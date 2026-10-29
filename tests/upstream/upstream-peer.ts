import { create, toBinary } from '@bufbuild/protobuf';
import { MessageService } from '@spectrum-cloudflare/imessage/proto/message_service';
import { ChatService } from '@spectrum-cloudflare/imessage/proto/chat_service';
import { createSpectrum } from '@spectrum-cloudflare/imessage';
import { frame, runtimeGrpcPeer, type RuntimeCall } from '../fixtures/runtime-grpc-peer.js';

/** Adaptation only: upstream Node SDK mocks become actual protobuf responses. */
export async function upstreamApp(phones: string[] = ['shared'], outputs: Record<string, Record<string, unknown>> = {}) {
  const calls: RuntimeCall[] = [];
  const app = await createSpectrum({ projectId: 'project', projectSecret: 'secret',
    clients: phones.map((phone, index) => ({ phone, token: `token-${index}`, baseUrl: `https://line-${index}.test` })),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const name = new URL(request.url).pathname.split('/').at(-1)!;
      const response = await runtimeGrpcPeer(request, { observe: call => calls.push(call) });
      const output = outputs[name];
      if (!output) return response;
      await response.body?.cancel();
      const method = [...MessageService.methods, ...ChatService.methods].find(item => item.name === name)!;
      const payload = frame(toBinary(method.output, create(method.output, output)));
      const trailers = frame(new TextEncoder().encode('grpc-status: 0\r\n'), 0x80);
      const bytes = new Uint8Array(payload.length + trailers.length);
      bytes.set(payload); bytes.set(trailers, payload.length);
      return new Response(bytes, { headers: { 'content-type': 'application/grpc-web+proto' } });
    },
  });
  return { app, calls };
}
