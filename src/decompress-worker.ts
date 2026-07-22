import { processChunkData } from "./chunk-download.ts";

interface InitMessage {
  type: "init";
  key: Uint8Array;
}

interface ProcessMessage {
  type: "process";
  id: number;
  encrypted: ArrayBuffer;
  expectedSha1: string;
  expectedSize?: number;
}

type WorkerRequest = InitMessage | ProcessMessage;

let key: Buffer | undefined;

onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    key = Buffer.from(message.key);
    return;
  }

  try {
    if (!key) throw new Error("Worker was not initialized");
    const chunk = await processChunkData(Buffer.from(message.encrypted), key, message.expectedSha1, message.expectedSize);
    const data = exactArrayBuffer(chunk);
    postMessage({ id: message.id, data }, [data]);
  } catch (error) {
    postMessage({ id: message.id, error: serializeError(error) });
  }
};

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.buffer instanceof ArrayBuffer) {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return Uint8Array.from(data).buffer;
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}
