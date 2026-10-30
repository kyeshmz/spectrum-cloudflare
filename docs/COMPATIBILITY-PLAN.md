# Spectrum consumption compatibility plan

Reference: [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts),
revision `d9e39089dc3d1c6f4536826f5ca50798856eecab`.

## Target application

```ts
import { Spectrum, text } from 'spectrum-cloudflare';
import { imessage } from 'spectrum-cloudflare/providers/imessage';

const app = await Spectrum({
  projectId: env.PROJECT_ID,
  projectSecret: env.PROJECT_SECRET,
  providers: [imessage.config()],
});

try {
  for await (const [space, message] of app.messages) {
    if (message.content.type === 'text') {
      await space.responding(() => message.reply(text('Hello!')));
    }
  }
} finally {
  await app.stop();
}
```

This is the compatibility acceptance shape for supported cloud iMessage code:
package-name changes and explicit Worker environment bindings. The host owns the
execution lifetime of the loop. A short-lived HTTP Worker should use authenticated
webhook delivery instead of assuming a background loop survives its request.

## Shape and ownership

Two candidates were considered: importing/recreating the generalized Spectrum
core with a provider registry, or extending the existing iMessage runtime with a
small configuration/selector boundary. The latter keeps one credential inventory,
one message materializer, one attachment lifetime owner, and one app shutdown path.
It also preserves standalone iMessage consumption without installing a generalized
framework. Public package exports enforce the boundary.

The configuration boundary translates upstream provider configuration into the
existing Web transport options. The runtime owns message dispatch and decoration.
Content builders own input validation and resolution. A private subscription
module owns iterator merging, backpressure, and cancellation; it delegates native
message materialization to the runtime.

## Implementation work

1. **Factory/provider compatibility (Sol):** add `Spectrum`, `imessage.config()`,
   `imessage(app/space/message)`, provider user/space lookup and creation, app config,
   and `stop()`. Adapt upstream explicit client `address` to Web transport URLs.
   Reject unsupported provider configurations explicitly.
2. **Content compatibility (Sol):** add structural async `ContentBuilder` support
   for static text, links, Web attachments, groups, reply/reaction/edit/unsend/read,
   and typing. Keep existing plain-value inputs usable. Validate outbound content
   at resolution; received content is not an outbound builder. Filesystem paths
   remain unavailable. Binary values remain `Uint8Array`.
3. **Runtime helpers (Sol):** resolve builders through a single send path; support
   variadic sends/replies and upstream space helper signatures. `responding()`
   must stop typing in `finally`, preserving the callback result/error and
   swallowing stop-typing failures as upstream does.
4. **Native iteration (Sol):** expose lazy `app.messages` and provider iteration
   backed by the pinned native event RPCs. Route by line, ignore heartbeats and
   outbound/status-only events, preserve multipart identities, and reuse native
   parsing. Consumers share a bounded broadcast; returning the last consumer
   cancels native subscriptions. Stopping the app terminates every pending
   iterator. Inventory changes flow from the existing line owner, and protocol
   failures reach all consumers.
5. **Integration and evidence:** export `/providers/imessage` from the umbrella,
   retain standalone packages, and compile/run upstream-style consumption against
   deterministic binary gRPC-Web fixtures. Add source-linked upstream-derived
   scenarios and keep the previous regression suite intact.

## Acceptance gates

- Exact supported upstream call shapes compile against public package exports.
- Native iterator tests cover lazy start, multi-line merge, heartbeat filtering,
  multipart messages, failed trailers, iterator return, and app stop.
- Existing startup-signal isolation, refresh singleflight, dedicated routing,
  known-phone retention, webhook authentication, and attachment cleanup pass.
- Independent Sol review checks actual behavior and lifetime failure cases.
- `SPECTRUM_UPSTREAM_CHECKOUT=/path/to/pinned/checkout pnpm pack:all` passes.
- `pnpm check:packed` executes all four isolated packages in workerd with no Node
  globals or compatibility flags, including the compatible factory/provider API.
- The packaged Worker example passes Wrangler's normal dry-run build.
- Documentation records supported signatures, upstream test lineage, and remaining
  differences; it distinguishes local transport evidence from live delivery.

## Scope boundaries

This increment targets the supported cloud iMessage application model. Other
providers, generalized provider authoring, environment discovery, telemetry,
Fusor/resumable reconnection, streaming text/Markdown, polls/app-card builders,
and macOS filesystem integrations remain separate work. Typed native RPC access
continues to expose advanced operations without claiming high-level parity.

Webhooks authenticate untouched bytes and await callbacks. That deliberate
Worker-oriented behavior differs from upstream's fire-and-forget callback model.
Hosted Photon/device delivery still requires a credentialed integration run.

## Implemented and verified — 2026-10-30

- Implemented the factory/provider selectors, explicit-client configuration,
  structural async builders, variadic sends/replies, space helpers, raw-byte
  webhooks, and lazy app/provider native received-message iteration above.
- Independent Sol reviews covered stream ownership and error teardown, builder
  execution, authoritative lookups, and cross-phone target resolution. Follow-up
  regressions cover single builder execution, module-scope attachment construction,
  edited/retracted multipart records, and canonical destination/target phones.
- `SPECTRUM_UPSTREAM_CHECKOUT=<pinned-checkout> pnpm pack:all` passed **342 checks
  across 27 files**: 324 ordinary tests plus all 18 upstream source-hash audits.
  Both generated-contract checks, package builds, source/test typechecks, and the
  example build passed.
- `pnpm check:packed` passed for all four packages: isolated public types and ESM
  exports, browser dependency graphs, and actual workerd without Node types,
  globals, aliases, or compatibility flags. The iMessage consumers exercise
  `Spectrum`, `imessage.config`, native iteration, `responding`, reply, and stop.
- The example copied from the newly packed umbrella passed Wrangler **4.155.0**
  `deploy --dry-run`: **395.64 KiB / 82.04 KiB gzip**, with ordinary bundling and
  no compatibility flags. Nothing was deployed or published to npm.
- Future upstream adoption uses the actual **oc-port-agent** CLI and tracked
  policies; see [UPSTREAM-PORTING.md](UPSTREAM-PORTING.md).
