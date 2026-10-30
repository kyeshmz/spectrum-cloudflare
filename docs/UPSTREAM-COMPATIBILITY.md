# Upstream test compatibility and provenance

This is a **partial, adapted upstream test suite**, complemented by source-guided public API compatibility tests. It does not claim the entire Spectrum framework. The reference repository is [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts), pinned to **`d9e39089dc3d1c6f4536826f5ca50798856eecab`**. No installed `@spectrum-ts/core`, official Node transport, Bun runtime, or vendored upstream repository is needed to run these tests.

## Supported upstream-style consumption

The [implementation plan](COMPATIBILITY-PLAN.md) targets cloud iMessage applications
using these public call shapes:

| Upstream API | Workers support |
| --- | --- |
| `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })` | Same setup shape; explicit Worker bindings replace environment discovery |
| `spectrum-ts/providers/imessage` | Change the package name to `spectrum-cloudflare/providers/imessage`; standalone `@spectrum-cloudflare/imessage` also exports the provider |
| `imessage(app)` / `imessage(space)` / `imessage(message)` / `imessage.is(value)` | Provider selection and identity-preserving narrowing |
| `imessage.config({ clients: { address, token, phone } })` | Singleton or array, with credential-free explicit clients |
| `imessage(app).user(id)`, `.space.get(id, {phone})`, `.space.create(users, {phone})` | Identity, asynchronous space resolution, shared/dedicated routing |
| `text`, `richlink`, `attachment`, `group` | Async `.build()` plus existing plain inputs; Web attachment adaptations below |
| `reply`, `reaction`, `edit`, `unsend`, `read`, `typing` | Supported action builders dispatched through the same native operations |
| `space.send(a, b)` / `message.reply(a, b)` | Ordered separate sends; use `group(...)` for a multipart message |
| `space.responding(fn)` | Starts typing, returns the callback result, always attempts stop, and ignores stop failures |
| `app.messages` / `imessage(app).messages` | Lazy native received-message subscriptions, shared across consumers |
| `app.stop()` | Idempotent shutdown of the same owned clients used by `close()` |
| `app.webhook({ body, headers }, handler)` | Raw `Uint8Array`/`ArrayBuffer` input and raw-byte response; verified callbacks are awaited |

The original `createSpectrum`, `app.space`, `app.createSpace`, `app.rpc`, and
`app.close` APIs remain available. Compatibility is scoped to supported inputs;
the API does not load arbitrary providers or recreate upstream's private hooks.

### Deliberate differences

- `Uint8Array` replaces Node `Buffer`; file paths are unavailable. Supply a `Blob`,
  bytes, or `new URL(...)`. MIME defaults use `Blob.type` or
  `application/octet-stream`; set `mimeType` explicitly when known.
- URL attachments download during app-owned sending, so app shutdown can cancel
  them. A builder's direct `read()` does not start an unowned network download.
- Static text rejects empty strings during build/send. Streaming text, Markdown,
  advanced content builders, and provider fallback pipelines are absent.
- Native iteration emits inbound `messageReceived` snapshots, preserving multipart
  identities and event timestamps. It filters heartbeats, self-authored echoes,
  and other native event arms. Reactions/read receipts, group/poll event mapping,
  automatic reconnect, catch-up replay, and Fusor remain outside this facade.
- Webhook handlers are awaited and errors propagate. Unknown normalized envelopes
  are rejected. This intentionally differs from upstream's fire-and-forget and
  acknowledgement policies even when the method call shape matches.
- Provider message lookup returns this facade's actionable normalized message;
  it does not implement upstream's raw provider record or cache-first metadata API.
- Stream inventory follows demand-driven credential refresh. Returning the last
  consumer cancels subscriptions; a future iterator can start fresh. Unexpected
  errors propagate instead of automatically reconnecting. Slow consumers apply
  bounded backpressure across the broadcast.

`tests/compat-content.test.ts`, `tests/compat-runtime.test.ts`, and
`tests/compat-streams.test.ts` exercise these additions. A separate
`tests/compat-content-workerd.test.ts` checks module-scope builder construction in
real workerd. They are source-guided
compatibility regressions, not entire upstream files relabeled as passes. Packed
consumers additionally compile and execute the factory/provider/native-loop/reply
shape inside workerd without Node types or compatibility flags.

## How much was converted to Cloudflare-only?

The pinned upstream monorepo contains **13 packages**, counted from `packages/*/package.json`, not estimated from source lines:

