import type { IMessageRpc } from './grpc.js';
import type { AttachmentContent } from './runtime-content.js';
import { SpectrumLines } from './runtime-lines.js';
import { concatenateBytes } from './runtime-messages.js';

type NativeAttachment = NonNullable<Awaited<ReturnType<IMessageRpc['attachments']['getAttachmentInfo']>>['attachment']>;

/** Lazy native downloads are app-owned even after the metadata operation finishes. */
export function receivedAttachment(pool: SpectrumLines, info: NativeAttachment, phone?: string): AttachmentContent {
  const makeStream = async (): Promise<ReadableStream<Uint8Array>> => {
    pool.assertOpen();
    const { rpc } = await pool.select(phone);
    pool.assertOpen();
    const abort = new AbortController();
    const frames = rpc.attachments.downloadAttachment({ attachmentGuid: info.guid }, {
      signal: AbortSignal.any([pool.signal, abort.signal]),
    });
    const iterator = frames[Symbol.asyncIterator]();
    let finished = false;
    let header = false;
    let companion = false;
    let cleanup: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let unregister = () => {};
    const close = (): Promise<void> => {
      if (cleanup) {
        return cleanup;
      }
      finished = true;
      abort.abort(new Error('Attachment download cancelled'));
      cleanup = (async () => {
        try {
          await iterator.return?.();
        } finally {
          unregister();
        }
      })();
      return cleanup;
    };
    unregister = pool.downloads.register(async reason => {
      if (!finished) {
        controller.error(reason);
      }
      await close();
    });
    return new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      async pull(controller) {
        try {
          while (!finished) {
            const result = await iterator.next();
            if (finished) {
              return;
            }
            if (result.done) {
              if (!header) {
                throw new Error('Attachment download completed without its metadata header');
              }
              controller.close();
              await close();
              return;
            }
            const payload = result.value.payload;
            if (payload.case === 'header') {
              if (header || payload.value.attachment?.guid !== info.guid) {
                throw new Error('Invalid attachment download header');
              }
              header = true;
            } else if (payload.case === 'primaryChunk') {
              if (!header || companion) {
                throw new Error('Invalid attachment download frame order');
              }
              controller.enqueue(payload.value);
              return;
            } else if (payload.case === 'companionChunk') {
              if (!header) {
                throw new Error('Attachment companion arrived before metadata');
              }
              companion = true;
            } else {
              throw new Error('Attachment download contained an empty frame');
            }
          }
        } catch (error) {
          if (!finished) {
            controller.error(error);
          }
          await close();
        }
      },
      async cancel() {
        await close();
      },
    });
  };
  return {
    type: 'attachment',
    id: info.guid,
    name: info.fileName,
    mimeType: info.mimeType || 'application/octet-stream',
    ...(info.totalBytes >= 0n && info.totalBytes <= BigInt(Number.MAX_SAFE_INTEGER) ? { size: Number(info.totalBytes) } : {}),
    stream: makeStream,
    read: () => pool.downloads.read(async () => {
      const reader = (await makeStream()).getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          chunks.push(result.value);
        }
        pool.assertOpen();
        return concatenateBytes(chunks);
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    }),
  };
}
