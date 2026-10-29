# Upstream test compatibility and provenance

This is a **partial, adapted upstream test suite**, not the complete Spectrum test suite and not a claim that this SDK implements Spectrum's full framework. The reference repository is [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts), pinned to **`d9e39089dc3d1c6f4536826f5ca50798856eecab`**. No installed `@spectrum-ts/core`, official Node transport, Bun runtime, or vendored upstream repository is needed to run these tests.

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
3. **Selected Spectrum-adjacent facade:** text, richlink, binary attachment and grouped sends; shared/dedicated space creation and phone selection; reply/react/edit/unsend; chat read and typing; native message/attachment retrieval; token refresh and app lifecycle; authenticated normalized webhook delivery for legacy and Standard Webhooks. This is the subset compared with original tests below. Full framework/providers, Node filesystem inputs and macOS integrations remain outside scope.

The quantitative test inventory is **16 source files indexed and hashed: 12 with adopted cases, four reviewed for boundaries**. Their 54 derived test instances are not 54 complete upstream files or all upstream tests. No percentage-of-lines, percentage-of-Spectrum or whole-framework conversion claim is made.

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

The optional audit checks every recorded source hash and fails on changed source contents. Ordinary tests neither access that path nor fetch GitHub. CI checks out the pinned upstream revision and enables all 16 source-hash audits. The provenance test also guards the immutable revision and local port destinations. Updating the pin requires reviewing the upstream changes, refreshing hashes, and updating this coverage map; changing a URL alone is insufficient.

There are **54 upstream-derived test instances from 12 upstream test files**, representing 52 selected original scenarios (the upstream provider-shim loop is instantiated for three Workers packages). There are also **four explicitly local Standard Webhooks extensions** and **one local provenance check**. All **59 tests across eight port-suite files pass**, with **zero expected failures**, including the known-line phone-loss auth scenario. No unported tests are represented by skipped placeholders. Counts do not include the optional 16 source-hash audit cases or this repository's pre-existing tests.

## What was changed when porting

* Imports target published public APIs: `spectrum-cloudflare`, its subpaths, and `@spectrum-cloudflare/{imessage,api,webhooks}`. Private upstream provider definitions and framework context objects are not recreated.
* Upstream `AdvancedIMessage` method mocks become actual binary gRPC-Web exchanges through `tests/fixtures/runtime-grpc-peer.ts` and the small `tests/upstream/upstream-peer.ts` response adapter. Assertions examine decoded protobuf requests, not an invented REST protocol. The adapter never changes production code.
* Fixture lineage is explicit: `runtime-grpc-peer.ts` is this repository's pre-existing independently authored binary peer; `upstream-peer.ts` is a new local response adapter, **not copied upstream transport code**. Original fixture values originate in the linked space/reaction/unsend/auth tests. The independent legacy HMAC signer is adapted directly from upstream `core/test/webhook/verify.test.ts`. The webhook envelope/signer in `webhook.test.ts` are local equivalents of upstream test-support fixtures; no complete upstream test-support package is vendored.
* Original scenario names, GUIDs, phone numbers, emoji, timestamps and expected refs are retained where possible. Facade objects include methods, so ref checks use `toMatchObject`, rather than whole-object equality against upstream raw records.
* `space.get` becomes synchronous `app.space`; line ambiguity is rejected at the first I/O operation, not offline construction. Offline spaces do not eagerly populate the default phone. Explicit phone routing is still checked.
* Native enum assertions use protobuf JSON enum names instead of the upstream Node SDK's `{kind: "like"}` / `{kind: "emoji"}` strings. Native part indices use `targetPartIndex` rather than the Node wrapper's `partIndex` option. Public child IDs remain `p:<index>/<parent-guid>`.
* The legacy verifier returns authenticated parsed JSON or throws a typed error, whereas upstream returns `{ok, reason}`. Its independent `node:crypto` test signer, signature format and timing boundaries are retained. Non-JSON `payload`/`original`/`tampered!` inputs become JSON string values because successful verification also parses JSON here. `now` is seconds, not upstream milliseconds. Malformed signatures throw typed `headers` errors, rather than returning a failure object; the original titles referring to “without throwing” mean no low-level crypto crash and are annotated accordingly.
* Renewal tests advance the clock and trigger demand-driven refresh through the public facade, rather than invoking upstream's scheduled renewal callback. They do **not** assert upstream's timer scheduling or stream observers.
* Webhook tests select an explicit scheme and use a Web `Request`, the facade's only overload. They use `imessage`, not a synthetic registered provider `im`. The four Standard Webhooks repetitions are a local extension, not tests claimed to exist upstream.
* Export identity preserves the upstream loop and assertions but applies them to this SDK's three packages. It does not assert exports for upstream's five providers. The two package-boundary tests adapt the package names and filesystem locations; installing Node's Advanced iMessage transport would be the opposite of this SDK's boundary.

