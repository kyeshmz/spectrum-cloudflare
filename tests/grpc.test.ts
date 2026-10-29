import { describe, expect, it } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { createIMessageRpc } from "@spectrum-cloudflare/imessage/grpc";
import { grpcBigint, grpcBytes, grpcPeer, type GrpcObservation } from "./fixtures/grpc-peer.js";

function fixture(mode = "ok", token: string | ((signal?: AbortSignal) => Promise<string>) = "test-token") {
  const calls: GrpcObservation[] = [];
  let cancelled = 0;
  const redirects: (RequestRedirect | undefined)[] = [];
  const rpc = createIMessageRpc({
    baseUrl: `https://${mode}.grpc.invalid`, token,
    fetch: async (input, init) => {
      redirects.push(init?.redirect);
      return grpcPeer(new Request(input, init), { observe: (call) => calls.push(call), cancel: () => { cancelled++; } });
    },
  });
  return { rpc, calls, redirects, cancelled: () => cancelled };
}

describe("Photon binary gRPC-Web transport", () => {
  it("uses actual service descriptors, rotating bearer auth, manual redirects, and bigint", async () => {
    let token = 0;
    const { rpc, calls, redirects } = fixture("ok", async () => `rotating-${++token}`);
    expect((await rpc.chats.getChatCount({})).count).toBe(grpcBigint);
    expect((await rpc.chats.getChatCount({})).count).toBe(grpcBigint);
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer rotating-1", "Bearer rotating-2"]);
    expect(calls[0]).toMatchObject({
      url: "https://ok.grpc.invalid/photon.imessage.v1.ChatService/GetChatCount",
      method: "POST", contentType: "application/grpc-web+proto", routingHeader: null,
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });
    expect(redirects).toEqual(["manual", "manual"]);
  });

  it("accepts Empty responses and rejects HTTP 200 with nonzero gRPC status without retry", async () => {
    const { rpc } = fixture();
    expect(await rpc.chats.markChatRead({ chatGuid: "any;-;test@example.invalid" })).toMatchObject({ $typeName: "google.protobuf.Empty" });
    const failed = fixture("error");
    await expect(failed.rpc.chats.getChatCount({})).rejects.toMatchObject({ code: Code.PermissionDenied, rawMessage: "fixture denied" });
    expect(failed.calls).toHaveLength(1);
  });

  it("rejects missing final status and redirects", async () => {
    await expect(fixture("missing").rpc.chats.getChatCount({})).rejects.toThrow("missing trailer");
    await expect(fixture("redirect").rpc.chats.getChatCount({})).rejects.toThrow();
  });

  it("uploads protobuf binary bytes and downloads fragmented server-streaming frames", async () => {
    const { rpc } = fixture();
    const uploaded = await rpc.attachments.uploadAttachment({ fileName: "binary.bin", data: grpcBytes });
    expect(uploaded.attachment).toMatchObject({ guid: "uploaded", totalBytes: 6n });
    const frames = [];
    for await (const frame of rpc.attachments.downloadAttachment({ attachmentGuid: "uploaded" })) frames.push(frame);
    expect(frames.map((frame) => frame.payload.case)).toEqual(["header", "primaryChunk"]);
    expect(frames[1]!.payload.value).toEqual(grpcBytes);
  });

  it("reads multiple server messages with exact uint64 sequences and validates stream trailers", async () => {
    const values = [];
    for await (const event of fixture().rpc.messages.subscribeMessageEvents({})) values.push(event.sequence);
    expect(values).toEqual([grpcBigint, grpcBigint + 1n]);
    const drain = async () => {
      for await (const _ of fixture("missing").rpc.messages.subscribeMessageEvents({})) { /* drain */ }
    };
    await expect(drain()).rejects.toBeDefined();
  });

  it("close cancels active streams and permanently prevents new calls", async () => {
    const test = fixture("stream");
    const stream = test.rpc.messages.subscribeMessageEvents({})[Symbol.asyncIterator]();
    expect((await stream.next()).value?.sequence).toBe(grpcBigint);
    expect((await stream.next()).value?.sequence).toBe(grpcBigint + 1n);
    const pending = stream.next();
    test.rpc.close();
    await expect(pending).rejects.toMatchObject({ code: Code.Canceled });
    expect(test.cancelled()).toBeGreaterThan(0);
    await expect(test.rpc.chats.getChatCount({})).rejects.toMatchObject({ code: Code.Canceled });
  });

  it("per-call cancellation and deadlines cover a non-cooperating pending token provider", async () => {
    const controller = new AbortController();
    const never = () => new Promise<string>(() => {});
    const test = fixture("ok", never);
    const call = test.rpc.chats.getChatCount({}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: Code.Canceled });
    await expect(test.rpc.chats.getChatCount({}, { timeoutMs: 10 })).rejects.toMatchObject({ code: Code.DeadlineExceeded });
    const closePending = test.rpc.chats.getChatCount({});
    test.rpc.close();
    await expect(closePending).rejects.toMatchObject({ code: Code.Canceled });
    expect(test.calls).toEqual([]);
  });

  it("honors the factory lifetime signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const rpc = createIMessageRpc({ baseUrl: "https://ok.grpc.invalid", token: "test", signal: controller.signal });
    await expect(rpc.chats.getChatCount({})).rejects.toMatchObject({ code: Code.Canceled });
  });

  it.each(["unary", "server-streaming"] as const)("normalizes custom lifetime abort reasons during %s auth", async (kind) => {
    const controller = new AbortController();
    let started!: () => void;
    const authStarted = new Promise<void>((resolve) => { started = resolve; });
    const rpc = createIMessageRpc({
      baseUrl: "https://ok.grpc.invalid", signal: controller.signal,
      token: () => { started(); return new Promise<string>(() => {}); },
    });
    const pending = kind === "unary"
      ? rpc.chats.getChatCount({})
      : rpc.messages.subscribeMessageEvents({})[Symbol.asyncIterator]().next();
    await authStarted;
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toMatchObject({ code: Code.Canceled, rawMessage: "user cancelled" });
  });

  it.each(["unary", "server-streaming"] as const)("preserves ConnectError lifetime reasons and genuine %s auth failures", async (kind) => {
    const invoke = (rpc: ReturnType<typeof createIMessageRpc>, timeoutMs?: number) => kind === "unary"
      ? rpc.chats.getChatCount({}, timeoutMs === undefined ? {} : { timeoutMs })
      : rpc.messages.subscribeMessageEvents({}, timeoutMs === undefined ? {} : { timeoutMs })[Symbol.asyncIterator]().next();
    const controller = new AbortController();
    const reason = new ConnectError("explicit shutdown status", Code.Unavailable);
    const stopped = createIMessageRpc({
      baseUrl: "https://ok.grpc.invalid", token: "test", signal: controller.signal,
    });
    controller.abort(reason);
    await expect(invoke(stopped)).rejects.toBe(reason);
    for (const error of [new Error("token service failed"), new ConnectError("token denied", Code.Unauthenticated)]) {
      const rpc = createIMessageRpc({
        baseUrl: "https://ok.grpc.invalid", signal: new AbortController().signal,
        token: async () => { throw error; },
      });
      await expect(invoke(rpc)).rejects.toMatchObject({
        code: error instanceof ConnectError ? Code.Unauthenticated : Code.Unknown,
        rawMessage: error instanceof ConnectError ? error.rawMessage : error.message,
      });
    }
    const timed = createIMessageRpc({
      baseUrl: "https://ok.grpc.invalid", token: () => new Promise<string>(() => {}),
    });
    await expect(invoke(timed, 10)).rejects.toMatchObject({ code: Code.DeadlineExceeded });
  });
});
