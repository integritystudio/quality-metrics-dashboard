/**
 * The Cloudflare KV client the pipeline scripts share: where the account and
 * namespace come from, and the fetch wrapper the SDK needs for KV's 204s and
 * the daily write limit. `derive-evaluations.ts` publishes `meta:calibration`
 * through it.
 */
import Cloudflare, { type ClientOptions as CloudflareClientOptions } from 'cloudflare';
import { parse as parseToml } from 'smol-toml';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../src/lib/http-constants.js';
import { KV_SCHEMA_VERSION } from '../src/api/api-constants.js';
import type { KVEntry } from '../src/api/aggregates/kv-entry.js';

type CloudflareConfig = {
  accountId: string;
  namespaceId: string;
}

/** `account_id` and the first `[[kv_namespaces]]` id in wrangler.toml, where it has them. */
function wranglerIds(tomlPath: string): { accountId: string | undefined; namespaceId: string | undefined } {
  const raw = readFileSync(tomlPath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${tomlPath}: ${describeUnknown(err)}`, { cause: err });
  }
  const kvNamespaces = Array.isArray(parsed.kv_namespaces) ? parsed.kv_namespaces : [];
  const firstNs = kvNamespaces[0] as Record<string, unknown> | undefined;
  return {
    accountId: typeof parsed.account_id === 'string' ? parsed.account_id : undefined,
    namespaceId: typeof firstNs?.id === 'string' ? firstNs.id : undefined,
  };
}

function resolveCloudflareConfig(): CloudflareConfig {
  const envNamespaceId = process.env.KV_NAMESPACE_ID;
  const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envNamespaceId && envAccountId) return { namespaceId: envNamespaceId, accountId: envAccountId };

  const tomlPath = join(import.meta.dirname, '..', 'wrangler.toml');
  if (existsSync(tomlPath)) {
    const fromToml = wranglerIds(tomlPath);
    const accountId = envAccountId ?? fromToml.accountId;
    const namespaceId = envNamespaceId ?? fromToml.namespaceId;
    if (accountId && namespaceId) return { accountId, namespaceId };
  }

  const missing: string[] = [];
  if (!process.env.KV_NAMESPACE_ID) missing.push('KV_NAMESPACE_ID');
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
  throw new Error(
    `Could not resolve Cloudflare config. Set ${missing.join(' and ')} or ensure wrangler.toml has account_id and [[kv_namespaces]] with id.`,
  );
}

let cfConfig: CloudflareConfig | undefined;
/** Resolved on first KV call, so importing this module or a dry run needs no config. */
export function getCloudflareConfig(): CloudflareConfig {
  return cfConfig ??= resolveCloudflareConfig();
}

/** The fetch the Cloudflare client accepts as its `fetch` option. */
type SdkFetch = NonNullable<CloudflareClientOptions['fetch']>;

/** Cloudflare API error code for the KV daily write limit (free tier only). */
export const KV_DAILY_WRITE_LIMIT_CODE = 10048;
/** The SDK obeys this header over its own retry rules. */
const SDK_SHOULD_RETRY_HEADER = 'x-should-retry';
const NULL_RESULT_BODY = '{"result":null}';
/** Set on a response kvSdkFetch rewrote from a 204, so a caller can tell it from a 200 with a null result. */
export const KV_ORIGINAL_STATUS_HEADER = 'x-kv-original-status';

async function isDailyWriteLimit(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as { errors?: Array<{ code?: unknown }> };
    return body.errors?.some(e => e.code === KV_DAILY_WRITE_LIMIT_CODE) ?? false;
  } catch {
    return false;
  }
}

/**
 * Fetch wrapper passed to the Cloudflare SDK.
 *
 * - An HTTP 204 (no body) becomes a 200 with `{"result":null}`, so the SDK's
 *   `_thenUnwrap((obj) => obj.result)` receives null rather than throwing
 *   `TypeError: Cannot read properties of null (reading 'result')`. The
 *   `result == null` guard in kvBulkPut then credits all batch keys. The original
 *   headers are kept, plus `KV_ORIGINAL_STATUS_HEADER`.
 * - The daily-write-limit 429 gets `x-should-retry: false`: it cannot succeed until
 *   the next day, so the SDK's retries would only add backoff. Connection failures
 *   and other 429s keep the SDK's retries.
 *
 * All other responses are forwarded unchanged.
 *
 * Exported for unit-testing the wrapper in isolation.
 */
export const kvSdkFetch: SdkFetch = async (url, init) => {
  const response = await http1Fetch(url, init);
  if (response.status === HttpStatus.NoContent) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set(CONTENT_TYPE_HEADER, ContentType.Json);
    headers.set(KV_ORIGINAL_STATUS_HEADER, String(HttpStatus.NoContent));
    return new Response(NULL_RESULT_BODY, { status: HttpStatus.Ok, headers });
  }
  if (response.status === HttpStatus.TooManyRequests && await isDailyWriteLimit(response.clone())) {
    const headers = new Headers(response.headers);
    // undici has already decoded the body, so the encoded length and encoding no longer describe it.
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set(SDK_SHOULD_RETRY_HEADER, 'false');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
};

let cfClient: Cloudflare | undefined;
export function getCloudflareClient(): Cloudflare {
  // HTTP/1.1: under Node 26's default HTTP/2 fetch a destroyed session fails the
  // SDK's own retries too (ERR_HTTP2_INVALID_SESSION; NODE-FETCH-HTTP2-DEAD-SESSION).
  // kvSdkFetch rewrites 204s and the daily-limit 429 before the SDK sees them.
  return cfClient ??= new Cloudflare({ fetch: kvSdkFetch });
}

const ORG_KEY_PREFIX = 'org:';

export function orgPrefixedKey(orgId: string, key: string): string {
  return `${ORG_KEY_PREFIX}${orgId}:${key}`;
}

export type EnvelopedKVPair = {
  key: string;
  value: string;
  expiration_ttl?: number;
}

export function envelope(e: KVEntry): EnvelopedKVPair {
  return {
    key: e.key,
    // `e.value` is already JSON (toKVValue), so the version envelope is spliced
    // around it as text; parsing and re-serializing gave the same bytes.
    value: `{"v":${JSON.stringify(KV_SCHEMA_VERSION)},"data":${e.value}}`,
    ...(e.expirationTtl != null ? { expiration_ttl: e.expirationTtl } : {}),
  };
}

/** Writes a handful of entries in one request and throws if Cloudflare took none or only some of them. */
export async function putKvEntries(entries: KVEntry[]): Promise<void> {
  const { namespaceId, accountId } = getCloudflareConfig();
  const result = await getCloudflareClient().kv.namespaces.bulkUpdate(namespaceId, {
    account_id: accountId,
    body: entries.map(entry => envelope(entry)),
  });
  const unwritten = result?.unsuccessful_keys ?? [];
  if (unwritten.length > 0) throw new Error(`Cloudflare KV did not write ${unwritten.join(', ')}`);
}
