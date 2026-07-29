#!/usr/bin/env node
/**
 * Compare CTS test results between baseline and transpiled runs.
 *
 * Usage:
 *   transpiler/tools/compare_results.ts [--ignore-file path] baseline.json transpiled.json
 */

import * as fs from 'fs';
import { TRANSPILER_PARSE_ERROR_MARKER } from '../transpiler_constants.ts';

interface TestResult {
  status: 'pass' | 'fail' | 'skip' | 'warn';
  timems: number;
  logs: unknown[];
}

function hasParseError(result: TestResult): boolean {
  if (!result.logs) return false;
  return result.logs.some(log => JSON.stringify(log).includes(TRANSPILER_PARSE_ERROR_MARKER));
}

interface CTSResults {
  version: string;
  results: Array<[string, TestResult]>;
}

function loadResults(filepath: string): Map<string, TestResult> {
  const content = fs.readFileSync(filepath, 'utf-8');

  // Find JSON start - skip any warning output before it
  // Look for the JSON object that starts with {"version":
  const jsonStart = content.indexOf('{\n  "version":');
  if (jsonStart === -1) {
    throw new Error(`No JSON found in ${filepath}`);
  }

  const jsonContent = content.slice(jsonStart);
  const data: CTSResults = JSON.parse(jsonContent);

  const results = new Map<string, TestResult>();
  for (const [name, result] of data.results) {
    results.set(name, result);
  }

  return results;
}

