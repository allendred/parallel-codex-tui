import { describe, expect, it } from "vitest";
import { buildActorPrompt } from "../src/orchestrator/prompts.js";

describe("role prompts", () => {
  it("includes configured role title and instructions", () => {
    const prompt = buildActorPrompt({
      request: "实现功能",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/judge",
      role: {
        title: "Builder",
        instructions: ["Prefer small patches.", "Always update worklog.md."]
      }
    });

    expect(prompt).toContain("# Role: Builder");
    expect(prompt).toContain("- Prefer small patches.");
    expect(prompt).toContain("- Always update worklog.md.");
  });
});
