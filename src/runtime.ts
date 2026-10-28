import { Code, ConnectError } from '@connectrpc/connect';
import { SpectrumApi, type SpectrumApiOptions } from './api.js';
import type { IMessageRpc } from './grpc.js';
import { SpectrumLines, SHARED_PHONE, type ExplicitSpectrumLine } from './runtime-lines.js';
import { attachmentUrl, text, type AttachmentContent, type SendContent } from './runtime-content.js';
import { chatType, targetRef } from './runtime-messages.js';
import { MessageReactionKind } from './generated/photon/imessage/v1/message_types_pb.js';
import { ChatServiceType } from './generated/photon/imessage/v1/address_types_pb.js';
import { orderedMessageParts } from './runtime-parts.js';
import { receivedAttachment } from './runtime-attachments.js';
import { WorkersCapabilityError } from './runtime-errors.js';
import { verifyLegacySpectrumWebhook, verifyStandardWebhook, WebhookVerificationError } from './webhooks.js';
import type { MessageContent, SpectrumMessage, SpectrumSpace, SpectrumMessageHandler, SpectrumWebhookOptions } from './runtime-types.js';

type NativeMessage = NonNullable<Awaited<ReturnType<IMessageRpc['messages']['getMessage']>>['message']>;
type NativeAttachment = NonNullable<Awaited<ReturnType<IMessageRpc['attachments']['uploadAttachment']>>['attachment']>;
type ReplyTo = { messageGuid: string; targetPartIndex?: number };

const tapbacks: Readonly<Record<string, MessageReactionKind>> = {
  '❤️': MessageReactionKind.LOVE,
  '👍': MessageReactionKind.LIKE,
  '👎': MessageReactionKind.DISLIKE,
  '😂': MessageReactionKind.LAUGH,
  '‼️': MessageReactionKind.EMPHASIZE,
  '❓': MessageReactionKind.QUESTION,
};

function nativeReaction(emoji: string): { kind: MessageReactionKind; emoji?: string } {
  if (!emoji) {
    throw new TypeError('Reaction emoji must not be empty');
  }
  const kind = tapbacks[emoji];
  return kind === undefined ? { kind: MessageReactionKind.EMOJI, emoji } : { kind };
}

function assertIMessageAlias(value: unknown): void {
  if (value !== undefined && value !== 'imessage' && value !== 'iMessage') {
    throw new TypeError('Only imessage and iMessage platform aliases are supported');
  }
}

export interface CreateSpectrumOptions extends SpectrumApiOptions {
  readonly clients?: readonly ExplicitSpectrumLine[];
  readonly sharedBaseUrl?: string;
  readonly signal?: AbortSignal;
  readonly webhook?: SpectrumWebhookOptions;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`Expected nonempty ${field}`);
  }
  return value;
}

function date(value: { seconds: bigint; nanos: number } | undefined): Date {
  if (!value) {
    throw new Error('Native message omitted dateCreated');
  }
  const result = new Date(Number(value.seconds) * 1_000 + value.nanos / 1_000_000);
  if (!Number.isFinite(result.getTime())) {
    throw new Error('Native message has an invalid dateCreated');
  }
  return result;
}

/** Small Spectrum-adjacent facade. Native service clients remain directly available. */
export class SpectrumApp {
  private constructor(
    readonly api: SpectrumApi,
    private readonly lines: SpectrumLines,
    private readonly webhookOptions: SpectrumWebhookOptions | undefined,
    private readonly requestFetch: typeof fetch,
  ) {}

  static async create(options: CreateSpectrumOptions): Promise<SpectrumApp> {
    if (options.webhook && (options.webhook.scheme !== 'legacy' && options.webhook.scheme !== 'standard')) {
      throw new TypeError('Webhook scheme must be explicitly legacy or standard');
    }
    const api = new SpectrumApi(options);
    const lines = await SpectrumLines.create({
      api,
      ...(options.clients ? { clients: options.clients } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.sharedBaseUrl ? { sharedBaseUrl: options.sharedBaseUrl } : {}),
    }, options.signal);
    return new SpectrumApp(api, lines, options.webhook, options.fetch ?? globalThis.fetch.bind(globalThis));
  }

