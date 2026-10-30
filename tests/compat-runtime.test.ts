import { createHmac } from 'node:crypto';
import { create, fromBinary, toBinary, toJson, type DescMessage } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';
import { Spectrum, imessage } from '../packages/imessage/src/runtime-provider.js';
import { text, typing, read, reaction, edit, unsend, reply } from '../packages/imessage/src/runtime-content.js';
import type { ContentInput } from '../packages/imessage/src/runtime-content.js';
import type { SpectrumMessage, SpectrumSpace } from '../packages/imessage/src/runtime-types.js';
import { runtimeGrpcPeer, frame, type RuntimeCall } from './fixtures/runtime-grpc-peer.js';
import { CreateChatResponseSchema } from '../packages/imessage/src/generated/photon/imessage/v1/chat_service_pb.js';
import { MessageService } from '../packages/imessage/src/generated/photon/imessage/v1/message_service_pb.js';

// Adapted scenarios, not a whole-file port. Copyright (c) 2025 Photon AI, MIT.
// https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/space.test.ts
// https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/spectrum.startup.test.ts
// https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/spectrum.test.ts
// Helper ordering is specified by packages/core/src/platform/build.ts:943–959.
// Transport adaptation: real binary gRPC-Web fixture instead of native SDK mocks.
// Deliberate difference: webhook handlers are awaited, and failures propagate.

const entry = (phone = 'shared') => ({ address: 'https://grpc.test', token: 'line', phone });
const calls: RuntimeCall[] = [];
const fetchPeer: typeof fetch = async (input, init) => runtimeGrpcPeer(new Request(input, init), { observe: call => calls.push(call) });
const fixture = () => Spectrum({ providers: [imessage.config({ clients: entry() })], fetch: fetchPeer });

function binaryReply(schema: DescMessage, value: Record<string, unknown>, status = 0): Response {
  return new Response(new ReadableStream({ start(controller) {
    if (status === 0) controller.enqueue(frame(toBinary(schema, create(schema, value))));
    controller.enqueue(frame(new TextEncoder().encode(`grpc-status: ${status}\r\n`), 0x80));
    controller.close();
  } }), { headers: { 'content-type': 'application/grpc-web+proto' } });
}

/** Mutable server state, not a mock of facade methods or local message objects. */
function mutationPeer(multipart = false) {
  const state = { text: 'before', present: true, failMutation: false, reads: 0, reactionPresent: false };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const name = new URL(request.url).pathname.split('/').at(-1)!;
    const method = MessageService.methods.find(candidate => candidate.name === name);
    if (!method) return runtimeGrpcPeer(request);
    const wire = new Uint8Array(await request.arrayBuffer());
    const data = toJson(method.input, fromBinary(method.input, wire.subarray(5))) as Record<string, unknown>;
    const message = () => ({ guid: 'mutable-parent', chatGuids: ['any;-;peer'], isFromMe: true,
      dateCreated: { seconds: 1_785_369_600n, nanos: 0 },
      content: { text: `${state.text}${multipart ? '\uFFFC' : ''}`, attachments: multipart
        ? [{ guid: 'photo', fileName: 'photo.png', mimeType: 'image/png', totalBytes: 3n }] : [] } });
    if ((name === 'EditMessage' || name === 'UnsendMessage' || name === 'SetReaction') && state.failMutation) {
      return binaryReply(method.output, {}, 14);
    }
    if (name === 'GetMessage') {
      state.reads++;
      const present = data.messageGuid === 'reaction-handle' ? state.reactionPresent : state.present;
      return binaryReply(method.output, { message: message() }, present ? 0 : 5);
    }
    if (name === 'SendTextMessage') state.text = data.text as string;
    if (name === 'EditMessage') state.text = data.newText as string;
    if (name === 'UnsendMessage') state.present = false;
    if (name === 'SetReaction') {
      state.reactionPresent = data.isSet === true;
      return binaryReply(method.output, { message: { ...message(), guid: 'reaction-handle' } });
    }
    return binaryReply(method.output, { message: message() });
  };
  return { state, fetch };
}

