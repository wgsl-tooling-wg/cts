/* eslint-disable no-process-exit, n/no-process-exit */
/* eslint-disable @typescript-eslint/no-namespace */

declare global {
  namespace Deno {
    function readFile(path: string): Promise<Uint8Array>;
    function readFileSync(path: string): Uint8Array;
    const args: string[];
    const cwd: () => string;
    function exit(code?: number): never;
  }
}

type ReadFileCallback = (err: { message: string } | null, data: Uint8Array) => void;

interface Sys {
  type: string;
  readFile: (path: string, callback: ReadFileCallback) => void;
  existsSync: (path: string) => boolean;
  args: string[];
  cwd: () => string;
  exit: (code?: number) => never;
}

const sys = getSys();

function getSys(): Sys {
  const isDeno = typeof globalThis.Deno !== 'undefined';
  return isDeno ? denoSys() : nodeSys();
}

function denoSys(): Sys {
  return {
    type: 'deno',
    existsSync(path: string) {
      try {
        Deno.readFileSync(path);
        return true;
      } catch {
        return false;
      }
    },
    readFile(path: string, callback: ReadFileCallback) {
      Deno.readFile(path).then(
        data => callback(null, data),
        err => callback({ message: String(err) }, new Uint8Array())
      );
    },
    args: Deno.args,
    cwd: Deno.cwd,
    exit: Deno.exit,
  };
}

function nodeSys(): Sys {
  // require() must be inside this function - Deno 2 doesn't support require()
  /* eslint-disable-next-line n/no-restricted-require */
  const fs = require('fs');
  return {
    type: 'node',
    readFile: fs.readFile,
    existsSync: fs.existsSync,
    args: process.argv.slice(2),
    cwd: () => process.cwd(),
    exit: (code?: number | undefined) => process.exit(code),
  };
}

export default sys;
