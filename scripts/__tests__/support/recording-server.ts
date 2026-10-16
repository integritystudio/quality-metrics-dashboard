/**
 * A local HTTP server that records every request and answers with a reply the
 * test chooses, so a script's real client and fetch reach a real socket.
 *
 * With `{ tls: true }` it is the parent's ALPN server, offering h2 and HTTP/1.1
 * over a certificate trusted for the server's lifetime, so `alpnProtocol` shows
 * which one the client chose: on Node 26 the built-in fetch picks h2 and
 * `http1Fetch` picks HTTP/1.1 (UNDICI8-GLOBAL-FETCH-HTTP2).
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { startAlpnServer } from '../../../../src/test-helpers/alpn-server.js';

const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const JSON_CONTENT_TYPE = 'application/json';
const TEXT_CONTENT_TYPE = 'text/plain';
const EMPTY_JSON_BODY = '{}';
/** `alpnProtocol` of a request that arrived without TLS. */
export const NO_ALPN = 'none';

export type RecordedRequest = {
  method: string;
  /** Path with its query string, as sent. */
  path: string;
  headers: IncomingHttpHeaders;
  httpVersion: string;
  alpnProtocol: string;
  body: string;
}

/** Answer with an HTTP response. */
export type HttpReply = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Destroy the socket without answering, as a dropped connection does. */
export const DROP_CONNECTION = Symbol('drop-connection');

export type Reply = HttpReply | typeof DROP_CONNECTION;
export type Responder = (request: RecordedRequest) => Reply;

export type RecordingServer = {
  readonly url: string;
  /** Requests received since the last reset, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  respondWith: (responder: Responder) => void;
  /** Forget recorded requests and go back to answering 200 `{}`. */
  reset: () => void;
  close: () => Promise<void>;
}

const answerOk: Responder = () => ({
  status: HTTP_OK,
  headers: { 'content-type': JSON_CONTENT_TYPE },
  body: EMPTY_JSON_BODY,
});

/**
 * A responder that throws would leave the request unanswered until the client
 * times out; answer 500 with the error instead, marked not to be retried.
 */
function replyToResponderError(err: unknown): HttpReply {
  return {
    status: HTTP_INTERNAL_SERVER_ERROR,
    headers: { 'content-type': TEXT_CONTENT_TYPE, 'x-should-retry': 'false' },
    body: `recording-server responder threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  };
}

/** Answer with `replies` in order, repeating the last one once they run out. */
export function inOrder(first: Reply, ...rest: Reply[]): Responder {
  const replies: Reply[] = [first, ...rest];
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? first;
}

/** What `handle` needs of a response, common to `node:http` and `node:http2`'s compat API. */
type ReplyChannel = {
  writeHead: (status: number, headers?: Record<string, string>) => unknown;
  end: (body: string) => unknown;
}

export async function startRecordingServer(options: { tls?: boolean } = {}): Promise<RecordingServer> {
  let requests: RecordedRequest[] = [];
  let responder = answerOk;

  const handle = (req: IncomingMessage | Http2ServerRequest, res: ReplyChannel) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        httpVersion: req.httpVersion,
        alpnProtocol: (req.socket as Partial<TLSSocket>).alpnProtocol || NO_ALPN,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      let reply: Reply;
      try {
        reply = responder(request);
      } catch (err) {
        reply = replyToResponderError(err);
      }
      if (reply === DROP_CONNECTION) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body ?? '');
    });
  };

  const { url, close } = options.tls ? await startAlpnServer(handle) : await listenPlain(handle);
  return {
    url,
    close,
    get requests() { return requests; },
    respondWith(next) { responder = next; },
    reset() {
      requests = [];
      responder = answerOk;
    },
  };
}

async function listenPlain(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Pick<RecordingServer, 'url' | 'close'>> {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(EPHEMERAL_PORT, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    async close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    },
  };
}
