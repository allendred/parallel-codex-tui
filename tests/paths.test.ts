import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routerRuntimeDir, sessionsRoot, taskDir } from "../src/core/paths.js";

describe("paths", () => {
  it("keeps router runtime files separate from workspace sessions", () => {
    const root = "/tmp/parallel-codex";

    expect(routerRuntimeDir(root, ".parallel-codex")).toBe(join(root, ".parallel-codex", "router"));
    expect(sessionsRoot(root, ".parallel-codex")).toBe(join(root, ".parallel-codex", "sessions"));
    expect(taskDir(root, ".parallel-codex", "task-a")).toBe(join(root, ".parallel-codex", "sessions", "task-a"));
  });

  it("rejects task ids that could escape the sessions directory", () => {
    const root = "/tmp/parallel-codex";

    expect(() => taskDir(root, ".parallel-codex", "../outside")).toThrow("Invalid task session id");
    expect(() => taskDir(root, ".parallel-codex", "task-a/../../outside")).toThrow("Invalid task session id");
    expect(taskDir(root, ".parallel-codex", "main")).toBe(join(root, ".parallel-codex", "sessions", "main"));
  });
});
