import { describe, expect, it } from "vitest";
import { parseCliArgs, validateCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("defaults app root and workspace to cwd", () => {
    const parsed = parseCliArgs([], "/app");

    expect(parsed.appRoot).toBe("/app");
    expect(parsed.cancelRun).toBe(false);
    expect(parsed.cancelRunId).toBeNull();
    expect(parsed.diagnostics).toBe(false);
    expect(parsed.diagnosticsPath).toBeNull();
    expect(parsed.doctor).toBe(false);
    expect(parsed.workspaceRoot).toBe("/app");
    expect(parsed.explicitWorkspace).toBeNull();
    expect(parsed.help).toBe(false);
    expect(parsed.init).toBe(false);
    expect(parsed.json).toBe(false);
    expect(parsed.probeAgents).toBe(false);
    expect(parsed.probeRouter).toBe(false);
    expect(parsed.runs).toBe(false);
    expect(parsed.submit).toBe(false);
    expect(parsed.submitRequest).toBeNull();
    expect(parsed.idempotencyKey).toBeNull();
    expect(parsed.wait).toBe(false);
    expect(parsed.waitRun).toBe(false);
    expect(parsed.waitRunId).toBeNull();
    expect(parsed.waitTimeoutMs).toBeNull();
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
    const parsed = parseCliArgs(["--doctor", "--probe-agents", "--probe-router", "--workspace", "game"], "/app");

    expect(parsed.doctor).toBe(true);
    expect(parsed.probeAgents).toBe(true);
    expect(parsed.probeRouter).toBe(true);
    expect(parsed.appRoot).toBe("/app");
    expect(parsed.workspaceRoot).toBe("/app/game");
    expect(parsed.explicitWorkspace).toBe("game");
  });

  it("accepts diagnostics with an optional destination directory", () => {
    const automatic = parseCliArgs(["--diagnostics", "--workspace", "game"], "/app");
    const explicit = parseCliArgs(["--diagnostics=./support-bundle"], "/app");

    expect(automatic.diagnostics).toBe(true);
    expect(automatic.diagnosticsPath).toBeNull();
    expect(explicit.diagnostics).toBe(true);
    expect(explicit.diagnosticsPath).toBe("/app/support-bundle");
  });

  it("accepts Supervisor status, cancellation, and wait command options", () => {
    const runs = parseCliArgs(["--runs", "--json", "--workspace", "game"], "/app");
    const latest = parseCliArgs(["--cancel-run", "--workspace", "game"], "/app");
    const selected = parseCliArgs(["--cancel-run=run-20260721T000000Z-deadbeef"], "/app");
    const waitLatest = parseCliArgs(["--wait-run", "--wait-timeout", "1.5"], "/app");
    const waitSelected = parseCliArgs(["--wait-run=run-20260721T000000Z-deadbeef", "--json"], "/app");

    expect(runs.runs).toBe(true);
    expect(runs.json).toBe(true);
    expect(latest.cancelRun).toBe(true);
    expect(latest.cancelRunId).toBeNull();
    expect(selected.cancelRun).toBe(true);
    expect(selected.cancelRunId).toBe("run-20260721T000000Z-deadbeef");
    expect(waitLatest.waitRun).toBe(true);
    expect(waitLatest.waitRunId).toBeNull();
    expect(waitLatest.waitTimeoutMs).toBe(1500);
    expect(waitSelected.waitRun).toBe(true);
    expect(waitSelected.waitRunId).toBe("run-20260721T000000Z-deadbeef");
    expect(waitSelected.json).toBe(true);
  });

  it("accepts detached submissions, stdin, waiting, and idempotency", () => {
    const direct = parseCliArgs([
      "--submit",
      "build a game",
      "--idempotency-key",
      "ci:game-1",
      "--json"
    ], "/app");
    const stdin = parseCliArgs(["--submit=-", "--wait", "--wait-timeout=2.5"], "/app");

    expect(direct.submit).toBe(true);
    expect(direct.submitRequest).toBe("build a game");
    expect(direct.idempotencyKey).toBe("ci:game-1");
    expect(direct.json).toBe(true);
    expect(stdin.submit).toBe(true);
    expect(stdin.submitRequest).toBe("-");
    expect(stdin.wait).toBe(true);
    expect(stdin.waitTimeoutMs).toBe(2500);
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

  it("accepts diagnostics as a standalone or value option", () => {
    expect(validateCliArgs(["--diagnostics"])).toEqual([]);
    expect(validateCliArgs(["--diagnostics=/tmp/support"])).toEqual([]);
  });

  it("validates Supervisor status, cancellation, and wait options", () => {
    expect(validateCliArgs(["--runs"])).toEqual([]);
    expect(validateCliArgs(["--runs", "--json"])).toEqual([]);
    expect(validateCliArgs(["--cancel-run"])).toEqual([]);
    expect(validateCliArgs(["--cancel-run=run-safe_01", "--json"])).toEqual([]);
    expect(validateCliArgs(["--wait-run"])).toEqual([]);
    expect(validateCliArgs(["--wait-run=run-safe_01", "--wait-timeout", "2.5", "--json"])).toEqual([]);
    expect(validateCliArgs(["--runs", "--cancel-run"])).toEqual([
      "Only one of --runs, --cancel-run, --wait-run, or --submit may be used"
    ]);
    expect(validateCliArgs(["--cancel-run", "--wait-run"])).toEqual([
      "Only one of --runs, --cancel-run, --wait-run, or --submit may be used"
    ]);
    expect(validateCliArgs(["--json"])).toEqual([
      "--json requires --runs, --cancel-run, --wait-run, or --submit"
    ]);
    expect(validateCliArgs(["--cancel-run=../../outside"])).toEqual([
      "Invalid --cancel-run: expected run- followed by letters, numbers, dot, underscore, or hyphen"
    ]);
    expect(validateCliArgs(["--wait-run=../../outside"])).toEqual([
      "Invalid --wait-run: expected run- followed by letters, numbers, dot, underscore, or hyphen"
    ]);
    expect(validateCliArgs(["--wait-run", "--wait-timeout", "0"])).toEqual([
      "Invalid --wait-timeout: expected a positive number of seconds"
    ]);
    expect(validateCliArgs(["--wait-timeout", "5"])).toEqual([
      "--wait-timeout requires --wait-run or --submit"
    ]);
    expect(validateCliArgs(["--wait-run", "--wait-timeout"])).toEqual([
      "Invalid --wait-timeout: expected a positive number of seconds"
    ]);
  });

  it("validates detached submission command combinations", () => {
    expect(validateCliArgs(["--submit", "build it"])).toEqual([]);
    expect(validateCliArgs(["--submit", "-", "--wait", "--json"])).toEqual([]);
    expect(validateCliArgs(["--submit=build it", "--wait-timeout", "5"])).toEqual([]);
    expect(validateCliArgs(["--submit", "build", "--idempotency-key", "ci:build-1"])).toEqual([]);
    expect(validateCliArgs(["--submit"])).toEqual([
      "Invalid --submit: expected request text or - for piped stdin"
    ]);
    expect(validateCliArgs(["--submit", "build", "--runs"])).toEqual([
      "Only one of --runs, --cancel-run, --wait-run, or --submit may be used"
    ]);
    expect(validateCliArgs(["--wait"])).toEqual(["--wait requires --submit"]);
    expect(validateCliArgs(["--idempotency-key", "ci-1"])).toEqual([
      "--idempotency-key requires --submit"
    ]);
    expect(validateCliArgs(["--submit", "build", "--idempotency-key", "bad/key"])).toEqual([
      "Invalid --idempotency-key: expected 1-128 letters, numbers, dot, underscore, colon, or hyphen"
    ]);
  });

  it("requires doctor mode for a live Router probe", () => {
    expect(validateCliArgs(["--probe-router"])).toEqual(["--probe-router requires --doctor"]);
    expect(validateCliArgs(["--doctor", "--probe-router"])).toEqual([]);
  });

  it("requires doctor mode for live Agent probes", () => {
    expect(validateCliArgs(["--probe-agents"])).toEqual(["--probe-agents requires --doctor"]);
    expect(validateCliArgs(["--doctor", "--probe-agents"])).toEqual([]);
  });

  it("allows positional text after an option terminator", () => {
    expect(validateCliArgs(["--workspace", "/tmp/project", "--", "--not-a-flag"])).toEqual([]);
  });
});
