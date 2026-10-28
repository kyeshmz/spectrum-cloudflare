import { createHmac } from 'node:crypto';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { MessageResponseSchema, SendTextMessageRequestSchema } from '../src/generated/photon/imessage/v1/message_service_pb.js';
import { grpcFrame, grpcTrailers } from './fixtures/grpc-peer.js';

const bindings = {
  SPECTRUM_PROJECT_ID: 'example-project',
  SPECTRUM_PROJECT_SECRET: 'example-secret',
  SPECTRUM_WEBHOOK_SECRET: 'example-webhook-secret',
};

function signed(body: string, secret = bindings.SPECTRUM_WEBHOOK_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  return {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-spectrum-timestamp': timestamp, 'x-spectrum-signature': `v0=${signature}` },
  };
}

const delivery = JSON.stringify({
  event: 'messages',
  message: {
    id: 'incoming-1', platform: 'iMessage', direction: 'inbound',
    timestamp: '2026-07-30T12:00:00Z',
    space: { id: 'any;-;+15551112222', phone: '+15550001111', type: 'dm' },
    content: { type: 'text', text: 'Hello from a signed fixture' },
  },
});

describe('shipped Worker example (package self-reference in real workerd)', () => {
  // Miniflare has no hosted outbound native-gRPC translation. This peer speaks
  // actual binary gRPC-Web: framed protobuf requests/responses and status trailers.
  it('verifies before I/O, ignores unsupported deliveries, awaits send and teardown, and routes dedicated tokens', async () => {
    // Instrument only the built test artifact to observe the real app.close().
    // The actual example and public package imports remain unchanged.
    const result = await build({
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
      entryPoints: ['examples/worker/worker.ts'],
      write: false, minify: true, metafile: true,
      plugins: [
        {
          name: 'observe-example-teardown',
          setup(builder) {
            builder.onLoad({ filter: /examples\/worker\/worker\.ts$/ }, async (args) => {
              const { readFile } = await import('node:fs/promises');
              const source = await readFile(args.path, 'utf8');
              const noNodeGlobals = "if (typeof Buffer !== 'undefined' || typeof process !== 'undefined') throw new Error('Worker must not expose Node globals');\n";
              return { loader: 'ts', resolveDir: dirname(args.path), contents: noNodeGlobals + source.replace('await app.close();', "await app.close(); await fetch('https://audit.test/closed', { method: 'POST' });") };
            });
          },
        },
      ],
    });
    const calls: { url: string; auth: string | null; server: string | null; body: unknown }[] = [];
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    let failSend = false;
    const mf = new Miniflare({
      modules: true, script: result.outputFiles[0]!.text, bindings,
      compatibilityDate: '2026-07-30',
      outboundService: async (request: Request) => {
        const url = request.url;
        const bytes = new Uint8Array(await request.arrayBuffer());
        const call = { url, auth: request.headers.get('authorization'), server: request.headers.get('x-photon-server'), body: undefined as unknown };
        calls.push(call);
        if (url === 'https://audit.test/closed') return new Response('ok');
        if (url === 'https://spectrum.photon.codes/projects/example-project/imessage/tokens') {
          return Response.json({ succeed: true, data: { type: 'dedicated', auth: { 'instance-1': 'minted-line-token' }, numbers: { 'instance-1': '+15550001111' }, expiresIn: 300 } });
        }
        if (url === 'https://instance-1.imsg.photon.codes/photon.imessage.v1.MessageService/SendTextMessage') {
          expect(request.headers.get('content-type')).toBe('application/grpc-web+proto');
          expect(bytes[0]).toBe(0);
          expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false)).toBe(bytes.length - 5);
          call.body = fromBinary(SendTextMessageRequestSchema, bytes.subarray(5));
          entered();
          await blocked;
          const frames = failSend ? [grpcTrailers(7)] : [
            grpcFrame(toBinary(MessageResponseSchema, create(MessageResponseSchema, { message: {
              guid: 'sent-1', isFromMe: true, dateCreated: { seconds: 1_785_412_800n, nanos: 0 },
            } }))), grpcTrailers(),
          ];
          const responseBytes = new Uint8Array(frames.reduce((size, frame) => size + frame.length, 0));
          let offset = 0;
          for (const frame of frames) { responseBytes.set(frame, offset); offset += frame.length; }
          return new Response(responseBytes, { headers: { 'content-type': 'application/grpc-web+proto' } });
        }
        throw new Error(`Unexpected egress: ${url}`);
      },
    });
    try {
      expect((await mf.dispatchFetch('https://worker.test/health')).status).toBe(200);
      expect((await mf.dispatchFetch('https://worker.test/send', { method: 'POST' })).status).toBe(404);
      expect((await mf.dispatchFetch('https://worker.test/webhook')).status).toBe(405);
      expect((await mf.dispatchFetch('https://worker.test/webhook', signed(delivery, 'wrong-secret'))).status).toBe(401);
      for (const body of ['{}', '{"event":"future"}', delivery.replace('"inbound"', '"outbound"'), delivery.replace('"text","text"', '"future","text"'), delivery.replace('"iMessage"', '"telegram"'), delivery.replace('"iMessage"', '"IMESSAGE"')]) {
        expect((await mf.dispatchFetch('https://worker.test/webhook', signed(body))).status).toBe(200);
      }
      expect(calls).toEqual([]);

      let responded = false;
      const responseTask = mf.dispatchFetch('https://worker.test/webhook', signed(delivery)).then((response) => { responded = true; return response; });
      await Promise.race([sending, responseTask.then(async (response) => { throw new Error(`Response before send: ${response.status} ${await response.text()}`); })]);
      expect(responded).toBe(false);
      expect(calls.some((call) => call.url.includes('audit.test'))).toBe(false);
      release();
      expect((await responseTask).status).toBe(200);
      expect(calls.map((call) => call.url)).toEqual([
        'https://spectrum.photon.codes/projects/example-project/imessage/tokens',
        'https://instance-1.imsg.photon.codes/photon.imessage.v1.MessageService/SendTextMessage',
        'https://audit.test/closed',
      ]);
      expect(calls[0]?.auth).toBe(`Basic ${btoa('example-project:example-secret')}`);
      expect(calls.find((call) => call.url.endsWith('/imessage/tokens'))?.auth).toBe(`Basic ${btoa('example-project:example-secret')}`);
      expect(calls.find((call) => call.url.endsWith('/SendTextMessage'))).toMatchObject({ auth: 'Bearer minted-line-token', server: null, body: { chatGuid: 'any;-;+15551112222', text: 'Received — thanks!' } });

      const lowercase = await mf.dispatchFetch('https://worker.test/webhook', signed(delivery.replace('"iMessage"', '"imessage"')));
      expect(lowercase.status).toBe(200);
      expect(await lowercase.text()).toBe('ok');
      expect(calls.filter((call) => call.url.endsWith('/SendTextMessage'))).toHaveLength(2);
      expect(calls.filter((call) => call.url.includes('audit.test'))).toHaveLength(2);

      failSend = true;
      const failed = await mf.dispatchFetch('https://worker.test/webhook', signed(delivery));
      expect(failed.status).toBe(500);
      expect(calls.at(-1)?.url).toBe('https://audit.test/closed');
      expect(calls.filter((call) => call.url.includes('audit.test'))).toHaveLength(3);
      expect(Object.keys(result.metafile!.inputs).some((path) => /grpc-js|socket\.io|@spectrum-ts|advanced-imessage|node-stdlib-browser|unenv/.test(path))).toBe(false);
      expect(result.metafile!.outputs).toBeDefined();
      expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual([]);
    } finally {
      release();
      await mf.dispose();
    }
  }, 60_000);
});
