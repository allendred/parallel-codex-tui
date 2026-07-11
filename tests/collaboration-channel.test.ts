import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTextIfExists, writeText } from "../src/core/file-store.js";
import {
  createFeatureChannel,
  recordApprovedFindingResolution,
  requireActorFindingReplies,
  requireFeatureRevisionFindings,
  updateFeatureStatus,
  type FeatureChannel
} from "../src/orchestrator/collaboration-channel.js";

describe("feature collaboration mailbox", () => {
  it("repairs a missing resumed status without clearing collaboration evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-collaboration-channel-resume-"));
    const taskDir = join(root, "task-test");
    const turnDir = join(taskDir, "turns", "0001");
    const input = {
      task: {
        id: "task-test",
        dir: taskDir,
        metaPath: join(taskDir, "meta.json"),
        routePath: join(taskDir, "route.json"),
        eventsPath: join(taskDir, "events.jsonl")
      },
      turn: {
        turnId: "0001",
        dir: turnDir,
        metaPath: join(turnDir, "turn.json"),
        userPath: join(turnDir, "user.md"),
        routePath: join(turnDir, "route.json")
      },
      request: "Preserve mailbox evidence",
      judgeDir: join(taskDir, "judge-mock")
    };
    const channel = await createFeatureChannel(input);
    await writeText(channel.actorWorklogPath, "existing worklog\n");
    await writeText(channel.actorRepliesPath, '{"finding_id":"C-001","status":"fixed"}\n');
    await writeText(channel.criticFindingsPath, '{"id":"C-001","summary":"existing finding"}\n');
    await rm(channel.statusPath);

    const resumed = await createFeatureChannel({ ...input, resume: true });

    expect(await readTextIfExists(resumed.actorWorklogPath)).toBe("existing worklog\n");
    expect(await readTextIfExists(resumed.actorRepliesPath)).toContain('"finding_id":"C-001"');
    expect(await readTextIfExists(resumed.criticFindingsPath)).toContain('"id":"C-001"');
    expect(JSON.parse(await readTextIfExists(resumed.statusPath))).toMatchObject({ state: "created" });
    expect(await readTextIfExists(resumed.dialoguePath)).toContain('"type":"feature.status_recovered"');
  });

  it("keeps repeated feature state updates idempotent", async () => {
    const channel = await featureChannel("state-idempotent");
    await writeText(channel.statusPath, `${JSON.stringify({
      feature_id: channel.id,
      task_id: channel.taskId,
      turn_id: channel.turnId,
      title: channel.title,
      description: channel.description,
      depends_on: [],
      state: "actor_running",
      updated_at: "2026-07-11T00:00:00.000Z"
    })}\n`);

    await updateFeatureStatus(channel, "actor_running");

    expect(JSON.parse(await readTextIfExists(channel.statusPath))).toMatchObject({
      state: "actor_running",
      updated_at: "2026-07-11T00:00:00.000Z"
    });
  });

  it("reports the exact malformed Critic finding row", async () => {
    const channel = await featureChannel("malformed");
    await writeText(channel.criticFindingsPath, [
      JSON.stringify({ id: "C-001", severity: "blocker", summary: "First issue" }),
      "{partial"
    ].join("\n"));

    await expect(requireFeatureRevisionFindings(channel)).rejects.toThrow(
      `Critic finding JSONL is invalid at line 2: ${channel.criticFindingsPath}`
    );
  });

  it("recovers an approved pre-resolution mailbox when every finding already has a fixed reply", async () => {
    const channel = await featureChannel("recovered");
    await writeText(channel.criticFindingsPath, `${JSON.stringify({
      id: "C-001",
      severity: "blocker",
      message: "Fix recovered work"
    })}\n`);
    await writeText(channel.actorRepliesPath, `${JSON.stringify({
      finding_id: "C-001",
      notes: "Recovered Actor checkpoint contains the fix"
    })}\n`);

    await recordApprovedFindingResolution(channel, [], { allowLegacyResolvedFindings: true });

    expect(JSON.parse(await readTextIfExists(channel.findingResolutionPath))).toMatchObject({
      version: 1,
      decision: "approved",
      finding_ids: ["C-001"],
      fixed_ids: ["C-001"],
      unresolved_ids: []
    });
  });

  it("does not infer resolution from preemptive Actor replies in a new approval", async () => {
    const channel = await featureChannel("strict-approval");
    await writeText(channel.criticFindingsPath, `${JSON.stringify({
      id: "C-001",
      severity: "blocker",
      summary: "Still blocking"
    })}\n`);
    await writeText(channel.actorRepliesPath, `${JSON.stringify({
      finding_id: "C-001",
      status: "fixed"
    })}\n`);

    await expect(recordApprovedFindingResolution(channel)).rejects.toThrow(
      "Critic approved with unresolved blocking findings: C-001"
    );
  });

  it("rejects Actor replies that reference unknown Critic findings", async () => {
    const channel = await featureChannel("unknown-reply");
    await writeText(channel.criticFindingsPath, `${JSON.stringify({
      id: "C-001",
      severity: "blocker",
      summary: "Known finding"
    })}\n`);
    await writeText(channel.actorRepliesPath, [
      JSON.stringify({ finding_id: "C-001", status: "fixed" }),
      JSON.stringify({ finding_id: "C-999", status: "fixed" })
    ].join("\n"));

    await expect(recordApprovedFindingResolution(channel, ["C-001"])).rejects.toThrow(
      "Actor replies reference unknown Critic findings: C-999"
    );
  });

  it("persists pending open findings before rejecting a non-fixed Actor reply", async () => {
    const channel = await featureChannel("pending");
    await writeText(channel.criticFindingsPath, `${JSON.stringify({
      id: "C-001",
      severity: "blocker",
      summary: "Still needs work"
    })}\n`);
    await writeText(channel.actorRepliesPath, `${JSON.stringify({
      finding_id: "C-001",
      status: "deferred",
      notes: "Not fixed yet"
    })}\n`);

    await expect(requireActorFindingReplies(channel, ["C-001"])).rejects.toThrow(
      "Actor revision did not mark every Critic finding fixed: C-001"
    );
    expect(JSON.parse(await readTextIfExists(channel.findingResolutionPath))).toMatchObject({
      decision: "pending",
      finding_ids: ["C-001"],
      fixed_ids: [],
      unresolved_ids: ["C-001"]
    });
  });
});

async function featureChannel(suffix: string): Promise<FeatureChannel> {
  const dir = await mkdtemp(join(tmpdir(), `pct-collaboration-channel-${suffix}-`));
  return {
    id: `0001-${suffix}`,
    title: suffix,
    description: suffix,
    dependsOn: [],
    taskId: "task-test",
    turnId: "0001",
    dir,
    specPath: join(dir, "spec.md"),
    statusPath: join(dir, "status.json"),
    dialoguePath: join(dir, "dialogue.jsonl"),
    actorWorklogPath: join(dir, "actor-worklog.md"),
    actorRepliesPath: join(dir, "actor-replies.jsonl"),
    criticFindingsPath: join(dir, "critic-findings.jsonl"),
    findingResolutionPath: join(dir, "finding-resolution.json"),
    decisionsPath: join(dir, "decisions.md")
  };
}
