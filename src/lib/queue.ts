// Bounded in-process work queue: fixed concurrency, cap from the `max_queue` setting, every task
// wrapped so a failure is logged with its stack and never escapes.

import { logger } from "./log.ts";

const log = logger("queue");

export type Task = () => Promise<void>;

export class BoundedQueue {
  private pending: { name: string; task: Task }[] = [];
  private running = 0;

  constructor(
    private readonly concurrency = 4,
    private max: () => number = () => 200,
  ) {}

  setMax(fn: () => number) {
    this.max = fn;
  }

  get size() {
    return this.pending.length;
  }

  get active() {
    return this.running;
  }

  /** Returns false (and logs) when the queue is full. */
  push(name: string, task: Task): boolean {
    if (this.pending.length >= this.max()) {
      log.warn(`full (${this.pending.length}), rejecting ${name}`);
      return false;
    }
    this.pending.push({ name, task });
    this.drain();
    return true;
  }

  private drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const item = this.pending.shift()!;
      this.running++;
      item
        .task()
        .catch((err) => log.error(`${item.name} failed`, err))
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }

  /** Resolve once everything currently queued or running has finished (tests). */
  async idle(): Promise<void> {
    while (this.running || this.pending.length) await new Promise((r) => setTimeout(r, 5));
  }
}

export const queue = new BoundedQueue(4);
