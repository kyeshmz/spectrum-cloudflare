import { describe, expect, it } from 'vitest';
import { createSpectrum } from '@spectrum-cloudflare/imessage';
import { runtimeGrpcPeer, type RuntimeCall } from './fixtures/runtime-grpc-peer.js';

async function fixture(wireText: string, guids = ['photo']) {
  const actions: RuntimeCall[] = [];
  const app = await createSpectrum({ projectId: 'p', projectSecret: 's',
    clients: [{ baseUrl: 'https://grpc.test', token: 'line', phone: 'shared' }],
    fetch: async (input, init) => runtimeGrpcPeer(new Request(input, init), { wireText, guids, observe: call => actions.push(call) }),
  });
  return { app, space: app.space('any;-;peer'), actions };
}

describe('native multipart bubble identity over protobuf', () => {
  it.each([
    { text: '\uFFFCcaption', expected: ['attachment', 'text'] },
    { text: 'caption', expected: ['attachment', 'text'] },
    { text: 'caption\uFFFC', expected: ['text', 'attachment'] },
  ])('preserves native order for $text', async ({ text, expected }) => {
    const { app, space } = await fixture(text);
    try {
      const parent = await space.getMessage('parent');
      if (parent?.content.type !== 'group') throw new Error('Expected multipart content');
      expect(parent.content.items.map(item => item.content.type)).toEqual(expected);
      expect(parent.content.items.map(item => item.id)).toEqual(['p:0/parent', 'p:1/parent']);
      expect((await space.getMessage('p:0/parent'))?.content.type).toBe(expected[0]);
    } finally { await app.close(); }
  });

  it('keeps interleaved text segments and attachments in separate native positions', async () => {
    const { app, space } = await fixture(' before \uFFFC middle \uFFFC after ', ['one', 'two']);
    try {
      const parent = await space.getMessage('parent');
      if (parent?.content.type !== 'group') throw new Error('Expected multipart content');
      expect(parent.content.items.map(item => item.content.type === 'text' ? item.content.text : item.content.type)).toEqual(['before', 'attachment', 'middle', 'attachment', 'after']);
      expect(parent.content.items.map(item => item.id)).toEqual(Array.from({ length: 5 }, (_, index) => `p:${index}/parent`));
    } finally { await app.close(); }
  });

  it('uses native message attachment metadata without additional lookups that could compact indexes', async () => {
    const { app, space, actions } = await fixture('\uFFFCmiddle\uFFFClast', ['one', 'two']);
    try {
      expect((await space.getMessage('p:0/parent'))?.content.type).toBe('attachment');
      expect((await space.getMessage('p:1/parent'))?.content).toEqual({ type: 'text', text: 'middle' });
      expect((await space.getMessage('p:2/parent'))?.content.type).toBe('attachment');
      expect((await space.getMessage('p:3/parent'))?.content).toEqual({ type: 'text', text: 'last' });
      expect(actions.every(call => call.method === 'GetMessage')).toBe(true);
      expect(await space.getMessage('p:4/parent')).toBeUndefined();
    } finally { await app.close(); }
  });

  it('actions on retrieved parts target the parent GUID and original bubble index', async () => {
    const { app, space, actions } = await fixture('first\uFFFCmiddle\uFFFClast', ['one', 'two']);
    try {
      const part = await space.getMessage('p:2/parent');
      expect(part?.content).toEqual({ type: 'text', text: 'middle' });
      await part?.reply('reply');
      await part?.react('👍');
      await part?.edit('updated');
      await part?.unsend();
      expect(actions.find(call => call.method === 'SendTextMessage')?.input.replyTo).toEqual({ messageGuid: 'parent', targetPartIndex: 2 });
      for (const method of ['SetReaction', 'EditMessage', 'UnsendMessage']) {
        expect(actions.find(call => call.method === method)?.input.target).toEqual({ chatGuid: 'any;-;peer', messageGuid: 'parent', targetPartIndex: 2 });
      }
    } finally { await app.close(); }
  });

  it('preserves native indexes when an attachment metadata slot lacks its GUID', async () => {
    const { app, space } = await fixture('\uFFFCmiddle\uFFFClast', ['', 'present']);
    try {
      expect(await space.getMessage('p:0/parent')).toBeUndefined();
      expect((await space.getMessage('p:1/parent'))?.content).toEqual({ type: 'text', text: 'middle' });
      expect((await space.getMessage('p:2/parent'))?.content.type).toBe('attachment');
      expect((await space.getMessage('p:3/parent'))?.content).toEqual({ type: 'text', text: 'last' });
      const parent = await space.getMessage('parent');
      if (parent?.content.type !== 'group') throw new Error('Expected surviving multipart content');
      expect(parent.content.items.map(child => child.id)).toEqual(['p:1/parent', 'p:2/parent', 'p:3/parent']);
    } finally { await app.close(); }
  });

  it('retains the original child identity if only one valid bubble survives', async () => {
    const { app, space } = await fixture('\uFFFCcaption', ['']);
    try {
      const surviving = await space.getMessage('parent');
      expect(surviving?.id).toBe('p:1/parent');
      expect(surviving?.content).toEqual({ type: 'text', text: 'caption' });
    } finally { await app.close(); }
  });
});
