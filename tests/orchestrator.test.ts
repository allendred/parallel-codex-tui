import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { appendJsonLine, appendText, pathExists, readJson, readTextIfExists, writeJson, writeText } from "../src/core/file-store.js";
import { SessionIndex } from "../src/core/session-index.js";
import { SessionManager, type TaskSession } from "../src/core/session-manager.js";
import { claimTaskRunLease, taskRunOwnerPath } from "../src/core/process-ownership.js";
import { NativeSessionSchema, RouteDecisionSchema, TaskMetaSchema, WorkerStatusSchema, type RouteDecision, type TaskState } from "../src/domain/schemas.js";
import { Orchestrator, type FeatureRunProgress } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";
import { ProcessWorkerAdapter } from "../src/workers/process-adapter.js";
import { parseTaskResultSummary } from "../src/tui/task-result.js";
import type { WorkerAdapter, WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

function mockConfig(root: string) {
  const config = defaultConfig(root);
  config.pairing.judge = "mock";
  config.pairing.actor = "mock";
  config.pairing.critic = "mock";
  config.pairing.main = "mock";
  config.router.defaultMode = "complex";
  config.router.codex.maxAttempts = 1;
  config.router.codex.retryDelayMs = 0;
  config.workers.mock.command = "mock";
  return config;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise
  };
}

async function featureStates(taskDir: string, count: number): Promise<string[]> {
  const states: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const status = JSON.parse(await readTextIfExists(join(
      taskDir,
      "features",
      `0001-module-${index}`,
      "status.json"
    ))) as { state?: unknown };
    states.push(typeof status.state === "string" ? status.state : "missing");
  }
  return states;
}

