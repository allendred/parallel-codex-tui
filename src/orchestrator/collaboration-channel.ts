import { join } from "node:path";
import { z } from "zod";
import { appendJsonLine, ensureDir, pathExists, readJson, readTextIfExists, writeJson, writeText } from "../core/file-store.js";
import type { TaskSession, TaskTurn } from "../core/session-manager.js";
import {
  FeatureAssignmentSchema,
  FeatureStatusSchema,
  type EngineName,
  type FeatureAssignment,
  type FeatureState,
  type FeatureStatus,
  type WorkerRole
} from "../domain/schemas.js";
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
  findingResolutionPath: string;
  decisionsPath: string;
  assignmentPath: string;
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
  assignmentPath: string;
}

export interface CreateFeatureChannelInput {
  task: TaskSession;
  turn: TaskTurn;
  request: string;
  judgeDir: string;
  feature?: FeatureDefinition;
  resume?: boolean;
  refreshDefinition?: boolean;
  actorEngine?: EngineName;
  criticEngine?: EngineName;
  actorModel?: string;
  criticModel?: string;
}

export interface CriticFindingRecord {
  id: string;
  severity?: string;
  summary: string;
}

export interface ActorFindingReplyRecord {
  finding_id: string;
  status: "fixed" | "not_fixed" | "deferred";
  notes?: string;
}

const CriticFindingRecordSchema = z.object({
  id: z.string().trim().min(1),
  severity: z.string().trim().optional(),
  summary: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1).optional()
}).passthrough().superRefine((record, context) => {
  if (!record.summary && !record.message) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "summary or legacy message is required"
    });
  }
}).transform((record) => ({
  ...record,
  summary: record.summary ?? record.message ?? ""
}));

const ActorFindingReplyRecordSchema = z.object({
  finding_id: z.string().trim().min(1),
  status: z.string().trim().toLowerCase().pipe(z.enum(["fixed", "not_fixed", "deferred"])).default("fixed"),
  notes: z.string().trim().optional()
}).passthrough();

const ApprovedFindingResolutionSchema = z.object({
  version: z.literal(1),
  decision: z.literal("approved"),
  finding_ids: z.array(z.string().min(1)),
  fixed_ids: z.array(z.string().min(1)),
  unresolved_ids: z.array(z.string().min(1)).length(0)
});

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
    findingResolutionPath: join(dir, "finding-resolution.json"),
    decisionsPath: join(dir, "decisions.md"),
    assignmentPath: join(dir, "assignment.json")
  };

  await ensureDir(dir);
  await ensureDir(join(input.task.dir, "dialogue"));
  if (input.resume) {
    await ensureFeatureChannelFiles(input, channel, input.refreshDefinition ?? false);
    const repairedState = await repairFeatureStatus(channel);
    if (repairedState) {
      await appendFeatureDialogue(
        channel,
        "feature.status_recovered",
        "actor",
        `Recovered Feature status as ${repairedState} while preserving collaboration evidence.`
      );
    }
    return channel;
  }

  await writeText(channel.specPath, buildFeatureSpec(input, channel));
  await writeText(channel.actorWorklogPath, "");
  await writeText(channel.actorRepliesPath, "");
  await writeText(channel.criticFindingsPath, "");
  if (input.actorEngine && input.criticEngine) {
    await writeFeatureAssignment(
      channel,
      input.actorEngine,
      input.criticEngine,
      input.actorModel,
      input.criticModel
    );
  }
  await updateFeatureStatus(channel, "created");
  await appendFeatureDialogue(channel, "feature.created", "actor", "Feature mailbox created for the current turn.");

  return channel;
}

async function ensureFeatureChannelFiles(
  input: CreateFeatureChannelInput,
  channel: FeatureChannel,
  refreshDefinition: boolean
): Promise<void> {
  const files: Array<[string, string]> = [
    [channel.specPath, buildFeatureSpec(input, channel)],
    [channel.actorWorklogPath, ""],
    [channel.actorRepliesPath, ""],
    [channel.criticFindingsPath, ""]
  ];
  for (const [path, initialContent] of files) {
    if ((refreshDefinition && path === channel.specPath) || !(await pathExists(path))) {
      await writeText(path, initialContent);
    }
  }
  if (!(await pathExists(channel.assignmentPath)) && input.actorEngine && input.criticEngine) {
    await writeFeatureAssignment(
      channel,
      input.actorEngine,
      input.criticEngine,
      input.actorModel,
      input.criticModel
    );
  }
}

export async function readFeatureAssignment(
  channel: Pick<FeatureChannel, "assignmentPath">,
  fallback: { actor: EngineName; critic: EngineName }
): Promise<FeatureAssignment> {
  try {
    return await readJson(channel.assignmentPath, FeatureAssignmentSchema);
  } catch {
    return FeatureAssignmentSchema.parse({
      version: 1,
      actor_engine: fallback.actor,
      critic_engine: fallback.critic,
      actor_model: "",
      critic_model: "",
      actor_override: false,
      critic_override: false,
      updated_at: new Date(0).toISOString()
    });
  }
}

