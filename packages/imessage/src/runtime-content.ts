import { WorkersCapabilityError } from './runtime-errors.js';

export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface RichLinkContent {
  readonly type: 'richlink';
  readonly url: string;
}

/** A lazy byte source; the owning app controls its download lifetime. */
export interface AttachmentContent {
  readonly type: 'attachment';
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  read(): Promise<Uint8Array>;
  stream(): Promise<ReadableStream<Uint8Array>>;
}

export interface GroupContent {
  readonly type: 'group';
  readonly items: readonly ContentInput[];
}

/** Only the fields builders inspect; real messages may carry additional methods. */
export interface ContentTarget {
  readonly id: string;
  readonly content: { readonly type: string };
  readonly direction: 'inbound' | 'outbound';
}

export interface BuiltGroupContent {
  readonly type: 'group';
  readonly items: readonly { readonly id: string; readonly content: Content }[];
}

export interface ReplyContent {
  readonly type: 'reply';
  readonly content: StaticContent;
  readonly target: ContentTarget;
}

export interface EditContent {
  readonly type: 'edit';
  readonly content: StaticContent;
  readonly target: ContentTarget;
}

export interface ReactionContent {
  readonly type: 'reaction';
  readonly emoji: string;
  readonly target: ContentTarget;
}

export interface ReadContent { readonly type: 'read'; readonly target: ContentTarget }
export interface UnsendContent { readonly type: 'unsend'; readonly target: ContentTarget }
export interface TypingContent { readonly type: 'typing'; readonly state: 'start' | 'stop' }

export type StaticContent = TextContent | RichLinkContent | AttachmentContent;
export type Content = StaticContent | BuiltGroupContent | ReplyContent | EditContent
  | ReactionContent | ReadContent | UnsendContent | TypingContent;

/** Structural by design: application-owned async builders need no base class. */
export interface ContentBuilder<T extends Content = Content> {
  build(): Promise<T>;
}
export interface ReactionBuilder extends ContentBuilder<ReactionContent> {}
export type ContentInput = string | ContentBuilder | Content | GroupContent;
export type SendContent = ContentInput;

function withBuild<T extends object, C extends Content>(value: T, build: () => Promise<C>): T & ContentBuilder<C> {
  return Object.defineProperty(value, 'build', { value: build, enumerable: false }) as T & ContentBuilder<C>;
}

export function text(value: string): TextContent & ContentBuilder<TextContent> {
  if (typeof value !== 'string') {
    throw new TypeError('text requires a string');
  }
  return withBuild({ type: 'text' as const, text: value }, async () => {
    if (!value) throw new TypeError('text requires a nonempty string');
    return { type: 'text', text: value };
  });
}

export function richlink(value: string | URL): RichLinkContent & ContentBuilder<RichLinkContent> {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('richlink requires an HTTP(S) URL');
  }
  return withBuild({ type: 'richlink' as const, url: url.href }, async () => ({ type: 'richlink', url: url.href }));
}

/** Filesystem paths are never interpreted as network URLs. */
export function attachment(
  input: Uint8Array | Blob | URL | string,
  options: { id?: string; name?: string; mimeType?: string } = {},
): AttachmentContent & ContentBuilder<AttachmentContent> {
  if (typeof input === 'string') {
    throw new WorkersCapabilityError('attachment', 'Filesystem paths are unavailable; pass Uint8Array, Blob, or new URL(...)');
  }
  if (input instanceof URL && input.protocol !== 'https:' && input.protocol !== 'http:') {
    throw new TypeError('attachment URL must use HTTP(S)');
  }
  if (!(input instanceof Uint8Array) && !(input instanceof Blob) && !(input instanceof URL)) {
    throw new TypeError('attachment requires Uint8Array, Blob, or URL');
  }
  const name = options.name ?? (input instanceof URL ? input.pathname.split('/').at(-1) : undefined) ?? 'attachment';
  const mimeType = options.mimeType ?? ((input instanceof Blob ? input.type : '') || 'application/octet-stream');
  let id = options.id;
  const bytes = input instanceof Uint8Array ? input.slice() : undefined;
  const read = async (): Promise<Uint8Array> => {
    if (bytes) {
      return bytes.slice();
    }
    if (input instanceof Blob) {
      return new Uint8Array(await input.arrayBuffer());
    }
    throw new WorkersCapabilityError('attachment.read', 'URL attachment downloads are started by space.send so the app can cancel them');
  };
  const content: AttachmentContent = {
    type: 'attachment',
    // Workers prohibit randomness during module evaluation. Generate the local
    // id only when built/accessed in a request, retaining this object's identity.
    get id() { return id ??= crypto.randomUUID(); },
    name: name || 'attachment',
    mimeType,
    ...(input instanceof URL ? {} : { size: input instanceof Blob ? input.size : input.byteLength }),
    read,
    stream: async () => {
      if (input instanceof Blob) {
        return input.stream();
      }
      const data = await read();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
    },
  };
  if (input instanceof URL) {
    attachmentUrls.set(content, new URL(input));
  }
  return withBuild(content, async () => validateAttachment(content));
}

