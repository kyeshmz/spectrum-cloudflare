import { describe, expect, it } from 'vitest';
import {
  attachment, attachmentUrl, edit, group, reaction, read, reply, resolveContent,
  resolveContents, richlink, text, typing, unsend,
  type ContentBuilder, type ContentInput, type ContentTarget,
} from '../packages/imessage/src/runtime-content.js';

// Scenario lineage: spectrum-ts d9e39089dc3d1c6f4536826f5ca50798856eecab.
// Adapted assertions: Copyright (c) 2025 Photon AI, MIT; see THIRD-PARTY-NOTICES.md.
// packages/core/test/content/text.test.ts ("text strings"), read.test.ts,
// unsend.test.ts; remaining assertions derive directly from the builders in
// packages/core/src/content/{resolve,group,reply,reaction,edit,typing,richlink,attachment}.ts.
// Web adaptation: Uint8Array/Blob instead of Buffer/files; URL downloads stay
// app-owned; MIME defaults remain Blob.type/application/octet-stream (no mime-types dependency).
const message = (direction: 'inbound' | 'outbound'): ContentTarget => ({
  id: 'p:1/message-guid', content: { type: 'text' }, direction,
});

describe('Spectrum static content builders', () => {
  it('builds upstream static text and defers empty-string failure until build', async () => {
    expect(await text('hi').build()).toEqual({ type: 'text', text: 'hi' });
    const empty = text('');
    expect(empty).toEqual({ type: 'text', text: '' });
    await expect(empty.build()).rejects.toThrow('nonempty');
    await expect(resolveContent('')).rejects.toThrow('nonempty');
    await expect(resolveContent({ type: 'text', text: '' })).rejects.toThrow('nonempty');
  });

  it('keeps plain conveniences and non-enumerable build methods', async () => {
    const content = text('hi');
    expect(content.text).toBe('hi');
    expect(Object.keys(content)).toEqual(['type', 'text']);
    expect(JSON.stringify(content)).toBe('{"type":"text","text":"hi"}');
    expect(await richlink('https://example.com/path').build()).toEqual({
      type: 'richlink', url: 'https://example.com/path',
    });
  });

  it('resolves arbitrary structural async builders, strings, and legacy plain values', async () => {
    const custom: ContentBuilder = { build: async () => ({ type: 'text', text: 'custom' }) };
    const inputs: ContentInput[] = ['one', custom, { type: 'text', text: 'three' }];
    expect(await resolveContents(inputs)).toEqual([
      { type: 'text', text: 'one' }, { type: 'text', text: 'custom' }, { type: 'text', text: 'three' },
    ]);
  });

  it.each(['group', 'reply', 'edit'] as const)('executes a self-returning child builder once inside %s', async kind => {
    // resolve.ts invokes each supplied builder once; parent builders have
    // already resolved their children before returning the built value.
    let builds = 0;
    const upload = {
      type: 'attachment' as const,
      id: 'file', name: 'x', mimeType: 'text/plain',
      read: async () => new Uint8Array(),
      stream: async () => new ReadableStream<Uint8Array>(),
      async build() { builds++; return this; },
    };
    const parent = kind === 'group' ? group('caption', upload)
      : kind === 'reply' ? reply(upload, message('inbound'))
        : edit(upload, message('outbound'));
    const built = await resolveContent(parent);
    expect(builds).toBe(1);
    const child = built.type === 'group' ? built.items[1]?.content
      : built.type === 'reply' || built.type === 'edit' ? built.content : undefined;
    expect(child).toBe(upload);
  });

  it('still resolves builders inside legacy plain group inputs', async () => {
    let builds = 0;
    const child: ContentBuilder = { build: async () => {
      builds++;
      return { type: 'text', text: 'child' };
    } };
    expect(await resolveContent({ type: 'group', items: ['caption', child] })).toEqual({
      type: 'group', items: [
        { id: '', content: { type: 'text', text: 'caption' } },
        { id: '', content: { type: 'text', text: 'child' } },
      ],
    });
    expect(builds).toBe(1);
  });

  it('validates built children rather than executing or accepting malformed nested builders', async () => {
    let builds = 0;
    const invalid = { build: async () => {
      builds++;
      return { type: 'text', text: 'should not execute' };
    } };
    const values = [
      { type: 'group', items: [{ id: '', content: invalid }, { id: '', content: { type: 'text', text: 'hi' } }] },
      { type: 'reply', target: message('inbound'), content: invalid },
      { type: 'edit', target: message('outbound'), content: invalid },
    ];
    for (const value of values) {
      await expect(resolveContent({ build: async () => value } as unknown as ContentBuilder)).rejects.toThrow('Content value');
    }
    expect(builds).toBe(0);
    await expect(resolveContent({ build: async () => ({
      type: 'group', items: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    }) } as unknown as ContentBuilder)).rejects.toThrow('Message stubs');
  });

  it('builds upstream group message stubs without losing byte sources', async () => {
    const file = attachment(new Uint8Array([0, 255]), { name: 'photo.png', mimeType: 'image/png' });
    const built = await group('caption', file).build();
    expect(built.type).toBe('group');
    expect(built.items).toEqual([
      { id: '', content: { type: 'text', text: 'caption' } }, { id: '', content: file },
    ]);
    expect(await file.read()).toEqual(new Uint8Array([0, 255]));
    expect(await resolveContent(group(text('caption'), file))).toEqual(built);
    expect(() => group('one')).toThrow('two');
    await expect(group('one', group('two', 'three')).build()).rejects.toThrow('cannot contain "group"');
    await expect(group('one', reaction('👍', message('inbound'))).build()).rejects.toThrow('cannot contain "reaction"');
  });

  it('keeps URL downloads lazy and owned by the app, not build or read', async () => {
    const input = new URL('https://example.com/photo.png');
    const file = attachment(input);
    const built = await file.build();
    expect(built).toBe(file);
    expect(attachmentUrl(built)?.href).toBe(input.href);
    expect(attachmentUrl(await resolveContent(file) as typeof built)?.href).toBe(input.href);
    const grouped = await resolveContent(group('caption', file));
    expect(grouped.type === 'group' && grouped.items[1]?.content).toBe(file);
    const wrapped = await resolveContent(reply(file, message('inbound')));
    expect(wrapped.type === 'reply' && wrapped.content).toBe(file);
    expect(attachmentUrl(file)?.href).toBe(input.href);
    await expect(file.read()).rejects.toThrow('app can cancel');
    await expect(file.stream()).rejects.toThrow('app can cancel');
    expect(() => attachment('/local/file')).toThrow('Filesystem');
    expect(() => attachment('https://example.com/file')).toThrow('new URL');
  });

  it('uses Web bytes and Blob metadata with no MIME lookup dependency', async () => {
    const bytes = new Uint8Array([1, 2]);
    const file = attachment(bytes, { id: 'local-id', name: 'test.bin' });
    bytes[0] = 99;
    expect(await file.read()).toEqual(new Uint8Array([1, 2]));
    (await file.read())[0] = 88;
    expect(await file.read()).toEqual(new Uint8Array([1, 2]));
    expect(file.id).toBe('local-id');
    expect(file.mimeType).toBe('application/octet-stream');
    const blob = await attachment(new Blob(['hi'], { type: 'text/plain' })).build();
    expect(blob.mimeType).toBe('text/plain');
    expect(blob.size).toBe(2);
    expect(blob.id).not.toBe('');
    expect(await new Response(await blob.stream()).text()).toBe('hi');
  });

  it('rejects empty attachment ids at build and outbound resolution boundaries', async () => {
    // attachment.ts attachmentSchema requires a nonempty id, including explicit options.id.
    const invalid = attachment(new Uint8Array(), { id: '' });
    await expect(invalid.build()).rejects.toThrow('nonempty id');
    await expect(resolveContent(invalid)).rejects.toThrow('nonempty id');
    await expect(resolveContent({ ...invalid })).rejects.toThrow('nonempty id');
  });

  it.each([
    { name: 123 }, { name: '' }, { mimeType: 123 }, { mimeType: '' },
    { id: 123 }, { size: -1 }, { size: 1.5 }, { size: Number.NaN }, { size: '1' },
  ])('rejects malformed structural attachment metadata %j', async override => {
    const valid = attachment(new Uint8Array(), { name: 'x', mimeType: 'text/plain' });
    const malformed = { ...valid, ...override };
    await expect(resolveContent(malformed as unknown as ContentInput)).rejects.toThrow('Invalid attachment content');
    await expect(resolveContent({ build: async () => malformed } as unknown as ContentBuilder)).rejects.toThrow('Invalid attachment content');
  });
});

