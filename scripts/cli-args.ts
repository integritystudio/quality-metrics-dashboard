/**
 * Command-line parsing shared by the pipeline scripts.
 *
 * Wraps `node:util` `parseArgs`, so `--days=7` and `--days 7` mean the same
 * thing in every script. Flags are named the way the scripts' own constants
 * spell them (`--limit`, `--source=`); the trailing `=` is ignored.
 */

import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { pathToFileURL } from 'node:url';

const FLAG_PREFIX = '--';
const INLINE_VALUE_SEPARATOR = '=';

/** `unknown`: a flag or argument the script does not take. `invalid`: a known flag used wrongly. */
export type CliArgErrorKind = 'unknown' | 'invalid';

/** A command line the user can fix: callers print the message and exit non-zero. */
export class CliArgError extends Error {
  override name = 'CliArgError';

  constructor(message: string, readonly kind: CliArgErrorKind = 'invalid') {
    super(message);
  }
}

/** The flags a script reads: `values` take an argument, `switches` do not. */
export interface CliSpec {
  values?: readonly string[];
  switches?: readonly string[];
}

export interface CliParseOptions {
  /**
   * Ignore flags missing from the spec (the default): several scripts share a
   * command line, each reading its own flags. `false` rejects them, and any
   * positional argument too.
   */
  allowUnknown?: boolean;
}

export interface CliArgs {
  readonly positionals: readonly string[];
  /** Whether a declared switch was given. */
  has(flag: string): boolean;
  /** A declared value flag's argument; `undefined` when the flag is absent. */
  value(flag: string): string | undefined;
}

/** `--limit` and `--source=` → `limit` and `source`. */
function optionName(flag: string): string {
  const name = flag.startsWith(FLAG_PREFIX) ? flag.slice(FLAG_PREFIX.length) : flag;
  return name.endsWith(INLINE_VALUE_SEPARATOR) ? name.slice(0, -INLINE_VALUE_SEPARATOR.length) : name;
}

/**
 * Parse `argv` against `spec`. Throws `CliArgError` when a value flag has no
 * argument (including `--limit --dry-run`, which `parseArgs` would read as the
 * value `--dry-run`), when a switch is given a value, and, with
 * `allowUnknown: false`, on an undeclared flag or a positional argument.
 */
export function parseCli(argv: readonly string[], spec: CliSpec, { allowUnknown = true }: CliParseOptions = {}): CliArgs {
  const valueNames = new Set((spec.values ?? []).map(optionName));
  const switchNames = new Set((spec.switches ?? []).map(optionName));
  const options: ParseArgsOptionsConfig = {};
  for (const name of valueNames) options[name] = { type: 'string' };
  for (const name of switchNames) options[name] = { type: 'boolean' };
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (valueNames.has(token.name)) {
      if (token.value === undefined || (!token.inlineValue && token.value.startsWith(FLAG_PREFIX))) {
        throw new CliArgError(`${token.rawName} needs a value`);
      }
    } else if (switchNames.has(token.name)) {
      if (token.value !== undefined) throw new CliArgError(`${token.rawName} takes no value`);
    } else if (!allowUnknown) {
      throw new CliArgError(`Unknown argument: ${token.rawName}`, 'unknown');
    }
  }
  const [positional] = positionals;
  if (!allowUnknown && positional !== undefined) throw new CliArgError(`Unknown argument: ${positional}`, 'unknown');

  const declared = (flag: string, names: ReadonlySet<string>): string => {
    const name = optionName(flag);
    if (!names.has(name)) throw new Error(`${flag} is not declared in this script's CliSpec`);
    return name;
  };
  return {
    positionals,
    has: flag => values[declared(flag, switchNames)] === true,
    value: (flag) => {
      const value = values[declared(flag, valueNames)];
      return typeof value === 'string' ? value : undefined;
    },
  };
}

/**
 * `read()`, or, when it throws `CliArgError`, print `<logPrefix> <message>`
 * and exit 1: the entry-point handling for a command line the user can fix.
 */
export function exitOnCliArgError<T>(logPrefix: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (!(err instanceof CliArgError)) throw err;
    console.error(`${logPrefix} ${err.message}`);
    process.exit(1);
  }
}

/** Strip a trailing `=` from a flag label so error messages read `--days` not `--days=`. */
function displayLabel(label: string): string {
  return label.endsWith(INLINE_VALUE_SEPARATOR) ? label.slice(0, -INLINE_VALUE_SEPARATOR.length) : label;
}

/** `raw` as a positive integer; `undefined` when absent. Throws `CliArgError` when it is not one. */
export function positiveIntArg(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new CliArgError(`${displayLabel(label)} must be a positive integer, got "${raw}"`);
  return value;
}

/** `raw` as a number above zero; `undefined` when absent. Throws `CliArgError` when it is not one. */
export function positiveNumberArg(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CliArgError(`${displayLabel(label)} must be a positive number, got "${raw}"`);
  return value;
}

/** `raw` as a number at or above zero; `undefined` when absent. Throws `CliArgError` when it is not one. */
export function nonNegativeNumberArg(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new CliArgError(`${displayLabel(label)} must be a non-negative number, got "${raw}"`);
  return value;
}

/**
 * Run `main()` only when this module is the entry point. Replaces the fragile
 * `process.argv[1]?.endsWith('foo.ts')` pattern used in several scripts.
 *
 * @param moduleUrl  Pass `import.meta.url` from the calling module.
 * @param main       Async entry point; may return an exit code.
 * @param logPrefix  Prefix for fatal error messages, e.g. `'[sync]'`.
 */
export function runIfMain(
  moduleUrl: string,
  main: () => Promise<unknown>,
  logPrefix: string,
): void {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  main()
    .then(code => { if (typeof code === 'number') process.exit(code); })
    .catch((err: unknown) => {
      console.error(`${logPrefix} fatal:`, err);
      process.exit(1);
    });
}
