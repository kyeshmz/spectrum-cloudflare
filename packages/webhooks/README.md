# @spectrum-cloudflare/webhooks

Standalone **Legacy Spectrum and Standard Webhooks verification**, using native
Web Crypto. No runtime dependencies, Node/Bun APIs, or compatibility flags.

Part of [Spectrum Cloudflare](https://github.com/kyeshmz/spectrum-cloudflare),
with behavior and tests derived from the original
[Photon Spectrum SDK](https://github.com/photon-hq/spectrum-ts).

```ts
import {
  verifyLegacySpectrumWebhook,
  isNormalizedSpectrumContent,
} from '@spectrum-cloudflare/webhooks';

const payload = await verifyLegacySpectrumWebhook({
  body: await request.arrayBuffer(),
  headers: request.headers,
  secret: env.SPECTRUM_WEBHOOK_SECRET,
});
// payload is unknown: validate its envelope/content before using it.
```

`verifyStandardWebhook` accepts the same options with a `whsec_` Standard signing
secret. Choose the signature scheme explicitly. Both helpers authenticate exact
wire bytes before parsing JSON, reject stale timestamps, and throw
`WebhookVerificationError` on invalid deliveries.

`isNormalizedSpectrumContent` validates known normalized content and supports
discriminated-union narrowing. The package exports payload and verification types.

Version `0.0.0` is available as a local workspace/package artifact. See
[installation](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/PACKAGES.md)
and [signature contracts](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/API-CONTRACT.md#webhook-verification).
