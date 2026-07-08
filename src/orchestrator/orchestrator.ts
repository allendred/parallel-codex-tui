import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../core/config.js";
import { ensureDir, pathExists, readJson, readTextIfExists, writeJson, writeText } from "../core/file-store.js";
import { routeRequestWithCodex, type CodexRouteRunner } from "../core/router.js";
import type { SessionManager, TaskSession, TaskTurn, WorkerFiles } from "../core/session-manager.js";
import { TaskMetaSchema, WorkerStatusSchema, type EngineName, type NativeSession, type WorkerRole, type WorkerStatus } from "../domain/schemas.js";
import { getAdapter, type WorkerRegistry } from "../workers/registry.js";
import type { WorkerResult, WorkerRunSpec } from "../workers/types.js";
import {
  appendFeatureDialogue,
  createFeatureChannel,
  featurePromptContext,
  type FeatureChannel,
  updateFeatureStatus,
  writeFeatureDecision
} from "./collaboration-channel.js";
import { buildActorPrompt, buildCriticPrompt, buildJudgePrompt } from "./prompts.js";
import { buildSupervisorSummary } from "./supervisor-summary.js";

export interface HandleRequestInput {
  request: string;
  cwd: string;
  onStatus?: (status: WorkerRunStatus) => void;
  onWorker?: (worker: WorkerLogRef) => void;
}

export interface HandleTaskTurnInput extends HandleRequestInput {
  taskId: string;
}

export interface HandleTaskQuestionInput extends HandleRequestInput {
  taskId: string;
}

export interface TaskFollowUpRouteResult {
  mode: "simple" | "complex";
  taskId: string | null;
  reason: string;
}

export interface HandleRequestResult {
  mode: "simple" | "complex";
  taskId: string | null;
  summary: string;
  workers: WorkerLogRef[];
}

export interface WorkerRunStatus {
  taskId: string;
  main?: string;
  judge?: string;
  actor?: string;
  critic?: string;
}

export interface WorkerLogRef {
  id: string;
  role: WorkerRole;
  engine: EngineName;
  label: string;
  logPath: string;
  statusPath: string;
}

