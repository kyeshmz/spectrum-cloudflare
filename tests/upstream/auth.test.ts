/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/auth.test.ts
 * Public facade replaces startClients/refresh/disposeCloudAuth; demand-driven clock advance
 * replaces scheduled renewal callbacks. Original inventory scenarios/phone inputs retained.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpectrum } from '@spectrum-cloudflare/imessage';
import { runtimeGrpcPeer, type RuntimeCall } from '../fixtures/runtime-grpc-peer.js';

afterEach(() => vi.useRealTimers());
type Inventory = { type: 'dedicated'; auth: Record<string, string>; numbers: Record<string, string | null>; expiresIn: number }
  | { type: 'shared'; token: string; expiresIn: number };
const dedicated = (numbers: Record<string, string | null>): Extract<Inventory, { type: 'dedicated' }> => ({ type: 'dedicated', numbers,
  auth: Object.fromEntries(Object.keys(numbers).map(id => [id, `token-${id}`])), expiresIn: 1 });
async function startClients(initial: Inventory) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  let data = initial;
  let mints = 0;
  const calls: RuntimeCall[] = [];
  const app = await createSpectrum({ projectId: 'project', projectSecret: 'secret', fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'spectrum.photon.codes') {
      mints++;
      return Response.json({ succeed: true, data });
    }
    return runtimeGrpcPeer(request, { observe: call => calls.push(call) });
  } });
  return { app, calls, mints: () => mints, refresh: (next: Inventory) => { data = next; vi.setSystemTime(Date.now() + 801); } };
}

describe('cloud auth inventories (upstream)', () => {
  it('skips a line without a phone number instead of failing startup', async () => {
    const { app, calls } = await startClients(dedicated({ 'instance-1': null }));
    try { await expect(app.rpc()).rejects.toThrow(); expect(calls).toEqual([]); }
    finally { await app.close(); }
  });
  it('picks up a line once its number is assigned', async () => {
    const { app, refresh } = await startClients(dedicated({ 'instance-1': null }));
    try { refresh(dedicated({ 'instance-1': '+15550000001' })); await expect(app.rpc('+15550000001')).resolves.toHaveProperty('messages'); }
    finally { await app.close(); }
  });
  it('keeps a known line usable when it loses its number mid-refresh', async () => {
    const { app, refresh, mints, calls } = await startClients(dedicated({ 'instance-1': '+15550000001' }));
    try {
      const client = await app.rpc('+15550000001');
      refresh({ ...dedicated({ 'instance-1': null }), auth: { 'instance-1': 'renewed-token' } });
      expect(await app.rpc('+15550000001')).toBe(client);
      await client.chats.markChatRead({ chatGuid: 's1' });
      expect(calls[0]?.authorization).toBe('Bearer renewed-token');
      const count = mints(); await app.rpc('+15550000001'); expect(mints()).toBe(count);
    } finally { await app.close(); }
  });
  it('attaches a line provisioned after startup', async () => {
    const { app, refresh, calls } = await startClients(dedicated({ 'instance-1': '+15550000001' }));
    try {
      refresh(dedicated({ 'instance-1': '+15550000001', 'instance-2': '+15550000002' }));
      await (await app.rpc('+15550000002')).chats.markChatRead({ chatGuid: 's1' });
      expect(calls[0]?.authorization).toBe('Bearer token-instance-2');
    } finally { await app.close(); }
  });
  it('detaches a deprovisioned line and closes its channel', async () => {
    const { app, refresh } = await startClients(dedicated({ 'instance-1': '+15550000001', 'instance-2': '+15550000002' }));
    try {
      const removed = await app.rpc('+15550000002');
      refresh(dedicated({ 'instance-1': '+15550000001' })); await app.rpc('+15550000001');
      await expect(removed.chats.markChatRead({ chatGuid: 's1' })).rejects.toThrow();
      await expect(app.rpc('+15550000002')).rejects.toThrow();
    } finally { await app.close(); }
  });
  it('removes every line when the response reports no lines', async () => {
    const { app, refresh } = await startClients(dedicated({ 'instance-1': '+15550000001' }));
    try { refresh(dedicated({})); await expect(app.rpc()).rejects.toThrow(); }
    finally { await app.close(); }
  });
  it('leaves shared mode untouched across a refresh', async () => {
    const { app, refresh, calls } = await startClients({ type: 'shared', token: 'shared-1', expiresIn: 1 });
    try {
      const client = await app.rpc();
      refresh({ type: 'shared', token: 'shared-2', expiresIn: 1 });
      expect(await app.rpc()).toBe(client);
      await client.chats.markChatRead({ chatGuid: 's1' });
      expect(calls[0]?.authorization).toBe('Bearer shared-2');
    } finally { await app.close(); }
  });
  it('uses the startup signal only for the initial token request', async () => {
    const controller = new AbortController();
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', signal: controller.signal,
      fetch: async () => Response.json({ succeed: true, data: { type: 'shared', token: 'shared', expiresIn: 1 } }) });
    try { controller.abort(); await expect(app.rpc()).resolves.toHaveProperty('messages'); }
    finally { await app.close(); }
  });
});
