/**
 * Dump the shaders the CTS validation suite considers valid, to JSON, so that a
 * non-CTS front end can be tested against them offline.
 *
 * The validation specs assert a verdict per shader (`expectCompileResult(valid,
 * code)`). The valid ones are a large, spec-blessed corpus of WGSL that any
 * front end must accept: a parse or type-check failure on one of them is a
 * false rejection, no GPU needed to say so. transpiler/dump_provider.ts records
 * the verdicts while the suite runs; this tool drives that run and re-emits the
 * transcript in a portable form.
 *
 * The run needs a real GPU (the fixtures request a device), so this is an
 * occasional, explicit regeneration step -- like tools/gen_cache -- not
 * something a test does.
 *
 * Usage:
 *   transpiler/tools/dump_shaders --out DIR [--filter REGEX] [--max N]
 *                                 [--query Q] [--invalid] [--list]
 *                                 [--transcript FILE]
 *
 *   --out DIR         directory to write <group>.json files into
 *   --filter REGEX    only keep specs whose name matches (default: all)
 *   --max N           keep at most N shaders per spec, sampled deterministically
 *                     (default 0, meaning keep all)
 *   --query Q         the CTS query to run (default webgpu:shader,validation,*)
 *   --invalid         keep the shaders the CTS expects to REJECT instead
 *   --list            print per-spec counts, write nothing
 *   --transcript FILE reuse a previous run's transcript instead of running the
 *                     suite again (and write it here when the suite does run)
 *
 * Output is one file per top level group, with the specs under it:
 *
 *   { "group": "const_assert",
 *     "specs": {
 *       "const_assert/const_assert": {
 *         "total": 2670, "unique": 890,
 *         "shaders": [
 *           { "params": { "scope": "module", "case": "any_false" },
 *             "code": "const one = 1;\nconst_assert(one == 1);" } ] } } }
 *
 * Field by field:
 *   group    the top level validation group ('const_assert', 'expression', ...).
 *   specs    map of spec name -> its shaders. A spec name is the '.spec.ts' path
 *            under shader/validation/ (here 'const_assert/const_assert').
 *   total    shaders the spec recorded, before dedup and sampling.
 *   unique   distinct sources among them (the same code often recurs across many
 *            params the shader does not depend on).
 *   shaders  the kept sources, each { params, code }.
 *   code     the WGSL under test. The ONLY field the oracle reads.
 *   params   the CTS test parameters that generated this shader (scope, case,
 *            format, ...). Nothing in wesl reads it -- the oracle checks `code`
 *            only. It is kept solely so a failing shader can be traced back to
 *            the CTS test case that produced it. Opaque and spec-specific (its
 *            keys vary per spec).
 *
 * dump_provider.ts records the transcript this tool re-emits; see it for how the
 * per-shader verdict is captured.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';

// Paths are relative to the CTS root, not the cwd, so the tool runs from anywhere.
const ctsRoot = path.resolve(__dirname, '../..');

/** One record as dump_provider writes it. */
interface Recorded {
  spec: string;
  params: unknown;
  expected: boolean;
  code: string;
}

interface Shader {
  params: unknown;
  code: string;
}

interface SpecShaders {
  /** shaders recorded for this spec, before dedup and sampling */
  total: number;
  /** distinct sources among them */
  unique: number;
  shaders: Shader[];
}

function usage(rc: number): never {
  console.error(
    `Usage: transpiler/tools/dump_shaders --out DIR [--filter REGEX] [--max N] [--query Q]\n` +
      `                                   [--invalid] [--list] [--transcript FILE]`
  );
  process.exit(rc);
}

