import { join } from "node:path";
import { appendJsonLine, ensureDir, pathExists, writeJson, writeText } from "../core/file-store.js";
import type { TaskSession, TaskTurn } from "../core/session-manager.js";
import type { FeatureState, WorkerRole } from "../domain/schemas.js";
import type { FeatureDefinition } from "./feature-plan.js";

export interface FeatureChannel {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
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
  featureTitle: string;
  featureDescription: string;
  featureSpecPath: string;
  featureDependencies: string[];
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
  feature?: FeatureDefinition;
  resume?: boolean;
}

export async function createFeatureChannel(input: CreateFeatureChannelInput): Promise<FeatureChannel> {
  const id = input.feature
    ? `${input.turn.turnId}-${input.feature.id}`
    : featureIdForTurn(input.turn, input.request);
  const dir = join(input.task.dir, "features", id);
  const dialoguePath = join(input.task.dir, "dialogue", "actor-critic.jsonl");
  const channel: FeatureChannel = {
    id,
    title: input.feature?.title ?? input.request.trim(),
    description: input.feature?.description ?? input.request.trim(),
    dependsOn: input.feature?.depends_on ?? [],
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
  if (input.resume && await pathExists(channel.statusPath)) {
    await ensureFeatureChannelFiles(input, channel);
    return channel;
  }

  await writeText(channel.specPath, buildFeatureSpec(input, channel));
  await writeText(channel.actorWorklogPath, "");
  await writeText(channel.actorRepliesPath, "");
  await writeText(channel.criticFindingsPath, "");
  await updateFeatureStatus(channel, "created");
  await appendFeatureDialogue(channel, "feature.created", "actor", "Feature mailbox created for the current turn.");

  return channel;
}

async function ensureFeatureChannelFiles(input: CreateFeatureChannelInput, channel: FeatureChannel): Promise<void> {
  const files: Array<[string, string]> = [
    [channel.specPath, buildFeatureSpec(input, channel)],
    [channel.actorWorklogPath, ""],
    [channel.actorRepliesPath, ""],
    [channel.criticFindingsPath, ""]
  ];
  for (const [path, initialContent] of files) {
    if (!(await pathExists(path))) {
      await writeText(path, initialContent);
    }
  }
}

export function featurePromptContext(channel: FeatureChannel): FeaturePromptContext {
  return {
    featureId: channel.id,
    featureTitle: channel.title,
    featureDescription: channel.description,
    featureSpecPath: channel.specPath,
    featureDependencies: channel.dependsOn,
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
    title: channel.title,
    description: channel.description,
    depends_on: channel.dependsOn,
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
    `Title: ${channel.title}`,
    `Description: ${channel.description}`,
    `Depends on: ${channel.dependsOn.length > 0 ? channel.dependsOn.join(", ") : "(none)"}`,
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
