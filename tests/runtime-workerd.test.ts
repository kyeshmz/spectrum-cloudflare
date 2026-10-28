import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runtimeGrpcPeer, type RuntimeCall } from './fixtures/runtime-grpc-peer.js';

let script: string;
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/runtime-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', minify: true, metafile: true });
  script = result.outputFiles[0]!.text;
  expect(result.metafile!.outputs['runtime-worker.js']?.imports ?? Object.values(result.metafile!.outputs)[0]!.imports).toEqual([]);
  expect(Object.keys(result.metafile!.inputs).some(path => /node:|spectrum-ts|advanced-imessage|grpc-js|socket\.io/.test(path))).toBe(false);
  console.info(`Web-only facade: ${script.length} bytes minified, ${gzipSync(script).length} bytes gzip`);
});

function worker(calls: RuntimeCall[]) {
  return new Miniflare({ modules: true, script, compatibilityDate: '2026-07-30',
    outboundService: (request: Request) => runtimeGrpcPeer(request, { observe: call => calls.push(call) }),
  });
}

function signed(platform = 'iMessage', text: unknown = 'hello') {
  const body = JSON.stringify({ event: 'messages', space: { id: 'any;-;peer', platform }, message: {
    id: 'inbound', platform, direction: 'inbound', timestamp: new Date().toISOString(),
    sender: { id: 'peer', platform }, space: { id: 'any;-;peer', platform }, content: { type: 'text', text },
  } });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const digest = createHmac('sha256', 'webhook-secret').update(`v0:${timestamp}:${body}`).digest('hex');
  return { body, headers: { 'content-type': 'application/json', 'x-spectrum-timestamp': timestamp, 'x-spectrum-signature': `v0=${digest}` } };
}

describe('Web-only facade in real workerd without compatibility flags', () => {
  it('runs decorated messaging, binary attachment upload/download, and multipart through native descriptors', async () => {
    const calls: RuntimeCall[] = [];
    const mf = worker(calls);
    try {
      const response = await mf.dispatchFetch('https://worker.test');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'sent', platform: 'imessage', direction: 'outbound', date: true, decorators: true,
        multipart: 'group', bytes: [1, 2, 3], hasBuffer: false, hasProcess: false });
      expect(calls.every(call => call.authorization === 'Bearer line' && call.routing === null)).toBe(true);
      expect(calls.find(call => call.method === 'UploadAttachment')?.input.data).toBe('AP+A');
      expect(calls.find(call => call.method === 'SendMultipartMessage')?.input.parts).toHaveLength(2);
      expect(calls.find(call => call.method === 'DownloadAttachment')).toBeDefined();
    } finally { await mf.dispose(); }
  });

  it.each(['iMessage', 'imessage'])('verifies raw bytes before normalizing %s and awaits handler RPCs', async platform => {
    const calls: RuntimeCall[] = [];
    const mf = worker(calls);
    try {
      const response = await mf.dispatchFetch('https://worker.test/webhook', { method: 'POST', ...signed(platform) });
      expect(response.status).toBe(200);
      expect(calls.map(call => call.method)).toEqual(['SendTextMessage', 'MarkChatRead']);
      expect(calls[0]?.input.replyTo).toEqual({ messageGuid: 'inbound' });
    } finally { await mf.dispose(); }
  });

  it('does not deliver tampered or unsupported-platform payloads', async () => {
    const calls: RuntimeCall[] = [];
    const mf = worker(calls);
    try {
      const valid = signed();
      const response = await mf.dispatchFetch('https://worker.test/webhook', { method: 'POST', ...valid, body: valid.body.replace('hello', 'tampered') });
      expect(response.status).toBe(401);
      const unsupported = await mf.dispatchFetch('https://worker.test/webhook', { method: 'POST', ...signed('telegram') });
      expect(unsupported.status).toBe(400);
      expect(calls).toEqual([]);
    } finally { await mf.dispose(); }
  });

  it('propagates handler failures instead of acknowledging fire-and-forget success', async () => {
    const calls: RuntimeCall[] = [];
    const mf = worker(calls);
    try {
      const response = await mf.dispatchFetch('https://worker.test/webhook-error', { method: 'POST', ...signed() });
      expect(response.status).toBe(500);
      expect(calls).toEqual([]);
    } finally { await mf.dispose(); }
  });
});
