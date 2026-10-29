import type { AttachmentContent, SendContent, TextContent, RichLinkContent } from './runtime-content.js';

export interface SpectrumUser {
  readonly id: string;
  readonly platform: 'imessage';
}

export interface ReactionContent {
  readonly type: 'reaction';
  readonly emoji: string;
  readonly targetId: string;
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
  reply(content: SendContent): Promise<SpectrumMessage>;
  react(emoji: string): Promise<SpectrumMessage>;
  edit(content: string | TextContent): Promise<void>;
  unsend(): Promise<void>;
  read(): Promise<void>;
}

export interface SpectrumSpace {
  readonly id: string;
  readonly platform: 'imessage';
  readonly phone?: string;
  readonly type: 'dm' | 'group';
  send(content: SendContent): Promise<SpectrumMessage>;
  getMessage(id: string): Promise<SpectrumMessage | undefined>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
  read(): Promise<void>;
}

export type SpectrumMessageHandler = (space: SpectrumSpace, message: SpectrumMessage) => void | Promise<void>;

export interface SpectrumWebhookOptions {
  /** Explicit signature scheme; malformed input never triggers fallback verification. */
  readonly scheme: 'legacy' | 'standard';
  readonly secret: string;
}
