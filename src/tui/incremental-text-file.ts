import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 64 * 1024;
const CHECKPOINT_BYTES = 64;

export interface IncrementalTextFileSnapshot {
  text: string;
  changed: boolean;
  reset: boolean;
  bytesRead: number;
  size: number;
}

export interface IncrementalTextFileReader {
  read(): Promise<IncrementalTextFileSnapshot>;
}

export interface IncrementalTextFileChunkSnapshot extends IncrementalTextFileSnapshot {
  hasMore: boolean;
}

export interface IncrementalTextFileChunkReader {
  read(): Promise<IncrementalTextFileChunkSnapshot>;
}

export interface IncrementalTextFileChunkReaderOptions {
  maxBytesPerRead?: number;
}

export function createIncrementalTextFileReader(path: string): IncrementalTextFileReader {
  let offset = 0;
  let text = "";
  let checkpoint: Buffer = Buffer.alloc(0);
  let identity: string | null = null;
  let initialized = false;
  let decoder = new StringDecoder("utf8");
  let queue = Promise.resolve();

  const clear = (): void => {
    offset = 0;
    text = "";
    checkpoint = Buffer.alloc(0);
    identity = null;
    initialized = false;
    decoder = new StringDecoder("utf8");
  };

  const readOnce = async (): Promise<IncrementalTextFileSnapshot> => {
    let file: FileHandle;
    try {
      file = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const reset = initialized || offset > 0 || text.length > 0;
      clear();
      return { text, changed: reset, reset, bytesRead: 0, size: 0 };
    }

    try {
      const stats = await file.stat();
      const currentIdentity = `${stats.dev}:${stats.ino}`;
      const wasInitialized = initialized;
      let reset = initialized && (identity !== currentIdentity || stats.size < offset);
      if (!reset && initialized && checkpoint.length > 0) {
        const existing = await readExact(file, checkpoint.length, offset - checkpoint.length);
        reset = existing.length !== checkpoint.length || !existing.equals(checkpoint);
      }
      if (reset) {
        clear();
      }

      initialized = true;
      identity = currentIdentity;
      const targetSize = stats.size;
      let bytesRead = 0;
      while (offset < targetSize) {
        const length = Math.min(READ_CHUNK_BYTES, targetSize - offset);
        const buffer = Buffer.allocUnsafe(length);
        const result = await file.read(buffer, 0, length, offset);
        if (result.bytesRead === 0) {
          break;
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        text += decoder.write(chunk);
        checkpoint = nextCheckpoint(checkpoint, chunk);
        offset += result.bytesRead;
        bytesRead += result.bytesRead;
      }

      return {
        text,
        changed: !wasInitialized || reset || bytesRead > 0,
        reset,
        bytesRead,
        size: offset
      };
    } finally {
      await file.close();
    }
  };

  return {
    read() {
      const operation = queue.then(readOnce);
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
}

export function createIncrementalTextFileChunkReader(
  path: string,
  options: IncrementalTextFileChunkReaderOptions = {}
): IncrementalTextFileChunkReader {
  const maxBytesPerRead = options.maxBytesPerRead ?? READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(maxBytesPerRead) || maxBytesPerRead <= 0) {
    throw new Error("Incremental text chunk size must be a positive safe integer");
  }

  let offset = 0;
  let checkpoint: Buffer = Buffer.alloc(0);
  let identity: string | null = null;
  let initialized = false;
  let decoder = new StringDecoder("utf8");
  let queue = Promise.resolve();

  const clear = (): void => {
    offset = 0;
    checkpoint = Buffer.alloc(0);
    identity = null;
    initialized = false;
    decoder = new StringDecoder("utf8");
  };

  const readOnce = async (): Promise<IncrementalTextFileChunkSnapshot> => {
    let file: FileHandle;
    try {
      file = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const reset = initialized || offset > 0;
      clear();
      return {
        text: "",
        changed: reset,
        reset,
        bytesRead: 0,
        size: 0,
        hasMore: false
      };
    }

    try {
      const stats = await file.stat();
      const currentIdentity = `${stats.dev}:${stats.ino}`;
      const wasInitialized = initialized;
      let reset = initialized && (identity !== currentIdentity || stats.size < offset);
      if (!reset && initialized && checkpoint.length > 0) {
        const existing = await readExact(file, checkpoint.length, offset - checkpoint.length);
        reset = existing.length !== checkpoint.length || !existing.equals(checkpoint);
      }
      if (reset) {
        clear();
      }

      initialized = true;
      identity = currentIdentity;
      const targetSize = stats.size;
      const targetOffset = Math.min(targetSize, offset + maxBytesPerRead);
      let bytesRead = 0;
      let text = "";
      while (offset < targetOffset) {
        const length = Math.min(READ_CHUNK_BYTES, targetOffset - offset);
        const buffer = Buffer.allocUnsafe(length);
        const result = await file.read(buffer, 0, length, offset);
        if (result.bytesRead === 0) {
          break;
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        text += decoder.write(chunk);
        checkpoint = nextCheckpoint(checkpoint, chunk);
        offset += result.bytesRead;
        bytesRead += result.bytesRead;
      }

      return {
        text,
        changed: !wasInitialized || reset || bytesRead > 0,
        reset,
        bytesRead,
        size: offset,
        hasMore: offset < targetSize
      };
    } finally {
      await file.close();
    }
  };

  return {
    read() {
      const operation = queue.then(readOnce);
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
}

async function readExact(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

function nextCheckpoint(previous: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= CHECKPOINT_BYTES) {
    return Buffer.from(chunk.subarray(chunk.length - CHECKPOINT_BYTES));
  }
  const combined = Buffer.concat([previous, chunk]);
  return Buffer.from(combined.subarray(Math.max(0, combined.length - CHECKPOINT_BYTES)));
}
