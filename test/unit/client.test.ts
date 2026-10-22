import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
const { call, Gone } = await import('../../dist/client.js');

describe('Given a review that takes a moment to answer, and Node’s agent, which times its sockets out sooner, ', () => {
  let server: http.Server;
  let url = '';
  const kept = http.globalAgent;

  before(async () => {
    // Node's own agent times a socket out after 5 seconds: this one, after a fifth of a second.
    Object.assign(http, { globalAgent: new http.Agent({ keepAlive: true, timeout: 200 }) });
    server = http.createServer((_req, res) => setTimeout(() => res.end('{"ok":true}'), 600));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });

  after(async () => {
    http.globalAgent.destroy();
    Object.assign(http, { globalAgent: kept });
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it(
    'when a call asks no time, as a watch’s does, '
    + 'then it waits for the answer.',
    async () => {
      assert.deepEqual((await call({ url, token: 't' }, 'POST', 'notes/watch')).data, { ok: true });
    },
  );

  it(
    'when a call asks for less time than the answer takes, '
    + 'then the review counts as gone.',
    async () => {
      await assert.rejects(call({ url, token: 't' }, 'GET', 'summary', { timeout: 300 }), Gone);
    },
  );
});
