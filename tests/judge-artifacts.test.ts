import { describe, expect, it } from "vitest";
import { validateJudgeArtifacts } from "../src/orchestrator/judge-artifacts.js";

describe("validateJudgeArtifacts", () => {
  it("normalizes structured Judge Markdown into an executable contract", () => {
    const report = validateJudgeArtifacts({
      "requirements.md": [
        "# Requirements",
        "",
        "- [R-001] Support keyboard controls.",
        "- Render the current score."
      ].join("\n"),
      "plan.md": [
        "# Plan",
        "",
        "1. [P-001] Implement the game loop.",
        "2. Add focused tests."
      ].join("\n"),
      "acceptance.md": [
        "# Acceptance",
        "",
        "- [A-001] [R-001] Arrow keys move the active piece in the smoke test.",
        "- `npm test` exits with code 0."
      ].join("\n"),
      "actor-brief.md": "# Actor Brief\n\nImplement the scoped requirements in the assigned workspace.\n",
      "critic-brief.md": "# Critic Brief\n\nVerify every acceptance item and report blocking findings.\n"
    });

    expect(report.state).toBe("valid");
    expect(report.issues).toEqual([]);
    expect(report.artifacts["requirements.md"]).toMatchObject({
      state: "valid",
      item_count: 2
    });
    expect(report.contract.requirements).toEqual([
      { id: "R-001", text: "Support keyboard controls.", references: [] },
      { id: "R-002", text: "Render the current score.", references: [] }
    ]);
    expect(report.contract.acceptance[0]).toEqual({
      id: "A-001",
      text: "[R-001] Arrow keys move the active piece in the smoke test.",
      references: ["R-001"]
    });
  });

  it("rejects heading-only, paragraph-only, and placeholder artifacts", () => {
    const report = validateJudgeArtifacts({
      "requirements.md": "# Requirements\n",
      "plan.md": "# Plan\n\n1. TBD\n",
      "acceptance.md": "# Acceptance\n\nTests should pass.\n",
      "actor-brief.md": "# Actor Brief\n\nTODO\n",
      "critic-brief.md": "# Critic Brief\n\n稍后补充\n"
    });

    expect(report.state).toBe("invalid");
    expect(report.issues.map((issue) => [issue.file, issue.code])).toEqual(expect.arrayContaining([
      ["requirements.md", "missing_list_items"],
      ["plan.md", "placeholder_only"],
      ["acceptance.md", "missing_list_items"],
      ["actor-brief.md", "placeholder_only"],
      ["critic-brief.md", "placeholder_only"]
    ]));
  });

  it("accepts legacy list artifacts without explicit ids and assigns stable ids", () => {
    const report = validateJudgeArtifacts({
      "requirements.md": "# Requirements\n\n- Build the game.\n",
      "plan.md": "# Plan\n\n1. Implement it.\n",
      "acceptance.md": "# Acceptance\n\n- The smoke test passes.\n",
      "actor-brief.md": "# Actor Brief\n\nImplement the requested change.\n",
      "critic-brief.md": "# Critic Brief\n\nReview the result against acceptance.\n"
    });

    expect(report.state).toBe("valid");
    expect(report.contract.requirements[0]?.id).toBe("R-001");
    expect(report.contract.plan[0]?.id).toBe("P-001");
    expect(report.contract.acceptance[0]?.id).toBe("A-001");
  });

  it("rejects duplicate ids and acceptance references to unknown requirements", () => {
    const report = validateJudgeArtifacts({
      "requirements.md": "# Requirements\n\n- [R-001] Build the game.\n- [R-001] Add controls.\n",
      "plan.md": "# Plan\n\n1. [P-001] Implement it.\n",
      "acceptance.md": "# Acceptance\n\n- [A-001] [R-999] The smoke test passes.\n",
      "actor-brief.md": "# Actor Brief\n\nImplement the requested change.\n",
      "critic-brief.md": "# Critic Brief\n\nReview the result against acceptance.\n"
    });

    expect(report.state).toBe("invalid");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "duplicate_item_id",
      "unknown_requirement_reference"
    ]));
  });
});
