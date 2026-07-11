import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeText } from "../src/core/file-store.js";
import { buildSupervisorSummary } from "../src/orchestrator/supervisor-summary.js";
import { parseTaskResultSummary } from "../src/tui/task-result.js";

describe("buildSupervisorSummary", () => {
  it("includes authoritative changed paths and bounded verification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-supervisor-summary-"));
    const judgeDir = join(root, "judge");
    const actorDir = join(root, "actor");
    const criticDir = join(root, "critic");
    await Promise.all([judgeDir, actorDir, criticDir].map((dir) => mkdir(dir, { recursive: true })));
    await writeText(join(judgeDir, "requirements.md"), "# Requirements\n\n- Build the game.\n");
    await writeText(join(actorDir, "worklog.md"), "# Worklog\n\n- Added gameplay.\n");
    await writeText(join(criticDir, "review.md"), [
      "# Review",
      "",
      "APPROVED",
      "",
      "Verification:",
      "- `npm test` passed: 42/42.",
      "- `npm run build` passed."
    ].join("\n"));

    const summary = await buildSupervisorSummary({
      judgeDir,
      actorDir,
      criticDir,
      changedPaths: ["src/z.ts", "src/a.ts", "src/z.ts"]
    });

    expect(summary).toContain("Changed files:\n- src/a.ts\n- src/z.ts");
    expect(summary).toContain("Verification:\nCritic decision: APPROVED");
    expect(summary).toContain("- `npm test` passed: 42/42.");
    expect(summary).toContain("- `npm run build` passed.");
    expect(summary).toContain("> Verification:");
    const parsed = parseTaskResultSummary(summary);
    expect(parsed?.sections.review).toContain("APPROVED");
    expect(parsed?.sections.verification).toContain("Critic decision: APPROVED");
  });

  it("keeps changed files empty when no integration paths are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-supervisor-summary-empty-"));
    const judgeDir = join(root, "judge");
    const actorDir = join(root, "actor");
    const criticDir = join(root, "critic");
    await Promise.all([judgeDir, actorDir, criticDir].map((dir) => mkdir(dir, { recursive: true })));

    const summary = await buildSupervisorSummary({ judgeDir, actorDir, criticDir });

    expect(summary).toContain("Changed files:\n(empty)");
    expect(summary).toContain("Verification:\n(empty)");
  });

  it("does not split Unicode code points when bounding long sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-supervisor-summary-unicode-"));
    const judgeDir = join(root, "judge");
    const actorDir = join(root, "actor");
    const criticDir = join(root, "critic");
    await Promise.all([judgeDir, actorDir, criticDir].map((dir) => mkdir(dir, { recursive: true })));
    await writeText(join(judgeDir, "requirements.md"), `${"a".repeat(796)}😀tail`);

    const summary = await buildSupervisorSummary({ judgeDir, actorDir, criticDir });

    expect(summary).toContain(`${"a".repeat(796)}😀...`);
    expect(summary).not.toContain("\ud83d...");
  });
});