## Adopted upstream files and exact scenario coverage

All links below are immutable source links at the pinned revision. A partially ported file is **not** counted as fully compatible.

| Original test file | Port and selected scenarios | Not ported / boundary |
| --- | --- | --- |
| [`imessage/test/space.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/space.test.ts) | `tests/upstream/space.test.ts`: all nine original scenarios: deterministic shared DM, shared group rejection, dedicated DM/group server GUIDs, explicit creation routing, offline DM/group typing, explicit space phone, multi-line ambiguity. | Adaptations to default phone and lazy line resolution above; no framework provider schemas are implied. |
| [`imessage/test/remote/reactions.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/reactions.test.ts) | `actions.test.ts`: all three `reactToMessage` scenarios: native 👍 tapback/record, 🦊 emoji fallback, parent GUID + part index. | `toReactionMessages` inbound event conversion, outbound cache resolution, actor metadata, failed-target dropping are absent. Native delivery diagnostics are not copied onto the facade record. |
| [`imessage/test/remote/unsend.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/unsend.test.ts) | `actions.test.ts`: five of six scenarios: plain retraction, child unwrapping, native/emoji reaction removal, part-targeted reaction removal. | The SDK-rejection/expired-window mock case is not ported here; transport error propagation has separate local gRPC coverage, not an upstream-port claim. |
| [`core/test/core/send-read.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/send-read.test.ts) | `core-actions.test.ts`: `message.read()` dispatches to native chat read, outbound read rejection. | Upstream `read()` content builder, `space.read(message)` overload, unsupported-provider silent no-op do not exist. Facade `space.read()` marks the chat. |
| [`core/test/core/send-unsend.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/send-unsend.test.ts) | `core-actions.test.ts`: message unsend, unsending the reaction handle, inbound unsend rejection. | `unsend()` content builder, `space.unsend(message)`, undefined send-result checks, unsupported-provider silent no-op are absent. |
| [`imessage/test/auth.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/auth.test.ts) | `auth.test.ts`: eight scenarios: unnumbered startup, newly assigned number, known line losing number (retains client/phone and refreshes credentials), provision/deprovision, empty inventory, shared token replacement without recreating client, startup signal independence. | Partial constructor rollback, failed close aggregation, observer re-assertion/failure isolation, stream attachment options, coalesced forced recovery, in-flight cancellation are not asserted by this port. Some cancellation/singleflight behavior has pre-existing local tests (below). |
| [`core/test/core/spectrum.startup.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/spectrum.startup.test.ts) | `core-actions.test.ts`: pre-aborted startup does no I/O; successful instance survives startup signal expiry. | Framework multi-provider rollback, telemetry shutdown and config validation absent. |
| [`core/test/core/spectrum.shutdown.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/core/spectrum.shutdown.test.ts) | `core-actions.test.ts`: prompt close without a subscription; no SIGINT/SIGTERM listeners. | Managed provider streams, multi-provider teardown, subprocess host-drain test not ported. |
| [`core/test/webhook/verify.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/verify.test.ts) | `verify.test.ts`: eleven of twelve scenarios: signed body, tamper/wrong secret, exact/expired tolerance boundary, missing headers, nonnumeric timestamp, malformed/odd signature, empty secret. | Bare hex signature acceptance is deliberately **not compatible**: this SDK requires the `v0=` prefix. Return/error and JSON parsing differences are described above. |
| [`core/test/webhook/spectrum.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/spectrum.test.ts) | `webhook.test.ts`: four scenarios: authenticated delivery, bad signature never calls handler, expired timestamp, Web Request delivery. Repeated under Standard Webhooks as four local extension cases. | Poll identifiers, unknown-event/platform 200 acknowledgement, missing-secret 500, raw overload, fire-and-forget handler behavior and Fusor dispatch are not ported. This facade rejects unknown envelopes/platforms with 400, requires explicit configuration, **awaits** handlers and propagates their errors; it is intentionally not upstream's fire-and-forget handler model. |
| [`spectrum-ts/test/providers-shims.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/spectrum-ts/test/providers-shims.test.ts) | `exports.test.ts`: provider/shim/barrel export identity loop across all exports of the three Workers packages. | Upstream provider const names and other providers absent. |
| [`spectrum-ts/test/imessage-package-boundary.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/spectrum-ts/test/imessage-package-boundary.test.ts) | `exports.test.ts`: original first two scenarios: no local iMessage in umbrella; no imessage-kit/better-sqlite3 in cloud provider. | Node transport dependency installation and explicit local-provider installation tests are not applicable. |

