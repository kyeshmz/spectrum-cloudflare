import { Code, ConnectError } from '@connectrpc/connect';
import { SpectrumApi, type SpectrumApiOptions } from '@spectrum-cloudflare/api';
import type { IMessageRpc } from './grpc.js';
import { SpectrumLines, SHARED_PHONE, type ExplicitSpectrumLine } from './runtime-lines.js';
import { attachmentUrl, resolveContent, reply, edit, unsend, reaction, read, type AttachmentContent, type ContentInput, type ContentTarget, type Content } from './runtime-content.js';
import { chatType, targetRef } from './runtime-messages.js';
import { MessageReactionKind } from './generated/photon/imessage/v1/message_types_pb.js';
import { ChatServiceType } from './generated/photon/imessage/v1/address_types_pb.js';
import { orderedMessageParts } from './runtime-parts.js';
import { receivedAttachment } from './runtime-attachments.js';
import { WorkersCapabilityError } from './runtime-errors.js';
import { verifyLegacySpectrumWebhook, verifyStandardWebhook, WebhookVerificationError } from '@spectrum-cloudflare/webhooks';
import type { MessageContent, MessageInput, ProjectData, SpectrumMessage, SpectrumReactionMessage, SpectrumSpace, SpectrumMessageHandler, SpectrumWebhookOptions, WebhookRawRequest, WebhookRawResult } from './runtime-types.js';
import { createNativeMessageStream } from './runtime-streams.js';

type NativeMessage = NonNullable<Awaited<ReturnType<IMessageRpc['messages']['getMessage']>>['message']>;
type NativeAttachment = NonNullable<Awaited<ReturnType<IMessageRpc['attachments']['uploadAttachment']>>['attachment']>;
type ReplyTo = { messageGuid: string; targetPartIndex?: number };

// Ownership metadata only: credentials and lifetime remain owned by SpectrumLines.
// This also resolves offline spaces received without a phone in a webhook.
const spaceOwners = new WeakMap<SpectrumSpace, SpectrumApp>();

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

/** Internal creation boundary shared by both public factories. */
export interface SpectrumRuntimeOptions extends Omit<CreateSpectrumOptions, 'projectId' | 'projectSecret'> {
  readonly projectId?: string;
  readonly projectSecret?: string;
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
  readonly messages: AsyncIterable<[SpectrumSpace, SpectrumMessage]>;

  private constructor(
    private readonly cloudApi: SpectrumApi | undefined,
    private readonly lines: SpectrumLines,
    private readonly webhookOptions: SpectrumWebhookOptions | undefined,
    private readonly requestFetch: typeof fetch,
    readonly config: ProjectData | undefined,
  ) {
    this.messages = createNativeMessageStream({
      lines,
      materialize: (native, phone, chatGuid, timestamp) => this.materialize(native, this.space(chatGuid, { phone }), undefined, timestamp),
    });
  }

  get api(): SpectrumApi {
    if (!this.cloudApi) throw new WorkersCapabilityError('api', 'Project credentials are required for cloud API requests');
    return this.cloudApi;
  }

  static async create(options: SpectrumRuntimeOptions, loadProject = false): Promise<SpectrumApp> {
    options.signal?.throwIfAborted();
    if ((options.projectId === undefined) !== (options.projectSecret === undefined)) {
      throw new TypeError('projectId and projectSecret must be provided together');
    }
    if (options.webhook && (options.webhook.scheme !== 'legacy' && options.webhook.scheme !== 'standard')) {
      throw new TypeError('Webhook scheme must be explicitly legacy or standard');
    }
    const api = options.projectId !== undefined && options.projectSecret !== undefined
      ? new SpectrumApi({ ...options, projectId: options.projectId, projectSecret: options.projectSecret }) : undefined;
    let config: ProjectData | undefined;
    if (loadProject && api) {
      const project = await api.request('GET', '/projects/{projectId}/', { ...(options.signal ? { signal: options.signal } : {}) });
      config = { ...project, id: options.projectId! };
      options.signal?.throwIfAborted();
    }
    const lines = await SpectrumLines.create({
      ...(api ? { api } : {}),
      ...(options.clients ? { clients: options.clients } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.sharedBaseUrl ? { sharedBaseUrl: options.sharedBaseUrl } : {}),
    }, options.signal);
    return new SpectrumApp(api, lines, options.webhook, options.fetch ?? globalThis.fetch.bind(globalThis), config);
  }

