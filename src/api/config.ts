/** API server hostname (node-server only). */
export const API_HOST = '127.0.0.1';

/** API server port (node-server only). Reads API_PORT env, defaults to 3001. */
export const API_PORT = Number(process.env.API_PORT) || 3001;
