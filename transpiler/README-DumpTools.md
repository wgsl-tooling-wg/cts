# CTS Dump Tools

A map of the tools under `transpiler/tools/` that extract CTS data into portable
JSON, so a non-CTS front end (the wesl type core / const evaluator) can be tested
against it offline, with no CTS runtime and mostly no GPU. This is the
orientation map: what CTS structure we start FROM, what we translate it INTO, and
the commands. The per-file headers (`dump_cases.ts`, `dump_shaders.ts`,
`dump_provider.ts`) are the field-by-field reference; this is the tour.

Sibling of `README-Transpiler.md`, which covers the other direction -- running
CTS shaders THROUGH the wesl linker on a GPU (the `test-cts` path).

## 1. The CTS structure we start from

### Execution case tables (the const-eval oracle source)

`src/webgpu/shader/execution/expression/**/*.cache.ts` -- each a
`makeCaseCache(name, ...)` of `(input, expected)` cases that the CTS builds in
TypeScript, no GPU involved, and pre-builds into `.bin` files under
`src/resources/cache/` with its own `tools/gen_cache`. An `expected` is an
`FPInterval` (an accuracy interval), a concrete value, or a `Comparator` wrapping
one.

Naming and shape:

- Operator tables are path-named (`binary/af_addition` = the `+` operator on
  abstract-float); builtin tables are named for the builtin alone (`ldexp`,
  `abs`).
- A table has per-type lists (`f32_const`, `abstract`, `f32_mat2x2_const`, ...).
- `*_non_const` lists carry the LOOSER accuracy a runtime evaluation is allowed;
  they do not describe const-eval, so the const-eval oracle drops them.

### Validation specs (the no-false-rejection oracle source)

`src/webgpu/shader/validation/**/*.spec.ts` -- each asserts a verdict per shader
with `t.expectCompileResult(expected, code)`: `expected === true` means the spec
says a conformant front end must ACCEPT that WGSL. Those valid shaders are the
corpus a partial type checker must never reject.

### Machinery worth knowing by name

- `DataCache` + the `.bin` cache (`src/common/framework/data_cache.ts`): how the
  pre-built case tables are stored and loaded.
- Comparators (`src/webgpu/util/compare.ts`): `anyOf` (any listed expectation
  matches), `skipUndefined`, `alwaysPass`. `anyOf` is how most interval cases are
  wrapped.
- `FPInterval` (`src/webgpu/util/floating_point.ts`): the accuracy interval an
  expected float result is checked against.
- The `--gpu-provider` hook: a module `require()`d before any spec loads, so it
  can patch fixtures without editing any upstream file. `dump_provider.ts` uses
  it to record the validation transcript.
- `setIsBuildingDataCache()`: the CTS's own `gen_cache` flag. A comparator's
  constructor (`anyOf` etc.) attaches its serializable `data` only while the flag
  is set, so `gen_cache` can write the payloads into the `.bin` cache. Normal
  test runs leave it off and stay lean. `deserializeComparator` rebuilds through
  those same constructors, so reading the cache with the flag OFF reconstructs
  the comparators and silently discards the payloads -- every interval case then
  decodes as "unrecoverable". `dump_cases` sets the flag to keep them: a
  build-time flag repurposed as a read-time "retain payloads" lever. Not a wesl
  bug, and not really a CTS bug.

## 2. What we translate into

Both dumps are CHECKED INTO THIS FORK under `dumps/`, versioned alongside the
`src/` tree they derive from. A dump is a deterministic function of that tree,
so the submodule SHA that pins `src/` pins the dumps too -- there is no separate
cache to key or rebuild, and a wesl checkout reads files instead of installing
the CTS toolchain to regenerate them. Each dump carries a `manifest.json` stamp
recording the `src` tree hash it came from (`git rev-parse HEAD:src`) plus its
sampling params.

Regenerate the dumps on every upstream merge, in the SAME fork commit that moves
`src/`. That keeps the stamp matching: a merge that moves `src/` without a regen
leaves a `sourceTree` that no longer equals `HEAD:src`, and a wesl-side unit test
(`CtsDumps.test.ts`) fails on that mismatch rather than silently testing stale
data.

- Cases -> `dumps/cases/*.json`, one file per cache: `{ cache, lists }`, each
  list `{ inputs, expectation, total, skipped, cases }` with keyless per-case
  payloads. `expectation.kind` is `value | interval | anyOf` (a single
  `interval` covers scalar / vector / matrix -- the payload nesting carries the
  dimensionality). No GPU needed (reads the pre-built `.bin` cache).
  `dump_cases.ts` has the full field reference and worked examples.
