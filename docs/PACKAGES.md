# Spectrum Cloudflare packages

The public repository is [kyeshmz/spectrum-cloudflare](https://github.com/kyeshmz/spectrum-cloudflare).
The original SDK is [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Ownership and imports

| Package | Implementation | Public entry points |
| --- | --- | --- |
| `@spectrum-cloudflare/api` | Management transport and generated operation types | Package root |
| `@spectrum-cloudflare/webhooks` | Signature verification and normalized payload types | Package root |
| `@spectrum-cloudflare/imessage` | Messaging facade, line credentials, attachment lifetime, gRPC transport and protobuf schemas | Root, `/grpc`, `/proto/*` |
| `spectrum-cloudflare` | Compatibility exports | Root, `/api`, `/webhooks`, `/imessage`, `/providers/imessage`, `/grpc`, `/proto/*` |

API and webhooks have no runtime dependencies. iMessage depends on those two
packages and `@bufbuild/protobuf`, `@connectrpc/connect`, and
`@connectrpc/connect-web`. The umbrella depends on all three domain packages.
Each implementation has one owner; cross-package imports use public exports.

```ts
import { Spectrum, imessage, text } from '@spectrum-cloudflare/imessage';
import { SpectrumApi } from '@spectrum-cloudflare/api';
import { verifyLegacySpectrumWebhook } from '@spectrum-cloudflare/webhooks';
import { createIMessageRpc } from '@spectrum-cloudflare/imessage/grpc';
import { MessageService } from '@spectrum-cloudflare/imessage/proto/message_service';
```

The umbrella's matching exports refer to the same module instances. Its protobuf
forwarders are generated from the pinned descriptor inventory. Private files such
as `runtime-lines.ts` are not package exports.

## Build and verify

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:upstream
```

Builds follow the workspace dependency order: API/webhooks, iMessage, umbrella.
`pnpm check` includes the upstream-derived tests, so `test:upstream` is useful for
a focused run. See [test provenance and scope](UPSTREAM-COMPATIBILITY.md).

## Local artifacts before npm publication

All four packages are currently version `0.0.0` and are not published to npm.
Create and verify the installable artifacts:

```sh
pnpm pack:all
pnpm check:packed
```

The full check runs once before packing. `artifacts/` contains:

```text
spectrum-cloudflare-api-0.0.0.tgz
spectrum-cloudflare-webhooks-0.0.0.tgz
spectrum-cloudflare-imessage-0.0.0.tgz
spectrum-cloudflare-0.0.0.tgz
```

The API or webhook package can be installed alone without additional local
packages:

```sh
pnpm add /absolute/path/to/artifacts/spectrum-cloudflare-api-0.0.0.tgz
```

For iMessage or the umbrella, copy the tarballs into your app's `vendor/` directory
and add these overrides to the app's `pnpm-workspace.yaml`:

```yaml
overrides:
  '@spectrum-cloudflare/api': file:./vendor/spectrum-cloudflare-api-0.0.0.tgz
  '@spectrum-cloudflare/webhooks': file:./vendor/spectrum-cloudflare-webhooks-0.0.0.tgz
  '@spectrum-cloudflare/imessage': file:./vendor/spectrum-cloudflare-imessage-0.0.0.tgz
```

Then install the desired entry package:

```sh
pnpm add ./vendor/spectrum-cloudflare-imessage-0.0.0.tgz
# Or the umbrella, for existing spectrum-cloudflare imports:
pnpm add ./vendor/spectrum-cloudflare-0.0.0.tgz
```

Packing converts `workspace:*` dependencies to normal versions. The temporary
local overrides resolve those versions to the same verified artifact set instead
of an unpublished registry release. After a future registry release, regular
versioned dependencies can replace the overrides.

`check:packed` installs each package as an isolated consumer. It type-checks with
no ambient Node types, resolves exported protobuf modules, rejects private
imports, checks standalone dependency graphs, and executes ordinary browser
bundles in real workerd without compatibility flags. The result is saved to
`artifacts/packed-verification.json`.