| Original module family | Upstream packages | Workers result |
| --- | --- | --- |
| Framework | `@spectrum-ts/core` (1) | **Not converted wholesale.** A smaller iMessage-only facade supplies the supported methods below; no generalized core/provider registry package is shipped. |
| Providers | `@spectrum-ts/imessage`, `@spectrum-ts/imessage-local`, `@spectrum-ts/slack`, `@spectrum-ts/telegram`, `@spectrum-ts/terminal`, `@spectrum-ts/whatsapp-business` (6) | Cloud iMessage transport and selected facade behavior are implemented in `@spectrum-cloudflare/imessage`. The other five providers are unconverted/absent, including local macOS iMessage. |
| Web-framework adapters | `@spectrum-ts/express`, `@spectrum-ts/fastify`, `@spectrum-ts/elysia`, `@spectrum-ts/hono` (4) | Unconverted/absent; use the Web `Request` webhook API. |
| Umbrella | `spectrum-ts` (1) | `spectrum-cloudflare` is a new umbrella for the three Workers packages, not the same batteries-included provider distribution. |
| Test infrastructure | `@spectrum-ts/test-support` (1) | Not shipped or depended on. Small local Web/binary fixtures replace its Node/framework mocks. |

This workspace ships **three implementation packages plus one umbrella**: `@spectrum-cloudflare/api`, `@spectrum-cloudflare/webhooks`, `@spectrum-cloudflare/imessage`, and `spectrum-cloudflare`. Those are separate Workers-oriented boundaries, not a one-to-one conversion of four original packages.

Three different coverage levels must not be conflated:

1. **Pinned management contract:** all **54 management operations** are exposed through the typed API package. This is complete coverage of that pinned contract, not the Spectrum framework.
2. **Pinned native iMessage contract:** all **51 native RPC methods across eight services** (messages, chats, groups, attachments, handles, events, polls, locations) are exposed via typed native clients over binary gRPC-Web. This includes lower-level capabilities not normalized by the facade. For example, exposing native poll/group/event RPCs does **not** implement Spectrum poll builders, group membership events, Fusor, stream resumability or inbound read-receipt mapping. Contract exposure also does not mean every native method has an individual behavioral upstream test or was exercised against a live Photon service.
3. **Selected Spectrum-compatible iMessage facade:** the factory/provider/builders/iteration surface above, text/link/binary/grouped sends, shared/dedicated routing, reply/react/edit/unsend/read/typing, native lookups, token refresh, app lifecycle, and authenticated normalized webhooks. The baseline behavior ports below and the new public compatibility regressions cover different aspects of this subset. Full framework/providers, Node filesystem inputs and macOS integrations remain outside scope.

The source inventory has **18 upstream files indexed and hashed**. The original
12 adopted files provide 54 derived baseline instances; the remaining files
provide boundary analysis and selected assertions for the additional compatibility
regressions. No percentage-of-lines, percentage-of-Spectrum or whole-framework
conversion claim is made.

## Run and audit

Build the workspace packages before running tests: public package imports resolve their built `dist` exports.

```sh
pnpm build
pnpm exec vitest run tests/upstream
```

`tests/upstream-manifest.json` records SHA-256 hashes of the exact upstream test files examined, the destination of each port, and the number of derived test instances. The hash is of the **original upstream file**, not the modified port. To independently audit against a checkout of the pinned revision:

```sh
SPECTRUM_UPSTREAM_CHECKOUT=/path/to/spectrum-ts pnpm exec vitest run tests/upstream/provenance.test.ts
```

The optional audit checks every recorded source hash and fails on changed source contents. Ordinary tests neither access that path nor fetch GitHub. CI checks out the pinned upstream revision and enables all 18 source-hash audits. The provenance test also guards the immutable revision and local test destinations. Updating the pin requires reviewing the upstream changes, refreshing hashes, and updating this coverage map; changing a URL alone is insufficient.

The baseline contains **54 upstream-derived test instances from 12 upstream test files**, representing 52 selected original scenarios (the upstream provider-shim loop is instantiated for three Workers packages). There are also **four explicitly local Standard Webhooks extensions** and **one local provenance check**, totaling **59 tests across eight port-suite files**, including the known-line phone-loss auth scenario. No unported tests are represented by skipped placeholders. This baseline count excludes the optional 18 source-hash audits, new compatibility regressions, and pre-existing local tests.

## What was changed in the original baseline ports

