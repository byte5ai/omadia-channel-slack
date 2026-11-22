/**
 * Runs tasks one after another per key, in the order they were handed in.
 * Different keys run concurrently. A failed task does not stop the ones
 * behind it (its own promise still rejects for its caller).
 *
 * The transports hand Slack events over fire-and-forget, so without this an
 * edit could reach the kernel before the `created` of the same message (the
 * created waits for the sender profile and the kernel's verdict).
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with a task queued or running (tests, diagnostics). */
  get size(): number {
    return this.tails.size;
  }
}