  /** Direct typed Connect clients; close() aborts their requests and server streams too. */
  async rpc(phone?: string): Promise<IMessageRpc> {
    return (await this.lines.select(phone)).rpc;
  }

  space(id: string, options: { phone?: string; type?: 'dm' | 'group' } = {}): SpectrumSpace {
    this.lines.assertOpen();
    requiredString(id, 'chat GUID');
    const phone = options.phone;
    const space: SpectrumSpace = {
      id,
      platform: 'imessage',
      __platform: 'imessage',
      type: options.type ?? chatType(id),
      ...(phone ? { phone } : {}),
      send: ((...content: ContentInput[]) => this.sendInputs(space, content)) as SpectrumSpace['send'],
      getMessage: messageId => this.getMessage(space, messageId),
      startTyping: () => this.lines.run(phone, async rpc => {
        await rpc.chats.setTyping({ chatGuid: id, isTyping: true });
      }),
      stopTyping: () => this.lines.run(phone, async rpc => {
        await rpc.chats.setTyping({ chatGuid: id, isTyping: false });
      }),
      read: async message => {
        const destination = message ? await this.resolveTargetSpace(space, message, 'read', 'inbound') : space;
        await this.lines.run(destination.phone, async rpc => { await rpc.chats.markChatRead({ chatGuid: id }); });
      },
      responding: async fn => {
        await space.startTyping();
        try { return await fn(); } finally { await space.stopTyping().catch(() => undefined); }
      },
      edit: async (message, content) => { await this.sendOne(space, edit(content, message)); },
      unsend: async message => { await this.sendOne(space, unsend(message)); },
    };
    spaceOwners.set(space, this);
    return space;
  }

  /** Provider-level get resolves routing immediately, but never fetches a chat. */
  async getSpace(id: string, options: { phone?: string } = {}): Promise<SpectrumSpace> {
    const lines = await this.lines.snapshot();
    if (!lines.length) throw new Error('No iMessage clients configured');
    const phone = lines.length === 1 && lines[0]!.phone === SHARED_PHONE ? SHARED_PHONE
      : options.phone ?? (lines.length === 1 ? lines[0]!.phone : undefined);
    if (!phone) throw new Error(`iMessage space.get requires params.phone when multiple clients are configured. Available: ${lines.map(line => line.phone).join(', ')}`);
    return this.space(id, { phone });
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
    return this.space(result.chat.guid, { phone: line.phone, type: result.chat.isGroup ? 'group' : 'dm' });
  }

  private decorate(
    id: string,
    space: SpectrumSpace,
    content: MessageContent,
    timestamp: Date,
    direction: 'inbound' | 'outbound',
    senderId?: string,
  ): SpectrumMessage {
    const message: SpectrumMessage = {
      id, space, content, timestamp, direction, platform: 'imessage',
      ...(senderId ? { sender: { id: senderId, platform: 'imessage' as const, __platform: 'imessage' as const } } : {}),
      reply: ((...values: ContentInput[]) => this.sendInputs(space, values.map(value => reply(value, message)))) as SpectrumMessage['reply'],
      react: async emoji => (await this.sendOne(space, reaction(emoji, message))) as SpectrumReactionMessage,
      edit: async value => { await this.sendOne(space, edit(value, message)); },
      unsend: async () => { await this.sendOne(space, unsend(message)); },
      read: async () => { await this.sendOne(space, read(message)); },
    };
    return message;
  }

  private async resolveTargetSpace(space: SpectrumSpace, target: ContentTarget, action: string, direction?: 'inbound' | 'outbound'): Promise<SpectrumSpace> {
    const line = await this.lines.select(space.phone);
    const destination = this.space(space.id, { phone: line.phone, type: space.type });
    if (direction && target.direction !== direction) {
      throw new WorkersCapabilityError(action, `Only ${direction} messages can be ${action === 'read' ? 'marked read' : action === 'edit' ? 'edited' : 'unsent'}`);
    }
    if ('space' in target && object(target.space)) {
      if (target.space.id !== destination.id) throw new TypeError(`${action} target belongs to another space`);
      const owner = spaceOwners.get(target.space as unknown as SpectrumSpace);
      const targetPhone = owner
        ? (await owner.lines.select(typeof target.space.phone === 'string' ? target.space.phone : undefined)).phone
        : target.space.phone;
      // A structural reference without any space is supported by content builders;
      // an actual space with unresolved ownership must not authorize a write.
      if (typeof targetPhone !== 'string' || !targetPhone) throw new TypeError(`${action} target space phone is unresolved`);
      if (targetPhone !== destination.phone) throw new TypeError(`${action} target belongs to another space`);
    }
    return destination;
  }

