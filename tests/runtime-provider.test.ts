import { describe, expect, it } from 'vitest';
import { createSpectrum, text, attachment, group, richlink } from '@spectrum-cloudflare/imessage';
import { runtimeGrpcPeer, type RuntimeCall } from './fixtures/runtime-grpc-peer.js';

describe('Web-only Spectrum-adjacent facade', () => {
  it('sends binary text, links, uploads, and multipart with decorated native message actions', async () => {
    const calls: RuntimeCall[] = [];
    const app = await createSpectrum({ projectId: 'project', projectSecret: 'secret',
      clients: [{ baseUrl: 'https://grpc.test', token: 'line', phone: 'shared' }],
      fetch: async (input, init) => runtimeGrpcPeer(new Request(input, init), { observe: call => calls.push(call) }),
    });
    try {
      expect(app.api.userRedirectUrl('peer')).toContain('/users/peer/redirect');
      const space = await app.createSpace('peer');
      const sent = await space.send(text('hello'));
      expect(sent).toMatchObject({ id: 'sent', platform: 'imessage', direction: 'outbound', content: { type: 'text', text: 'hello' } });
      expect(sent.timestamp).toBeInstanceOf(Date);
      await sent.reply('reply');
      const reaction = await sent.react('👍');
      await reaction.unsend();
      await sent.edit('updated');
      await sent.unsend();
      await space.startTyping();
      await space.stopTyping();
      await space.send(richlink('https://example.com'));
      const sentAttachment = await space.send(attachment(new Uint8Array([0, 255, 128]), { name: 'photo.png' }));
      expect(sentAttachment.content).toMatchObject({ type: 'attachment', id: 'uploaded' });
      const multipart = await space.send(group(text('caption'), attachment(new Blob([new Uint8Array([1])]), { name: 'second.png' })));
      expect(multipart.content.type).toBe('group');
      if (multipart.content.type !== 'group') throw new Error('Expected group');
      expect(multipart.content.items.map(child => child.id)).toEqual(['p:0/sent', 'p:1/sent']);
      expect(calls.every(call => call.authorization === 'Bearer line' && call.routing === null)).toBe(true);
      expect(calls.filter(call => call.method === 'SetReaction').map(call => call.input.isSet ?? false)).toEqual([true, false]);
      expect(calls.find(call => call.method === 'UploadAttachment')?.input.data).toBe('AP+A');
      expect(calls.find(call => call.method === 'SendAttachmentMessage')?.input.attachment).toMatchObject({ attachmentGuid: 'uploaded' });
      expect(calls.find(call => call.method === 'SendMultipartMessage')?.input.parts).toHaveLength(2);
      await expect(app.createSpace(['one', 'two'])).rejects.toThrow('Shared');
    } finally { await app.close(); }
    await expect(app.rpc()).rejects.toThrow('closed');
  });

  it('exposes native typed clients and dedicated chat creation without middleware routing headers', async () => {
    const calls: RuntimeCall[] = [];
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's',
      clients: [{ baseUrl: 'https://instance.imsg.photon.codes', token: 't', phone: '+15550001111' }],
      fetch: async (input, init) => runtimeGrpcPeer(new Request(input, init), { observe: call => calls.push(call) }),
    });
    try {
      const space = await app.createSpace(['one', 'two']);
      expect(space.id).toBe('any;+;group');
      expect(space.phone).toBe('+15550001111');
      await (await app.rpc()).chats.markChatRead({ chatGuid: space.id });
      expect(calls.map(call => call.method)).toEqual(['CreateChat', 'MarkChatRead']);
      expect(calls.every(call => call.routing === null)).toBe(true);
    } finally { await app.close(); }
  });

  it('rejects filesystem strings and invalid content construction without a Node shim', () => {
    expect(() => attachment('https://example.com/file.png')).toThrow('new URL');
    expect(() => group(text('one'))).toThrow('two');
    expect(() => richlink('file:///private/path')).toThrow('HTTP');
  });
});
