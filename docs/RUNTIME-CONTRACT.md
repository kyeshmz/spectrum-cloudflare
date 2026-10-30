# Web-only Spectrum-compatible iMessage runtime

## Scope and architecture

This is a scoped **Spectrum-compatible iMessage facade**. The supported factory,
provider, builder, and message-loop shapes run over one Web-only runtime. It does
not install Spectrum core's generalized registry, telemetry, or process lifecycle.

The original repository is [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts).
Its adopted behavior tests and the remaining compatibility scope are tracked in
[UPSTREAM-COMPATIBILITY.md](UPSTREAM-COMPATIBILITY.md).

The implementation lives in `@spectrum-cloudflare/imessage`. Management and
signature verification are separate dependency-free packages; `spectrum-cloudflare`
forwards their public exports. See [package boundaries](PACKAGES.md).

Production code uses Web APIs only: fetch, Web Crypto, AbortController,
Uint8Array, Blob, and ReadableStream. There are no Node/Bun imports, Buffer,
process, compatibility polyfills, or custom esbuild shims. An ordinary browser
ESM bundle runs in workerd on compatibility date `2026-07-30` with **no
compatibility flags**. Tests also assert Buffer/process are absent.

The runtime uses the actual Photon protobuf descriptors through Connect's
binary gRPC-Web transport. Cloudflare Workers' outbound gRPC translation can
translate these requests to Photon's native gRPC hosts. Availability depends on
Cloudflare account rollout; no extra Worker compatibility flag is used.
A self-hosted/local peer must itself speak gRPC-Web. Tests use a binary
gRPC-Web peer and do **not** prove that a production account has translation
enabled or that Photon accepts the account's credentials.

There is no HTTP middleware origin requirement and no `x-photon-server` routing
header. Defaults are the documented native hosts:

- Shared: `https://imessage.spectrum.photon.codes`
- Dedicated: `https://<instanceId>.imsg.photon.codes`

## Public API

Upstream-style setup uses `Spectrum({ providers: [imessage.config()], projectId,
projectSecret })`, with `imessage` imported from
`spectrum-cloudflare/providers/imessage` or the standalone iMessage package.
`imessage(app)` exposes asynchronous `user`, `space.get`, `space.create`, native
message iteration, and lookup helpers. Spaces/users carry `__platform: 'imessage'`
alongside the existing `platform` field. Selectors preserve space/message identity.
See the [compatibility matrix](UPSTREAM-COMPATIBILITY.md) for exact scope.

The original direct API remains available:

```ts
import { createSpectrum, text, attachment, group } from 'spectrum-cloudflare';

const app = await createSpectrum({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
  webhook: { scheme: 'legacy', secret: env.SPECTRUM_WEBHOOK_SECRET },
});
try {
  const space = await app.createSpace('+15551112222');
  const sent = await space.send(text('Hello'));
  await sent.reply('Threaded reply');
  const reaction = await sent.react('👍');
  await reaction.unsend(); // removes the original tapback
  await sent.edit('Updated');
  await space.send(attachment(new URL('https://example.com/photo.png')));
  await space.send(group(text('Caption'), attachment(new Uint8Array([1, 2]))));
} finally {
  await app.close();
}
```

- `app.api`: complete standalone `SpectrumApi` management client when project
  credentials are configured.
- `app.space(chatGuid, { phone? })`: synchronous existing-space reference.
- `await app.createSpace(peerOrPeers, { phone? })`: resolve/create a native chat.
- `await app.rpc(phone?)`: direct typed Connect clients with actual native method
  and field names. This exposes capabilities beyond the small facade, including
  available group, poll, location, and server-streaming methods.
- `await app.getAttachment(guid, { phone? })`: lazy Uint8Array/ReadableStream bytes.
- `await app.webhook(request, handler, { scheme, secret }?)`: verify, normalize,
  hydrate, and **await** one normalized message handler.
- `await app.webhook({ body, headers }, handler, options?)`: the raw-byte overload
  accepts `Uint8Array`/`ArrayBuffer` and returns `{ status, headers, body }`.
- `await app.close()`: idempotent cancellation and deterministic draining.
- `await app.stop()`: the upstream-style name for the same shutdown path.
- `app.messages`: the lazy native received-message iterable described below.

The facade's native clients default to a 30-second per-call deadline, configurable
with `timeoutMs` when creating the app. Connect call options can override it for
each RPC; use `{ timeoutMs: 0, signal }` for a long-lived subscription controlled
by your signal or `app.close()`.