export async function writeFeatureAssignment(
  channel: Pick<FeatureChannel, "assignmentPath">,
  actorEngine: EngineName,
  criticEngine: EngineName,
  actorModel = "",
  criticModel = "",
  options: { actorOverride?: boolean; criticOverride?: boolean } = {}
): Promise<FeatureAssignment> {
  const assignment = FeatureAssignmentSchema.parse({
    version: 1,
    actor_engine: actorEngine,
    critic_engine: criticEngine,
    actor_model: actorModel,
    critic_model: criticModel,
    actor_override: options.actorOverride ?? false,
    critic_override: options.criticOverride ?? false,
    updated_at: new Date().toISOString()
  });
  await writeJson(channel.assignmentPath, assignment);
  return assignment;
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
    decisionsPath: channel.decisionsPath,
    assignmentPath: channel.assignmentPath
  };
}

export async function updateFeatureStatus(channel: FeatureChannel, state: FeatureState): Promise<void> {
  if (await pathExists(channel.statusPath)) {
    try {
      const current = await readJson(channel.statusPath, FeatureStatusSchema);
      if (current.state === state && featureStatusMatchesChannel(current, channel)) {
        return;
      }
    } catch {
      // A corrupt status is rebuilt from the authoritative feature channel.
    }
  }
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

async function repairFeatureStatus(channel: FeatureChannel): Promise<FeatureState | null> {
  let current: FeatureStatus | null = null;
  if (await pathExists(channel.statusPath)) {
    try {
      current = await readJson(channel.statusPath, FeatureStatusSchema);
    } catch {
      // Invalid status is rebuilt without replacing the collaboration mailbox.
    }
  }
  if (current && featureStatusMatchesChannel(current, channel)) {
    return null;
  }

  const state = current && featureStatusIdentityMatches(current, channel)
    ? current.state
    : "created";
  await updateFeatureStatus(channel, state);
  return state;
}

function featureStatusMatchesChannel(status: FeatureStatus, channel: FeatureChannel): boolean {
  return featureStatusIdentityMatches(status, channel)
    && status.title === channel.title
    && status.description === channel.description
    && status.depends_on.length === channel.dependsOn.length
    && status.depends_on.every((dependency, index) => dependency === channel.dependsOn[index]);
}

function featureStatusIdentityMatches(status: FeatureStatus, channel: FeatureChannel): boolean {
  return status.feature_id === channel.id
    && status.task_id === channel.taskId
    && status.turn_id === channel.turnId;
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

export async function requireFeatureRevisionFindings(channel: FeatureChannel): Promise<string[]> {
  const findings = await readFeatureCriticFindings(channel);
  if (findings.length === 0) {
    throw new Error(`Critic requested revision without valid critic findings for ${channel.id}.`);
  }
  const findingIds = findings.map((finding) => finding.id);
  const replies = await readFeatureActorReplies(channel);
  await writeFindingResolutionSnapshot(channel, "pending", findingIds, replies);
  return findingIds;
}

export async function requireActorFindingReplies(
  channel: FeatureChannel,
  findingIds: readonly string[]
): Promise<void> {
  const replies = await readFeatureActorReplies(channel);
  const resolution = await writeFindingResolutionSnapshot(channel, "pending", findingIds, replies);
  const unknown = resolution.unknownReplyIds;
  if (unknown.length > 0) {
    throw new Error(`Actor replies reference unknown Critic findings: ${unknown.join(", ")}.`);
  }
  const unresolved = resolution.unresolvedIds;
  if (unresolved.length > 0) {
    throw new Error(`Actor revision did not mark every Critic finding fixed: ${unresolved.join(", ")}.`);
  }
}

export async function recordApprovedFindingResolution(
  channel: FeatureChannel,
  revisionFindingIds: readonly string[] = [],
  options: { allowLegacyResolvedFindings?: boolean } = {}
): Promise<void> {
  const findings = await readFeatureCriticFindings(channel);
  const currentIds = [...new Set(findings.map((finding) => finding.id))];
  const replies = await readFeatureActorReplies(channel);
  const latestReplies = new Map(replies.map((reply) => [reply.finding_id, reply]));
  const expectedIds = revisionFindingIds.length > 0
    ? [...new Set(revisionFindingIds)]
    : options.allowLegacyResolvedFindings
      ? currentIds.filter((id) => latestReplies.get(id)?.status === "fixed")
      : [];
  const unexpected = currentIds.filter((id) => !expectedIds.includes(id));
  if (unexpected.length > 0) {
    await writeFindingResolutionRecord(channel, {
      decision: "inconsistent",
      findingIds: currentIds,
      fixedIds: [],
      unresolvedIds: currentIds,
      unknownReplyIds: [...new Set(replies.map((reply) => reply.finding_id))]
        .filter((id) => !currentIds.includes(id)),
      replyCount: replies.length
    });
    throw new Error(`Critic approved with unresolved blocking findings: ${unexpected.join(", ")}.`);
  }
  await requireActorFindingReplies(channel, expectedIds);
  await writeFindingResolutionRecord(channel, {
    decision: "approved",
    findingIds: expectedIds,
    fixedIds: expectedIds,
    unresolvedIds: [],
    unknownReplyIds: [],
    replyCount: replies.length
  });
}

export async function featureCriticCheckpointIsReusable(
  channel: FeatureChannel,
  decision: "approved" | "revision"
): Promise<boolean> {
  try {
    if (decision === "revision") {
      return (await readFeatureCriticFindings(channel)).length > 0;
    }
    const resolutionText = await readTextIfExists(channel.findingResolutionPath);
    if (resolutionText.trim()) {
      return ApprovedFindingResolutionSchema.safeParse(JSON.parse(resolutionText)).success;
    }
    const findings = await readFeatureCriticFindings(channel);
    const replies = await readFeatureActorReplies(channel);
    if (findings.length === 0) {
      return replies.length === 0;
    }
    const findingIds = new Set(findings.map((finding) => finding.id));
    const latestReplies = new Map(replies.map((reply) => [reply.finding_id, reply]));
    return [...latestReplies.keys()].every((id) => findingIds.has(id))
      && [...findingIds].every((id) => latestReplies.get(id)?.status === "fixed");
  } catch {
    return false;
  }
}

async function readFeatureCriticFindings(channel: FeatureChannel): Promise<CriticFindingRecord[]> {
  return readMailboxJsonLines(channel.criticFindingsPath, CriticFindingRecordSchema, "Critic finding");
}

async function readFeatureActorReplies(channel: FeatureChannel): Promise<ActorFindingReplyRecord[]> {
  return readMailboxJsonLines(channel.actorRepliesPath, ActorFindingReplyRecordSchema, "Actor finding reply");
}

async function writeFindingResolutionSnapshot(
  channel: FeatureChannel,
  decision: "pending" | "inconsistent",
  findingIds: readonly string[],
  replies: ActorFindingReplyRecord[]
): Promise<{ fixedIds: string[]; unresolvedIds: string[]; unknownReplyIds: string[] }> {
  const ids = [...new Set(findingIds)];
  const expected = new Set(ids);
  const latest = new Map(replies.map((reply) => [reply.finding_id, reply]));
  const fixedIds = ids.filter((id) => latest.get(id)?.status === "fixed");
  const unresolvedIds = ids.filter((id) => latest.get(id)?.status !== "fixed");
  const unknownReplyIds = [...latest.keys()].filter((id) => !expected.has(id));
  await writeFindingResolutionRecord(channel, {
    decision,
    findingIds: ids,
    fixedIds,
    unresolvedIds,
    unknownReplyIds,
    replyCount: replies.length
  });
  return { fixedIds, unresolvedIds, unknownReplyIds };
}

async function writeFindingResolutionRecord(
  channel: FeatureChannel,
  input: {
    decision: "pending" | "approved" | "inconsistent";
    findingIds: string[];
    fixedIds: string[];
    unresolvedIds: string[];
    unknownReplyIds: string[];
    replyCount: number;
  }
): Promise<void> {
  await writeJson(channel.findingResolutionPath, {
    version: 1,
    decision: input.decision,
    finding_ids: input.findingIds,
    fixed_ids: input.fixedIds,
    unresolved_ids: [
      ...input.unresolvedIds,
      ...input.unknownReplyIds.map((id) => `unknown:${id}`)
    ],
    unknown_reply_ids: input.unknownReplyIds,
    reply_count: input.replyCount,
    updated_at: new Date().toISOString()
  });
}

async function readMailboxJsonLines<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  label: string
): Promise<Array<z.output<TSchema>>> {
  const records: Array<z.output<TSchema>> = [];
  const lines = (await readTextIfExists(path)).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${label} JSONL is invalid at line ${index + 1}: ${path}.`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.length ? ` field ${issue.path.join(".")}` : "";
      throw new Error(`${label}${field} is invalid at line ${index + 1}: ${path}.`);
    }
    records.push(result.data);
  }
  return records;
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
    '- Critic writes one JSON object per blocking issue to critic-findings.jsonl: {"id":"C-001","severity":"blocker","summary":"what must change"}.',
    '- Actor replies to each fixed finding in actor-replies.jsonl: {"finding_id":"C-001","status":"fixed","notes":"what changed"}.',
    "- Supervisor writes the final decision summary to decisions.md.",
    "- assignment.json records the Actor and Critic engines selected for retries.",
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