export class Orchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly workers: WorkerRegistry,
    private readonly routeRunner?: CodexRouteRunner
  ) {}

  async handleRequest(input: HandleRequestInput): Promise<HandleRequestResult> {
    const route = await this.routeRequest(input.request);
    const workers: WorkerLogRef[] = [];

    if (route.mode === "simple") {
      input.onStatus?.({ taskId: "main", main: "running" });
      const output = await this.runMain(input, workers);
      input.onStatus?.({ taskId: "main", main: "done" });
      return {
        mode: "simple",
        taskId: null,
        summary: extractMainResponse(output) || emptyMainResponseSummary(),
        workers
      };
    }

    const task = await this.sessions.createTask({
      request: input.request,
      cwd: input.cwd,
      route
    });
    const turn = (await this.sessions.latestTurn(task)) ?? {
      turnId: "0001",
      dir: join(task.dir, "turns", "0001"),
      metaPath: join(task.dir, "turns", "0001", "turn.json"),
      userPath: join(task.dir, "turns", "0001", "user.md"),
      routePath: join(task.dir, "turns", "0001", "route.json")
    };

    try {
      await this.sessions.updateTaskStatus(task, "judging");
      input.onStatus?.({ taskId: task.id, judge: "running", actor: "waiting", critic: "waiting" });
      const judge = await this.runJudge(input, task, route.judge_engine, workers, turn);
      const feature = await createFeatureChannel({
        task,
        turn,
        request: input.request,
        judgeDir: judge.dir
      });

      await this.sessions.updateTaskStatus(task, "actor_running");
      await updateFeatureStatus(feature, "actor_running");
      input.onStatus?.({ taskId: task.id, judge: "done", actor: "running", critic: "waiting" });
      let actor = await this.runActor(input, task, route.actor_engine, judge.dir, workers, turn, feature);

      await this.sessions.updateTaskStatus(task, "critic_running");
      await updateFeatureStatus(feature, "critic_running");
      input.onStatus?.({ taskId: task.id, judge: "done", actor: "done", critic: "running" });
      let critic = await this.runCritic(input, task, route.critic_engine, judge.dir, actor.dir, workers, turn, feature);
      const review = await readTextIfExists(`${critic.dir}/review.md`);

      if (review.includes("REVISION_REQUIRED")) {
        await this.sessions.updateTaskStatus(task, "revision_needed");
        await updateFeatureStatus(feature, "revision_needed");
        await appendFeatureDialogue(feature, "critic.revision_requested", "critic", "Critic requested Actor revision.", {
          review: join(critic.dir, "review.md"),
          findings: feature.criticFindingsPath
        });
        input.onStatus?.({ taskId: task.id, judge: "done", actor: "revision", critic: "done" });
        actor = await this.runActor(
          input,
          task,
          route.actor_engine,
          judge.dir,
          workers,
          turn,
          feature,
          buildRevisionRequest(review, feature)
        );
        await this.sessions.updateTaskStatus(task, "critic_running");
        await updateFeatureStatus(feature, "critic_running");
        input.onStatus?.({ taskId: task.id, judge: "done", actor: "done", critic: "rerunning" });
        critic = await this.runCritic(input, task, route.critic_engine, judge.dir, actor.dir, workers, turn, feature);
      }

      await this.sessions.updateTaskStatus(task, "done");
      input.onStatus?.({ taskId: task.id, judge: "done", actor: "done", critic: "done" });
      const summary = await buildSupervisorSummary({
        judgeDir: judge.dir,
        actorDir: actor.dir,
        criticDir: critic.dir,
        turnDir: turn.dir,
        featureActorWorklogPath: feature.actorWorklogPath,
        featureCriticFindingsPath: feature.criticFindingsPath
      });
      await writeText(join(turn.dir, "supervisor-summary.md"), `${summary}\n`);
      await writeFeatureDecision(feature, summary);
      await updateFeatureStatus(feature, "approved");

      return {
        mode: "complex",
        taskId: task.id,
        summary,
        workers
      };
    } catch (error) {
      await this.sessions.updateTaskStatus(task, "failed");
      throw error;
    }
  }

  async handleTaskTurn(input: HandleTaskTurnInput): Promise<HandleRequestResult> {
    const task: TaskSession = this.sessions.taskFromId(input.taskId);
    const route = await this.routeRequest(input.request);
    const turn = await this.sessions.appendTurn(task, {
      request: input.request,
      route
    });
    const workers: WorkerLogRef[] = [];
    const judgeEngine = route.judge_engine;
    const actorEngine = route.actor_engine;
    const criticEngine = route.critic_engine;
    const judge = this.workerFiles(task, `judge-${judgeEngine}`);
    const feature = await createFeatureChannel({
      task,
      turn,
      request: input.request,
      judgeDir: judge.dir
    });

    try {
      await this.sessions.updateTaskStatus(task, "actor_running");
      await updateFeatureStatus(feature, "actor_running");
      input.onStatus?.({ taskId: task.id, judge: "done", actor: "running", critic: "waiting" });
      let actor = await this.runActor(input, task, actorEngine, judge.dir, workers, turn, feature);

      await this.sessions.updateTaskStatus(task, "critic_running");
      await updateFeatureStatus(feature, "critic_running");
      input.onStatus?.({ taskId: task.id, judge: "done", actor: "done", critic: "running" });
      let critic = await this.runCritic(input, task, criticEngine, judge.dir, actor.dir, workers, turn, feature);
      const review = await readTextIfExists(`${critic.dir}/review.md`);

      if (review.includes("REVISION_REQUIRED")) {
        await this.sessions.updateTaskStatus(task, "revision_needed");
        await updateFeatureStatus(feature, "revision_needed");
        await appendFeatureDialogue(feature, "critic.revision_requested", "critic", "Critic requested Actor revision.", {
          review: join(critic.dir, "review.md"),
          findings: feature.criticFindingsPath
        });
        input.onStatus?.({ taskId: task.id, judge: "done", actor: "revision", critic: "done" });
        actor = await this.runActor(
          input,
          task,
          actorEngine,
          judge.dir,
          workers,
          turn,
          feature,
          buildRevisionRequest(review, feature)
        );
        await this.sessions.updateTaskStatus(task, "critic_running");
        await updateFeatureStatus(feature, "critic_running");
        input.onStatus?.({ taskId: task.id, judge: "done", actor: "done", critic: "rerunning" });
        critic = await this.runCritic(input, task, criticEngine, judge.dir, actor.dir, workers, turn, feature);
      }

      await this.sessions.updateTaskStatus(task, "done");
      input.onStatus?.({ taskId: task.id, judge: "done", actor: "done", critic: "done" });
      const summary = await buildSupervisorSummary({
        judgeDir: judge.dir,
        actorDir: actor.dir,
        criticDir: critic.dir,
        turnDir: turn.dir,
        featureActorWorklogPath: feature.actorWorklogPath,
        featureCriticFindingsPath: feature.criticFindingsPath
      });
      await writeText(join(turn.dir, "supervisor-summary.md"), `${summary}\n`);
      await writeFeatureDecision(feature, summary);
      await updateFeatureStatus(feature, "approved");

      return {
        mode: "complex",
        taskId: task.id,
        summary,
        workers
      };
    } catch (error) {
      await this.sessions.updateTaskStatus(task, "failed");
      throw error;
    }
  }

  async routeTaskFollowUp(input: HandleTaskQuestionInput): Promise<TaskFollowUpRouteResult> {
    const route = await this.routeRequest(input.request);

    return {
      mode: route.mode,
      taskId: route.mode === "complex" ? input.taskId : null,
      reason: route.reason
    };
  }

  async answerTaskQuestion(input: HandleTaskQuestionInput): Promise<HandleRequestResult> {
    const task = this.sessions.taskFromId(input.taskId);
    const meta = await readTaskMetaIfValid(task.metaPath);
    const workerSummaries = await Promise.all(
      ["judge", "actor", "critic"].map((role) => this.readLatestWorkerQuestionSummary(task, role as WorkerRole))
    );
    const workers = workerSummaries.filter((worker) => worker !== null);
    const failed = workers.find((worker) => worker.status.state === "failed");
    const latest = failed ?? workers.at(-1);
    const lines = [
      `Task ${task.id}${meta ? ` is ${meta.status}` : ""}.`,
      latest
        ? `${labelWorker(latest.status)}: ${latest.status.state}/${latest.status.phase}: ${latest.status.summary}`
        : "No worker status files found for this task."
    ];

    if (latest?.logTail) {
      lines.push("", "Latest worker log:", latest.logTail);
    }

    return {
      mode: "simple",
      taskId: task.id,
      summary: lines.join("\n"),
      workers: []
    };
  }

  async listTaskWorkers(taskId: string): Promise<WorkerLogRef[]> {
    const task = this.sessions.taskFromId(taskId);
    if (!(await pathExists(task.dir))) {
      return [];
    }

    const entries = await readdir(task.dir, { withFileTypes: true });
    const workers: WorkerLogRef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = join(task.dir, entry.name);
      const statusPath = join(dir, "status.json");
      if (!(await pathExists(statusPath))) {
        continue;
      }
      const status = await readWorkerStatusIfValid(statusPath);
      if (!status) {
        continue;
      }
      workers.push({
        id: status.worker_id,
        role: status.role,
        engine: status.engine,
        label: `${capitalize(status.role)} (${status.engine})`,
        logPath: join(dir, "output.log"),
        statusPath
      });
    }

    return workers.sort((left, right) => workerRoleOrder(left.role) - workerRoleOrder(right.role));
  }

  private routeRequest(request: string) {
    return routeRequestWithCodex(request, this.config, this.routeRunner, this.config.projectRoot);
  }

  private async runMain(input: HandleRequestInput, workers: WorkerLogRef[]): Promise<string> {
    const engine = this.config.pairing.main;
    const dir = this.sessions.mainSessionDir();
    const workerId = `main-${engine}`;
    const filesDir = join(dir, workerId);
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");

    await ensureDir(filesDir);
    await writeText(promptPath, input.request);
    await writeText(outputLogPath, "");
    await writeJson(statusPath, {
      worker_id: workerId,
      role: "main",
      engine,
      state: "idle",
      phase: "initialized",
      last_event_at: new Date().toISOString(),
      summary: "Main chat worker initialized"
    } satisfies WorkerStatus);

    this.recordWorker(input, workers, {
      id: workerId,
      role: "main",
      engine,
      label: `Main (${engine})`,
      logPath: outputLogPath,
      statusPath
    });

    await getAdapter(this.workers, engine).run({
      workerId,
      role: "main",
      engine,
      cwd: input.cwd,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: input.request
    });

    return readTextIfExists(outputLogPath);
  }

  private async runJudge(
    input: HandleRequestInput,
    task: TaskSession,
    engine: EngineName,
    workers: WorkerLogRef[],
    turn: TaskTurn
  ): Promise<WorkerFiles> {
    const workerId = `judge-${engine}`;
    const judgeFiles = this.workerFiles(task, workerId);
    const judge = await this.sessions.initializeWorker(task, {
      workerId,
      role: "judge",
      engine,
      prompt: buildJudgePrompt({
        request: input.request,
        taskDir: task.dir,
        workerDir: judgeFiles.dir,
        turn: this.promptTurnContext(turn),
        role: this.config.roles.judge
      })
    });

    this.recordWorker(input, workers, {
      id: judge.workerId,
      role: "judge",
      engine,
      label: `Judge (${engine})`,
      logPath: judge.outputLogPath,
      statusPath: judge.statusPath
    });

    const result = await this.runWorkerWithNativeSession(engine, {
      workerId: judge.workerId,
      role: "judge",
      engine,
      cwd: input.cwd,
      filesDir: judge.dir,
      promptPath: judge.promptPath,
      outputLogPath: judge.outputLogPath,
      statusPath: judge.statusPath,
      prompt: await readTextIfExists(judge.promptPath)
    });
    ensureWorkerSuccess(result.workerId, result.exitCode);

    return judge;
  }

  private async runActor(
    input: HandleRequestInput,
    task: TaskSession,
    engine: EngineName,
    judgeDir: string,
    workers: WorkerLogRef[],
    turn: TaskTurn,
    feature: FeatureChannel,
    revision?: string
  ): Promise<WorkerFiles> {
    const actor = await this.sessions.initializeWorker(task, {
      workerId: `actor-${engine}`,
      role: "actor",
      engine,
      prompt: buildActorPrompt({
        request: input.request,
        taskDir: task.dir,
        judgeDir,
        turn: this.promptTurnContext(turn),
        feature: featurePromptContext(feature),
        revision,
        role: this.config.roles.actor
      })
    });

    this.recordWorker(input, workers, {
      id: actor.workerId,
      role: "actor",
      engine,
      label: `Actor (${engine})`,
      logPath: actor.outputLogPath,
      statusPath: actor.statusPath
    });

    const result = await this.runWorkerWithNativeSession(engine, {
      workerId: actor.workerId,
      role: "actor",
      engine,
      cwd: input.cwd,
      filesDir: actor.dir,
      promptPath: actor.promptPath,
      outputLogPath: actor.outputLogPath,
      statusPath: actor.statusPath,
      prompt: await readTextIfExists(actor.promptPath)
    });
    ensureWorkerSuccess(result.workerId, result.exitCode);
    await mirrorWorkerFileToFeature(join(actor.dir, "worklog.md"), feature.actorWorklogPath);
    await appendFeatureDialogue(feature, "actor.completed", "actor", "Actor completed feature work.", {
      worklog: actor.outputLogPath,
      feature_worklog: feature.actorWorklogPath,
      replies: feature.actorRepliesPath
    });

    return actor;
  }

  private async runCritic(
    input: HandleRequestInput,
    task: TaskSession,
    engine: EngineName,
    judgeDir: string,
    actorDir: string,
    workers: WorkerLogRef[],
    turn: TaskTurn,
    feature: FeatureChannel
  ): Promise<WorkerFiles> {
    const critic = await this.sessions.initializeWorker(task, {
      workerId: `critic-${engine}`,
      role: "critic",
      engine,
      prompt: buildCriticPrompt({
        request: input.request,
        taskDir: task.dir,
        judgeDir,
        actorDir,
        turn: this.promptTurnContext(turn),
        feature: featurePromptContext(feature),
        role: this.config.roles.critic
      })
    });

    this.recordWorker(input, workers, {
      id: critic.workerId,
      role: "critic",
      engine,
      label: `Critic (${engine})`,
      logPath: critic.outputLogPath,
      statusPath: critic.statusPath
    });

    const result = await this.runWorkerWithNativeSession(engine, {
      workerId: critic.workerId,
      role: "critic",
      engine,
      cwd: input.cwd,
      filesDir: critic.dir,
      promptPath: critic.promptPath,
      outputLogPath: critic.outputLogPath,
      statusPath: critic.statusPath,
      prompt: await readTextIfExists(critic.promptPath)
    });
    ensureWorkerSuccess(result.workerId, result.exitCode);
    await appendFeatureDialogue(feature, "critic.completed", "critic", "Critic completed feature review.", {
      review: join(critic.dir, "review.md"),
      findings: feature.criticFindingsPath
    });

    return critic;
  }

  private recordWorker(input: HandleRequestInput, workers: WorkerLogRef[], worker: WorkerLogRef): void {
    const existingIndex = workers.findIndex((item) => item.id === worker.id);
    if (existingIndex >= 0) {
      workers[existingIndex] = worker;
    } else {
      workers.push(worker);
    }
    input.onWorker?.(worker);
  }

  private async runWorkerWithNativeSession(engine: EngineName, spec: WorkerRunSpec): Promise<WorkerResult> {
    const adapter = getAdapter(this.workers, engine);
    const workerFiles: WorkerFiles = {
      workerId: spec.workerId,
      dir: spec.filesDir,
      promptPath: spec.promptPath,
      outputLogPath: spec.outputLogPath,
      statusPath: spec.statusPath
    };
    const existing = await this.sessions.readNativeSession(workerFiles);
    if (existing) {
      await this.sessions.writeNativeSession(workerFiles, {
        ...existing,
        last_used_at: new Date().toISOString()
      });
    }

    return adapter.run({
      ...spec,
      nativeSession: existing,
      nativeSessionConfig: this.config.workers[engine].nativeSession,
      onNativeSession: async (sessionId) => {
        const now = new Date().toISOString();
        const previous = await this.sessions.readNativeSession(workerFiles);
        const record: NativeSession = {
          engine,
          role: spec.role,
          worker_id: spec.workerId,
          session_id: sessionId,
          scope: "task",
          cwd: spec.cwd,
          created_at: previous?.created_at ?? now,
          last_used_at: now,
          source: previous?.source ?? "output-detected"
        };
        await this.sessions.writeNativeSession(workerFiles, record);
      },
      onNativeSessionRetired: async (_sessionId, reason) => {
        await this.sessions.retireNativeSession(workerFiles, summarizeRetirementReason(reason));
      }
    });
  }

  private workerFiles(task: TaskSession, workerId: string): WorkerFiles {
    const dir = join(task.dir, workerId);
    return {
      workerId,
      dir,
      promptPath: join(dir, "prompt.md"),
      outputLogPath: join(dir, "output.log"),
      statusPath: join(dir, "status.json")
    };
  }

  private promptTurnContext(turn: TaskTurn) {
    return {
      turnId: turn.turnId,
      turnDir: turn.dir,
      previousSummaries: []
    };
  }

  private async readLatestWorkerQuestionSummary(
    task: TaskSession,
    role: WorkerRole
  ): Promise<{ status: WorkerStatus; logTail: string } | null> {
    for (const engine of ["codex", "claude", "mock"] as EngineName[]) {
      const files = this.workerFiles(task, `${role}-${engine}`);
      if (!(await pathExists(files.statusPath))) {
        continue;
      }
      const status = await readWorkerStatusIfValid(files.statusPath);
      if (!status) {
        continue;
      }
      return {
        status,
        logTail: tailText(await readTextIfExists(files.outputLogPath), 8)
      };
    }
    return null;
  }
}