function compareResults(
  baseline: Map<string, TestResult>,
  transpiled: Map<string, TestResult>,
  ignoredTests: Set<string>
): void {
  const baselineTests = new Set(baseline.keys());
  const transpiledTests = new Set(transpiled.keys());
  const ignored = new Set<string>();

  // Check for mismatched tests
  const onlyBaseline = filterIgnored(
    [...baselineTests].filter(t => !transpiledTests.has(t)),
    ignoredTests,
    ignored
  );
  const onlyTranspiled = filterIgnored(
    [...transpiledTests].filter(t => !baselineTests.has(t)),
    ignoredTests,
    ignored
  );

  if (onlyBaseline.length > 0) {
    console.log(`Warning: ${onlyBaseline.length} tests only in baseline`);
  }
  if (onlyTranspiled.length > 0) {
    console.log(`Warning: ${onlyTranspiled.length} tests only in transpiled`);
  }

  // Categorize differences
  const parseErrors: string[] = []; // Transpiler failed to parse valid code
  const mistranslations: string[] = []; // Transpiler produced invalid output
  const tooPermissive: string[] = []; // failed baseline, passed transpiled
  let bothPass = 0;
  let bothFail = 0;
  let bothSkip = 0;
  const otherDiff: Array<[string, string, string]> = [];

  const commonTests = [...baselineTests].filter(t => transpiledTests.has(t)).sort();

  for (const test of commonTests) {
    const bStatus = baseline.get(test)!.status;
    const tStatus = transpiled.get(test)!.status;

    if (bStatus === tStatus) {
      if (bStatus === 'pass') bothPass++;
      else if (bStatus === 'fail') bothFail++;
      else if (bStatus === 'skip') bothSkip++;
    } else if (bStatus === 'pass' && tStatus === 'fail') {
      // Too strict - check if it's a parse error or mistranslation
      const tResult = transpiled.get(test)!;
      if (hasParseError(tResult)) {
        parseErrors.push(test);
      } else {
        mistranslations.push(test);
      }
    } else if (bStatus === 'fail' && tStatus === 'pass') {
      tooPermissive.push(test);
    } else {
      otherDiff.push([test, bStatus, tStatus]);
    }
  }

  const unexpectedParseErrors = filterIgnored(parseErrors, ignoredTests, ignored);
  const unexpectedMistranslations = filterIgnored(mistranslations, ignoredTests, ignored);
  const unexpectedTooPermissive = filterIgnored(tooPermissive, ignoredTests, ignored);
  const unexpectedOtherDiff = otherDiff.filter(([test]) => {
    if (!ignoredTests.has(test)) return true;
    ignored.add(test);
    return false;
  });

  // Print summary
  const total = commonTests.length;
  console.log(`\n** Comparison Summary **`);
  console.log(`Total tests compared: ${total}`);
  console.log(`Both pass:            ${bothPass}`);
  console.log(`Both fail:            ${bothFail}`);
  console.log(`Both skip:            ${bothSkip}`);
  console.log();

  if (unexpectedParseErrors.length > 0) {
    console.log(`** Parse Errors (${unexpectedParseErrors.length}) **`);
    console.log(`(Transpiler failed to parse valid WGSL)`);
    for (const test of unexpectedParseErrors) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  if (unexpectedMistranslations.length > 0) {
    console.log(`** Mistranslations (${unexpectedMistranslations.length}) **`);
    console.log(`(Transpiler produced invalid output from valid input)`);
    for (const test of unexpectedMistranslations) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  if (unexpectedTooPermissive.length > 0) {
    console.log(`** Too Permissive (${unexpectedTooPermissive.length}) **`);
    console.log(`(Transpiler accepts/transforms invalid code into valid code)`);
    for (const test of unexpectedTooPermissive) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  if (unexpectedOtherDiff.length > 0) {
    console.log(`** Other Differences (${unexpectedOtherDiff.length}) **`);
    for (const [test, b, t] of unexpectedOtherDiff) {
      console.log(`  ${test}: ${b} -> ${t}`);
    }
    console.log();
  }

  if (ignored.size > 0) {
    console.log(`** Known Divergences (${ignored.size}, ignored) **`);
    console.log(`(Excluded from issue counts and exit status)`);
    for (const test of [...ignored].sort()) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  // Final summary
  console.log(`** Transpiler Issues **`);
  console.log(
    `  parse-errors:    ${unexpectedParseErrors.length} (Transpiler can't parse valid WGSL)`
  );
  console.log(
    `  mistranslations: ${unexpectedMistranslations.length} (Transpiler produces invalid output)`
  );
  console.log(
    `  too-permissive:  ${unexpectedTooPermissive.length} (Transpiler accepts what baseline rejects)`
  );

  // Exit with error if there are issues
  if (unexpectedParseErrors.length > 0 || unexpectedMistranslations.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

function filterIgnored(tests: string[], ignoredTests: Set<string>, ignored: Set<string>): string[] {
  return tests.filter(test => {
    if (!ignoredTests.has(test)) return true;
    ignored.add(test);
    return false;
  });
}

function loadIgnoredTests(filepath: string): Set<string> {
  const lines = fs.readFileSync(filepath, 'utf-8').split(/\r?\n/);
  return new Set(lines.map(line => line.trim()).filter(line => line && !line.startsWith('#')));
}

function main(): void {
  const args = process.argv.slice(2);
  const paths: string[] = [];
  let ignoredTests = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--ignore-file') {
      paths.push(args[i]);
      continue;
    }
    const ignoreFile = args[++i];
    if (!ignoreFile) usageError();
    ignoredTests = new Set([...ignoredTests, ...loadIgnoredTests(ignoreFile)]);
  }

  if (paths.length !== 2) {
    usageError();
  }

  const [baselinePath, transpiledPath] = paths;

  if (!baselinePath || !transpiledPath) {
    usageError();
  }

  console.log(`Loading baseline: ${baselinePath}`);
  const baseline = loadResults(baselinePath);

  console.log(`Loading transpiled: ${transpiledPath}`);
  const transpiled = loadResults(transpiledPath);

  compareResults(baseline, transpiled, ignoredTests);
}

function usageError(): never {
  console.log(
    `Usage: npx ts-node compare_results.ts [--ignore-file path] baseline.json transpiled.json`
  );
  process.exit(1);
}

main();
