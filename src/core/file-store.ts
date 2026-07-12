import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { output, ZodTypeAny } from "zod";

const appendQueues = new Map<string, Promise<void>>();
const defaultRecentJsonLineChunkBytes = 64 * 1024;
const defaultRecentJsonLineMaxBytes = 2 * 1024 * 1024;

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);

  await ensureDir(dir);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function readJson<TSchema extends ZodTypeAny>(path: string, schema: TSchema): Promise<output<TSchema>> {
  const text = await readFile(path, "utf8");
  return schema.parse(JSON.parse(text));
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

export async function writeText(path: string, value: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, value, "utf8");
}

export async function appendText(path: string, value: string): Promise<void> {
  await appendFile(path, value);
}

export interface ReadRecentJsonLinesOptions {
  chunkBytes?: number;
  maxLineBytes?: number;
}

export async function readRecentJsonLines<TSchema extends ZodTypeAny>(
  path: string,
  schema: TSchema,
  limit: number,
  options: ReadRecentJsonLinesOptions = {}
): Promise<Array<output<TSchema>>> {
  const targetLimit = Number.isFinite(limit)
    ? Math.min(10000, Math.max(0, Math.trunc(limit)))
    : 10000;
  if (targetLimit === 0) {
    return [];
  }
  const chunkBytes = boundedPositiveInteger(
    options.chunkBytes,
    defaultRecentJsonLineChunkBytes,
    4 * 1024 * 1024
  );
  const maxLineBytes = boundedPositiveInteger(
    options.maxLineBytes,
    defaultRecentJsonLineMaxBytes,
    16 * 1024 * 1024
  );

  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  try {
    let position = (await handle.stat()).size;
    let lineSegments: Buffer[] = [];
    let lineBytes = 0;
    let lineTooLong = false;
    const newestFirst: Array<output<TSchema>> = [];

    const addLineSegment = (segment: Buffer): void => {
      if (segment.length === 0 || lineTooLong) {
        return;
      }
      lineBytes += segment.length;
      if (lineBytes > maxLineBytes) {
        lineSegments = [];
        lineTooLong = true;
        return;
      }
      lineSegments.push(Buffer.from(segment));
    };

    const finishLine = (): void => {
      if (!lineTooLong && lineBytes > 0) {
        const line = Buffer.concat([...lineSegments].reverse(), lineBytes).toString("utf8").trim();
        if (line) {
          try {
            const parsed = schema.safeParse(JSON.parse(line));
            if (parsed.success) {
              newestFirst.push(parsed.data);
            }
          } catch {
            // Invalid or partial rows do not hide earlier valid records.
          }
        }
      }
      lineSegments = [];
      lineBytes = 0;
      lineTooLong = false;
    };

    while (position > 0 && newestFirst.length < targetLimit) {
      const requested = Math.min(chunkBytes, position);
      position -= requested;
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        continue;
      }

      let segmentEnd = bytesRead;
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) {
          continue;
        }
        addLineSegment(buffer.subarray(index + 1, segmentEnd));
        finishLine();
        segmentEnd = index;
        if (newestFirst.length >= targetLimit) {
          break;
        }
      }
      if (newestFirst.length < targetLimit) {
        addLineSegment(buffer.subarray(0, segmentEnd));
      }
    }

    if (position === 0 && newestFirst.length < targetLimit && (lineBytes > 0 || lineTooLong)) {
      finishLine();
    }
    return newestFirst.reverse();
  } finally {
    await handle.close();
  }
}

async function appendFile(path: string, value: string): Promise<void> {
  const key = resolve(path);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await ensureDir(dirname(path));
    await writeFile(path, value, { encoding: "utf8", flag: "a" });
  });
  appendQueues.set(key, operation);
  try {
    await operation;
  } finally {
    if (appendQueues.get(key) === operation) {
      appendQueues.delete(key);
    }
  }
}

export async function readTextIfExists(path: string): Promise<string> {
  if (!(await pathExists(path))) {
    return "";
  }
  return readFile(path, "utf8");
}

export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}
