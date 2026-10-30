import { SpectrumApp, type SpectrumRuntimeOptions } from './runtime.js';
import type { AttachmentContent } from './runtime-content.js';
import type { ProjectData, SpectrumMessage, SpectrumSpace, SpectrumUser } from './runtime-types.js';
import type { ExplicitSpectrumLine } from './runtime-lines.js';

const registration = Symbol('spectrum-cloudflare.imessage');

export interface IMessageClientConfig {
  readonly address: string;
  readonly token: string;
  readonly phone: string;
}

export interface IMessageConfig {
  readonly clients?: IMessageClientConfig | readonly IMessageClientConfig[];
}

/** A registration descriptor, not an upstream custom-provider definition. */
export interface IMessageProviderConfig {
  readonly [registration]: true;
  readonly config: IMessageConfig;
}

export interface IMessageProvider {
  readonly messages: AsyncIterable<[SpectrumSpace, SpectrumMessage]>;
  readonly space: {
    get(id: string, params?: { phone?: string }): Promise<SpectrumSpace>;
    create(users: string | Pick<SpectrumUser, 'id'> | (string | Pick<SpectrumUser, 'id'>)[], params?: { phone?: string }): Promise<SpectrumSpace>;
  };
  user(id: string): Promise<SpectrumUser>;
  getMessage(space: SpectrumSpace, id: string): Promise<SpectrumMessage | undefined>;
  getAttachment(guid: string, phone?: string): Promise<AttachmentContent | undefined>;
}

type ProjectCredentials = { projectId: string; projectSecret: string } | { projectId?: never; projectSecret?: never };

export type SpectrumOptions = Omit<SpectrumRuntimeOptions, 'clients' | 'projectId' | 'projectSecret'> & ProjectCredentials & {
  readonly providers: readonly IMessageProviderConfig[];
  readonly webhookSecret?: string;
};

function explicitClients(config: IMessageConfig): ExplicitSpectrumLine[] | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Invalid imessage configuration');
  for (const key of Object.keys(config)) {
    if (key !== 'clients') throw new TypeError(`Unsupported imessage configuration option: ${key}`);
  }
  if (config.clients === undefined) return undefined;
  const entries = Array.isArray(config.clients) ? config.clients : [config.clients];
  if (!entries.length) throw new TypeError('clients must contain at least one iMessage line');
  const phones = new Set<string>();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new TypeError('Invalid imessage client');
    for (const key of Object.keys(entry)) {
      if (key !== 'address' && key !== 'token' && key !== 'phone') throw new TypeError(`Unsupported imessage client option: ${key}`);
    }
    if (typeof entry.address !== 'string' || !entry.address || typeof entry.token !== 'string' || !entry.token
      || typeof entry.phone !== 'string' || !entry.phone) throw new TypeError('imessage clients require address, token and phone');
    // Host:port addresses from the native SDK are TLS origins in the Web client.
    const baseUrl = entry.address.includes('://') ? entry.address : `https://${entry.address}`;
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new TypeError('imessage client address must be an HTTPS URL or TLS host');
    }
    if (phones.has(entry.phone)) throw new TypeError('Explicit iMessage line phones must be unique');
    phones.add(entry.phone);
    return { baseUrl, token: entry.token, phone: entry.phone };
  });
}

export function Spectrum(options: SpectrumOptions & { projectId: string; projectSecret: string }): Promise<SpectrumApp & { readonly config: ProjectData }>;
export function Spectrum(options: SpectrumOptions): Promise<SpectrumApp>;
export async function Spectrum(options: SpectrumOptions): Promise<SpectrumApp> {
  options.signal?.throwIfAborted();
  const supported = new Set(['providers', 'projectId', 'projectSecret', 'webhookSecret', 'signal', 'baseUrl', 'fetch', 'timeoutMs', 'sharedBaseUrl', 'webhook']);
  for (const key of Object.keys(options)) {
    if (!supported.has(key)) throw new TypeError(`Unsupported Spectrum option: ${key}`);
  }
  if (!Array.isArray(options.providers)) throw new TypeError('Spectrum requires providers: [imessage.config()]');
  if (options.providers.length > 1) {
    throw new TypeError('Spectrum received multiple providers for platform "imessage". Register exactly one provider per platform.');
  }
  const provider = options.providers[0];
  if (!provider || provider[registration] !== true) throw new TypeError('Only imessage.config() providers are supported');
  const clients = explicitClients(provider.config);
  if ((options.projectId === undefined) !== (options.projectSecret === undefined)) {
    throw new TypeError('projectId and projectSecret must be provided together');
  }
  if (!clients && !options.projectId) throw new TypeError('Cloud iMessage requires projectId and projectSecret, or explicit imessage clients');
  if (clients?.some(client => client.phone === 'shared') && clients.length !== 1) {
    throw new TypeError('Shared iMessage identity cannot be mixed with dedicated lines');
  }
  if (options.webhookSecret !== undefined && !options.webhookSecret) throw new TypeError('webhookSecret must be nonempty');
  if (options.webhookSecret !== undefined && options.webhook !== undefined) {
    throw new TypeError('Specify webhookSecret or webhook, not both');
  }
  const { providers: _providers, webhookSecret, ...runtime } = options;
  return SpectrumApp.create({ ...runtime, ...(clients ? { clients } : {}),
    ...(webhookSecret !== undefined ? { webhook: { scheme: 'legacy', secret: webhookSecret } } : {}) }, true);
}

const instances = new WeakMap<SpectrumApp, IMessageProvider>();

export interface IMessagePlatform {
  (app: SpectrumApp): IMessageProvider;
  (space: SpectrumSpace): SpectrumSpace;
  (message: SpectrumMessage): SpectrumMessage;
  (space: { readonly id: string; readonly __platform: string; readonly send: unknown }): SpectrumSpace;
  (message: { readonly id: string; readonly platform: string; readonly space: unknown }): SpectrumMessage;
  config(config?: IMessageConfig): IMessageProviderConfig;
  is(input: SpectrumSpace): input is SpectrumSpace;
  is(input: SpectrumMessage): input is SpectrumMessage;
  is(input: unknown): input is SpectrumSpace | SpectrumMessage;
}

export const imessage: IMessagePlatform = Object.assign(
  ((input: SpectrumApp | SpectrumSpace | SpectrumMessage) => {
    if (input instanceof SpectrumApp) {
      let instance = instances.get(input);
      if (!instance) {
        instance = {
          messages: input.messages,
          user: async id => ({ id, platform: 'imessage', __platform: 'imessage' }),
          space: {
            get: (id, params) => input.getSpace(id, params),
            create: (users, params) => input.createSpace((Array.isArray(users) ? users : [users]).map(user => typeof user === 'string' ? user : user.id), params),
          },
          getMessage: (space, id) => input.getMessage(space, id),
          getAttachment: (guid, phone) => input.getAttachment(guid, phone === undefined ? {} : { phone }),
        };
        instances.set(input, instance);
      }
      return instance;
    }
    if (input && typeof input === 'object' && (('__platform' in input && 'send' in input)
      || ('platform' in input && 'space' in input))) return input;
    throw new TypeError('Invalid input to imessage narrowing function');
  }) as IMessagePlatform,
  {
    config: (config: IMessageConfig = {}): IMessageProviderConfig => ({ [registration]: true, config }),
    is: ((input: unknown): input is SpectrumSpace | SpectrumMessage => {
      if (!input || typeof input !== 'object') return false;
      if ('__platform' in input) return input.__platform === 'imessage';
      return 'platform' in input && input.platform === 'imessage';
    }),
  },
);
