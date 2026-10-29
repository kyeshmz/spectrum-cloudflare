import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpectrum } from '@spectrum-cloudflare/imessage';
import { runtimeGrpcPeer, type RuntimeCall } from './fixtures/runtime-grpc-peer.js';
import { Code } from '@connectrpc/connect';

afterEach(() => vi.useRealTimers());

describe('demand-driven native line inventory', () => {
  it('uses UTF-8 Basic management auth and default native hosts with bounded singleflight refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00Z'));
    let mints = 0;
    const calls: RuntimeCall[] = [];
    const app = await createSpectrum({ projectId: 'project', projectSecret: '密',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === 'spectrum.photon.codes') {
          expect(request.headers.get('authorization')).toBe(`Basic ${Buffer.from('project:密').toString('base64')}`);
          mints++;
          return Response.json({ succeed: true, data: { type: 'dedicated', auth: { instance: `token-${mints}` }, numbers: { instance: '+15550001111' }, expiresIn: 10 } });
        }
        return runtimeGrpcPeer(request, { observe: call => calls.push(call) });
      },
    });
    try {
      await Promise.all(Array.from({ length: 5 }, () => app.rpc()));
      expect(mints).toBe(1);
      await app.space('any;-;peer').send('hello');
      expect(calls[0]).toMatchObject({ authorization: 'Bearer token-1', routing: null });
      expect(new URL(calls[0]!.url).hostname).toBe('instance.imsg.photon.codes');
      vi.advanceTimersByTime(8_001);
      expect(mints).toBe(1);
      await Promise.all(Array.from({ length: 5 }, () => app.rpc()));
      expect(mints).toBe(2);
      await app.space('any;-;peer').send('again');
      expect(calls[1]?.authorization).toBe('Bearer token-2');
    } finally { await app.close(); }
    await expect(app.rpc()).rejects.toThrow('closed');
  });

  it('does not poison refresh after a failed management request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let mints = 0;
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', fetch: async () => {
      mints++;
      if (mints === 2) return new Response('failure', { status: 503 });
      return Response.json({ succeed: true, data: { type: 'shared', token: 'line', expiresIn: 1 } });
    } });
    try {
      vi.advanceTimersByTime(801);
      await expect(app.rpc()).rejects.toThrow('503');
      await expect(app.rpc()).resolves.toHaveProperty('messages');
      expect(mints).toBe(3);
    } finally { await app.close(); }
  });

  it('rejects ambiguous lines and mixed shared inventories', async () => {
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', clients: [
      { baseUrl: 'https://one.test', token: 'a', phone: '+1' },
      { baseUrl: 'https://two.test', token: 'b', phone: '+2' },
    ] });
    try {
      await expect(app.rpc()).rejects.toThrow('phone');
      await expect(app.rpc('+2')).resolves.toHaveProperty('messages');
    } finally { await app.close(); }
    await expect(createSpectrum({ projectId: 'p', projectSecret: 's', clients: [
      { baseUrl: 'https://one.test', token: 'a', phone: 'shared' },
      { baseUrl: 'https://two.test', token: 'b', phone: '+2' },
    ] })).rejects.toThrow('mixed');
  });

  it('does not initialize network I/O for an aborted request', async () => {
    const fetch = vi.fn();
    await expect(createSpectrum({ projectId: 'p', projectSecret: 's', fetch,
      signal: AbortSignal.abort(new Error('request cancelled')) })).rejects.toThrow('request cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates untrusted token payloads and dedicated instance hostname labels', async () => {
    for (const data of [
      { type: 'shared', token: '', expiresIn: 60 },
      { type: 'shared', token: 'x', expiresIn: 0 },
      { type: 'dedicated', auth: { 'evil.test/path': 'token' }, numbers: { 'evil.test/path': '+1' }, expiresIn: 60 },
    ]) {
      await expect(createSpectrum({ projectId: 'p', projectSecret: 's', fetch: async () => Response.json({ succeed: true, data }) })).rejects.toThrow(/Invalid/);
    }
  });

  it('does not let the first RPC cancel a shared token refresh needed by another RPC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let mints = 0;
    let refreshSignal: AbortSignal | undefined;
    let releaseRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    const calls: RuntimeCall[] = [];
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === 'spectrum.photon.codes') {
        mints++;
        if (mints === 2) {
          refreshSignal = request.signal;
          refreshStarted();
          return new Promise<Response>((resolve, reject) => {
            releaseRefresh = resolve;
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
        }
        return Response.json({ succeed: true, data: { type: 'shared', token: 'initial-token', expiresIn: 1 } });
      }
      return runtimeGrpcPeer(request, { observe: call => calls.push(call) });
    } });
    try {
      // Reuse a borrowed native client so refresh starts inside the auth callback,
      // not through the facade's line-selection path.
      const rpc = await app.rpc();
      vi.setSystemTime(801);
      const caller = new AbortController();
      const first = rpc.chats.markChatRead({ chatGuid: 'any;-;peer' }, { signal: caller.signal })
        .then(() => undefined, error => error);
      await started;
      const second = rpc.chats.markChatRead({ chatGuid: 'any;-;peer' });
      caller.abort(new Error('first caller cancelled'));
      expect(await first).toMatchObject({ code: Code.Canceled });
      expect(refreshSignal?.aborted).toBe(false);
      expect(mints).toBe(2);
      releaseRefresh(Response.json({ succeed: true, data: { type: 'shared', token: 'fresh-token', expiresIn: 60 } }));
      await expect(second).resolves.toMatchObject({ $typeName: 'google.protobuf.Empty' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.authorization).toBe('Bearer fresh-token');
      expect(refreshSignal?.aborted).toBe(false);
    } finally { await app.close(); }
  });

  it('cancels a blocked initialization mint through pool cleanup when its initializer aborts', async () => {
    const controller = new AbortController();
    let mintSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const creating = createSpectrum({ projectId: 'p', projectSecret: 's', signal: controller.signal,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        mintSignal = request.signal;
        entered();
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      },
    }).then(() => undefined, error => error);
    await started;
    controller.abort(new Error('initializer cancelled'));
    expect(String(await creating)).toContain('initializer cancelled');
    expect(mintSignal?.aborted).toBe(true);
  });

  it('retains only authenticated known instances when phone assignments disappear', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let auth = { known: 'initial-token' } as Record<string, string>;
    let numbers = { known: '+15550000001' } as Record<string, string | null>;
    const calls: RuntimeCall[] = [];
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === 'spectrum.photon.codes') {
        return Response.json({ succeed: true, data: { type: 'dedicated', auth, numbers, expiresIn: 1 } });
      }
      return runtimeGrpcPeer(request, { observe: call => calls.push(call) });
    } });
    try {
      const client = await app.rpc('+15550000001');
      auth = { known: 'renewed-token', unassigned: 'unused-token' };
      numbers = { unassigned: null };
      vi.setSystemTime(801);
      expect(await app.rpc()).toBe(client);
      await client.chats.markChatRead({ chatGuid: 's1' });
      expect(calls[0]?.authorization).toBe('Bearer renewed-token');
      // A stale number alone cannot keep an instance whose auth disappeared.
      auth = { unassigned: 'unused-token' };
      numbers = { known: '+15550000001', unassigned: null };
      vi.setSystemTime(1602);
      await expect(app.rpc('+15550000001')).rejects.toThrow('No active');
      await expect(client.chats.markChatRead({ chatGuid: 's1' })).rejects.toMatchObject({ code: Code.Canceled });
      expect(calls).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('rejects duplicate phone assignments after known-number fallback without committing the inventory', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let numbers: Record<string, string | null> = { first: '+15550000001', second: '+15550000002' };
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', fetch: async () => Response.json({
      succeed: true, data: { type: 'dedicated', auth: { first: 'a', second: 'b' }, numbers, expiresIn: 1 },
    }) });
    try {
      const first = await app.rpc('+15550000001');
      const second = await app.rpc('+15550000002');
      numbers = { first: null, second: '+15550000001' };
      vi.setSystemTime(801);
      await expect(app.rpc('+15550000001')).rejects.toThrow('duplicate phone');
      numbers = { first: null, second: '+15550000002' };
      expect(await app.rpc('+15550000001')).toBe(first);
      expect(await app.rpc('+15550000002')).toBe(second);
    } finally { await app.close(); }
  });

  it('routes a dedicated instance named shared by its discriminator and safely reconciles both transitions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let mints = 0;
    const calls: RuntimeCall[] = [];
    const app = await createSpectrum({ projectId: 'p', projectSecret: 's', fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === 'spectrum.photon.codes') {
        mints++;
        const data = mints === 2
          ? { type: 'dedicated', auth: { shared: 'dedicated-token' }, numbers: { shared: '+15550001111' }, expiresIn: 1 }
          : { type: 'shared', token: `shared-token-${mints}`, expiresIn: 1 };
        return Response.json({ succeed: true, data });
      }
      return runtimeGrpcPeer(request, { observe: call => calls.push(call) });
    } });
    try {
      const originalShared = await app.rpc();
      await originalShared.chats.markChatRead({ chatGuid: 'any;-;peer' });
      vi.setSystemTime(801);
      const dedicated = await app.rpc('+15550001111');
      await dedicated.chats.markChatRead({ chatGuid: 'any;-;peer' });
      await expect(originalShared.chats.markChatRead({ chatGuid: 'any;-;peer' })).rejects.toMatchObject({ code: Code.Canceled });
      vi.setSystemTime(1602);
      const sharedAgain = await app.rpc();
      await sharedAgain.chats.markChatRead({ chatGuid: 'any;-;peer' });
      await expect(dedicated.chats.markChatRead({ chatGuid: 'any;-;peer' })).rejects.toMatchObject({ code: Code.Canceled });
      expect(calls.map(call => new URL(call.url).hostname)).toEqual([
        'imessage.spectrum.photon.codes', 'shared.imsg.photon.codes', 'imessage.spectrum.photon.codes',
      ]);
      expect(calls.map(call => call.authorization)).toEqual([
        'Bearer shared-token-1', 'Bearer dedicated-token', 'Bearer shared-token-3',
      ]);
      expect(mints).toBe(3);
    } finally { await app.close(); }
  });
});
