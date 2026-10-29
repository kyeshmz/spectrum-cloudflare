import { Code, ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { AddressService } from "./generated/photon/imessage/v1/address_service_pb.js";
import { AttachmentService } from "./generated/photon/imessage/v1/attachment_service_pb.js";
import { ChatService } from "./generated/photon/imessage/v1/chat_service_pb.js";
import { EventService } from "./generated/photon/imessage/v1/event_service_pb.js";
import { GroupService } from "./generated/photon/imessage/v1/group_service_pb.js";
import { LocationService } from "./generated/photon/imessage/v1/location_service_pb.js";
import { MessageService } from "./generated/photon/imessage/v1/message_service_pb.js";
import { PollService } from "./generated/photon/imessage/v1/poll_service_pb.js";

export interface IMessageRpcOptions {
  /** Native Photon gRPC origin. Workers must have outbound gRPC translation enabled. */
  baseUrl: string;
  /** Called for every RPC, including stream reconnects. */
  token: string | ((signal?: AbortSignal) => Promise<string>);
  fetch?: typeof globalThis.fetch;
  /** Default deadline; callers may override it using Connect call options. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function resolveToken(token: IMessageRpcOptions["token"], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (typeof token === "string") return token;
  // A token provider may not cooperate with cancellation. Bound the caller's
  // wait anyway, and remove the listener when either operation settles.
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([token(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Typed Photon v1 clients over binary gRPC-Web. Cloudflare translates outbound
 * requests to native gRPC; a direct local peer must itself speak gRPC-Web.
 * No retries are added, particularly for mutating operations.
 */
export function createIMessageRpc(options: IMessageRpcOptions) {
  const url = new URL(options.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must be an HTTP(S) gRPC origin without credentials, query, or fragment");
  }
  const controller = new AbortController();
  const lifetime = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const authorize: Interceptor = (next) => async (request) => {
    const signal = request.signal;
    const token = await resolveToken(options.token, signal);
    signal.throwIfAborted();
    request.header.set("authorization", `Bearer ${token}`);
    return next(request);
  };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const webTransport = createGrpcWebTransport({
    baseUrl: url.href.replace(/\/$/, ""),
    useBinaryFormat: true,
    interceptors: [authorize],
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
    // Required for Cloudflare's native outbound gRPC translation. Connect
    // rejects redirect responses; credentials are never followed to a new URL.
    fetch: (input, init) => fetchImplementation(input, { ...init, redirect: "manual" }),
  });
  const callSignal = (signal: AbortSignal | undefined) => signal
    ? AbortSignal.any([signal, lifetime])
    : lifetime;
  // Combine before Connect creates its call controller, not inside auth.
  // This lets Connect normalize custom abort reasons to Canceled throughout
  // pending auth and response streams, while retaining deadline/error codes.
  const transport: Transport = {
    unary(method, signal, timeoutMs, header, message, contextValues) {
      return webTransport.unary(method, callSignal(signal), timeoutMs, header, message, contextValues);
    },
    stream(method, signal, timeoutMs, header, input, contextValues) {
      return webTransport.stream(method, callSignal(signal), timeoutMs, header, input, contextValues);
    },
  };
  return {
    messages: createClient(MessageService, transport),
    chats: createClient(ChatService, transport),
    groups: createClient(GroupService, transport),
    attachments: createClient(AttachmentService, transport),
    handles: createClient(AddressService, transport),
    events: createClient(EventService, transport),
    polls: createClient(PollService, transport),
    locations: createClient(LocationService, transport),
    close(): void {
      controller.abort(new ConnectError("Photon RPC client closed", Code.Canceled));
    },
  };
}

export type IMessageRpc = ReturnType<typeof createIMessageRpc>;
