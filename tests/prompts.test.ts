import { describe, expect, it } from "vitest";
import {
  buildActorPrompt,
  buildJudgePrompt,
  buildWaveActorPrompt,
  buildWaveCriticPrompt
} from "../src/orchestrator/prompts.js";

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

  it("asks the Wave Critic to verify the combined workspace before live commit", () => {
    const prompt = buildWaveCriticPrompt({
      request: "实现 alpha 与 beta",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/judge",
      workerDir: "/tmp/task/critic-wave",
      workspaceDir: "/tmp/task/workspaces/wave/verification",
      wave: 1,
      waves: 2,
      featureIds: ["0001-alpha", "0001-beta"]
    });

    expect(prompt).toContain("# Role: Wave Critic");
    expect(prompt).toContain("Combined verification workspace: /tmp/task/workspaces/wave/verification");
    expect(prompt).toContain("Live workspace has not been updated");
    expect(prompt).toContain("Judge acceptance.md");
    expect(prompt).toContain("0001-alpha, 0001-beta");
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("REVISION_REQUIRED");
  });

  it("asks the Wave Actor to fix only the combined integration workspace", () => {
    const prompt = buildWaveActorPrompt({
      request: "实现 alpha 与 beta",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/judge",
      workerDir: "/tmp/task/actor-wave",
      workspaceDir: "/tmp/task/workspaces/wave/integration",
      wave: 1,
      waves: 2,
      featureIds: ["0001-alpha", "0001-beta"],
      review: "REVISION_REQUIRED\nFix combined output."
    });

    expect(prompt).toContain("# Role: Wave Actor");
    expect(prompt).toContain("Combined integration workspace: /tmp/task/workspaces/wave/integration");
    expect(prompt).toContain("Fix combined output.");
    expect(prompt).toContain("Do not modify the live workspace");
  });
});
