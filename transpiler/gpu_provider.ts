// GPU provider for Node.js CTS tests using Dawn (via webgpu npm package)
// Optionally wraps createShaderModule to run code through a transpiler

const { create, globals } = require('webgpu');
import { globalTestConfig } from '../src/common/framework/test_config.js';
import { TRANSPILER_PARSE_ERROR_MARKER } from './transpiler_constants.js';

// Set up WebGPU globals (GPUValidationError, GPUOutOfMemoryError, etc.)
Object.assign(globalThis, globals);

function wrapGPU(gpu: GPU): GPU {
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);

  gpu.requestAdapter = async (options?: GPURequestAdapterOptions) => {
    const adapter = await originalRequestAdapter(options);
    if (!adapter) return adapter;

    return wrapAdapter(adapter);
  };

  return gpu;
}

function wrapAdapter(adapter: GPUAdapter): GPUAdapter {
  const originalRequestDevice = adapter.requestDevice.bind(adapter);

  adapter.requestDevice = async (descriptor?: GPUDeviceDescriptor) => {
    const device = await originalRequestDevice(descriptor);
    if (!device) return device;

    return wrapDevice(device);
  };

  return adapter;
}

function wrapDevice(device: GPUDevice): GPUDevice {
  const originalCreateShaderModule = device.createShaderModule.bind(device);

  device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
    let code = descriptor.code;

    // If transpiler is configured, run code through it
    if (globalTestConfig.shaderTranspiler) {
      try {
        code = globalTestConfig.shaderTranspiler(code);
      } catch (e) {
        // Transpiler failed - create a shader that will fail validation
        // Use valid WGSL syntax (1/0 causes const eval error) to avoid WESL warnings
        const errorMsg = (e as Error).message.replace(/\n/g, ' ');
        code = `/* ${TRANSPILER_PARSE_ERROR_MARKER} ${errorMsg} */ const _e:i32=1/0;`;
      }
    }

    return originalCreateShaderModule({ ...descriptor, code });
  };

  return device;
}

module.exports = {
  create: (flags: string[]) => {
    const gpu = create(flags);

    // Always wrap - the wrapper checks globalTestConfig.shaderTranspiler
    return wrapGPU(gpu);
  }
};
