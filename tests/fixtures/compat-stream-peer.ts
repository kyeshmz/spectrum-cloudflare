// Local binary gRPC-Web evidence only; no hosted Photon/device delivery claim.
import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import {
  SubscribeMessageEventsRequestSchema,
  SubscribeMessageEventsResponseSchema,
} from '../../packages/imessage/src/generated/photon/imessage/v1/message_service_pb.js';
import { grpcFrame, grpcTrailers } from './grpc-peer.js';

export type StreamFrame = MessageInitShape<typeof SubscribeMessageEventsResponseSchema>;
export const sequence = 9_007_199_254_740_993n;

export function received(id = 'message', seq = sequence, fromMe = false): StreamFrame {
  return { sequence: seq, payload: { case: 'messageChanged', value: {
    chatGuid: 'any;-;peer', occurredAt: { seconds: 200n },
    change: { case: 'messageReceived', value: { message: {
      guid: id, chatGuids: ['any;-;peer'], isFromMe: fromMe,
      dateCreated: { seconds: 100n }, sender: { address: 'peer' },
      content: { text: 'hello' },
    } } },
  } } };
}

export function compatStreamPeer() {
  const calls: { request: Request; body: Uint8Array }[] = [];
  const connections: {
    host: string;
    push(frame: StreamFrame): void;
    end(status?: number): void;
    canceled: boolean;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.endsWith('/photon.imessage.v1.MessageService/SubscribeMessageEvents')) {
      throw new Error(`Unexpected RPC ${request.url}`);
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body[0] !== 0 || new DataView(body.buffer).getUint32(1) !== body.length - 5) throw new Error('Invalid gRPC framing');
    const decoded = fromBinary(SubscribeMessageEventsRequestSchema, body.subarray(5));
    if (decoded.chatGuid !== undefined) throw new Error('Unexpected chat filter');
    calls.push({ request, body });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const connection = {
      host: new URL(request.url).hostname,
      canceled: false,
      push(frame: StreamFrame) {
        if (closed) throw new Error('Fixture stream closed');
        const bytes = grpcFrame(toBinary(SubscribeMessageEventsResponseSchema, create(SubscribeMessageEventsResponseSchema, frame)));
        // Exercise framing across a split length prefix.
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
      },
      end(status = 0) {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener('abort', abort);
        controller.enqueue(grpcTrailers(status));
        controller.close();
      },
    };
    const abort = () => {
      if (closed) return;
      closed = true;
      connection.canceled = true;
      controller.error(request.signal.reason);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      },
      cancel() {
        closed = true;
        connection.canceled = true;
        request.signal.removeEventListener('abort', abort);
      },
    });
    connections.push(connection);
    return new Response(stream, { headers: { 'content-type': 'application/grpc-web+proto' } });
  };
  return { fetch, calls, connections };
}