Spaces expose `send`, `getMessage`, `startTyping`, `stopTyping`, `responding`, and
message action helpers. `responding(fn)` awaits typing start, invokes the callback,
and always attempts typing stop, ignoring stop failures while preserving the
callback's result or error. Variadic `send(a, b)`/`reply(a, b)` make separate ordered
sends; `group(...)` constructs one multipart send. Control signals can return no
message; variadic results contain the messages actually produced.
Messages expose `reply`, `react`, `edit`, `unsend`, and `read`, with `id`, `space`,
`platform: 'imessage'`, `direction`, `timestamp: Date`, content, and optional sender.
Edits and unsend require outbound messages; message-level read requires inbound
messages. Native reads mark the whole chat read.

Content helpers implement Spectrum's structural async `ContentBuilder` contract:
`text(string)`, `richlink(URL|string)`, `attachment(Uint8Array|Blob|URL, options?)`,
and `group(...parts)`, plus `reply`, `reaction`, `edit`, `unsend`, `read`, and `typing`.
`text('hello').build()` returns `{ type: 'text', text: 'hello' }`; empty outbound
text rejects at build/send time. Static helpers retain their original plain
properties, with non-enumerable `build` methods. Custom async builders are accepted
for supported content shapes. `space.send(string)` is plain text. Path strings are rejected,
not reinterpreted as URLs. A URL attachment is fetched by the app then uploaded as
protobuf bytes; no server-side URL-upload endpoint is invented. Direct `read()`
and `stream()` calls on a URL attachment input are unsupported; use the URL value
with `space.send()` so its fetch belongs to the app's cancellation scope.
Attachment MIME defaults are `Blob.type` or `application/octet-stream`; filename
inference is not implemented. `group(...).build()` returns upstream-style item
stubs with `{ id: '', content }`; sent groups contain actionable child messages.

The facade has no automatic write retries. It does not claim exactly-once sends;
advanced callers can use native client-message IDs through the typed RPC clients.

## Management discovery and routing

`createSpectrum` initializes during a request, not through module-global network
I/O. Project ID/secret use UTF-8 HTTP Basic auth through `SpectrumApi` to mint
short-lived line tokens. Management requests reject redirects, validate trusted
HTTPS origins, and retain bounded response-body deadlines. Tokens authenticate
native RPCs with Bearer metadata. This is **Stable Spectrum**, not the Beta
`api.photon.codes/v1` account API.

Tokens refresh on demand at 80% TTL with per-app singleflight and manual runtime
validation. A refresh belongs to the app lifetime; cancelling one caller stops
only that caller's wait, leaving concurrent callers' refresh intact. There are
no refresh intervals or assumptions about isolate reuse.
Dedicated instance IDs are validated before becoming hostname labels. Unassigned
lines with no assignment history are ignored. A still-authenticated instance keeps
its known phone during a temporary null/missing-number refresh; an instance removed
from auth has its client cancelled. Multiple dedicated lines
require explicit `phone` for existing-space operations. Creation without a phone
chooses a current dedicated line at random, then pins the returned space to it.
Shared mode uses deterministic `any;-;<peer>` DM GUIDs and cannot create groups.

For explicit/self-hosted gRPC-Web clients, bypass discovery while retaining the
management client:

```ts
createSpectrum({
  projectId: 'project',
  projectSecret: 'secret',
  clients: [{ baseUrl: 'http://127.0.0.1:8080', token: 'line-token', phone: 'shared' }],
});
```

Use actual line phones instead of `'shared'` for dedicated clients. `baseUrl`
configures the native/gRPC-Web transport, not an unrelated REST middleware.

The compatibility factory also permits explicit clients without management
credentials:

```ts
const app = await Spectrum({
  providers: [imessage.config({
    clients: { address: 'https://grpc.example.com', token: 'line-token', phone: 'shared' },
  })],
});
```

The provider boundary translates upstream `address` into the Web transport URL.
Native TLS host addresses (such as `grpc.example.com:443`) become HTTPS URLs.
The existing low-level `baseUrl` configuration also permits HTTP test peers.
No dummy project credentials are synthesized. With project credentials,
`Spectrum` obtains project metadata as `app.config` before initializing lines;
`createSpectrum` retains its existing discovery-only initialization behavior.
Startup signals stop initialization only; they do not become app lifetime signals.