  private async sendInputs(space: SpectrumSpace, inputs: ContentInput[]): Promise<SpectrumMessage | SpectrumMessage[] | undefined> {
    if (!inputs.length) throw new TypeError('send requires at least one content input');
    if (inputs.length === 1) return this.sendOne(space, inputs[0]!);
    const messages: SpectrumMessage[] = [];
    for (const input of inputs) {
      const message = await this.sendOne(space, input);
      if (message) messages.push(message);
    }
    return messages;
  }

  private async sendOne(space: SpectrumSpace, input: ContentInput): Promise<SpectrumMessage | undefined> {
    this.lines.assertOpen();
    const content = await resolveContent(input);
    if (content.type === 'typing') {
      await (content.state === 'start' ? space.startTyping() : space.stopTyping());
      return;
    }
    if (content.type === 'read' || content.type === 'reply' || content.type === 'reaction' || content.type === 'edit' || content.type === 'unsend') {
      space = await this.resolveTargetSpace(space, content.target, content.type,
        content.type === 'read' ? 'inbound' : content.type === 'edit' || content.type === 'unsend' ? 'outbound' : undefined);
    }
    if (content.type === 'read') {
      await space.read();
      return;
    }
    if (content.type === 'reply') {
      const target = targetRef(content.target.id);
      return this.sendResolved(space, content.content, { messageGuid: target.guid,
        ...(target.partIndex === undefined ? {} : { targetPartIndex: target.partIndex }) });
    }
    if (content.type === 'reaction' || content.type === 'edit' || content.type === 'unsend') {
      const target = targetRef(content.target.id);
      const nativeTarget = { chatGuid: space.id, messageGuid: target.guid,
        ...(target.partIndex === undefined ? {} : { targetPartIndex: target.partIndex }) };
      return this.lines.run(space.phone, async rpc => {
        if (content.type === 'reaction') {
          const sent = this.requireMessage((await rpc.messages.setReaction({ target: nativeTarget,
            reaction: nativeReaction(content.emoji), isSet: true })).message);
          return this.decorate(sent.guid, space, { type: 'reaction', emoji: content.emoji,
            targetId: content.target.id, target: content.target }, date(sent.dateCreated), 'outbound');
        }
        if (content.type === 'edit') {
          if (content.content.type !== 'text') throw new WorkersCapabilityError('edit', 'Only text messages can be edited');
          await rpc.messages.editMessage({ target: nativeTarget, newText: content.content.text });
        } else if (content.target.content.type === 'reaction') {
          const reactionContent = content.target.content as unknown as { targetId?: string; target?: ContentTarget; emoji: string };
          const original = targetRef(reactionContent.target?.id ?? requiredString(reactionContent.targetId, 'reaction target id'));
          await rpc.messages.setReaction({ target: { chatGuid: space.id, messageGuid: original.guid,
            ...(original.partIndex === undefined ? {} : { targetPartIndex: original.partIndex }) },
          reaction: nativeReaction(reactionContent.emoji), isSet: false });
        } else {
          await rpc.messages.unsendMessage({ target: nativeTarget });
        }
        return undefined;
      });
    }
    return this.sendResolved(space, content);
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

  private async sendResolved(space: SpectrumSpace, content: Exclude<Content, { type: 'typing' | 'read' | 'reply' | 'reaction' | 'edit' | 'unsend' }>, replyTo?: ReplyTo): Promise<SpectrumMessage> {
    const line = await this.lines.select(space.phone);
    const resolved = this.space(space.id, { phone: line.phone, type: space.type });
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
        const staticParts = content.items.map(item => item.content);
        if (staticParts.some(part => part.type !== 'text' && part.type !== 'attachment')) {
          throw new WorkersCapabilityError('group', 'iMessage multipart sends support only text and attachment parts');
        }
        if (staticParts.filter(part => part.type === 'text').length > 1) {
          throw new WorkersCapabilityError('group', 'iMessage multipart sends permit at most one text part');
        }
        const parts = [];
        const deliveredParts = [];
        for (const [index, part] of staticParts.entries()) {
          if (part.type === 'text') {
            parts.push({ text: part.text, bubbleIndex: index });
            deliveredParts.push(part);
          } else if (part.type === 'attachment') {
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

  async getMessage(space: SpectrumSpace, id: string): Promise<SpectrumMessage | undefined> {
    const line = await this.lines.select(space.phone);
    const resolved = this.space(space.id, { phone: line.phone, type: space.type });
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
      return this.materialize(native, resolved, target.partIndex);
    });
  }

  /** Shared by by-id lookup and embedded native stream events; never performs RPC. */
  private materialize(native: NativeMessage, resolved: SpectrumSpace, partIndex?: number, timestamp?: Date): SpectrumMessage | undefined {
    const parts = orderedMessageParts(native.content?.text, native.content?.attachments ?? []);
    const direction = native.isFromMe ? 'outbound' : 'inbound';
    const stamp = timestamp ?? date(native.dateCreated);
    const materialize = (index: number): SpectrumMessage | undefined => {
      const part = parts[index];
      if (!part || (part.type === 'attachment' && !part.attachment.guid)) {
        return undefined;
      }
      const content: MessageContent = part.type === 'text' ? { type: 'text', text: part.text }
        : receivedAttachment(this.lines, part.attachment, resolved.phone!);
      return this.decorate(parts.length > 1 || partIndex !== undefined ? `p:${index}/${native.guid}` : native.guid,
        resolved, content, stamp, direction, native.sender?.address);
    };
    if (partIndex !== undefined) return materialize(partIndex);
    const items = parts.map((_, index) => materialize(index))
      .filter((item): item is SpectrumMessage => item !== undefined);
    if (parts.length && !items.length) return undefined;
    if (items.length === 1) return items[0];
    return this.decorate(native.guid, resolved, items.length ? { type: 'group', items } : { type: 'unknown', raw: native }, stamp, direction, native.sender?.address);
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
  webhook(request: Request, handler: SpectrumMessageHandler, options?: SpectrumWebhookOptions): Promise<Response>;
  webhook(request: WebhookRawRequest, handler: SpectrumMessageHandler, options?: SpectrumWebhookOptions): Promise<WebhookRawResult>;
  async webhook(request: Request | WebhookRawRequest, handler: SpectrumMessageHandler, options = this.webhookOptions): Promise<Response | WebhookRawResult> {
    if (request instanceof Request) return this.handleWebhook(request, handler, options);
    const bytes = request.body instanceof ArrayBuffer ? request.body : request.body.slice().buffer;
    const response = await this.handleWebhook(new Request('https://spectrum.invalid/webhook', {
      method: 'POST', headers: request.headers ?? {}, body: bytes,
    }), handler, options);
    return { status: response.status, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
  }

  private async handleWebhook(request: Request, handler: SpectrumMessageHandler, options: SpectrumWebhookOptions | undefined): Promise<Response> {
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
      content = { type: 'text', text: raw.text };
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
      const targetId = requiredString(raw.target.id, 'reaction.target.id');
      content = { type: 'reaction', emoji: raw.emoji, targetId,
        target: { id: targetId, direction: raw.target.direction === 'outbound' ? 'outbound' : 'inbound',
          content: object(raw.target.content) && typeof raw.target.content.type === 'string' ? { type: raw.target.content.type } : { type: 'unknown' } } };
    } else {
      content = { type: 'unknown', raw };
    }
    return this.decorate(id, space, content, timestamp, 'inbound', object(value.sender) && typeof value.sender.id === 'string' ? value.sender.id : undefined);
  }

  close(): Promise<void> {
    return this.lines.close();
  }

  stop(): Promise<void> { return this.close(); }

  send(space: SpectrumSpace, content: MessageInput): Promise<SpectrumMessage>;
  send(space: SpectrumSpace, content: ContentInput): Promise<SpectrumMessage | undefined>;
  send(space: SpectrumSpace, first: ContentInput, second: ContentInput, ...rest: ContentInput[]): Promise<SpectrumMessage[]>;
  send(space: SpectrumSpace, ...content: ContentInput[]): Promise<SpectrumMessage | SpectrumMessage[] | undefined> {
    if (!content.length) return Promise.reject(new TypeError('send requires at least one content input'));
    return content.length === 1 ? space.send(content[0]!) : space.send(content[0]!, content[1]!, ...content.slice(2));
  }

  async edit(message: SpectrumMessage, content: ContentInput): Promise<void> {
    await message.edit(content);
  }

  responding<T>(space: SpectrumSpace, fn: () => T | Promise<T>): Promise<T> {
    return space.responding(fn);
  }
}

export function createSpectrum(options: CreateSpectrumOptions): Promise<SpectrumApp> {
  return SpectrumApp.create(options);
}
