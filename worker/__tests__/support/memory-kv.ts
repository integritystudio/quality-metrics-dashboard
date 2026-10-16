/**
 * A Map-backed Workers KV namespace for the worker's route tests.
 *
 * Values are held as the strings KV stores, so `get(key, 'json')` parses what `put` wrote, as
 * the binding does, and a seeded object reaches the worker the same way a synced one would.
 * Expiration is not modelled: nothing the worker reads depends on it.
 */
type KvValueType = 'text' | 'json' | 'arrayBuffer' | 'stream';
type KvGetOptions = KvValueType | { type?: KvValueType };
type KvPutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream;

type KvPutOptions = {
  metadata?: unknown;
}

type KvListOptions = {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

type KvListKey = {
  name: string;
  metadata?: unknown;
}

type KvListResult =
  | { keys: KvListKey[]; list_complete: true; cacheStatus: null }
  | { keys: KvListKey[]; list_complete: false; cursor: string; cacheStatus: null };

type StoredEntry = {
  value: string;
  metadata: unknown;
}

const DEFAULT_LIST_LIMIT = 1000;
const DEFAULT_VALUE_TYPE: KvValueType = 'text';

function valueTypeOf(options: KvGetOptions | undefined): KvValueType {
  if (typeof options === 'string') return options;
  return options?.type ?? DEFAULT_VALUE_TYPE;
}

function decode(value: string, type: KvValueType): unknown {
  switch (type) {
    case 'json': return JSON.parse(value) as unknown;
    case 'arrayBuffer': return new TextEncoder().encode(value).buffer;
    case 'stream': return new Response(value).body;
    case 'text': return value;
  }
}

async function encode(value: KvPutValue): Promise<string> {
  if (typeof value === 'string') return value;
  if (value instanceof ReadableStream) return new Response(value).text();
  return new TextDecoder().decode(value);
}

export class MemoryKv {
  readonly #entries = new Map<string, StoredEntry>();

  /** Each seed value is stored as its JSON text, the form sync-to-kv writes. */
  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.#entries.set(key, { value: JSON.stringify(value), metadata: null });
    }
  }

  get(key: string, options?: KvGetOptions): Promise<unknown> {
    const entry = this.#entries.get(key);
    return Promise.resolve(entry ? decode(entry.value, valueTypeOf(options)) : null);
  }

  getWithMetadata(key: string, options?: KvGetOptions): Promise<{ value: unknown; metadata: unknown; cacheStatus: null }> {
    const entry = this.#entries.get(key);
    return Promise.resolve({
      value: entry ? decode(entry.value, valueTypeOf(options)) : null,
      metadata: entry?.metadata ?? null,
      cacheStatus: null,
    });
  }

  async put(key: string, value: KvPutValue, options: KvPutOptions = {}): Promise<void> {
    this.#entries.set(key, { value: await encode(value), metadata: options.metadata ?? null });
  }

  delete(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  list({ prefix = '', cursor, limit = DEFAULT_LIST_LIMIT }: KvListOptions = {}): Promise<KvListResult> {
    const names = [...this.#entries.keys()].filter((name) => name.startsWith(prefix)).sort();
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) return Promise.reject(new Error(`Invalid list cursor: ${cursor}`));
    const end = start + limit;
    const keys = names.slice(start, end).map((name) => {
      const { metadata } = this.#entries.get(name) ?? { metadata: null };
      return metadata === null ? { name } : { name, metadata };
    });
    if (end >= names.length) return Promise.resolve({ keys, list_complete: true, cacheStatus: null });
    return Promise.resolve({ keys, list_complete: false, cursor: String(end), cacheStatus: null });
  }
}