function main() {
  const args = process.argv.slice(2);
  let outDir: string | undefined;
  let filter = '';
  let max = 0;
  let query = 'webgpu:shader,validation,*';
  let wantValid = true;
  let listOnly = false;
  let transcript: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--out':
        outDir = args[++i];
        break;
      case '--filter':
        filter = args[++i];
        break;
      case '--max':
        max = Number.parseInt(args[++i], 10);
        break;
      case '--query':
        query = args[++i];
        break;
      case '--invalid':
        wantValid = false;
        break;
      case '--list':
        listOnly = true;
        break;
      case '--transcript':
        transcript = args[++i];
        break;
      case '--help':
        usage(0);
        break;
      default:
        console.error(`unrecognized argument: ${args[i]}`);
        usage(1);
    }
  }
  if (!listOnly && outDir === undefined) usage(1);

  const records = transcribe(query, transcript);
  const specs = collect(records, new RegExp(filter), wantValid, max);
  report(specs);
  if (listOnly || outDir === undefined) return;

  for (const [group, groupSpecs] of groups(specs)) {
    const outPath = path.join(outDir, `${group}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, stringify(group, groupSpecs));
  }
}

/** The recorded shaders, running the CTS suite to produce them if needed. */
function transcribe(query: string, transcript: string | undefined): Recorded[] {
  const dumpPath = transcript ?? path.join(os.tmpdir(), 'wesl-cts-shaders.ndjson');
  if (transcript !== undefined && fs.existsSync(transcript)) {
    console.log(`reusing transcript ${transcript}`);
  } else {
    runSuite(query, dumpPath);
  }
  return fs
    .readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Recorded);
}

/**
 * Run the validation suite under dump_provider, which records each shader.
 *
 * Validation failures are expected and are not our concern here: we want the
 * shaders the specs name, not the CTS's own verdict on the GPU. Only a crash,
 * which would truncate the transcript, matters.
 */
function runSuite(query: string, dumpPath: string) {
  console.log(`running ${query} (needs a GPU; this takes a few minutes)`);
  const provider = path.join(ctsRoot, 'transpiler/dump_provider.ts');
  const result = spawnSync(
    path.join(ctsRoot, 'tools/run_node'),
    ['--gpu-provider', provider, '--quiet', query],
    { cwd: ctsRoot, env: { ...process.env, WESL_SHADER_DUMP: dumpPath }, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (!fs.existsSync(dumpPath)) throw new Error('the suite recorded no shaders');
}

/** Group the wanted records by spec, dropping duplicate sources. */
function collect(
  records: Recorded[],
  filter: RegExp,
  wantValid: boolean,
  max: number
): Map<string, SpecShaders> {
  const specs = new Map<string, SpecShaders>();
  const seen = new Map<string, Set<string>>();

  for (const r of records) {
    if (r.expected !== wantValid || !filter.test(r.spec)) continue;

    const spec = specs.get(r.spec) ?? { total: 0, unique: 0, shaders: [] };
    specs.set(r.spec, spec);
    spec.total++;

    // The same source often arrives under several params (a spec that varies a
    // parameter the shader does not use); one copy is enough.
    const codes = seen.get(r.spec) ?? new Set<string>();
    seen.set(r.spec, codes);
    if (codes.has(r.code)) continue;
    codes.add(r.code);
    spec.shaders.push({ params: r.params, code: r.code });
  }

  for (const spec of specs.values()) {
    spec.unique = spec.shaders.length;
    if (max > 0 && spec.shaders.length > max) spec.shaders = sample(spec.shaders, max);
  }
  return specs;
}

function report(specs: Map<string, SpecShaders>) {
  let kept = 0;
  let unique = 0;
  let total = 0;
  for (const [name, spec] of [...specs].sort()) {
    console.log(`${name}: ${spec.shaders.length}/${spec.unique} unique of ${spec.total}`);
    kept += spec.shaders.length;
    unique += spec.unique;
    total += spec.total;
  }
  console.log(`\n${specs.size} specs, ${kept} shaders kept, ${unique} unique, ${total} recorded`);
}

/** Specs bucketed by their top level group ('expression/binary/x' -> 'expression'). */
function groups(specs: Map<string, SpecShaders>): Map<string, Map<string, SpecShaders>> {
  const byGroup = new Map<string, Map<string, SpecShaders>>();
  for (const [name, spec] of [...specs].sort()) {
    const group = name.split('/')[0];
    const groupSpecs = byGroup.get(group) ?? new Map<string, SpecShaders>();
    byGroup.set(group, groupSpecs);
    groupSpecs.set(name, spec);
  }
  return byGroup;
}

/** One shader per line, so the checked-in fixtures stay readable and diffable. */
function stringify(group: string, specs: Map<string, SpecShaders>): string {
  const out = [`{`, ` "group": ${JSON.stringify(group)},`, ` "specs": {`];
  const names = [...specs.keys()];
  names.forEach((name, i) => {
    const spec = specs.get(name)!;
    out.push(`  ${JSON.stringify(name)}: {`);
    out.push(`   "total": ${spec.total},`);
    out.push(`   "unique": ${spec.unique},`);
    out.push(`   "shaders": [`);
    out.push(spec.shaders.map(s => `    ${JSON.stringify(s)}`).join(',\n'));
    out.push(`   ]`);
    out.push(`  }${i < names.length - 1 ? ',' : ''}`);
  });
  out.push(` }`, `}`, ``);
  return out.join('\n');
}

/**
 * Deterministically keep `max` of `shaders`, spread over the whole list.
 *
 * A spec's shaders are usually a cartesian product of its params, so a plain
 * every-Nth stride can lock onto one column of the product (always the same
 * type, say). Ordering by a hash of the index avoids that aliasing while
 * staying reproducible.
 */
function sample<T>(shaders: T[], max: number): T[] {
  return shaders
    .map((_, i) => i)
    .sort((a, b) => mix(a) - mix(b))
    .slice(0, max)
    .sort((a, b) => a - b)
    .map(i => shaders[i]);
}

/** Knuth multiplicative hash, as a stable pseudo-random ordering key. */
function mix(i: number): number {
  return Math.imul(i + 1, 2654435761) >>> 0;
}

main();
