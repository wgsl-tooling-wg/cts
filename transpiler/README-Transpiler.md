# WESL Transpiler Testing with WebGPU CTS

This document describes how to test the WESL transpiler against the WebGPU Conformance Test Suite (CTS).

## Overview

The setup allows running CTS tests through the WESL transpiler and comparing results against baseline (non-transpiled) runs. This helps identify:
- **Parse errors**: WESL can't parse valid WGSL
- **Mistranslations**: WESL produces invalid output from valid input
- **Too permissive**: WESL accepts code that should be rejected

## Prerequisites

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

### Full Test Run with Comparison

```bash
# 1. Run baseline (no transpiler) and save JSON
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --print-json --quiet 'webgpu:shader,validation,parse,*' \
  > /tmp/baseline.json

# 2. Run with transpiler and save JSON
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  --print-json --quiet 'webgpu:shader,validation,parse,*' \
  > /tmp/transpiled.json

# 3. Compare results
transpiler/tools/compare_results.ts /tmp/baseline.json /tmp/transpiled.json
```

Note: Use absolute paths (or `$PWD`) because the CTS loader enforces `.js` extensions for relative imports.

### Quick Sanity Check

```bash
# Run examples (fast, ~20 tests)
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  'webgpu:examples,*'

# Run flow control (medium, ~140 tests)
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  'webgpu:shader,execution,flow_control,*'
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

### Example Browser URLs

```bash
# Parse validation tests with transpiler
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,validation,parse,*

# Execution tests with transpiler
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,execution,flow_control,*
```

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

### Run Single Test

Copy the full test name from comparison output or browser runner:

**Node:**
```bash
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts \
  --shader-transpiler $PWD/transpiler/wesl/wesl_transpiler.ts \
  --verbose 'webgpu:shader,validation,parse,diagnostic:valid_params:severity="info";rule="derivative_uniformity";type="attribute"'
```

**Browser:**
```
http://localhost:8080/standalone/?shader_transpiler=/transpiler/wesl/wesl_transpiler.js&q=webgpu:shader,validation,parse,diagnostic:valid_params:severity="info";rule="derivative_uniformity";type="attribute"
```

### List Tests Without Running

```bash
tools/run_node --gpu-provider $PWD/transpiler/gpu_provider.ts --list 'QUERY'
```

## Troubleshooting

### "WESL transpiler not initialized" (Node)

The transpiler module failed to load. Check the path in `wesl_transpiler.ts`.

### "Failed to load transpiler module" (Browser)

- Ensure the transpiler JavaScript file exists at the specified URL
- The URL must be absolute (e.g., `/transpiler/wesl/wesl_transpiler.js`) or fully qualified

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
- **Both:** Parse errors show `[TRANSPILER-PARSE-ERROR]` in the shader output
- **Browser:** The `shader_transpiler` parameter uses snake_case (not camelCase)