describe('supported iMessage factory and provider compatibility', () => {
  it('initializes explicit clients without credentials or I/O and caches the provider instance', async () => {
    const fetch = vi.fn(fetchPeer);
    const app = await Spectrum({ providers: [imessage.config({ clients: entry() })], fetch });
    try {
      expect(fetch).not.toHaveBeenCalled();
      expect(app.config).toBeUndefined();
      expect(() => app.api).toThrow('Project credentials');
      expect(imessage(app)).toBe(imessage(app));
      expect(imessage(app).messages).toBe(app.messages);
      expect(await imessage(app).user('a@example.com')).toMatchObject({ id: 'a@example.com', __platform: 'imessage' });
      const space = await imessage(app).space.get('any;-;peer');
      expect(space).toMatchObject({ id: 'any;-;peer', phone: 'shared', __platform: 'imessage', type: 'dm' });
      expect(imessage(space)).toBe(space);
      expect(imessage.is(space)).toBe(true);
      expect(imessage.is(null)).toBe(false);
      expect(imessage.is(1)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await app.stop(); }
    expect(app.stop()).toBe(app.close());
  });

  it('rejects unsupported providers, duplicate registrations and malformed configs before I/O', async () => {
    const fetch = vi.fn(fetchPeer);
    const provider = imessage.config({ clients: entry() });
    await expect(Spectrum({ providers: [provider, provider], fetch })).rejects.toThrow('multiple providers');
    await expect(Spectrum({ providers: [{} as typeof provider], fetch })).rejects.toThrow('Only imessage');
    await expect(Spectrum({ providers: [imessage.config({ clients: [] })], fetch })).rejects.toThrow('at least one');
    await expect(Spectrum({ providers: [imessage.config({ clients: entry(), onHeartbeat: () => {} } as never)], fetch })).rejects.toThrow('Unsupported');
    await expect(Spectrum({ providers: [provider], projectId: 'p', fetch } as never)).rejects.toThrow('together');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches real project metadata from the generated trailing-slash route before line initialization', async () => {
    const requests: Request[] = [];
    const app = await Spectrum({ projectId: 'project', projectSecret: 'secret', providers: [imessage.config({ clients: entry() })],
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ succeed: true, data: { name: 'Project', slug: 'project-slug', profile: { custom: 42 } } });
      } });
    try {
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url).pathname).toBe('/projects/project/');
      expect(requests[0]!.headers.get('authorization')).toBe(`Basic ${btoa('project:secret')}`);
      expect(app.config).toEqual({ id: 'project', name: 'Project', slug: 'project-slug', profile: { custom: 42 } });
    } finally { await app.stop(); }
  });

  it('rejects a pre-aborted start, but a successful app outlives its initialization signal', async () => {
    const fetch = vi.fn(fetchPeer);
    const cancelled = new AbortController();
    const reason = new Error('cancelled');
    cancelled.abort(reason);
    await expect(Spectrum({ providers: [imessage.config({ clients: entry() })], signal: cancelled.signal, fetch })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    const app = await Spectrum({ providers: [imessage.config({ clients: entry() })], signal: controller.signal, fetch });
    try {
      controller.abort();
      expect((await (await imessage(app).space.get('any;-;peer')).send('still open')).id).toBe('sent');
    } finally { await app.stop(); }
  });

  it('constructs shared DMs offline, ignores requested phone in shared mode, and rejects shared groups', async () => {
    const fetch = vi.fn(fetchPeer);
    const app = await Spectrum({ providers: [imessage.config({ clients: entry() })], fetch });
    try {
      const im = imessage(app);
      expect(await im.space.create(await im.user('+15550123'))).toMatchObject({ id: 'any;-;+15550123', type: 'dm', phone: 'shared' });
      expect(await im.space.get('iMessage;+;chat42', { phone: 'ignored' })).toMatchObject({ type: 'group', phone: 'shared' });
      await expect(im.space.create(['a', 'b'])).rejects.toThrow('Shared');
      await expect(im.space.create([])).rejects.toThrow('at least one');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await app.stop(); }
  });

  it('requires multi-phone get routing and creates dedicated groups using the selected line', async () => {
    calls.length = 0;
    const app = await Spectrum({ providers: [imessage.config({ clients: [entry('+15550100'), entry('+15550111')] })], fetch: fetchPeer });
    try {
      const im = imessage(app);
      await expect(im.space.get('any;-;peer')).rejects.toThrow(/params\.phone.*\+15550100, \+15550111/);
      expect(await im.space.get('iMessage;+;chat42', { phone: '+15550111' })).toMatchObject({ phone: '+15550111', type: 'group' });
      const space = await im.space.create(['a', await im.user('b')], { phone: '+15550111' });
      expect(space).toMatchObject({ id: 'any;+;group', phone: '+15550111', type: 'group' });
      expect(calls.map(call => call.method)).toEqual(['CreateChat']);
      expect(calls[0]!.input.addresses).toEqual(['a', 'b']);
    } finally { await app.stop(); }
  });

  it('narrows messages and wrong-platform spaces by identity, without cloning', async () => {
    const app = await fixture();
    try {
      const space = await imessage(app).space.get('any;-;peer');
      const sent = await space.send(text('hello'));
      expect(imessage(sent)).toBe(sent);
      expect(imessage.is(sent)).toBe(true);
      const foreign = { ...space, __platform: 'other' } as unknown as SpectrumSpace;
      expect(imessage(foreign)).toBe(foreign);
      expect(imessage.is(foreign)).toBe(false);
    } finally { await app.stop(); }
  });

  it('randomly selects a dedicated creation line and keeps the server chat type authoritative', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const requests: Request[] = [];
    const app = await Spectrum({ providers: [imessage.config({ clients: [entry('+15550100'), entry('+15550111')] })],
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (!request.url.endsWith('/CreateChat')) return runtimeGrpcPeer(request);
        const message = toBinary(CreateChatResponseSchema, create(CreateChatResponseSchema, {
          chat: { guid: 'any;-;server-assigned', isGroup: true },
        }));
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(frame(message));
          controller.enqueue(frame(new TextEncoder().encode('grpc-status: 0\r\n'), 0x80));
          controller.close();
        } }), { headers: { 'content-type': 'application/grpc-web+proto' } });
      } });
    try {
      const space = await imessage(app).space.create(['a', 'b']);
      expect(space).toMatchObject({ id: 'any;-;server-assigned', type: 'group', phone: '+15550111' });
      expect((await space.send('hello')).space.type).toBe('group');
      expect(requests).toHaveLength(2);
    } finally { random.mockRestore(); await app.stop(); }
  });
});

