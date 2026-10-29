# Spectrum Cloudflare

A Web-only TypeScript integration for Stable Spectrum management and Photon
iMessage gRPC. It offers chat spaces, content helpers, and message decorators
without Bun or Node APIs in the shipped runtime.

Built alongside and adapted from **[Photon's original Spectrum SDK,
`photon-hq/spectrum-ts`](https://github.com/photon-hq/spectrum-ts)**. This repository
uses a smaller Spectrum-adjacent API tailored to Workers. See
[upstream compatibility and test provenance](docs/UPSTREAM-COMPATIBILITY.md)
for the pinned source revision, adopted tests, and API differences.

**Repository:** [kyeshmz/spectrum-cloudflare](https://github.com/kyeshmz/spectrum-cloudflare).
The packages are at `0.0.0` and have not been published to npm.
Local tests exercise real workerd against deterministic gRPC-Web peers. Hosted
native gRPC delivery requires Cloudflare's outbound gRPC translation to be enabled
for your account: the [announcement](https://blog.cloudflare.com/grpc-workers/)
describes a private beta rolling out. Local protocol tests do not prove account
eligibility or delivery to an Apple device.

## Packages

| Package | Use it for | Runtime dependencies |
| --- | --- | --- |
| [`@spectrum-cloudflare/imessage`](packages/imessage) | Spaces, messages, attachments, token discovery, typed gRPC and protobuf exports | API, webhooks, Connect, Protobuf-ES |
| [`@spectrum-cloudflare/api`](packages/api) | All 54 Stable management operations | None |
| [`@spectrum-cloudflare/webhooks`](packages/webhooks) | Legacy/Standard signature verification and normalized payload types | None |
| `spectrum-cloudflare` | Convenience entry combining all packages | The three packages above |

Each domain package owns its implementation and builds its own JavaScript and
declarations. Installing only API or webhooks does not install iMessage, Connect,
or protobuf. The convenience package forwards the same exports and module
identities; existing `spectrum-cloudflare/api`, `/webhooks`, `/grpc`, and `/proto/*`
imports continue to work. `spectrum-cloudflare/imessage` is also available.

```ts
import { createSpectrum, text } from '@spectrum-cloudflare/imessage';
import { SpectrumApi } from '@spectrum-cloudflare/api';
import { verifyStandardWebhook } from '@spectrum-cloudflare/webhooks';
```

## Start locally

Use Node.js for development tooling and the pinned `pnpm@12.14.0`. Runtime Workers
use Web APIs only.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:example
```

The [Worker example](examples/worker/README.md) includes a normal Wrangler
TypeScript entry, local secrets template, `/health`, and a signature-authenticated
`POST /webhook`. It sends receipts only for signed normalized inbound iMessage
text and exposes no public send route. It needs neither `nodejs_compat` nor a
custom bundler plugin.

Build the complete local package set before consuming it in another Worker app:

```sh
pnpm pack:all
```

This emits four tarballs into `artifacts/`. See [package installation and
boundaries](docs/PACKAGES.md) for local dependency resolution before npm publication.

Copy `examples/worker/worker.ts` and `wrangler.jsonc` into your app together. Use
Wrangler's normal bundling. `build.mjs` is an optional plain esbuild browser build
for local verification; it requires esbuild as a development dependency. With
pnpm build-script approvals enabled, approve esbuild's install script or allow it
in your `pnpm-workspace.yaml`. This repository allowlists esbuild and workerd.

## Small usage

Initialize in a request or job, await messaging work, then close:

```ts
import { createSpectrum, text } from 'spectrum-cloudflare';

const app = await createSpectrum({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
});
try {
  const space = app.space('any;-;+15551112222', { phone: 'shared' });
  const sent = await space.send(text('Hello from a Worker'));
  await sent.react('👍');
  await sent.reply('A threaded follow-up');
} finally {
  await app.close();
}
```

Use the delivery's `space.phone` for dedicated-line routing. `app.createSpace(peers,
{ phone })` creates a chat; `app.rpc(phone)` provides typed Photon native services
for operations outside the facade. Shared lines cannot create groups.

## Transport and credentials

The transport uses Buf-generated Photon protobuf types and
`@connectrpc/connect-web`'s `createGrpcWebTransport`. Fetch uses
`redirect: 'manual'`, as required for Cloudflare's automatic outbound
gRPC-Web-to-native-gRPC translation. No extra Worker compatibility flags or HTTP
middleware URL are needed.

Translation happens in Cloudflare's hosted network for enabled accounts, not in
local Miniflare. Local `wrangler dev` may therefore fail against Photon's default
native gRPC hosts even when the gRPC-Web fixture tests pass. Verify live messaging
from a hosted/remote Worker after account support is enabled. This integration
uses outbound fetch translation only; Cloudflare's Spectrum TCP product mentioned
in the announcement is unrelated to Photon Spectrum and is not used here.

Project-secret Basic authentication mints line tokens through `SpectrumApi`.
Native calls use Bearer line tokens at the shared origin
`https://imessage.spectrum.photon.codes` or dedicated origin
`https://${instanceId}.imsg.photon.codes`. The management origin remains
`https://spectrum.photon.codes`. These are separate service roles.

The typed native surface covers **51 RPCs across eight Photon services**, including
unary and server-streaming operations. Standalone clients are available from
`@spectrum-cloudflare/imessage/grpc`; protobuf schemas and enums are available
through `@spectrum-cloudflare/imessage/proto/*`, such as
`@spectrum-cloudflare/imessage/proto/message_service`. The matching umbrella
subpaths remain available.
Attachment upload is a unary protobuf request carrying `Uint8Array` bytes, not
client streaming. Native streaming operations belong to the app lifetime; close
the app after their work is complete. Check the
[runtime contract](docs/RUNTIME-CONTRACT.md) for the facade's supported content
and behavior.

## Stable management API

All **54 method/path operations** in the pinned Stable OpenAPI snapshot have
generated input and success-data types. Literal method/path arguments select
their types; the client fills `{projectId}` from its configuration:

```ts
import { SpectrumApi } from '@spectrum-cloudflare/api';

const api = new SpectrumApi({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
});
const { users, total } = await api.request('GET', '/projects/{projectId}/users/', {
  query: { limit: 50, offset: 0 },
});
if (users[0]) {
  const user = await api.request('GET', '/projects/{projectId}/users/{userId}/', {
    path: { userId: users[0].id },
  });
}
```

Responses unwrap the `data` envelope; resource types are compile-time contracts,
not full runtime validation. Pagination and request scheduling remain explicit.
This client targets Stable, rather than Photon Beta's `/v1` API or dashboard OAuth.
Management has no send-message endpoint; messaging uses the native gRPC services.
See [API contract and provenance](docs/API-CONTRACT.md).

## Webhook signatures and payload schemas

Signature scheme and payload schema are independent. The pinned registration
description lists both Standard and legacy signature headers on each delivery;
`schemaVersion` determines its payload:

- `normalized-events.v1`: normalized Spectrum events, including `event: 'messages'`.
- `raw-inbound.v1`: the inbound provider request. Its complete payload schema has
  not been established here.

| Signature scheme | Verifier | Secret and headers |
| --- | --- | --- |
| Legacy Spectrum | `verifyLegacySpectrumWebhook` | Literal `signingSecret`; `X-Spectrum-Timestamp` and `X-Spectrum-Signature` |
| Standard Webhooks | `verifyStandardWebhook` | `whsec_` base64 `standardSigningSecret`; `webhook-id`, `webhook-timestamp`, and `webhook-signature` |

Import either verifier from `@spectrum-cloudflare/webhooks`. It authenticates exact
raw bytes and returns unknown JSON for schema validation. A Standard signature
does not imply a raw payload. There is no automatic signature fallback or schema
downgrade. The management subscription `message.received` differs from the
normalized envelope's `messages` discriminator.

The example uses legacy verification and accepts normalized inbound text with
`platform: 'iMessage'` or lowercase `imessage`. It verifies before initializing the
networked app, awaits its send, then awaits `close()` before acknowledging. Invalid
signatures and unsupported events cause zero egress. Sending before acknowledgement
means a webhook retry after a send/ack ambiguity can duplicate receipts;
application deduplication and queueing are outside the sample.

## Verification and provenance

`pnpm check` checks generated management and protobuf drift, builds package exports,
type-checks source and tests, runs tests, and builds the example. `pnpm pack:all`
runs that gate before packing all four packages. Individual `pnpm pack` commands
build the selected package and its dependencies. `pnpm check:generated` checks the pinned management snapshot offline;
`pnpm check:grpc-generated` checks the pinned protobuf snapshot and generated modules.

`pnpm test:upstream` runs the compatibility tests derived from
[`photon-hq/spectrum-ts`](https://github.com/photon-hq/spectrum-ts). They also run in
the full suite. GitHub CI checks package boundaries, types, upstream behavior,
real workerd execution, and packed artifacts. Test lineage and supported scope
are recorded in [UPSTREAM-COMPATIBILITY.md](docs/UPSTREAM-COMPATIBILITY.md).

The example integration runs inside actual workerd without Node aliases or
polyfills. Its deterministic peer decodes/encodes binary protobuf gRPC-Web frames;
the test checks token minting, routing, signature rejection, awaited work, cleanup,
and absence of `Buffer` and `process`. Native HTTP/2 translation and hosted device
delivery remain separate from these local tests.

See [third-party notices](THIRD-PARTY-NOTICES.md), the
[runtime contract](docs/RUNTIME-CONTRACT.md), and the
[management API contract](docs/API-CONTRACT.md) for source revisions and behavior.
