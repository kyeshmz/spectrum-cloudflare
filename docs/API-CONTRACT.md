# Stable Spectrum API contract

Researched 2026-10-28. This package's management client targets **Stable Spectrum**,
not Photon Beta/2.0. The management and webhook-verification modules use only
fetch, Web APIs, and Web Crypto. The root Spectrum-adjacent facade is also Web-only;
its messaging behavior is covered by [the runtime contract](RUNTIME-CONTRACT.md).

## Sources and revision

- [Stable documentation index](https://docs.photon.codes/docs/llms.txt)
- [Spectrum introduction](https://photon.codes/docs/api-reference/introduction)
- [Live Spectrum OpenAPI](https://spectrum.photon.codes/openapi/json)
- [Stable rate limits](https://photon.codes/docs/api-reference/rate-limit)
- [Legacy events](https://photon.codes/docs/webhooks/events)
- [Legacy verification](https://photon.codes/docs/webhooks/verifying-signatures)
- [Legacy delivery](https://photon.codes/docs/webhooks/delivery)
- [Legacy webhook management prose](https://photon.codes/docs/webhooks/managing-webhooks)
- [Dashboard OAuth](https://photon.codes/docs/api-reference/oauth)
- [Standard Webhooks specification 1.0.0](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)

The checked-in `spec/spectrum-openapi.json` is the live external API 1.0.0 snapshot:
38 paths, **54 method/path pairs**, SHA-256 of the formatted snapshot:
`8aaa5c842a429d8e07b738418a76f155ea67ddc0128896d7281884c34822c3d3`.
No Beta sources were used. No authenticated API calls were made.

`node scripts/generate-api.mjs` regenerates `src/api-types.ts` and
`src/api-routes.ts` from that snapshot without network access or dependencies.
`node scripts/generate-api.mjs --check` verifies both generated outputs.
To intentionally update the contract, download and review a new official snapshot,
then pass its local filename to the generator. Update this revision record too.
The generator rejects unsupported references rather than silently weakening types.

## Public API and ownership

`SpectrumApi` owns origin, credentials, fetch, and request deadlines. A generated
operation map replaces dozens of redundant resource wrappers. Literal method/path
arguments select the exact input and success-data type:

```ts
const api = new SpectrumApi({ projectId, projectSecret });
const { users, total } = await api.request('GET', '/projects/{projectId}/users/', {
  query: { limit: 50, offset: 0, id: ['first-uuid', 'second-uuid'] },
});
const user = await api.request('GET', '/projects/{projectId}/users/{userId}/', {
  path: { userId },
});
```

- Project ID is supplied by the instance, never by an operation's path options.
- Other path parameters, required query fields, and bodies are compile-time required.
- Slash spelling is pinned exactly. Array query values become repeated keys.
- Basic auth uses UTF-8 bytes; no credentials appear in URL strings.
- The HTTPS base URL must be an origin, not a path, URL with credentials, or query.
  A custom origin is an explicit trust decision: it will receive project credentials.
- Opaque path segments reject slash, backslash, percent escapes, URL delimiters,
  control characters, and dot/dot-dot traversal.
- All fetches use `redirect: 'manual'`, supported by workerd without Node
  compatibility. Management 3xx responses are explicitly rejected as
  `SpectrumApiError`, preserving status, headers (including Location), and body;
  credentials are never forwarded to a redirect destination. The public redirect
  operation sends no auth and returns its manual 302 `Response` directly.
  `userRedirectUrl(userId, {msg})` remains preferable for external navigation.
- Success returns the `data` field. Only the envelope is checked at runtime, not
  every resource field. Compile-time response types derive from the pinned schema.
- `SpectrumApiError` preserves status, response headers, raw text, parsed body,
  optional server code, and `kind: 'http' | 'invalid-response'`.
- Network/abort exceptions remain native errors. Finite timeouts default to 30s,
  can be overridden per request, and cover native fetch/body consumption. An
  injected fetch implementation must honor its supplied AbortSignal.
- No automatic retries, pagination loops, billing side effects, or token cache.
- Default service rate limit is 5 requests/sec/project; callers schedule requests.

## Authentication boundaries

Spectrum is `https://spectrum.photon.codes` with project-secret HTTP Basic auth and
no `/v1` prefix. Dashboard `https://app.photon.codes/api/...` uses user Bearer
tokens/OAuth and handles project creation/secret rotation. Beta
`https://api.photon.codes/v1` is a different product/contract. Neither is included
in this management client. There is no Stable management HTTP send-message,
message-history, space lookup, or attachment-download endpoint.

## Webhook verification

Both helpers take `{body, headers, secret, now?, toleranceSeconds?}` and resolve
to **unknown parsed JSON only after verification**. Read `request.arrayBuffer()`
before parsing JSON, and pass those bytes plus `request.headers`. To retain the
request body for other code, read a clone. Invalid verification throws
`WebhookVerificationError` with a categorical code. Helpers do not acknowledge,
enqueue, deduplicate, or automatically fall back to another scheme.

Legacy `verifyLegacySpectrumWebhook`:

- Uses `X-Spectrum-Timestamp` and one lowercase `v0=<64 hex>` signature.
- Signs `UTF8('v0:' + timestamp + ':') || rawBody` using HMAC-SHA256.
- The key is the **literal UTF-8 legacy secret**, not decoded hex/base64.

Standard `verifyStandardWebhook` (symmetric v1 only):

- Uses `webhook-id`, `webhook-timestamp`, and space-separated `v1,<base64>` signatures.
- Signs `UTF8(id + '.' + timestamp + '.') || rawBody` using HMAC-SHA256.
- Removes `whsec_` and base64-decodes the remainder to **24–64 secret bytes**,
  following the official Standard Webhooks specification.
- Multiple validly encoded v1 signatures support key overlap; one must verify.
  Unsupported schemes may coexist but are never trusted.
- IDs cannot contain a dot, whitespace, or comma; timestamps use strict safe,
  nonnegative decimal integer syntax. Noncanonical base64 is rejected.

Both use native `crypto.subtle.verify` and check absolute past/future timestamp
distance (default 300 seconds). Invalid signed UTF-8/JSON is rejected *after*
authentication. Independent Python stdlib HMAC fixtures in the tests cover Unicode,
binary-body byte preservation, multiple signatures, tampering, and replay checks.

Raw `raw-inbound.v1` payloads remain unknown: the official Stable sources fetched
here do not provide their complete schema. `webhook-types.ts` documents only
legacy normalized events. The normalized body event is `messages`, not the
management subscription string `message.received`; these must not be conflated.
Additional content/platform fields are intentionally tolerated. Album child
messages may omit `space` in the official example.

For ergonomic narrowing, import `isNormalizedSpectrumContent` from the portable
`webhooks` module. The forward-compatible `SerializedSpectrumContent` type keeps
unknown arms, so a discriminator check alone cannot prove that a field is safe.
The guard validates required and optional fields, including nested reaction refs,
contact fields, and album-message children. Unknown future child content arms are
tolerated; unknown root arms return false. Extra fields remain allowed.

```ts
// After signature verification and selecting a message's content:
if (isNormalizedSpectrumContent(content)) {
  if (content.type === 'text') console.log(content.text.toUpperCase());
  if (content.type === 'reaction') console.log(content.target.id);
} else {
  // Unknown future arm or malformed known content: log/ignore deliberately.
}
```

This guard does not authenticate the request or validate an entire event envelope.

## Known official documentation mismatches

Prefer the pinned live management schema over older prose:

1. Prose says create/list/delete only, one secret, and no rotation endpoint. Live
   schema has six webhook operations, schema-version selection, subscriptions,
   enable/disable, egress IPs, and both one-time secrets. Standard rotation does
   **not** rotate the legacy secret.
2. Live schema marks webhook create `schemaVersion` and `eventTypes`, rotation
   `overlapSeconds`, and template-list `limit` required despite documenting defaults.
   The typed client requires explicit values rather than guessing defaulting behavior.
3. Live webhook DELETE has no trailing slash; older prose adds one.
4. The prose's register-same-URL-before-delete rotation recipe contradicts its
   own documented 409 duplicate-URL rule. Prefer Standard rotation with overlap.
5. Prose says no event filtering; live subscription/enabled updates exist but
   return 409 until the endpoint is upgraded to raw. Schema upgrades are one-way,
   must be sent separately from settings changes, and may briefly overlap sources.
6. Legacy delivery prose describes six attempts, 30s attempt timeout, bounded
   jittered retries, fatal redirects/most 4xx, no DLQ, no ordering guarantee, and
   possible loss. Do **not** promise this applies unchanged to Fusor raw delivery.
7. Legacy prose suggests API message reconciliation, but the live management
   spec has no message-history API. Use a separately supported runtime SDK instead.
8. GET project prose suggests optional profile, while its schema requires it.
   Runtime decoding deliberately does not reject future/omitted resource fields.
9. Error prose omits `data`/`code` shown in the schema. Error parsing tolerates both.
10. Auth isn't described as an OpenAPI security scheme; it is wired from official
    operation descriptions/introduction. Public redirect is explicitly auth-free.

## Delivery application responsibilities

Verify before parsing/trusting, durably enqueue before acknowledging 2xx, and
dedupe atomically. Standard dedupe ID is `webhook-id` (event ID); legacy dedupe ID
is opaque `message.id`, optionally scoped by `X-Spectrum-Webhook-Id` (registration
ID). Those two header IDs have different meanings. Do not rely on bare fire-and-
forget promises surviving a Worker response. Delivery destinations must be final
public HTTPS URLs without redirects. Registration syntax validation alone does
not prove delivery eligibility.
