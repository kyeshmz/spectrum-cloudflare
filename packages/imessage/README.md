# @spectrum-cloudflare/imessage

Spectrum-adjacent iMessage messaging for Cloudflare Workers: spaces, replies,
reactions, edits, attachments, and **51 typed Photon gRPC methods**.

Part of [Spectrum Cloudflare](https://github.com/kyeshmz/spectrum-cloudflare).
The original SDK is [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts);
our [compatibility tests](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/UPSTREAM-COMPATIBILITY.md)
record the pinned upstream source and supported behavior.

```ts
import { createSpectrum, text } from '@spectrum-cloudflare/imessage';

const app = await createSpectrum({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
});
try {
  const space = app.space('any;-;+15551112222', { phone: 'shared' });
  const sent = await space.send(text('Hello from a Worker'));
  await sent.reply('Threaded reply');
} finally {
  await app.close();
}
```

## Native services

Use `await app.rpc(phone)` for message, chat, group, attachment, address, event,
poll, and location services. For an independently owned native client:

```ts
import { createIMessageRpc } from '@spectrum-cloudflare/imessage/grpc';
import { MessageReactionKind } from '@spectrum-cloudflare/imessage/proto/message_types';
```

Protobuf bytes remain `Uint8Array` and uint64 values remain `bigint`. Uploads are
unary; downloads and subscriptions are server-streaming. `close()` cancels owned
requests and streams.

The deployed runtime uses Web APIs only. Hosted calls to Photon's native hosts
need Cloudflare's outbound gRPC-Web-to-gRPC translation support; local workerd
tests use real binary gRPC-Web peers. See the
[runtime contract](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/RUNTIME-CONTRACT.md)
for routing, lifecycle, and hosted verification details.

Version `0.0.0` is available as a local workspace/package artifact. See
[installation](https://github.com/kyeshmz/spectrum-cloudflare/blob/main/docs/PACKAGES.md).
