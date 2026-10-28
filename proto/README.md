# Photon gRPC contract snapshot

These `.proto` files are the unmodified snapshot shipped in
`@photon-ai/advanced-imessage@2.4.0`. Its `prepublishOnly` exports precisely
`buf.build/photon-hq/imessage:d271d841bb604a8ea53556dfb1a77ac4`.
`snapshot.json` records that provenance and SHA-256 for every source file.
Photon sources are MIT licensed; Google API annotation sources retain their
Apache-2.0 notices. The originating Photon repository is
https://github.com/photon-hq/advanced-imessage-ts.

Generate checked-in Protobuf-ES v2 messages and service descriptors with
`node scripts/generate-grpc.mjs`; verify with
`node scripts/generate-grpc.mjs --check`. Both `buf` and `protoc-gen-es` must
be on PATH. Reproducible tool versions: `@bufbuild/buf@1.69.0` and
`@bufbuild/protoc-gen-es@2.16.0` (runtime `@bufbuild/protobuf@2.16.0`).
Generation is offline from this snapshot and does not contact the BSR.

For an intentional snapshot update, first obtain the pinned module with
`buf export <module>:<commit> -o <snapshot-directory>`, then update the pin in
the generation script and run its `--snapshot-source <snapshot-directory>`
option. Review the source and generated diffs together.

Updates stage an exact source inventory and compile it before touching the
checked-in files. Successful updates replace `.proto` and generated `_pb.ts`
inventories, removing files deleted upstream rather than overlaying the old
snapshot. README files, licenses, configuration, and other files are preserved.
Failed validation or compilation leaves the current snapshot and generated
modules unchanged. A replacement manifest identifies an explicitly supplied
snapshot rather than silently retaining the original npm-package provenance;
verify the source commit when reviewing an intentional update.

The generated service clients use gRPC-Web over fetch. Production Cloudflare
Workers require Cloudflare's outbound gRPC-Web-to-gRPC translation rollout;
local gRPC-Web fixtures test the client protocol, not that infrastructure.

## Public low-level imports

Import the transport factory from `spectrum-cloudflare/grpc`. Photon schemas,
service descriptors, and enum values have the deliberate `./proto/*` public
subpath, without the generated `_pb` suffix:

```ts
import { createIMessageRpc } from "spectrum-cloudflare/grpc";
import { MessageService, SendTextMessageRequestSchema }
  from "spectrum-cloudflare/proto/message_service";
```

Other modules follow their protobuf filenames, for example
`spectrum-cloudflare/proto/message_types`, `proto/chat_service`, and
`proto/attachment_service` (each with the `spectrum-cloudflare/` prefix).
Generated Google annotation modules are implementation details; standard
well-known protobuf schemas are available from `@bufbuild/protobuf/wkt`.