describe("Orchestrator", () => {
  it("does not create Judge Actor Critic sessions for simple requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-simple-"));
    const config = mockConfig(root);
    config.router.defaultMode = "simple";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));

    const result = await orchestrator.handleRequest({
      request: "解释一下 actor critic",
      cwd: root
    });

    expect(result.mode).toBe("simple");
    expect(result.taskId).toBeNull();
    expect(result.summary).toBe("Mock simple response for: 解释一下 actor critic");
    expect(result.workers.map((worker) => worker.id)).toEqual(["main-mock"]);
    expect(await pathExists(join(root, ".parallel-codex", "sessions"))).toBe(true);
    expect(await pathExists(join(root, ".parallel-codex", "sessions", "main"))).toBe(true);
    expect(await pathExists(join(root, ".parallel-codex", "sessions", "main", "judge-mock"))).toBe(false);
  });

  it("does not expose router debug text when a simple main worker returns no visible output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-simple-empty-"));
    const config = mockConfig(root);
    config.router.defaultMode = "simple";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new EmptyMainWorkerAdapter()]]));

    const result = await orchestrator.handleRequest({
      request: "你好",
      cwd: root
    });

    expect(result.mode).toBe("simple");
    expect(result.summary).toContain("简单对话通道没有收到可显示回复");
    expect(result.summary).not.toContain("main worker");
    expect(result.summary).not.toContain("Simple route selected");
    expect(result.summary).not.toContain("Forced simple mode");
  });

  it("passes configured main role instructions into simple chat prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-main-role-"));
    const config = mockConfig(root);
    config.router.defaultMode = "simple";
    config.roles.main = {
      title: "Guide",
      instructions: ["Answer in concise Chinese.", "Keep prior context."]
    };
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir
    });
    const adapter = new CapturingAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    const result = await orchestrator.handleRequest({
      request: "解释 actor critic",
      cwd: root
    });

    expect(adapter.runs[0]?.prompt).toContain("# Role: Guide");
    expect(adapter.runs[0]?.prompt).toContain("- Answer in concise Chinese.");
    expect(adapter.runs[0]?.prompt).toContain("- Keep prior context.");
    expect(adapter.runs[0]?.prompt).toContain("User request:\n解释 actor critic");
    expect(result.summary).toBe("Mock simple response for: 解释 actor critic");
  });

  it("reuses the main native session across simple chat turns and restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-main-session-"));
    const config = mockConfig(root);
    config.router.defaultMode = "simple";
    const firstIndex = await SessionIndex.open(root, config.dataDir);
    const firstAdapter = new CapturingAdapter();

    try {
      const firstManager = new SessionManager({
        projectRoot: root,
        dataDir: config.dataDir,
        index: firstIndex
      });
      const firstOrchestrator = new Orchestrator(config, firstManager, new Map([["mock", firstAdapter]]));
      await firstOrchestrator.handleRequest({ request: "记住暗号蓝色", cwd: root });
    } finally {
      firstIndex.close();
    }

    const secondIndex = await SessionIndex.open(root, config.dataDir);

    try {
      await secondIndex.rebuildFromFiles();
      await expect(secondIndex.countRows("native_sessions")).resolves.toBe(1);
      const secondAdapter = new CapturingAdapter();
      const secondManager = new SessionManager({
        projectRoot: root,
        dataDir: config.dataDir,
        index: secondIndex
      });
      const secondOrchestrator = new Orchestrator(config, secondManager, new Map([["mock", secondAdapter]]));
      await secondOrchestrator.handleRequest({ request: "暗号是什么", cwd: root });

      expect(firstAdapter.runs[0]?.nativeSession?.session_id).toBeUndefined();
      expect(secondAdapter.runs[0]?.nativeSession?.session_id).toBe("mock-main-mock");
      const mainSessionPath = join(
        root,
        config.dataDir,
        "sessions",
        "main",
        "main-mock",
        "native-session.json"
      );
      const mainSession = await readJson(mainSessionPath, NativeSessionSchema);
      expect(mainSession.scope).toBe("main");
      await expect(secondIndex.countRows("native_sessions")).resolves.toBe(1);
    } finally {
      secondIndex.close();
    }
  });

  it("runs Judge Actor Critic for complex requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-complex-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));
    const statuses: string[] = [];
    const workerLabels: string[] = [];

    const result = await orchestrator.handleRequest({
      request: "实现 parallel coding worker 状态栏",
      cwd: root,
      onStatus: (status) => statuses.push([status.judge, status.actor, status.critic].join("/")),
      onWorker: (worker) => workerLabels.push(worker.label)
    });

    expect(result.mode).toBe("complex");
    expect(result.taskId).toBe("task-20260630-033000-a1b2");
    expect(result.summary).toContain("APPROVED");
    expect(result.workers.map((worker) => worker.id)).toEqual(["judge-mock", "actor-mock", "critic-mock"]);
    expect(workerLabels).toEqual(["Judge (mock)", "Actor (mock)", "Critic (mock)"]);
    expect(statuses).toContain("running/waiting/waiting");
    expect(statuses).toContain("done/done/done");

    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033000-a1b2");
    expect(await readTextIfExists(join(taskDir, "judge-mock", "requirements.md"))).toContain("Mock requirements");
    expect(await readTextIfExists(join(taskDir, "actor-mock", "worklog.md"))).toContain("Mock actor");
    expect(await readTextIfExists(join(taskDir, "critic-mock", "review.md"))).toContain("APPROVED");

    const actorStatus = await readJson(join(taskDir, "actor-mock", "status.json"), WorkerStatusSchema);
    expect(actorStatus.state).toBe("done");
    expect(await readTextIfExists(join(taskDir, "turns", "0001", "user.md"))).toContain(
      "实现 parallel coding worker 状态栏"
    );
    expect(JSON.parse(await readTextIfExists(join(taskDir, "turns", "0001", "judge-validation.json")))).toMatchObject({
      version: 1,
      state: "valid",
      artifacts: {
        "requirements.md": { state: "valid", item_count: 1 },
        "plan.md": { state: "valid", item_count: 2 },
        "acceptance.md": { state: "valid", item_count: 1 }
      }
    });
    expect(await readTextIfExists(join(taskDir, "actor-mock", "prompt.md"))).toContain("Current turn: 0001");

    const featureDir = join(taskDir, "features", "0001-parallel-coding-worker");
    expect(await readTextIfExists(join(featureDir, "spec.md"))).toContain("实现 parallel coding worker 状态栏");
    expect(await readTextIfExists(join(featureDir, "actor-worklog.md"))).toContain("Mock actor");
    expect(await readTextIfExists(join(featureDir, "critic-findings.jsonl"))).toBe("");
    expect(JSON.parse(await readTextIfExists(join(featureDir, "finding-resolution.json")))).toMatchObject({
      decision: "approved",
      finding_ids: [],
      unresolved_ids: []
    });
    expect(await readTextIfExists(join(featureDir, "decisions.md"))).toContain("APPROVED");
    expect(await readTextIfExists(join(taskDir, "actor-mock", "prompt.md"))).toContain(`Feature directory: ${featureDir}`);
    expect(await readTextIfExists(join(taskDir, "critic-mock", "prompt.md"))).toContain("critic-findings.jsonl");
    expect(await readTextIfExists(join(taskDir, "dialogue", "actor-critic.jsonl"))).toContain('"type":"critic.completed"');
  });

  it("stops before Actor when Judge artifacts are not executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-judge-contract-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:01.000Z"),
      randomId: () => "judge-contract"
    });
    const adapter = new InvalidJudgeContractAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    await expect(orchestrator.handleRequest({
      request: "实现一项需要明确需求的功能",
      cwd: root
    })).rejects.toThrow("Judge artifacts failed validation");

    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033001-judge-contract");
    const report = JSON.parse(await readTextIfExists(join(taskDir, "turns", "0001", "judge-validation.json"))) as {
      state: string;
      issues: Array<{ file: string; code: string }>;
    };
    expect(report.state).toBe("invalid");
    expect(report.issues).toContainEqual({
      file: "requirements.md",
      code: "missing_list_items",
      message: "requirements.md must contain at least one Markdown list requirement."
    });
    expect(adapter.roles).toEqual(["judge"]);
    expect(await pathExists(join(taskDir, "actor-mock"))).toBe(false);
  });

  it("publishes completion evidence before exposing the terminal done state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-completion-order-"));
    const config = mockConfig(root);
    const manager = new CompletionOrderingSessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "completion-order"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]])
    );

    await orchestrator.handleRequest({
      request: "build completion ordering",
      cwd: root
    });

    expect(manager.doneEvidence).toEqual([{
      summary: true,
      decision: true,
      featureApproved: true
    }]);
  });

  it("requires an explicit decision from a Feature Critic", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-no-decision-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:01.000Z"),
      randomId: () => "feature-decision"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MissingFeatureDecisionAdapter()]])
    );

    await expect(orchestrator.handleRequest({
      request: "实现一个必须审查的功能",
      cwd: root
    })).rejects.toThrow("must include APPROVED or REVISION_REQUIRED");

    expect(await pathExists(join(root, "rejected.txt"))).toBe(false);
    expect((await readJson(join(
      root,
      ".parallel-codex",
      "sessions",
      "task-20260630-033001-feature-decision",
      "meta.json"
    ), TaskMetaSchema)).status).toBe("failed");
  });

  it("accepts Critic decisions formatted as Markdown headings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-markdown-decision-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:01.500Z"),
      randomId: () => "markdown-decision"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MarkdownApprovalAdapter()]])
    );

    await expect(orchestrator.handleRequest({
      request: "实现并审查 Markdown 决策",
      cwd: root
    })).resolves.toMatchObject({ mode: "complex" });
  });

  it("commits a single Feature workspace only after Critic approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-single-isolation-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:02.000Z"),
      randomId: () => "single-safe"
    });
    const adapter = new SingleIsolationAdapter(root);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const progress: FeatureRunProgress[] = [];

    const result = await orchestrator.handleRequest({
      request: "实现单个安全功能",
      cwd: root,
      onStatus: (status) => {
        if (status.featureProgress) progress.push(status.featureProgress);
      }
    });

    expect(adapter.actorCwd).not.toBe(root);
    expect(adapter.criticCwd).not.toBe(adapter.actorCwd);
    expect(adapter.criticCwd).toContain(join("reviews", "0001"));
    expect(adapter.actorIsolation).toBe(true);
    expect(adapter.criticIsolation).toBe(true);
    expect(adapter.criticSawActorChange).toBe(true);
    expect(adapter.liveWasUntouchedDuringCritic).toBe(true);
    expect(await readTextIfExists(join(root, "approved.txt"))).toBe("approved\n");
    expect(await pathExists(join(root, "critic-only.txt"))).toBe(false);
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "integration", completed: 0, total: 1 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "integration", completed: 1, total: 1 });
    const taskDir = join(root, ".parallel-codex", "sessions", result.taskId ?? "");
    expect(JSON.parse(await readTextIfExists(join(taskDir, "actor-mock", "native-session.json"))).cwd).toBe(adapter.actorCwd);
    expect(JSON.parse(await readTextIfExists(join(taskDir, "critic-mock", "native-session.json"))).cwd).toBe(adapter.criticCwd);
  });

  it("runs independent feature pairs concurrently and waits for dependency waves", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-parallel-features-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "wave"
    });
    const adapter = new MultiFeatureAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    const result = await orchestrator.handleRequest({
      request: "实现游戏界面、规则引擎并完成集成",
      cwd: root
    });

    const taskDir = join(root, ".parallel-codex", "sessions", result.taskId ?? "");
    expect(adapter.maxConcurrentActors).toBe(2);
    expect(adapter.actorCwds.get("0001-ui")).not.toBe(root);
    expect(adapter.actorCwds.get("0001-engine")).not.toBe(root);
    expect(adapter.actorCwds.get("0001-ui")).not.toBe(adapter.actorCwds.get("0001-engine"));
    expect(adapter.criticCwds.get("0001-ui")).not.toBe(adapter.actorCwds.get("0001-ui"));
    expect(adapter.criticCwds.get("0001-engine")).not.toBe(adapter.actorCwds.get("0001-engine"));
    expect(adapter.criticCwds.get("0001-ui")).toContain(join("reviews", "0001-ui"));
    expect(adapter.criticCwds.get("0001-engine")).toContain(join("reviews", "0001-engine"));
    expect(adapter.criticSawActorChanges.get("0001-ui")).toBe(true);
    expect(adapter.criticSawActorChanges.get("0001-engine")).toBe(true);
    expect(adapter.integrationSawDependencies).toBe(true);
    expect(await readTextIfExists(join(root, "src", "0001-ui.txt"))).toContain("0001-ui");
    expect(await readTextIfExists(join(root, "src", "0001-engine.txt"))).toContain("0001-engine");
    expect(await readTextIfExists(join(root, "src", "0001-integration.txt"))).toContain("0001-integration");
    expect(await pathExists(join(root, "src", "critic-only-0001-ui.txt"))).toBe(false);
    expect(await pathExists(join(root, "src", "critic-only-0001-engine.txt"))).toBe(false);
    expect(await pathExists(join(root, "src", "critic-only-0001-integration.txt"))).toBe(false);
    expect(adapter.events.indexOf("actor:start:0001-integration")).toBeGreaterThan(
      adapter.events.indexOf("critic:end:0001-ui")
    );
    expect(adapter.events.indexOf("actor:start:0001-integration")).toBeGreaterThan(
      adapter.events.indexOf("critic:end:0001-engine")
    );
    expect(result.workers.map((worker) => worker.id)).toEqual(expect.arrayContaining([
      "judge-mock",
      "actor-mock-0001-ui",
      "actor-mock-0001-engine",
      "critic-mock-0001-ui",
      "critic-mock-0001-engine",
      "actor-mock-0001-integration",
      "critic-mock-0001-integration"
    ]));
    expect(result.summary).toContain("Game UI");
    expect(result.summary).toContain("Game engine");
    expect(result.summary).toContain("Integration");
    const restoredWorkers = await orchestrator.listTaskWorkers(result.taskId ?? "");
    expect(restoredWorkers.map((worker) => worker.label)).toEqual(expect.arrayContaining([
      "Actor (mock) · Game UI",
      "Critic (mock) · Game UI",
      "Actor (mock) · Integration",
      "Critic (mock) · Integration"
    ]));
    expect(await readTextIfExists(join(taskDir, "turns", "0001", "feature-plan.json"))).toContain('"depends_on"');
    expect(JSON.parse(await readTextIfExists(join(taskDir, "actor-mock-0001-ui", "status.json")))).toMatchObject({
      feature_id: "0001-ui",
      feature_title: "Game UI",
      state: "done"
    });
    expect(JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-ui", "status.json")))).toMatchObject({ state: "approved" });
    expect(JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-engine", "status.json")))).toMatchObject({ state: "approved" });
    expect(JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-integration", "status.json")))).toMatchObject({ state: "approved" });
  });

  it("limits concurrent feature workers and reports phase progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-parallel-limit-"));
    const config = mockConfig(root);
    config.orchestration.maxParallelFeatures = 2;
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:10.000Z"),
      randomId: () => "limit"
    });
    const adapter = new LimitedParallelAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const progress: FeatureRunProgress[] = [];

    const result = await orchestrator.handleRequest({
      request: "并行实现五个独立模块",
      cwd: root,
      onStatus: (status) => {
        const featureProgress = status.featureProgress;
        if (featureProgress) {
          progress.push(featureProgress);
        }
      }
    });

    expect(adapter.maxConcurrent).toBe(2);
    expect(result.workers).toHaveLength(12);
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "actor", completed: 0, total: 5 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "actor", completed: 5, total: 5 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "critic", completed: 5, total: 5 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "integration", completed: 0, total: 1 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "integration", completed: 1, total: 1 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "verification", completed: 0, total: 1 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "verification", completed: 1, total: 1 });
  });

  it("exposes queued and actor-complete states at the real parallel scheduling boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-parallel-state-"));
    const config = mockConfig(root);
    config.orchestration.maxParallelFeatures = 2;
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:11.000Z"),
      randomId: () => "queue-state"
    });
    const adapter = new QueuedFeatureStateAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033011-queue-state";
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    const run = orchestrator.handleRequest({ request: "并行实现三个独立模块", cwd: root });
    let assertionError: unknown;

    try {
      await adapter.firstActorBatchStarted;
      await expect(featureStates(taskDir, 3)).resolves.toEqual([
        "actor_running",
        "actor_running",
        "queued"
      ]);
      await expect(orchestrator.cancelFeature(taskId, "0001-module-3")).resolves.toEqual({
        requested: false,
        featureId: "0001-module-3"
      });

      adapter.releaseActors();
      await adapter.firstCriticBatchStarted;
      await expect(featureStates(taskDir, 3)).resolves.toEqual([
        "critic_running",
        "critic_running",
        "actor_done"
      ]);
    } catch (error) {
      assertionError = error;
    } finally {
      adapter.releaseAll();
      await run;
    }

    if (assertionError) {
      throw assertionError;
    }
  });

  it("runs a combined Wave Critic before committing approved features to the live workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-wave-critic-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:12.000Z"),
      randomId: () => "verify"
    });
    const adapter = new CombinedVerificationAdapter(root);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const progress: FeatureRunProgress[] = [];

    const result = await orchestrator.handleRequest({
      request: "并行创建 alpha 和 beta，并联合验收",
      cwd: root,
      onStatus: (status) => {
        if (status.featureProgress) {
          progress.push(status.featureProgress);
        }
      }
    });

    const taskDir = join(root, ".parallel-codex", "sessions", result.taskId ?? "");
    expect(adapter.waveCriticRuns).toBe(1);
    expect(adapter.waveCriticSawCombinedWorkspace).toBe(true);
    expect(adapter.liveWasUntouchedDuringVerification).toBe(true);
    expect(adapter.waveCriticWritableDirs).toContain(join(taskDir, "critic-mock-wave-0001-0001"));
    expect(adapter.waveCriticWritableDirs).not.toContain(taskDir);
    expect(adapter.waveCriticWritableDirs).not.toContain(join(
      taskDir,
      "workspaces",
      "turn-0001",
      "wave-0001",
      "integration"
    ));
    expect(result.workers.map((worker) => worker.id)).toContain("critic-mock-wave-0001-0001");
    expect(await readTextIfExists(join(taskDir, "critic-mock-wave-0001-0001", "review.md"))).toContain("APPROVED");
    expect(JSON.parse(await readTextIfExists(join(
      taskDir,
      "critic-mock-wave-0001-0001",
      "native-session.json"
    ))).writable_dirs).toEqual(adapter.waveCriticWritableDirs);
    expect(result.summary).toContain("# Combined verification");
    expect(result.summary).toContain("## Wave 1");
    expect(result.summary.startsWith("Complex task completed.")).toBe(true);
    const structured = parseTaskResultSummary(result.summary);
    expect(structured?.sections.changes).toContain("alpha.txt");
    expect(structured?.sections.changes).toContain("beta.txt");
    expect(structured?.sections.verification).toContain("Wave 1");
    await expect(readTextIfExists(join(
      taskDir,
      "features",
      "0001-alpha",
      "finding-resolution.json"
    ))).resolves.toContain('"decision": "approved"');
    await expect(readTextIfExists(join(
      taskDir,
      "features",
      "0001-beta",
      "finding-resolution.json"
    ))).resolves.toContain('"decision": "approved"');
    expect(JSON.parse(await readTextIfExists(join(
      taskDir,
      "workspaces",
      "turn-0001",
      "wave-0001",
      "verification.json"
    )))).toMatchObject({ state: "approved", revised: false });
    expect((await orchestrator.listTaskWorkers(result.taskId ?? "")).map((worker) => worker.label)).toContain(
      "Critic (mock) · Wave 1/1"
    );
    expect(await readTextIfExists(join(root, "alpha.txt"))).toBe("alpha\n");
    expect(await readTextIfExists(join(root, "beta.txt"))).toBe("beta\n");
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "verification", completed: 0, total: 1 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "verification", completed: 1, total: 1 });
  });

  it("runs a Wave Actor revision and reuses the Wave Critic session before live commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-wave-revision-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:13.000Z"),
      randomId: () => "wave-revision"
    });
    const adapter = new WaveRevisionAdapter(root);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const progress: FeatureRunProgress[] = [];

    const result = await orchestrator.handleRequest({
      request: "并行创建 alpha 和 beta，并修复组合问题",
      cwd: root,
      onStatus: (status) => {
        if (status.featureProgress) {
          progress.push(status.featureProgress);
        }
      }
    });

    const taskDir = join(root, ".parallel-codex", "sessions", result.taskId ?? "");
    expect(adapter.liveWasUntouchedBeforeRevision).toBe(true);
    expect(adapter.waveActorRuns).toBe(1);
    expect(adapter.waveCriticRuns).toBe(2);
    expect(adapter.secondCriticSawRevision).toBe(true);
    expect(adapter.waveCriticNativeSessions).toEqual([null, "mock-critic-mock-wave-0001-0001"]);
    expect(result.workers.map((worker) => worker.id)).toEqual(expect.arrayContaining([
      "actor-mock-wave-0001-0001",
      "critic-mock-wave-0001-0001"
    ]));
    expect(await readTextIfExists(join(root, "combined.txt"))).toBe("fixed\n");
    const verification = JSON.parse(await readTextIfExists(join(
      taskDir,
      "workspaces",
      "turn-0001",
      "wave-0001",
      "verification.json"
    )));
    expect(verification).toMatchObject({ state: "approved", revised: true });
    expect(verification.review_paths).toHaveLength(2);
    expect(await readTextIfExists(join(
      taskDir,
      "workspaces",
      "turn-0001",
      "wave-0001",
      "verification-review-01.md"
    ))).toContain("REVISION_REQUIRED");
    expect(await readTextIfExists(join(
      taskDir,
      "workspaces",
      "turn-0001",
      "wave-0001",
      "verification-review-02.md"
    ))).toContain("APPROVED");
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "revision", completed: 0, total: 1 });
    expect(progress).toContainEqual({ wave: 1, waves: 1, phase: "revision", completed: 1, total: 1 });
  });

  it("rejects an ambiguous Wave Critic response without changing the live workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-wave-no-decision-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:14.000Z"),
      randomId: () => "no-decision"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MissingWaveDecisionAdapter(root)]])
    );

    await expect(orchestrator.handleRequest({
      request: "并行创建 alpha 和 beta",
      cwd: root
    })).rejects.toThrow("did not include APPROVED or REVISION_REQUIRED");

    expect(await pathExists(join(root, "alpha.txt"))).toBe(false);
    expect(await pathExists(join(root, "beta.txt"))).toBe(false);
    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033014-no-decision");
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("failed");
  });

  it("fails overlapping feature integration atomically and preserves conflict evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-parallel-conflict-"));
    await writeText(join(root, "src", "shared.ts"), "export const owner = 'base';\n");
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:15.000Z"),
      randomId: () => "conflict"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new ConflictingFeatureAdapter()]])
    );

    await expect(orchestrator.handleRequest({
      request: "并行实现两个会修改共享配置的功能",
      cwd: root
    })).rejects.toThrow("Workspace integration conflict in 1 path: src/shared.ts");

    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033015-conflict");
    expect(await readTextIfExists(join(root, "src", "shared.ts"))).toBe("export const owner = 'base';\n");
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("failed");
    expect(JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-ui", "status.json")))).toMatchObject({ state: "failed" });
    expect(JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-engine", "status.json")))).toMatchObject({ state: "failed" });
    const conflict = await readTextIfExists(join(
      taskDir,
      "workspaces",
      "turn-0001",
      "wave-0001",
      "conflicts",
      "0001-engine",
      "src",
      "shared.ts"
    ));
    expect(conflict).toContain("<<<<<<< current");
    expect(conflict).toContain("owner = 'ui'");
    expect(conflict).toContain("owner = 'engine'");
  });

  it("stops scheduling queued feature workers after a parallel failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-parallel-stop-"));
    const config = mockConfig(root);
    config.orchestration.maxParallelFeatures = 2;
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:20.000Z"),
      randomId: () => "stop-queue"
    });
    const adapter = new StopQueuedFeaturesAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    await expect(orchestrator.handleRequest({
      request: "并行实现五个独立模块",
      cwd: root
    })).rejects.toThrow("actor-mock-0001-module-1 failed with exit code 2");

    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033020-stop-queue");
    expect(adapter.startedActors.sort()).toEqual(["0001-module-1", "0001-module-2"]);
    expect(await pathExists(join(taskDir, "actor-mock-0001-module-3"))).toBe(false);
    expect(await pathExists(join(taskDir, "critic-mock-0001-module-1"))).toBe(false);
  });

  it("lists workers from an existing task session after TUI restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-list-workers-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const firstOrchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));
    const result = await firstOrchestrator.handleRequest({
      request: "实现 worker attach",
      cwd: root
    });
    const restartedOrchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));

    const workers = await restartedOrchestrator.listTaskWorkers(result.taskId ?? "");

    expect(workers.map((worker) => worker.id)).toEqual(["judge-mock", "actor-mock", "critic-mock"]);
    expect(workers.map((worker) => worker.label)).toEqual(["Judge (mock)", "Actor (mock)", "Critic (mock)"]);
    expect(workers.map((worker) => worker.runtimeStatus?.state)).toEqual(["done", "done", "done"]);
    expect(workers[1].statusPath).toBe(join(root, ".parallel-codex", "sessions", result.taskId ?? "", "actor-mock", "status.json"));
  });

  it("skips corrupt worker status files when restoring an existing task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-list-corrupt-workers-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));
    const result = await orchestrator.handleRequest({
      request: "实现 worker attach",
      cwd: root
    });

    await writeText(join(root, ".parallel-codex", "sessions", result.taskId ?? "", "actor-mock", "status.json"), "{");

    const workers = await orchestrator.listTaskWorkers(result.taskId ?? "");

    expect(workers.map((worker) => worker.id)).toEqual(["judge-mock", "critic-mock"]);
  });

  it("uses Codex router decisions before starting workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-codex-router-"));
    const config = mockConfig(root);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]), async () =>
      JSON.stringify({
        mode: "complex",
        reason: "Codex routed optimization as project work."
      })
    );

    const result = await orchestrator.handleRequest({
      request: "优化得分",
      cwd: root
    });

    expect(result.mode).toBe("complex");
    expect(result.taskId).toBe("task-20260630-033000-a1b2");
    expect(await readTextIfExists(join(root, ".parallel-codex", "sessions", result.taskId ?? "", "route.json"))).toContain(
      "Codex routed optimization as project work."
    );
  });

  it("routes from a dedicated router directory while workers run inside the selected workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    let routerCwd = "";
    const workerCwds: string[] = [];
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new CwdRecordingWorkerAdapter(workerCwds)]]),
      async (prompt, _config, cwd) => {
        expect(prompt).toContain("做个俄罗斯方块的游戏");
        expect(prompt).not.toContain(appRoot);
        expect(prompt).not.toContain(workspaceRoot);
        routerCwd = cwd;
        return JSON.stringify({
          mode: "complex",
          reason: "Codex routed project work."
        });
      },
      routerCwdRoot
    );

    const result = await orchestrator.handleRequest({
      request: "做个俄罗斯方块的游戏",
      cwd: workspaceRoot
    });

    expect(result.mode).toBe("complex");
    expect(routerCwd).toBe(routerCwdRoot);
    expect(workerCwds[0]).toBe(join(
      workspaceRoot,
      ".parallel-codex",
      "sessions",
      "task-20260630-033000-a1b2",
      "judge-mock"
    ));
    expect(workerCwds[1]).not.toBe(workspaceRoot);
    expect(workerCwds[2]).not.toBe(workerCwds[1]);
    expect(workerCwds[1]).toContain(join("workspaces", "turn-0001", "wave-0001", "features", "0001"));
    expect(workerCwds[2]).toContain(join("workspaces", "turn-0001", "wave-0001", "reviews", "0001"));
  });

  it("records simple decisions in one shared router audit across workspaces", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-audit-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-audit-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => JSON.stringify({ mode: "simple", reason: "Greeting needs Main only." }),
      routerCwdRoot
    );

    const result = await orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot
    });
    const records = (await readTextIfExists(join(routerCwdRoot, "routes.jsonl")))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.mode).toBe("simple");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request: "你好",
      workspace: workspaceRoot,
      mode: "simple",
      reason: "Greeting needs Main only.",
      source: "codex",
      router_timeout_ms: 30000,
      router_first_output_timeout_ms: 15000,
      router_idle_timeout_ms: 15000,
      proxy_configured: expect.any(Boolean),
      router_dispatch_ms: expect.any(Number),
      router_parse_ms: expect.any(Number)
    });
    expect(records[0]?.time).toEqual(expect.any(String));
    expect(records[0]?.duration_ms).toEqual(expect.any(Number));
  });

  it("sanitizes requests and reasons before writing the shared Router audit", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-redaction-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-redaction-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const request = "检查 https://user:secret@proxy.test/private?token=hidden OPENAI_API_KEY=sk-proj-routersecret npm_abcdefghijklmnopqrstuvwxyz";
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async (prompt) => {
        expect(prompt).toContain(request);
        return JSON.stringify({
          mode: "simple",
          reason: "Proxy https://user:secret@proxy.test/private?token=hidden is configured."
        });
      },
      routerCwdRoot
    );

    await orchestrator.handleRequest({ request, cwd: workspaceRoot });
    const audit = await readTextIfExists(join(routerCwdRoot, "routes.jsonl"));
    const record = JSON.parse(audit.trim()) as Record<string, unknown>;

    expect(record.request).toContain("https://***@proxy.test");
    expect(record.reason).toContain("https://***@proxy.test");
    for (const secret of [
      "user:secret",
      "/private",
      "hidden",
      "sk-proj-routersecret",
      "npm_abcdefghijklmnopqrstuvwxyz"
    ]) {
      expect(audit).not.toContain(secret);
    }
  });

  it("records structured timeout and proxy evidence for Router fallbacks", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-evidence-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-evidence-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    config.router.codex.timeoutMs = 30000;
    config.router.codex.env = { HTTPS_PROXY: "http://127.0.0.1:7890" };
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        throw new Error("Codex router timed out after 30000ms with proxy configured");
      },
      routerCwdRoot
    );

    await orchestrator.handleRequest({ request: "你好", cwd: workspaceRoot });
    const record = JSON.parse(
      (await readTextIfExists(join(routerCwdRoot, "routes.jsonl"))).trim()
    ) as Record<string, unknown>;

    expect(record).toMatchObject({
      source: "fallback",
      router_timeout_ms: 30000,
      router_first_output_timeout_ms: 15000,
      router_idle_timeout_ms: 15000,
      proxy_configured: true,
      failure_kind: "timeout",
      router_attempt: 1,
      router_fallback_resolution: "configured",
      router_dispatch_ms: expect.any(Number)
    });
    expect(record.router_parse_ms).toBeUndefined();
  });

  it("lets an interactive fallback choose Parallel without keyword rules", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-choice-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-choice-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    config.router.codex.fallback = "simple";
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "choice"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        throw new Error("Codex router timed out after 30000ms");
      },
      routerCwdRoot
    );
    const prompts: Array<{ attempt: number; scope: string; route: { mode: string } }> = [];

    const result = await orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot,
      onRouteFallback: async (fallback: { attempt: number; scope: string; route: { mode: string } }) => {
        prompts.push(fallback);
        return "parallel" as const;
      }
    });
    const record = JSON.parse(
      (await readTextIfExists(join(routerCwdRoot, "routes.jsonl"))).trim()
    ) as Record<string, unknown>;

    expect(result.mode).toBe("complex");
    expect(result.taskId).toBe("task-20260630-033000-choice");
    expect(prompts).toEqual([expect.objectContaining({
      attempt: 1,
      scope: "initial",
      route: expect.objectContaining({ mode: "simple" })
    })]);
    expect(record).toMatchObject({
      mode: "complex",
      source: "fallback",
      router_attempt: 1,
      router_fallback_resolution: "parallel"
    });
    expect(record.reason).toContain("User selected Parallel after Router fallback");
  });

  it("records an interactive Router retry before accepting the next Codex decision", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-retry-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-retry-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    let routeCalls = 0;
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        routeCalls += 1;
        if (routeCalls === 1) {
          throw new Error("Codex router timed out after 30000ms");
        }
        return JSON.stringify({ mode: "simple", reason: "Second Router attempt succeeded." });
      },
      routerCwdRoot
    );

    const result = await orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot,
      onRouteFallback: async () => "retry"
    });
    const records = (await readTextIfExists(join(routerCwdRoot, "routes.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result).toMatchObject({ mode: "simple", taskId: null });
    expect(routeCalls).toBe(2);
    expect(records).toEqual([
      expect.objectContaining({
        source: "fallback",
        router_attempt: 1,
        router_fallback_resolution: "retry"
      }),
      expect.objectContaining({
        source: "codex",
        router_attempt: 2
      })
    ]);
  });

  it("automatically retries a transient Router stall before prompting the user", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-auto-retry-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-auto-retry-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    config.router.codex.maxAttempts = 2;
    config.router.codex.retryDelayMs = 25;
    let routeCalls = 0;
    let prompts = 0;
    let finalRoute: RouteDecision | null = null;
    const starts: Array<{ phase: string; attempt?: number; maxAttempts?: number }> = [];
    const manager = new SessionManager({ projectRoot: workspaceRoot, dataDir: config.dataDir });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        routeCalls += 1;
        if (routeCalls === 1) {
          throw Object.assign(new Error("Codex router idle timed out after 500ms"), {
            routerTimeoutKind: "idle",
            routerFailureStage: "streaming"
          });
        }
        return JSON.stringify({ mode: "simple", reason: "Recovered Router response." });
      },
      routerCwdRoot
    );

    const result = await orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot,
      onRouteStart: (state) => starts.push(state),
      onRoute: (route) => {
        finalRoute = route;
      },
      onRouteFallback: async () => {
        prompts += 1;
        return "parallel";
      }
    });
    const records = (await readTextIfExists(join(routerCwdRoot, "routes.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result).toMatchObject({ mode: "simple", taskId: null });
    expect(routeCalls).toBe(2);
    expect(prompts).toBe(0);
    expect(finalRoute).toMatchObject({
      source: "codex",
      router_attempt: 2,
      router_recovered_from: "timeout",
      router_recovered_via: "auto-retry",
      router_recovered_timeout_kind: "idle",
      router_recovered_failure_stage: "streaming",
      router_total_duration_ms: expect.any(Number)
    });
    expect((finalRoute as RouteDecision | null)?.router_total_duration_ms).toBeGreaterThanOrEqual(20);
    expect(starts).toEqual([
      expect.objectContaining({ phase: "starting", attempt: 1, maxAttempts: 2 }),
      expect.objectContaining({ phase: "retrying", attempt: 2, maxAttempts: 2 }),
      expect.objectContaining({ phase: "starting", attempt: 2, maxAttempts: 2 })
    ]);
    expect(records).toEqual([
      expect.objectContaining({
        source: "fallback",
        router_attempt: 1,
        router_fallback_resolution: "auto-retry",
        router_timeout_kind: "idle"
      }),
      expect.objectContaining({
        source: "codex",
        router_attempt: 2,
        router_recovered_from: "timeout",
        router_recovered_via: "auto-retry",
        router_recovered_timeout_kind: "idle",
        router_total_duration_ms: expect.any(Number)
      })
    ]);
  });

  it("prompts after the transient retry budget is exhausted", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-auto-limit-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-auto-limit-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    config.router.codex.maxAttempts = 2;
    config.router.codex.retryDelayMs = 0;
    let routeCalls = 0;
    const promptAttempts: number[] = [];
    let finalRoute: RouteDecision | null = null;
    const manager = new SessionManager({ projectRoot: workspaceRoot, dataDir: config.dataDir });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        routeCalls += 1;
        throw Object.assign(new Error("Codex router first output timed out after 500ms"), {
          routerTimeoutKind: "first-output",
          routerFailureStage: "waiting-output"
        });
      },
      routerCwdRoot
    );

    const result = await orchestrator.handleRequest({
      request: "实现功能",
      cwd: workspaceRoot,
      onRoute: (route) => {
        finalRoute = route;
      },
      onRouteFallback: async ({ attempt }) => {
        promptAttempts.push(attempt);
        return "parallel";
      }
    });
    const records = (await readTextIfExists(join(routerCwdRoot, "routes.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.mode).toBe("complex");
    expect(routeCalls).toBe(2);
    expect(promptAttempts).toEqual([2]);
    expect(finalRoute).toMatchObject({
      source: "fallback",
      router_attempt: 2,
      router_total_duration_ms: expect.any(Number),
      router_fallback_resolution: "parallel"
    });
    expect((finalRoute as RouteDecision | null)?.router_recovered_from).toBeUndefined();
    expect(records).toEqual([
      expect.objectContaining({ router_attempt: 1, router_fallback_resolution: "auto-retry" }),
      expect.objectContaining({
        router_attempt: 2,
        router_total_duration_ms: expect.any(Number),
        router_fallback_resolution: "parallel"
      })
    ]);
  });

  it("does not automatically retry authentication failures", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-no-auth-retry-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-no-auth-retry-workspace-"));
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    config.router.codex.maxAttempts = 2;
    config.router.codex.retryDelayMs = 0;
    let routeCalls = 0;
    const promptAttempts: number[] = [];
    const manager = new SessionManager({ projectRoot: workspaceRoot, dataDir: config.dataDir });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        routeCalls += 1;
        throw new Error("HTTP 401 Unauthorized; run codex login");
      }
    );

    await orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot,
      onRouteFallback: async ({ attempt }) => {
        promptAttempts.push(attempt);
        return "main";
      }
    });

    expect(routeCalls).toBe(1);
    expect(promptAttempts).toEqual([1]);
  });

  it("cancels an automatic Router retry during backoff without spawning another attempt", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-auto-cancel-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-auto-cancel-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    config.router.codex.maxAttempts = 2;
    config.router.codex.retryDelayMs = 5000;
    const controller = new AbortController();
    let routeCalls = 0;
    const manager = new SessionManager({ projectRoot: workspaceRoot, dataDir: config.dataDir });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        routeCalls += 1;
        throw Object.assign(new Error("Codex router idle timed out after 500ms"), {
          routerTimeoutKind: "idle",
          routerFailureStage: "streaming"
        });
      },
      routerCwdRoot
    );

    await expect(orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot,
      signal: controller.signal,
      onRouteStart: (state) => {
        if (state.phase === "retrying") {
          controller.abort();
        }
      }
    })).rejects.toMatchObject({ name: "AbortError" });
    const records = (await readTextIfExists(join(routerCwdRoot, "routes.jsonl")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(routeCalls).toBe(1);
    expect(records).toEqual([
      expect.objectContaining({ router_attempt: 1, router_fallback_resolution: "auto-retry" })
    ]);
  });

  it("records an interactive fallback cancellation without starting Main or task workers", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-cancel-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-router-cancel-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir
    });
    const adapter = new CapturingAdapter();
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", adapter]]),
      async () => {
        throw new Error("Codex router timed out after 30000ms");
      },
      routerCwdRoot
    );

    await expect(orchestrator.handleRequest({
      request: "你好",
      cwd: workspaceRoot,
      onRouteFallback: async () => "cancel"
    })).rejects.toMatchObject({ name: "AbortError" });
    const record = JSON.parse(
      (await readTextIfExists(join(routerCwdRoot, "routes.jsonl"))).trim()
    ) as Record<string, unknown>;

    expect(adapter.runs).toHaveLength(0);
    expect(record).toMatchObject({
      source: "fallback",
      router_attempt: 1,
      router_fallback_resolution: "cancelled"
    });
  });

  it("passes configured role prompts into worker prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-role-prompts-"));
    const config = mockConfig(root);
    config.roles.actor = {
      title: "Builder",
      instructions: ["Prefer small patches.", "Always update worklog.md."]
    };
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));

    const result = await orchestrator.handleRequest({
      request: "实现角色配置",
      cwd: root
    });

    const actorPrompt = await readTextIfExists(
      join(root, ".parallel-codex", "sessions", result.taskId ?? "", "actor-mock", "prompt.md")
    );
    expect(actorPrompt).toContain("# Role: Builder");
    expect(actorPrompt).toContain("- Prefer small patches.");
    expect(actorPrompt).toContain("- Always update worklog.md.");
  });

  it("passes same-task native sessions into worker runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-native-session-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const capturing = new CapturingAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", capturing]]));
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const actorDir = join(task.dir, "actor-mock");
    await writeJson(
      join(actorDir, "native-session.json"),
      NativeSessionSchema.parse({
        engine: "mock",
        role: "actor",
        worker_id: "actor-mock",
        session_id: "native-actor-1",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      })
    );

    await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "继续改",
      cwd: root
    });

    const actorRun = capturing.runs.find((run) => run.role === "actor");
    expect(actorRun?.nativeSession?.session_id).toBe("native-actor-1");
    const updated = await readJson(join(actorDir, "native-session.json"), NativeSessionSchema);
    expect(updated.last_used_at).not.toBe("2026-06-30T03:30:00.000Z");
    expect(updated.source).toBe("manual");
  });

  it("reruns Judge in the same native session before a complex follow-up pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const capturing = new CapturingAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", capturing]]));
    const first = await orchestrator.handleRequest({
      request: "实现 parallel coding worker 状态栏",
      cwd: root
    });
    const taskDir = join(root, ".parallel-codex", "sessions", first.taskId ?? "");
    await writeText(
      join(taskDir, "turns", "0001", "supervisor-summary.md"),
      "FIRST_TURN_MEMORY\nstatus rail completed\n"
    );

    capturing.runs.length = 0;
    const followUp = await orchestrator.handleTaskTurn({
      taskId: first.taskId ?? "",
      request: "继续改状态栏",
      cwd: root
    });

    expect(followUp.mode).toBe("complex");
    expect(capturing.runs.map((run) => run.role)).toEqual(["judge", "actor", "critic"]);
    const judgeRun = capturing.runs.find((run) => run.role === "judge");
    const actorRun = capturing.runs.find((run) => run.role === "actor");
    const criticRun = capturing.runs.find((run) => run.role === "critic");
    expect(judgeRun?.nativeSession?.session_id).toBe("mock-judge-mock");
    expect(judgeRun?.prompt).toContain("继续改状态栏");
    expect(judgeRun?.cwd).toBe(join(taskDir, "judge-mock"));
    expect(judgeRun?.enforceWorkspaceIsolation).toBe(true);
    expect(actorRun?.cwd).not.toBe(root);
    expect(criticRun?.cwd).not.toBe(actorRun?.cwd);
    expect(criticRun?.cwd).toContain(join("reviews", "0002"));
    expect(actorRun?.prompt).toContain("- 0001: FIRST_TURN_MEMORY status rail completed");
    expect(criticRun?.prompt).toContain("- 0001: FIRST_TURN_MEMORY status rail completed");
    expect(actorRun?.prompt).not.toContain("Previous turn summaries:\n- (none)");
    expect(actorRun?.prompt).toContain(`Judge directory: ${join(taskDir, "turns", "0002")}`);
    expect(await readTextIfExists(join(taskDir, "turns", "0001", "requirements.md"))).toContain("Mock requirements");
    expect(await readTextIfExists(join(taskDir, "turns", "0002", "requirements.md"))).toContain("Mock requirements");
    expect(await readTextIfExists(join(taskDir, "turns", "0002", "user.md"))).toContain("继续改状态栏");
    expect(await readTextIfExists(join(taskDir, "actor-mock", "prompt.md"))).toContain("Current turn: 0002");
    expect(await readTextIfExists(join(taskDir, "actor-mock", "prompt.md"))).toContain(
      `Feature directory: ${join(taskDir, "features", "0002")}`
    );
    expect(await readTextIfExists(join(taskDir, "features", "0002", "spec.md"))).toContain("继续改状态栏");
    expect(await readTextIfExists(join(taskDir, "dialogue", "actor-critic.jsonl"))).toContain('"feature_id":"0002"');
    expect(await readTextIfExists(join(taskDir, "turns", "0002", "supervisor-summary.md"))).toContain(
      "Complex task completed."
    );
    expect(JSON.parse(await readTextIfExists(join(taskDir, "judge-mock", "native-session.json"))).cwd).toBe(
      join(taskDir, "judge-mock")
    );
    expect(JSON.parse(await readTextIfExists(join(taskDir, "actor-mock", "native-session.json"))).cwd).toBe(actorRun?.cwd);
  });

  it("runs a multi-Feature plan produced by the Judge for a complex follow-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-features-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "follow-features"
    });
    const adapter = new FollowUpFeaturePlanAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const initial = await orchestrator.handleRequest({ request: "实现基础功能", cwd: root });
    const statuses: Array<{ judge?: string; featureProgress?: FeatureRunProgress }> = [];

    adapter.runs.length = 0;
    const followUp = await orchestrator.handleTaskTurn({
      taskId: initial.taskId ?? "",
      request: "改方向：并行增加 alpha 与 beta",
      cwd: root,
      onStatus: (status) => statuses.push(status)
    });

    expect(followUp.mode).toBe("complex");
    expect(adapter.runs.filter((run) => run.role === "judge")).toHaveLength(1);
    expect(adapter.judgeNativeSessions).toEqual([null, "mock-judge-mock"]);
    expect(adapter.runs.filter((run) => run.role === "actor").map((run) => run.workerId).sort()).toEqual([
      "actor-mock-0002-alpha",
      "actor-mock-0002-beta"
    ]);
    expect(await readTextIfExists(join(root, "alpha.txt"))).toBe("alpha\n");
    expect(await readTextIfExists(join(root, "beta.txt"))).toBe("beta\n");
    expect(statuses[0]?.judge).toBe("running");
    expect(statuses.some(({ featureProgress }) => featureProgress?.phase === "actor")).toBe(true);
    expect(statuses.some(({ featureProgress }) => featureProgress?.phase === "critic")).toBe(true);
    expect(statuses.some(({ featureProgress }) => featureProgress?.phase === "verification")).toBe(true);
    expect(statuses.some(({ featureProgress }) => featureProgress?.phase === "integration")).toBe(true);
    const taskDir = join(root, ".parallel-codex", "sessions", initial.taskId ?? "");
    expect(JSON.parse(await readTextIfExists(join(taskDir, "turns", "0002", "feature-plan.json")))).toMatchObject({
      features: [{ id: "alpha" }, { id: "beta" }]
    });
  });

  it("passes critic findings through the feature mailbox for actor revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-revision-"));
    const config = mockConfig(root);
    const adapter = new RevisionFindingAdapter();
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    const result = await orchestrator.handleRequest({
      request: "实现 keyboard feature",
      cwd: root
    });

    expect(adapter.runs.map((run) => run.role)).toEqual(["judge", "actor", "critic", "actor", "critic"]);
    const taskDir = join(root, ".parallel-codex", "sessions", result.taskId ?? "");
    const featureDir = join(taskDir, "features", "0001-keyboard-feature");
    const actorPrompts = adapter.runs.filter((run) => run.role === "actor").map((run) => run.prompt);
    expect(actorPrompts[1]).toContain("Revision request:");
    expect(actorPrompts[1]).toContain(join(featureDir, "critic-findings.jsonl"));
    expect(await readTextIfExists(join(featureDir, "critic-findings.jsonl"))).toContain('"id":"C-001"');
    expect(await readTextIfExists(join(featureDir, "actor-replies.jsonl"))).toContain('"finding_id":"C-001"');
    expect(await readTextIfExists(join(featureDir, "status.json"))).toContain('"state": "approved"');
    expect(adapter.criticCwds).toHaveLength(2);
    expect(adapter.criticCwds[1]).toBe(adapter.criticCwds[0]);
    expect(adapter.criticNativeSessions).toEqual([null, "mock-critic-mock"]);
    expect(adapter.secondCriticSawActorFix).toBe(true);
    expect(adapter.secondCriticSawCleanReviewClone).toBe(true);
    expect(await readTextIfExists(join(root, "fixed.txt"))).toBe("fixed\n");
    expect(await pathExists(join(root, "critic-only.txt"))).toBe(false);
    expect(JSON.parse(await readTextIfExists(join(featureDir, "finding-resolution.json")))).toMatchObject({
      version: 1,
      decision: "approved",
      finding_ids: ["C-001"],
      fixed_ids: ["C-001"],
      unresolved_ids: []
    });
    expect(parseTaskResultSummary(result.summary)?.sections.findings).toBe("");
  });

  it("rejects a revision request without structured Critic findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-missing-findings-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "missing-findings"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new RevisionWithoutFindingsAdapter()]])
    );

    await expect(orchestrator.handleRequest({
      request: "实现必须按 finding 修订的功能",
      cwd: root
    })).rejects.toThrow("requested revision without valid critic findings");

    expect(await pathExists(join(root, "revision-without-finding.txt"))).toBe(false);
  });

  it("rejects Actor revisions that do not acknowledge every Critic finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-missing-reply-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "missing-reply"
    });
    const adapter = new RevisionWithoutReplyAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    await expect(orchestrator.handleRequest({
      request: "实现必须确认修复结果的功能",
      cwd: root
    })).rejects.toThrow("Actor revision did not mark every Critic finding fixed: C-001");

    expect(adapter.criticRuns).toBe(1);
    expect(await pathExists(join(root, "unacknowledged-fix.txt"))).toBe(false);
  });

  it("rejects APPROVED reviews that leave unresolved blocking findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-inconsistent-approval-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "inconsistent-approval"
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new ApprovedWithFindingAdapter()]])
    );

    await expect(orchestrator.handleRequest({
      request: "实现必须一致审查的功能",
      cwd: root
    })).rejects.toThrow("Critic approved with unresolved blocking findings: C-001");

    expect(await pathExists(join(root, "inconsistent-approval.txt"))).toBe(false);
  });

  it("reruns an incoherent Critic checkpoint on task retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-protocol-retry-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "protocol-retry"
    });
    const adapter = new RepairingProtocolOnRetryAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033000-protocol-retry";

    await expect(orchestrator.handleRequest({
      request: "实现可恢复的审查协议",
      cwd: root
    })).rejects.toThrow("Critic approved with unresolved blocking findings: C-001");

    const result = await orchestrator.retryTask({ taskId, cwd: root });

    expect(result.taskId).toBe(taskId);
    expect(adapter.criticRuns).toBe(2);
    expect(await readTextIfExists(join(root, "protocol-retry.txt"))).toBe("ready\n");
  });

  it("uses current feature worklog in supervisor summaries instead of stale actor worker artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-feature-summary-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await writeText(join(task.dir, "judge-mock", "requirements.md"), "# Requirements\n\n- Current requirements.\n");
    await writeText(join(task.dir, "actor-mock", "worklog.md"), "STALE_ACTOR_WORKLOG");
    await writeText(join(task.dir, "critic-mock", "review.md"), "STALE_CRITIC_REVIEW");
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new FeatureOnlyWorklogAdapter()]]));

    await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "继续优化",
      cwd: root
    });

    const summary = await readTextIfExists(join(task.dir, "turns", "0002", "supervisor-summary.md"));
    const decisions = await readTextIfExists(join(task.dir, "features", "0002", "decisions.md"));
    expect(summary).toContain("CURRENT_FEATURE_WORKLOG");
    expect(summary).toContain("CURRENT_CRITIC_REVIEW");
    expect(summary).not.toContain("STALE_ACTOR_WORKLOG");
    expect(summary).not.toContain("STALE_CRITIC_REVIEW");
    expect(decisions).toContain("CURRENT_FEATURE_WORKLOG");
    expect(decisions).not.toContain("STALE_ACTOR_WORKLOG");
  });

  it("uses current turn requirements in supervisor summaries when Judge writes there", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-turn-requirements-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new TurnRequirementsJudgeAdapter()]]));

    const result = await orchestrator.handleRequest({
      request: "做个俄罗斯方块的游戏",
      cwd: root
    });

    const taskDir = join(root, ".parallel-codex", "sessions", result.taskId ?? "");
    const summary = await readTextIfExists(join(taskDir, "turns", "0001", "supervisor-summary.md"));
    expect(summary).toContain("TURN_ONLY_REQUIREMENTS");
    expect(summary).not.toContain("Requirements:\n(empty)");
  });

  it("clears stale worker artifacts before reusing actor and critic worker directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-clear-artifacts-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await writeText(join(task.dir, "judge-mock", "requirements.md"), "# Requirements\n\n- Current requirements.\n");
    await writeText(join(task.dir, "actor-mock", "worklog.md"), "STALE_ACTOR_WORKLOG");
    await writeText(join(task.dir, "actor-mock", "patch.diff"), "STALE_PATCH");
    await writeText(join(task.dir, "critic-mock", "review.md"), "STALE_CRITIC_REVIEW");
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new NoArtifactAdapter()]]));

    await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "继续优化",
      cwd: root
    });

    const summary = await readTextIfExists(join(task.dir, "turns", "0002", "supervisor-summary.md"));
    expect(await readTextIfExists(join(task.dir, "actor-mock", "worklog.md"))).toBe("");
    expect(await readTextIfExists(join(task.dir, "actor-mock", "patch.diff"))).toBe("");
    expect(await readTextIfExists(join(task.dir, "critic-mock", "review.md"))).toContain("APPROVED");
    expect(summary).not.toContain("STALE_ACTOR_WORKLOG");
    expect(summary).not.toContain("STALE_PATCH");
    expect(summary).not.toContain("STALE_CRITIC_REVIEW");
  });

  it("continues task turns under the workspace session root when app root differs", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-workspace-root-"));
    const config = mockConfig(appRoot);
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));
    const task = await manager.createTask({
      request: "做个俄罗斯方块的游戏",
      cwd: workspaceRoot,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "键盘能改不",
      cwd: workspaceRoot
    });

    expect(await pathExists(join(workspaceRoot, ".parallel-codex", "sessions", task.id, "turns", "0002", "user.md"))).toBe(true);
    expect(await pathExists(join(appRoot, ".parallel-codex", "sessions", task.id, "turns", "0001", "user.md"))).toBe(false);
  });

  it("answers active task questions through the persistent Main session without starting a worker turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-task-question-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const adapter = new CapturingAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const task = await manager.createTask({
      request: "优化得分",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await manager.updateTaskStatus(task, "failed");
    await writeJson(join(task.dir, "critic-mock", "status.json"), {
      worker_id: "critic-mock",
      role: "critic",
      engine: "mock",
      state: "failed",
      phase: "process-idle-timeout",
      last_event_at: "2026-06-30T03:35:00.000Z",
      summary: "mock produced no output for 300000ms"
    });
    await writeText(
      join(task.dir, "critic-mock", "output.log"),
      "$ mock critic\n\nProcess idle timed out after 300000ms\n"
    );
    await writeText(
      join(task.dir, "turns", "0001", "supervisor-summary.md"),
      "# Summary\n\nThe critic timed out while reviewing the scoring change.\n"
    );

    const first = await orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "原因呢超时",
      cwd: root
    });
    const second = await orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "怎么修复",
      cwd: root
    });

    expect(first.mode).toBe("simple");
    expect(first.taskId).toBe(task.id);
    expect(first.summary).toBe("Mock simple response for: 原因呢超时");
    expect(first.workers.map((worker) => worker.id)).toEqual(["main-mock"]);
    expect(second.summary).toBe("Mock simple response for: 怎么修复");
    expect(adapter.runs.map((run) => run.role)).toEqual(["main", "main"]);
    expect(adapter.runs[0]?.prompt).toContain("# Active task context");
    expect(adapter.runs[0]?.prompt).toContain(`Active task: ${task.id}`);
    expect(adapter.runs[0]?.prompt).toContain("Task status: failed");
    expect(adapter.runs[0]?.prompt).toContain("Critic (mock): failed/process-idle-timeout");
    expect(adapter.runs[0]?.prompt).toContain("Process idle timed out after 300000ms");
    expect(adapter.runs[0]?.prompt).toContain("0001: # Summary The critic timed out while reviewing the scoring change.");
    expect(adapter.runs[0]?.prompt).toContain("User request:\n原因呢超时");
    expect(adapter.runs[0]?.nativeSession).toBeNull();
    expect(adapter.runs[1]?.nativeSession?.session_id).toBe("mock-main-mock");
    expect(await pathExists(join(task.dir, "turns", "0002", "user.md"))).toBe(false);
  });

  it("skips corrupt worker status files when answering active task questions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-task-question-corrupt-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const adapter = new CapturingAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const task = await manager.createTask({
      request: "优化得分",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await manager.updateTaskStatus(task, "failed");
    await writeText(join(task.dir, "actor-mock", "status.json"), "{");
    await writeJson(join(task.dir, "critic-mock", "status.json"), {
      worker_id: "critic-mock",
      role: "critic",
      engine: "mock",
      state: "failed",
      phase: "process-idle-timeout",
      last_event_at: "2026-06-30T03:35:00.000Z",
      summary: "mock produced no output for 300000ms"
    });

    const result = await orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "原因呢超时",
      cwd: root
    });

    expect(result.summary).toBe("Mock simple response for: 原因呢超时");
    expect(adapter.runs[0]?.prompt).toContain("Critic (mock): failed/process-idle-timeout");
    expect(adapter.runs[0]?.prompt).toContain("mock produced no output for 300000ms");
    expect(adapter.runs[0]?.prompt).not.toContain("Actor (mock)");
  });

  it("skips corrupt task metadata when answering active task questions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-task-question-corrupt-meta-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const adapter = new CapturingAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const task = await manager.createTask({
      request: "优化得分",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await manager.updateTaskStatus(task, "failed");
    await writeJson(join(task.dir, "critic-mock", "status.json"), {
      worker_id: "critic-mock",
      role: "critic",
      engine: "mock",
      state: "failed",
      phase: "process-idle-timeout",
      last_event_at: "2026-06-30T03:35:00.000Z",
      summary: "mock produced no output for 300000ms"
    });
    await writeText(join(task.dir, "meta.json"), "{");

    const result = await orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "原因呢超时",
      cwd: root
    });

    expect(result.summary).toBe("Mock simple response for: 原因呢超时");
    expect(adapter.runs[0]?.prompt).toContain(`Active task: ${task.id}`);
    expect(adapter.runs[0]?.prompt).toContain("Task status: unavailable");
    expect(adapter.runs[0]?.prompt).toContain("Critic (mock): failed/process-idle-timeout");
    expect(adapter.runs[0]?.prompt).toContain("mock produced no output for 300000ms");
  });

  it("routes active task follow-ups through the Codex semantic router", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-router-"));
    const config = mockConfig(root);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "优化得分",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]), async (prompt) =>
      JSON.stringify({
        mode: prompt.includes("改成不用 Docker") ? "complex" : "simple",
        reason: "mock semantic follow-up route"
      })
    );

    const simple = await orchestrator.routeTaskFollowUp({
      taskId: task.id,
      request: "原因呢超时",
      cwd: root
    });
    expect(simple).toMatchObject({
      mode: "simple",
      taskId: null
    });
    expect(await pathExists(join(task.dir, "latest-route.json"))).toBe(false);
    await orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "原因呢超时",
      cwd: root,
      route: simple.route
    });
    await expect(readJson(join(task.dir, "latest-route.json"), RouteDecisionSchema)).resolves.toMatchObject({
      mode: "simple",
      source: "codex"
    });
    const complex = await orchestrator.routeTaskFollowUp({
      taskId: task.id,
      request: "那改成不用 Docker 评测呢",
      cwd: root
    });
    expect(complex).toMatchObject({
      mode: "complex",
      taskId: task.id
    });
    await expect(readJson(join(task.dir, "latest-route.json"), RouteDecisionSchema)).resolves.toMatchObject({
      mode: "simple"
    });
    await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "那改成不用 Docker 评测呢",
      cwd: root,
      route: complex.route
    });
    await expect(readJson(join(task.dir, "latest-route.json"), RouteDecisionSchema)).resolves.toMatchObject({
      mode: "complex",
      source: "codex"
    });
  });

  it("uses a short safe fallback for active task follow-ups when Codex routing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-fallback-"));
    const config = mockConfig(root);
    config.router.defaultMode = "auto";
    config.router.codex.timeoutMs = 120000;
    config.router.codex.followUpTimeoutMs = 20000;
    config.router.codex.env = {
      HTTPS_PROXY: "http://user:secret@127.0.0.1:7890"
    };
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "实现俄罗斯方块",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    let seenTimeout = 0;
    let seenFallback = "";
    let routeStart: unknown;
    const routeProgress: string[] = [];
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async (_prompt, routeConfig) => {
        seenTimeout = routeConfig.router.codex.timeoutMs;
        seenFallback = routeConfig.router.codex.fallback;
        throw new Error("router transport unavailable");
      }
    );

    const result = await orchestrator.routeTaskFollowUp({
      taskId: task.id,
      request: "你好",
      cwd: root,
      onRouteStart: (state: unknown) => {
        routeStart = state;
      },
      onRouteProgress: (state: { phase: string }) => {
        routeProgress.push(state.phase);
      }
    });

    expect(seenTimeout).toBe(20000);
    expect(seenFallback).toBe("simple");
    expect(routeStart).toEqual({
      scope: "follow-up",
      mode: "auto",
      timeoutMs: 20000,
      phase: "starting",
      attempt: 1,
      maxAttempts: 1,
      proxyConfigured: true,
      proxySource: "router-config",
      proxyVariable: "HTTPS_PROXY",
      proxyEndpoint: "127.0.0.1:7890"
    });
    expect(routeProgress).toEqual(["dispatching"]);
    expect(result).toMatchObject({
      mode: "simple",
      taskId: null,
      route: {
        mode: "simple",
        source: "fallback",
        suggested_roles: [],
        proxy_configured: true,
        proxy_source: "router-config",
        proxy_variable: "HTTPS_PROXY",
        proxy_endpoint: "127.0.0.1:7890"
      }
    });
    expect(result.reason).toContain("fallback forced simple");
  });

  it("lets an active-task fallback choose a new Parallel turn instead of silently using Main", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-fallback-choice-"));
    const config = mockConfig(root);
    config.router.defaultMode = "auto";
    config.router.codex.followUpTimeoutMs = 20000;
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "follow-choice"
    });
    const task = await manager.createTask({
      request: "实现俄罗斯方块",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        throw new Error("router transport unavailable");
      }
    );

    const result = await orchestrator.routeTaskFollowUp({
      taskId: task.id,
      request: "改成不用 Docker",
      cwd: root,
      onRouteFallback: async () => "parallel"
    });

    expect(result).toMatchObject({
      mode: "complex",
      taskId: task.id,
      route: {
        mode: "complex",
        source: "fallback",
        router_fallback_resolution: "parallel"
      }
    });
    expect(await pathExists(join(task.dir, "latest-route.json"))).toBe(false);
    await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "改成不用 Docker",
      cwd: root,
      route: result.route
    });
    await expect(readJson(join(task.dir, "latest-route.json"), RouteDecisionSchema)).resolves.toMatchObject({
      mode: "complex",
      router_fallback_resolution: "parallel"
    });
  });

  it("answers a directly handled simple task turn through Main without appending a worker turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-direct-simple-turn-"));
    const config = mockConfig(root);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "实现俄罗斯方块",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const adapter = new CapturingAdapter();
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", adapter]]),
      async () => JSON.stringify({ mode: "simple", reason: "Conversational follow-up." })
    );

    const result = await orchestrator.handleTaskTurn({
      taskId: task.id,
      request: "你好",
      cwd: root
    });

    expect(result.mode).toBe("simple");
    expect(adapter.runs.map((run) => run.role)).toEqual(["main"]);
    expect(await pathExists(join(task.dir, "turns", "0002"))).toBe(false);
    expect(await pathExists(join(task.dir, "actor-mock"))).toBe(false);
  });

  it("reuses the precomputed complex follow-up decision when starting the task turn", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-once-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-once-workspace-"));
    const routerCwdRoot = join(appRoot, ".parallel-codex", "router");
    const config = mockConfig(appRoot);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: workspaceRoot,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    let routeCalls = 0;
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      async () => {
        routeCalls += 1;
        return JSON.stringify({ mode: "complex", reason: "Project work needs the pair." });
      },
      routerCwdRoot
    );
    const initial = await orchestrator.handleRequest({
      request: "实现计分功能",
      cwd: workspaceRoot
    });
    const followUp = await orchestrator.routeTaskFollowUp({
      taskId: initial.taskId ?? "",
      request: "再增加等级速度",
      cwd: workspaceRoot
    });
    const precomputedRoute = (
      followUp as typeof followUp & { route?: unknown }
    ).route;

    await orchestrator.handleTaskTurn({
      taskId: initial.taskId ?? "",
      request: "再增加等级速度",
      cwd: workspaceRoot,
      route: precomputedRoute
    } as Parameters<Orchestrator["handleTaskTurn"]>[0]);

    expect(routeCalls).toBe(2);
    const auditLines = (await readTextIfExists(join(routerCwdRoot, "routes.jsonl")))
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(auditLines).toHaveLength(2);
  });

  it("routes active task follow-ups using only the current user request", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-follow-up-request-only-"));
    const config = mockConfig(root);
    config.router.defaultMode = "auto";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "优化得分",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    let seenPrompt = "";
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]), async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({
        mode: "simple",
        reason: "mock request-only follow-up route"
      });
    });

    await orchestrator.routeTaskFollowUp({
      taskId: task.id,
      request: "原因呢超时",
      cwd: root
    });

    expect(seenPrompt).toContain("原因呢超时");
    expect(seenPrompt).not.toContain(task.id);
    expect(seenPrompt).not.toContain("Task status");
    expect(seenPrompt).not.toContain(root);
  });

  it("stops complex flow when a worker fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-failure-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "fail"
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new FailingJudgeAdapter()]]));

    await expect(
      orchestrator.handleRequest({
        request: "做个俄罗斯方块的游戏",
        cwd: root
      })
    ).rejects.toThrow("judge-mock failed with exit code 2");

    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033000-fail");
    expect(await pathExists(join(taskDir, "critic-mock"))).toBe(false);
    const meta = await readJson(join(taskDir, "meta.json"), TaskMetaSchema);
    expect(meta.status).toBe("failed");
  });

  it("stops before Critic when a timed-out worker handles SIGTERM with exit code zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-logical-worker-failure-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "logical-failure"
    });
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const role = process.env.PARALLEL_CODEX_ROLE;",
      "const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  if (role === 'judge') {",
      "    fs.writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\\n\\n- [R-001] Preserve watchdog failures.\\n');",
      "    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\\n\\n1. [P-001] Run the Actor.\\n');",
      "    fs.writeFileSync(path.join(dir, 'acceptance.md'), '# Acceptance\\n\\n- [A-001] [R-001] A timed-out Actor blocks Critic.\\n');",
      "    fs.writeFileSync(path.join(dir, 'actor-brief.md'), '# Actor Brief\\n\\nImplement the requested behavior.\\n');",
      "    fs.writeFileSync(path.join(dir, 'critic-brief.md'), '# Critic Brief\\n\\nReview only successful Actor work.\\n');",
      "    return;",
      "  }",
      "  if (role === 'actor') {",
      "    fs.writeFileSync(path.join(dir, 'worklog.md'), '# Worklog\\n\\nActor reached the deadline.\\n');",
      "    process.on('SIGTERM', () => process.exit(0));",
      "    setInterval(() => {}, 1000);",
      "    return;",
      "  }",
      "  fs.writeFileSync(path.join(dir, 'review.md'), 'APPROVED\\n');",
      "});"
    ].join("");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script], "mock", {
      timeoutMs: 800
    });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    await expect(orchestrator.handleRequest({
      request: "实现一个不能忽略超时的功能",
      cwd: root
    })).rejects.toThrow("actor-mock failed during process-timeout");

    const taskDir = join(root, ".parallel-codex", "sessions", "task-20260630-033000-logical-failure");
    expect(await pathExists(join(taskDir, "critic-mock"))).toBe(false);
    await expect(readJson(join(taskDir, "actor-mock", "status.json"), WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-timeout"
    });
    await expect(readJson(join(taskDir, "meta.json"), TaskMetaSchema)).resolves.toMatchObject({
      status: "failed"
    });
    await expect(orchestrator.canRetryTask("task-20260630-033000-logical-failure")).resolves.toBe(true);
  }, 5000);

  it("converges the task and releases its lease when feature failure persistence also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-failure-convergence-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:30:30.000Z"),
      randomId: () => "failure-convergence"
    });
    const adapter = new RejectingParallelActorWithBrokenFeatureStatusAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033030-failure-convergence";
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);

    const failure = await orchestrator.handleRequest({
      request: "实现故障后仍可恢复的功能",
      cwd: root
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("actor adapter finalization failed");
    expect((failure as Error).message).toContain("state convergence failed");
    expect((failure as Error).message).toContain("EISDIR");
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);

    await expect(readJson(join(taskDir, "meta.json"), TaskMetaSchema)).resolves.toMatchObject({
      status: "failed"
    });
    await expect(orchestrator.canRetryTask(taskId)).resolves.toBe(true);
    expect(JSON.parse(await readTextIfExists(
      join(taskDir, "features", "0001-healthy", "status.json")
    ))).toMatchObject({ state: "failed" });
    expect(await pathExists(taskRunOwnerPath(taskDir))).toBe(false);

    await rm(join(taskDir, "features", "0001-broken", "status.json"), { recursive: true });
    const retried = await orchestrator.retryTask({ taskId, cwd: root });

    expect(retried.mode).toBe("complex");
    expect(adapter.sawFirstAttemptEvidenceOnRetry).toBe(true);
    expect(adapter.retriedNativeSessionId).toBe("failure-convergence-actor-session");
    expect(adapter.actorRuns).toEqual({ broken: 2, healthy: 1 });
    await expect(readJson(join(taskDir, "meta.json"), TaskMetaSchema)).resolves.toMatchObject({
      status: "done"
    });
  });

  it("retries a failed task in the same task and turn with its native worker session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:00.000Z"),
      randomId: () => "retry"
    });
    const adapter = new RetryOnceActorAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033100-retry";

    await expect(
      orchestrator.handleRequest({
        request: "实现一个可玩的俄罗斯方块",
        cwd: root
      })
    ).rejects.toThrow("actor-mock failed with exit code 2");

    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    const turnDir = join(taskDir, "turns", "0001");
    await writeText(join(turnDir, "requirements.md"), "# Requirements\n\n- Build the game.\n");
    await writeText(join(turnDir, "plan.md"), "# Plan\n\n1. Implement the game.\n");
    await writeText(join(turnDir, "acceptance.md"), "# Acceptance\n\n- The smoke test passes.\n");
    await writeText(join(turnDir, "judge-validation.json"), "");
    await writeJson(join(taskDir, "latest-route.json"), RouteDecisionSchema.parse({
      mode: "simple",
      reason: "A later task question.",
      source: "codex",
      duration_ms: 9000,
      suggested_roles: []
    }));

    const resumedManager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:10.000Z")
    });
    const resumedOrchestrator = new Orchestrator(config, resumedManager, new Map([["mock", adapter]]));
    const result = await resumedOrchestrator.retryTask({ taskId, cwd: root });
    const meta = await readJson(join(taskDir, "meta.json"), TaskMetaSchema);
    const latestRoute = await readJson(join(taskDir, "latest-route.json"), RouteDecisionSchema);

    expect(result.taskId).toBe(taskId);
    expect(meta.status).toBe("done");
    expect(latestRoute).toMatchObject({ mode: "complex", source: "forced" });
    expect(adapter.actorRuns).toBe(2);
    expect(adapter.judgeRuns).toBe(1);
    expect(adapter.actorNativeSessions).toEqual([null, "retry-actor-session"]);
    expect(JSON.parse(await readTextIfExists(join(turnDir, "judge-validation.json")))).toMatchObject({
      state: "valid",
      contract: {
        requirements: [{ id: "R-001", text: "Build the game." }],
        plan: [{ id: "P-001", text: "Implement the game." }],
        acceptance: [{ id: "A-001", text: "The smoke test passes." }]
      }
    });
    expect(await pathExists(join(taskDir, "turns", "0002"))).toBe(false);
    expect(await readTextIfExists(join(taskDir, "actor-mock", "output.log"))).toContain("FIRST_ACTOR_FAILURE");
    expect(await readTextIfExists(join(taskDir, "events.jsonl"))).toContain("task.retrying");
  });

  it("rebuilds an incomplete legacy done task from its integrated checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-recover-incomplete-done-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:05.000Z"),
      randomId: () => "incomplete-done"
    });
    const firstAdapter = new CapturingAdapter();
    const firstOrchestrator = new Orchestrator(config, manager, new Map([["mock", firstAdapter]]));
    const first = await firstOrchestrator.handleRequest({
      request: "build recoverable completion",
      cwd: root
    });
    const taskId = first.taskId ?? "";
    const taskDir = join(root, config.dataDir, "sessions", taskId);
    const featureDir = join(taskDir, "features", "0001-build-recoverable-completion");
    await writeText(join(taskDir, "turns", "0001", "supervisor-summary.md"), "");
    await writeText(join(featureDir, "decisions.md"), "");
    const featureStatus = JSON.parse(await readTextIfExists(join(featureDir, "status.json")));
    await writeJson(join(featureDir, "status.json"), { ...featureStatus, state: "integrating" });

    const resumedManager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:15.000Z")
    });
    await expect(resumedManager.reconcileInterruptedTasks()).resolves.toEqual([
      expect.objectContaining({ taskId, previousState: "done", featuresRecovered: 1 })
    ]);
    const resumedAdapter = new CapturingAdapter();
    const resumedOrchestrator = new Orchestrator(
      config,
      resumedManager,
      new Map([["mock", resumedAdapter]])
    );

    const recovered = await resumedOrchestrator.retryTask({ taskId, cwd: root });

    expect(recovered.summary).toContain("Complex task completed.");
    expect(resumedAdapter.runs).toHaveLength(0);
    expect(await readTextIfExists(join(taskDir, "turns", "0001", "supervisor-summary.md"))).toContain(
      "Complex task completed."
    );
    expect(await readTextIfExists(join(featureDir, "decisions.md"))).toContain("APPROVED");
    expect(JSON.parse(await readTextIfExists(join(featureDir, "status.json"))).state).toBe("approved");
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("done");
  });

  it("rejects a concurrent retry while another TUI owns the task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-live-owner-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:11.000Z"),
      randomId: () => "owned"
    });
    const task = await manager.createTask({
      request: "实现并行功能",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await manager.updateTaskStatus(task, "failed");
    const lease = await claimTaskRunLease(task.dir, { ownerId: "other-live-tui" });
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", new MockWorkerAdapter()]]));

    try {
      await expect(orchestrator.retryTask({ taskId: task.id, cwd: root }))
        .rejects.toThrow("Task is already running in another parallel-codex-tui process");
      expect(await pathExists(join(task.dir, "turns", "0002"))).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("retries a failed single-feature Critic without rerunning its completed Actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-single-critic-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:12.000Z"),
      randomId: () => "single-critic"
    });
    const adapter = new RetryOnceCriticAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033112-single-critic";

    await expect(orchestrator.handleRequest({
      request: "实现并审查单个功能",
      cwd: root
    })).rejects.toThrow("critic-mock failed with exit code 2");

    const resumedManager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:28.000Z")
    });
    const resumedOrchestrator = new Orchestrator(config, resumedManager, new Map([["mock", adapter]]));
    const result = await resumedOrchestrator.retryTask({ taskId, cwd: root });
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    const events = await readTextIfExists(join(taskDir, "events.jsonl"));

    expect(adapter.judgeRuns).toBe(1);
    expect(adapter.actorRuns).toBe(1);
    expect(adapter.criticRuns).toBe(2);
    expect(adapter.criticNativeSessions).toEqual([null, "retry-critic-session"]);
    expect(result.workers.map((worker) => worker.id)).not.toContain("actor-mock");
    expect(events).toContain("feature.wave_actor_checkpoints_reused");
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("done");
  });

  it("retries a failed feature worker with the persisted plan and native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-feature-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:15.000Z"),
      randomId: () => "feature"
    });
    const adapter = new RetryMultiFeatureAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033115-feature";

    await expect(orchestrator.handleRequest({
      request: "实现游戏界面、规则引擎并完成集成",
      cwd: root
    })).rejects.toThrow("actor-mock-0001-ui failed with exit code 2");

    const result = await orchestrator.retryTask({ taskId, cwd: root });
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);

    expect(result.taskId).toBe(taskId);
    expect(adapter.uiNativeSessions).toEqual([null, "retry-ui-session"]);
    expect(adapter.events.filter((event) => event === "actor:start:0001-engine")).toHaveLength(1);
    expect(result.workers.map((worker) => worker.id)).toContain("actor-mock-0001-integration");
    expect(await pathExists(join(taskDir, "turns", "0002"))).toBe(false);
    expect(await readTextIfExists(join(taskDir, "actor-mock-0001-ui", "output.log"))).toContain("FIRST_UI_FAILURE");
    expect(await readTextIfExists(join(taskDir, "turns", "0001", "feature-plan.json"))).toContain('"id": "integration"');
  });

  it("resumes a failed feature plan from its last integrated wave", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-resume-checkpoint-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:18.000Z"),
      randomId: () => "checkpoint"
    });
    const adapter = new RetryCheckpointFeatureAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033118-checkpoint";

    await expect(orchestrator.handleRequest({
      request: "依次完成基础层、界面层和最终集成",
      cwd: root
    })).rejects.toThrow("actor-mock-0001-ui failed with exit code 2");

    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    expect(await readTextIfExists(join(root, "src", "0001-foundation.txt"))).toBe("implemented 0001-foundation\n");
    expect(JSON.parse(await readTextIfExists(join(
      taskDir,
      "features",
      "0001-foundation",
      "status.json"
    )))).toMatchObject({ state: "approved" });

    const resumedManager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:29.000Z")
    });
    const resumedOrchestrator = new Orchestrator(config, resumedManager, new Map([["mock", adapter]]));
    const result = await resumedOrchestrator.retryTask({ taskId, cwd: root });
    const events = await readTextIfExists(join(taskDir, "events.jsonl"));

    expect(adapter.judgeRuns).toBe(1);
    expect(adapter.actorRuns.get("0001-foundation")).toBe(1);
    expect(adapter.actorRuns.get("0001-ui")).toBe(2);
    expect(adapter.actorRuns.get("0001-integration")).toBe(1);
    expect(adapter.uiNativeSessions).toEqual([null, "checkpoint-ui-session"]);
    expect(adapter.waveCriticRuns.get("critic-mock-wave-0001-0001")).toBe(1);
    expect(adapter.integrationSawDependencies).toBe(true);
    expect(result.workers.map((worker) => worker.id)).not.toContain("judge-mock");
    expect(result.workers.map((worker) => worker.id)).not.toContain("actor-mock-0001-foundation");
    expect(result.summary).toContain("Foundation");
    expect(result.summary).toContain("Game UI");
    expect(result.summary).toContain("Integration");
    expect(events).toContain("feature.wave_checkpoint_reused");
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("done");
    for (const featureId of ["0001-foundation", "0001-ui", "0001-integration"]) {
      expect(JSON.parse(await readTextIfExists(join(taskDir, "features", featureId, "status.json"))))
        .toMatchObject({ state: "approved" });
    }
  });

  it("recovers an integrated wave when a crash left feature states unfinished", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-recover-integrated-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:19.000Z"),
      randomId: () => "recover"
    });
    const adapter = new IntegratedCheckpointRecoveryAdapter(root);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const initial = await orchestrator.handleRequest({ request: "并行创建 alpha 和 beta", cwd: root });
    const taskId = initial.taskId ?? "";
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);

    const meta = await readJson(join(taskDir, "meta.json"), TaskMetaSchema);
    await writeJson(join(taskDir, "meta.json"), { ...meta, status: "failed" });
    for (const featureId of ["0001-alpha", "0001-beta"]) {
      const statusPath = join(taskDir, "features", featureId, "status.json");
      const status = JSON.parse(await readTextIfExists(statusPath)) as Record<string, unknown>;
      await writeJson(statusPath, { ...status, state: "failed" });
    }

    const result = await orchestrator.retryTask({ taskId, cwd: root });
    const events = await readTextIfExists(join(taskDir, "events.jsonl"));

    expect(adapter.judgeRuns).toBe(1);
    expect(adapter.actorRuns).toBe(2);
    expect(adapter.waveCriticRuns).toBe(1);
    expect(result.workers).toEqual([]);
    expect(result.summary).toContain("Alpha");
    expect(result.summary).toContain("Beta");
    expect(events).toContain("feature.wave_checkpoint_recovered");
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("done");
    for (const featureId of ["0001-alpha", "0001-beta"]) {
      expect(JSON.parse(await readTextIfExists(join(taskDir, "features", featureId, "status.json"))))
        .toMatchObject({ state: "approved" });
    }
  });

  it("recovers an integrated single feature without applying it twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-recover-single-integrated-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:19.500Z"),
      randomId: () => "single-recover"
    });
    const adapter = new SingleIsolationAdapter(root);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const initial = await orchestrator.handleRequest({ request: "实现单个安全功能", cwd: root });
    const taskId = initial.taskId ?? "";
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    const featureStatusPath = join(taskDir, "features", "0001", "status.json");

    const meta = await readJson(join(taskDir, "meta.json"), TaskMetaSchema);
    const featureStatus = JSON.parse(await readTextIfExists(featureStatusPath)) as Record<string, unknown>;
    await writeJson(join(taskDir, "meta.json"), { ...meta, status: "failed" });
    await writeJson(featureStatusPath, { ...featureStatus, state: "failed" });

    const result = await orchestrator.retryTask({ taskId, cwd: root });
    const events = await readTextIfExists(join(taskDir, "events.jsonl"));

    expect(adapter.judgeRuns).toBe(1);
    expect(adapter.actorRuns).toBe(1);
    expect(adapter.criticRuns).toBe(1);
    expect(result.workers).toEqual([]);
    expect(await readTextIfExists(join(root, "approved.txt"))).toBe("approved\n");
    expect(events).toContain("feature.wave_checkpoint_recovered");
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({ state: "approved" });
    expect((await readJson(join(taskDir, "meta.json"), TaskMetaSchema)).status).toBe("done");
  });

  it("retries failed Wave verification with the same Critic native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-wave-verify-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:20.000Z"),
      randomId: () => "wave-verify"
    });
    const adapter = new RetryWaveVerificationAdapter(root);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033120-wave-verify";

    await expect(orchestrator.handleRequest({
      request: "并行创建 alpha 和 beta",
      cwd: root
    })).rejects.toThrow("did not include APPROVED or REVISION_REQUIRED");
    expect(await pathExists(join(root, "alpha.txt"))).toBe(false);

    const result = await orchestrator.retryTask({ taskId, cwd: root });

    expect(result.taskId).toBe(taskId);
    expect(adapter.waveCriticNativeSessions).toEqual([null, "mock-critic-mock-wave-0001-0001"]);
    expect(adapter.featureActorRuns).toBe(2);
    expect(adapter.featureCriticRuns).toBe(2);
    expect(await readTextIfExists(join(root, "alpha.txt"))).toBe("alpha\n");
    expect(await readTextIfExists(join(root, "beta.txt"))).toBe("beta\n");
    expect((await readJson(join(root, ".parallel-codex", "sessions", taskId, "meta.json"), TaskMetaSchema)).status).toBe("done");
  });

  it("retries a failed follow-up turn without adding another turn or rerunning Judge", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-follow-up-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:30.000Z"),
      randomId: () => "follow"
    });
    const adapter = new RetryFollowUpActorAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const initial = await orchestrator.handleRequest({ request: "实现基础游戏", cwd: root });
    const taskId = initial.taskId ?? "";

    await expect(
      orchestrator.handleTaskTurn({ taskId, request: "增加关卡速度", cwd: root })
    ).rejects.toThrow("actor-mock failed with exit code 2");

    await orchestrator.retryTask({ taskId, cwd: root });
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);

    expect(adapter.runs.filter((run) => run.role === "judge")).toHaveLength(2);
    expect(adapter.runs.filter((run) => run.role === "actor")).toHaveLength(3);
    expect(adapter.runs.filter((run) => run.role === "actor").at(-1)?.nativeSession?.session_id).toBe("mock-actor-mock");
    expect(await pathExists(join(taskDir, "turns", "0002"))).toBe(true);
    expect(await pathExists(join(taskDir, "turns", "0003"))).toBe(false);
    expect(await readTextIfExists(join(taskDir, "actor-mock", "output.log"))).toContain("FOLLOWUP_ACTOR_FAILURE");
  });

  it("reruns a failed follow-up Judge when no turn snapshot was produced", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-follow-up-judge-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:31.000Z"),
      randomId: () => "follow-judge"
    });
    const adapter = new RetryFollowUpJudgeAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const initial = await orchestrator.handleRequest({ request: "实现基础游戏", cwd: root });
    const taskId = initial.taskId ?? "";

    await expect(
      orchestrator.handleTaskTurn({ taskId, request: "改成另一个方向", cwd: root })
    ).rejects.toThrow("judge-mock failed with exit code 2");

    const result = await orchestrator.retryTask({ taskId, cwd: root });
    const taskDir = join(root, ".parallel-codex", "sessions", taskId);

    expect(result.mode).toBe("complex");
    expect(adapter.judgeNativeSessions).toEqual([null, "mock-judge-mock", "mock-judge-mock"]);
    expect(await readTextIfExists(join(taskDir, "turns", "0002", "requirements.md"))).toContain("Mock requirements");
    expect(await pathExists(join(taskDir, "turns", "0003"))).toBe(false);
  });

  it("cancels only the selected active feature worker and leaves the live workspace untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-cancel-feature-"));
    const config = mockConfig(root);
    config.orchestration.maxParallelFeatures = 2;
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:32:05.000Z"),
      randomId: () => "feature-cancel"
    });
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const role = process.env.PARALLEL_CODEX_ROLE;",
      "const workerId = process.env.PARALLEL_CODEX_WORKER_ID;",
      "const filesDir = process.env.PARALLEL_CODEX_FILES_DIR;",
      "if (role === 'judge') {",
      "  fs.writeFileSync(path.join(filesDir, 'requirements.md'), '# Requirements\\n\\n- [R-001] Implement alpha and beta.\\n');",
      "  fs.writeFileSync(path.join(filesDir, 'plan.md'), '# Plan\\n\\n1. [P-001] Implement both features.\\n');",
      "  fs.writeFileSync(path.join(filesDir, 'acceptance.md'), '# Acceptance\\n\\n- [A-001] [R-001] Both features are verified.\\n');",
      "  fs.writeFileSync(path.join(filesDir, 'actor-brief.md'), '# Actor Brief\\n\\nImplement the assigned feature.\\n');",
      "  fs.writeFileSync(path.join(filesDir, 'critic-brief.md'), '# Critic Brief\\n\\nVerify the assigned feature.\\n');",
      "  fs.writeFileSync(path.join(filesDir, 'features.json'), JSON.stringify({version:1,features:[",
      "    {id:'alpha',title:'Alpha',description:'Implement alpha',depends_on:[]},",
      "    {id:'beta',title:'Beta',description:'Implement beta',depends_on:[]}",
      "  ]}));",
      "  process.exit(0);",
      "}",
      "if (role === 'actor') {",
      "  console.log(workerId + ' started');",
      "  if (workerId.endsWith('-alpha')) setInterval(() => {}, 1000);",
      "  else setTimeout(() => { fs.writeFileSync(path.join(filesDir, 'worklog.md'), 'beta complete\\n'); process.exit(0); }, 180);",
      "}",
      "if (role === 'critic') { fs.writeFileSync(path.join(filesDir, 'review.md'), 'APPROVED\\n'); process.exit(0); }"
    ].join("");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const controllable = orchestrator as Orchestrator & {
      cancelFeature?: (taskId: string, featureId: string) => Promise<{
        requested: boolean;
        featureId: string;
        role?: string;
      }>;
    };
    const taskId = "task-20260630-033205-feature-cancel";
    let cancellation: Promise<{ requested: boolean; featureId: string; role?: string }> | null = null;

    expect(controllable.cancelFeature).toBeTypeOf("function");
    const run = orchestrator.handleRequest({
      request: "并行实现 alpha 与 beta",
      cwd: root,
      onWorker: (worker) => {
        if (worker.id === "actor-mock-0001-alpha" && !cancellation) {
          cancellation = new Promise((resolve, reject) => {
            setTimeout(() => {
              controllable.cancelFeature?.(taskId, "0001-alpha").then(resolve, reject);
            }, 80);
          });
        }
      }
    });

    await expect(run).rejects.toThrow("Feature 0001-alpha was cancelled before integration");
    await expect(cancellation).resolves.toEqual({
      requested: true,
      featureId: "0001-alpha",
      role: "actor"
    });

    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    const meta = await readJson(join(taskDir, "meta.json"), TaskMetaSchema);
    const alphaWorker = await readJson(join(taskDir, "actor-mock-0001-alpha", "status.json"), WorkerStatusSchema);
    const betaWorker = await readJson(join(taskDir, "actor-mock-0001-beta", "status.json"), WorkerStatusSchema);
    const alphaFeature = JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-alpha", "status.json"))) as { state: string };
    const betaFeature = JSON.parse(await readTextIfExists(join(taskDir, "features", "0001-beta", "status.json"))) as { state: string };
    const events = await readTextIfExists(join(taskDir, "events.jsonl"));

    expect(meta.status).toBe("cancelled");
    expect(alphaWorker.state).toBe("cancelled");
    expect(betaWorker.state).toBe("done");
    expect(alphaFeature.state).toBe("cancelled");
    expect(betaFeature.state).toBe("failed");
    expect(events).toContain("feature.cancel_requested");
    expect(events).toContain("feature.cancelled");
    expect(await pathExists(join(taskDir, "critic-mock-0001-alpha"))).toBe(false);
    expect(await pathExists(join(taskDir, "critic-mock-0001-beta"))).toBe(false);
    expect(await pathExists(join(root, "alpha.txt"))).toBe(false);
    expect(await pathExists(join(root, "beta.txt"))).toBe(false);
    await expect(orchestrator.canRetryTask(taskId)).resolves.toBe(true);
    await expect(orchestrator.cancelFeature(taskId, "0001-alpha")).resolves.toEqual({
      requested: false,
      featureId: "0001-alpha"
    });
  });

  it("marks an interrupted task cancelled and does not start the next worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-cancel-"));
    const config = mockConfig(root);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:32:00.000Z"),
      randomId: () => "stop"
    });
    const controller = new AbortController();
    const script = [
      "const role = process.env.PARALLEL_CODEX_ROLE;",
      "console.log(role + ' ready');",
      "if (role === 'judge') {",
      "  const fs = require('node:fs');",
      "  const path = require('node:path');",
      "  const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
      "  fs.writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\\n\\n- [R-001] Run a cancellable Actor.\\n');",
      "  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\\n\\n1. [P-001] Start the Actor.\\n');",
      "  fs.writeFileSync(path.join(dir, 'acceptance.md'), '# Acceptance\\n\\n- [A-001] [R-001] Cancellation stops the Actor.\\n');",
      "  fs.writeFileSync(path.join(dir, 'actor-brief.md'), '# Actor Brief\\n\\nImplement the requested behavior.\\n');",
      "  fs.writeFileSync(path.join(dir, 'critic-brief.md'), '# Critic Brief\\n\\nVerify cancellation behavior.\\n');",
      "}",
      "if (role === 'actor') setInterval(() => {}, 1000);"
    ].join("");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const taskId = "task-20260630-033200-stop";

    await expect(
      orchestrator.handleRequest({
        request: "实现一个可取消的俄罗斯方块任务",
        cwd: root,
        signal: controller.signal,
        onWorker: (worker) => {
          if (worker.role === "actor") {
            setTimeout(() => controller.abort(), 80);
          }
        }
      })
    ).rejects.toMatchObject({ name: "AbortError", message: "Request cancelled." });

    const taskDir = join(root, ".parallel-codex", "sessions", taskId);
    const meta = await readJson(join(taskDir, "meta.json"), TaskMetaSchema);
    const actorStatus = await readJson(join(taskDir, "actor-mock", "status.json"), WorkerStatusSchema);
    expect(meta.status).toBe("cancelled");
    expect(actorStatus.state).toBe("cancelled");
    expect(actorStatus.phase).toBe("process-cancelled");
    expect(await pathExists(join(taskDir, "critic-mock"))).toBe(false);
  });
});

