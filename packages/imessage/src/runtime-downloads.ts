/** Owns provider-created downloads, including lazy work started after metadata lookup. */
export class ProviderDownloads {
  private stopped = false;
  private readonly cancellations = new Set<(reason: Error) => Promise<void>>();
  private readonly reads = new Set<Promise<unknown>>();
  private stopping: Promise<void> | undefined;

  assertOpen(): void {
    if (this.stopped) {
      throw new Error('iMessage provider has been stopped; attachment download is unavailable');
    }
  }

  register(cancel: (reason: Error) => Promise<void>): () => void {
    this.assertOpen();
    this.cancellations.add(cancel);
    return () => {
      this.cancellations.delete(cancel);
    };
  }

  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const task = operation();
    this.reads.add(task);
    try {
      return await task;
    } finally {
      this.reads.delete(task);
    }
  }

  close(): Promise<void> {
    if (!this.stopping) {
      this.stopped = true;
      this.stopping = this.closeAll();
    }
    return this.stopping;
  }

  private async closeAll(): Promise<void> {
    const reason = new Error('iMessage provider stopped; attachment download cancelled');
    // Abort every network stream before draining read promises: reversing this
    // order waits forever when an HTTP response body never produces another byte.
    const cancelled = await Promise.allSettled([...this.cancellations].map(cancel => cancel(reason)));
    await Promise.allSettled([...this.reads]);
    this.cancellations.clear();
    const failures = cancelled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) {
      throw new AggregateError(failures, 'Attachment download cleanup failed');
    }
  }
}
