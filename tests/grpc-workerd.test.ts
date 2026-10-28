import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Code } from "@connectrpc/connect";
import { grpcBigint, grpcPeer, type GrpcObservation } from "./fixtures/grpc-peer.js";

// The outbound peer speaks gRPC-Web. This proves the real fetch client runs
// without Node compatibility, not that Cloudflare's production translation
// private beta is enabled on any particular account.
describe("Photon gRPC-Web in workerd without nodejs_compat", () => {
  let worker: Miniflare;
  const calls: GrpcObservation[] = [];
  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["tests/fixtures/grpc-worker.ts"], bundle: true,
      platform: "browser", format: "esm", target: "es2022", write: false, metafile: true,
    });
    for (const output of Object.values(bundle.metafile!.outputs)) expect(output.imports).toEqual([]);
    expect(Object.keys(bundle.metafile!.inputs).some((path) => /grpc-js|nice-grpc|advanced-imessage|spectrum-ts|node:/.test(path))).toBe(false);
    worker = new Miniflare({
      modules: true, script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-07-30", compatibilityFlags: [],
      outboundService: (request: Request) => grpcPeer(request, { observe: (call) => calls.push(call) }),
    });
    await worker.ready;
  });
  beforeEach(() => { calls.length = 0; });
  afterAll(async () => { await worker?.dispose(); });

  it("performs native fetch with binary framing, auth and exact bigint decoding", async () => {
    const response = await worker.dispatchFetch("https://worker.invalid/ok");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: String(grpcBigint) });
    expect(calls[0]).toMatchObject({
      url: "https://ok.grpc.invalid/photon.imessage.v1.ChatService/GetChatCount",
      method: "POST", authorization: "Bearer workerd-token",
      contentType: "application/grpc-web+proto", routingHeader: null,
    });
    expect(Array.from(calls[0]!.body)).toEqual([0, 0, 0, 0, 0]);
  });

  it("supports Empty responses and binary unary upload/server-stream download", async () => {
    expect(await (await worker.dispatchFetch("https://worker.invalid/empty")).json()).toEqual({ type: "google.protobuf.Empty" });
    const response = await worker.dispatchFetch("https://worker.invalid/attachments");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ guid: "uploaded", size: "6", chunks: [[0, 255, 128, 13, 10, 42]] });
  });

  it("parses fragmented server messages and successful final trailers", async () => {
    const response = await worker.dispatchFetch("https://worker.invalid/events");
    expect(await response.json()).toEqual({ values: [String(grpcBigint), String(grpcBigint + 1n)], done: true });
  });

  it("preserves gRPC errors over HTTP 200 and rejects missing trailers/redirects", async () => {
    const failure = await worker.dispatchFetch("https://worker.invalid/error");
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ code: Code.PermissionDenied, message: "fixture denied" });
    expect(calls).toHaveLength(1);
    for (const scenario of ["missing", "redirect"]) {
      const response = await worker.dispatchFetch(`https://worker.invalid/${scenario}`);
      expect(response.status).toBe(502);
      expect(await response.json()).toHaveProperty("code");
    }
  });

  it("close cancels an active stream using Web AbortSignal", async () => {
    const response = await worker.dispatchFetch("https://worker.invalid/stream");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ values: [String(grpcBigint), String(grpcBigint + 1n)], cancelled: Code.Canceled });
  });
});