class CompletionOrderingSessionManager extends SessionManager {
  readonly doneEvidence: Array<{
    summary: boolean;
    decision: boolean;
    featureApproved: boolean;
  }> = [];

  override async updateTaskStatus(task: TaskSession, status: TaskState): Promise<void> {
    if (status === "done") {
      const featureDir = join(task.dir, "features", "0001-build-completion-ordering");
      const featureStatusText = await readTextIfExists(join(featureDir, "status.json"));
      let featureApproved = false;
      try {
        featureApproved = JSON.parse(featureStatusText).state === "approved";
      } catch {
        featureApproved = false;
      }
      this.doneEvidence.push({
        summary: Boolean((await readTextIfExists(join(task.dir, "turns", "0001", "supervisor-summary.md"))).trim()),
        decision: Boolean((await readTextIfExists(join(featureDir, "decisions.md"))).trim()),
        featureApproved
      });
    }
    await super.updateTaskStatus(task, status);
  }
}

class FailingJudgeAdapter implements WorkerAdapter {
  readonly name = "mock" as const;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      return {
        workerId: spec.workerId,
        exitCode: 2,
        signal: null
      };
    }
    return new MockWorkerAdapter().run(spec);
  }
}

class RejectingParallelActorWithBrokenFeatureStatusAdapter extends MockWorkerAdapter {
  readonly actorRuns = { broken: 0, healthy: 0 };
  sawFirstAttemptEvidenceOnRetry = false;
  retriedNativeSessionId: string | null = null;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: [
          { id: "broken", title: "Broken persistence", description: "Trigger persistence failure", depends_on: [] },
          { id: "healthy", title: "Healthy peer", description: "Finish alongside the failed Actor", depends_on: [] }
        ]
      });
      return result;
    }
    if (spec.role !== "actor") {
      return super.run(spec);
    }

    const featureName = spec.featureId === "0001-broken" ? "broken" : "healthy";
    this.actorRuns[featureName] += 1;
    if (featureName === "healthy" || this.actorRuns.broken > 1) {
      if (featureName === "broken") {
        this.retriedNativeSessionId = spec.nativeSession?.session_id ?? null;
        this.sawFirstAttemptEvidenceOnRetry = (await readTextIfExists(
          join(spec.filesDir, "..", "features", spec.featureId ?? "", "actor-worklog.md")
        )).includes("FIRST_ATTEMPT_EVIDENCE");
      }
      return super.run(spec);
    }

    const featureDir = join(spec.filesDir, "..", "features", spec.featureId ?? "");
    await spec.onNativeSession?.("failure-convergence-actor-session");
    await writeText(join(featureDir, "actor-worklog.md"), "FIRST_ATTEMPT_EVIDENCE\n");
    const featureStatusPath = join(featureDir, "status.json");
    await rm(featureStatusPath, { force: true });
    await mkdir(featureStatusPath);
    throw new Error("actor adapter finalization failed");
  }
}

