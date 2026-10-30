import type { AttachmentContent, ContentInput, ContentTarget, ReactionBuilder, StaticContent, GroupContent, BuiltGroupContent, TextContent, RichLinkContent } from './runtime-content.js';

/** Inputs which produce a message, rather than a control-signal result. */
export type MessageInput = string | StaticContent | GroupContent | BuiltGroupContent;

export interface SpectrumUser {
  readonly id: string;
  readonly platform: 'imessage';
  readonly __platform: 'imessage';
}

export interface ReactionContent {
  readonly type: 'reaction';
  readonly emoji: string;
  readonly targetId: string;
  readonly target: ContentTarget;
}

export type MessageContent =
  | TextContent
  | RichLinkContent
  | AttachmentContent
  | ReactionContent
  | { readonly type: 'group'; readonly items: readonly SpectrumMessage[] }
  | { readonly type: 'unknown'; readonly raw: unknown };

export interface SpectrumMessage {
  readonly id: string;
  readonly platform: 'imessage';
  readonly direction: 'inbound' | 'outbound';
  readonly timestamp: Date;
  readonly sender?: SpectrumUser;
  readonly space: SpectrumSpace;
  readonly content: MessageContent;
  reply(content: MessageInput): Promise<SpectrumMessage>;
  reply(content: ContentInput): Promise<SpectrumMessage | undefined>;
  reply(first: ContentInput, second: ContentInput, ...rest: ContentInput[]): Promise<SpectrumMessage[]>;
  react(emoji: string): Promise<SpectrumReactionMessage>;
  edit(content: ContentInput): Promise<void>;
  unsend(): Promise<void>;
  read(): Promise<void>;
}

export type SpectrumReactionMessage = SpectrumMessage & { readonly content: ReactionContent };

export interface SpectrumSpace {
  readonly id: string;
  readonly platform: 'imessage';
  readonly __platform: 'imessage';
  readonly phone?: string;
  readonly type: 'dm' | 'group';
  send(content: ReactionBuilder): Promise<SpectrumReactionMessage | undefined>;
  send(content: MessageInput): Promise<SpectrumMessage>;
  send(content: ContentInput): Promise<SpectrumMessage | undefined>;
  send(first: ContentInput, second: ContentInput, ...rest: ContentInput[]): Promise<SpectrumMessage[]>;
  getMessage(id: string): Promise<SpectrumMessage | undefined>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
  read(message?: SpectrumMessage): Promise<void>;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  edit(message: SpectrumMessage | undefined, content: ContentInput): Promise<void>;
  unsend(message: SpectrumMessage | undefined): Promise<void>;
}

export interface ProjectData {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly profile: Record<string, unknown>;
}

export interface WebhookRawRequest {
  readonly body: Uint8Array | ArrayBuffer;
  readonly headers?: Record<string, string>;
}

export interface WebhookRawResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

export type SpectrumMessageHandler = (space: SpectrumSpace, message: SpectrumMessage) => void | Promise<void>;

export interface SpectrumWebhookOptions {
  /** Explicit signature scheme; malformed input never triggers fallback verification. */
  readonly scheme: 'legacy' | 'standard';
  readonly secret: string;
}
