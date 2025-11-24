# WESL Transpiler Testing with WebGPU CTS

This document describes how to test the WESL transpiler against the WebGPU Conformance Test Suite (CTS).

## Overview

The setup allows running CTS tests through the WESL transpiler and comparing results against baseline (non-transpiled) runs. This helps identify:
- **Parse errors**: WESL can't parse valid WGSL
- **Mistranslations**: WESL produces invalid output from valid input
- **Too permissive**: WESL accepts code that should be rejected

## Prerequisites

- Node.js (modern version with TypeScript support)
```bash
npm install
```

## Configuration

### WESL Package

The WESL transpiler is configured via `transpiler/wesl/package.json`. Edit the `wesl` dependency path:

```json
{
  "dependencies": {
    "wesl": "file:../../../tools/packages/wesl"
  }
}
```

Then install dependencies:

```bash
cd transpiler/wesl && npm install
```

## Running Tests in Node

### Basic Usage

```bash
# Run baseline (no transpiler)
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts 'QUERY'

# Run with transpiler
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts 'QUERY'
```

Note: Use absolute paths (or `$PWD`) because the CTS loader enforces `.js` extensions for relative imports.

### Capturing Results for Comparison

```bash
# 1. Run baseline and save JSON
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --print-json --quiet 'QUERY' > baseline.json

# 2. Run with transpiler and save JSON
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  --print-json --quiet 'QUERY' > transpiled.json

# 3. Compare results
transpiler/tools/compare_results.ts baseline.json transpiled.json
```

## Running Tests in Browser

### Setup

1. Build the transpiler module for the browser:

```bash
cd transpiler/wesl
npm install
npm run build  # If a build step is configured
```

2. Start the standalone server:

```bash
npm start
```