* Imports target published public APIs: `spectrum-cloudflare`, its subpaths, and `@spectrum-cloudflare/{imessage,api,webhooks}`. Private upstream provider definitions and framework context objects are not recreated.
* Upstream `AdvancedIMessage` method mocks become actual binary gRPC-Web exchanges through `tests/fixtures/runtime-grpc-peer.ts` and the small `tests/upstream/upstream-peer.ts` response adapter. Assertions examine decoded protobuf requests, not an invented REST protocol. The adapter never changes production code.
* Fixture lineage is explicit: `runtime-grpc-peer.ts` is this repository's pre-existing independently authored binary peer; `upstream-peer.ts` is a new local response adapter, **not copied upstream transport code**. Original fixture values originate in the linked space/reaction/unsend/auth tests. The independent legacy HMAC signer is adapted directly from upstream `core/test/webhook/verify.test.ts`. The webhook envelope/signer in `webhook.test.ts` are local equivalents of upstream test-support fixtures; no complete upstream test-support package is vendored.
* Original scenario names, GUIDs, phone numbers, emoji, timestamps and expected refs are retained where possible. Facade objects include methods, so ref checks use `toMatchObject`, rather than whole-object equality against upstream raw records.
* The original port used synchronous `app.space` for `space.get`; its offline references defer phone resolution until I/O. New public compatibility tests separately exercise `imessage(app).space.get`, which resolves the default phone and rejects ambiguity immediately.
* Native enum assertions use protobuf JSON enum names instead of the upstream Node SDK's `{kind: "like"}` / `{kind: "emoji"}` strings. Native part indices use `targetPartIndex` rather than the Node wrapper's `partIndex` option. Public child IDs remain `p:<index>/<parent-guid>`.
* The legacy verifier returns authenticated parsed JSON or throws a typed error, whereas upstream returns `{ok, reason}`. Its independent `node:crypto` test signer, signature format and timing boundaries are retained. Non-JSON `payload`/`original`/`tampered!` inputs become JSON string values because successful verification also parses JSON here. `now` is seconds, not upstream milliseconds. Malformed signatures throw typed `headers` errors, rather than returning a failure object; the original titles referring to “without throwing” mean no low-level crypto crash and are annotated accordingly.
* Renewal tests advance the clock and trigger demand-driven refresh through the public facade, rather than invoking upstream's scheduled renewal callback. They do **not** assert upstream's timer scheduling or stream observers.
* Baseline webhook tests select an explicit scheme and use a Web `Request`. They use `imessage`, not a synthetic registered provider `im`. The four Standard Webhooks repetitions are a local extension, not tests claimed to exist upstream.
* Export identity preserves the upstream loop and assertions but applies them to this SDK's three packages. It does not assert exports for upstream's five providers. The two package-boundary tests adapt the package names and filesystem locations; installing Node's Advanced iMessage transport would be the opposite of this SDK's boundary.

## Adopted upstream files and exact scenario coverage

All links below are immutable source links at the pinned revision. A partially ported file is **not** counted as fully compatible.