describe('Spectrum action builders', () => {
  it('builds read/unsend values with target identity and enforces direction', async () => {
    const inbound = message('inbound');
    const outbound = message('outbound');
    expect((await read(inbound).build()).target).toBe(inbound);
    expect((await unsend(outbound).build()).target).toBe(outbound);
    await expect(read(outbound).build()).rejects.toThrow('must be an inbound message');
    await expect(unsend(inbound).build()).rejects.toThrow('must be an outbound message');
    await expect(unsend(undefined).build()).rejects.toThrow('unsend() target is undefined');
  });

  it('cannot wrap read/unsend signals in replies or edits (upstream regression scenarios)', async () => {
    for (const inner of [read(message('inbound')), unsend(message('outbound'))]) {
      const type = (await inner.build()).type;
      await expect(reply(inner, message('inbound')).build()).rejects.toThrow(`reply() cannot wrap "${type}"`);
      await expect(edit(inner, message('outbound')).build()).rejects.toThrow(`edit() cannot wrap "${type}"`);
    }
  });

  it('builds typing start/stop with the upstream state field', async () => {
    expect(await typing().build()).toEqual({ type: 'typing', state: 'start' });
    expect(await typing('stop').build()).toEqual({ type: 'typing', state: 'stop' });
  });

  it('builds reply/edit wrappers and reaction targets without replacing references', async () => {
    const inbound = message('inbound');
    const outbound = message('outbound');
    expect(await reply('answer', inbound).build()).toEqual({
      type: 'reply', content: { type: 'text', text: 'answer' }, target: inbound,
    });
    expect((await reply('answer', inbound).build()).target).toBe(inbound);
    expect(await edit(text('updated'), outbound).build()).toEqual({
      type: 'edit', content: { type: 'text', text: 'updated' }, target: outbound,
    });
    expect(await reaction('👍', inbound).build()).toEqual({ type: 'reaction', emoji: '👍', target: inbound });
    expect((await resolveContent(reaction('👍', inbound)) as { target: ContentTarget }).target).toBe(inbound);
    await expect(edit('updated', inbound).build()).rejects.toThrow('outbound');
    await expect(reply('answer', undefined).build()).rejects.toThrow('reply() target is undefined');
    await expect(reaction('👍', undefined).build()).rejects.toThrow('reaction() target is undefined');
    await expect(reaction('', inbound).build()).rejects.toThrow('empty');
    await expect(reaction('👍', { ...inbound, content: { type: 'reaction' } }).build()).rejects.toThrow('cannot target "reaction"');
    await expect(reply(typing(), inbound).build()).rejects.toThrow('cannot wrap "typing"');
    await expect(edit(group('a', 'b'), outbound).build()).rejects.toThrow('cannot wrap "group"');
  });

  it('rejects unsupported families from structural builders explicitly', async () => {
    // External JavaScript builders can return families outside this scoped Web adapter.
    const unsupported = { build: async () => ({ type: 'markdown', text: '**hi**' }) };
    await expect(resolveContent(unsupported as unknown as ContentBuilder)).rejects.toThrow('Unsupported content type "markdown"');
    await expect(resolveContent({ build: async () => null } as unknown as ContentBuilder)).rejects.toThrow('Content value');
  });
});
