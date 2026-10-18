/**
 * Listen on an ephemeral loopback port and hand back the URL and a close, the
 * plumbing every local test server in this package otherwise repeats: the
 * `listen` promise, the `address()` cast and the `close` callback's error.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

export type LoopbackServer = {
  /** The port the OS chose. */
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  close: () => Promise<void>;
};

export async function listenLoopback(server: Server): Promise<LoopbackServer> {
  await new Promise<void>(resolve => { server.listen(EPHEMERAL_PORT, LOOPBACK_HOST, resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://${LOOPBACK_HOST}:${port}`,
    close: async (): Promise<void> => {
      // An idle keep-alive socket keeps `close()` waiting until it times out.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close(err => (err ? reject(err) : resolve())); });
    },
  };
}
