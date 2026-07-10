import { describe, expect, it } from "vitest";
import { buildActorPrompt, buildJudgePrompt } from "../src/orchestrator/prompts.js";

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

  it("asks Judge for a bounded dependency-aware feature manifest", () => {
    const prompt = buildJudgePrompt({
      request: "实现包含界面、引擎和集成的游戏",
      taskDir: "/tmp/task",
      workerDir: "/tmp/task/judge"
    });

    expect(prompt).toContain("- features.json");
    expect(prompt).toContain('"depends_on"');
    expect(prompt).toContain("independent features can run in parallel");
    expect(prompt).toContain("at most 8 features");
  });
});