describe('compatible runtime helpers on the existing owner', () => {
  it.each([false, true])('reads authoritative parent and part state after successful and failed mutations (multipart=%s)', async multipart => {
    const { state, fetch } = mutationPeer(multipart);
    const app = await Spectrum({ providers: [imessage.config({ clients: entry() })], fetch });
    try {
      const space = await imessage(app).space.get('any;-;peer');
      const sent = await space.send('before');
      const parent = await space.getMessage(sent.id);
      const part = await space.getMessage(`p:0/${sent.id}`);
      expect(part?.content).toEqual({ type: 'text', text: 'before' });
      expect(parent?.content.type).toBe(multipart ? 'group' : 'text');
      await part!.edit('after');
      const editedParent = await space.getMessage(sent.id);
      const editedPart = await space.getMessage(`p:0/${sent.id}`);
      expect(editedPart?.content).toEqual({ type: 'text', text: 'after' });
      expect(editedParent?.content.type === 'group' ? editedParent.content.items[0]?.content : editedParent?.content)
        .toEqual({ type: 'text', text: 'after' });
      state.failMutation = true;
      await expect(editedPart!.edit('must not appear')).rejects.toThrow();
      await expect(editedPart!.unsend()).rejects.toThrow();
      expect((await space.getMessage(`p:0/${sent.id}`))?.content).toEqual({ type: 'text', text: 'after' });
      expect(await space.getMessage(sent.id)).toBeDefined();
      state.failMutation = false;
      await editedPart!.unsend();
      expect(await space.getMessage(sent.id)).toBeUndefined();
      expect(await space.getMessage(`p:0/${sent.id}`)).toBeUndefined();
      // No tombstone: a later valid server record is visible through both aliases.
      state.present = true;
      state.text = 'restored';
      expect((await space.getMessage(`p:0/${sent.id}`))?.content).toEqual({ type: 'text', text: 'restored' });
      expect(await space.getMessage(sent.id)).toBeDefined();
      expect(state.reads).toBe(10);
    } finally { await app.stop(); }
  });

  it('rechecks reaction handles and related target views after removal, without caching failed removals', async () => {
    const { state, fetch } = mutationPeer();
    const app = await Spectrum({ providers: [imessage.config({ clients: entry() })], fetch });
    try {
      const space = app.space('any;-;peer');
      const sent = await space.send('before');
      const handle = await sent.react('👍');
      expect(await space.getMessage(handle.id)).toBeDefined();
      expect(await space.getMessage(sent.id)).toBeDefined();
      state.failMutation = true;
      await expect(handle.unsend()).rejects.toThrow();
      expect(await space.getMessage(handle.id)).toBeDefined();
      state.failMutation = false;
      await handle.unsend();
      expect(await space.getMessage(handle.id)).toBeUndefined();
      expect((await space.getMessage(sent.id))?.content).toEqual({ type: 'text', text: 'before' });
      expect(state.reads).toBe(5);
    } finally { await app.stop(); }
  });

  it('resolves offline destination and target owners before every targeted action, blocking cross-phone writes', async () => {
    const writesA: RuntimeCall[] = [];
    const writesB: RuntimeCall[] = [];
    const appA = await Spectrum({ providers: [imessage.config({ clients: entry('+100') })],
      fetch: async (input, init) => runtimeGrpcPeer(new Request(input, init), { observe: call => writesA.push(call) }) });
    const appB = await Spectrum({ providers: [imessage.config({ clients: entry('+200') })],
      fetch: async (input, init) => runtimeGrpcPeer(new Request(input, init), { observe: call => writesB.push(call) }) });
    const actions: ((space: SpectrumSpace, outbound: SpectrumMessage, inbound: SpectrumMessage) => Promise<unknown>)[] = [
      (space, outbound) => space.unsend(outbound),
      (space, outbound) => space.edit(outbound, 'changed'),
      (space, outbound) => space.send(unsend(outbound)),
      (space, outbound) => space.send(edit('changed', outbound)),
      (space, outbound) => space.send(reaction('👍', outbound)),
      (space, outbound) => space.send(reply('response', outbound)),
      (space, _outbound, inbound) => space.read(inbound),
      (space, _outbound, inbound) => space.send(read(inbound)),
    ];
    try {
      const chat = 'any;-;peer';
      const destination = appA.space(chat); // Deliberately lacks a phone.
      const foreign = await (await imessage(appB).space.get(chat)).send('foreign');
      const unresolvedForeign = { ...foreign, space: appB.space(chat) };
      for (const target of [foreign, unresolvedForeign]) {
        const inbound = { ...target, direction: 'inbound' as const };
        for (const action of actions) await expect(action(destination, target, inbound)).rejects.toThrow('another space');
      }
      expect(writesA).toHaveLength(0);
      expect(writesB.map(call => call.method)).toEqual(['SendTextMessage']);
      const local = await destination.send('local');
      writesA.length = 0;
      for (const action of actions) {
        await action(destination, local, { ...local, direction: 'inbound' });
      }
      // Known unresolved local spaces retain the same default-line behavior.
      await destination.edit({ ...local, space: destination }, 'local offline target');
      // A builder reference with no space still works; no phone is invented on it.
      const reference = { id: local.id, direction: 'outbound' as const, content: { type: 'text' } };
      await destination.send(edit('reference', reference));
      expect('space' in reference).toBe(false);
      expect(writesA).toHaveLength(actions.length + 2);
      expect(writesA.some(call => call.method === 'GetMessage')).toBe(false);
      await expect(destination.unsend({ ...local, space: { id: chat } as SpectrumSpace })).rejects.toThrow('unresolved');
      expect(writesA).toHaveLength(actions.length + 2);
    } finally { await appA.stop(); await appB.stop(); }
  });

  it('keeps offline multi-phone destinations ambiguous instead of authorizing from a target phone', async () => {
    const writes: RuntimeCall[] = [];
    const app = await Spectrum({ providers: [imessage.config({ clients: [entry('+100'), entry('+200')] })],
      fetch: async (input, init) => runtimeGrpcPeer(new Request(input, init), { observe: call => writes.push(call) }) });
    try {
      const target = await (await imessage(app).space.get('any;-;peer', { phone: '+200' })).send('target');
      writes.length = 0;
      await expect(app.space('any;-;peer').unsend(target)).rejects.toThrow(/phone/);
      expect(writes).toHaveLength(0);
    } finally { await app.stop(); }
  });

  it('uses one resolver path for async builders, variadic send/reply, actions and app delegates', async () => {
    calls.length = 0;
    const app = await fixture();
    try {
      const space = await imessage(app).space.get('any;-;peer');
      const messages = await space.send({ build: async () => ({ type: 'text', text: 'one' }) }, typing(), 'two');
      expect(messages).toHaveLength(2);
      expect(calls.filter(call => call.method === 'SendTextMessage')).toHaveLength(2);
      expect(calls.some(call => call.method === 'SendMultipartMessage')).toBe(false);
      expect(await messages[0]!.reply('a', text('b'))).toHaveLength(2);
      expect(await app.send(space, 'a', 'b')).toHaveLength(2);
      await space.edit(messages[0], 'updated');
      await app.edit(messages[0]!, 'updated again');
      const reacted = await space.send(reaction('👍', messages[0]));
      expect(reacted?.content).toMatchObject({ type: 'reaction', targetId: 'sent', target: messages[0] });
      await space.send(unsend(reacted));
      await space.send(edit('updated', messages[0]));
      await space.send(reply('response', messages[0]));
      const flags = calls.filter(call => call.method === 'SetReaction').map(call => call.input.isSet ?? false);
      expect(flags).toEqual([true, false]);
      const empty: ContentInput = { build: async () => ({ type: 'text', text: '' }) };
      await expect(space.send(empty)).rejects.toThrow('nonempty');
    } finally { await app.stop(); }
  });

  it('starts typing before responding, preserves callback outcomes, and swallows stop failures', async () => {
    const app = await fixture();
    try {
      const space = app.space('any;-;peer');
      const order: string[] = [];
      space.startTyping = async () => { order.push('start'); };
      space.stopTyping = async () => { order.push('stop'); throw new Error('stop failed'); };
      expect(await app.responding(space, () => { order.push('callback'); return 42; })).toBe(42);
      expect(order).toEqual(['start', 'callback', 'stop']);
      const failure = new Error('callback failed');
      await expect(space.responding(() => { throw failure; })).rejects.toBe(failure);
      space.startTyping = async () => { throw failure; };
      const callback = vi.fn();
      await expect(space.responding(callback)).rejects.toBe(failure);
      expect(callback).not.toHaveBeenCalled();
    } finally { await app.stop(); }
  });

  it('looks up messages from the backend and rejects outbound or cross-space read targets', async () => {
    calls.length = 0;
    const app = await fixture();
    try {
      const space = await imessage(app).space.get('any;-;peer');
      const message = await imessage(app).getMessage(space, 'parent');
      expect((await space.getMessage('parent'))?.id).toBe(message?.id);
      expect(calls.filter(call => call.method === 'GetMessage')).toHaveLength(2);
      const outbound = await space.send('outbound');
      await expect(space.read(outbound)).rejects.toThrow('inbound');
      await expect(space.send(read(outbound))).rejects.toThrow('inbound');
      const inbound = { ...outbound, direction: 'inbound' as const };
      await space.read(inbound);
      await space.send(read(inbound));
      await expect(app.space('any;-;another').read(inbound)).rejects.toThrow('another space');
      expect(calls.filter(call => call.method === 'MarkChatRead')).toHaveLength(2);
    } finally { await app.stop(); }
    await expect(app.rpc()).rejects.toThrow('closed');
  });

  it('routes positional attachment phones and keeps bytes lazy and app-owned', async () => {
    calls.length = 0;
    const app = await fixture();
    try {
      const attachment = await imessage(app).getAttachment('photo', 'ignored-for-shared');
      expect(attachment).toMatchObject({ id: 'photo', name: 'photo.png', mimeType: 'image/png' });
      expect(calls.map(call => call.method)).toEqual(['GetAttachmentInfo']);
      expect(await attachment!.read()).toEqual(new Uint8Array([1, 2, 3]));
      const reader = (await attachment!.stream()).getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
      await reader.cancel();
      expect(calls.filter(call => call.method === 'DownloadAttachment')).toHaveLength(2);
    } finally { await app.stop(); }
  });

  it('accepts upstream raw signed bytes and awaits handlers without changing error propagation', async () => {
    const secret = 'compat-webhook-secret';
    const app = await Spectrum({ providers: [imessage.config({ clients: entry() })], webhookSecret: secret });
    const raw = JSON.stringify({ event: 'messages', space: { id: 'any;-;peer', platform: 'imessage' },
      message: { id: 'inbound', timestamp: '2026-06-12T10:00:00.000Z', content: { type: 'text', text: '' } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { 'X-Spectrum-Timestamp': String(timestamp),
      'X-Spectrum-Signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}` };
    try {
      let delivered: SpectrumMessage | undefined;
      const result = await app.webhook({ body: new TextEncoder().encode(raw), headers }, async (space, message) => {
        await Promise.resolve();
        expect(space.__platform).toBe('imessage');
        delivered = message;
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual(new TextEncoder().encode('ok'));
      expect(delivered?.content).toEqual({ type: 'text', text: '' });
      const failure = new Error('handler failure');
      await expect(app.webhook({ body: new TextEncoder().encode(raw).buffer, headers }, () => { throw failure; })).rejects.toBe(failure);
      const forged = await app.webhook({ body: new TextEncoder().encode(`${raw} `), headers }, () => { throw failure; });
      expect(forged.status).toBe(401);
    } finally { await app.stop(); }
  });
});

// Compile-time regression: ordinary sends retain the previous non-optional result.
function ordinaryReturnTypes(space: SpectrumSpace, message: SpectrumMessage, input: ContentInput) {
  const ordinary: Promise<SpectrumMessage> = space.send('plain');
  const staticBuilt: Promise<SpectrumMessage> = space.send(text('plain'));
  const general: Promise<SpectrumMessage | undefined> = space.send(input);
  const many: Promise<SpectrumMessage[]> = message.reply('one', 'two');
  return { ordinary, staticBuilt, general, many };
}
void ordinaryReturnTypes;
