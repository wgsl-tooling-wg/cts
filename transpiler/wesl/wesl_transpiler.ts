// WESL transpiler module for CTS shader validation tests
// Exports a transpile function that transforms WGSL through WESL linker
//
// Note: We use dynamic import with Function constructor because:
// 1. The wesl package is ESM-only ("type": "module")
// 2. The CTS uses ts-node which transforms import() to require()
// 3. require() cannot load ESM modules
// The Function constructor prevents ts-node from transforming the import().
// A static `import { _linkSync } from 'wesl'` would fail with ERR_REQUIRE_ESM.

import * as path from 'path';
import type { ShaderTranspiler } from '../../src/common/framework/test_config.js';
import type { _linkSync } from 'wesl';

let linkSync: typeof _linkSync | null = null;

/**
 * Initialize the transpiler by loading the WESL module.
 * Must be called before transpile().
 */
export async function init(): Promise<void> {
  if (linkSync) return;

  // Construct path to wesl ESM module in node_modules
  const weslPath = path.join(__dirname, 'node_modules/wesl/dist/index.js');
  // Use Function constructor to prevent ts-node from transforming import() to require()
  const importDynamic = new Function('specifier', 'return import(specifier)');
  const wesl = await importDynamic(weslPath);
  linkSync = wesl._linkSync;
}

/**
 * Transpile WGSL code through the WESL linker.
 */
export const transpile: ShaderTranspiler = (code: string): string => {
  if (!linkSync) {
    throw new Error('WESL transpiler not initialized. Call init() first.');
  }

  const srcMap = linkSync({
    weslSrc: { './main.wesl': code },
    rootModuleName: 'main',
    config: {},
  });

  return srcMap.dest.text;
};