function validateAttachment(content: AttachmentContent): AttachmentContent {
  if (typeof content.read !== 'function' || typeof content.stream !== 'function'
    || typeof content.id !== 'string' || !content.id
    || typeof content.name !== 'string' || !content.name
    || typeof content.mimeType !== 'string' || !content.mimeType
    || (content.size !== undefined && (!Number.isSafeInteger(content.size) || content.size < 0))) {
    throw new TypeError('Invalid attachment content: expected nonempty id, name, mimeType and optional nonnegative integer size');
  }
  return content;
}

// The URL is an implementation detail of a content value, not public mutable state.
const attachmentUrls = new WeakMap<AttachmentContent, URL>();

export function attachmentUrl(content: AttachmentContent): URL | undefined {
  return attachmentUrls.get(content);
}

export function group(...items: ContentInput[]): GroupContent & ContentBuilder<BuiltGroupContent> {
  if (items.length < 2) {
    throw new TypeError('group requires at least two content parts');
  }
  return withBuild({ type: 'group' as const, items: [...items] }, async () => buildGroup(items));
}

async function buildGroup(items: readonly ContentInput[]): Promise<BuiltGroupContent> {
  if (items.length < 2) throw new TypeError('group requires at least two content parts');
  const resolved = await resolveContents(items);
  for (const item of resolved) {
    if (item.type === 'group' || item.type === 'reaction') {
      throw new TypeError(`group() cannot contain "${item.type}" items`);
    }
  }
  return { type: 'group', items: resolved.map(content => ({ id: '', content })) };
}

function targetFor(action: string, target: ContentTarget | undefined, direction?: 'inbound' | 'outbound'): ContentTarget {
  if (!target) throw new TypeError(`${action}() target is undefined — the targeted message was never sent`);
  if (typeof target.id !== 'string' || !target.content || typeof target.content.type !== 'string') {
    throw new TypeError(`${action}() target must be a Message`);
  }
  if (direction && target.direction !== direction) {
    throw new TypeError(`${action}() target must be an ${direction} message (got direction "${target.direction}", message id "${target.id}")`);
  }
  return target;
}

export function typing(state: 'start' | 'stop' = 'start'): ContentBuilder<TypingContent> {
  return { build: async () => {
    if (state !== 'start' && state !== 'stop') throw new TypeError('typing state must be start or stop');
    return { type: 'typing', state };
  } };
}

export function read(target: ContentTarget): ContentBuilder<ReadContent> {
  return { build: async () => ({ type: 'read', target: targetFor('read', target, 'inbound') }) };
}

export function unsend(target: ContentTarget | undefined): ContentBuilder<UnsendContent> {
  return { build: async () => ({ type: 'unsend', target: targetFor('unsend', target, 'outbound') }) };
}

