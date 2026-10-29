/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/space.test.ts
 * Original titles/addresses/refs retained; provider ctx -> facade, SDK mock -> gRPC-Web.
 */
import { describe, expect, it } from 'vitest';
import { upstreamApp } from './upstream-peer.js';

describe('imessage space.create (upstream)', () => {
  it('shared mode: builds the deterministic DM guid without an API call', async () => {
    const { app, calls } = await upstreamApp();
    try {
      expect(await app.createSpace('+15550123')).toMatchObject({ id: 'any;-;+15550123', type: 'dm', phone: 'shared' });
      expect(calls).toEqual([]);
    } finally { await app.close(); }
  });
  it('shared mode: cannot create group chats', async () => {
    const { app, calls } = await upstreamApp();
    try {
      await expect(app.createSpace(['a@x.com', 'b@x.com'])).rejects.toThrow(/Shared.*cannot create group chats/);
      expect(calls).toEqual([]);
    } finally { await app.close(); }
  });
  it.each([
    ['dedicated mode: creates a DM through the API and uses the server guid', ['+15550123'], 'any;-;+15550123', 'dm'],
    ['dedicated mode: creates a group through the API and uses the server guid', ['a@x.com', 'b@x.com'], 'iMessage;+;chat42', 'group'],
  ] as const)('%s', async (_title, peers, id, type) => {
    const { app, calls } = await upstreamApp(['+15550100'], { CreateChat: { chat: { guid: id, isGroup: type === 'group' } } });
    try {
      expect(await app.createSpace(peers)).toMatchObject({ id, type, phone: '+15550100' });
      expect(calls[0]?.input.addresses).toEqual(peers);
    } finally { await app.close(); }
  });
  it('dedicated mode: routes creation to the client owning params.phone', async () => {
    const { app, calls } = await upstreamApp(['+15550100', '+15550111'], { CreateChat: { chat: { guid: 'iMessage;+;chat7', isGroup: true } } });
    try {
      expect(await app.createSpace(['a@x.com', 'b@x.com'], { phone: '+15550111' })).toMatchObject({ id: 'iMessage;+;chat7', type: 'group', phone: '+15550111' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.authorization).toBe('Bearer token-1');
    } finally { await app.close(); }
  });
});

describe('imessage space.get (upstream)', () => {
  it.each([
    ['constructs the space offline, deriving dm type from the guid shape', 'any;-;+15550123', 'dm'],
    ['derives group type from the `;+;` guid separator', 'iMessage;+;chat42', 'group'],
  ] as const)('%s', async (_title, id, type) => {
    const { app, calls } = await upstreamApp();
    try { expect(app.space(id)).toMatchObject({ id, type }); expect(calls).toEqual([]); }
    finally { await app.close(); }
  });
  it('tags the space with params.phone when provided', async () => {
    const { app } = await upstreamApp(['+15550100', '+15550111']);
    try { expect(app.space('any;-;a@x.com', { phone: '+15550111' })).toMatchObject({ id: 'any;-;a@x.com', type: 'dm', phone: '+15550111' }); }
    finally { await app.close(); }
  });
  it('requires params.phone when multiple clients are configured', async () => {
    const { app } = await upstreamApp(['+15550100', '+15550111']);
    // Facade resolves the line on I/O, not offline construction.
    try { await expect(app.space('any;-;x').send('hi')).rejects.toThrow(/phone/); }
    finally { await app.close(); }
  });
});
