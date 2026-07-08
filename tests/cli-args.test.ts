import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("defaults app root and workspace to cwd", () => {
    const parsed = parseCliArgs([], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.doctor).toBe(false);
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.help).toBe(false);
    expect(parsed.init).toBe(false);
    expect(parsed.taskId).toBeNull();
    expect(parsed.version).toBe(false);
  });

  it("accepts a separate workspace path", () => {
    const parsed = parseCliArgs(["--workspace", "/tmp/game"], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/tmp/game");
    expect(parsed.explicitWorkspace).toBe("/tmp/game");
  });

  it("accepts equals-style long option values", () => {
    const parsed = parseCliArgs(
      ["--app-root=/tmp/app", "--workspace=/tmp/work", "--task=task-1234"],
      "/repo"
    );

    expect(parsed.appRoot).toBe("/tmp/app");
    expect(parsed.workspaceRoot).toBe("/tmp/work");
    expect(parsed.explicitWorkspace).toBe("/tmp/work");
    expect(parsed.taskId).toBe("task-1234");
  });

  it("accepts equals-style short option values", () => {
    const parsed = parseCliArgs(["-w=/tmp/work", "-t=task-short"], "/repo");

    expect(parsed.workspaceRoot).toBe("/tmp/work");
    expect(parsed.explicitWorkspace).toBe("/tmp/work");
    expect(parsed.taskId).toBe("task-short");
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
    expect(parsed.explicitWorkspace).toBe("game");
  });

  it("accepts doctor without changing workspace parsing", () => {
    const parsed = parseCliArgs(["--doctor", "--workspace", "game"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
    expect(parsed.explicitWorkspace).toBe("game");
  });

  it("accepts a separate app root for config lookup", () => {
    const parsed = parseCliArgs(["--app-root", "/tmp/app", "--workspace", "/tmp/work"], "/repo");

    expect(parsed.appRoot).toBe("/tmp/app");
    expect(parsed.workspaceRoot).toBe("/tmp/work");
  });

  it("uses the last provided value when value flags are repeated", () => {
    const parsed = parseCliArgs(
      [
        "--app-root",
        "/tmp/first-app",
        "--app-root=/tmp/second-app",
        "--workspace",
        "/tmp/first-work",
        "-w=/tmp/second-work",
        "--task",
        "task-first",
        "-t=task-second"
      ],
      "/repo"
    );

    expect(parsed.appRoot).toBe("/tmp/second-app");
    expect(parsed.workspaceRoot).toBe("/tmp/second-work");
    expect(parsed.explicitWorkspace).toBe("/tmp/second-work");
    expect(parsed.taskId).toBe("task-second");
  });

  it("does not treat another flag as a workspace value", () => {
    const parsed = parseCliArgs(["--workspace", "--doctor"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.workspaceRoot).toBe("/app");
  });

  it("does not treat another flag as an app root value", () => {
    const parsed = parseCliArgs(["--app-root", "--doctor"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.appRoot).toBe("/app");
  });

  it("does not treat another flag as a task id", () => {
    const parsed = parseCliArgs(["--task", "--doctor"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.taskId).toBeNull();
  });

  it("ignores empty equals-style option values", () => {
    const parsed = parseCliArgs(["--workspace=", "--app-root=", "--task="], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.taskId).toBeNull();
  });

  it("does not let empty equals-style option values consume the next argument", () => {
    const parsed = parseCliArgs(["--workspace=", "next", "--task=", "task-next", "-w=", "short-next", "-t=", "short-task"], "/app");

    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.taskId).toBeNull();
  });
});
