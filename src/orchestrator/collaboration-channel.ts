import { join } from "node:path";
import { appendJsonLine, ensureDir, writeJson, writeText } from "../core/file-store.js";
import type { TaskSession, TaskTurn } from "../core/session-manager.js";
import type { WorkerRole } from "../domain/schemas.js";

export type FeatureState =
  | "created"
  | "actor_running"
  | "critic_running"
  | "revision_needed"
  | "approved"
  | "failed"
  | "cancelled";

export interface FeatureChannel {
  id: string;
  taskId: string;
  turnId: string;
  dir: string;
  specPath: string;
  statusPath: string;
  dialoguePath: string;
  actorWorklogPath: string;
  actorRepliesPath: string;
  criticFindingsPath: string;
  decisionsPath: string;
}

export interface FeaturePromptContext {
  featureId: string;
  featureDir: string;
  dialoguePath: string;
  actorWorklogPath: string;
  actorRepliesPath: string;
  criticFindingsPath: string;
  decisionsPath: string;
}

export interface CreateFeatureChannelInput {
  task: TaskSession;
  turn: TaskTurn;
  request: string;
  judgeDir: string;
}

export async function createFeatureChannel(input: CreateFeatureChannelInput): Promise<FeatureChannel> {
  const id = featureIdForTurn(input.turn, input.request);
  const dir = join(input.task.dir, "features", id);
  const dialoguePath = join(input.task.dir, "dialogue", "actor-critic.jsonl");
  const channel: FeatureChannel = {
    id,
    taskId: input.task.id,
    turnId: input.turn.turnId,
    dir,
    specPath: join(dir, "spec.md"),
    statusPath: join(dir, "status.json"),
    dialoguePath,
    actorWorklogPath: join(dir, "actor-worklog.md"),
    actorRepliesPath: join(dir, "actor-replies.jsonl"),
    criticFindingsPath: join(dir, "critic-findings.jsonl"),
    decisionsPath: join(dir, "decisions.md")
  };

  await ensureDir(dir);
  await ensureDir(join(input.task.dir, "dialogue"));
  await writeText(channel.specPath, buildFeatureSpec(input, channel));
  await writeText(channel.actorWorklogPath, "");
  await writeText(channel.actorRepliesPath, "");
  await writeText(channel.criticFindingsPath, "");
  await updateFeatureStatus(channel, "created");
  await appendFeatureDialogue(channel, "feature.created", "actor", "Feature mailbox created for the current turn.");

  return channel;
}

export function featurePromptContext(channel: FeatureChannel): FeaturePromptContext {
  return {
    featureId: channel.id,
    featureDir: channel.dir,
    dialoguePath: channel.dialoguePath,
    actorWorklogPath: channel.actorWorklogPath,
    actorRepliesPath: channel.actorRepliesPath,
    criticFindingsPath: channel.criticFindingsPath,
    decisionsPath: channel.decisionsPath
  };
}

export async function updateFeatureStatus(channel: FeatureChannel, state: FeatureState): Promise<void> {
  await writeJson(channel.statusPath, {
    feature_id: channel.id,
    task_id: channel.taskId,
    turn_id: channel.turnId,
    state,
    updated_at: new Date().toISOString()
  });
}

export async function appendFeatureDialogue(
  channel: FeatureChannel,
  type: string,
  role: WorkerRole,
  message: string,
  paths: Record<string, string> = {}
): Promise<void> {
  await appendJsonLine(channel.dialoguePath, {
    time: new Date().toISOString(),
    feature_id: channel.id,
    turn_id: channel.turnId,
    type,
    role,
    message,
    paths
  });
}

export async function writeFeatureDecision(channel: FeatureChannel, summary: string): Promise<void> {
  await writeText(
    channel.decisionsPath,
    [
      "# Decisions",
      "",
      `Feature: ${channel.id}`,
      `Turn: ${channel.turnId}`,
      "",
      "Supervisor summary:",
      summary.trim() || "(empty)",
      ""
    ].join("\n")
  );
}

function buildFeatureSpec(input: CreateFeatureChannelInput, channel: FeatureChannel): string {
  return [
    "# Feature Mailbox",
    "",
    `Feature: ${channel.id}`,
    `Task: ${input.task.id}`,
    `Turn: ${input.turn.turnId}`,
    `Turn directory: ${input.turn.dir}`,
    `Judge directory: ${input.judgeDir}`,
    "",
    "User request:",
    input.request.trim(),
    "",
    "Protocol:",
    "- Actor writes implementation notes to actor-worklog.md.",
    "- Critic writes one JSON object per blocking issue to critic-findings.jsonl.",
    "- Actor replies to each critic finding in actor-replies.jsonl.",
    "- Supervisor writes the final decision summary to decisions.md.",
    ""
  ].join("\n");
}

function featureIdForTurn(turn: TaskTurn, request: string): string {
  const slug = request
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug ? `${turn.turnId}-${slug}` : turn.turnId;
}
