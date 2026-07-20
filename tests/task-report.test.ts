import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists, writeJson, writeText } from "../src/core/file-store.js";
import { buildTaskReport, reconcileTaskWorkspace } from "../src/core/task-report.js";
import { TaskMetaSchema } from "../src/domain/schemas.js";

describe("task report", () => {
  it("reconciles authoritative integration snapshots against the current workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-task-report-reconcile-"));
    const taskDir = join(workspace, ".parallel-codex", "sessions", "task-report-reconcile");
    const wave1 = join(taskDir, "workspaces", "turn-0001", "wave-0001");
    const wave2 = join(taskDir, "workspaces", "turn-0002", "wave-0001");
    await writeText(join(wave1, "integration", "match.txt"), "same\n");
    await writeText(join(workspace, "match.txt"), "same\n");
    await writeText(join(wave1, "integration", "drift.txt"), "expected\n");
    await writeText(join(workspace, "drift.txt"), "changed\n");
    await writeText(join(wave1, "integration", "missing.txt"), "expected\n");
    await writeText(join(workspace, "deleted.txt"), "returned\n");
    await writeText(join(wave1, "integration", "latest.txt"), "old\n");
    await writeText(join(wave2, "integration", "latest.txt"), "new\n");
    await writeText(join(workspace, "latest.txt"), "new\n");
    await writeJson(join(wave1, "integration.json"), {
      version: 1,
      state: "integrated",
      turn_id: "0001",
      wave: 1,
      feature_ids: ["0001-core"],
      changed_paths: ["match.txt", "drift.txt", "missing.txt", "deleted.txt", "latest.txt", "../outside.txt"]
    });
    await writeJson(join(wave2, "integration.json"), {
      version: 1,
      state: "integrated",
      turn_id: "0002",
      wave: 1,
      feature_ids: ["0002-follow-up"],
      changed_paths: ["latest.txt"]
    });

    const reconciliation = await reconcileTaskWorkspace(taskDir, workspace);

    expect(reconciliation).toMatchObject({
      state: "unavailable",
      integrated_waves: 2,
      changed_paths: 6,
      counts: { match: 2, drift: 1, missing: 1, unexpected: 1, unavailable: 1 }
    });
    expect(reconciliation.paths.find((entry) => entry.path === "latest.txt")).toMatchObject({
      state: "match",
      source: { turn_id: "0002", wave: 1, feature_ids: ["0002-follow-up"] }
    });
    expect(reconciliation.paths.find((entry) => entry.path === "../outside.txt")).toMatchObject({
      state: "unavailable",
      expected: { type: "unavailable", detail: "unsafe relative path" },
      current: { type: "unavailable", detail: "unsafe relative path" }
    });
  });

  it("builds JSON and Markdown evidence for turns, Features, Workers, and native sessions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-task-report-build-"));
    const taskDir = join(workspace, ".parallel-codex", "sessions", "task-report-build");
    const now = "2026-07-20T08:00:00.000Z";
    const task = TaskMetaSchema.parse({
      id: "task-report-build",
      title: "中文任务报告",
      created_at: now,
      cwd: workspace,
      mode: "complex",
      status: "done"
    });
    await writeJson(join(taskDir, "turns", "0001", "turn.json"), {
      task_id: task.id,
      turn_id: "0001",
      created_at: now,
      request_path: "turns/0001/user.md"
    });
    await writeText(join(taskDir, "turns", "0001", "user.md"), "实现中文输入\n并保留完整请求\n");
    await writeJson(join(taskDir, "turns", "0001", "route.json"), {
      mode: "complex",
      reason: "需要修改工程并验证。",
      source: "codex",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "claude"
    });
    await writeText(join(taskDir, "turns", "0001", "requirements.md"), "# Requirements\n\n- 中文输入不能丢字。\n");
    await writeText(join(taskDir, "turns", "0001", "plan.md"), "# Plan\n\n1. 修复输入。\n2. 验证。\n");
    await writeText(join(taskDir, "turns", "0001", "acceptance.md"), "# Acceptance\n\n- 中文回归测试通过。\n");
    await writeJson(join(taskDir, "turns", "0001", "feature-plan.json"), {
      version: 1,
      features: [{ id: "0001-input", title: "输入可靠性" }]
    });
    await writeJson(join(taskDir, "turns", "0001", "judge-validation.json"), {
      version: 1,
      state: "valid",
      issues: []
    });
    await writeText(join(taskDir, "turns", "0001", "supervisor-summary.md"), "任务已通过最终验收。\n");
    await writeJson(join(taskDir, "turns", "0001", "completion-contract.json"), {
      version: 1,
      final_judge_required: true
    });
    await writeJson(join(taskDir, "turns", "0001", "final-acceptance.json"), {
      version: 1,
      decision: "approved",
      summary: "中文输入已验证"
    });
    await writeJson(join(taskDir, "features", "0001-input", "status.json"), {
      feature_id: "0001-input",
      task_id: task.id,
      turn_id: "0001",
      title: "输入可靠性",
      description: "处理中文输入",
      depends_on: [],
      state: "approved",
      updated_at: now
    });
    await writeJson(join(taskDir, "features", "0001-input", "assignment.json"), {
      version: 1,
      actor_engine: "codex",
      critic_engine: "claude",
      actor_model: "gpt-5.6",
      critic_model: "claude-opus",
      actor_override: true,
      critic_override: true,
      updated_at: now
    });
    await writeText(
      join(taskDir, "features", "0001-input", "critic-findings.jsonl"),
      `${JSON.stringify({ summary: "需要覆盖分块 UTF-8 输入" })}\n`
    );
    await writeText(
      join(taskDir, "features", "0001-input", "actor-replies.jsonl"),
      `${JSON.stringify({ summary: "已增加分块 UTF-8 回归测试" })}\n`
    );
    const workerDir = join(taskDir, "actor-codex-0001-input");
    await writeJson(join(workerDir, "status.json"), {
      worker_id: "actor-codex-0001-input",
      feature_id: "0001-input",
      feature_title: "输入可靠性",
      role: "actor",
      engine: "codex",
      model_name: "gpt-5.6",
      model_provider: "openai",
      state: "done",
      phase: "implementation",
      last_event_at: now,
      summary: "实现完成",
      native_session_id: "codex-session-1"
    });
    await writeJson(join(workerDir, "native-session.json"), {
      engine: "codex",
      role: "actor",
      worker_id: "actor-codex-0001-input",
      session_id: "codex-session-1",
      scope: "task",
      cwd: workspace,
      writable_dirs: [workspace],
      created_at: now,
      last_used_at: now,
      source: "output-detected"
    });
    const wave = join(taskDir, "workspaces", "turn-0001", "wave-0001");
    await writeText(join(wave, "integration", "src", "input.ts"), "export const input = true;\n");
    await writeText(join(workspace, "src", "input.ts"), "export const input = true;\n");
    await writeJson(join(wave, "integration.json"), {
      version: 1,
      state: "integrated",
      turn_id: "0001",
      wave: 1,
      feature_ids: ["0001-input"],
      changed_paths: ["src/input.ts"]
    });
    await writeJson(join(wave, "verification.json"), {
      version: 1,
      decision: "approved",
      tests: ["npm test"]
    });
    await writeText(join(wave, "verification-review.md"), "# Verification\n\n`npm test` passed.\n");

    const built = await buildTaskReport({
      task,
      taskDir,
      workspaceRoot: workspace,
      generatedAt: "2026-07-20T09:00:00.000Z"
    });

    expect(built.report.workspace.reconciliation.state).toBe("clean");
    expect(built.report.turns[0]).toMatchObject({
      request: "实现中文输入\n并保留完整请求",
      route: { mode: "complex", reason: "需要修改工程并验证。" },
      requirements: expect.stringContaining("中文输入不能丢字"),
      acceptance_criteria: expect.stringContaining("中文回归测试通过"),
      judge_validation: { state: "valid", issues: [] },
      final_acceptance: { decision: "approved" }
    });
    expect(built.report.features[0]).toMatchObject({
      title: "输入可靠性",
      actor_engine: "codex",
      critic_engine: "claude",
      latest_finding: "需要覆盖分块 UTF-8 输入",
      latest_reply: "已增加分块 UTF-8 回归测试"
    });
    expect(built.report.workers[0]).toMatchObject({
      id: "actor-codex-0001-input",
      model: "gpt-5.6",
      model_provider: "openai",
      native_session: { id: "codex-session-1" }
    });
    expect(built.markdown).toContain("# Task Report: 中文任务报告");
    expect(built.markdown).toContain("实现中文输入");
    expect(built.markdown).toContain("## Workspace Reconciliation");
    expect(built.markdown).toContain("**Requirements**");
    expect(built.markdown).toContain("## Integration And Verification");
    expect(built.markdown).toContain("`npm test` passed");
    expect(built.markdown).toContain("`src/input.ts`");
    expect(built.report.integrations[0]).toMatchObject({
      turn_id: "0001",
      wave: 1,
      verification: { decision: "approved", tests: ["npm test"] }
    });
    expect(await pathExists(join(workspace, "outside.txt"))).toBe(false);
  });

  it("reports that a task has no integration evidence without treating it as drift", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-task-report-empty-"));
    await mkdir(join(workspace, "task"), { recursive: true });

    await expect(reconcileTaskWorkspace(join(workspace, "task"), workspace)).resolves.toMatchObject({
      state: "no-integrations",
      integrated_waves: 0,
      changed_paths: 0
    });
  });
});
