import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { movedApp, movedTarget, movedWorker } from '../src/server/moved';

const TO = 'https://playtrivioqb.onrender.com';

describe('moved server', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer(movedApp(TO));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it('forwards pages and links to the same path on the new address', async () => {
    for (const path of ['/', '/r/ABCD?x=1', '/u/alex_qb', '/api/me']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(TO + path);
    }
    expect((await fetch(base + '/api/login', { method: 'POST', redirect: 'manual' })).status).toBe(308);
  });

  it('stays healthy and serves a worker that clears the old app', async () => {
    expect(await (await fetch(base + '/healthz')).json()).toEqual({ ok: true, movedTo: TO });
    const sw = await fetch(base + '/sw.js');
    expect(sw.headers.get('content-type')).toMatch(/javascript/);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const body = await sw.text();
    expect(body).toBe(movedWorker(TO));
    expect(body).toContain('caches.delete');
    expect(body).toContain('unregister');
    expect((await fetch(base + '/socket.io/?EIO=4&transport=polling')).status).toBe(410);
  });

  it('only accepts an https address', () => {
    expect(movedTarget(`${TO}/`)).toBe(TO);
    expect(movedTarget('http://x.com')).toBeNull();
    expect(movedTarget('https://x.com/path')).toBeNull();
    expect(movedTarget(undefined)).toBeNull();
  });
});