| Original test file | Port and selected scenarios | Not ported / boundary |
| --- | --- | --- |
| [`imessage/test/space.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/space.test.ts) | `tests/upstream/space.test.ts`: all nine original scenarios: deterministic shared DM, shared group rejection, dedicated DM/group server GUIDs, explicit creation routing, offline DM/group typing, explicit space phone, multi-line ambiguity. | Adaptations to default phone and lazy line resolution above; no framework provider schemas are implied. |
| [`imessage/test/remote/reactions.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/reactions.test.ts) | `actions.test.ts`: all three `reactToMessage` scenarios: native 👍 tapback/record, 🦊 emoji fallback, parent GUID + part index. | `toReactionMessages` inbound event conversion, outbound cache resolution, actor metadata, failed-target dropping are absent. Native delivery diagnostics are not copied onto the facade record. |
| [`imessage/test/remote/unsend.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/unsend.test.ts) | `actions.test.ts`: five of six scenarios: plain retraction, child unwrapping, native/emoji reaction removal, part-targeted reaction removal. | The SDK-rejection/expired-window mock case is not ported here; transport error propagation has separate local gRPC coverage, not an upstream-port claim. |
| [`core/test/core/send-read.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/send-read.test.ts) | `core-actions.test.ts`: `message.read()` dispatches to native chat read, outbound read rejection. | New compatibility tests cover `read()` and `space.read(message)` separately; unsupported-provider no-op behavior is outside this iMessage-only runtime. |
| [`core/test/core/send-unsend.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/send-unsend.test.ts) | `core-actions.test.ts`: message unsend, unsending the reaction handle, inbound unsend rejection. | New compatibility tests cover `unsend()` and space action helpers separately; unsupported-provider no-op behavior is outside this runtime. |
| [`imessage/test/auth.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/auth.test.ts) | `auth.test.ts`: eight scenarios: unnumbered startup, newly assigned number, known line losing number (retains client/phone and refreshes credentials), provision/deprovision, empty inventory, shared token replacement without recreating client, startup signal independence. | Partial constructor rollback, failed close aggregation, observer re-assertion/failure isolation, stream attachment options, coalesced forced recovery, in-flight cancellation are not asserted by this port. Some cancellation/singleflight behavior has pre-existing local tests (below). |
| [`core/test/core/spectrum.startup.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/spectrum.startup.test.ts) | `core-actions.test.ts`: pre-aborted startup does no I/O; successful instance survives startup signal expiry. | Framework multi-provider rollback, telemetry shutdown and config validation absent. |
| [`core/test/core/spectrum.shutdown.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/spectrum.shutdown.test.ts) | `core-actions.test.ts`: prompt close without a subscription; no SIGINT/SIGTERM listeners. | Managed provider streams, multi-provider teardown, subprocess host-drain test not ported. |
| [`core/test/webhook/verify.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/verify.test.ts) | `verify.test.ts`: eleven of twelve scenarios: signed body, tamper/wrong secret, exact/expired tolerance boundary, missing headers, nonnumeric timestamp, malformed/odd signature, empty secret. | Bare hex signature acceptance is deliberately **not compatible**: this SDK requires the `v0=` prefix. Return/error and JSON parsing differences are described above. |
| [`core/test/webhook/spectrum.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/spectrum.test.ts) | `webhook.test.ts`: four scenarios: authenticated delivery, bad signature never calls handler, expired timestamp, Web Request delivery. Repeated under Standard Webhooks as four local extension cases. | Poll identifiers, unknown-event/platform 200 acknowledgement, missing-secret 500, raw overload, fire-and-forget handler behavior and Fusor dispatch are not ported. This facade rejects unknown envelopes/platforms with 400, requires explicit configuration, **awaits** handlers and propagates their errors; it is intentionally not upstream's fire-and-forget handler model. |
| [`spectrum-ts/test/providers-shims.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/spectrum-ts/test/providers-shims.test.ts) | `exports.test.ts`: provider/shim/barrel export identity loop across all exports of the three Workers packages. | The additional `/providers/imessage` shim is checked by package-boundary and packed tests. Other provider consts remain absent. |
| [`spectrum-ts/test/imessage-package-boundary.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/spectrum-ts/test/imessage-package-boundary.test.ts) | `exports.test.ts`: original first two scenarios: no local iMessage in umbrella; no imessage-kit/better-sqlite3 in cloud provider. | Node transport dependency installation and explicit local-provider installation tests are not applicable. |

## Existing local tests are not relabeled upstream tests

These tests predate this port. They complement it but are **not** counted in the upstream-derived total:

