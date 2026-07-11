import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTextIfExists, writeText } from "../src/core/file-store.js";
import {
  recordApprovedFindingResolution,
  requireActorFindingReplies,
  requireFeatureRevisionFindings,
  type FeatureChannel
} from "../src/orchestrator/collaboration-channel.js";

describe("feature collaboration mailbox", () => {
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
