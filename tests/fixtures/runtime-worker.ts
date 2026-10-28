import { createSpectrum, text, richlink, attachment, group } from '../../src/index.js';

export default {
  async fetch(request: Request): Promise<Response> {
    const app = await createSpectrum({ projectId: 'project', projectSecret: 'secret',
      clients: [{ baseUrl: 'https://grpc.test', token: 'line', phone: 'shared' }],
      webhook: { scheme: 'legacy', secret: 'webhook-secret' },
    });
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/webhook')) {
        return await app.webhook(request, async (space, message) => {
          if (path === '/webhook-error') throw new Error('handler failed');
          if (message.platform !== 'imessage' || space.platform !== 'imessage') throw new Error('Alias not normalized');
          await message.reply('Webhook reply');
          await message.read();
        });
      }
      const space = await app.createSpace('peer');
      const sent = await space.send(text('Hello from workerd'));
      await sent.reply('reply');
      const reaction = await sent.react('👍');
      await reaction.unsend();
      await sent.edit('updated');
      await sent.unsend();
      await space.startTyping();
      await space.stopTyping();
      await space.send(richlink('https://example.com'));
      await space.send(attachment(new Uint8Array([0, 255, 128]), { name: 'binary.png' }));
      const multipart = await space.send(group(text('caption'), attachment(new Blob([new Uint8Array([1])]), { name: 'second.png' })));
      const received = await space.getMessage('parent');
      if (received?.content.type !== 'group') throw new Error('Expected native multipart content');
      const incomingAttachment = received.content.items[0]?.content;
      if (incomingAttachment?.type !== 'attachment') throw new Error('Expected native attachment');
      const bytes = await incomingAttachment.read();
      return Response.json({
        id: sent.id, platform: sent.platform, direction: sent.direction,
        date: sent.timestamp instanceof Date, decorators: typeof sent.reply === 'function',
        multipart: multipart.content.type, bytes: [...bytes],
        hasBuffer: Reflect.has(globalThis, 'Buffer'), hasProcess: Reflect.has(globalThis, 'process'),
      });
    } finally { await app.close(); }
  },
};
