// Adapted from shared/inbound-parts.ts in Photon AI's MIT spectrum-ts,
// commit d9e39089dc3d1c6f4536826f5ca50798856eecab. See THIRD-PARTY-NOTICES.md.
const ATTACHMENT_PLACEHOLDER = '\uFFFC';

type OrderedPart<T extends object> =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: T };

/** Assign native part positions BEFORE attempting any lazy attachment lookup. */
export function orderedMessageParts<T extends object>(
  text: string | undefined,
  attachments: readonly T[],
): readonly OrderedPart<T>[] {
  const parts: OrderedPart<T>[] = [];
  const addText = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) {
      parts.push({ type: 'text', text: trimmed });
    }
  };
  if (!text?.includes(ATTACHMENT_PLACEHOLDER)) {
    for (const attachment of attachments) {
      parts.push({ type: 'attachment', attachment });
    }
    addText(text);
    return parts;
  }
  const segments = text.split(ATTACHMENT_PLACEHOLDER);
  for (const [index, attachment] of attachments.entries()) {
    addText(segments[index]);
    parts.push({ type: 'attachment', attachment });
  }
  addText(segments.slice(attachments.length).join(''));
  return parts;
}
