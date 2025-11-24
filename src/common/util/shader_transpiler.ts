import { globalTestConfig } from '../framework/test_config.js';

// Marker for transpiler parse errors (must match transpiler/transpiler_constants.ts)
const TRANSPILER_PARSE_ERROR_MARKER = '[TRANSPILER-PARSE-ERROR]';

/** Wrap a device's createShaderModule to run code through the configured transpiler. */
export function wrapDeviceWithTranspiler(device: GPUDevice): void {
  const transpiler = globalTestConfig.shaderTranspiler;
  if (!transpiler) return;

  const origCreateShaderModule = device.createShaderModule.bind(device);

  device.createShaderModule = function (descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
    if (!descriptor.code || typeof descriptor.code !== 'string') {
      return origCreateShaderModule(descriptor);
    }

    try {
      const newCode = transpiler(descriptor.code);
      return origCreateShaderModule({ ...descriptor, code: newCode });
    } catch (e) {
      // Return shader with error marker so tests can detect parse errors
      // Use valid WGSL syntax (1/0 causes const eval error) to avoid WESL warnings
      const errorMsg = String(e).replace(/\n/g, ' ');
      const errorCode = `/* ${TRANSPILER_PARSE_ERROR_MARKER} ${errorMsg} */ const _e:i32=1/0;`;
      return origCreateShaderModule({ ...descriptor, code: errorCode });
    }
  };
}