  /** Direct typed Connect clients; close() aborts their requests and server streams too. */
  async rpc(phone?: string): Promise<IMessageRpc> {
    return (await this.lines.select(phone)).rpc;
  }

  space(id: string, options: { phone?: string } = {}): SpectrumSpace {
    this.lines.assertOpen();
    requiredString(id, 'chat GUID');
    const phone = options.phone;
    const space: SpectrumSpace = {
      id,
      platform: 'imessage',
      type: chatType(id),
      ...(phone ? { phone } : {}),
      send: content => this.send(space, content),
      getMessage: messageId => this.getMessage(space, messageId),
      startTyping: () => this.lines.run(phone, async rpc => {
        await rpc.chats.setTyping({ chatGuid: id, isTyping: true });
      }),
      stopTyping: () => this.lines.run(phone, async rpc => {
        await rpc.chats.setTyping({ chatGuid: id, isTyping: false });
      }),
      read: () => this.lines.run(phone, async rpc => {
        await rpc.chats.markChatRead({ chatGuid: id });
      }),
    };
    return space;
  }

  async createSpace(peers: string | readonly string[], options: { phone?: string } = {}): Promise<SpectrumSpace> {
    const addresses = typeof peers === 'string' ? [peers] : [...peers];
    if (!addresses.length || addresses.some(peer => !peer)) {
      throw new TypeError('createSpace requires at least one nonempty peer address');
    }
    const line = await this.lines.forCreate(options.phone);
    if (line.phone === SHARED_PHONE) {
      if (addresses.length !== 1) {
        throw new WorkersCapabilityError('createSpace', 'Shared iMessage lines cannot create group chats');
      }
      return this.space(`any;-;${addresses[0]}`, { phone: line.phone });
    }
    const result = await this.lines.run(line.phone, rpc => rpc.chats.createChat({ addresses, service: ChatServiceType.IMESSAGE }));
    if (!result.chat?.guid) {
      throw new Error('CreateChat omitted chat.guid');
    }
    return this.space(result.chat.guid, { phone: line.phone });
  }

  private decorate(
    id: string,
    space: SpectrumSpace,
    content: MessageContent,
    timestamp: Date,
    direction: 'inbound' | 'outbound',
    senderId?: string,
  ): SpectrumMessage {
    const target = targetRef(id);
    const nativeTarget = { chatGuid: space.id, messageGuid: target.guid,
      ...(target.partIndex === undefined ? {} : { targetPartIndex: target.partIndex }) };
    return {
      id, space, content, timestamp, direction, platform: 'imessage',
      ...(senderId ? { sender: { id: senderId, platform: 'imessage' as const } } : {}),
      reply: value => this.send(space, value, { messageGuid: target.guid,
        ...(target.partIndex === undefined ? {} : { targetPartIndex: target.partIndex }) }),
      react: emoji => this.lines.run(space.phone, async rpc => {
        const result = await rpc.messages.setReaction({ target: nativeTarget,
          reaction: nativeReaction(emoji), isSet: true });
        const sent = this.requireMessage(result.message);
        return this.decorate(sent.guid, space, { type: 'reaction', emoji, targetId: id }, date(sent.dateCreated), 'outbound');
      }),
      edit: value => this.lines.run(space.phone, async rpc => {
        if (direction !== 'outbound') {
          throw new WorkersCapabilityError('edit', 'Only outbound messages can be edited');
        }
        await rpc.messages.editMessage({ target: nativeTarget, newText: typeof value === 'string' ? value : value.text });
      }),
      unsend: () => this.lines.run(space.phone, async rpc => {
        if (direction !== 'outbound') {
          throw new WorkersCapabilityError('unsend', 'Only outbound messages can be unsent');
        }
        if (content.type === 'reaction') {
          const original = targetRef(content.targetId);
          await rpc.messages.setReaction({
            target: { chatGuid: space.id, messageGuid: original.guid,
              ...(original.partIndex === undefined ? {} : { targetPartIndex: original.partIndex }) },
            reaction: nativeReaction(content.emoji), isSet: false,
          });
        } else {
          await rpc.messages.unsendMessage({ target: nativeTarget });
        }
      }),
      read: async () => {
        if (direction !== 'inbound') {
          throw new WorkersCapabilityError('read', 'Only inbound messages can be marked read');
        }
        await space.read();
      },
    };
  }

