/**
 * A --gpu-provider that records every shader the validation suite compiles,
 * along with whether the CTS expects it to be valid.
 *
 * The validation specs state their verdict at the call site, as
 * `t.expectCompileResult(expected, code)`. That verdict is the interesting
 * half: the shaders with `expected === true` are a large, spec-blessed corpus
 * of valid WGSL, which is what a non-validating type checker must never reject.
 * Nothing downstream of the fixture can recover the verdict -- a shader does not
 * say what was expected of it -- so it has to be captured in the fixture.
 *
 * A --gpu-provider module is require()d before any spec loads, which makes it
 * the one hook point that needs no change to any upstream file. The GPU it
 * provides is the real one, and the recorded calls still run: the suite behaves
 * exactly as it does without this provider, and merely leaves a transcript.
 *
 * Driven by transpiler/tools/dump_shaders; see that tool for the output format.
 *
 *   WESL_SHADER_DUMP=out.ndjson tools/run_node \
 *     --gpu-provider transpiler/dump_provider.ts 'webgpu:shader,validation,*'
 */

import * as fs from 'fs';

// gpu_provider goes first: it installs the WebGPU globals, and the fixture
// module below is loaded (transitively) against them.
const gpuProvider = require('./gpu_provider.js');
const fixtures =
  require('../src/webgpu/shader/validation/shader_validation_test.js') as typeof import('../src/webgpu/shader/validation/shader_validation_test.js');

/** One recorded createShaderModule expectation. */
interface Recorded {
  /** the spec it came from, e.g. 'expression/binary/add_sub_mul' */
  spec: string;
  /**
   * The CTS test parameters that generated this shader (scope, case, format,
   * ...). Nothing in wesl reads it -- the oracle checks `code` only. It is kept
   * solely so a failing shader can be traced back to the CTS test case that
   * produced it.
   */
  params: unknown;
  /** whether the CTS expects this shader to compile */
  expected: boolean;
  code: string;
}

type CompileFn = (expected: boolean, code: string, ...rest: unknown[]) => void;

const dumpPath = process.env.WESL_SHADER_DUMP;
let dumpFd = -1;
let count = 0;

if (dumpPath !== undefined) {
  // Written a record at a time: the whole corpus does not fit in one string, and
  // a run that dies partway still leaves a usable transcript.
  dumpFd = fs.openSync(dumpPath, 'w');
  recordCompileExpectations();
  process.on('exit', () => {
    fs.closeSync(dumpFd);
    console.log(`[dump_provider] wrote ${count} shaders to ${dumpPath}`);
  });
}

function write(record: Recorded) {
  fs.writeSync(dumpFd, JSON.stringify(record) + '\n');
  count++;
}

/**
 * Patch both validation fixtures to record their expectation, then behave as
 * before. The two differ only in the device they request; each declares
 * expectCompileResult itself rather than sharing a base.
 */
function recordCompileExpectations() {
  for (const fixture of [
    fixtures.ShaderValidationTest,
    fixtures.UniqueFeaturesAndLimitsShaderValidationTest,
  ]) {
    const proto = fixture.prototype as { expectCompileResult: CompileFn; params: unknown };
    const original = proto.expectCompileResult;
    proto.expectCompileResult = function (expected, code, ...rest) {
      write({ spec: callingSpec(), params: this.params, expected, code });
      return original.call(this, expected, code, ...rest);
    };
  }
}

/**
 * The validation spec that called us, from the stack. A fixture does not know
 * its own test name (only the runner does), but the spec file is the grouping
 * that matters for triage, and the call site names it.
 */
function callingSpec(): string {
  const stack = new Error().stack ?? '';
  const match = /webgpu[/\\]shader[/\\]validation[/\\](.*?)\.spec\.[tj]s/.exec(stack);
  return match ? match[1].replace(/\\/g, '/') : 'unknown';
}

module.exports = gpuProvider;
