import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { output, ZodTypeAny } from "zod";

const appendQueues = new Map<string, Promise<void>>();

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