class InvalidJudgeContractAdapter extends MockWorkerAdapter {
  readonly roles: string[] = [];

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.roles.push(spec.role);
    const result = await super.run(spec);
    if (spec.role === "judge") {
      await writeText(join(spec.filesDir, "requirements.md"), "# Requirements\n\nRequirements will be decided later.\n");
    }
    return result;
  }
}

class MissingFeatureDecisionAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "actor") {
      await writeText(join(spec.cwd, "rejected.txt"), "must not reach live\n");
    }
    const result = await super.run(spec);
    if (spec.role === "critic") {
      await writeText(join(spec.filesDir, "review.md"), "Review completed without a decision marker.\n");
    }
    return result;
  }
}

class MarkdownApprovalAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "critic") {
      await writeText(join(spec.filesDir, "review.md"), "## **APPROVED**\n\nNo blocking findings.\n");
    }
    return result;
  }
}

class SingleIsolationAdapter extends MockWorkerAdapter {
  judgeRuns = 0;
  actorRuns = 0;
  criticRuns = 0;
  actorCwd = "";
  criticCwd = "";
  actorIsolation = false;
  criticIsolation = false;
  criticSawActorChange = false;
  liveWasUntouchedDuringCritic = false;

  constructor(private readonly liveRoot: string) {
    super();
  }

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      this.judgeRuns += 1;
    }
    if (spec.role === "actor") {
      this.actorRuns += 1;
      this.actorCwd = spec.cwd;
      this.actorIsolation = spec.enforceWorkspaceIsolation === true;
      await writeText(join(spec.cwd, "approved.txt"), "approved\n");
    }
    if (spec.role === "critic") {
      this.criticRuns += 1;
      this.criticCwd = spec.cwd;
      this.criticIsolation = spec.enforceWorkspaceIsolation === true;
      this.criticSawActorChange = await readTextIfExists(join(spec.cwd, "approved.txt")) === "approved\n";
      this.liveWasUntouchedDuringCritic = !(await pathExists(join(this.liveRoot, "approved.txt")));
      await writeText(join(spec.cwd, "critic-only.txt"), "must not be integrated\n");
    }
    return super.run(spec);
  }
}

