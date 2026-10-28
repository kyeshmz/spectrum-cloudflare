import { SpectrumApi } from './api.js';
import { createIMessageRpc, type IMessageRpc } from './grpc.js';
import { ProviderDownloads } from './runtime-downloads.js';

export const SHARED_PHONE = 'shared';

export interface ExplicitSpectrumLine {
  readonly baseUrl: string;
  readonly token: string | ((signal?: AbortSignal) => Promise<string>);
  readonly phone: string;
}

export interface SpectrumLineOptions {
  readonly api: SpectrumApi;
  readonly clients?: readonly ExplicitSpectrumLine[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly sharedBaseUrl?: string;
}

interface Line {
  readonly mode: 'shared' | 'dedicated';
  readonly phone: string;
  readonly baseUrl: string;
  readonly rpc: IMessageRpc;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTokens(value: unknown) {
  if (!record(value) || typeof value.expiresIn !== 'number' || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0) {
    throw new Error('Invalid Spectrum token payload: expected a positive finite expiresIn');
  }
  if (value.type === 'shared' && typeof value.token === 'string' && value.token) {
    return { type: 'shared' as const, expiresIn: value.expiresIn, entries: [{ key: SHARED_PHONE, phone: SHARED_PHONE, token: value.token }] };
  }
  if (value.type !== 'dedicated' || !record(value.auth) || !record(value.numbers)) {
    throw new Error('Invalid Spectrum token payload: expected shared or dedicated credentials');
  }
  const entries: { key: string; phone: string; token: string }[] = [];
  const phones = new Set<string>();
  for (const [key, token] of Object.entries(value.auth)) {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(key) || typeof token !== 'string' || !token) {
      throw new Error('Invalid dedicated iMessage instance credentials');
    }
    const phone = value.numbers[key];
    if (phone === null || phone === undefined) {
      continue;
    }
    if (typeof phone !== 'string' || !phone) {
      throw new Error('Invalid dedicated iMessage phone number');
    }
    if (phones.has(phone)) {
      throw new Error('Invalid dedicated iMessage inventory: duplicate phone number');
    }
    phones.add(phone);
    entries.push({ key, phone, token });
  }
  return { type: 'dedicated' as const, expiresIn: value.expiresIn, entries };
}

/** Owns credentials, native RPC clients, cancellation, and all app-scoped downloads. */
export class SpectrumLines {
  readonly downloads = new ProviderDownloads();
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private lines: Line[] = [];
  private credentials = new Map<string, string>();
  private refreshAt = 0;
  private refreshing: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly retired = new Set<Promise<void>>();
  private readonly retirementErrors: unknown[] = [];

  private constructor(private readonly options: SpectrumLineOptions) {
    this.signal = this.lifetime.signal;
  }