## Existing local tests are not relabeled upstream tests

These tests predate this port. They complement it but are **not** counted in the upstream-derived total:

| Supported capability / upstream comparison | Existing local evidence | Limit |
| --- | --- | --- |
| Text, richlink, binary attachment upload, grouped sends, reply/react/edit/unsend, typing | `tests/runtime-provider.test.ts` | There is no matching ordinary outbound iMessage send test file in this pinned upstream suite; upstream markdown/stream/app send tests require additional features. These are local contract tests, not claimed original tests. |
| Native `getMessage`, ordered parts, child action targets | `tests/runtime-parts.test.ts`, `tests/runtime-downloads.test.ts` | Compared with [`imessage/test/remote/inbound.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/inbound.test.ts), which tests a provider stream, not this native getter. Original sender country/service metadata, reply-target caches, CAF voice classification and provider event subscription are not implemented by the facade. |
| Normalized text/reaction/group/attachment validation and hydration | `tests/webhooks.test.ts`, `tests/runtime-workerd.test.ts` | [`core/test/webhook/deserialize.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/deserialize.test.ts) is not copied: its resolver/context API, raw nested target objects, reply/read/voice/poll/membership/avatar types and custom fallback differ. This facade uses `unknown` fallback, not upstream `custom`, and has a smaller content surface. |
| Token refresh coalescing, aborted initialization, retry after mint failure, inventory routing, lifecycle cancellation | `tests/runtime-lines.test.ts`, `tests/runtime-tokens-workerd.test.ts` | Demand-driven rather than upstream background renewal; not a claim to pass all [`core/test/utils/token-renewal.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/utils/token-renewal.test.ts) scheduler tests. |
| Standard Webhooks signatures, key decoding/rotation, exact byte verification and replay protection | `tests/webhooks.test.ts` | Standard Webhooks are a local extension; upstream's pinned `verify.test.ts` tests only legacy signatures. |
| REST management, binary transport, Worker execution, browser runtime boundary | `tests/api.test.ts`, `tests/grpc.test.ts`, `tests/grpc-workerd.test.ts`, `tests/portable-workerd.test.ts`, `tests/web-boundary.test.ts` | These are independent Workers SDK tests, not upstream framework compatibility. |

## Reviewed features that are absent, not “passed”

* [`imessage/test/remote/message-metadata-integration.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/imessage/test/remote/message-metadata-integration.test.ts) and `message-metadata.test.ts`: full native metadata propagation and cache-first `getMessage` are absent. This facade exposes a smaller normalized message plus direct native RPC access; that does not pass these tests.
* [`core/test/content/text.test.ts`](https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/content/text.test.ts): upstream async `.build()`, stream sources/extractors and empty-text validation are not this SDK's synchronous `text()` API. In particular, this SDK currently permits an empty text value; this is not counted as compatibility with upstream's rejection test.
* `core/test/platform/define.test.ts`, `core/test/core/space.test.ts`, `spectrum.unique-platform-names.test.ts`, `spectrum.env-credentials.test.ts`, `platform-wise-reads.test.ts`, and `utils/provider-packages.test.ts`: no provider registry, arbitrary platform schemas, environment discovery or automatic provider package loading.
* `core/test/core/fusor/{webhook,websocket}.test.ts`, `core/test/utils/{resumable-stream,stream-group,resumable-diagnostics,stream,collect-until-idle}.test.ts`, `imessage/test/remote/{stream,heartbeats,profile-sync-gate,read-receipts}.test.ts`: no Fusor stream, provider subscriptions, resumable cursors, heartbeat/profile synchronization or inbound read-receipt stream. Native typed server streams alone do not imply these semantics.
* `core/test/content/{markdown,app,poll,membership,read,unsend}.test.ts`, `core/test/core/{send-markdown-fallback,send-stream-text-fallback,send-membership,receive-membership,receive-read}.test.ts`, `imessage/test/remote/{markdown,send-markdown,stream-text,app,polls,inbound-app-card,group-events,contact-share}.test.ts`, and `imessage/test/{membership,read-actions,background,contact-card}.test.ts`: framework content builders/fallbacks, formatted streaming text, polls, app cards, membership/group metadata actions and specialized control signals are absent. Only the message/space methods specifically mapped above are tested.
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
