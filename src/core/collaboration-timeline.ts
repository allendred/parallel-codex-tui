import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  EventRecordSchema,
  FeatureAssignmentSchema,
  FeatureStatusSchema,
  type EngineName,
  type FeatureState
} from "../domain/schemas.js";
import { readTextIfExists } from "./file-store.js";

const FeatureDialogueSchema = z.object({
  time: z.string().datetime(),
  feature_id: z.string().min(1),
  turn_id: z.string().min(1),
  type: z.string().min(1),
  role: z.enum(["actor", "critic"]),
  message: z.string().default(""),
  paths: z.record(z.string()).default({})
});

const FindingResolutionSchema = z.object({
  version: z.literal(1),
  decision: z.enum(["pending", "approved", "inconsistent"]),
  fixed_ids: z.array(z.string().min(1)),
  unresolved_ids: z.array(z.string().min(1))
});

export type CollaborationFeatureState = FeatureState;
export type CollaborationRole = "actor" | "critic" | "supervisor";

export interface CollaborationArtifactRef {
  label: string;
  path: string;
}

export interface CollaborationFeature {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  turnId: string;
  state: CollaborationFeatureState;
  updatedAt: string;
  actorEngine?: EngineName;
  criticEngine?: EngineName;
  findings: number;
  replies: number;
  resolvedFindings?: number;
  unresolvedFindings?: number;
  latestFinding?: string;
  latestReply?: string;
  artifactRefs: CollaborationArtifactRef[];
}

export interface CollaborationEvent {
  id: string;
  time: string;
  type: string;
  role: CollaborationRole;
  action: string;
  message: string;
  turnId?: string;
  featureId?: string;
  featureTitle?: string;
  findings?: number;
  replies?: number;
  resolvedFindings?: number;
  unresolvedFindings?: number;
  artifacts: string[];
  artifactRefs: CollaborationArtifactRef[];
}

export interface CollaborationTimeline {
  taskId: string;
  features: CollaborationFeature[];
  events: CollaborationEvent[];
}

export async function loadCollaborationTimeline(taskId: string, taskDir: string): Promise<CollaborationTimeline> {
  const [features, dialogueText, taskEventsText] = await Promise.all([
    readCollaborationFeatures(taskDir),
    readTextIfExists(join(taskDir, "dialogue", "actor-critic.jsonl")),
    readTextIfExists(join(taskDir, "events.jsonl"))
  ]);
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const dialogue = parseJsonLines(dialogueText, FeatureDialogueSchema);
  const taskEvents = parseJsonLines(taskEventsText, EventRecordSchema)
    .filter((event) => event.type.startsWith("feature.wave_"));
  const events: CollaborationEvent[] = [
    ...dialogue.map((event, index): CollaborationEvent => {
      const feature = featureById.get(event.feature_id);
      const artifactRefs = collaborationArtifactRefs(event.paths ?? {});
      return {
        id: `dialogue-${index}-${event.time}`,
        time: event.time,
        type: event.type,
        role: event.role,
        action: collaborationDialogueAction(event.type),
        message: event.type === "critic.revision_requested" && feature?.latestFinding
          ? appendCollaborationEvidence(event.message ?? "", feature.latestFinding)
          : event.message ?? "",
        turnId: event.turn_id,
        featureId: event.feature_id,
        featureTitle: feature?.title ?? event.feature_id,
        findings: feature?.findings ?? 0,
        replies: feature?.replies ?? 0,
        ...(typeof feature?.resolvedFindings === "number"
          ? { resolvedFindings: feature.resolvedFindings }
          : {}),
        ...(typeof feature?.unresolvedFindings === "number"
          ? { unresolvedFindings: feature.unresolvedFindings }
          : {}),
        artifacts: artifactRefs.map((artifact) => artifact.label),
        artifactRefs
      };
    }),
    ...taskEvents.map((event, index): CollaborationEvent => ({
      id: `task-${index}-${event.time}`,
      time: event.time,
      type: event.type,
      role: "supervisor",
      action: collaborationWaveAction(event.type),
      message: event.message ?? "",
      artifacts: ["task events"],
      artifactRefs: [{ label: "task events", path: join(taskDir, "events.jsonl") }]
    })),
    ...features.map((feature): CollaborationEvent => ({
      id: `state-${feature.id}-${feature.updatedAt}`,
      time: feature.updatedAt,
      type: "feature.state",
      role: "supervisor",
      action: collaborationFeatureStateAction(feature.state),
      message: [
        `${feature.title} · ${humanizeFeatureState(feature.state)}`,
        ...(feature.latestFinding ? [`finding: ${feature.latestFinding}`] : []),
        ...(feature.latestReply ? [`reply: ${feature.latestReply}`] : [])
      ].join(" · "),
      turnId: feature.turnId,
      featureId: feature.id,
      featureTitle: feature.title,
      findings: feature.findings,
      replies: feature.replies,
      ...(typeof feature.resolvedFindings === "number"
        ? { resolvedFindings: feature.resolvedFindings }
        : {}),
      ...(typeof feature.unresolvedFindings === "number"
        ? { unresolvedFindings: feature.unresolvedFindings }
        : {}),
      artifacts: feature.artifactRefs.map((artifact) => artifact.label),
      artifactRefs: feature.artifactRefs
    }))
  ].sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id));

  return { taskId, features, events };
}