class RetryOnceActorAdapter extends MockWorkerAdapter {
  judgeRuns = 0;
  actorRuns = 0;
  readonly actorNativeSessions: Array<string | null> = [];

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      this.judgeRuns += 1;
    }
    if (spec.role !== "actor") {
      return super.run(spec);
    }

    this.actorRuns += 1;
    this.actorNativeSessions.push(spec.nativeSession?.session_id ?? null);
    if (this.actorRuns > 1) {
      return super.run(spec);
    }

    await spec.onNativeSession?.("retry-actor-session");
    await appendText(spec.outputLogPath, "FIRST_ACTOR_FAILURE\n");
    await writeJson(spec.statusPath, {
      worker_id: spec.workerId,
      role: spec.role,
      engine: spec.engine,
      state: "failed",
      phase: "test-failure",
      last_event_at: new Date().toISOString(),
      summary: "Actor failed once",
      native_session_id: "retry-actor-session"
    });
    return {
      workerId: spec.workerId,
      exitCode: 2,
      signal: null
    };
  }
}

class RetryOnceCriticAdapter extends MockWorkerAdapter {
  judgeRuns = 0;
  actorRuns = 0;
  criticRuns = 0;
  readonly criticNativeSessions: Array<string | null> = [];

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      this.judgeRuns += 1;
      return super.run(spec);
    }
    if (spec.role === "actor") {
      this.actorRuns += 1;
      return super.run(spec);
    }
    if (spec.role !== "critic") {
      return super.run(spec);
    }

    this.criticRuns += 1;
    this.criticNativeSessions.push(spec.nativeSession?.session_id ?? null);
    if (this.criticRuns > 1) {
      return super.run(spec);
    }
    await spec.onNativeSession?.("retry-critic-session");
    await appendText(spec.outputLogPath, "FIRST_CRITIC_FAILURE\n");
    await writeJson(spec.statusPath, {
      worker_id: spec.workerId,
      role: spec.role,
      engine: spec.engine,
      state: "failed",
      phase: "test-critic-failure",
      last_event_at: new Date().toISOString(),
      summary: "Critic failed once",
      native_session_id: "retry-critic-session"
    });
    return { workerId: spec.workerId, exitCode: 2, signal: null };
  }
}

