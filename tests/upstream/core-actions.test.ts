/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * d9e39089dc3d1c6f4536826f5ca50798856eecab:
 * packages/core/test/core/{send-read,send-unsend,spectrum.shutdown,spectrum.startup}.test.ts
 * Original scenario titles retained; registry/dispatch mocks -> facade/binary peer.
 * See docs/UPSTREAM-COMPATIBILITY.md for exact links and assertions intentionally not ported.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSpectrum } from '@spectrum-cloudflare/imessage';
import { upstreamApp } from './upstream-peer.js';

const inbound = { GetMessage: { message: { guid: 'm1', chatGuids: ['s1'], isFromMe: false,
  dateCreated: { seconds: 0n }, content: { text: 'hi' } } } };
describe('core message actions (upstream)', () => {
  it('message.read() dispatches read content targeting the message', async () => {
    const { app, calls } = await upstreamApp(['shared'], inbound);
    try {
      const message = await app.space('s1').getMessage('m1');
      await expect(message!.read()).resolves.toBeUndefined();
      // Native protocol marks the containing chat, not an individual message.
      expect(calls.at(-1)?.method).toBe('MarkChatRead');
      expect(calls.at(-1)?.input).toEqual({ chatGuid: 's1' });
    } finally { await app.close(); }
  });
  it('rejects marking an outbound message as read', async () => {
    const { app, calls } = await upstreamApp();
    try {
      await expect((await app.space('s1').send('hi')).read()).rejects.toThrow(/inbound/);
      expect(calls.some(call => call.method === 'MarkChatRead')).toBe(false);
    } finally { await app.close(); }
  });
  it('message.unsend() dispatches unsend content targeting the message', async () => {
    const { app, calls } = await upstreamApp();
    try {
      const sent = await app.space('s1').send('hi');
      await expect(sent.unsend()).resolves.toBeUndefined();
      expect(calls.at(-1)?.input).toEqual({ target: { chatGuid: 's1', messageGuid: sent.id } });
    } finally { await app.close(); }
  });
  it('unsends a reaction via the handle returned by react()', async () => {
    const { app, calls } = await upstreamApp();
    try {
      const sent = await app.space('s1').send('hi');
      const reaction = await sent.react('👍');
      await expect(reaction.unsend()).resolves.toBeUndefined();
      expect(calls.at(-1)?.method).toBe('SetReaction');
      expect(calls.at(-1)?.input.isSet ?? false).toBe(false);
    } finally { await app.close(); }
  });
  it('rejects unsending an inbound message', async () => {
    const { app, calls } = await upstreamApp(['shared'], inbound);
    try {
      await expect((await app.space('s1').getMessage('m1'))!.unsend()).rejects.toThrow(/outbound/);
      expect(calls.some(call => call.method === 'UnsendMessage')).toBe(false);
    } finally { await app.close(); }
  });
});

describe('core lifecycle (upstream)', () => {
  it('no subscription: resolves promptly', async () => {
    const { app } = await upstreamApp();
    await app.close();
    await expect(app.rpc()).rejects.toThrow(/closed/);
  });
  it('registers no SIGINT/SIGTERM listeners', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const { app } = await upstreamApp();
    try { expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before); }
    finally { await app.close(); }
  });
  it('rejects a pre-aborted start before project lookup or provider creation', async () => {
    const fetch = vi.fn();
    await expect(createSpectrum({ projectId: 'project', projectSecret: 'secret', fetch,
      signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not stop a successful instance when its startup signal expires', async () => {
    const controller = new AbortController();
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', signal: controller.signal,
      clients: [{ phone: 'shared', token: 'token', baseUrl: 'https://line.test' }] });
    try { controller.abort(); await expect(app.rpc()).resolves.toHaveProperty('messages'); }
    finally { await app.close(); }
  });
});
