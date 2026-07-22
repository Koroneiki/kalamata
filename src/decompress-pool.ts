import { availableParallelism } from "node:os";

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface WorkerResponse {
  id: number;
  data?: ArrayBuffer;
  error?: SerializedError;
}

interface Pending {
  id: number;
  encrypted: ArrayBuffer;
  expectedSha1: string;
  expectedSize: number | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  aborted: boolean;
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  index: number;
  worker: Worker;
  current: Pending | undefined;
}

export class DecompressPool {
  static readonly #MAX_CONSECUTIVE_WORKER_FAILURES = 3;
  readonly #key: Uint8Array;
  readonly #workers: WorkerSlot[] = [];
  readonly #queue: Pending[] = [];
  #nextId = 0;
  #consecutiveWorkerFailures = 0;
  #disposed = false;

  constructor(key: Buffer, count = availableParallelism()) {
    if (!Number.isInteger(count) || count < 1) throw new Error("Worker count must be a positive integer");
    this.#key = Uint8Array.from(key);

    const workerCount = Math.min(count, availableParallelism());
    try {
      for (let index = 0; index < workerCount; index++) this.#workers.push(this.#createWorker(index));
    } catch (error) {
      for (const slot of this.#workers) slot.worker.terminate();
      this.#workers.length = 0;
      this.#disposed = true;
      throw error;
    }
  }

  process(encrypted: Buffer, expectedSha1: string, expectedSize?: number, signal?: AbortSignal): Promise<Buffer> {
    if (this.#disposed) return Promise.reject(new Error("Pool disposed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const id = this.#nextId++;
    return new Promise<Buffer>((resolve, reject) => {
      const pending: Pending = {
        id,
        encrypted: exactArrayBuffer(encrypted),
        expectedSha1,
        expectedSize,
        signal,
        onAbort: undefined,
        aborted: false,
        resolve,
        reject,
      };
      pending.onAbort = () => {
        pending.aborted = true;
        const index = this.#queue.indexOf(pending);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      this.#queue.push(pending);
      this.#dispatch();
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new Error("Pool disposed");

    for (const pending of this.#queue.splice(0)) {
      cleanupPending(pending);
      pending.reject(error);
    }
    for (const slot of this.#workers) {
      if (slot.current) {
        cleanupPending(slot.current);
        slot.current.reject(error);
      }
      slot.current = undefined;
      slot.worker.terminate();
    }
    this.#workers.length = 0;
  }

  #createWorker(index: number): WorkerSlot {
    const worker = new Worker(new URL("./decompress-worker.ts", import.meta.url).href, {
      name: `depot-decompress-${index}`,
      ref: true,
    });
    const slot: WorkerSlot = { index, worker, current: undefined };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.#handleMessage(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.#handleWorkerFailure(slot, event.error instanceof Error ? event.error : new Error(event.message));
    };
    worker.onmessageerror = () => this.#handleWorkerFailure(slot, new Error("Worker message could not be deserialized"));
    worker.addEventListener("close", () => this.#handleWorkerFailure(slot, new Error("Worker exited unexpectedly")));
    worker.postMessage({ type: "init", key: this.#key });
    return slot;
  }

  #handleMessage(slot: WorkerSlot, message: WorkerResponse): void {
    if (this.#disposed || this.#workers[slot.index] !== slot) return;
    const pending = slot.current;
    if (!pending || message.id !== pending.id) {
      this.#handleWorkerFailure(slot, new Error("Worker returned an unexpected response"));
      return;
    }

    slot.current = undefined;
    this.#consecutiveWorkerFailures = 0;
    cleanupPending(pending);
    if (!pending.aborted) {
      if (message.error) pending.reject(deserializeError(message.error));
      else if (message.data) pending.resolve(Buffer.from(message.data));
      else pending.reject(new Error("Worker returned no chunk data"));
    }
    this.#dispatch(slot);
  }

  #handleWorkerFailure(slot: WorkerSlot, error: Error): void {
    if (this.#disposed || this.#workers[slot.index] !== slot) return;
    if (slot.current) {
      cleanupPending(slot.current);
      if (!slot.current.aborted) slot.current.reject(error);
    }
    slot.current = undefined;
    slot.worker.terminate();

    this.#consecutiveWorkerFailures++;
    if (this.#consecutiveWorkerFailures >= DecompressPool.#MAX_CONSECUTIVE_WORKER_FAILURES) {
      this.#disposed = true;
      for (const pending of this.#queue.splice(0)) {
        cleanupPending(pending);
        pending.reject(error);
      }
      for (const workerSlot of this.#workers) workerSlot.worker.terminate();
      this.#workers.length = 0;
      return;
    }

    // A single crashed isolate should fail its chunk, not permanently reduce pool capacity.
    try {
      const replacement = this.#createWorker(slot.index);
      this.#workers[slot.index] = replacement;
      this.#dispatch(replacement);
    } catch (replacementError) {
      this.#disposed = true;
      const failure = toError(replacementError);
      for (const pending of this.#queue.splice(0)) {
        cleanupPending(pending);
        pending.reject(failure);
      }
      for (const workerSlot of this.#workers) workerSlot.worker.terminate();
      this.#workers.length = 0;
    }
  }

  #dispatch(onlySlot?: WorkerSlot): void {
    const slots = onlySlot ? [onlySlot] : this.#workers;
    for (const slot of slots) {
      if (slot.current || this.#disposed) continue;
      const pending = this.#queue.shift();
      if (!pending) return;
      slot.current = pending;
      try {
        slot.worker.postMessage(
          {
            type: "process",
            id: pending.id,
            encrypted: pending.encrypted,
          expectedSha1: pending.expectedSha1,
          expectedSize: pending.expectedSize,
          },
          [pending.encrypted],
        );
      } catch (error) {
        this.#handleWorkerFailure(slot, toError(error));
      }
    }
  }
}

function cleanupPending(pending: Pending): void {
  if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
  pending.onAbort = undefined;
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Transfer only the visible bytes; Buffers may be views into a larger shared slab.
  if (data.buffer instanceof ArrayBuffer) {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return Uint8Array.from(data).buffer;
}

function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