- Shaders -> `dumps/shaders/*.json`, one file per top-level group:
  `{ group, specs }`, each spec `{ total, unique, shaders }`, each shader
  `{ params, code }`. Built in two hops: `dump_provider.ts` records an NDJSON
  transcript of `{ spec, params, expected, code }` while the validation suite
  runs on a real GPU, then `dump_shaders.ts` keeps the valid ones, dedups by
  code, samples, and re-emits the JSON. `params` is provenance only -- nothing in
  wesl reads it. `dump_shaders.ts` has the full field reference.

## 3. The commands (and the gotchas we keep hitting)

### The fork tools directly

```
transpiler/tools/dump_cases --out DIR [--filter REGEX] [--max N] [--list]
transpiler/tools/dump_shaders --out DIR [--filter REGEX] [--max N]
                              [--query Q] [--invalid] [--list] [--transcript FILE]
```

- `dump_cases` needs no GPU (it reads the pre-built `.bin` cache). Its `--filter`
  matches the CACHE name, and for builtins that is the builtin ALONE: `^ldexp`,
  not `float_builtin_functions/ldexp`.
- `dump_shaders` needs a GPU (the fixtures request a device). Reuse an earlier
  run's transcript with `--transcript FILE` to re-sample without re-running the
  suite. `--invalid` keeps the shaders the CTS expects to REJECT instead.

### The wesl-side commands (what you normally run)

From the monorepo (`pnpm --filter wesl ...`, or `rpr` in that package). These
wrap the fork tools, target `dumps/`, and write the manifest stamp:

- `dump:cts:cases` -- regenerate `dumps/cases/` + its manifest (no GPU; reads
  the `.bin` cache). Uses the default caps (operators `--max 100`, builtins
  `--max 40`). Extending const eval (a new builtin, matrix operators) means
  deleting a name from the exclusion filters in `scripts/dump-cts-cases.ts`,
  then re-running this.
- `dump:cts:shaders` -- regenerate `dumps/shaders/` + its manifest (needs a GPU,
  `--max 25`). Reuses a recorded transcript with `--transcript FILE`.
- `test:cts:offline` -- run the offline oracles (`CtsConstEval`, `CtsValidation`)
  over the checked-in dumps, no GPU.
- `test:cts` / `test:cts:full` -- the live GPU round-trip (see below and
  `README-Transpiler.md`), unchanged by these tools.

After a regen, `CtsDumps.test.ts` checks each manifest's `sourceTree` against the
live submodule's `HEAD:src`, so a forgotten regen fails a unit test rather than
silently testing stale data.

### The full corpus (on demand, not checked in)

The checked-in dumps are a small sampled net. For the full corpus, hand-dump
with the fork tools to a scratch dir (`--max 0`) and point the oracle at it with
an env override:

```
transpiler/tools/dump_cases   --out /tmp/cts-cases-all   --filter '<regex>' --max 0
transpiler/tools/dump_shaders --out /tmp/cts-shaders-all --max 0   # needs a GPU

WESL_CTS_CASES=/tmp/cts-cases-all     pnpm --filter wesl exec vitest run CtsConstEval
WESL_CTS_SHADERS=/tmp/cts-shaders-all pnpm --filter wesl exec vitest run CtsValidation
```

`scripts/dump-cts-cases.ts --out DIR [--max N]` is a thin wrapper over the cases
tool for the same scratch dump.

## 4. Where it is consumed

- `packages/wesl/src/test/CtsCases.ts` -- decodes the cases JSON, synthesizes the
  WGSL under test, checks a const-eval result against an expectation, and renders
  a case as a human line (`caseToString`). Driven by `CtsConstEval.test.ts`.
- `packages/wesl/src/test/CtsShaders.ts` -- replays each valid shader through
  parse + bind + the type core. Driven by `CtsValidation.test.ts`.
- `README-Transpiler.md` -- the GPU side.

## The oracle boundary (why extraction does not replace test-cts)

Two oracles, split by what each can answer:

- A STATIC, GPU-independent oracle -- the INPUT side: does wesl accept a valid
  shader, and is its type / const answer right. The CTS already knows these
  answers (its case tables and valid/invalid verdicts), so we extract them to
  JSON and run offline on CPU. Push this as far as it goes.
- A LIVE oracle -- a real compiler (Dawn) judging wesl's OWN emitted output: is
  the WGSL wesl PRODUCES valid. That answer is not known until link time and
  needs a real compiler, so it stays in `test-cts` on a GPU.

Extraction can never replace `test-cts`, because you cannot pre-extract "the
right answer" for output that depends on wesl's own (possibly regressing)
emission. The two overlap only on the pure-acceptance / parse signal; the offline
corpus owns that, and the GPU time is reserved for emit validity.
