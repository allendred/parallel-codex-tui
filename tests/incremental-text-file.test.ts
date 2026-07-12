import { appendFile, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIncrementalTextFileReader } from "../src/tui/incremental-text-file.js";

describe("incremental text file reader", () => {
  it("reads an existing file once and only consumes appended bytes afterward", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-incremental-log-"));
    const path = join(root, "output.log");
    const initial = "first line\n";
    const appended = "新增内容\n";
    await writeFile(path, initial, "utf8");
    const reader = createIncrementalTextFileReader(path);

    await expect(reader.read()).resolves.toMatchObject({
      text: initial,
      changed: true,
      reset: false,
      bytesRead: Buffer.byteLength(initial)
    });
    await expect(reader.read()).resolves.toMatchObject({
      text: initial,
      changed: false,
      reset: false,
      bytesRead: 0
    });

    await appendFile(path, appended, "utf8");
    await expect(reader.read()).resolves.toMatchObject({
      text: `${initial}${appended}`,
      changed: true,
      reset: false,
      bytesRead: Buffer.byteLength(appended)
    });
  });

  it("preserves a UTF-8 character split across separate file polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-incremental-utf8-"));
    const path = join(root, "output.log");
    const encoded = Buffer.from("你", "utf8");
    await writeFile(path, encoded.subarray(0, 1));
    const reader = createIncrementalTextFileReader(path);

    await expect(reader.read()).resolves.toMatchObject({ text: "", bytesRead: 1 });
    await appendFile(path, encoded.subarray(1));
    await expect(reader.read()).resolves.toMatchObject({
      text: "你",
      bytesRead: encoded.byteLength - 1
    });
  });

  it("serializes concurrent polls without consuming the same bytes twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-incremental-concurrent-"));
    const path = join(root, "output.log");
    const content = "one shared append\n";
    await writeFile(path, content, "utf8");
    const reader = createIncrementalTextFileReader(path);

    const snapshots = await Promise.all([reader.read(), reader.read()]);

    expect(snapshots.map((snapshot) => snapshot.text)).toEqual([content, content]);
    expect(snapshots.map((snapshot) => snapshot.bytesRead)).toEqual([
      Buffer.byteLength(content),
      0
    ]);
  });

  it("resets stale text when the same file is truncated and rewritten past the old offset", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-incremental-rewrite-"));
    const path = join(root, "output.log");
    const original = `${"old-".repeat(40)}\n`;
    const replacement = `${"new-".repeat(80)}\n`;
    await writeFile(path, original, "utf8");
    const reader = createIncrementalTextFileReader(path);
    await reader.read();

    await writeFile(path, replacement, "utf8");

    await expect(reader.read()).resolves.toMatchObject({
      text: replacement,
      changed: true,
      reset: true,
      bytesRead: Buffer.byteLength(replacement)
    });
  });

  it("clears deleted output and reads a later replacement as a new generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-incremental-recreate-"));
    const path = join(root, "output.log");
    await writeFile(path, "old generation\n", "utf8");
    const reader = createIncrementalTextFileReader(path);
    await reader.read();

    await unlink(path);
    await expect(reader.read()).resolves.toMatchObject({
      text: "",
      changed: true,
      reset: true,
      bytesRead: 0
    });

    await writeFile(path, "new generation\n", "utf8");
    await expect(reader.read()).resolves.toMatchObject({
      text: "new generation\n",
      changed: true,
      reset: false,
      bytesRead: Buffer.byteLength("new generation\n")
    });
  });
});
