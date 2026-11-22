/**
 * Signed calls to the parent's api-provisioning-receiver `/inbox`, the one service that may
 * store an org's judge key in AI Gateway. The signature is HMAC-SHA256, lowercase hex, over
 * `<timestamp>.<body>`, with the timestamp in epoch milliseconds and the key named by id: the
 * receiver resolves `x-key-id` in its SIGNING_KEYS map and refuses any other shape.
 */
import { CONTENT_TYPE_HEADER, ContentType } from '../src/lib/http-constants.js';

const INBOX_PATH = '/inbox';
const RECEIVER_TIMEOUT_MS = 15_000;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export const RECEIVER_HEADER = {
  TIMESTAMP: 'x-timestamp',
  SIGNATURE: 'x-signature',
  KEY_ID: 'x-key-id',
} as const;

export type ReceiverEnv = {
  PROVISIONING_RECEIVER_URL?: string;
  PROVISIONING_SIGNING_KEY_ID?: string;
  PROVISIONING_SIGNING_SECRET?: string;
};

type ReceiverAccess = { url: string; keyId: string; secret: string };

/** The receiver coordinates, or null when any of the three is unbound. */
export function receiverAccess(env: ReceiverEnv): ReceiverAccess | null {
  const { PROVISIONING_RECEIVER_URL: url, PROVISIONING_SIGNING_KEY_ID: keyId, PROVISIONING_SIGNING_SECRET: secret } = env;
  return url && keyId && secret ? { url, keyId, secret } : null;
}

export async function signReceiverMessage(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return Array.from(signature, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0')).join('');
}

/** POSTs `payload` to `/inbox`, signed; a transport failure resolves to null rather than throwing. */
export async function postToReceiver(access: ReceiverAccess, payload: Record<string, unknown>): Promise<Response | null> {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = await signReceiverMessage(access.secret, `${timestamp}.${body}`);
  return fetch(new URL(INBOX_PATH, access.url), {
    method: 'POST',
    headers: {
      [CONTENT_TYPE_HEADER]: ContentType.Json,
      [RECEIVER_HEADER.TIMESTAMP]: timestamp,
      [RECEIVER_HEADER.SIGNATURE]: signature,
      [RECEIVER_HEADER.KEY_ID]: access.keyId,
    },
    body,
    signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
  }).catch(() => null);
}