export function reaction(emoji: string, target: ContentTarget | undefined): ReactionBuilder {
  return { build: async () => {
    const resolvedTarget = targetFor('reaction', target);
    if (resolvedTarget.content.type === 'reaction') throw new TypeError('reaction() cannot target "reaction" content');
    if (typeof emoji !== 'string' || !emoji) throw new TypeError('Reaction emoji must not be empty');
    return { type: 'reaction', emoji, target: resolvedTarget };
  } };
}

async function wrappedContent(action: 'reply' | 'edit', input: ContentInput): Promise<StaticContent> {
  const content = await resolveContent(input);
  if (content.type !== 'text' && content.type !== 'attachment' && content.type !== 'richlink') {
    throw new TypeError(`${action}() cannot wrap "${content.type}" content`);
  }
  return content;
}

export function reply(input: ContentInput, target: ContentTarget | undefined): ContentBuilder<ReplyContent> {
  return { build: async () => {
    const resolvedTarget = targetFor('reply', target);
    return { type: 'reply', content: await wrappedContent('reply', input), target: resolvedTarget };
  } };
}

export function edit(input: ContentInput, target: ContentTarget | undefined): ContentBuilder<EditContent> {
  return { build: async () => {
    const resolvedTarget = targetFor('edit', target, 'outbound');
    return { type: 'edit', content: await wrappedContent('edit', input), target: resolvedTarget };
  } };
}

/** Outbound boundary only: received raw empty text must not pass through this. */
export async function resolveContent(input: ContentInput): Promise<Content> {
  if (typeof input === 'string') return text(input).build();
  if (!input || typeof input !== 'object') throw new TypeError('Expected content or a ContentBuilder');
  if ('build' in input && typeof input.build === 'function') {
    return validateBuiltContent(await input.build());
  }
  // Legacy plain groups contain inputs rather than message stubs. Only these
  // inputs execute builders; a builder's result is already resolved content.
  if ('type' in input && input.type === 'group') {
    if (!Array.isArray(input.items)) throw new TypeError('Invalid group items');
    const items = await Promise.all(input.items.map(async (item: ContentInput | { id: string; content: Content }) => {
      if (typeof item === 'object' && item !== null && 'id' in item && 'content' in item) return item;
      return { id: '', content: await resolveContent(item) };
    }));
    return validateBuiltContent({ type: 'group', items });
  }
  return validateBuiltContent(input);
}

/** Validate resolved values without executing any attached build methods. */
async function validateBuiltContent(value: unknown): Promise<Content> {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new TypeError('ContentBuilder must build a Content value');
  const content = value as Content;
  switch (content.type) {
    case 'text': return text(content.text).build();
    case 'richlink': return richlink(content.url).build();
    case 'attachment': return validateAttachment(content);
    case 'group': {
      if (!Array.isArray(content.items)) throw new TypeError('Invalid group items');
      if (content.items.length < 2) throw new TypeError('group requires at least two content parts');
      const items = await Promise.all(content.items.map(async item => {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !('content' in item)) {
          throw new TypeError('Built group items must be Message stubs with id and content');
        }
        const member = await validateBuiltContent(item.content);
        if (member.type === 'group' || member.type === 'reaction') {
          throw new TypeError(`group() cannot contain "${member.type}" items`);
        }
        return { id: item.id, content: member };
      }));
      return { type: 'group', items };
    }
    case 'typing': return typing(content.state).build();
    case 'read': return read(content.target).build();
    case 'unsend': return unsend(content.target).build();
    case 'reaction': return reaction(content.emoji, content.target).build();
    case 'reply':
    case 'edit': {
      const target = targetFor(content.type, content.target, content.type === 'edit' ? 'outbound' : undefined);
      const inner = await validateBuiltContent(content.content);
      if (inner.type !== 'text' && inner.type !== 'attachment' && inner.type !== 'richlink') {
        throw new TypeError(`${content.type}() cannot wrap "${inner.type}" content`);
      }
      return { type: content.type, target, content: inner };
    }
    default: throw new WorkersCapabilityError('content', `Unsupported content type "${String((value as { type: unknown }).type)}"`);
  }
}

export function resolveContents(items: readonly ContentInput[]): Promise<Content[]> {
  return Promise.all(items.map(resolveContent));
}
