import { create, fromBinary, toBinary, toJson, type DescMessage } from '@bufbuild/protobuf';
import { MessageService } from '@spectrum-cloudflare/imessage/proto/message_service';
import { ChatService } from '@spectrum-cloudflare/imessage/proto/chat_service';
import { AttachmentService, UploadAttachmentRequestSchema } from '@spectrum-cloudflare/imessage/proto/attachment_service';

export interface RuntimeCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly routing: string | null;
  readonly input: Record<string, unknown>;
}

export interface RuntimePeerOptions {
  wireText?: string;
  guids?: readonly string[];
  missingGuids?: readonly string[];
  blockedDownload?: boolean;
  downloadStatus?: number;
  observe?: (call: RuntimeCall) => void;
  started?: () => void;
  cancelled?: () => void;
}

export function frame(payload: Uint8Array, flags = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(payload.length + 5);
  bytes[0] = flags;
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}

function encode(schema: DescMessage, input: Record<string, unknown>): Uint8Array {
  return frame(toBinary(schema, create(schema, input)));
}

const stamp = { seconds: 1_785_369_600n, nanos: 0 };
const attachmentInfo = (guid: string) => ({ guid, fileName: `${guid}.png`, mimeType: 'image/png', totalBytes: 3n });

/** Real binary gRPC-Web peer using the same published protobuf descriptors. */
export async function runtimeGrpcPeer(request: Request, options: RuntimePeerOptions = {}): Promise<Response> {
  const name = new URL(request.url).pathname.split('/').at(-1)!;
  const method = [...MessageService.methods, ...ChatService.methods, ...AttachmentService.methods].find(candidate => candidate.name === name);
  if (!method) {
    throw new Error(`Unexpected fixture RPC ${name}`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 5 || bytes[0] !== 0 || new DataView(bytes.buffer).getUint32(1) !== bytes.length - 5) {
    throw new Error('Expected exactly one binary gRPC request');
  }
  const input = toJson(method.input, fromBinary(method.input, bytes.subarray(5))) as Record<string, unknown>;
  options.observe?.({ method: name, url: request.url, authorization: request.headers.get('authorization'), routing: request.headers.get('x-photon-server'), input });
  const message = { guid: 'sent', dateCreated: stamp, isFromMe: true, chatGuids: ['any;-;peer'], content: { text: 'sent', attachments: [] } };
  let output: Record<string, unknown> = {};
  let status = 0;
  const frames: Uint8Array[] = [];
  switch (name) {
    case 'GetMessage':
      output = { message: { ...message, guid: 'parent', content: { text: options.wireText ?? '\uFFFCcaption', attachments: (options.guids ?? ['photo']).map(attachmentInfo) } } };
      break;
    case 'SendTextMessage':
    case 'SendAttachmentMessage':
    case 'SendMultipartMessage':
    case 'EditMessage':
    case 'SetReaction':
      output = { message };
      break;
    case 'CreateChat':
      output = { chat: { guid: 'any;+;group', isGroup: true } };
      break;
    case 'GetAttachmentInfo': {
      const guid = input.attachmentGuid as string;
      if (options.missingGuids?.includes(guid)) {
        status = 5;
      } else {
        output = { attachment: attachmentInfo(guid) };
      }
      break;
    }
    case 'UploadAttachment': {
      const uploaded = fromBinary(UploadAttachmentRequestSchema, bytes.subarray(5));
      output = { attachment: { ...attachmentInfo('uploaded'), fileName: uploaded.fileName, totalBytes: BigInt(uploaded.data.length) } };
      break;
    }
    case 'DownloadAttachment': {
      const guid = input.attachmentGuid as string;
      frames.push(encode(method.output, { payload: { case: 'header', value: { attachment: attachmentInfo(guid) } } }));
      if (!options.blockedDownload) {
        frames.push(encode(method.output, { payload: { case: 'primaryChunk', value: new Uint8Array([1, 2, 3]) } }));
      }
      options.started?.();
      status = options.downloadStatus ?? 0;
      break;
    }
  }
  if (name !== 'DownloadAttachment' && status === 0) {
    frames.push(encode(method.output, output));
  }
  if (!options.blockedDownload || name !== 'DownloadAttachment') {
    frames.push(frame(new TextEncoder().encode(`grpc-status: ${status}\r\n${status ? 'grpc-message: fixture%20failure\r\n' : ''}`), 0x80));
  }
  let index = 0;
  let stopped = false;
  let abort = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (!stopped) {
          stopped = true;
          options.cancelled?.();
          controller.error(request.signal.reason);
        }
      };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) {
        abort();
      }
    },
    pull(controller) {
      if (stopped) {
        return;
      }
      if (index < frames.length) {
        controller.enqueue(frames[index++]!);
      } else if (!options.blockedDownload || name !== 'DownloadAttachment') {
        stopped = true;
        request.signal.removeEventListener('abort', abort);
        controller.close();
      }
    },
    cancel() {
      if (!stopped) {
        options.cancelled?.();
      }
      stopped = true;
      request.signal.removeEventListener('abort', abort);
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
}
