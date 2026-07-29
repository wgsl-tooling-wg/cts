/**
 * Dump the CTS expression case tables to JSON, so that a non-CTS const-evaluator
 * can be tested against them offline.
 *
 * The case tables under src/webgpu/shader/execution/expression are built by the
 * CTS in TypeScript (no GPU involved) and pre-built into src/resources/cache as
 * .bin files. This tool reads them through the DataCache and re-emits them in a
 * portable JSON form.
 *
 * Usage:
 *   transpiler/tools/dump_cases --out DIR [--filter REGEX] [--max N] [--list]
 *
 *   --out DIR      directory to write <cache name>.json files into
 *   --filter REGEX only dump caches whose name matches
 *                  (default: ^(binary|unary)/a[fi]_, the abstract-numeric caches)
 *   --max N        keep at most N cases per case list, sampled deterministically
 *                  (default 0, meaning keep all)
 *   --list         print the matching cache names and case counts, write nothing
 *
 * A cache is named for its table: operator tables are path-named
 * ('binary/af_addition' = the '+' operator on abstract-float), builtin tables
 * for the builtin alone ('atan2', 'abs'). Each holds one or more named case
 * LISTS (per input type, per const-ness); a '*_non_const' list carries the
 * looser accuracy a runtime evaluation may use, which does not describe
 * const-eval, so those are skipped and only the const-evaluable lists kept.
 *
 * Every case in a list shares one input signature and one expectation schema, so
 * both are hoisted to the list and the cases themselves are bare payloads:
 *
 *   { "cache": "binary/af_addition",
 *     "lists": {
 *       "scalar": {
 *         "inputs": ["abstract-float", "abstract-float"],
 *         "expectation": { "kind": "interval", "precision": "abstract" },
 *         "total": 254, "skipped": 0,
 *         "cases": [ [[-1.5, 2], [0.5, 0.5]], ... ] } } }
 *
 * A case is [inputs, expected]. An input payload follows its declared type: a
 * scalar is a bare number, a `vecN<T>` is an array of N, a `matCxR<T>` is an
 * array of C columns of R. The expectation schema is a tagged union on `kind`:
 *
 *   value     an exact result of type `type`; the payload is that value.
 *   interval  an accuracy interval; the payload is [lo, hi], nested per
 *             component for a vector ([[lo,hi], ...]) and per column of rows for
 *             a matrix ([[[lo,hi], ...], ...]). One 'interval' kind covers all
 *             three shapes -- the nesting carries the dimensionality, so no
 *             separate vector/matrix tags are needed.
 *   anyOf     `option` holds the shared inner schema; the payload is
 *             [payload, ...] and any one option matching is a pass.
 *
 * `precision` (abstract | f32 | f16) rides the interval kinds but feeds one
 * decision only: which subnormal-flush width to allow. It is not part of the
 * plain "is x in [lo, hi]" membership test.
 *
 * A zero-width interval [v, v] is still an interval, just degenerate (the list's
 * kind is uniform and interval-typed); bare values appear only in `value` lists.
 * CtsCases.caseToString renders one case per line, which is how these read:
 *
 *   sin [f32]:  sin(0.03173325955867767f)  ==  [0.031239651143550873, 0.03221621736884117]    (f32)
 *   binary/ai_arithmetic [multiplication]:  -10 * -10  ==  100    (abstract-int)
 *   cross [f32_const]:  cross(vec3(1f, -2f, -1f), vec3(-1f, 1f, -2f))  ==  [5, 3, -1]    (f32, exact)
 *   transpose [f32_mat2x2_const]:  transpose(mat2x2(2f, -2f, -1f, 2f))  ==  [[2, -1], [-2, 2]]    (f32, exact)
 *   step [f32]:  step(-0f, -1.1754942106924411e-38f)  ==  0 | 1    (f32, exact)
 *
 * Most interval-valued cases are wrapped in an 'anyOf' comparator by the CTS, so
 * recovering their payload needs setIsBuildingDataCache() -- the CTS's own
 * gen_cache flag, which keeps a comparator's serializable `data` reachable while
 * the cache is read (see the call site). A single-option anyOf is unwrapped.
 * Comparators that constrain nothing (alwaysPass, and skipUndefined with no
 * expectation) are dropped and counted as skipped.
 *
 * Numbers are JSON numbers when finite and not -0, and otherwise one of the
 * strings "inf", "-inf", "nan", "-0". An abstract-int outside the exact double
 * range is a decimal string.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';

import {
  Cacheable,
  dataCache,
  setIsBuildingDataCache,
} from '../../src/common/framework/data_cache.js';
import { Case } from '../../src/webgpu/shader/execution/expression/case.js';
import {
  Expectation,
  isComparator,
} from '../../src/webgpu/shader/execution/expression/expectation.js';
import { Comparator } from '../../src/webgpu/util/compare.js';
import {
  MatrixValue,
  Value,
  VectorValue,
  isScalarValue,
} from '../../src/webgpu/util/conversion.js';
import { FPInterval } from '../../src/webgpu/util/floating_point.js';

// Paths are relative to the CTS root, not the cwd, so the tool runs from anywhere.
const ctsRoot = path.resolve(__dirname, '../..');
const expressionDir = path.join(ctsRoot, 'src/webgpu/shader/execution/expression');
const cacheDir = path.join(ctsRoot, 'src/resources/cache');

/** A JSON scalar: a number, "inf" / "-inf" / "nan" / "-0" / a big decimal, or a bool. */
type Num = number | string | boolean;
/** Nested to the shape of the value or interval list it encodes. */
type Payload = Num | Payload[];
type ExpKind = { kind: string; precision?: string; type?: string; option?: ExpKind };
type JsonList = {
  inputs: string[];
  expectation: ExpKind;
  total: number;
  skipped: number;
  cases: [Payload[], Payload][];
};

