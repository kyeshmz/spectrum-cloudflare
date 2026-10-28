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
  readonly items: readonly (TextContent | AttachmentContent)[];
}

export type SendContent = string | TextContent | RichLinkContent | AttachmentContent | GroupContent;

export function text(value: string): TextContent {
  if (typeof value !== 'string') {
    throw new TypeError('text requires a string');
  }
  return { type: 'text', text: value };
}

export function richlink(value: string | URL): RichLinkContent {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('richlink requires an HTTP(S) URL');
  }
  return { type: 'richlink', url: url.href };
}

/** Filesystem paths are never interpreted as network URLs. */
export function attachment(
  input: Uint8Array | Blob | URL | string,
  options: { name?: string; mimeType?: string } = {},
): AttachmentContent {
  if (typeof input === 'string') {
    throw new WorkersCapabilityError('attachment', 'Filesystem paths are unavailable; pass Uint8Array, Blob, or new URL(...)');
  }
  if (input instanceof URL && input.protocol !== 'https:' && input.protocol !== 'http:') {
    throw new TypeError('attachment URL must use HTTP(S)');
  }
  const name = options.name ?? (input instanceof URL ? input.pathname.split('/').at(-1) : undefined) ?? 'attachment';
  const mimeType = options.mimeType ?? ((input instanceof Blob ? input.type : '') || 'application/octet-stream');
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
    // The native upload assigns the persistent GUID; content creation needs no I/O.
    id: '',
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
  return content;
}

// The URL is an implementation detail of a content value, not public mutable state.
const attachmentUrls = new WeakMap<AttachmentContent, URL>();

export function attachmentUrl(content: AttachmentContent): URL | undefined {
  return attachmentUrls.get(content);
}

export function group(...items: (TextContent | AttachmentContent)[]): GroupContent {
  if (items.length < 2) {
    throw new TypeError('group requires at least two content parts');
  }
  return { type: 'group', items: [...items] };
}
