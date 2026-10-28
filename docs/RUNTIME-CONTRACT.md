# Web-only Spectrum-adjacent runtime

## Scope and architecture

This is a small **Spectrum-adjacent facade**, not a drop-in replacement for
`spectrum-ts`. It does not depend on or copy Spectrum core's provider registry,
builder pipeline, telemetry, message runtime, or process lifecycle.

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

- `app.api`: complete standalone `SpectrumApi` management client.
- `app.space(chatGuid, { phone? })`: synchronous existing-space reference.
- `await app.createSpace(peerOrPeers, { phone? })`: resolve/create a native chat.
- `await app.rpc(phone?)`: direct typed Connect clients with actual native method
  and field names. This exposes capabilities beyond the small facade, including
  available group, poll, location, and server-streaming methods.
- `await app.getAttachment(guid, { phone? })`: lazy Uint8Array/ReadableStream bytes.
- `await app.webhook(request, handler, { scheme, secret }?)`: verify, normalize,
  hydrate, and **await** one normalized message handler.
- `await app.close()`: idempotent cancellation and deterministic draining.

The facade's native clients default to a 30-second per-call deadline, configurable
with `timeoutMs` when creating the app. Connect call options can override it for
each RPC; use `{ timeoutMs: 0, signal }` for a long-lived subscription controlled
by your signal or `app.close()`.

Spaces expose `send`, `getMessage`, `startTyping`, `stopTyping`, and `read`.
Messages expose `reply`, `react`, `edit`, `unsend`, and `read`, with `id`, `space`,
`platform: 'imessage'`, `direction`, `timestamp: Date`, content, and optional sender.
Edits and unsend require outbound messages; message-level read requires inbound
messages. Native reads mark the whole chat read.

Content helpers return simple values, not Spectrum's `ContentBuilder` objects:
`text(string)`, `richlink(URL|string)`, `attachment(Uint8Array|Blob|URL, options?)`,
and `group(...parts)`. `space.send(string)` is plain text. Path strings are rejected,
not reinterpreted as URLs. A URL attachment is fetched by the app then uploaded as
protobuf bytes; no server-side URL-upload endpoint is invented. Direct accessor
calls on a URL attachment value are unsupported until it is sent; use the URL
value with `space.send()` so its fetch belongs to the app's cancellation scope.

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
lines are ignored; removed line clients are cancelled. Multiple dedicated lines
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

No provider registry, local macOS provider, terminal process, telemetry stack,
filesystem APIs, audio transcoding, Markdown renderer, or full Spectrum builder
compatibility. Native capabilities beyond the facade are available through
typed services rather than a second handwritten copy of their API surface.
