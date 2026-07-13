import { describe, expect, it } from "vitest";
import { parseCliArgs, validateCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("defaults app root and workspace to cwd", () => {
    const parsed = parseCliArgs([], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.doctor).toBe(false);
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.help).toBe(false);
    expect(parsed.init).toBe(false);
    expect(parsed.probeRouter).toBe(false);
    expect(parsed.taskId).toBeNull();
    expect(parsed.theme).toBeNull();
    expect(parsed.themes).toBe(false);
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
      ["--app-root=/tmp/app", "--workspace=/tmp/work", "--task=task-1234", "--theme=graphite"],
      "/repo"
    );

    expect(parsed.appRoot).toBe("/tmp/app");
    expect(parsed.workspaceRoot).toBe("/tmp/work");
    expect(parsed.explicitWorkspace).toBe("/tmp/work");
    expect(parsed.taskId).toBe("task-1234");
    expect(parsed.theme).toBe("graphite");
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

  it("accepts a separate theme value", () => {
    const parsed = parseCliArgs(["--theme", "studio"], "/app");

    expect(parsed.theme).toBe("studio");
  });

  it("normalizes theme option whitespace", () => {
    const parsed = parseCliArgs(["--theme", "  paper  "], "/app");

    expect(parsed.theme).toBe("paper");
  });

  it("accepts init without changing workspace parsing", () => {
    const parsed = parseCliArgs(["--init", "--workspace", "game"], "/app");

    expect(parsed.init).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
    expect(parsed.explicitWorkspace).toBe("game");
  });

  it("accepts doctor without changing workspace parsing", () => {
    const parsed = parseCliArgs(["--doctor", "--probe-router", "--workspace", "game"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.probeRouter).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
    expect(parsed.explicitWorkspace).toBe("game");
  });

  it("accepts themes without changing workspace parsing", () => {
    const parsed = parseCliArgs(["--themes", "--workspace", "game"], "/app");

    expect(parsed.themes).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
    expect(parsed.explicitWorkspace).toBe("game");
  });

  it("accepts a separate app root for config lookup", () => {
    const parsed = parseCliArgs(["--app-root", "/tmp/app", "--workspace", "/tmp/work"], "/repo");

    expect(parsed.appRoot).toBe("/tmp/app");
    expect(parsed.workspaceRoot).toBe("/tmp/work");
  });

  it("expands home-relative app root and workspace option values", () => {
    const parsed = parseCliArgs(["--app-root", "~/pct-app", "--workspace", "~/pct-work"], "/repo");

    expect(parsed.appRoot).toMatch(/\/pct-app$/);
    expect(parsed.appRoot).not.toBe("/repo/~/pct-app");
    expect(parsed.workspaceRoot).toMatch(/\/pct-work$/);
    expect(parsed.workspaceRoot).not.toBe("/repo/~/pct-work");
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
        "-t=task-second",
        "--theme",
        "codex",
        "--theme=paper"
      ],
      "/repo"
    );

    expect(parsed.appRoot).toBe("/tmp/second-app");
    expect(parsed.workspaceRoot).toBe("/tmp/second-work");
    expect(parsed.explicitWorkspace).toBe("/tmp/second-work");
    expect(parsed.taskId).toBe("task-second");
    expect(parsed.theme).toBe("paper");
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

  it("does not treat another flag as a theme value", () => {
    const parsed = parseCliArgs(["--theme", "--doctor"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.theme).toBeNull();
  });

  it("ignores empty equals-style option values", () => {
    const parsed = parseCliArgs(["--workspace=", "--app-root=", "--task=", "--theme="], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.taskId).toBeNull();
    expect(parsed.theme).toBeNull();
  });

  it("does not let empty equals-style option values consume the next argument", () => {
    const parsed = parseCliArgs(["--workspace=", "next", "--task=", "task-next", "-w=", "short-next", "-t=", "short-task"], "/app");

    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.taskId).toBeNull();
  });

  it("ignores option-like text after the option terminator", () => {
    const parsed = parseCliArgs(["--workspace", "/tmp/work", "--", "--version", "--workspace", "/tmp/ignored"], "/app");

    expect(parsed.version).toBe(false);
    expect(parsed.workspaceRoot).toBe("/tmp/work");
    expect(parsed.explicitWorkspace).toBe("/tmp/work");
  });
});

describe("validateCliArgs", () => {
  it("reports unknown options before startup can continue", () => {
    expect(validateCliArgs(["--workspacce", "/tmp/project"])).toEqual(["Unknown option: --workspacce"]);
  });

  it("rejects invalid theme names before startup can continue", () => {
    expect(validateCliArgs(["--theme", "solarized"])).toEqual([
      "Invalid --theme: solarized (expected codex, graphite, paper, aurora, studio)"
    ]);
  });

  it("rejects task ids that contain path separators", () => {
    expect(validateCliArgs(["--task", "task-a/../../outside"])).toEqual([
      "Invalid --task: expected task- followed by letters, numbers, dot, underscore, or hyphen"
    ]);
    expect(validateCliArgs(["--task=task-safe_01"])).toEqual([]);
  });

  it("validates normalized theme option values", () => {
    expect(validateCliArgs(["--theme", "  graphite  "])).toEqual([]);
  });

  it("accepts the theme catalog command", () => {
    expect(validateCliArgs(["--themes"])).toEqual([]);
  });

  it("requires doctor mode for a live Router probe", () => {
    expect(validateCliArgs(["--probe-router"])).toEqual(["--probe-router requires --doctor"]);
    expect(validateCliArgs(["--doctor", "--probe-router"])).toEqual([]);
  });

  it("allows positional text after an option terminator", () => {
    expect(validateCliArgs(["--workspace", "/tmp/project", "--", "--not-a-flag"])).toEqual([]);
  });
});
