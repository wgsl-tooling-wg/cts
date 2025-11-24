#!/usr/bin/env node
/**
 * Compare CTS test results between baseline and transpiled runs.
 *
 * Usage:
 *   transpiler/tools/compare_results.ts baseline.json transpiled.json
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
  return result.logs.some(log =>
    JSON.stringify(log).includes(TRANSPILER_PARSE_ERROR_MARKER)
  );
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
  transpiled: Map<string, TestResult>
): void {
  const baselineTests = new Set(baseline.keys());
  const transpiledTests = new Set(transpiled.keys());

  // Check for mismatched tests
  const onlyBaseline = [...baselineTests].filter(t => !transpiledTests.has(t));
  const onlyTranspiled = [...transpiledTests].filter(t => !baselineTests.has(t));

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

  // Print summary
  const total = commonTests.length;
  console.log(`\n** Comparison Summary **`);
  console.log(`Total tests compared: ${total}`);
  console.log(`Both pass:            ${bothPass}`);
  console.log(`Both fail:            ${bothFail}`);
  console.log(`Both skip:            ${bothSkip}`);
  console.log();

  if (parseErrors.length > 0) {
    console.log(`** Parse Errors (${parseErrors.length}) **`);
    console.log(`(Transpiler failed to parse valid WGSL)`);
    for (const test of parseErrors) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  if (mistranslations.length > 0) {
    console.log(`** Mistranslations (${mistranslations.length}) **`);
    console.log(`(Transpiler produced invalid output from valid input)`);
    for (const test of mistranslations) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  if (tooPermissive.length > 0) {
    console.log(`** Too Permissive (${tooPermissive.length}) **`);
    console.log(`(Transpiler accepts/transforms invalid code into valid code)`);
    for (const test of tooPermissive) {
      console.log(`  ${test}`);
    }
    console.log();
  }

  if (otherDiff.length > 0) {
    console.log(`** Other Differences (${otherDiff.length}) **`);
    for (const [test, b, t] of otherDiff) {
      console.log(`  ${test}: ${b} -> ${t}`);
    }
    console.log();
  }

  // Final summary
  console.log(`** Transpiler Issues **`);
  console.log(`  parse-errors:    ${parseErrors.length} (Transpiler can't parse valid WGSL)`);
  console.log(`  mistranslations: ${mistranslations.length} (Transpiler produces invalid output)`);
  console.log(`  too-permissive:  ${tooPermissive.length} (Transpiler accepts what baseline rejects)`);

  // Exit with error if there are issues
  if (parseErrors.length > 0 || mistranslations.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.log(`Usage: npx ts-node compare_results.ts baseline.json transpiled.json`);
    process.exit(1);
  }

  const [baselinePath, transpiledPath] = args;

  console.log(`Loading baseline: ${baselinePath}`);
  const baseline = loadResults(baselinePath);

  console.log(`Loading transpiled: ${transpiledPath}`);
  const transpiled = loadResults(transpiledPath);

  compareResults(baseline, transpiled);
}

main();
