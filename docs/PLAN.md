# Web-only integration plan

## Architecture

The user requested a Spectrum-adjacent Worker API without Bun or Node runtime
dependencies. The previous official-core/Node-compatibility adapter is replaced
by a Web-only facade and Buf/Connect Photon gRPC transport. Node remains a
development-tooling dependency only.

## Integration work

- Use `createSpectrum`, request-scoped spaces and message decorators, typed native
  services, and awaited `close()` rather than the official core/provider system.
- Retain the typed Stable management client, pinned 54-operation contract, and
  explicit Standard/legacy webhook verification. Signature scheme and payload
  `schemaVersion` are independent axes.
- Use ordinary Wrangler TypeScript bundling without `nodejs_compat` or a custom
  runtime build helper. Keep package self-reference imports in the example.
- Verify webhook bytes before network initialization; accept documented `iMessage`
  and compatible lowercase `imessage`, preserve phone routing, await send and
  teardown, and expose no public send route.
- Migrate the actual-workerd example test to binary protobuf gRPC-Web. Assert no
  Node globals or aliases, correct token minting/auth/origins, zero-egress rejection,
  held-open send lifetime, and cleanup after success/failure.

## Implementation and review

- All 54 pinned management operations have generated input and response types.
- All 51 Photon RPCs use actual Protobuf-ES service descriptors from 18 pinned
  source modules, with offline generation and drift checks.
- The facade and example run in actual workerd without Node compatibility. Binary
  gRPC-Web peers exercise messaging, attachments, cancellation, and token routing.
- Signed webhook tests cover both `iMessage` and `imessage`; an independent
  workerd probe also covers Standard signatures, nested album aliases, inherited
  dedicated routing, multipart action indexes, and tamper rejection.
- Independent review fixes have regressions for custom lifetime abort reasons,
  shared-refresh cancellation isolation, shared/dedicated hostname selection,
  and exact replacement of protobuf inventories during snapshot updates.
- Source and test typechecks pass; obsolete core-specific fixtures are removed.
- Plain esbuild and pinned Wrangler `4.155.0` dry-run builds accept the Worker
  example without compatibility shims.

## Package gate

`pnpm check` verifies both generated contracts, builds package exports, type-checks
source and tests, runs the complete suite, and builds the example. `pnpm pack`
runs that gate through `prepack`.

Verify a release tarball in an isolated consumer with no ambient Node types:
type-check public root/API/webhook/gRPC/protobuf imports, bundle with ordinary
browser-target esbuild, execute it in workerd without compatibility flags, and
dry-run the shipped example with Wrangler. This checks the packaged artifact
separately from repository self-references.

### Final local verification — 2026-10-28

- `pnpm pack` completed its full `prepack` gate: **189 tests across 14 files**,
  both generation checks, source/test typechecks, and the example build passed.
- Installed the resulting `spectrum-cloudflare-0.0.0.tgz` in an isolated consumer.
  Public imports type-checked with `types: []` and `skipLibCheck: false`.
- Its ordinary browser bundle ran in workerd without compatibility flags, loaded
  every root export, exercised management and binary gRPC-Web calls, preserved a
  uint64 above `Number.MAX_SAFE_INTEGER`, and reported Buffer/process absent.
- Wrangler `4.155.0` dry-ran the example copied from that tarball successfully:
  **77.01 KiB gzip**, using its standard TypeScript entry and bundling.

## Hosted prerequisite and sample boundary

Cloudflare's [outbound gRPC announcement](https://blog.cloudflare.com/grpc-workers/)
documents `createGrpcWebTransport` with native fetch `redirect: 'manual'` and
automatic gRPC-Web-to-native translation, announced as a private beta rolling out.
Hosted use requires account enablement; local gRPC-Web peers prove protocol
behavior, not native HTTP/2 translation or delivery to an Apple device.
Local Wrangler/Miniflare does not supply that translation, so native Photon hosts
need verification from a hosted/remote Worker after account enablement. This uses
outbound fetch translation, not Cloudflare's separate Spectrum TCP product.

Project-token discovery selects Photon shared/dedicated gRPC origins. No separate
HTTP middleware URL is required. Package version `0.0.0` remains local integration
status, not proof of registry publication. The example sends before acknowledging,
so retry ambiguity can duplicate receipts; application deduplication and queueing
remain outside the sample.
