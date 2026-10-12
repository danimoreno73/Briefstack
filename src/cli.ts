#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configFilePath, readConfig, resolvePaths } from './config/config.js';
import { systemPathEnv, type PathEnv } from './config/paths.js';
import { isBriefstackError } from './errors.js';
import { cliMessages } from './i18n/cli.js';
import { formatError } from './i18n/errors.js';
import { resolveLang, systemLocale, type Lang } from './i18n/index.js';
import { scaffoldMessages } from './i18n/scaffold.js';
import { VERSION } from './index.js';
import { PACKAGE_ROOT } from './packageRoot.js';
import { scaffold } from './scaffold/index.js';
import { readSpec } from './spec/index.js';

/** Argument parsing only; all real work lives in the library. */

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  pathEnv: PathEnv;
}

const defaultIO = (): CliIO => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  cwd: process.cwd(),
  pathEnv: systemPathEnv(),
});

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
}

function parseArgs(args: readonly string[], allowedFlags: readonly string[], lang: Lang): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (!allowedFlags.includes(arg)) throw new UsageError(cliMessages[lang].unknownOption(arg));
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

async function runScaffold(args: readonly string[], io: CliIO, lang: Lang): Promise<number> {
  const messages = scaffoldMessages[lang];
  const { positionals, flags } = parseArgs(args, ['--allow-non-empty'], lang);
  const [specArg, outArg] = positionals;
  if (positionals.length !== 2 || specArg === undefined || outArg === undefined) {
    throw new UsageError(cliMessages[lang].wrongArguments(messages.usage));
  }

  const config = await readConfig(configFilePath(io.pathEnv));
  const paths = resolvePaths(config, io.pathEnv);
  const spec = await readSpec(path.resolve(io.cwd, specArg));
  const result = await scaffold(spec, path.resolve(io.cwd, outArg), {
    protectedDirs: [
      { root: 'repo', path: PACKAGE_ROOT },
      { root: 'library', path: paths.libraryDir },
    ],
    templateRoots: [
      path.join(paths.libraryDir, 'templates'),
      path.join(PACKAGE_ROOT, 'library', 'templates'),
    ],
    allowNonEmpty: flags.has('--allow-non-empty'),
  });

  io.out(messages.created(result.outDir, result.files.length, result.template));
  if (result.gitInitialised) io.out(messages.gitInitialised);
  for (const warning of result.warnings) io.err(messages.warning(warning));
  return EXIT_OK;
}

async function detectLang(io: CliIO): Promise<Lang> {
  let configLang: string | undefined;
  try {
    configLang = (await readConfig(configFilePath(io.pathEnv))).lang;
  } catch {
    // A broken config is reported by the command that needs it.
  }
  return resolveLang({ env: io.pathEnv.env, configLang, osLocale: systemLocale() });
}

export async function main(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  const lang = await detectLang(io);
  z.config(lang === 'es' ? z.locales.es() : z.locales.en());
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case '--version':
        io.out(`briefstack ${VERSION}`);
        return EXIT_OK;
      case undefined:
      case '--help':
        io.out(cliMessages[lang].usage);
        return EXIT_OK;
      case 'scaffold':
        return await runScaffold(rest, io, lang);
      default:
        throw new UsageError(cliMessages[lang].unknownCommand(command));
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    if (isBriefstackError(error)) {
      io.err(formatError(error, lang));
      return EXIT_ERROR;
    }
    io.err(cliMessages[lang].unexpected(error instanceof Error ? error.message : String(error)));
    return EXIT_ERROR;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
