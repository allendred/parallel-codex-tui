import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendJsonLine,
  pathExists,
  pathIsDirectory,
  readJson,
  readTextIfExists,
  writeJson,
  writeText
} from "../src/core/file-store.js";
import { TaskMetaSchema } from "../src/domain/schemas.js";

describe("file store", () => {
  it("writes and reads validated JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-file-store-"));
    const file = join(root, "nested", "meta.json");

    await writeJson(file, {
      id: "task-20260630-033000-a1b2",
      title: "Implement wrapper",
      created_at: "2026-06-30T03:30:00.000Z",
      cwd: root,
      mode: "complex",
      status: "created"
    });

    const result = await readJson(file, TaskMetaSchema);
    expect(result.id).toBe("task-20260630-033000-a1b2");
  });

  it("appends JSONL records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-jsonl-"));
    const file = join(root, "events.jsonl");

    await appendJsonLine(file, { type: "task.created" });
    await appendJsonLine(file, { type: "worker.started" });

    const text = await readFile(file, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(text).toContain("\"task.created\"");
  });

  it("reads optional text files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-text-"));
    const file = join(root, "output.log");

    expect(await readTextIfExists(file)).toBe("");
    await writeText(file, "hello\n");

    expect(await pathExists(file)).toBe(true);
    expect(await readTextIfExists(file)).toBe("hello\n");
  });

  it("distinguishes directories from existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-directory-"));
    const file = join(root, "workspace-file");

    await writeText(file, "not a directory");

    expect(await pathExists(file)).toBe(true);
    expect(await pathIsDirectory(root)).toBe(true);
    expect(await pathIsDirectory(file)).toBe(false);
    expect(await pathIsDirectory(join(root, "missing"))).toBe(false);
  });
});
