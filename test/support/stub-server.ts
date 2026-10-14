import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
}
export type Reply = { status: number; body?: string; headers?: Record<string, string> } | 'hang';

export interface Stub {
  url: string;
  hits: Hit[];
  close(): Promise<void>;
}

/** A local HTTP server that records every request and answers with `reply`. */
export async function stubServer(reply: (hit: Hit) => Reply): Promise<Stub> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const hit = { headers: req.headers, body };
      hits.push(hit);
      const answer = reply(hit);
      if (answer === 'hang') return;
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body ?? '');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    hits,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
