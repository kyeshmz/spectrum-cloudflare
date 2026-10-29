import { ConnectError } from "@connectrpc/connect";
import { createIMessageRpc } from "@spectrum-cloudflare/imessage/grpc";

export default {
  async fetch(request: Request): Promise<Response> {
    const scenario = new URL(request.url).pathname.slice(1) || "ok";
    const rpc = createIMessageRpc({
      baseUrl: `https://${["error", "missing", "redirect", "stream"].includes(scenario) ? scenario : "ok"}.grpc.invalid`,
      token: async () => "workerd-token",
    });
    try {
      if (scenario === "attachments") {
        const data = new Uint8Array([0, 255, 128, 13, 10, 42]);
        const result = await rpc.attachments.uploadAttachment({ fileName: "binary.bin", data });
        const chunks: number[][] = [];
        for await (const frame of rpc.attachments.downloadAttachment({ attachmentGuid: result.attachment!.guid })) {
          if (frame.payload.case === "primaryChunk") chunks.push(Array.from(frame.payload.value));
        }
        return Response.json({ guid: result.attachment!.guid, size: String(result.attachment!.totalBytes), chunks });
      }
      if (scenario === "events" || scenario === "stream") {
        const iterator = rpc.messages.subscribeMessageEvents({})[Symbol.asyncIterator]();
        const values = [String((await iterator.next()).value!.sequence), String((await iterator.next()).value!.sequence)];
        if (scenario === "stream") {
          const pending = iterator.next();
          rpc.close();
          try { await pending; } catch (error) {
            if (error instanceof ConnectError) return Response.json({ values, cancelled: error.code });
            throw error;
          }
          throw new Error("Stream was not canceled");
        }
        return Response.json({ values, done: (await iterator.next()).done });
      }
      if (scenario === "empty") {
        const result = await rpc.chats.markChatRead({ chatGuid: "any;-;fixture@example.invalid" });
        return Response.json({ type: result.$typeName });
      }
      return Response.json({ count: String((await rpc.chats.getChatCount({})).count) });
    } catch (error) {
      if (error instanceof ConnectError) return Response.json({ code: error.code, message: error.rawMessage }, { status: 502 });
      throw error;
    } finally {
      rpc.close();
    }
  },
};