class MultiFeatureAdapter extends MockWorkerAdapter {
  readonly events: string[] = [];
  readonly actorCwds = new Map<string, string>();
  readonly criticCwds = new Map<string, string>();
  readonly criticSawActorChanges = new Map<string, boolean>();
  maxConcurrentActors = 0;
  integrationSawDependencies = false;
  private activeActors = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: [
          { id: "ui", title: "Game UI", description: "Render board and controls", depends_on: [] },
          { id: "engine", title: "Game engine", description: "Implement board rules", depends_on: [] },
          { id: "integration", title: "Integration", description: "Connect UI and engine", depends_on: ["ui", "engine"] }
        ]
      });
      return result;
    }

    const featureId = spec.featureId ?? "none";
    if (spec.role === "actor") {
      this.actorCwds.set(featureId, spec.cwd);
      if (featureId === "0001-integration") {
        this.integrationSawDependencies = (
          await pathExists(join(spec.cwd, "src", "0001-ui.txt"))
          && await pathExists(join(spec.cwd, "src", "0001-engine.txt"))
        );
      }
      await writeText(join(spec.cwd, "src", `${featureId}.txt`), `implemented ${featureId}\n`);
      this.activeActors += 1;
      this.maxConcurrentActors = Math.max(this.maxConcurrentActors, this.activeActors);
      this.events.push(`actor:start:${featureId}`);
      try {
        await new Promise((resolve) => setTimeout(resolve, featureId.includes("integration") ? 20 : 80));
        return await super.run(spec);
      } finally {
        this.events.push(`actor:end:${featureId}`);
        this.activeActors -= 1;
      }
    }

    if (spec.role === "critic") {
      this.criticCwds.set(featureId, spec.cwd);
      this.criticSawActorChanges.set(
        featureId,
        await pathExists(join(spec.cwd, "src", `${featureId}.txt`))
      );
      await writeText(join(spec.cwd, "src", `critic-only-${featureId}.txt`), "must not be integrated\n");
      this.events.push(`critic:start:${featureId}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = await super.run(spec);
      this.events.push(`critic:end:${featureId}`);
      return result;
    }

    return super.run(spec);
  }
}

class RetryMultiFeatureAdapter extends MultiFeatureAdapter {
  readonly uiNativeSessions: Array<string | null> = [];
  private uiRuns = 0;
  private judgeRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      this.judgeRuns += 1;
      const result = await super.run(spec);
      if (this.judgeRuns > 1) {
        await writeJson(join(spec.filesDir, "features.json"), {
          version: 1,
          features: [
            { id: "drifted", title: "Drifted plan", description: "Must not replace persisted plan", depends_on: [] }
          ]
        });
      }
      return result;
    }

    if (spec.role !== "actor" || spec.featureId !== "0001-ui") {
      return super.run(spec);
    }

    this.uiRuns += 1;
    this.uiNativeSessions.push(spec.nativeSession?.session_id ?? null);
    if (this.uiRuns > 1) {
      return super.run(spec);
    }

    await spec.onNativeSession?.("retry-ui-session");
    await appendText(spec.outputLogPath, "FIRST_UI_FAILURE\n");
    await writeJson(spec.statusPath, {
      worker_id: spec.workerId,
      feature_id: spec.featureId,
      feature_title: spec.featureTitle,
      role: spec.role,
      engine: spec.engine,
      state: "failed",
      phase: "test-feature-failure",
      last_event_at: new Date().toISOString(),
      summary: "UI actor failed once",
      native_session_id: "retry-ui-session"
    });
    return { workerId: spec.workerId, exitCode: 2, signal: null };
  }
}

class RetryCheckpointFeatureAdapter extends MockWorkerAdapter {
  judgeRuns = 0;
  readonly actorRuns = new Map<string, number>();
  readonly uiNativeSessions: Array<string | null> = [];
  readonly waveCriticRuns = new Map<string, number>();
  integrationSawDependencies = false;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      this.judgeRuns += 1;
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: [
          { id: "foundation", title: "Foundation", description: "Create the foundation", depends_on: [] },
          { id: "ui", title: "Game UI", description: "Build on the foundation", depends_on: ["foundation"] },
          { id: "integration", title: "Integration", description: "Connect all layers", depends_on: ["ui"] }
        ]
      });
      return result;
    }

    if (spec.role === "critic" && spec.workerId.includes("-wave-")) {
      this.waveCriticRuns.set(spec.workerId, (this.waveCriticRuns.get(spec.workerId) ?? 0) + 1);
      return super.run(spec);
    }

    if (spec.role !== "actor" || !spec.featureId) {
      return super.run(spec);
    }

    const runs = (this.actorRuns.get(spec.featureId) ?? 0) + 1;
    this.actorRuns.set(spec.featureId, runs);
    if (spec.featureId === "0001-ui") {
      this.uiNativeSessions.push(spec.nativeSession?.session_id ?? null);
      if (runs === 1) {
        await spec.onNativeSession?.("checkpoint-ui-session");
        await appendText(spec.outputLogPath, "FIRST_UI_FAILURE\n");
        await writeJson(spec.statusPath, {
          worker_id: spec.workerId,
          feature_id: spec.featureId,
          feature_title: spec.featureTitle,
          role: spec.role,
          engine: spec.engine,
          state: "failed",
          phase: "test-checkpoint-failure",
          last_event_at: new Date().toISOString(),
          summary: "UI actor failed once",
          native_session_id: "checkpoint-ui-session"
        });
        return { workerId: spec.workerId, exitCode: 2, signal: null };
      }
    }

    if (spec.featureId === "0001-integration") {
      this.integrationSawDependencies = (
        await pathExists(join(spec.cwd, "src", "0001-foundation.txt"))
        && await pathExists(join(spec.cwd, "src", "0001-ui.txt"))
      );
    }
    await writeText(join(spec.cwd, "src", `${spec.featureId}.txt`), `implemented ${spec.featureId}\n`);
    return super.run(spec);
  }
}

class LimitedParallelAdapter extends MockWorkerAdapter {
  maxConcurrent = 0;
  private active = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: Array.from({ length: 5 }, (_, index) => ({
          id: `module-${index + 1}`,
          title: `Module ${index + 1}`,
          description: `Implement module ${index + 1}`,
          depends_on: []
        }))
      });
      return result;
    }

    if (spec.role !== "actor" && spec.role !== "critic") {
      return super.run(spec);
    }

    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return await super.run(spec);
    } finally {
      this.active -= 1;
    }
  }
}

class QueuedFeatureStateAdapter extends MockWorkerAdapter {
  private readonly actorGate = deferred();
  private readonly criticGate = deferred();
  private readonly actorBatch = deferred();
  private readonly criticBatch = deferred();
  private actorStarts = 0;
  private criticStarts = 0;

  readonly firstActorBatchStarted = this.actorBatch.promise;
  readonly firstCriticBatchStarted = this.criticBatch.promise;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: Array.from({ length: 3 }, (_, index) => ({
          id: `module-${index + 1}`,
          title: `Module ${index + 1}`,
          description: `Implement module ${index + 1}`,
          depends_on: []
        }))
      });
      return result;
    }
    if (spec.role === "actor") {
      this.actorStarts += 1;
      if (this.actorStarts === 2) {
        this.actorBatch.resolve();
      }
      if (this.actorStarts <= 2) {
        await this.actorGate.promise;
      }
    }
    if (spec.role === "critic") {
      this.criticStarts += 1;
      if (this.criticStarts === 2) {
        this.criticBatch.resolve();
      }
      if (this.criticStarts <= 2) {
        await this.criticGate.promise;
      }
    }
    return super.run(spec);
  }

  releaseActors(): void {
    this.actorGate.resolve();
  }

  releaseAll(): void {
    this.actorGate.resolve();
    this.criticGate.resolve();
  }
}

class CombinedVerificationAdapter extends MockWorkerAdapter {
  waveCriticRuns = 0;
  featureActorRuns = 0;
  featureCriticRuns = 0;
  waveCriticSawCombinedWorkspace = false;
  liveWasUntouchedDuringVerification = false;
  waveCriticWritableDirs: string[] = [];

  constructor(private readonly liveRoot: string) {
    super();
  }

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: [
          { id: "alpha", title: "Alpha", description: "Create alpha.txt", depends_on: [] },
          { id: "beta", title: "Beta", description: "Create beta.txt", depends_on: [] }
        ]
      });
      return result;
    }
    if (spec.role === "actor" && spec.featureId) {
      this.featureActorRuns += 1;
      const name = spec.featureId.endsWith("alpha") ? "alpha" : "beta";
      await writeText(join(spec.cwd, `${name}.txt`), `${name}\n`);
    }
    if (spec.role === "critic" && spec.featureId) {
      this.featureCriticRuns += 1;
    }
    if (spec.role === "critic" && spec.workerId.includes("-wave-")) {
      this.waveCriticRuns += 1;
      this.waveCriticWritableDirs = spec.writableDirs ?? [];
      this.waveCriticSawCombinedWorkspace = (
        await readTextIfExists(join(spec.cwd, "alpha.txt")) === "alpha\n"
        && await readTextIfExists(join(spec.cwd, "beta.txt")) === "beta\n"
      );
      this.liveWasUntouchedDuringVerification = (
        !(await pathExists(join(this.liveRoot, "alpha.txt")))
        && !(await pathExists(join(this.liveRoot, "beta.txt")))
      );
    }
    return super.run(spec);
  }
}

class IntegratedCheckpointRecoveryAdapter extends CombinedVerificationAdapter {
  judgeRuns = 0;
  actorRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      this.judgeRuns += 1;
    }
    if (spec.role === "actor" && spec.featureId) {
      this.actorRuns += 1;
    }
    return super.run(spec);
  }
}

class RetryWaveVerificationAdapter extends CombinedVerificationAdapter {
  readonly waveCriticNativeSessions: Array<string | null> = [];

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "critic" && spec.workerId.includes("-wave-")) {
      this.waveCriticNativeSessions.push(spec.nativeSession?.session_id ?? null);
      if (this.waveCriticNativeSessions.length === 1) {
        await writeText(join(spec.filesDir, "review.md"), "No decision on the first attempt.\n");
      }
    }
    return result;
  }
}

class WaveRevisionAdapter extends CombinedVerificationAdapter {
  readonly waveCriticNativeSessions: Array<string | null> = [];
  waveActorRuns = 0;
  secondCriticSawRevision = false;
  liveWasUntouchedBeforeRevision = false;

  constructor(private readonly root: string) {
    super(root);
  }

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "actor" && spec.workerId.includes("-wave-")) {
      this.waveActorRuns += 1;
      this.liveWasUntouchedBeforeRevision = (
        !(await pathExists(join(this.root, "alpha.txt")))
        && !(await pathExists(join(this.root, "beta.txt")))
      );
      await writeText(join(spec.cwd, "combined.txt"), "fixed\n");
    }

    const result = await super.run(spec);
    if (spec.role === "critic" && spec.workerId.includes("-wave-")) {
      this.waveCriticNativeSessions.push(spec.nativeSession?.session_id ?? null);
      if (this.waveCriticNativeSessions.length === 1) {
        await writeText(join(spec.filesDir, "review.md"), "REVISION_REQUIRED\nCreate combined.txt.\n");
      } else {
        this.secondCriticSawRevision = await readTextIfExists(join(spec.cwd, "combined.txt")) === "fixed\n";
      }
    }
    return result;
  }
}

class MissingWaveDecisionAdapter extends CombinedVerificationAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "critic" && spec.workerId.includes("-wave-")) {
      await writeText(join(spec.filesDir, "review.md"), "Review completed without a decision marker.\n");
    }
    return result;
  }
}

class ConflictingFeatureAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: [
          { id: "ui", title: "UI", description: "Update shared ownership for UI", depends_on: [] },
          { id: "engine", title: "Engine", description: "Update shared ownership for engine", depends_on: [] }
        ]
      });
      return result;
    }
    if (spec.role === "actor") {
      const owner = spec.featureId === "0001-ui" ? "ui" : "engine";
      await writeText(join(spec.cwd, "src", "shared.ts"), `export const owner = '${owner}';\n`);
    }
    return super.run(spec);
  }
}

class StopQueuedFeaturesAdapter extends MockWorkerAdapter {
  readonly startedActors: string[] = [];

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      const result = await super.run(spec);
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: Array.from({ length: 5 }, (_, index) => ({
          id: `module-${index + 1}`,
          title: `Module ${index + 1}`,
          description: `Implement module ${index + 1}`,
          depends_on: []
        }))
      });
      return result;
    }

    if (spec.role !== "actor") {
      return super.run(spec);
    }

    this.startedActors.push(spec.featureId ?? "unknown");
    if (spec.featureId === "0001-module-1") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { workerId: spec.workerId, exitCode: 2, signal: null };
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    return super.run(spec);
  }
}

class RetryFollowUpActorAdapter extends MockWorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];
  private actorRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    if (spec.role !== "actor") {
      return super.run(spec);
    }

    this.actorRuns += 1;
    if (this.actorRuns !== 2) {
      return super.run(spec);
    }

    await appendText(spec.outputLogPath, "FOLLOWUP_ACTOR_FAILURE\n");
    await writeJson(spec.statusPath, {
      worker_id: spec.workerId,
      role: spec.role,
      engine: spec.engine,
      state: "failed",
      phase: "test-follow-up-failure",
      last_event_at: new Date().toISOString(),
      summary: "Follow-up actor failed once",
      native_session_id: spec.nativeSession?.session_id
    });
    return { workerId: spec.workerId, exitCode: 2, signal: null };
  }
}

class RetryFollowUpJudgeAdapter extends MockWorkerAdapter {
  readonly judgeNativeSessions: Array<string | null> = [];
  private judgeRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role !== "judge") {
      return super.run(spec);
    }

    this.judgeRuns += 1;
    this.judgeNativeSessions.push(spec.nativeSession?.session_id ?? null);
    if (this.judgeRuns === 2) {
      return { workerId: spec.workerId, exitCode: 2, signal: null };
    }
    return super.run(spec);
  }
}

class FollowUpFeaturePlanAdapter extends MockWorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];
  readonly judgeNativeSessions: Array<string | null> = [];
  private judgeRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    if (spec.role === "judge") {
      this.judgeRuns += 1;
      this.judgeNativeSessions.push(spec.nativeSession?.session_id ?? null);
      const result = await super.run(spec);
      if (this.judgeRuns === 2) {
        await writeJson(join(spec.filesDir, "features.json"), {
          version: 1,
          features: [
            { id: "alpha", title: "Alpha", description: "Create alpha.txt", depends_on: [] },
            { id: "beta", title: "Beta", description: "Create beta.txt", depends_on: [] }
          ]
        });
      }
      return result;
    }

    if (spec.role === "actor" && spec.featureId?.endsWith("-alpha")) {
      await writeText(join(spec.cwd, "alpha.txt"), "alpha\n");
    }
    if (spec.role === "actor" && spec.featureId?.endsWith("-beta")) {
      await writeText(join(spec.cwd, "beta.txt"), "beta\n");
    }
    return super.run(spec);
  }
}

class CapturingAdapter extends MockWorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    return super.run(spec);
  }
}

class RevisionFindingAdapter extends MockWorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];
  readonly criticCwds: string[] = [];
  readonly criticNativeSessions: Array<string | null> = [];
  secondCriticSawActorFix = false;
  secondCriticSawCleanReviewClone = false;
  private criticRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    const result = await super.run(spec);
    if (spec.role === "critic") {
      this.criticRuns += 1;
      this.criticCwds.push(spec.cwd);
      this.criticNativeSessions.push(spec.nativeSession?.session_id ?? null);
      if (this.criticRuns === 1) {
        await writeText(join(spec.cwd, "critic-only.txt"), "discard before recheck\n");
        const featureDir = featureDirFromPrompt(spec.prompt);
        await writeText(join(featureDir, "critic-findings.jsonl"), "");
        await appendJsonLine(join(featureDir, "critic-findings.jsonl"), {
          id: "C-001",
          severity: "blocker",
          summary: "Keyboard handling is incomplete"
        });
        await writeText(join(spec.filesDir, "review.md"), "# **REVISION_REQUIRED**\n\nSee critic-findings.jsonl.\n");
      } else {
        this.secondCriticSawActorFix = await readTextIfExists(join(spec.cwd, "fixed.txt")) === "fixed\n";
        this.secondCriticSawCleanReviewClone = !(await pathExists(join(spec.cwd, "critic-only.txt")));
      }
    }
    if (spec.role === "actor" && spec.prompt.includes("Revision request:")) {
      await writeText(join(spec.cwd, "fixed.txt"), "fixed\n");
      const featureDir = featureDirFromPrompt(spec.prompt);
      await appendJsonLine(join(featureDir, "actor-replies.jsonl"), {
        finding_id: "C-001",
        status: "fixed",
        notes: "Mock actor fixed the keyboard handling."
      });
    }
    return result;
  }
}

class RevisionWithoutFindingsAdapter extends MockWorkerAdapter {
  private criticRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "critic") {
      this.criticRuns += 1;
      if (this.criticRuns === 1) {
        await writeText(join(spec.filesDir, "review.md"), "REVISION_REQUIRED\nWrite the missing file.\n");
      }
    }
    if (spec.role === "actor" && spec.prompt.includes("Revision request:")) {
      await writeText(join(spec.cwd, "revision-without-finding.txt"), "should not run\n");
    }
    return result;
  }
}

class RevisionWithoutReplyAdapter extends MockWorkerAdapter {
  criticRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "critic") {
      this.criticRuns += 1;
      if (this.criticRuns === 1) {
        const featureDir = featureDirFromPrompt(spec.prompt);
        await appendJsonLine(join(featureDir, "critic-findings.jsonl"), {
          id: "C-001",
          severity: "blocker",
          summary: "The required file is missing"
        });
        await writeText(join(spec.filesDir, "review.md"), "REVISION_REQUIRED\nSee critic-findings.jsonl.\n");
      }
    }
    if (spec.role === "actor" && spec.prompt.includes("Revision request:")) {
      await writeText(join(spec.cwd, "unacknowledged-fix.txt"), "fixed without reply\n");
    }
    return result;
  }
}

class ApprovedWithFindingAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "actor") {
      await writeText(join(spec.cwd, "inconsistent-approval.txt"), "must not integrate\n");
    }
    if (spec.role === "critic") {
      const featureDir = featureDirFromPrompt(spec.prompt);
      await appendJsonLine(join(featureDir, "critic-findings.jsonl"), {
        id: "C-001",
        severity: "blocker",
        summary: "Blocking issue still exists"
      });
      await writeText(join(spec.filesDir, "review.md"), "APPROVED\n");
    }
    return result;
  }
}

class RepairingProtocolOnRetryAdapter extends MockWorkerAdapter {
  criticRuns = 0;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const result = await super.run(spec);
    if (spec.role === "actor") {
      await writeText(join(spec.cwd, "protocol-retry.txt"), "ready\n");
    }
    if (spec.role === "critic") {
      this.criticRuns += 1;
      const featureDir = featureDirFromPrompt(spec.prompt);
      if (this.criticRuns === 1) {
        await appendJsonLine(join(featureDir, "critic-findings.jsonl"), {
          id: "C-001",
          severity: "blocker",
          summary: "Contradictory approved finding"
        });
      } else {
        await writeText(join(featureDir, "critic-findings.jsonl"), "");
      }
      await writeText(join(spec.filesDir, "review.md"), "APPROVED\n");
    }
    return result;
  }
}

class EmptyMainWorkerAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "main") {
      return {
        workerId: spec.workerId,
        exitCode: 0,
        signal: null
      };
    }

    return super.run(spec);
  }
}

class CwdRecordingWorkerAdapter extends MockWorkerAdapter {
  constructor(private readonly cwds: string[]) {
    super();
  }

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.cwds.push(spec.cwd);
    return super.run(spec);
  }
}

class FeatureOnlyWorklogAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "actor") {
      const featureDir = featureDirFromPrompt(spec.prompt);
      await writeText(join(featureDir, "actor-worklog.md"), "# Actor Feature Worklog\n\nCURRENT_FEATURE_WORKLOG\n");
      return {
        workerId: spec.workerId,
        exitCode: 0,
        signal: null
      };
    }

    if (spec.role === "critic") {
      await writeText(join(spec.filesDir, "review.md"), "# Review\n\nCURRENT_CRITIC_REVIEW\n\nAPPROVED\n");
      return {
        workerId: spec.workerId,
        exitCode: 0,
        signal: null
      };
    }

    return super.run(spec);
  }
}

class NoArtifactAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "critic") {
      await writeText(join(spec.filesDir, "review.md"), "APPROVED\n");
      return {
        workerId: spec.workerId,
        exitCode: 0,
        signal: null
      };
    }
    if (spec.role === "actor") {
      return {
        workerId: spec.workerId,
        exitCode: 0,
        signal: null
      };
    }

    return super.run(spec);
  }
}

class TurnRequirementsJudgeAdapter extends MockWorkerAdapter {
  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      await writeText(join(turnDirFromPrompt(spec.prompt), "requirements.md"), "# Requirements\n\n- [R-001] TURN_ONLY_REQUIREMENTS\n");
      await writeText(join(turnDirFromPrompt(spec.prompt), "plan.md"), "# Plan\n\n1. [P-001] Execute the turn-local plan.\n");
      await writeText(join(turnDirFromPrompt(spec.prompt), "acceptance.md"), "# Acceptance\n\n- [A-001] [R-001] Turn-local acceptance is verified.\n");
      await writeText(join(turnDirFromPrompt(spec.prompt), "actor-brief.md"), "# Actor Brief\n\nTurn-local actor brief.\n");
      await writeText(join(turnDirFromPrompt(spec.prompt), "critic-brief.md"), "# Critic Brief\n\nTurn-local critic brief.\n");
      return {
        workerId: spec.workerId,
        exitCode: 0,
        signal: null
      };
    }

    return super.run(spec);
  }
}

function featureDirFromPrompt(prompt: string): string {
  const line = prompt.split("\n").find((item) => item.startsWith("Feature directory: "));
  if (!line) {
    throw new Error("Feature directory missing from prompt");
  }
  return line.replace("Feature directory: ", "").trim();
}

function turnDirFromPrompt(prompt: string): string {
  const line = prompt.split("\n").find((item) => item.startsWith("Current turn directory: "));
  if (!line) {
    throw new Error("Current turn directory missing from prompt");
  }
  return line.replace("Current turn directory: ", "").trim();
}
