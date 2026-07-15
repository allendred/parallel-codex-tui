import { describe, expect, it } from "vitest";
import { validateFinalJudgeAcceptance } from "../src/orchestrator/final-acceptance.js";

describe("validateFinalJudgeAcceptance", () => {
  it("accepts a complete evidence-backed approval", () => {
    const result = validateFinalJudgeAcceptance({
      version: 1,
      decision: "approved",
      summary: "All integrated behavior passed.",
      acceptance: [
        { criterion_id: "A-001", status: "passed", evidence: "npm test passed" },
        { criterion_id: "A-002", status: "passed", evidence: "manual flow passed" }
      ],
      changed_paths: ["src/a.ts", "src/b.ts"]
    }, ["A-001", "A-002"], ["src/b.ts", "src/a.ts"]);

    expect(result.report).toEqual({
      version: 1,
      state: "valid",
      decision: "approved",
      issues: []
    });
  });

  it("rejects missing criteria, contradictory decisions, and invented paths", () => {
    const result = validateFinalJudgeAcceptance({
      version: 1,
      decision: "approved",
      summary: "Looks fine.",
      acceptance: [
        { criterion_id: "A-001", status: "failed", evidence: "test failed" },
        { criterion_id: "A-003", status: "passed", evidence: "unrelated" }
      ],
      changed_paths: ["src/invented.ts"]
    }, ["A-001", "A-002"], ["src/a.ts"]);

    expect(result.report.state).toBe("invalid");
    expect(result.report.issues).toEqual([
      "missing acceptance criteria: A-002",
      "unknown acceptance criteria: A-003",
      "approved decision contains failed criteria: A-001",
      "missing changed paths: src/a.ts",
      "unknown changed paths: src/invented.ts"
    ]);
  });

  it("requires a rejected verdict to name a failed criterion", () => {
    const result = validateFinalJudgeAcceptance({
      version: 1,
      decision: "rejected",
      summary: "Rejected without a failed item.",
      acceptance: [{ criterion_id: "A-001", status: "passed", evidence: "passed" }],
      changed_paths: []
    }, ["A-001"], []);

    expect(result.report.issues).toContain(
      "rejected decision must identify at least one failed criterion"
    );
  });
});
