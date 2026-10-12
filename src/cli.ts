#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from './index.js';

/** Argument parsing only; all real work lives in the library. */
export function main(argv: readonly string[], out: (line: string) => void = console.log): number {
  void argv;
  out(`briefstack ${VERSION}`);
  return 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