| Supported capability / upstream comparison | Existing local evidence | Limit |
| --- | --- | --- |
| Text, richlink, binary attachment upload, grouped sends, reply/react/edit/unsend, typing | `tests/runtime-provider.test.ts` | There is no matching ordinary outbound iMessage send test file in this pinned upstream suite; upstream markdown/stream/app send tests require additional features. These are local contract tests, not claimed original tests. |
| Native `getMessage`, ordered parts, child action targets | `tests/runtime-parts.test.ts`, `tests/runtime-downloads.test.ts` | Compared with [`imessage/test/remote/inbound.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/inbound.test.ts), which tests a provider stream. New subscription tests reuse the same materializer; sender country/service metadata, reply-target caches, and CAF voice classification remain absent. |
| Normalized text/reaction/group/attachment validation and hydration | `tests/webhooks.test.ts`, `tests/runtime-workerd.test.ts` | [`core/test/webhook/deserialize.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/deserialize.test.ts) is not copied: its resolver/context API, raw nested target objects, reply/read/voice/poll/membership/avatar types and custom fallback differ. This facade uses `unknown` fallback, not upstream `custom`, and has a smaller content surface. |
| Token refresh coalescing, aborted initialization, retry after mint failure, inventory routing, lifecycle cancellation | `tests/runtime-lines.test.ts`, `tests/runtime-tokens-workerd.test.ts` | Demand-driven rather than upstream background renewal; not a claim to pass all [`core/test/utils/token-renewal.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/utils/token-renewal.test.ts) scheduler tests. |
| Standard Webhooks signatures, key decoding/rotation, exact byte verification and replay protection | `tests/webhooks.test.ts` | Standard Webhooks are a local extension; upstream's pinned `verify.test.ts` tests only legacy signatures. |
| REST management, binary transport, Worker execution, browser runtime boundary | `tests/api.test.ts`, `tests/grpc.test.ts`, `tests/grpc-workerd.test.ts`, `tests/portable-workerd.test.ts`, `tests/web-boundary.test.ts` | These are independent Workers SDK tests, not upstream framework compatibility. |

## Reviewed features that are absent, not “passed”

* [`imessage/test/remote/message-metadata-integration.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/message-metadata-integration.test.ts) and `message-metadata.test.ts`: full native metadata propagation and cache-first `getMessage` are absent. This facade exposes a smaller normalized message plus direct native RPC access; that does not pass these tests.
* [`core/test/content/text.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/content/text.test.ts): static `.build()` and empty-text rejection have adapted assertions in `compat-content.test.ts`; stream sources/extractors and streaming delivery remain absent.
* `core/test/platform/define.test.ts`, `core/test/core/space.test.ts`, `spectrum.unique-platform-names.test.ts`, `spectrum.env-credentials.test.ts`, `platform-wise-reads.test.ts`, and `utils/provider-packages.test.ts`: no provider registry, arbitrary platform schemas, environment discovery or automatic provider package loading.
* `core/test/core/fusor/{webhook,websocket}.test.ts`, `core/test/utils/{resumable-stream,stream-group,resumable-diagnostics,stream,collect-until-idle}.test.ts`, `imessage/test/remote/{stream,heartbeats,profile-sync-gate,read-receipts}.test.ts`: the new native received-message broadcast is narrower than these suites. Fusor, resumable cursors, heartbeat/profile synchronization and inbound read-receipt mapping remain absent.
* `core/test/content/{markdown,app,poll,membership}.test.ts`, `core/test/core/{send-markdown-fallback,send-stream-text-fallback,send-membership,receive-membership,receive-read}.test.ts`, `imessage/test/remote/{markdown,send-markdown,stream-text,app,polls,inbound-app-card,group-events,contact-share}.test.ts`, and `imessage/test/{membership,background,contact-card}.test.ts`: formatted streaming text, polls, app cards, membership/group metadata actions and provider fallback pipelines are absent. Supported static/action builders are covered separately; their presence does not imply advanced builder parity.
* `imessage-local/test/**`, `terminal/**`, Slack, Telegram, WhatsApp Business, and Express/Fastify/Elysia/Hono adapter suites: no macOS database/filesystem integration, terminal provider, other messaging providers or web-framework adapters. The SDK exposes a standard Web `Request` handler instead.
* Upstream telemetry/instrumentation helpers and release tooling tests are not runtime compatibility claims.

## Adopted known-line phone-loss behavior

`tests/upstream/auth.test.ts` now passes upstream's **“keeps a known line usable when it loses its number mid-refresh”** as an ordinary test. Dedicated lines retain their instance identity in the inventory owner; an authenticated instance with a temporarily null or missing number keeps its last assigned phone and the same native client, using renewed credentials.

Reproduction: mint dedicated inventory with `auth: {"instance-1": "token-instance-1"}`, `numbers: {"instance-1": "+15550000001"}`, TTL 1 second; after 801 ms mint renewed auth for the same instance with `numbers: {"instance-1": null}`; call `app.rpc('+15550000001')`. Both upstream and this facade retain the known phone and complete refresh normally. The port additionally checks native-client identity and renewed bearer auth, and verifies that subsequent RPC selection does not repeatedly mint tokens.

Never-assigned instances remain ignored. An instance absent from `auth` is still retired and its old client canceled, even if a stale number remains. Duplicate phone validation runs after known-number fallback, rejecting ambiguous remapping before committing the inventory. Two local regressions in `tests/runtime-lines.test.ts` cover missing-number fallback/retirement and duplicate fallback rejection/recovery; these are not additional upstream-derived cases. Verification: **18 scoped tests pass** (runtime lines plus upstream auth), **59 port-suite tests pass**, **262 full-suite tests pass across 23 files**, and the full workspace/root/test typecheck passes. There are no expected failures.

## License and attribution

Adapted test scenarios, test names, assertions and the independent legacy signer derive from the upstream source linked above. Upstream's license is [MIT at the pinned revision](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/LICENSE). The following notice applies to those portions:

> MIT License Copyright (c) 2025 Photon AI
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
