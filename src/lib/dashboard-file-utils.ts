/**
 * Dashboard script file I/O utilities with Zod validation.
 *
 * Wraps core file-utils functions to provide validated reading of
 * dashboard script data (traces, evals, transcripts, KV state).
 *
 * Extends src/lib/core/file-utils.ts with dashboard-specific types
 * and validation schemas.
 */

import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Structural schema interface compatible with both Zod v3 and Zod v4 schemas. */
type ParseableSchema<T> = {
  safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: { message: string } };
}

/**
 * Stream lines from a file with Zod schema validation.
 * Yields validated entries, silently skips invalid lines.
 *
 * Useful for processing large JSONL files without loading into memory.
 *
 * @param filePath - Path to JSONL file
 * @param schema - Zod schema for validation
 * @returns Async generator of validated entries
 *
 * @example
 * for await (const span of streamJsonlWithValidation(path, traceSpanSchema)) {
 *   console.log(span.traceId);
 * }
 */
export async function* streamJsonlWithValidation<T>(
  filePath: string,
  schema: ParseableSchema<T>
): AsyncGenerator<T> {
  if (!existsSync(filePath)) return;

  const stream = createReadStream(filePath, 'utf-8');
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      const result = schema.safeParse(parsed);
      if (result.success) {
        yield result.data;
      }
      // Silently skip validation failures
    } catch {
      // Silently skip JSON parse errors
    }
  }
}

/**
 * Load and validate a JSON file.
 *
 * @param filePath - Path to JSON file
 * @param schema - Zod schema for validation
 * @returns Validated object, or null if not found
 * @throws If validation fails
 */
function loadJsonWithValidation<T>(
  filePath: string,
  schema: ParseableSchema<T>
): T | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const result = schema.safeParse(parsed);

    if (result.success) {
      return result.data;
    } else {
      throw new Error(`Validation failed: ${result.error.message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load ${filePath}: ${message}`, { cause: error });
  }
}

/**
 * Load and validate a JSON file, returning fallback on error.
 *
 * @param filePath - Path to JSON file
 * @param schema - Zod schema for validation
 * @param fallback - Value to return if file not found or validation fails
 * @returns Validated object or fallback
 */
export function loadJsonWithValidationSafe<T>(
  filePath: string,
  schema: ParseableSchema<T>,
  fallback: T
): T {
  try {
    return loadJsonWithValidation(filePath, schema) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * `import.meta.dirname` is typed `string` by @types/node but is undefined under
 * runners that transform modules without a file URL (e.g. vitest). Check it at
 * runtime so the result is honestly `string | undefined` — a plain annotation
 * gets flow-narrowed back to `string` and an assertion hides the check.
 */
export function importMetaDirname(meta: { dirname?: unknown }): string | undefined {
  return typeof meta.dirname === 'string' ? meta.dirname : undefined;
}
