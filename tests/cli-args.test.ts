import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("defaults app root and workspace to cwd", () => {
    const parsed = parseCliArgs([], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.doctor).toBe(false);
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.help).toBe(false);
    expect(parsed.init).toBe(false);
    expect(parsed.taskId).toBeNull();
    expect(parsed.version).toBe(false);
  });

  it("accepts a separate workspace path", () => {
    const parsed = parseCliArgs(["--workspace", "/tmp/game"], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/tmp/game");
  });

  it("accepts an initial task id", () => {
    const parsed = parseCliArgs(["--task", "task-1234"], "/app");

    expect(parsed.taskId).toBe("task-1234");
  });

  it("accepts init without changing workspace parsing", () => {
    const parsed = parseCliArgs(["--init", "--workspace", "game"], "/app");

    expect(parsed.init).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
  });

  it("accepts doctor without changing workspace parsing", () => {
    const parsed = parseCliArgs(["--doctor", "--workspace", "game"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
  });

  it("accepts a separate app root for config lookup", () => {
    const parsed = parseCliArgs(["--app-root", "/tmp/app", "--workspace", "/tmp/work"], "/repo");

    expect(parsed.appRoot).toBe("/tmp/app");
    expect(parsed.workspaceRoot).toBe("/tmp/work");
  });
});
