/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * Revision d9e39089dc3d1c6f4536826f5ca50798856eecab, packages/imessage/test/remote/{reactions,unsend}.test.ts
 * Exact source links and changes: docs/UPSTREAM-COMPATIBILITY.md.
 */
import { describe, expect, it } from 'vitest';
import { attachment, group, text } from '@spectrum-cloudflare/imessage';
import { upstreamApp } from './upstream-peer.js';

const parent = { GetMessage: { message: { guid: 'parent-guid', chatGuids: ['s1'], isFromMe: true,
  dateCreated: { seconds: 0n }, content: { text: 'before\uFFFCafter', attachments: [{ guid: 'att-0', fileName: 'photo.png', mimeType: 'image/png' }] } } } };

describe('iMessage remote reactToMessage (upstream)', () => {
  it('maps a native tapback emoji and returns the tapback record', async () => {
    const { app, calls } = await upstreamApp(['shared'], { SetReaction: { message: { guid: 'tapback-1', dateCreated: { seconds: 1700000000n } } } });
    try {
      const record = await (await app.space('s1').send('hi')).react('👍');
      expect(calls.filter(call => call.method === 'SetReaction')).toHaveLength(1);
      expect(calls.at(-1)?.input).toMatchObject({ reaction: { kind: 'MESSAGE_REACTION_KIND_LIKE' }, isSet: true });
      expect(record.id).toBe('tapback-1');
      expect(record.timestamp).toEqual(new Date(1700000000000));
      expect(record.content).toMatchObject({ type: 'reaction', emoji: '👍' });
    } finally { await app.close(); }
  });
  it('falls back to an emoji reaction for non-tapback emoji', async () => {
    const { app, calls } = await upstreamApp();
    try {
      await (await app.space('s1').send('hi')).react('🦊');
      expect(calls.at(-1)?.input.reaction).toEqual({ kind: 'MESSAGE_REACTION_KIND_EMOJI', emoji: '🦊' });
    } finally { await app.close(); }
  });
  it('targets the parent guid and forwards partIndex for group parts', async () => {
    const { app, calls } = await upstreamApp(['shared'], parent);
    try {
      await (await app.space('s1').getMessage('p:2/parent-guid'))!.react('👍');
      expect(calls.at(-1)?.input.target).toEqual({ chatGuid: 's1', messageGuid: 'parent-guid', targetPartIndex: 2 });
    } finally { await app.close(); }
  });
});

describe('iMessage remote unsendMessage (upstream)', () => {
  it('retracts by chat and message guid', async () => {
    const { app, calls } = await upstreamApp(['shared'], { SendTextMessage: { message: { guid: 'msg-guid', dateCreated: { seconds: 0n } } } });
    try {
      await (await app.space('s1').send('hi')).unsend();
      expect(calls.filter(call => call.method === 'UnsendMessage')).toHaveLength(1);
      expect(calls.at(-1)?.input.target).toEqual({ chatGuid: 's1', messageGuid: 'msg-guid' });
    } finally { await app.close(); }
  });
  it('unwraps child ids and forwards partIndex', async () => {
    const { app, calls } = await upstreamApp(['shared'], { SendMultipartMessage: { message: { guid: 'parent-guid', dateCreated: { seconds: 0n } } } });
    try {
      const sent = await app.space('s1').send(group(attachment(new Uint8Array([1])), attachment(new Uint8Array([2])), text('hi')));
      if (sent.content.type !== 'group') throw new Error('expected group');
      await sent.content.items[2]!.unsend();
      expect(calls.at(-1)?.input.target).toEqual({ chatGuid: 's1', messageGuid: 'parent-guid', targetPartIndex: 2 });
    } finally { await app.close(); }
  });
});

describe('iMessage remote unsendReaction (upstream)', () => {
  it.each([
    ['removes a native tapback with isSet=false', '👍', { kind: 'MESSAGE_REACTION_KIND_LIKE' }],
    ['falls back to an emoji reaction for non-tapback emoji', '🦊', { kind: 'MESSAGE_REACTION_KIND_EMOJI', emoji: '🦊' }],
  ] as const)('%s', async (_title, emoji, reaction) => {
    const { app, calls } = await upstreamApp();
    try {
      const target = await app.space('s1').send('hi');
      await (await target.react(emoji)).unsend();
      expect(calls.filter(call => call.method === 'SetReaction').map(call => call.input.isSet ?? false)).toEqual([true, false]);
      expect(calls.at(-1)?.input).toMatchObject({ target: { chatGuid: 's1', messageGuid: target.id }, reaction });
    } finally { await app.close(); }
  });
  it('targets the parent guid and forwards partIndex for group parts', async () => {
    const { app, calls } = await upstreamApp(['shared'], parent);
    try {
      await (await (await app.space('s1').getMessage('p:2/parent-guid'))!.react('👍')).unsend();
      expect(calls.at(-1)?.input.target).toEqual({ chatGuid: 's1', messageGuid: 'parent-guid', targetPartIndex: 2 });
    } finally { await app.close(); }
  });
});