function usage(rc: number): never {
  console.error(`Usage: transpiler/tools/dump_cases --out DIR [--filter REGEX] [--max N] [--list]`);
  process.exit(rc);
}

function main() {
  const args = process.argv.slice(2);
  let outDir: string | undefined;
  let filter = '^(binary|unary)/a[fi]_';
  let max = 0;
  let listOnly = false;

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
      case '--list':
        listOnly = true;
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

  // The pre-built case data lives in the repo; fall back to building on the fly.
  dataCache.setStore({
    load: async (p: string) => new Uint8Array(await fs.promises.readFile(path.join(cacheDir, p))),
  });
  // setIsBuildingDataCache is the CTS's own gen_cache flag: comparator
  // constructors (anyOf etc., util/compare.ts) attach their serializable `data`
  // only while it is set, so gen_cache can write the payloads into the .bin
  // cache. deserializeComparator rebuilds through those same constructors, so
  // reading the cache with the flag OFF reconstructs the comparators and
  // silently discards the payloads. We set it to repurpose that build-time flag
  // as a read-time "retain payloads" lever (see the file header).
  setIsBuildingDataCache();

  void dump(new RegExp(filter), outDir, max, listOnly);
}

async function dump(filter: RegExp, outDir: string | undefined, max: number, listOnly: boolean) {
  for (const file of cacheModules()) {
    const mod = await import(file); // ts-node loads the .ts directly
    const cacheable = mod.d as Cacheable<Record<string, Case[]>> | undefined;
    if (cacheable?.serialize === undefined) continue;

    // cacheable.path is 'webgpu/shader/execution/<name>.bin'
    const name = cacheable.path.replace(/^webgpu\/shader\/execution\//, '').replace(/\.bin$/, '');
    if (!filter.test(name)) continue;

    const data = await dataCache.fetch(cacheable);
    const lists: Record<string, JsonList> = {};
    for (const listName of Object.keys(data)) {
      // The builtin caches carry a *_non_const list per type, holding the same
      // inputs with the looser accuracy intervals a runtime evaluation is
      // allowed. Those intervals do not describe const-evaluation, so a const
      // evaluator must be held to the *_const list instead.
      if (listName.includes('non_const')) continue;
      const list = jsonList(data[listName], max);
      if (list.cases.length > 0) lists[listName] = list;
    }
    if (Object.keys(lists).length === 0) continue; // nothing const-evaluable here

    const counts = Object.entries(lists)
      .map(([n, l]) => `${n}=${l.cases.length}/${l.total}${l.skipped ? ` (-${l.skipped})` : ''}`)
      .join(' ');
    console.log(`${name}: ${counts}`);
    if (listOnly || outDir === undefined) continue;

    const outPath = path.join(outDir, `${name}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, stringify(name, lists));
  }
}

/** The .cache.ts files under the expression suite, relative to the CTS root. */
function cacheModules(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort()) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.cache.ts')) found.push(p);
    }
  };
  walk(expressionDir);
  return found;
}

/** One case per line, so the checked-in fixtures stay readable and diffable. */
function stringify(cache: string, lists: Record<string, JsonList>): string {
  const out = [`{`, ` "cache": ${JSON.stringify(cache)},`, ` "lists": {`];
  const names = Object.keys(lists);
  names.forEach((name, i) => {
    const l = lists[name];
    out.push(`  ${JSON.stringify(name)}: {`);
    out.push(`   "inputs": ${JSON.stringify(l.inputs)},`);
    out.push(`   "expectation": ${JSON.stringify(l.expectation)},`);
    out.push(`   "total": ${l.total},`);
    out.push(`   "skipped": ${l.skipped},`);
    out.push(`   "cases": [`);
    out.push(l.cases.map(c => `    ${JSON.stringify(c)}`).join(',\n'));
    out.push(`   ]`);
    out.push(`  }${i < names.length - 1 ? ',' : ''}`);
  });
  out.push(` }`, `}`, ``);
  return out.join('\n');
}

/** Encode one case list, sampling down to `max` cases if it is larger. */
function jsonList(cases: Case[], max: number): JsonList {
  const kept: { inputs: Value[]; expectation: Constraint }[] = [];
  for (const c of cases) {
    const expectation = constraint(c.expected);
    if (expectation === undefined) continue; // an expectation that constrains nothing
    const inputs = Array.isArray(c.input) ? c.input : [c.input as Value];
    kept.push({ inputs, expectation });
  }

  // Some builtin lists mix a bare expectation with an anyOf of alternatives
  // (e.g. only the cases where flushing a subnormal changes the answer get the
  // alternatives). Lift the whole list to anyOf so its schema stays uniform.
  const anyMulti = kept.some(k => 'options' in k.expectation);
  const expectations = kept.map(({ expectation }) =>
    anyMulti && 'single' in expectation ? { options: [expectation.single] } : expectation,
  );

  const encoded: [Payload[], Payload][] = [];
  let inTypes: string[] | undefined;
  let expKind: ExpKind | undefined;
  kept.forEach(({ inputs }, i) => {
    // The list's schema is taken from its first case and enforced on the rest;
    // the decoder relies on a list being uniform.
    const types = inputs.map(typeName);
    const kind = expKindOf(expectations[i]);
    inTypes ??= types;
    expKind ??= kind;
    check(types, inTypes, 'input types');
    check(kind, expKind, 'expectation kind');

    encoded.push([inputs.map(valuePayload), expPayload(expectations[i])]);
  });

  const sampled = max > 0 && encoded.length > max ? sample(encoded, max) : encoded;
  return {
    inputs: inTypes ?? [],
    expectation: expKind ?? { kind: 'none' },
    total: cases.length,
    skipped: cases.length - encoded.length,
    cases: sampled,
  };
}

function check(got: unknown, want: unknown, what: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`case list is not uniform in its ${what}: ${g} vs ${w}`);
}

/**
 * Deterministically keep `max` of `cases`, spread over the whole list.
 *
 * Case lists are usually a cartesian product of two input ranges, so a plain
 * every-Nth stride can lock onto one column of the product (always the same
 * right-hand operand). Ordering by a hash of the index avoids that aliasing
 * while staying reproducible.
 */
function sample<T>(cases: T[], max: number): T[] {
  return cases
    .map((_, i) => i)
    .sort((a, b) => mix(a) - mix(b))
    .slice(0, max)
    .sort((a, b) => a - b)
    .map(i => cases[i]);
}

/** Knuth multiplicative hash, as a stable pseudo-random ordering key. */
function mix(i: number): number {
  return Math.imul(i + 1, 2654435761) >>> 0;
}

/**
 * A checkable expectation: either one Expectation, or a list of alternatives
 * from an anyOf comparator (any one of which matching is a pass).
 *
 * The two are tagged rather than inferred from shape, because they are not
 * distinguishable by shape: a matrix expectation is an FPInterval[][], and so
 * is a list of alternatives that are each a vector expectation.
 */
type Constraint = { single: Expectation } | { options: Expectation[] };

/** The expectation to check, or undefined if it constrains nothing. */
function constraint(e: Expectation): Constraint | undefined {
  if (!isComparator(e)) return { single: e };
  const c = e as Comparator;
  switch (c.kind) {
    case 'anyOf': {
      const options = (c.data as Expectation[]).filter(o => constraint(o) !== undefined);
      if (options.length === 0) return undefined;
      return options.length === 1 ? { single: options[0] } : { options };
    }
    case 'skipUndefined':
      return c.data === undefined ? undefined : { single: c.data as Expectation };
    case 'alwaysPass':
      return undefined;
    default:
      throw new Error(`cannot encode '${c.kind}' comparator`);
  }
}

function expKindOf(c: Constraint): ExpKind {
  if ('options' in c) return { kind: 'anyOf', option: expKindOf({ single: c.options[0] }) };
  const e = c.single;
  // scalar, vector, and matrix intervals share one 'interval' kind; the payload
  // nesting distinguishes them, so the decoder does not need separate tags.
  if (e instanceof FPInterval) return { kind: 'interval', precision: e.kind };
  if (e instanceof Array) {
    const first = e[0];
    if (first instanceof FPInterval) return { kind: 'interval', precision: first.kind };
    const m = e as readonly (readonly FPInterval[])[];
    return { kind: 'interval', precision: m[0][0].kind };
  }
  return { kind: 'value', type: typeName(e as Value) };
}

function expPayload(c: Constraint): Payload {
  if ('options' in c) return c.options.map(o => expPayload({ single: o }));
  const e = c.single;
  if (e instanceof FPInterval) return interval(e);
  if (e instanceof Array) {
    const first = e[0];
    if (first instanceof FPInterval) return (e as readonly FPInterval[]).map(interval);
    const m = e as readonly (readonly FPInterval[])[];
    return m.map(col => col.map(interval));
  }
  return valuePayload(e as Value);
}

/** A WGSL-ish type name: 'abstract-float', 'vec3<abstract-int>', 'mat2x3<abstract-float>'. */
function typeName(v: Value): string {
  if (isScalarValue(v)) return v.type.kind;
  if (v instanceof VectorValue) return `vec${v.elements.length}<${v.elements[0].type.kind}>`;
  if (v instanceof MatrixValue) {
    const [cols, rows] = [v.elements.length, v.elements[0].length];
    return `mat${cols}x${rows}<${v.elements[0][0].type.kind}>`;
  }
  throw new Error(`cannot encode value ${v}`);
}

function valuePayload(v: Value): Payload {
  if (isScalarValue(v)) return scalar(v.value);
  if (v instanceof VectorValue) return v.elements.map(valuePayload);
  if (v instanceof MatrixValue) return v.elements.map(col => col.map(valuePayload));
  throw new Error(`cannot encode value ${v}`);
}

function scalar(value: number | bigint | boolean): Num {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    // stay a JSON number while that is exact, so the common small values stay readable
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  return num(value);
}

/** JSON has no -0, Infinity or NaN, so those become strings. */
function num(n: number): Num {
  if (Number.isNaN(n)) return 'nan';
  if (n === Number.POSITIVE_INFINITY) return 'inf';
  if (n === Number.NEGATIVE_INFINITY) return '-inf';
  if (n === 0 && Object.is(n, -0)) return '-0';
  return n;
}

function interval(i: FPInterval): Payload {
  return [num(i.begin), num(i.end)];
}

main();