## Native received-message iteration

`app.messages` and `imessage(app).messages` use the same app-owned broadcast.
Subscriptions start on first consumer demand through the actual
`MessageService/SubscribeMessageEvents` RPC, with no unary timeout. Separate
consumers receive the same events rather than dividing them among themselves.
Each line preserves its own order and bigint sequence; lines merge concurrently.
Each line keeps bounded pending deliveries. A stalled consumer applies backpressure
instead of growing an unbounded queue. Inventory changes discovered by the existing
demand-driven token refresh attach/retire subscriptions through the line owner;
there is no separate polling scheduler.

Only inbound `messageReceived` snapshots are emitted in this increment. The native
message's `isFromMe` flag filters outbound echoes. Heartbeats and other event arms
do not emit new messages. Event timestamps take precedence over creation time.
Embedded messages use the same materializer as message lookup; iteration does not
refetch each message or eagerly download its attachments.

Returning the last iterator aborts its subscriptions. `stop()`/`close()` aborts all
subscriptions and settles pending reads. A transport/trailer failure is surfaced
to consumers, and sibling streams are canceled. There is no implicit reconnect or
replay; the pinned subscription request has no resume-cursor field. Poll/group
events, reactions, and read-receipt normalization remain outside this iterator.
Webhook delivery does not feed the native iterable.

## Attachments, multipart identity, and lifetime

Photon `UploadAttachment` is a unary protobuf request with raw Uint8Array data;
uploads require the full primary file in memory. No filesystem or ffmpeg is used.
`DownloadAttachment` is server streaming: exactly one header, primary chunks,
optional companion chunks, and successful final gRPC status. There is no sentinel.
The facade exposes primary bytes only. Typed RPC access exposes all frames and
companions. Whole-file `read()` rejects on a nonzero final status rather than
returning partial bytes. A stream can expose bytes before a later trailer error;
callers must handle stream failures. Large files remain subject to Worker memory
and request limits.

Native multipart ordering follows Spectrum's U+FFFC algorithm. Without
placeholders, attachments precede text. Child IDs are `p:<index>/<parentGuid>`.
The same parent GUID/index is used for replies, reactions, edits, and unsend.
Message lookup uses the attachment metadata already present in the native message,
so extra metadata queries cannot compact its indexes. An attachment slot missing
its GUID is not materialized, but later child indexes are never compacted; a
single surviving child retains its original `p:<index>/<parentGuid>` identity.
Unknown native-only payloads
remain explicit `unknown` content rather than a fabricated empty text message.

The app owns lazy attachments obtained from message lookup, attachment lookup,
and verified webhook hydration. Close aborts native RPC requests/streams and URL
fetches, cancels all registered lazy downloads, then drains reads and provider
operations. New app operations and lazy network access reject after close.
Stream cancellation aborts the transport **before** awaiting iterator teardown,
including when the pending response never produces another byte. These semantics
are exercised against a real local HTTP socket carrying binary gRPC-Web frames.
Borrowed native clients are cancelled by app close as well; caller-created clients
from `createIMessageRpc` have their own explicit `close()` lifecycle.

## Authenticated webhook hydration

Select the signature scheme explicitly (`legacy` or `standard`). Verification
uses the original raw request bytes and occurs **before** JSON interpretation,
platform alias normalization, hydration, or handler dispatch. There is no fallback
between schemes. The facade accepts the Stable normalized `event: 'messages'`
envelope, not raw-provider protobuf deliveries. Only the explicit platform aliases
`iMessage` and `imessage` normalize to canonical `imessage`.

```ts
const app = await createSpectrum(options);
try {
  return await app.webhook(request, async (_space, message) => {
    await message.reply('Received');
  });
} finally {
  await app.close();
}
```

Handlers are awaited. Errors propagate instead of receiving a false successful
acknowledgement. Returning from the webhook method means its handler completed;
there is no fire-and-forget core behavior and no need for a background retention
shim. At-least-once delivery still requires durable deduplication before side
effects. A failed handler may have completed some side effects before the server
retries. Replies are separate native RPCs, not JSON embedded in the response.

## Intentional exclusions

No generalized provider registry, local macOS provider, terminal process, telemetry stack,
filesystem APIs, audio transcoding, Markdown renderer, or full Spectrum builder
compatibility. Native capabilities beyond the facade are available through
typed services rather than a second handwritten copy of their API surface.