  static async create(options: SpectrumLineOptions, signal?: AbortSignal): Promise<SpectrumLines> {
    signal?.throwIfAborted();
    const pool = new SpectrumLines(options);
    try {
      if (options.clients) {
        if (options.clients.length === 0) {
          throw new Error('clients must contain at least one iMessage line');
        }
        const phones = new Set<string>();
        for (const entry of options.clients) {
          if (!entry.phone || phones.has(entry.phone)) {
            throw new Error('Explicit iMessage line phones must be nonempty and unique');
          }
          phones.add(entry.phone);
          pool.lines.push({ mode: entry.phone === SHARED_PHONE ? 'shared' : 'dedicated', phone: entry.phone, baseUrl: entry.baseUrl, rpc: createIMessageRpc({
            baseUrl: entry.baseUrl,
            token: entry.token,
            signal: pool.signal,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          }) });
        }
        if (phones.has(SHARED_PHONE) && phones.size > 1) {
          throw new Error('Shared iMessage identity cannot be mixed with dedicated lines');
        }
      } else {
        await pool.refresh(signal);
      }
      signal?.throwIfAborted();
      return pool;
    } catch (error) {
      try {
        await pool.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Spectrum initialization and cleanup failed');
      }
      throw error;
    }
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error('Spectrum app has been closed');
    }
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    if (this.options.clients || Date.now() < this.refreshAt) {
      return;
    }
    if (!this.refreshing) {
      // A mint belongs to the pool, not to whichever RPC first needs it.
      // Its cleanup must run even if that RPC stops waiting independently.
      const started = this.mint();
      this.refreshing = started;
      const clear = () => {
        if (this.refreshing === started) {
          this.refreshing = undefined;
        }
      };
      void started.then(clear, clear);
    }
    const task = this.refreshing;
    if (!signal) {
      await task;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void task.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      if (signal.aborted) {
        abort();
      }
    });
  }

  private async mint(): Promise<void> {
    const data = parseTokens(await this.options.api.request('POST', '/projects/{projectId}/imessage/tokens', {
      signal: this.signal,
    }));
    this.assertOpen();
    const next = data.entries.map(entry => {
      const baseUrl = data.type === 'shared'
        ? this.options.sharedBaseUrl ?? 'https://imessage.spectrum.photon.codes'
        : `https://${entry.key}.imsg.photon.codes`;
      const existing = this.lines.find(line => line.mode === data.type && line.phone === entry.phone && line.baseUrl === baseUrl);
      if (existing) {
        return existing;
      }
      const credentialKey = `${data.type}:${entry.key}`;
      return { mode: data.type, phone: entry.phone, baseUrl, rpc: createIMessageRpc({
        baseUrl,
        signal: this.signal,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        token: async (callSignal) => {
          await this.refresh(callSignal);
          this.assertOpen();
          const token = this.credentials.get(credentialKey);
          if (!token) {
            throw new Error('iMessage line has been removed from this project');
          }
          return token;
        },
      }) };
    });
    const removed = this.lines.filter(line => !next.includes(line));
    this.credentials = new Map(data.entries.map(entry => [`${data.type}:${entry.key}`, entry.token]));
    this.lines = next;
    this.refreshAt = Date.now() + data.expiresIn * 800;
    for (const line of removed) {
      const retirement = Promise.resolve(line.rpc.close());
      this.retired.add(retirement);
      void retirement.catch(error => {
        this.retirementErrors.push(error);
      }).finally(() => {
        this.retired.delete(retirement);
      });
    }
  }

  async select(phone?: string): Promise<Line> {
    await this.refresh();
    this.assertOpen();
    if (this.lines.length === 0) {
      throw new Error('No active iMessage lines have assigned phone numbers');
    }
    if (this.lines.length === 1 && this.lines[0]!.mode === 'shared') {
      return this.lines[0]!;
    }
    if (!phone && this.lines.length > 1) {
      throw new Error('Specify phone when multiple dedicated iMessage lines are configured');
    }
    const line = phone ? this.lines.find(candidate => candidate.phone === phone) : this.lines[0];
    if (!line) {
      throw new Error(`No iMessage line serves phone ${phone}`);
    }
    return line;
  }

  async forCreate(phone?: string): Promise<Line> {
    await this.refresh();
    if (phone || this.lines.length <= 1) {
      return this.select(phone);
    }
    this.assertOpen();
    return this.lines[Math.floor(Math.random() * this.lines.length)]!;
  }

  async run<T>(phone: string | undefined, operation: (rpc: IMessageRpc) => Promise<T>): Promise<T> {
    this.assertOpen();
    const task = (async () => operation((await this.select(phone)).rpc))();
    this.operations.add(task);
    try {
      return await task;
    } finally {
      this.operations.delete(task);
    }
  }

  close(): Promise<void> {
    this.stopping ??= this.closeAll();
    return this.stopping;
  }

  private async closeAll(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error('Spectrum app closed'));
    const cancellations = Promise.allSettled([
      this.downloads.close(),
      ...this.lines.map(line => Promise.resolve(line.rpc.close())),
      ...this.retired,
    ]);
    if (this.refreshing) {
      await this.refreshing.catch(() => undefined);
    }
    await Promise.allSettled([...this.operations]);
    const results = await cancellations;
    this.lines = [];
    this.credentials.clear();
    const failures = [...this.retirementErrors, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])];
    if (failures.length) {
      throw new AggregateError(failures, 'Spectrum app cleanup failed');
    }
  }
}
