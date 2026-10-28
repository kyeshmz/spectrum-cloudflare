# Signed iMessage receive/respond Worker

This Web-only example verifies legacy signatures on normalized Spectrum webhooks
and sends `Received — thanks!` to inbound iMessage text chats using native Photon
gRPC. It accepts documented `platform: 'iMessage'` and lowercase `imessage` only.
Other providers, outgoing echoes, albums, and unknown shapes are ignored. The
receipt is an ordinary chat message, not a threaded reply. `GET /health` does no
I/O; `POST /send` is a 404.

## Build and run

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:example
cp examples/worker/.dev.vars.example examples/worker/.dev.vars
pnpm dlx wrangler@4.155.0 dev --config examples/worker/wrangler.jsonc
```

Fill the three bindings in `.dev.vars`:

| Binding | Value |
| --- | --- |
| `SPECTRUM_PROJECT_ID` | Stable project ID |
| `SPECTRUM_PROJECT_SECRET` | Stable project secret |
| `SPECTRUM_WEBHOOK_SECRET` | Literal legacy `signingSecret`, not the Standard `whsec_` key |

Wrangler bundles `worker.ts` normally. The compatibility date is `2026-07-30`;
there is no `nodejs_compat`, custom build helper, or Node/Bun runtime dependency.
The optional `build.mjs` uses plain esbuild's browser target for local bundle
verification. Development tooling itself runs on Node.js.

Hosted native gRPC requires Cloudflare's outbound gRPC translation to be enabled
for your account. The [announcement](https://blog.cloudflare.com/grpc-workers/)
describes a private beta rolling out. Miniflare's local gRPC-Web peer does not
prove account eligibility or native HTTP/2 translation. Project tokens select the
shared or dedicated Photon gRPC origin automatically.

The `wrangler dev` command above is local: it can serve `/health` and validate the
Worker, but Miniflare does not perform hosted outbound translation. Live calls to
Photon's default native hosts may fail locally. Verify those calls from a
hosted/remote Worker once account support is enabled; no deployment is performed
by these instructions or tests. The integration uses outbound fetch translation,
not Cloudflare's separately named Spectrum TCP product.

When configuring a hosted Worker, provision the same three bindings as secrets
(project ID may be a plain variable):

```sh
pnpm dlx wrangler@4.155.0 secret put SPECTRUM_PROJECT_ID --config examples/worker/wrangler.jsonc
pnpm dlx wrangler@4.155.0 secret put SPECTRUM_PROJECT_SECRET --config examples/worker/wrangler.jsonc
pnpm dlx wrangler@4.155.0 secret put SPECTRUM_WEBHOOK_SECRET --config examples/worker/wrangler.jsonc
```

Register a final public HTTPS `/webhook` URL with
`schemaVersion: 'normalized-events.v1'` and use its legacy `signingSecret`.
Signature scheme and schema version are independent: registration lists both
Standard and legacy headers. This example uses legacy verification only, with no
fallback or conversion of `raw-inbound.v1`; the complete raw schema is not
established here. No hosted deployment or messaging verification is claimed.

## Lifetime and delivery

The receive/respond path is sequential:

1. Verify exact request bytes before initializing the networked app.
2. Select normalized inbound iMessage text. Invalid signatures return 401;
   signed unsupported shapes return 200 without egress.
3. Create the request-scoped app and resolve the chat with the signed `space.phone`.
4. Await the outbound send, then await `app.close()` in `finally`.
5. Acknowledge only after work and cleanup succeed. Operational failures propagate.

There are no detached application promises or `waitUntil()` tasks. A retry after
a successful send and failed acknowledgement can duplicate receipts; application
deduplication and queueing are outside this sample. `webhook-id` identifies an
event; legacy `X-Spectrum-Webhook-Id` identifies its registration.

## Test without credentials

```sh
pnpm build
pnpm exec vitest run tests/example-workerd.test.ts
```

The test builds public package imports with plain esbuild and runs actual workerd
without Node compatibility. An actual binary gRPC-Web fixture decodes protobuf
requests and returns framed protobuf responses and gRPC status trailers. It checks
Basic-auth token minting, Bearer-auth gRPC-Web calls, dedicated origin routing,
delayed sends, failure cleanup, and zero-egress ignored/invalid deliveries. A
test-only marker after real `app.close()` observes completed teardown. The test
also asserts `Buffer` and `process` are absent. Hosted native translation and
Apple-device delivery need a separate authorized test.