function ensureWorkerSuccess(workerId: string, exitCode: number): void {
  if (exitCode !== 0) {
    throw new Error(`${workerId} failed with exit code ${exitCode}`);
  }
}

async function readWorkerStatusIfValid(statusPath: string): Promise<WorkerStatus | null> {
  try {
    return await readJson(statusPath, WorkerStatusSchema);
  } catch {
    return null;
  }
}

async function readTaskMetaIfValid(metaPath: string) {
  if (!(await pathExists(metaPath))) {
    return null;
  }

  try {
    return await readJson(metaPath, TaskMetaSchema);
  } catch {
    return null;
  }
}

function summarizeRetirementReason(reason: string): string {
  const lines = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const contextLine = lines.find((line) => /context window|ran out of room|clear earlier history|start a new thread/i.test(line));
  const summary = contextLine ?? lines.at(-1) ?? "Native session retired";
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function buildRevisionRequest(review: string, feature: FeatureChannel): string {
  return [
    review.trim(),
    "",
    "Feature mailbox:",
    `- Critic findings: ${feature.criticFindingsPath}`,
    `- Actor replies: ${feature.actorRepliesPath}`,
    "Reply to each fixed finding in actor-replies.jsonl."
  ].join("\n");
}

async function mirrorWorkerFileToFeature(sourcePath: string, targetPath: string): Promise<void> {
  const content = await readTextIfExists(sourcePath);
  if (content.trim()) {
    await writeText(targetPath, content);
  }
}

function extractMainResponse(outputLog: string): string {
  return outputLog
    .split("\n")
    .filter((line) => !line.startsWith("$ "))
    .filter((line) => !line.startsWith("[mock:main]"))
    .join("\n")
    .trim();
}

function emptyMainResponseSummary(): string {
  return "简单对话通道没有收到可显示回复。";
}

function labelWorker(status: WorkerStatus): string {
  return `${capitalize(status.role)} (${status.engine})`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function workerRoleOrder(role: WorkerRole): number {
  return ["main", "judge", "actor", "critic"].indexOf(role);
}

function tailText(text: string, lines: number): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n")
    .trim();
}
