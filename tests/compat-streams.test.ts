import { afterEach, describe, expect, it, vi } from 'vitest';
import { Code } from '@connectrpc/connect';
import { SpectrumApi } from '@spectrum-cloudflare/api';
import { createHmac } from 'node:crypto';
import { Spectrum, imessage } from '../packages/imessage/src/index.js';
import { SpectrumLines } from '../packages/imessage/src/runtime-lines.js';
import { createNativeMessageStream } from '../packages/imessage/src/runtime-streams.js';
import type { SpectrumMessage } from '../packages/imessage/src/runtime-types.js';
import { compatStreamPeer, received, sequence } from './fixtures/compat-stream-peer.js';
import { runtimeGrpcPeer, type RuntimeCall } from './fixtures/runtime-grpc-peer.js';

// Independently authored binary-Web scenarios informed by MIT-licensed
// photon-hq/spectrum-ts d9e3908 packages/imessage/test/remote/stream.test.ts
// (parked iterator teardown) and core/test/core/spectrum.shutdown.test.ts.
// These are not wholesale upstream tests or claims of full provider parity.
const pools: SpectrumLines[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  vi.useRealTimers();
});

async function fixture(phones = ['+1'], timeoutMs = 30_000) {
  const peer = compatStreamPeer();
  const lines = await SpectrumLines.create({
    clients: phones.map((phone, index) => ({ phone, baseUrl: `https://line${index}.test`, token: 'native-token' })),
    fetch: peer.fetch, timeoutMs,
  });
  pools.push(lines);
  const materialize = vi.fn((native, phone, chatGuid, timestamp) => ({
    id: native.guid, direction: 'inbound', platform: 'imessage',
    space: { id: chatGuid, phone, platform: 'imessage', type: 'dm' },
    timestamp, content: { type: 'text', text: native.content?.text },
  } as SpectrumMessage));
  const messages = createNativeMessageStream({ lines, materialize });
  return { peer, lines, materialize, messages };
}

async function connected(peer: ReturnType<typeof compatStreamPeer>, count = 1) {
  await vi.waitFor(() => expect(peer.connections).toHaveLength(count));
}

