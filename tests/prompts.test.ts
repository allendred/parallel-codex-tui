import { describe, expect, it } from "vitest";
import {
  buildActorPrompt,
  buildCriticPrompt,
  buildFinalJudgePrompt,
  buildJudgePrompt,
  buildMainPrompt,
  buildWaveActorPrompt,
  buildWaveCriticPrompt
} from "../src/orchestrator/prompts.js";

describe("role prompts", () => {
  it("gives non-interactive Main an honest permission contract", () => {
    const prompt = buildMainPrompt({ request: "检查本机网络" });

    expect(prompt).toContain("Chat replies cannot grant CLI tool permissions");
    expect(prompt).toContain("Never claim that a system permission dialog was shown");
    expect(prompt).toContain("press Ctrl+O to continue in the native agent");
  });

  it("includes configured role title and instructions", () => {
    const prompt = buildActorPrompt({
      request: "实现功能",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/judge",
      workerDir: "/tmp/task/actor",
      workspaceDir: "/tmp/task/workspaces/feature",
      role: {
        title: "Builder",
        instructions: ["Prefer small patches.", "Always update worklog.md."]
      }
    });

    expect(prompt).toContain("# Role: Builder");
    expect(prompt).toContain("- Prefer small patches.");
    expect(prompt).toContain("- Always update worklog.md.");
    expect(prompt).toContain("logical project root for this run");
    expect(prompt).toContain("Never write implementation files to the shared live workspace");
    expect(prompt).toContain("Worker directory: /tmp/task/actor");
    expect(prompt).toContain("not in the feature workspace");
  });

  it("describes the Critic workspace as a disposable review copy", () => {
    const prompt = buildCriticPrompt({
      request: "审查功能",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/turn",
      workerDir: "/tmp/task/critic",
      actorDir: "/tmp/task/actor",
      workspaceDir: "/tmp/task/workspaces/reviews/ui"
    });

    expect(prompt).toContain("Review workspace: /tmp/task/workspaces/reviews/ui");
    expect(prompt).toContain("Worker directory: /tmp/task/critic");
    expect(prompt).toContain("disposable review copy");
    expect(prompt).toContain("discarded");
    expect(prompt).toContain("not in the disposable review workspace");
    expect(prompt).toContain('{"id":"C-001","severity":"blocker","summary":"what must change"}');
  });

  it("gives Actor an exact finding reply record contract", () => {
    const prompt = buildActorPrompt({
      request: "修复 Critic finding",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/turn",
      workspaceDir: "/tmp/task/workspaces/feature"
    });

    expect(prompt).toContain('{"finding_id":"C-001","status":"fixed","notes":"what changed"}');
  });

  it("asks Judge for a bounded dependency-aware feature manifest", () => {
    const prompt = buildJudgePrompt({
      request: "实现包含界面、引擎和集成的游戏",
      taskDir: "/tmp/task",
      workerDir: "/tmp/task/judge",
      workspaceDir: "/tmp/project"
    });

    expect(prompt).toContain("- features.json");
    expect(prompt).toContain('"depends_on"');
    expect(prompt).toContain("independent features can run in parallel");
    expect(prompt).toContain("at most 8 features");
    expect(prompt).toContain("Project workspace (read-only): /tmp/project");
    expect(prompt).toContain("Never put the absolute live workspace path into implementation instructions");
    expect(prompt).toContain("logical project root");
    expect(prompt).toContain("- [R-001] one actionable requirement");
    expect(prompt).toContain("1. [P-001] one concrete implementation step");
    expect(prompt).toContain("- [A-001] [R-001] one observable check or command");
    expect(prompt).toContain("Do not leave TODO, TBD, 待定, or placeholder-only content");
  });

  it("asks the same Judge to preserve Feature ids and serialize a conflicting wave", () => {
    const prompt = buildJudgePrompt({
      request: "实现并行功能",
      taskDir: "/tmp/task",
      workerDir: "/tmp/task/judge",
      workspaceDir: "/tmp/project",
      replan: {
        round: 1,
        reportPath: "/tmp/task/turns/0001/feature-replan-01.json",
        conflictPaths: ["src/shared.ts"],
        waveFeatureIds: ["ui", "engine"],
        previousFeatureIds: ["ui", "engine", "tests"]
      }
    });

    expect(prompt).toContain("# Conflict replan 1");
    expect(prompt).toContain("src/shared.ts");
    expect(prompt).toContain("Preserve exactly these feature ids: ui, engine, tests");
    expect(prompt).toContain("Use depends_on to serialize the Features from the conflicting wave");
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

  it("requires the Final Judge to return structured criterion evidence", () => {
    const prompt = buildFinalJudgePrompt({
      request: "实现 alpha 与 beta",
      taskDir: "/tmp/task",
      judgeDir: "/tmp/task/turns/0001",
      workerDir: "/tmp/task/judge-final",
      workspaceDir: "/tmp/task/workspaces/turn-0001/final-verification",
      supervisorSummaryPath: "/tmp/task/turns/0001/supervisor-summary.md",
      expectedCriterionIds: ["A-001", "A-002"],
      changedPaths: ["src/a.ts", "src/b.ts"]
    });

    expect(prompt).toContain("Final acceptance");
    expect(prompt).toContain("disposable snapshot of the integrated project");
    expect(prompt).toContain('Required acceptance criterion ids: ["A-001","A-002"]');
    expect(prompt).toContain('Authoritative changed paths: ["src/a.ts","src/b.ts"]');
    expect(prompt).toContain("Write final-acceptance.json");
    expect(prompt).toContain("Do not rely on process exit alone");
  });
});
