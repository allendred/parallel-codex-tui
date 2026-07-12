import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readRecentJsonLines, writeText } from "../src/core/file-store.js";

const RecordSchema = z.object({
  id: z.number().int(),
  text: z.string()
});

describe("readRecentJsonLines", () => {
  it("reads the newest valid records across tiny UTF-8 chunk boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-recent-jsonl-utf8-"));
    const path = join(root, "history.jsonl");
    await writeText(path, [
      JSON.stringify({ id: 1, text: "旧记录" }),
      "{broken",
      JSON.stringify({ id: 2, text: "你好，世界" }),
      JSON.stringify({ id: 3, text: "继续优化" })
    ].join("\n") + "\n");

    await expect(readRecentJsonLines(path, RecordSchema, 2, { chunkBytes: 7 })).resolves.toEqual([
      { id: 2, text: "你好，世界" },
      { id: 3, text: "继续优化" }
    ]);
  });

  it("skips oversized and partial tail rows without hiding earlier evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-recent-jsonl-oversized-"));
    const path = join(root, "history.jsonl");
    await writeText(path, [
      JSON.stringify({ id: 1, text: "keep me" }),
      JSON.stringify({ id: 2, text: "x".repeat(4096) }),
      "{partial tail"
    ].join("\n"));

    await expect(readRecentJsonLines(path, RecordSchema, 1, {
      chunkBytes: 31,
      maxLineBytes: 128
    })).resolves.toEqual([{ id: 1, text: "keep me" }]);
  });

  it("accepts CRLF and a final record without a trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-recent-jsonl-crlf-"));
    const path = join(root, "history.jsonl");
    await writeText(path, [
      JSON.stringify({ id: 1, text: "first" }),
      JSON.stringify({ id: 2, text: "last" })
    ].join("\r\n"));

    await expect(readRecentJsonLines(path, RecordSchema, 2, { chunkBytes: 5 })).resolves.toEqual([
      { id: 1, text: "first" },
      { id: 2, text: "last" }
    ]);
  });

  it("returns no records for a missing file or zero limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-recent-jsonl-empty-"));
    const path = join(root, "missing.jsonl");

    await expect(readRecentJsonLines(path, RecordSchema, 10)).resolves.toEqual([]);
    await expect(readRecentJsonLines(path, RecordSchema, 0)).resolves.toEqual([]);
  });
});