describe('bounded app-owned native subscriptions', () => {
  it('starts lazily and broadcasts through one actual authenticated binary RPC', async () => {
    const test = await fixture();
    const first = test.messages[Symbol.asyncIterator]();
    const second = test.messages[Symbol.asyncIterator]();
    expect(test.peer.calls).toEqual([]);
    const a = first.next();
    const b = second.next();
    await connected(test.peer);
    test.peer.connections[0]!.push(received());
    expect((await a).value?.[1].id).toBe('message');
    expect((await b).value?.[1].id).toBe('message');
    expect(test.peer.calls[0]!.body).toEqual(new Uint8Array([0, 0, 0, 0, 0]));
    expect(test.peer.calls[0]!.request.headers.get('authorization')).toBe('Bearer native-token');
    expect(test.peer.calls[0]!.request.headers.get('grpc-timeout')).toBeNull();
    await first.return?.();
    expect(test.peer.connections[0]!.canceled).toBe(false);
    const pending = second.next();
    await second.return?.();
    expect(await pending).toMatchObject({ done: true });
    expect(test.peer.connections[0]!.canceled).toBe(true);
  });

  it('merges concurrent quiet lines without sharing their bigint dedup cursor', async () => {
    const test = await fixture(['+1', '+2']);
    const iterator = test.messages[Symbol.asyncIterator]();
    const first = iterator.next();
    await connected(test.peer, 2);
    test.peer.connections[1]!.push(received('second-line'));
    expect((await first).value?.[0].phone).toBe('+2');
    test.peer.connections[0]!.push(received('first-line'));
    expect((await iterator.next()).value?.[1].id).toBe('first-line');
    test.peer.connections[1]!.push(received('duplicate', sequence));
    test.peer.connections[1]!.push(received('next', sequence + 1n));
    expect((await iterator.next()).value?.[1].id).toBe('next');
    await iterator.return?.();
  });

  it('filters heartbeat, self snapshots and non-received changes, using embedded content and event time', async () => {
    const test = await fixture();
    const iterator = test.messages[Symbol.asyncIterator]();
    const pending = iterator.next();
    await connected(test.peer);
    const source = test.peer.connections[0]!;
    source.push({ payload: { case: 'heartbeat', value: {} } });
    source.push(received('self', sequence, true));
    for (const [index, change] of ['messageEdited', 'messageUnsent', 'messageRead', 'reactionAdded', 'reactionRemoved', 'stickerPlaced'].entries()) {
      source.push({ sequence: sequence + BigInt(index + 1), payload: { case: 'messageChanged', value: {
        change: { case: change, value: { messageGuid: 'old' } } as never,
      } } });
    }
    const incoming = received('inbound', sequence + 10n);
    if (incoming.payload?.case === 'messageChanged') incoming.payload.value.isFromMe = true;
    source.push(incoming);
    expect((await pending).value?.[1].id).toBe('inbound');
    expect(test.materialize).toHaveBeenCalledTimes(1);
    expect(test.materialize.mock.calls[0]?.slice(1)).toEqual(['+1', 'any;-;peer', new Date(200_000)]);
    expect(test.peer.calls).toHaveLength(1); // no GetMessage hydration round trip
    await iterator.return?.();
  });

  it('bounds read ahead when a subscriber stalls and resumes when it detaches', async () => {
    const test = await fixture();
    const fast = test.messages[Symbol.asyncIterator]();
    const slow = test.messages[Symbol.asyncIterator]();
    const a = fast.next();
    const b = slow.next();
    await connected(test.peer);
    const source = test.peer.connections[0]!;
    source.push(received('one'));
    await Promise.all([a, b]);
    source.push(received('two', sequence + 1n));
    source.push(received('three', sequence + 2n));
    expect((await fast.next()).value?.[1].id).toBe('two');
    await vi.waitFor(() => expect(test.materialize).toHaveBeenCalledTimes(2));
    const third = fast.next();
    await slow.return?.();
    expect((await third).value?.[1].id).toBe('three');
    await fast.return?.();
  });

  it('returns a parked read and can restart with a fresh native subscription', async () => {
    const test = await fixture();
    const iterator = test.messages[Symbol.asyncIterator]();
    const pending = iterator.next();
    await connected(test.peer);
    await iterator.return?.();
    expect(await pending).toMatchObject({ done: true });
    const restarted = test.messages[Symbol.asyncIterator]();
    const next = restarted.next();
    await connected(test.peer, 2);
    test.peer.connections[1]!.push(received('fresh'));
    expect((await next).value?.[1].id).toBe('fresh');
    await restarted.return?.();
  });

  it('stop settles every pending consumer and waits for native reader cleanup', async () => {
    const test = await fixture(['+1', '+2']);
    const a = test.messages[Symbol.asyncIterator]().next();
    const b = test.messages[Symbol.asyncIterator]().next();
    await connected(test.peer, 2);
    await test.lines.close();
    expect(await a).toMatchObject({ done: true });
    expect(await b).toMatchObject({ done: true });
    expect(test.peer.connections.every(connection => connection.canceled)).toBe(true);
    expect(await test.messages[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
  });

  it('propagates failed trailers unchanged and aborts siblings', async () => {
    const test = await fixture(['+1', '+2']);
    const iterator = test.messages[Symbol.asyncIterator]();
    const subscriber = test.messages[Symbol.asyncIterator]();
    const first = iterator.next();
    const broadcast = subscriber.next();
    await connected(test.peer, 2);
    test.peer.connections[0]!.push(received());
    await Promise.all([first, broadcast]);
    const failed = iterator.next().catch(error => error);
    const sameFailure = subscriber.next().catch(error => error);
    test.peer.connections[0]!.end(7);
    const error = await failed;
    expect(error).toMatchObject({ code: Code.PermissionDenied, rawMessage: 'fixture denied' });
    expect(error.metadata.get('error-code')).toBe('FIXTURE_DENIED');
    expect(await sameFailure).toBe(error);
    await vi.waitFor(() => expect(test.peer.connections[1]!.canceled).toBe(true));
    await iterator.return?.();
    await subscriber.return?.();
  });

  it('does not treat unrelated RPC cancellation as graceful completion', async () => {
    const test = await fixture();
    const iterator = test.messages[Symbol.asyncIterator]();
    const pending = iterator.next();
    const checked = expect(pending).rejects.toMatchObject({ code: Code.Canceled });
    await connected(test.peer);
    (await test.lines.select()).rpc.close();
    await checked;
  });

  it('ends only after all native sources return successful trailers', async () => {
    const test = await fixture(['+1', '+2']);
    const iterator = test.messages[Symbol.asyncIterator]();
    const pending = iterator.next();
    await connected(test.peer, 2);
    test.peer.connections[0]!.end();
    test.peer.connections[1]!.push(received('still-open'));
    expect((await pending).value?.[1].id).toBe('still-open');
    test.peer.connections[1]!.end();
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('disables the default unary deadline for idle subscriptions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const test = await fixture(['+1'], 10);
    const iterator = test.messages[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(test.peer.connections).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(100);
    test.peer.connections[0]!.push(received('late'));
    expect((await pending).value?.[1].id).toBe('late');
    await iterator.return?.();
  });

  it.each(['stop', 'return'] as const)('%s cancels pending non-cooperating native authentication without leaking a fetch', async (operation) => {
    let started!: () => void;
    const auth = new Promise<void>(resolve => { started = resolve; });
    const peer = compatStreamPeer();
    const lines = await SpectrumLines.create({ clients: [{ phone: '+1', baseUrl: 'https://auth.test',
      token: () => { started(); return new Promise<string>(() => {}); },
    }], fetch: peer.fetch });
    pools.push(lines);
    const messages = createNativeMessageStream({ lines, materialize: () => undefined });
    const iterator = messages[Symbol.asyncIterator]();
    const pending = iterator.next();
    await auth;
    if (operation === 'stop') await lines.close();
    else await iterator.return?.();
    expect(await pending).toMatchObject({ done: true });
    expect(peer.calls).toEqual([]);
  });

  it('requires a real API when explicit clients are absent', async () => {
    await expect(SpectrumLines.create({})).rejects.toThrow('explicit iMessage clients or Spectrum API credentials');
  });

  it('return interrupts lazy inventory initialization without canceling the shared mint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let requests = 0;
    let started!: () => void;
    let release!: (response: Response) => void;
    const mintStarted = new Promise<void>(resolve => { started = resolve; });
    const peer = compatStreamPeer();
    const response = () => Response.json({ succeed: true, data: { type: 'shared', token: 'native', expiresIn: 1 } });
    const api = new SpectrumApi({ projectId: 'p', projectSecret: 's', fetch: async () => {
      if (++requests === 1) return response();
      started();
      return new Promise<Response>(resolve => { release = resolve; });
    } });
    const lines = await SpectrumLines.create({ api, fetch: peer.fetch });
    pools.push(lines);
    vi.setSystemTime(801);
    const stream = createNativeMessageStream({ lines, materialize: () => undefined });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await mintStarted;
    await iterator.return?.();
    expect(await pending).toMatchObject({ done: true });
    expect(peer.calls).toEqual([]);
    release(response());
    await lines.snapshot();
    expect(peer.calls).toEqual([]);
  });

  it('reconciles cloud inventory additions and removals through the line owner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const peer = compatStreamPeer();
    let generation = 0;
    const api = new SpectrumApi({ projectId: 'p', projectSecret: 's', fetch: async () => {
      generation++;
      return Response.json({ succeed: true, data: { type: 'dedicated', expiresIn: 1,
        auth: generation === 1 ? { one: 'a' } : { two: 'b' },
        numbers: generation === 1 ? { one: '+1' } : { two: '+2' },
      } });
    } });
    const lines = await SpectrumLines.create({ api, fetch: peer.fetch });
    pools.push(lines);
    const materialize = (native: { guid: string }, phone: string) => ({ id: native.guid, space: { phone } } as SpectrumMessage);
    const stream = createNativeMessageStream({ lines, materialize });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await connected(peer);
    vi.setSystemTime(801);
    await lines.snapshot();
    await connected(peer, 2);
    expect(peer.connections[0]!.canceled).toBe(true);
    peer.connections[1]!.push(received('replacement'));
    expect((await pending).value?.[0].phone).toBe('+2');
    await iterator.return?.();
  });
});

describe('public application integration', () => {
  it('shares app/provider subscriptions and materializes multipart children with native action targets', async () => {
    const peer = compatStreamPeer();
    const calls: RuntimeCall[] = [];
    const app = await Spectrum({ providers: [imessage.config({ clients: { address: 'public.test', token: 'line', phone: '+1' } })],
      fetch: async (input, init) => {
        if (String(input).endsWith('/SubscribeMessageEvents')) return peer.fetch(input, init);
        return runtimeGrpcPeer(new Request(input, init), { observe: call => calls.push(call) });
      },
    });
    try {
      const appIterator = app.messages[Symbol.asyncIterator]();
      const providerIterator = imessage(app).messages[Symbol.asyncIterator]();
      const a = appIterator.next();
      const b = providerIterator.next();
      await connected(peer);
      const multipart = received('parent');
      if (multipart.payload?.case !== 'messageChanged' || multipart.payload.value.change?.case !== 'messageReceived') throw new Error('Fixture shape');
      const native = multipart.payload.value.change.value.message!;
      native.content = { text: '\uFFFCcaption', attachments: [{ guid: 'photo', fileName: 'photo.png', mimeType: 'image/png', totalBytes: 3n }] };
      peer.connections[0]!.push(multipart);
      const value = (await a).value!;
      expect((await b).value?.[1]).toBe(value[1]);
      expect(value[1].timestamp).toEqual(new Date(200_000));
      expect(value[1]).toMatchObject({ id: 'parent', direction: 'inbound', content: { type: 'group' } });
      if (value[1].content.type !== 'group') throw new Error('Expected group');
      expect(value[1].content.items.map((child: SpectrumMessage) => child.id)).toEqual(['p:0/parent', 'p:1/parent']);
      expect(value[1].content.items[0]!.content).toMatchObject({ type: 'attachment', id: 'photo' });
      expect(calls).toEqual([]); // Embedded snapshot, lazy attachment: no hydration/download RPC.
      const child = value[1].content.items[1]!;
      await child.reply('reply');
      await child.react('👍');
      expect(calls.find(call => call.method === 'SendTextMessage')?.input.replyTo).toMatchObject({ messageGuid: 'parent', targetPartIndex: 1 });
      expect(calls.find(call => call.method === 'SetReaction')?.input.target).toMatchObject({ messageGuid: 'parent', targetPartIndex: 1 });
      const pending = appIterator.next();
      await app.stop();
      expect(await pending).toMatchObject({ done: true });
      expect(peer.connections[0]!.canceled).toBe(true);
    } finally { await app.stop(); }
  });

  it('awaits authenticated webhook callbacks without feeding native iteration', async () => {
    const peer = compatStreamPeer();
    const secret = 'fixture-secret';
    const app = await Spectrum({ providers: [imessage.config({ clients: { address: 'webhook.test', token: 'line', phone: '+1' } })],
      webhook: { scheme: 'legacy', secret }, fetch: peer.fetch,
    });
    try {
      const iterator = app.messages[Symbol.asyncIterator]();
      const pending = iterator.next();
      await connected(peer);
      const body = JSON.stringify({ event: 'messages', space: { id: 'any;-;peer', platform: 'imessage', phone: '+1' },
        message: { id: 'webhook', platform: 'imessage', timestamp: new Date().toISOString(), content: { type: 'text', text: 'webhook' } },
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
      let release!: () => void;
      let started!: () => void;
      const callbackStarted = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let finished = false;
      const response = app.webhook(new Request('https://app.test/webhook', { method: 'POST', body, headers: {
        'x-spectrum-timestamp': timestamp, 'x-spectrum-signature': `v0=${signature}`,
      } }), async (_space, message) => {
        expect(message.id).toBe('webhook');
        started();
        await gate;
      }).then(value => { finished = true; return value; });
      await callbackStarted;
      expect(finished).toBe(false);
      release();
      expect((await response).status).toBe(200);
      peer.connections[0]!.push(received('native-only'));
      expect((await pending).value?.[1].id).toBe('native-only');
      await iterator.return?.();
    } finally { await app.stop(); }
  });
});
