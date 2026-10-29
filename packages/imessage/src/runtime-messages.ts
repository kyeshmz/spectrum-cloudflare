const PART = /^p:(\d+)\/(.+)$/;

/** Multipart child identity follows Spectrum's established native bubble convention. */
export function targetRef(id: string): { guid: string; partIndex?: number } {
  const match = PART.exec(id);
  return match ? { guid: match[2]!, partIndex: Number(match[1]) } : { guid: id };
}

export function chatType(id: string): 'dm' | 'group' {
  return id.includes(';+;') ? 'group' : 'dm';
}

export function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