3. Navigate to [http://localhost:8080/standalone/](http://localhost:8080/standalone/)

### Using the Transpiler

Add the `shader_transpiler` URL parameter to enable transpilation:

```
http://localhost:8080/standalone/?shader_transpiler=<TRANSPILER_URL>&q=<QUERY>
```

For local development, the transpiler URL needs to be an absolute path to the transpiler module. For example:

```
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,validation,parse,*
```

**Note**: The transpiler module URL must be accessible from the browser and must be a `.js` file (not `.ts`). Ensure your transpiler module is built/transpiled to JavaScript and served by the development server.

### Example Browser URLs

```bash
# Parse validation tests with transpiler
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,validation,parse,*

# Execution tests with transpiler
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,execution,flow_control,*

# Examples with transpiler
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:examples,*
```

### Comparing Browser Results

The browser runner doesn't have built-in JSON export, but you can:
1. Run tests with transpiler enabled and note failures
2. Run same tests without the `shader_transpiler` parameter
3. Manually compare results

Alternatively, use the Node runner for automated comparison (see above).

## Common Test Queries

### Validation Tests

```bash
# All parse validation tests (~3300 tests)
'webgpu:shader,validation,parse,*'

# Specific parse category
'webgpu:shader,validation,parse,diagnostic,*'
'webgpu:shader,validation,parse,identifiers,*'

# All validation tests (larger)
'webgpu:shader,validation,*'
```

### Execution Tests

```bash
# Flow control tests (~140 tests)
'webgpu:shader,execution,flow_control,*'

# Statement tests (~40 tests)
'webgpu:shader,execution,statement,*'

# Zero init tests (~350 tests)
'webgpu:shader,execution,zero_init,*'

# Shader IO tests (~1000 tests)
'webgpu:shader,execution,shader_io,*'

# Built-in function tests (many thousands)
'webgpu:shader,execution,expression,call,builtin,abs,*'
```

### Examples

```bash
# Example tests (~20 tests)
'webgpu:examples,*'
```

## Interpreting Results

### Comparison Output (Node)

```
** Comparison Summary **
Total tests compared: 3310
Both pass:            3297
Both fail:            0
Both skip:            0

** Parse Errors (1) **
(WESL failed to parse valid WGSL)
  webgpu:shader,validation,parse,source:empty:

** Mistranslations (12) **
(WESL produced invalid output from valid input)
  webgpu:shader,validation,parse,identifiers:alias_name:ident="binding_array"
  ...

** Transpiler Issues **
  parse-errors:    1 (WESL can't parse valid WGSL)
  mistranslations: 12 (WESL produces invalid output)
  too-permissive:  0 (WESL accepts what Dawn rejects)
```

### Issue Types

| Type | Meaning | Severity |
|------|---------|----------|
| Parse Error | WESL throws when parsing valid WGSL | High |
| Mistranslation | WESL parses but outputs invalid code | High |
| Too Permissive | WESL accepts code that should be rejected | Medium |

## Debugging Failing Tests

### Get Shader Code (Node)

Use `--verbose` to see the actual shader code:

```bash
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  --verbose 'webgpu:shader,validation,parse,diagnostic:valid_locations:type="attribute";location="if_stmt";rule="derivative_uniformity"'
```

Output shows:
```
---- shader ----
fn foo() { @diagnostic(info, derivative_uniformity) if true { } }
```

### Browser DevTools

In the browser, open DevTools console to see:
- Parse errors from the transpiler
- Shader validation errors from WebGPU
- Test failures and error messages

### Run Single Test

Copy the full test name from comparison output or browser runner:

**Node:**
```bash
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  --verbose 'webgpu:shader,validation,parse,source:empty:'
```

**Browser:**
```
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,validation,parse,source:empty:
```

### List Tests Without Running

```bash
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts --list 'QUERY'
```

## File Structure

```
cts/
└── transpiler/
    ├── gpu_provider.ts          # GPU provider for Node tests
    ├── transpiler_constants.ts  # Shared constants
    ├── README-Transpiler.md     # This file
    ├── tools/
    │   └── compare_results.ts   # Result comparison script (Node)
    └── wesl/
        ├── package.json         # WESL dependency config
        └── wesl_transpiler.ts   # WESL transpiler wrapper
```

## Example Workflows

### Full Parse Test Run (Node)

```bash
# 1. Run baseline
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --print-json --quiet 'webgpu:shader,validation,parse,*' \
  > /tmp/baseline.json

# 2. Run with transpiler
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  --print-json --quiet 'webgpu:shader,validation,parse,*' \
  > /tmp/transpiled.json

# 3. Compare
transpiler/tools/compare_results.ts /tmp/baseline.json /tmp/transpiled.json
```

### Quick Sanity Check (Node)

```bash
# Run examples (fast)
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  'webgpu:examples,*'

# Run flow control (medium)
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  'webgpu:shader,execution,flow_control,*'
```

### Browser Testing Workflow

```bash
# 1. Start server
npm start

# 2. Open browser to baseline (no transpiler)
http://localhost:8080/standalone/?q=webgpu:shader,validation,parse,*

# 3. Note results, then add transpiler
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,validation,parse,*

# 4. Compare failures manually or use Node runner for automated comparison
```

## Troubleshooting

### "WESL transpiler not initialized" (Node)

The transpiler module failed to load. Check the path in `wesl_transpiler.ts`.

### "Failed to load transpiler module" (Browser)

- Ensure the transpiler JavaScript file exists at the specified URL
- Check browser DevTools Network tab for 404 errors
- Verify the module exports the required `transpile` function
- The URL must be absolute (e.g., `/transpiler/wesl/wesl_transpiler.js`) or fully qualified

### "All relative imports must end in .js"

The CTS loader requires `.js` extensions. Make sure imports use `.js`:
```typescript
import { foo } from './bar.js';  // Correct
import { foo } from './bar.ts';  // Wrong
```

### Tests Timing Out

Some test suites (especially expression tests) are very large. Run smaller subsets:
```bash
# Instead of all execution tests
'webgpu:shader,execution,*'

# Run specific categories
'webgpu:shader,execution,flow_control,*'
'webgpu:shader,execution,statement,*'
```
## Notes

- **Node:** The `--quiet` flag suppresses per-test output but keeps the summary
- **Node:** The `--print-json` flag outputs machine-readable results
- **Node:** Exit code is 1 if any tests fail or have warnings
- **Both:** Parse errors show `[TRANSPILER-PARSE-ERROR]` in the shader output
- **Browser:** The `shader_transpiler` parameter uses snake_case (not camelCase)
- **Browser:** Use browser DevTools to inspect transpiler errors and WebGPU validation failures
