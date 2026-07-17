import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/bootstrap.js";
import { exportDiagnostics } from "../src/core/diagnostics.js";
import { appendJsonLine, pathExists, writeJson, writeText } from "../src/core/file-store.js";
import { WorkerStatusSchema } from "../src/domain/schemas.js";

describe("diagnostics export", () => {
  it("exports bounded state and logs while removing secrets and local paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-diagnostics-"));
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");
    await mkdir(appRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const runtime = await createRuntime(appRoot, workspace);
    try {
      runtime.config.workers.codex.model.env = {
        OPENAI_API_KEY: "CONFIG-MUST-NOT-LEAK",
        HTTPS_PROXY: "http://proxy-user:proxy-password@127.0.0.1:7890/private?token=hidden"
      };
      const task = await runtime.sessions.createTask({
        request: "Build a diagnostics fixture",
        cwd: workspace,
        route: {
          mode: "complex",
          reason: "Test diagnostics",
          source: "forced",
          suggested_roles: [],
          judge_engine: "codex",
          actor_engine: "codex",
          critic_engine: "claude"
        }
      });
      const worker = await runtime.sessions.initializeWorker(task, {
        workerId: "actor-codex",
        role: "actor",
        engine: "codex",
        prompt: "PROMPT-MUST-NOT-LEAK"
      });
      const status = WorkerStatusSchema.parse({
        worker_id: worker.workerId,
        role: "actor",
        engine: "codex",
        state: "done",
        phase: "process-exited",
        last_event_at: "2026-07-17T10:00:00.000Z",
        summary: `done in ${workspace}`,
        native_session_id: "native-session-123"
      });
      await writeJson(worker.statusPath, status);
      await runtime.index.upsertWorker(task.id, status, {
        dir: worker.dir,
        statusPath: worker.statusPath,
        outputLogPath: worker.outputLogPath
      });
      await runtime.sessions.writeNativeSession(worker, {
        engine: "codex",
        role: "actor",
        worker_id: worker.workerId,
        session_id: "native-session-123",
        scope: "task",
        cwd: workspace,
        created_at: "2026-07-17T09:59:00.000Z",
        last_used_at: "2026-07-17T10:00:00.000Z",
        source: "output-detected"
      });
      await writeText(
        worker.outputLogPath,
        [
          "old line one",
          "old line two",
          "old line three",
          `workspace ${workspace}`,
          "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz",
          "npm_token=npm_abcdefghijklmnopqrstuvwxyz123456",
          "request https://url-user:url-password@example.test/private/path?q=secret"
        ].join("\n")
      );
      await writeFile(join(workspace, "private-source.txt"), "SOURCE-MUST-NOT-LEAK\n");
      await appendJsonLine(join(runtime.routerCwd, "routes.jsonl"), {
        time: "2026-07-17T10:00:00.000Z",
        request: "route npm_abcdefghijklmnopqrstuvwxyz123456",
        workspace,
        scope: "initial",
        mode: "complex",
        reason: "connected through http://router-user:router-password@127.0.0.1:7890/private",
        source: "codex",
        suggested_roles: [],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      });

      const result = await exportDiagnostics(appRoot, runtime, {
        now: () => new Date("2026-07-17T10:01:02.000Z"),
        logBytes: 1024,
        logLines: 4,
        doctor: async () => ({
          ok: false,
          text: `workspace permissions: ok (${workspace})\ntoken=ghp_abcdefghijklmnopqrstuvwxyz123456\n`
        })
      });

      expect(result.path).toBe(join(workspace, ".parallel-codex", "diagnostics", "20260717100102"));
      expect(result).toMatchObject({ taskCount: 1, workerCount: 1, logCount: 1 });
      expect(await pathExists(join(result.path, "manifest.json"))).toBe(true);
      expect(await pathExists(join(result.path, "report.md"))).toBe(true);
      expect(await pathExists(join(result.path, "logs", task.id, "actor-codex.log"))).toBe(true);

      const allText = await readDirectoryText(result.path);
      expect(allText).toContain("$WORKSPACE");
      expect(allText).toContain("native-session-123");
      expect(allText).toContain("OPENAI_API_KEY");
      expect(allText).toContain("HTTPS_PROXY");
      expect(allText).toContain("Authorization: Bearer ***");
      expect(allText).toContain("npm_token=***");
      expect(allText).toContain("https://***@example.test");
      expect(allText).not.toContain(workspace);
      expect(allText).not.toContain(appRoot);
      expect(allText).not.toContain("CONFIG-MUST-NOT-LEAK");
      expect(allText).not.toContain("PROMPT-MUST-NOT-LEAK");
      expect(allText).not.toContain("SOURCE-MUST-NOT-LEAK");
      expect(allText).not.toContain("proxy-password");
      expect(allText).not.toContain("url-password");
      expect(allText).not.toContain("router-password");
      expect(allText).not.toContain("abcdefghijklmnopqrstuvwxyz123456");

      const log = await readFile(join(result.path, "logs", task.id, "actor-codex.log"), "utf8");
      expect(log).toContain("[earlier log content omitted]");
      expect(log.split("\n").length).toBeLessThanOrEqual(6);
      const manifest = JSON.parse(await readFile(join(result.path, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        format: "parallel-codex-diagnostics-v1",
        redaction: { enabled: true }
      });
    } finally {
      runtime.index.close();
    }
  });

  it("supports an exact custom destination and cleans staging after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-diagnostics-destination-"));
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");
    const destination = join(root, "support", "bundle");
    await mkdir(appRoot, { recursive: true });
    const runtime = await createRuntime(appRoot, workspace);
    try {
      const result = await exportDiagnostics(appRoot, runtime, {
        destinationPath: destination,
        doctor: async () => ({ ok: true, text: "ok\n" })
      });
      expect(result.path).toBe(destination);
      await expect(exportDiagnostics(appRoot, runtime, {
        destinationPath: destination,
        doctor: async () => ({ ok: true, text: "ok\n" })
      })).rejects.toThrow("already exists");

      const failedDestination = join(root, "support", "failed");
      await expect(exportDiagnostics(appRoot, runtime, {
        destinationPath: failedDestination,
        doctor: async () => {
          throw new Error("doctor failed");
        }
      })).rejects.toThrow("doctor failed");
      expect(await pathExists(failedDestination)).toBe(false);
      expect((await readdir(join(root, "support"))).some((name) => name.startsWith(".parallel-codex-diagnostics-"))).toBe(false);
    } finally {
      runtime.index.close();
    }
  });
});

async function readDirectoryText(root: string): Promise<string> {
  const chunks: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        chunks.push(await readFile(path, "utf8"));
      }
    }
  }
  await visit(root);
  return chunks.join("\n");
}