  private requireMessage(message: NativeMessage | undefined): NativeMessage {
    if (!message?.guid) {
      throw new Error('Native RPC response omitted message.guid');
    }
    return message;
  }

  private async upload(rpc: IMessageRpc, content: AttachmentContent): Promise<NativeAttachment> {
    const url = attachmentUrl(content);
    const data = url ? await this.lines.downloads.read(async () => {
      const response = await this.requestFetch(url, { signal: this.lines.signal, redirect: 'follow' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Attachment URL returned HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.lines.assertOpen();
      return bytes;
    }) : await content.read();
    const result = await rpc.attachments.uploadAttachment({ fileName: content.name, data });
    if (!result.attachment?.guid) {
      throw new Error('UploadAttachment omitted attachment.guid');
    }
    return result.attachment;
  }

  private async send(space: SpectrumSpace, input: SendContent, replyTo?: ReplyTo): Promise<SpectrumMessage> {
    const line = await this.lines.select(space.phone);
    const resolved = this.space(space.id, { phone: line.phone });
    const content = typeof input === 'string' ? text(input) : input;
    return this.lines.run(line.phone, async rpc => {
      const reply = replyTo ? { replyTo } : {};
      let sent: NativeMessage;
      if (content.type === 'text' || content.type === 'richlink') {
        const result = await rpc.messages.sendTextMessage({ chatGuid: space.id,
          text: content.type === 'text' ? content.text : content.url,
          ...(content.type === 'richlink' ? { enableLinkPreview: true } : {}), ...reply });
        sent = this.requireMessage(result.message);
      } else if (content.type === 'attachment') {
        const uploaded = await this.upload(rpc, content);
        const result = await rpc.messages.sendAttachmentMessage({ chatGuid: space.id,
          attachment: { source: { case: 'attachmentGuid', value: uploaded.guid } }, ...reply });
        sent = this.requireMessage(result.message);
        return this.decorate(sent.guid, resolved, receivedAttachment(this.lines, uploaded, line.phone), date(sent.dateCreated), 'outbound');
      } else {
        if (content.items.filter(part => part.type === 'text').length > 1) {
          throw new WorkersCapabilityError('group', 'iMessage multipart sends permit at most one text part');
        }
        const parts = [];
        const deliveredParts = [];
        for (const [index, part] of content.items.entries()) {
          if (part.type === 'text') {
            parts.push({ text: part.text, bubbleIndex: index });
            deliveredParts.push(part);
          } else {
            const uploaded = await this.upload(rpc, part);
            parts.push({ attachment: { source: { case: 'attachmentGuid' as const, value: uploaded.guid },
              attachmentName: part.name }, bubbleIndex: index });
            deliveredParts.push(receivedAttachment(this.lines, uploaded, line.phone));
          }
        }
        const result = await rpc.messages.sendMultipartMessage({ chatGuid: space.id, parts, ...reply });
        sent = this.requireMessage(result.message);
        const items = deliveredParts.map((part, index) => this.decorate(`p:${index}/${sent.guid}`, resolved, part, date(sent.dateCreated), 'outbound'));
        return this.decorate(sent.guid, resolved, { type: 'group', items }, date(sent.dateCreated), 'outbound');
      }
      return this.decorate(sent.guid, resolved, content, date(sent.dateCreated), 'outbound');
    });
  }

  private async getMessage(space: SpectrumSpace, id: string): Promise<SpectrumMessage | undefined> {
    const line = await this.lines.select(space.phone);
    const resolved = this.space(space.id, { phone: line.phone });
    return this.lines.run(line.phone, async rpc => {
      const target = targetRef(id);
      let native: NativeMessage;
      try {
        native = this.requireMessage((await rpc.messages.getMessage({ messageGuid: target.guid })).message);
      } catch (error) {
        if (error instanceof ConnectError && error.code === Code.NotFound) {
          return undefined;
        }
        throw error;
      }
      if (native.chatGuids.length && !native.chatGuids.includes(space.id)) {
        throw new Error('Native message belongs to another chat');
      }
      const parts = orderedMessageParts(native.content?.text, native.content?.attachments ?? []);
      const direction = native.isFromMe ? 'outbound' : 'inbound';
      const stamp = date(native.dateCreated);
      const materialize = (index: number): SpectrumMessage | undefined => {
        const part = parts[index];
        if (!part) {
          return undefined;
        }
        if (part.type === 'attachment' && !part.attachment.guid) {
          return undefined;
        }
        const content: MessageContent = part.type === 'text' ? text(part.text) : receivedAttachment(this.lines, part.attachment, line.phone);
        return this.decorate(parts.length > 1 || target.partIndex !== undefined ? `p:${index}/${native.guid}` : native.guid,
          resolved, content, stamp, direction, native.sender?.address);
      };
      if (target.partIndex !== undefined) {
        return materialize(target.partIndex);
      }
      const items = parts.map((_, index) => materialize(index))
        .filter((item): item is SpectrumMessage => item !== undefined);
      if (parts.length && !items.length) {
        return undefined;
      }
      if (items.length === 1) {
        return items[0];
      }
      return this.decorate(native.guid, resolved, items.length ? { type: 'group', items } : { type: 'unknown', raw: native }, stamp, direction, native.sender?.address);
    });
  }

  async getAttachment(id: string, options: { phone?: string } = {}): Promise<AttachmentContent | undefined> {
    const line = await this.lines.select(options.phone);
    return this.lines.run(line.phone, async rpc => {
      try {
        const info = (await rpc.attachments.getAttachmentInfo({ attachmentGuid: id })).attachment;
        return info ? receivedAttachment(this.lines, info, line.phone) : undefined;
      } catch (error) {
        if (error instanceof ConnectError && error.code === Code.NotFound) {
          return undefined;
        }
        throw error;
      }
    });
  }

  /** Authentication precedes alias normalization and user callbacks; handlers are awaited. */
  async webhook(request: Request, handler: SpectrumMessageHandler, options = this.webhookOptions): Promise<Response> {
    this.lines.assertOpen();
    if (!options) {
      throw new Error('Configure an explicit webhook scheme and secret');
    }
    if (options.scheme !== 'legacy' && options.scheme !== 'standard') {
      throw new TypeError('Webhook scheme must be explicitly legacy or standard');
    }
    if (request.method !== 'POST') {
      return new Response('Expected POST', { status: 405 });
    }
    let envelope: unknown;
    try {
      const verification = { body: new Uint8Array(await request.arrayBuffer()), headers: request.headers, secret: options.secret };
      envelope = options.scheme === 'legacy' ? await verifyLegacySpectrumWebhook(verification) : await verifyStandardWebhook(verification);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return new Response('Invalid webhook', { status: error.code === 'signature' || error.code === 'timestamp' ? 401 : 400 });
      }
      throw error;
    }
    let message: SpectrumMessage;
    try {
      if (!object(envelope) || envelope.event !== 'messages' || !object(envelope.message)) {
        throw new TypeError('Expected a normalized Spectrum messages envelope');
      }
      message = await this.hydrate(envelope.message, envelope.space, 0);
    } catch (error) {
      if (error instanceof TypeError) {
        return new Response('Invalid normalized webhook payload', { status: 400 });
      }
      throw error;
    }
    await handler(message.space, message);
    return new Response('ok');
  }

  private async hydrate(value: unknown, inheritedSpace: unknown, depth: number): Promise<SpectrumMessage> {
    if (depth > 16 || !object(value)) {
      throw new TypeError('Invalid normalized message');
    }
    const rawSpace = object(value.space) ? value.space : inheritedSpace;
    if (!object(rawSpace)) {
      throw new TypeError('Missing normalized message space');
    }
    const platform = value.platform ?? rawSpace.platform;
    if (platform !== 'imessage' && platform !== 'iMessage') {
      throw new TypeError('Only imessage and iMessage platform aliases are supported');
    }
    assertIMessageAlias(value.platform);
    assertIMessageAlias(rawSpace.platform);
    if (object(value.sender)) {
      assertIMessageAlias(value.sender.platform);
    }
    if (value.direction !== undefined && value.direction !== 'inbound') {
      throw new TypeError('Normalized webhook messages must be inbound');
    }
    const space = this.space(requiredString(rawSpace.id, 'space.id'), typeof rawSpace.phone === 'string' ? { phone: rawSpace.phone } : {});
    const id = requiredString(value.id, 'message.id');
    const timestamp = new Date(requiredString(value.timestamp, 'message.timestamp'));
    if (!Number.isFinite(timestamp.getTime()) || !object(value.content)) {
      throw new TypeError('Invalid message timestamp or content');
    }
    const raw = value.content;
    requiredString(raw.type, 'content.type');
    let content: MessageContent;
    if (raw.type === 'text') {
      if (typeof raw.text !== 'string') {
        throw new TypeError('Normalized text content must contain a text string');
      }
      content = text(raw.text);
    } else if (raw.type === 'attachment') {
      const attachmentId = requiredString(raw.id, 'attachment.id');
      const app = this;
      content = { type: 'attachment', id: attachmentId,
        name: requiredString(raw.name, 'attachment.name'), mimeType: requiredString(raw.mimeType, 'attachment.mimeType'),
        read: async () => {
          const found = await app.getAttachment(attachmentId, typeof rawSpace.phone === 'string' ? { phone: rawSpace.phone } : {});
          if (!found) {
            throw new Error('Webhook attachment not found');
          }
          return found.read();
        },
        stream: async () => {
          const found = await app.getAttachment(attachmentId, typeof rawSpace.phone === 'string' ? { phone: rawSpace.phone } : {});
          if (!found) {
            throw new Error('Webhook attachment not found');
          }
          return found.stream();
        },
      };
    } else if (raw.type === 'group' && Array.isArray(raw.items) && raw.items.length <= 1_000) {
      const items: SpectrumMessage[] = [];
      for (const child of raw.items) {
        items.push(await this.hydrate(child, rawSpace, depth + 1));
      }
      content = { type: 'group', items };
    } else if (raw.type === 'reaction' && typeof raw.emoji === 'string' && object(raw.target)) {
      assertIMessageAlias(raw.target.platform);
      content = { type: 'reaction', emoji: raw.emoji, targetId: requiredString(raw.target.id, 'reaction.target.id') };
    } else {
      content = { type: 'unknown', raw };
    }
    return this.decorate(id, space, content, timestamp, 'inbound', object(value.sender) && typeof value.sender.id === 'string' ? value.sender.id : undefined);
  }

  close(): Promise<void> {
    return this.lines.close();
  }
}

export function createSpectrum(options: CreateSpectrumOptions): Promise<SpectrumApp> {
  return SpectrumApp.create(options);
}
