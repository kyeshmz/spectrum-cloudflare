import type { Message as NativeMessage } from './generated/photon/imessage/v1/message_types_pb.js';
import type { SubscribeMessageEventsResponse } from './generated/photon/imessage/v1/message_service_pb.js';
import type { SpectrumLines, NativeStreamLine } from './runtime-lines.js';
import type { SpectrumMessage, SpectrumSpace } from './runtime-types.js';

type Tuple = [SpectrumSpace, SpectrumMessage];
type Result = IteratorResult<Tuple, undefined>;
const done = (): Result => ({ done: true, value: undefined });

interface Delivery {
  value: Tuple;
  release(): void;
}

/** One queued delivery per native source, released only when consumed. */
class Consumer {
  private queue: Delivery[] = [];
  private waiters: { resolve(value: Result): void; reject(error: unknown): void }[] = [];
  private ended = false;
  private error: unknown;
  private failed = false;

  next(): Promise<Result> {
    const delivery = this.queue.shift();
    if (delivery) {
      delivery.release();
      return Promise.resolve({ done: false, value: delivery.value });
    }
    if (this.ended) return this.failed ? Promise.reject(this.error) : Promise.resolve(done());
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  deliver(value: Tuple, signal: AbortSignal): Promise<void> {
    if (this.ended || signal.aborted) return Promise.resolve();
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const delivery: Delivery = { value, release: () => {
        signal.removeEventListener('abort', abort);
        resolve();
      } };
      const abort = () => {
        const index = this.queue.indexOf(delivery);
        if (index !== -1) this.queue.splice(index, 1);
        delivery.release();
      };
      this.queue.push(delivery);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  end(failed = false, error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failed = failed;
    this.error = error;
    for (const delivery of this.queue.splice(0)) delivery.release();
    for (const waiter of this.waiters.splice(0)) {
      if (failed) waiter.reject(error);
      else waiter.resolve(done());
    }
  }
}

interface Source {
  controller: AbortController;
  task: Promise<void>;
  ended: boolean;
}

interface StreamOptions {
  lines: SpectrumLines;
  materialize(native: NativeMessage, phone: string, chatGuid: string, timestamp: Date | undefined): SpectrumMessage | undefined;
}

/**
 * Received-message iteration only: heartbeat, edits, unsends, reactions, read
 * receipts and other domains are deliberately not normalized in this tranche.
 * No reconnect/replay is implied. Each line has one read and one broadcast in
 * flight; slow subscribers apply backpressure instead of growing a queue.
 */
export function createNativeMessageStream({ lines, materialize }: StreamOptions): AsyncIterable<Tuple> {
  let current: Hub | undefined;

  class Hub {
    readonly consumers = new Set<Consumer>();
    private readonly controller = new AbortController();
    private readonly sources = new Map<NativeStreamLine['rpc'], Source>();
    private readonly tasks = new Set<Promise<void>>();
    private disposeInventory: (() => void) | undefined;
    private disposeOwner: (() => void) | undefined;
    private startup: Promise<void> = Promise.resolve();
    private started = false;
    private ended = false;
    private stopping: Promise<void> | undefined;

    add(consumer: Consumer): void {
      this.consumers.add(consumer);
      if (this.started) return;
      this.started = true;
      lines.signal.addEventListener('abort', this.onStop, { once: true });
      if (lines.signal.aborted) {
        this.finish();
        return;
      }
      this.disposeOwner = lines.ownStream(() => this.close());
      this.startup = this.start().catch(error => {
        if (!this.ended) this.finish(true, error);
      });
    }

    private readonly onStop = () => { this.finish(); };

    private async start(): Promise<void> {
      await lines.snapshot(this.controller.signal);
      if (this.ended) return;
      const dispose = lines.observeInventory(inventory => this.reconcile(inventory));
      if (this.ended) dispose();
      else this.disposeInventory = dispose;
    }

    private reconcile(inventory: readonly NativeStreamLine[]): void {
      if (this.ended) return;
      const wanted = new Set(inventory.map(line => line.rpc));
      for (const [rpc, source] of this.sources) {
        if (!wanted.has(rpc)) {
          // Classify retirement as owned cancellation before rpc.close().
          source.controller.abort();
          this.sources.delete(rpc);
        }
      }
      for (const line of inventory) {
        if (this.sources.has(line.rpc)) continue;
        const source: Source = { controller: new AbortController(), task: Promise.resolve(), ended: false };
        this.sources.set(line.rpc, source);
        source.task = this.read(line, source);
        this.tasks.add(source.task);
        void source.task.then(() => { this.tasks.delete(source.task); });
      }
      this.checkEof();
    }

    private checkEof(): void {
      if ([...this.sources.values()].every(source => source.ended)) this.finish();
    }

    private async read(line: NativeStreamLine, source: Source): Promise<void> {
      const signal = AbortSignal.any([source.controller.signal, this.controller.signal]);
      let iterator: AsyncIterator<SubscribeMessageEventsResponse> | undefined;
      let sequence: bigint | undefined;
      try {
        iterator = line.rpc.messages.subscribeMessageEvents({}, { signal, timeoutMs: 0 })[Symbol.asyncIterator]();
        while (!signal.aborted) {
          const result = await iterator.next();
          if (result.done || signal.aborted) break;
          const frame = result.value;
          if (frame.payload.case !== 'messageChanged') continue;
          if (frame.sequence !== undefined) {
            if (sequence !== undefined && frame.sequence <= sequence) continue;
            sequence = frame.sequence;
          }
          const event = frame.payload.value;
          if (event.change.case !== 'messageReceived') continue;
          const native = event.change.value.message;
          if (!native || native.isFromMe) continue;
          const timestamp = event.occurredAt
            ? new Date(Number(event.occurredAt.seconds) * 1_000 + event.occurredAt.nanos / 1_000_000)
            : undefined;
          const message = materialize(native, line.phone, event.chatGuid || native.chatGuids[0] || '', timestamp);
          if (message && !signal.aborted) {
            await Promise.all([...this.consumers].map(consumer => consumer.deliver([message.space, message], signal)));
          }
        }
      } catch (error) {
        if (!signal.aborted) this.finish(true, error);
      } finally {
        // Abort first: generator.return() alone cannot interrupt a parked read.
        const canceled = signal.aborted;
        source.controller.abort();
        try { await iterator?.return?.(); } catch (error) {
          if (!canceled && !this.ended) this.finish(true, error);
        }
        source.ended = true;
        if (!this.ended && this.sources.get(line.rpc) === source) this.checkEof();
      }
    }

    private finish(failed = false, error?: unknown): void {
      if (this.ended) return;
      this.ended = true;
      if (current === this) current = undefined;
      for (const consumer of this.consumers) consumer.end(failed, error);
      this.consumers.clear();
      this.controller.abort();
      this.disposeInventory?.();
      lines.signal.removeEventListener('abort', this.onStop);
      // Keep the ownership hook until native readers have settled, including
      // after a consumer returns while authentication is still pending.
      void this.close();
    }

    remove(consumer: Consumer): Promise<void> {
      consumer.end();
      this.consumers.delete(consumer);
      if (this.consumers.size) return Promise.resolve();
      this.finish();
      return this.close();
    }

    close(): Promise<void> {
      this.finish();
      this.stopping ??= (async () => {
        await this.startup;
        await Promise.allSettled([...this.tasks]);
        this.disposeOwner?.();
      })();
      return this.stopping;
    }
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<Tuple> {
      const consumer = new Consumer();
      let hub: Hub | undefined;
      let returned = false;
      return {
        next() {
          if (returned) return Promise.resolve(done());
          if (!hub) {
            if (lines.signal.aborted) return Promise.resolve(done());
            hub = current ??= new Hub();
            hub.add(consumer);
          }
          return consumer.next();
        },
        async return() {
          returned = true;
          if (hub) await hub.remove(consumer);
          else consumer.end();
          return done();
        },
      };
    },
  };
}
