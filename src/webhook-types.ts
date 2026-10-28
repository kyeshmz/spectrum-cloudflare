/** Legacy normalized-events.v1 payloads only. raw-inbound.v1 remains unknown. */
export interface SerializedSpectrumSpace {
  id: string;
  platform: string;
  [key: string]: unknown;
}

export interface SerializedSpectrumUser {
  id: string;
  platform: string;
}

export interface SpectrumMessageRef {
  id: string;
  platform: string;
  timestamp: string;
  sender?: SerializedSpectrumUser;
  contentPreview?: string;
}

export type NormalizedSpectrumContent =
  | { type: 'text'; text: string }
  | { type: 'attachment'; id: string; name: string; mimeType: string; size?: number }
  | { type: 'contact'; name?: { formatted?: string; first?: string; last?: string }; phones?: { value: string; type?: string }[]; photo?: { mimeType: string }; raw?: unknown }
  | { type: 'richlink'; url: string }
  | { type: 'reaction'; emoji: string; target: SpectrumMessageRef }
  | { type: 'group'; items: SerializedSpectrumAlbumItem[] };

/**
 * Unknown arms may be introduced without a breaking server release. Use
 * isNormalizedSpectrumContent from webhooks.ts to validate a known-content view
 * before discriminator narrowing; type === 'text' alone cannot prove text exists.
 */
export type SerializedSpectrumContent = NormalizedSpectrumContent | { type: string; [key: string]: unknown };

export interface SerializedSpectrumAlbumItem {
  id: string;
  platform: string;
  direction: 'inbound';
  timestamp: string;
  sender: SerializedSpectrumUser;
  /** Child album items omit this in the documented example. */
  space?: SerializedSpectrumSpace;
  content: SerializedSpectrumContent;
  [key: string]: unknown;
}

export interface SerializedSpectrumInboundMessage extends SerializedSpectrumAlbumItem {
  space: SerializedSpectrumSpace;
}

export interface NormalizedSpectrumWebhookEvent {
  event: 'messages';
  space: SerializedSpectrumSpace;
  message: SerializedSpectrumInboundMessage;
  [key: string]: unknown;
}
