// A local binary gRPC-Web peer, not a simulation of Cloudflare's production
// gRPC-Web-to-native-gRPC translation. No Photon endpoints are contacted.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { GetChatCountResponseSchema } from "@spectrum-cloudflare/imessage/proto/chat_service";
import {
  DownloadAttachmentResponseSchema,
  UploadAttachmentRequestSchema,
  UploadAttachmentResponseSchema,
} from "@spectrum-cloudflare/imessage/proto/attachment_service";
import { SubscribeMessageEventsResponseSchema } from "@spectrum-cloudflare/imessage/proto/message_service";

export const grpcBigint = 9_007_199_254_740_993n;
export const grpcBytes = new Uint8Array([0, 255, 128, 13, 10, 42]);

export function grpcFrame(payload: Uint8Array, flags = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = flags;
  new DataView(bytes.buffer).setUint32(1, payload.length, false);
  bytes.set(payload, 5);
  return bytes;
}

export function grpcTrailers(status = 0): Uint8Array<ArrayBuffer> {
  return grpcFrame(new TextEncoder().encode(status === 0
    ? "grpc-status: 0\r\n"
    : `grpc-status: ${status}\r\ngrpc-message: fixture%20denied\r\nerror-code: FIXTURE_DENIED\r\nx-retryable: false\r\n`), 0x80);
}

export interface GrpcObservation {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  routingHeader: string | null;
  body: Uint8Array;
}

export async function grpcPeer(request: Request, hooks: {
  observe?: (observation: GrpcObservation) => void;
  cancel?: () => void;
} = {}): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  hooks.observe?.({
    url: request.url, method: request.method,
    authorization: request.headers.get("authorization"),
    contentType: request.headers.get("content-type"),
    routingHeader: request.headers.get("x-photon-server"), body,
  });
  if (body.length < 5 || body[0] !== 0 || new DataView(body.buffer).getUint32(1, false) !== body.length - 5) {
    throw new Error("Expected exactly one uncompressed binary gRPC request message");
  }
  const url = new URL(request.url);
  const mode = url.hostname.split(".")[0];
  if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://not-authorized.invalid" } });
  const frames: Uint8Array[] = [];
  if (mode !== "error") {
    if (url.pathname.endsWith("/GetChatCount")) {
      frames.push(grpcFrame(toBinary(GetChatCountResponseSchema, create(GetChatCountResponseSchema, { count: grpcBigint }))));
    } else if (url.pathname.endsWith("/MarkChatRead")) {
      frames.push(grpcFrame(toBinary(EmptySchema, create(EmptySchema))));
    } else if (url.pathname.endsWith("/UploadAttachment")) {
      const uploaded = fromBinary(UploadAttachmentRequestSchema, body.subarray(5));
      if (uploaded.fileName !== "binary.bin" || uploaded.data.toString() !== grpcBytes.toString()) throw new Error("Attachment bytes changed");
      frames.push(grpcFrame(toBinary(UploadAttachmentResponseSchema, create(UploadAttachmentResponseSchema, {
        attachment: { guid: "uploaded", fileName: uploaded.fileName, totalBytes: BigInt(uploaded.data.length) },
      }))));
    } else if (url.pathname.endsWith("/DownloadAttachment")) {
      for (const payload of [
        { case: "header" as const, value: { attachment: { guid: "uploaded", totalBytes: 6n } } },
        { case: "primaryChunk" as const, value: grpcBytes },
      ]) frames.push(grpcFrame(toBinary(DownloadAttachmentResponseSchema, create(DownloadAttachmentResponseSchema, { payload }))));
    } else if (url.pathname.endsWith("/SubscribeMessageEvents")) {
      for (const sequence of [grpcBigint, grpcBigint + 1n]) {
        frames.push(grpcFrame(toBinary(SubscribeMessageEventsResponseSchema, create(SubscribeMessageEventsResponseSchema, {
          sequence, payload: { case: "heartbeat", value: {} },
        }))));
      }
    } else {
      throw new Error(`Unexpected fixture method: ${url.pathname}`);
    }
  }
  if (mode !== "missing" && mode !== "stream") frames.push(grpcTrailers(mode === "error" ? 7 : 0));
  const all = new Uint8Array(frames.reduce((size, frame) => size + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { all.set(frame, offset); offset += frame.length; }
  let cursor = 0;
  let abort: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => { hooks.cancel?.(); controller.error(request.signal.reason); };
      request.signal.addEventListener("abort", abort, { once: true });
    },
    pull(controller) {
      if (cursor < all.length) {
        // Split every length prefix, protobuf field, and trailer across chunks.
        controller.enqueue(all.slice(cursor, ++cursor));
      } else if (mode !== "stream") {
        request.signal.removeEventListener("abort", abort);
        controller.close();
      }
    },
    cancel() {
      request.signal.removeEventListener("abort", abort);
      hooks.cancel?.();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/grpc-web+proto" } });
}