async function readCollaborationFeatures(taskDir: string): Promise<CollaborationFeature[]> {
  const root = join(taskDir, "features");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const features = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<CollaborationFeature | null> => {
      const dir = join(root, entry.name);
      const [statusText, assignmentText, spec, findings, replies, resolutionText] = await Promise.all([
        readTextIfExists(join(dir, "status.json")),
        readTextIfExists(join(dir, "assignment.json")),
        readTextIfExists(join(dir, "spec.md")),
        readTextIfExists(join(dir, "critic-findings.jsonl")),
        readTextIfExists(join(dir, "actor-replies.jsonl")),
        readTextIfExists(join(dir, "finding-resolution.json"))
      ]);
      const status = parseJsonValue(statusText, FeatureStatusSchema);
      if (!status) {
        return null;
      }
      const findingEvidence = readMailboxEvidence(findings);
      const replyEvidence = readMailboxEvidence(replies);
      const resolution = parseJsonValue(resolutionText, FindingResolutionSchema);
      const assignment = parseJsonValue(assignmentText, FeatureAssignmentSchema);
      return {
        id: status.feature_id,
        title: status.title?.trim() || featureSpecTitle(spec) || status.feature_id,
        description: status.description?.trim() ?? "",
        dependsOn: status.depends_on ?? [],
        turnId: status.turn_id,
        state: status.state,
        updatedAt: status.updated_at,
        ...(assignment ? {
          actorEngine: assignment.actor_engine,
          criticEngine: assignment.critic_engine
        } : {}),
        findings: findingEvidence.count,
        replies: replyEvidence.count,
        artifactRefs: [
          { label: "status", path: join(dir, "status.json") },
          { label: "spec", path: join(dir, "spec.md") },
          ...(assignment ? [{ label: "assignment", path: join(dir, "assignment.json") }] : []),
          { label: "critic findings", path: join(dir, "critic-findings.jsonl") },
          { label: "actor replies", path: join(dir, "actor-replies.jsonl") },
          ...(resolution ? [{ label: "finding resolution", path: join(dir, "finding-resolution.json") }] : [])
        ],
        ...(resolution
          ? {
              resolvedFindings: new Set(resolution.fixed_ids).size,
              unresolvedFindings: new Set(resolution.unresolved_ids).size
            }
          : {}),
        ...(findingEvidence.latest ? { latestFinding: findingEvidence.latest } : {}),
        ...(replyEvidence.latest ? { latestReply: replyEvidence.latest } : {})
      };
    }));
  return features
    .filter((feature): feature is CollaborationFeature => feature !== null)
    .sort((left, right) => left.turnId.localeCompare(right.turnId) || left.id.localeCompare(right.id));
}

function collaborationArtifactRefs(paths: Record<string, string>): CollaborationArtifactRef[] {
  return Object.entries(paths)
    .map(([label, path]) => ({ label: label.trim(), path: path.trim() }))
    .filter((artifact) => artifact.label && artifact.path)
    .sort((left, right) => left.label.localeCompare(right.label) || left.path.localeCompare(right.path));
}

function parseJsonLines<T>(text: string, schema: z.ZodType<T>): T[] {
  const records: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) {
        records.push(parsed.data);
      }
    } catch {
      // A partial mailbox write must not hide earlier collaboration evidence.
    }
  }
  return records;
}

function parseJsonValue<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readMailboxEvidence(text: string): { count: number; latest: string | null } {
  let count = 0;
  let latest: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        count += 1;
        latest = mailboxRecordSummary(value as Record<string, unknown>) || latest;
      }
    } catch {
      // Ignore partial or malformed mailbox rows.
    }
  }
  return { count, latest };
}

function mailboxRecordSummary(value: Record<string, unknown>): string {
  for (const key of ["message", "summary", "notes", "resolution", "title", "description", "issue", "status"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) {
      return field.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function appendCollaborationEvidence(message: string, evidence: string): string {
  const base = message.trim();
  if (!base || base.includes(evidence)) {
    return base || evidence;
  }
  return `${base} · ${evidence}`;
}

function featureSpecTitle(spec: string): string | null {
  const title = spec.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  return title || null;
}

function collaborationDialogueAction(type: string): string {
  if (type === "feature.created") {
    return "mailbox created";
  }
  if (type === "actor.completed") {
    return "implementation completed";
  }
  if (type === "critic.completed") {
    return "review completed";
  }
  if (type === "critic.revision_requested") {
    return "revision requested";
  }
  return humanizeCollaborationType(type);
}

function collaborationWaveAction(type: string): string {
  const action = type.replace(/^feature\.wave_/, "wave ");
  return humanizeCollaborationType(action);
}

function collaborationFeatureStateAction(state: CollaborationFeatureState): string {
  if (state === "approved") {
    return "feature approved";
  }
  if (state === "revision_needed") {
    return "revision pending";
  }
  return `feature ${humanizeFeatureState(state)}`;
}

function humanizeFeatureState(state: CollaborationFeatureState): string {
  return state.replaceAll("_", " ");
}

function humanizeCollaborationType(type: string): string {
  return type.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}
