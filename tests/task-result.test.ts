import { describe, expect, it } from "vitest";
import {
  latestTaskResultMessageIndex,
  parseTaskResultSummary
} from "../src/tui/task-result.js";

const FIRST_RESULT = [
  "Complex task completed.",
  "",
  "Requirements:",
  "# Requirements",
  "",
  "- Build the first project.",
  "- Keep keyboard controls responsive.",
  "",
  "Actor work:",
  "# Worklog",
  "",
  "- Added the game loop.",
  "- Added score and level tests.",
  "",
  "Critic review:",
  "# Review",
  "",
  "APPROVED",
  "",
  "All acceptance checks passed.",
  "",
  "Critic findings:",
  "(empty)"
].join("\n");

describe("task result parsing", () => {
  it("preserves every structured section instead of keeping only its first line", () => {
    const result = parseTaskResultSummary(FIRST_RESULT);

    expect(result).not.toBeNull();
    expect(result?.outcome).toBe("approved");
    expect(result?.sections.requirements).toContain("Build the first project.");
    expect(result?.sections.requirements).toContain("Keep keyboard controls responsive.");
    expect(result?.sections.implementation).toContain("Added the game loop.");
    expect(result?.sections.implementation).toContain("Added score and level tests.");
    expect(result?.sections.review).toContain("All acceptance checks passed.");
    expect(result?.sections.findings).toBe("");
  });

  it("selects the latest result belonging to the active task", () => {
    const messages = [
      { from: "system" as const, text: FIRST_RESULT, taskId: "task-first" },
      { from: "user" as const, text: "switch task", taskId: "task-second" },
      {
        from: "system" as const,
        text: FIRST_RESULT.replace("Build the first project.", "Build the second project."),
        taskId: "task-second"
      },
      { from: "system" as const, text: "A later Main answer.", taskId: "task-second" }
    ];

    expect(latestTaskResultMessageIndex(messages, "task-first")).toBe(0);
    expect(latestTaskResultMessageIndex(messages, "task-second")).toBe(2);
    expect(latestTaskResultMessageIndex(messages, "task-missing")).toBe(-1);
  });

  it("keeps legacy unscoped summaries available after upgrading", () => {
    expect(latestTaskResultMessageIndex([
      { from: "system" as const, text: FIRST_RESULT }
    ], "task-restored")).toBe(0);
  });

  it("does not mistake ordinary chat replies for task results", () => {
    expect(parseTaskResultSummary("APPROVED\nEverything looks good.")).toBeNull();
  });

  it("uses the standalone Critic decision instead of words in its explanation", () => {
    const approved = parseTaskResultSummary(
      FIRST_RESULT.replace("All acceptance checks passed.", "No tests failed during verification.")
    );
    const revision = parseTaskResultSummary(
      FIRST_RESULT.replace("APPROVED", "REVISION_REQUIRED")
    );

    expect(approved?.outcome).toBe("approved");
    expect(revision?.outcome).toBe("revision-required");
  });

  it("parses changed files and verification from newer summaries", () => {
    const result = parseTaskResultSummary(
      FIRST_RESULT
        .replace("\nCritic review:", "\nChanged files:\n- src/game.ts\n- tests/game.test.ts\n\nCritic review:")
        .replace("\nCritic findings:", "\nVerification:\nCritic decision: APPROVED\n- npm test passed\n\nCritic findings:")
    );

    expect(result?.sections.changes).toContain("src/game.ts");
    expect(result?.sections.changes).toContain("tests/game.test.ts");
    expect(result?.sections.verification).toContain("npm test passed");
  });
});
