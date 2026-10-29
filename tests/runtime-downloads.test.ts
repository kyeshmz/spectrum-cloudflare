import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpectrum } from '@spectrum-cloudflare/imessage';
import { runtimeGrpcPeer } from './fixtures/runtime-grpc-peer.js';

const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  servers.clear();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Actual local binary gRPC-Web TCP peer; a download may leave its body open forever. */
async function fixture(complete = false, downloadStatus = 0) {
  const started = deferred();
  const disconnected = deferred();
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort(new Error('HTTP socket closed')));
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(new Uint8Array(chunk));
      const body = Buffer.concat(chunks);
      const peer = await runtimeGrpcPeer(new Request(`http://127.0.0.1${request.url}`, {
        method: request.method ?? 'POST', headers: { 'content-type': 'application/grpc-web+proto' }, body,
        signal: abort.signal,
      }), { blockedDownload: !complete, downloadStatus, started: started.resolve, cancelled: disconnected.resolve });
      response.writeHead(peer.status, Object.fromEntries(peer.headers));
      response.flushHeaders();
      const reader = peer.body!.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        response.write(next.value);
      }
      response.end();
    } catch {
      response.destroy();
    }
  });
  servers.add(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
  const app = await createSpectrum({ projectId: 'p', projectSecret: 's',
    clients: [{ baseUrl: `http://127.0.0.1:${address.port}`, token: 'line', phone: 'shared' }],
  });
  const attachment = await app.getAttachment('photo');
  if (!attachment) throw new Error('Expected attachment metadata');
  return { app, attachment, started: started.promise, disconnected: disconnected.promise };
}

describe('native app-owned attachment download lifetime', () => {
  it('cancels a blocked reader promptly by aborting transport before iterator.return', async () => {
    const { app, attachment, started, disconnected } = await fixture();
    try {
      const reader = (await attachment.stream()).getReader();
      const pending = reader.read();
      await started;
      await reader.cancel();
      expect(await pending).toEqual({ done: true, value: undefined });
      await disconnected;
      await reader.cancel();
    } finally { await app.close(); }
  }, 5_000);

  it('close aborts blocked streams and rejects subsequent lazy access', async () => {
    const { app, attachment, started, disconnected } = await fixture();
    const reader = (await attachment.stream()).getReader();
    const pending = reader.read().then(() => 'unexpected bytes', error => String(error));
    await started;
    await app.close();
    expect(await pending).toMatch(/closed|stopped|cancel/i);
    await disconnected;
    await expect(attachment.stream()).rejects.toThrow('closed');
    await expect(attachment.read()).rejects.toThrow('stopped');
    await app.close();
  }, 5_000);

  it('close aborts and drains whole-file reads without successful partial bytes', async () => {
    const { app, attachment, started, disconnected } = await fixture();
    let settled = false;
    const pending = attachment.read().then(
      () => { settled = true; return 'unexpected success'; },
      error => { settled = true; return String(error); },
    );
    await started;
    expect(settled).toBe(false);
    await app.close();
    expect(settled).toBe(true);
    expect(await pending).toMatch(/closed|stopped|cancel/i);
    await disconnected;
  }, 5_000);

  it('reads Uint8Array bytes and rejects fresh reads after shutdown', async () => {
    const { app, attachment } = await fixture(true);
    expect(await attachment.read()).toEqual(new Uint8Array([1, 2, 3]));
    await app.close();
    await expect(attachment.read()).rejects.toThrow('stopped');
  }, 5_000);

  it('rejects nonzero final gRPC trailers instead of returning truncated file bytes', async () => {
    const { app, attachment } = await fixture(true, 7);
    try { await expect(attachment.read()).rejects.toMatchObject({ code: 7 }); }
    finally { await app.close(); }
  }, 5_000);

  it('aborts downloads before draining sends that forward app-owned attachments', async () => {
    const { app, attachment, started, disconnected } = await fixture();
    const sending = app.space('any;-;peer').send(attachment).then(() => 'unexpected success', error => String(error));
    await started;
    await app.close();
    expect(await sending).toMatch(/closed|stopped|cancel/i);
    await disconnected;
  }, 5_000);

  it('owns lazy bytes exposed by native message lookup too', async () => {
    const { app, started, disconnected } = await fixture();
    const message = await app.space('any;-;peer').getMessage('p:0/parent');
    if (message?.content.type !== 'attachment') throw new Error('Expected attachment content');
    const reading = message.content.read().then(() => 'unexpected success', error => String(error));
    await started;
    await app.close();
    expect(await reading).toMatch(/closed|stopped|cancel/i);
    await disconnected;
  }, 5_000);
});
