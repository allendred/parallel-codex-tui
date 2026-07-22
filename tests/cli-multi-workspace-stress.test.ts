import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ChatRecordSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import type { SupervisorSubmitAndWaitResult } from "../src/supervisor/operations.js";
import { readSupervisorRunRequest, readSupervisorRunState, supervisorRunFiles } from "../src/supervisor/store.js";

const execFileAsync = promisify(execFile);
const stressIt = process.env.PCT_STRESS_TESTS === "1" ? it : it.skip;

describe("CLI multi-workspace restart stress", () => {
  stressIt("isolates two concurrent workspaces across repeated simple and complex CLI restarts", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-stress-app-"));
    const projectsRoot = await mkdtemp(join(tmpdir(), "pct-stress-workspaces-"));
    const workspaces = [join(projectsRoot, "alpha"), join(projectsRoot, "beta")] as const;
    const simpleRounds = 10;
    const followUpRounds = 5;

    try {
      await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));
      await writeMockConfig(appRoot, "simple");

      for (let round = 1; round <= simpleRounds; round += 1) {
        const results = await Promise.all(workspaces.map((workspace, workspaceIndex) => submitAndWait({
          appRoot,
          workspace,
          request: `工作区${workspaceIndex + 1}简单轮次${round}`,
          idempotencyKey: `stress-simple-${workspaceIndex}-${round}`
        })));
        expect(results.map((result) => result.wait.outcome)).toEqual(["completed", "completed"]);
      }

      await Promise.all(workspaces.map(async (workspace) => {
        const session = JSON.parse(await readFile(join(
          workspace,
          ".parallel-codex",
          "sessions",
          "main",
          "main-mock",
          "native-session.json"
        ), "utf8")) as { session_id?: string };
        expect(session.session_id).toBe("mock-main-mock");
      }));

      await writeMockConfig(appRoot, "complex");
      const initial = await Promise.all(workspaces.map((workspace, workspaceIndex) => submitAndWait({
        appRoot,
        workspace,
        request: `工作区${workspaceIndex + 1}复杂初始任务`,
        idempotencyKey: `stress-complex-${workspaceIndex}-initial`
      })));
      const taskIds = initial.map((result) => result.wait.run.task_id);
      expect(taskIds[0]).toMatch(/^task-/);
      expect(taskIds[1]).toMatch(/^task-/);
      expect(taskIds[0]).not.toBe(taskIds[1]);

      for (let round = 1; round <= followUpRounds; round += 1) {
        const results = await Promise.all(workspaces.map((workspace, workspaceIndex) => submitAndWait({
          appRoot,
          workspace,
          taskId: taskIds[workspaceIndex]!,
          request: `工作区${workspaceIndex + 1}复杂追问轮次${round}`,
          idempotencyKey: `stress-complex-${workspaceIndex}-${round}`
        })));
        expect(results.map((result) => result.submission.run.kind)).toEqual([
          "handle-task-turn",
          "handle-task-turn"
        ]);
        expect(results.map((result) => result.wait.run.task_id)).toEqual(taskIds);
      }

      await Promise.all(workspaces.map(async (workspace, workspaceIndex) => {
        const taskId = taskIds[workspaceIndex]!;
        const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
        const meta = TaskMetaSchema.parse(JSON.parse(await readFile(join(taskDir, "meta.json"), "utf8")));
        expect(meta.status).toBe("done");

        const turns = (await readdir(join(taskDir, "turns")))
          .filter((entry) => /^\d{4}$/.test(entry))
          .sort();
        expect(turns).toEqual(Array.from(
          { length: followUpRounds + 1 },
          (_, index) => String(index + 1).padStart(4, "0")
        ));

        const workerStatuses = await readWorkerStatuses(taskDir);
        expect(workerStatuses.length).toBeGreaterThanOrEqual((followUpRounds + 1) * 3);
        expect(new Set(workerStatuses.map((status) => status.state))).toEqual(new Set(["done"]));

        const history = await readChatRecords(workspace);
        const ownPrefix = `工作区${workspaceIndex + 1}`;
        const otherPrefix = `工作区${workspaceIndex === 0 ? 2 : 1}`;
        expect(history.filter((record) => record.from === "system" && record.text.includes(ownPrefix)))
          .toHaveLength(simpleRounds);
        expect(history.some((record) => record.text.includes(otherPrefix))).toBe(false);

        const runsRoot = join(workspace, ".parallel-codex", "supervisor", "runs");
        const runNames = (await readdir(runsRoot)).filter((entry) => entry.startsWith("run-"));
        expect(runNames).toHaveLength(simpleRounds + followUpRounds + 1);
        const runFiles = runNames.map((runName) => supervisorRunFiles(join(runsRoot, runName)));
        const runStates = await Promise.all(runFiles.map(readSupervisorRunState));
        expect(new Set(runStates.map((state) => state.status))).toEqual(new Set(["completed"]));
        expect(new Set(runStates.map((state) => state.workspace_root))).toEqual(new Set([workspace]));
        const requests = await Promise.all(runFiles.map(readSupervisorRunRequest));
        expect(requests.filter((request) => "request" in request && request.request.startsWith(ownPrefix)))
          .toHaveLength(simpleRounds + followUpRounds + 1);
        expect(requests.some((request) => "request" in request && request.request.includes(otherPrefix)))
          .toBe(false);
      }));

      const remembered = await readFile(join(appRoot, ".parallel-codex", "workspaces.json"), "utf8");
      expect(remembered).toContain(workspaces[0]);
      expect(remembered).toContain(workspaces[1]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(projectsRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

async function writeMockConfig(appRoot: string, mode: "simple" | "complex"): Promise<void> {
  await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
  await writeFile(join(appRoot, ".parallel-codex", "config.toml"), [
    "[router]",
    `defaultMode = "${mode}"`,
    "",
    "[pairing]",
    'main = "mock"',
    'judge = "mock"',
    'actor = "mock"',
    'critic = "mock"',
    ""
  ].join("\n"), "utf8");
}

async function submitAndWait(input: {
  appRoot: string;
  workspace: string;
  request: string;
  idempotencyKey: string;
  taskId?: string;
}): Promise<SupervisorSubmitAndWaitResult> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.tsx",
    "--app-root",
    input.appRoot,
    "--workspace",
    input.workspace,
    ...(input.taskId ? ["--task", input.taskId] : []),
    "--submit",
    input.request,
    "--idempotency-key",
    input.idempotencyKey,
    "--wait",
    "--wait-timeout",
    "30",
    "--json"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
    maxBuffer: 2 * 1024 * 1024
  });
  expect(stderr).toBe("");
  const result = JSON.parse(stdout) as SupervisorSubmitAndWaitResult;
  expect(result.wait.outcome).toBe("completed");
  return result;
}

async function readChatRecords(workspace: string) {
  const text = await readFile(join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map((line) => ChatRecordSchema.parse(JSON.parse(line)));
}

async function readWorkerStatuses(root: string) {
  const statusPaths = await findNamedFiles(root, "status.json");
  const statuses = await Promise.all(statusPaths.map(async (path) => {
    const parsed = WorkerStatusSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  }));
  return statuses.filter((status): status is NonNullable<typeof status> => status !== null);
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findNamedFiles(path, name));
    } else if (entry.isFile() && entry.name === name) {
      found.push(path);
    }
  }
  return found;
}
