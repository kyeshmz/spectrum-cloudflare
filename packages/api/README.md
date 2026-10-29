# @spectrum-cloudflare/api

Standalone Web-only client for **54 Stable Spectrum management operations**.
It has no runtime dependencies and uses native fetch, AbortSignal, and UTF-8
Basic authentication.

Part of [Spectrum Cloudflare](https://github.com/kyeshmz/spectrum-cloudflare),
adapted from the contracts used by the original
[Photon Spectrum SDK](https://github.com/photon-hq/spectrum-ts).

```ts
import { SpectrumApi } from '@spectrum-cloudflare/api';

const api = new SpectrumApi({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
});

const { users, total } = await api.request('GET', '/projects/{projectId}/users/', {
  query: { limit: 50, offset: 0 },
});
```

Literal method/path arguments select generated request and response types.
Responses unwrap the `data` envelope. `SpectrumApiError` preserves HTTP status,
headers, and upstream error data. Timeouts and cancellation cover response-body
consumption; redirects are rejected and requests are not retried automatically.

This package targets Stable `https://spectrum.photon.codes`. For iMessage sends,
use `@spectrum-cloudflare/imessage`.

Version `0.0.0` is available as a local workspace/package artifact. See
[installation](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/PACKAGES.md)
and the [API contract](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/API-CONTRACT.md).
