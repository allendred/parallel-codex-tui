import React from "react";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  WorkerOutputView,
  workerOutputBodyDisplayLines,
  workerOutputCodeDisplayLines,
  workerOutputDiffColumns,
  workerOutputDiffDisplayLines,
  workerOutputHeaderDisplay,
  workerOutputLineFillTheme,
  workerOutputLineLayout,
  workerOutputLineTheme,
  workerOutputScrollDisplay,
  workerOutputSourceColumns,
  workerOutputSourceDisplayLines,
  workerOutputTailTopPaddingLines,
  workerOutputTitleDisplay,
  workerOutputVisibleStart
} from "../src/tui/WorkerOutputView.js";
import { displayWidth } from "../src/tui/display-width.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("WorkerOutputView", () => {
  it("renders an actionable empty state when no worker log is selected", async () => {
    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Worker output"
        logPath={null}
        height={5}
      />
    );

    try {
      await waitForFrame(lastFrame, "No worker selected");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("No worker selected. Run a complex task to create logs.");
      expect(frame).not.toContain("No worker log selected.");
    } finally {
      unmount();
    }
  });

  it("renders actor role artifact logs before raw process output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "worklog.md"), "Implemented board controls.\n");
    await writeFile(join(workerDir, "actor-worklog.md"), "Feature mailbox notes.\n");
    await writeFile(join(workerDir, "output.log"), "raw process output\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "Implemented board controls.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("artifacts");
      expect(frame).toContain("worklog.md");
      expect(frame).toContain("actor-worklog.md");
      expect(frame).toContain("Feature mailbox notes.");
      expect(frame).toContain("process");
      expect(frame).toContain("raw process output");
      expect(frame).not.toContain("Role artifacts");
      expect(frame).not.toContain("Process output");
      expect(frame).not.toContain("[output.log]");
      expect(frame).not.toContain("--- worklog.md ---");
    } finally {
      unmount();
    }
  });

  it("renders critic review artifacts before raw process output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\nNo blockers.\n");
    await writeFile(join(workerDir, "critic-findings.jsonl"), "{\"severity\":\"high\",\"message\":\"missing test\"}\n");
    await writeFile(join(workerDir, "output.log"), "critic cli transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "APPROVED");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("artifacts");
      expect(frame).toContain("review.md");
      expect(frame).toContain("critic-findings.jsonl");
      expect(frame).toContain("missing test");
      expect(frame).toContain("process");
      expect(frame).toContain("critic cli transcript");
      expect(frame).not.toContain("Role artifacts");
      expect(frame).not.toContain("Process output");
      expect(frame).not.toContain("[output.log]");
    } finally {
      unmount();
    }
  });

  it("renders worker jsonl records with finding ids and source locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-jsonl-summary-"));
    const criticDir = join(root, "critic-mock");
    const actorDir = join(root, "actor-mock");

    await mkdir(criticDir, { recursive: true });
    await mkdir(actorDir, { recursive: true });
    await writeFile(
      join(criticDir, "critic-findings.jsonl"),
      "{\"id\":\"C-017\",\"severity\":\"high\",\"file\":\"src/input.ts\",\"line\":42,\"message\":\"Chinese input drops the final character\"}\n"
    );
    await writeFile(join(criticDir, "output.log"), "critic cli transcript\n");
    await writeFile(
      join(actorDir, "actor-replies.jsonl"),
      "{\"finding_id\":\"C-017\",\"status\":\"fixed\",\"to\":\"critic\",\"message\":\"Buffered IME commits before submit\"}\n"
    );
    await writeFile(join(actorDir, "output.log"), "actor cli transcript\n");

    const critic = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(criticDir, "output.log")}
        height={16}
      />
    );
    const actor = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(actorDir, "output.log")}
        height={16}
      />
    );

    try {
      await waitForFrame(critic.lastFrame, "Chinese input drops the final character");
      await waitForFrame(actor.lastFrame, "Buffered IME commits before submit");

      const criticFrame = critic.lastFrame() ?? "";
      expect(criticFrame).toContain("[high] C-017 · src/input.ts:42");
      expect(criticFrame).toContain("Chinese input drops the final character");
      expect(criticFrame).not.toContain("\"line\":42");

      const actorFrame = actor.lastFrame() ?? "";
      expect(actorFrame).toContain("[fixed] C-017 · to critic");
      expect(actorFrame).toContain("Buffered IME commits before submit");
      expect(actorFrame).not.toContain("\"finding_id\"");
    } finally {
      critic.unmount();
      actor.unmount();
    }
  });

  it("renders jsonl title, details, and recommendations without leaking raw objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-jsonl-details-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "critic-findings.jsonl"),
      [
        "{",
        "\"id\":\"C-018\",",
        "\"severity\":\"medium\",",
        "\"file\":\"src/workers/native-attach.ts\",",
        "\"line\":\"245\",",
        "\"title\":\"Attach cleanup leaves stale sessions\",",
        "\"details\":[\"Close after pty exit\",\"Fallback resumes wrong worker\"],",
        "\"recommendation\":\"Clear native session id\"",
        "}"
      ].join("")
    );
    await writeFile(join(workerDir, "output.log"), "critic cli transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={16}
      />
    );

    try {
      await waitForFrame(lastFrame, "Clear native session id");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("[medium] C-018 · src/workers/native-attach.ts:245");
      expect(frame).toContain("Attach cleanup leaves stale sessions");
      expect(frame).toContain("detail · Close after pty exit");
      expect(frame).toContain("detail · Fallback resumes wrong worker");
      expect(frame).toContain("fix · Clear native session id");
      expect(frame).not.toContain("\"details\"");
      expect(frame).not.toContain("\"recommendation\"");
      expect(frame).not.toContain("{\"id\"");
    } finally {
      unmount();
    }
  });

  it("keeps judge worker briefs out of the primary log view", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-judge-briefs-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "requirements.md"), "Build a playable falling-blocks game.\n");
    await writeFile(join(workerDir, "plan.md"), "Implement rules, input, rendering, and checks.\n");
    await writeFile(join(workerDir, "acceptance.md"), "npm test, smoke, and build must pass.\n");
    await writeFile(join(workerDir, "actor-brief.md"), "INTERNAL ACTOR TEMPLATE: do not show this prompt.\n");
    await writeFile(
      join(workerDir, "critic-brief.md"),
      [
        "INTERNAL CRITIC TEMPLATE: do not show this prompt.",
        "",
        "## 输出格式",
        "- `Critical`: internal severity rubric"
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "judge process output\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (mock) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "Build a playable falling-blocks game.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("requirements.md");
      expect(frame).toContain("plan.md");
      expect(frame).toContain("acceptance.md");
      expect(frame).toContain("judge process output");
      expect(frame).not.toContain("actor-brief.md");
      expect(frame).not.toContain("critic-brief.md");
      expect(frame).not.toContain("INTERNAL ACTOR TEMPLATE");
      expect(frame).not.toContain("INTERNAL CRITIC TEMPLATE");
      expect(frame).not.toContain("输出格式");
      expect(frame).not.toContain("Critical");
    } finally {
      unmount();
    }
  });

  it("renders empty search exit code 1 as no matches without hiding real search errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-search-exit-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc 'rg TODO src' in /tmp/project",
        "exited 1 in 0ms:",
        "",
        "exec",
        "/bin/zsh -lc 'rg SECRET /root' in /tmp/project",
        "exited 1 in 2ms:",
        "/root/private.txt: Permission denied"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (mock) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "Permission denied");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("no matches 0ms · TODO src");
      expect(frame).not.toContain("$ rg TODO src");
      expect(frame).not.toContain("exit 1 0ms");
      expect(frame).toContain("$ rg SECRET /root");
      expect(frame).toContain("exit 1 2ms");
      expect(frame).toContain("/root/private.txt: Permission denied");
    } finally {
      unmount();
    }
  });

  it("does not show stale worker content immediately after switching logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-switch-"));
    const actorDir = join(root, "actor-mock");
    const criticDir = join(root, "critic-mock");

    await mkdir(actorDir, { recursive: true });
    await mkdir(criticDir, { recursive: true });
    await writeFile(join(actorDir, "worklog.md"), "ACTOR UNIQUE CONTENT\n");
    await writeFile(join(actorDir, "output.log"), "actor process output\n");
    await writeFile(join(criticDir, "review.md"), "CRITIC UNIQUE CONTENT\n");
    await writeFile(join(criticDir, "output.log"), "critic process output\n");

    const view = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(actorDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ACTOR UNIQUE CONTENT");

      view.rerender(
        <WorkerOutputView
          title="Critic (mock) output"
          role="critic"
          logPath={join(criticDir, "output.log")}
          height={20}
        />
      );

      const immediateFrame = view.lastFrame() ?? "";
      expect(immediateFrame).toContain("critic/mock");
      expect(immediateFrame).not.toContain("ACTOR UNIQUE CONTENT");
      expect(immediateFrame).not.toContain("actor process output");

      await waitForFrame(view.lastFrame, "CRITIC UNIQUE CONTENT");
      expect(view.lastFrame() ?? "").toContain("critic process output");
    } finally {
      view.unmount();
    }
  });

  it("renders ERROR-prefixed process lines as errors instead of code", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-error-line-"));
    const workerDir = join(root, "actor-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ codex exec resume abc -",
        "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying."
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (codex) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "Codex context window full");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("error · Codex context window full · start a new thread or clear history");
      expect(frame).not.toContain("ERROR: Codex ran out of room");
      expect(frame).not.toContain("| ERROR: Codex ran out of room");
    } finally {
      unmount();
    }
  });

  it("hides successful internal worker launch commands from process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-launch-command-hidden-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ codex exec --skip-git-repo-check --sandbox workspace-write --color never -",
        "$ pwd && rg --files",
        "succeeded in 0ms:",
        "/tmp/tetris",
        "src/main.mjs",
        "src/game/scoring.mjs",
        "src/game/pieces.mjs",
        "src/game/randomizer.mjs",
        "src/game/engine.mjs",
        "src/game/board.mjs",
        "src/styles.css",
        "src/ui/input.mjs",
        "src/ui/render.mjs",
        "src/ui/storage.mjs",
        "scripts/build.mjs",
        "package.json"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "files 13 paths");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("ok 0ms · files 13 paths · $ rg --files");
      expect(frame).not.toContain("\n   $ pwd && rg --files \n");
      expect(frame).not.toContain("$ codex exec --skip-git-repo-check");
    } finally {
      unmount();
    }
  });

  it("keeps internal worker launch commands when they explain a startup failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-launch-command-error-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ codex exec --ask-for-approval never --sandbox workspace-write --color never -",
        "error: unexpected argument '--ask-for-approval' found",
        "Usage: codex exec [OPTIONS] [PROMPT]"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "unexpected argument");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("$ codex exec --ask-for-approval never");
      expect(frame).toContain("unexpected argument");
    } finally {
      unmount();
    }
  });

  it("collapses long file listing output while preserving command status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-file-list-collapse-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ pwd && rg --files",
        "succeeded in 0ms:",
        "/tmp/tetris",
        "src/main.mjs",
        "src/game/scoring.mjs",
        "src/game/pieces.mjs",
        "src/game/randomizer.mjs",
        "src/game/engine.mjs",
        "src/styles.css",
        "src/ui/input.mjs",
        "src/ui/render.mjs",
        "src/ui/storage.mjs",
        "scripts/build.mjs",
        "scripts/dev-server.mjs",
        "scripts/smoke-test.mjs",
        "package.json",
        "package-lock.json",
        "dist/app.js",
        "dist/index.html",
        "test/engine.test.mjs",
        "test/board.test.mjs",
        "index.html",
        "$ npm test",
        "4 tests passed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "4 tests passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · files 20 paths · $ rg --files");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("4 tests passed");
      expect(frame).not.toContain("$ pwd && rg --files");
      expect(frame).not.toContain("succeeded in 0ms:");
      expect(frame).not.toContain("src/game/scoring.mjs");
      expect(frame).not.toContain("scripts/smoke-test.mjs");
    } finally {
      unmount();
    }
  });

  it("uses a short command label for collapsed rg file listings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-file-list-short-command-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ pwd && rg --files -g '!*node_modules*' -g '!*.png' -g '!*.jpg' | sed -n '1,200p'",
        "succeeded in 0ms:",
        "/tmp/tetris",
        "src/main.mjs",
        "src/game/scoring.mjs",
        "src/game/pieces.mjs",
        "src/game/randomizer.mjs",
        "src/game/engine.mjs",
        "src/game/board.mjs",
        "src/styles.css",
        "src/ui/input.mjs",
        "src/ui/render.mjs",
        "src/ui/storage.mjs",
        "scripts/build.mjs",
        "package.json"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "files 13 paths");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · files 13 paths · $ rg --files");
      expect(frame).not.toContain("!*node_modules");
      expect(frame).not.toContain("!*.png");
    } finally {
      unmount();
    }
  });

  it("renders collapsed command output as one status summary row", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-command-summary-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ sed -n '1,260p' test/board.test.mjs",
        "succeeded in 0ms:",
        "const one = 1;",
        "const two = 2;",
        "const three = 3;",
        "const four = 4;",
        "const five = 5;",
        "const six = 6;",
        "const seven = 7;",
        "const eight = 8;",
        "after summary"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={16}
      />
    );

    try {
      await waitForFrame(lastFrame, "after summary");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("test/board.test.mjs:1-260 · 8 code");
      expect(frame).toContain("after summary");
      expect(frame).not.toContain("const one");
      expect(frame).not.toContain("\n   $ sed -n '1,260p' test/board.test.mjs \n");
    } finally {
      unmount();
    }
  });

  it("groups short runs of adjacent file read summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-read-run-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ sed -n '1,40p' src/main.mjs",
        "succeeded in 1ms:",
        "const one = 1;",
        "const two = 2;",
        "const three = 3;",
        "const four = 4;",
        "$ sed -n '1,40p' src/ui/storage.mjs",
        "succeeded in 1ms:",
        "const five = 5;",
        "const six = 6;",
        "const seven = 7;",
        "const eight = 8;",
        "$ sed -n '1,40p' scripts/build.mjs",
        "succeeded in 1ms:",
        "const nine = 9;",
        "const ten = 10;",
        "const eleven = 11;",
        "const twelve = 12;",
        "after reads"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={14}
      />
    );

    try {
      await waitForFrame(lastFrame, "after reads");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· read 3 chunks · 12 lines · main.mjs, ui/storage.mjs, scripts/build.mjs");
      expect(frame).toContain("after reads");
      expect(frame).not.toContain("main.mjs:1-40 · 4 code");
      expect(frame).not.toContain("ui/storage.mjs:1-40 · 4 code");
      expect(frame).not.toContain("scripts/build.mjs:1-40 · 4 code");
    } finally {
      unmount();
    }
  });

  it("renders orphaned collapsed summaries as explicit summary rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-orphan-summary-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "output.log"), "Collapsed code output: 217 lines\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={8}
      />
    );

    try {
      await waitForFrame(lastFrame, "Collapsed code output: 217 lines");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· Collapsed code output: 217 lines");
      expect(frame).not.toContain("| Collapsed code output");
    } finally {
      unmount();
    }
  });

  it("keeps consecutive collapsed summary rows dense", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-dense-summaries-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "Collapsed code output: 217 lines",
        "",
        "Collapsed source output: 42 lines",
        "",
        "after summaries"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "after summaries");

      const lines = (lastFrame() ?? "").split("\n");
      const firstSummary = lines.findIndex((line) => line.includes("· Collapsed code output: 217 lines"));
      const secondSummary = lines.findIndex((line) => line.includes("· Collapsed source output: 42 lines"));
      const after = lines.findIndex((line) => line.includes("after summaries"));

      expect(firstSummary).toBeGreaterThanOrEqual(0);
      expect(secondSummary).toBe(firstSummary + 1);
      expect(lines.slice(secondSummary + 1, after).filter((line) => line.trim() === "")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("keeps adjacent process status events dense after smoke output is merged", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-dense-process-events-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 505ms: ($ npm test)",
        "Node tests passed: 30/30",
        "",
        "succeeded in 367ms: ($ npm run smoke)",
        "",
        "Smoke test passed: app boots with DOM/canvas shims.",
        "",
        "succeeded in 372ms: ($ npm run build) Build output: dist/"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "built dist");

      const lines = (lastFrame() ?? "").split("\n");
      const testStatus = lines.findIndex((line) => line.includes("· ok 505ms · $ npm test"));
      const testSummary = lines.findIndex((line) => line.includes("· tests 30 passed"));
      const smoke = lines.findIndex((line) => line.includes("smoke passed · 367ms"));
      const build = lines.findIndex((line) => line.includes("· ok 372ms · $ npm run build · built dist"));

      expect(testStatus).toBeGreaterThanOrEqual(0);
      expect(testSummary).toBe(testStatus + 1);
      expect(smoke).toBe(testSummary + 1);
      expect(build).toBe(smoke + 1);
      expect(lines.slice(testStatus, build + 1).filter((line) => line.trim() === "")).toHaveLength(0);
    } finally {
      unmount();
    }
  });

  it("pairs a collapsed result with the oldest pending adjacent command", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-adjacent-command-summary-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ sed -n '1,260p' src/game/scoring.mjs",
        "$ sed -n '1,260p' index.html",
        "succeeded in 0ms:",
        "const LINE_SCORES = Object.freeze({",
        "0: 0,",
        "1: 100,",
        "2: 300,",
        "3: 500,",
        "4: 800",
        "});",
        "export function scoreLines(linesCleared, level) {",
        "return (LINE_SCORES[linesCleared] ?? 0) * level;",
        "}",
        "after adjacent commands"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "after adjacent commands");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· game/scoring.mjs:1-260 · 10 code");
      expect(frame).toContain("$ sed -n '1,260p' index.html");
      expect(frame).not.toContain("$ sed -n '1,260p' src/game/scoring.mjs");
      expect(frame).not.toContain("Collapsed code output: 10 lines ($ sed -n '1,260p' index.html)");
      expect(frame).not.toContain("LINE_SCORES");
      expect(frame).not.toContain("0: 0");
    } finally {
      unmount();
    }
  });

  it("renders feature mailbox artifacts for the selected role", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-"));
    const workerDir = join(root, "actor-mock");
    const featureDir = join(root, "features", "0002");

    await mkdir(workerDir, { recursive: true });
    await mkdir(featureDir, { recursive: true });
    await writeFile(join(featureDir, "actor-worklog.md"), "Feature 0002 implementation notes.\n");
    await writeFile(join(featureDir, "critic-findings.jsonl"), "{\"message\":\"critic only\"}\n");
    await writeFile(join(workerDir, "output.log"), "actor cli transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "Feature 0002 implementation notes.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("mailbox");
      expect(frame).toContain("file · 0002/actor-worklog.md");
      expect(frame).not.toContain("file · features/0002/actor-worklog.md");
      expect(frame).not.toContain("critic only");
      expect(frame).toContain("process");
      expect(frame).not.toContain("Feature mailbox");
      expect(frame).not.toContain("Process output");
      expect(frame).not.toContain("[output.log]");
    } finally {
      unmount();
    }
  });

  it("compacts short worker metadata headings into one-line fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-metadata-fields-"));
    const workerDir = join(root, "actor-mock");
    const featureDir = join(root, "features", "0010");

    await mkdir(workerDir, { recursive: true });
    await mkdir(featureDir, { recursive: true });
    await writeFile(
      join(featureDir, "actor-worklog.md"),
      [
        "# Actor Feature Worklog",
        "",
        "## Feature",
        "0010",
        "",
        "## User Request",
        "设置速度",
        "",
        "## Summary",
        "Added a saved speed setting."
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "actor cli transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "Added a saved speed setting.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Feature: 0010");
      expect(frame).toContain("User Request: 设置速度");
      expect(frame).toContain("Summary");
      expect(frame).toContain("Added a saved speed setting.");
      expect(frame).not.toContain("Actor Feature Worklog");
      expect(frame).not.toMatch(/Feature\s*\n\s*0010/);
      expect(frame).not.toMatch(/User Request\s*\n\s*设置速度/);
    } finally {
      unmount();
    }
  });

  it("renders feature mailbox artifacts from oldest to newest before process output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-mailbox-order-"));
    const workerDir = join(root, "critic-mock");
    const oldFeatureDir = join(root, "features", "0005");
    const newFeatureDir = join(root, "features", "0010");

    await mkdir(workerDir, { recursive: true });
    await mkdir(oldFeatureDir, { recursive: true });
    await mkdir(newFeatureDir, { recursive: true });
    await writeFile(join(oldFeatureDir, "decisions.md"), "Old decision turn 0005.\n");
    await writeFile(join(newFeatureDir, "decisions.md"), "Latest decision turn 0010.\n");
    await writeFile(join(workerDir, "output.log"), "process tail\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "Latest decision turn 0010.");

      const frame = lastFrame() ?? "";
      const oldIndex = frame.indexOf("Old decision turn 0005.");
      const latestIndex = frame.indexOf("Latest decision turn 0010.");
      const processIndex = frame.indexOf("process tail");
      expect(oldIndex).toBeGreaterThanOrEqual(0);
      expect(latestIndex).toBeGreaterThan(oldIndex);
      expect(processIndex).toBeGreaterThan(latestIndex);
    } finally {
      unmount();
    }
  });

  it("opens tall multi-turn tails at the latest complete feature section without top padding", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-latest-tail-"));
    const workerDir = join(root, "critic-mock");
    const oldFeatureDir = join(root, "features", "0007");
    const newFeatureDir = join(root, "features", "0010");

    await mkdir(workerDir, { recursive: true });
    await mkdir(oldFeatureDir, { recursive: true });
    await mkdir(newFeatureDir, { recursive: true });
    await writeFile(join(oldFeatureDir, "decisions.md"), [
      "# Decisions",
      "",
      "Feature: 0007",
      "Turn: 0007",
      "",
      "Supervisor summary:",
      "Complex task completed.",
      "Old retained summary detail 1.",
      "Old retained summary detail 2.",
      "Old retained summary detail 3.",
      "Old retained summary detail 4.",
      "Old retained summary detail 5.",
      "Old retained summary detail 6.",
      "Old retained summary detail 7.",
      "Old retained summary detail 8.",
      "",
      "Critic review:",
      "APPROVED",
      "",
      "Critic findings:",
      "(empty)"
    ].join("\n"));
    await writeFile(join(newFeatureDir, "decisions.md"), [
      "# Decisions",
      "",
      "Feature: 0010",
      "Turn: 0010",
      "",
      "Supervisor summary:",
      "Complex task completed.",
      "",
      "Critic review:",
      "APPROVED",
      "",
      "Critic findings:",
      "(empty)"
    ].join("\n"));
    await writeFile(join(workerDir, "output.log"), "");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={18}
      />
    );

    try {
      await waitForFrame(lastFrame, "Feature 0010");

      const frame = lastFrame() ?? "";
      const lines = frame.split("\n");
      expect(lines[1]?.trim()).toBe("file · 0010/decisions.md");
      expect(frame).toContain("Feature 0010");
      expect(frame).not.toContain("file · 0007/decisions.md");
      expect(frame).not.toContain("Feature 0007");
    } finally {
      unmount();
    }
  });

  it("compacts feature decisions to final review signal instead of repeated truncated source summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-decisions-compact-"));
    const workerDir = join(root, "critic-mock");
    const featureDir = join(root, "features", "0010");

    await mkdir(workerDir, { recursive: true });
    await mkdir(featureDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), [
      "APPROVED",
      "",
      "## Blocking Findings",
      "None.",
      "",
      "Critic findings:",
      "(empty)"
    ].join("\n"));
    await writeFile(join(featureDir, "decisions.md"), [
      "# Decisions",
      "",
      "Feature: 0010",
      "Turn: 0010",
      "",
      "Supervisor summary:",
      "Complex task completed.",
      "",
      "Requirements:",
      "# 需求说明：俄罗斯方块浏览器游戏",
      "- 当前代码已经有游戏模块雏形：",
      "- `src/game/engine.mjs`",
      "",
      "Actor work:",
      "# Actor Feature Worklog",
      "## User Request",
      "设置速度",
      "- `src/ui/storage.mjs`",
      "  - Added validat...",
      "",
      "Critic review:",
      "# Critic Review - Feature 0010",
      "",
      "APPROVED",
      "",
      "## Blocking Findings",
      "",
      "None.",
      "",
      "## Evidence",
      "- Storage, smoke coverage, and unit tests cover speed persistence.",
      "",
      "## Verification",
      "- `npm test` passed: 30/30 tests.",
      "- `n...",
      "",
      "Critic findings:",
      "(empty)"
    ].join("\n"));
    await writeFile(join(workerDir, "output.log"), "process tail\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={32}
      />
    );

    try {
      await waitForFrame(lastFrame, "Summary: done");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("file · 0010/decisions.md");
      expect(frame).not.toContain("review.md");
      expect(frame).not.toMatch(/\n\s+Decisions\n/);
      expect(frame).toContain("Feature 0010");
      expect(frame).toContain("Summary: done");
      expect(frame).not.toContain("Critic Review - Feature 0010");
      expect(frame).toContain("Review: approved");
      expect(frame).toContain("Blocking: none");
      expect(frame).toContain("Findings: none");
      expect(frame).toContain("process tail");
      expect(frame).not.toContain("Supervisor summary:\n");
      expect(frame).not.toContain("Critic review:\n");
      expect(frame).not.toContain("Critic review:\n\nAPPROVED");
      expect(frame).not.toContain("Critic Review - Feature 0010\n\nAPPROVED");
      expect(frame).not.toContain("Blocking Findings\n");
      expect(frame).not.toContain("Blocking Findings\n\nNone.");
      expect(frame).not.toContain("Critic findings\n");
      expect(frame.match(/Review: approved/g)).toHaveLength(1);
      expect(frame).not.toContain("需求说明");
      expect(frame).not.toContain("Actor Feature Worklog");
      expect(frame).not.toContain("User Request");
      expect(frame).not.toContain("Added validat");
      expect(frame).not.toContain("Storage, smoke coverage");
      expect(frame).not.toContain("n...");
      expect(frame).not.toContain("| Feature: 0010");
      expect(frame).not.toContain("| Turn: 0010");
    } finally {
      unmount();
    }
  });

  it("keeps historical decision reviews short when they include long critic context sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-decisions-review-short-"));
    const workerDir = join(root, "critic-mock");
    const featureDir = join(root, "features", "0005");

    await mkdir(workerDir, { recursive: true });
    await mkdir(featureDir, { recursive: true });
    await writeFile(join(featureDir, "decisions.md"), [
      "# Decisions",
      "",
      "Feature: 0005",
      "Turn: 0005",
      "",
      "Supervisor summary:",
      "Complex task completed.",
      "",
      "Requirements:",
      "# Large requirements should not be repeated.",
      "",
      "Actor work:",
      "# Actor Worklog should not be repeated.",
      "",
      "Critic review:",
      "# Critic Review — Turn 0005",
      "",
      "**Verdict:** APPROVED",
      "",
      "## User Request",
      "",
      "`继续优化` — Keep optimizing.",
      "",
      "## Actor Behavior — What Changed",
      "",
      "The actor changed a long list of files.",
      "",
      "## Evidence",
      "",
      "- Long source-review details.",
      "",
      "Critic findings:",
      "(empty)"
    ].join("\n"));
    await writeFile(join(workerDir, "output.log"), "process tail\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={28}
      />
    );

    try {
      await waitForFrame(lastFrame, "Critic Review — Turn 0005");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Summary: done");
      expect(frame).toContain("Critic Review — Turn 0005");
      expect(frame).toContain("Verdict: APPROVED");
      expect(frame).toContain("Findings: none");
      expect(frame).toContain("process tail");
      expect(frame).not.toContain("Large requirements");
      expect(frame).not.toContain("Actor Worklog");
      expect(frame).not.toContain("User Request");
      expect(frame).not.toContain("Keep optimizing");
      expect(frame).not.toContain("Actor Behavior");
      expect(frame).not.toContain("Long source-review details");
    } finally {
      unmount();
    }
  });

  it("renders markdown, jsonl, ansi, commands, and diff lines as readable log rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      [
        "# Worklog",
        "",
        "- Implemented board controls.",
        "- Added tests.",
        "",
        "```ts",
        "const score = 10;",
        "```"
      ].join("\n")
    );
    await writeFile(
      join(workerDir, "actor-replies.jsonl"),
      "{\"to\":\"critic\",\"message\":\"Fixed missing input test\",\"severity\":\"info\"}\n"
    );
    await writeFile(
      join(workerDir, "patch.diff"),
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-removed line",
        "+added line",
        " context line"
      ].join("\n")
    );
    await writeFile(
      join(workerDir, "output.log"),
      ["\u001b[32m$ npm test\u001b[39m", "✓ tests passed", "Error: one flaky assertion"].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "Implemented board controls.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Worklog");
      expect(frame).not.toContain("# Worklog");
      expect(frame).toContain("file · worklog.md");
      expect(frame).toContain("• Implemented board controls.");
      expect(frame).toContain("[info] to critic");
      expect(frame).toContain("Fixed missing input test");
      expect(frame).not.toContain("{\"to\":\"critic\"");
      expect(frame).toContain("● Update(src/a.ts)");
      expect(frame).toContain("└ Added 1 line, removed 1 line");
      expect(frame).toContain("  1 - removed line");
      expect(frame).toContain("  1 + added line");
      expect(frame).toContain("  2   context line");
      expect(frame).not.toContain("file |");
      expect(frame).not.toContain("hunk |");
      expect(frame).not.toContain("+    |");
      expect(frame).not.toContain("-    |");
      expect(frame).not.toContain("file src/a.ts");
      expect(frame).not.toContain("hunk @@");
      expect(frame).not.toContain("diff --git");
      expect(frame).not.toContain("index 1111111");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("tests passed");
      expect(frame).toContain("error · one flaky assertion");
      expect(frame).not.toContain("cmd  |");
      expect(frame).not.toContain("ok   |");
      expect(frame).not.toContain("err  |");
      expect(frame).not.toContain("item |");
      expect(frame).not.toContain("code |");
      expect(frame).not.toContain("json |");
      expect(frame).not.toContain("msg  |");
      expect(frame).not.toContain("\u001b[32m");
    } finally {
      unmount();
    }
  });

  it("strips stray carriage-return control characters from rendered rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-carriage-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "worklog.md"), "npm test passed.\r\n");
    await writeFile(join(workerDir, "output.log"), "process ok\r\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "npm test passed.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("npm test passed.");
      expect(frame).toContain("process ok");
      expect(frame).not.toContain("\r");
    } finally {
      unmount();
    }
  });

  it("renders markdown list items containing failure words as lists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-list-failure-word-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      "- Added failing input assertions first; `node --test test/input.test.mjs` failed before the fix.\n"
    );
    await writeFile(join(workerDir, "output.log"), "process ok\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "Added failing input assertions");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("• Added failing input assertions first; node --test test/input.test.mjs failed before the fix.");
      expect(frame).not.toContain("- Added failing input assertions");
      expect(frame).not.toContain("`node --test");
    } finally {
      unmount();
    }
  });

  it("keeps artifact prose about expected red tests from rendering as current errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-artifact-failed-prose-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      [
        "## TDD Record",
        "Wrote tests first. The focused unit tests failed on missing speed APIs, and the smoke test failed on missing #speedInput. After implementation, the focused tests and smoke test passed."
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "process ok\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={14}
      />
    );

    try {
      await waitForFrame(lastFrame, "Wrote tests first.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("TDD Record");
      expect(frame).toContain("Wrote tests first. The focused unit tests failed on missing speed APIs");
      expect(frame).not.toContain("error · Wrote tests first");
    } finally {
      unmount();
    }
  });

  it("compacts empty critic findings inside actor worklogs into a quiet review line", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-actor-empty-findings-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      [
        "## Verification",
        "npm test passed.",
        "",
        "## Critic Findings",
        "No active Critic findings were present for this feature; `critic-findings.jsonl` is empty."
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "process ok\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={14}
      />
    );

    try {
      await waitForFrame(lastFrame, "Findings: none");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Verification");
      expect(frame).toContain("npm test passed.");
      expect(frame).toContain("Findings: none");
      expect(frame).not.toMatch(/\n\s+Critic Findings\n/);
    } finally {
      unmount();
    }
  });

  it("compacts verification bullet lists into one readable artifact summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-verification-summary-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      [
        "## Verification",
        "- `node --test test/scoring.test.mjs test/engine.test.mjs test/storage.test.mjs` passed, 18/18.",
        "- `npm test` passed, 30/30.",
        "- `npm run smoke` passed.",
        "- `npm run build` passed.",
        "- `npm run dev` could not bind a port in this sandbox and produced the static `dist/` fallback.",
        "",
        "## Critic Findings",
        "No active Critic findings were present for this feature; `critic-findings.jsonl` is empty."
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "process ok\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={14}
      />
    );

    try {
      await waitForFrame(lastFrame, "Verification: unit 18/18");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback");
      expect(frame).toContain("Findings: none");
      expect(frame).not.toContain("• npm test passed");
      expect(frame).not.toContain("npm run dev could not bind");
    } finally {
      unmount();
    }
  });

  it("indents file change descriptions under their file list item", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-file-list-detail-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      [
        "## Files Changed",
        "- index.html",
        "- Added a Speed settings panel with range input.",
        "- src/main.mjs",
        "- Wires speed input/reset to the game engine.",
        "- src/ui/storage.mjs - added validated piece color helpers.",
        "- test/scoring.test.mjs, test/engine.test.mjs, scripts/smoke-test.mjs",
        "- Added coverage for speed math and UI wiring.",
        "- npm test passed"
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "process ok\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={18}
      />
    );

    try {
      await waitForFrame(lastFrame, "Wires speed input");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("• index.html");
      expect(frame).toContain("   Added a Speed settings panel with range input.");
      expect(frame).toContain("• src/main.mjs");
      expect(frame).toContain("   Wires speed input/reset to the game engine.");
      expect(frame).toContain("• src/ui/storage.mjs");
      expect(frame).toContain("   added validated piece color helpers.");
      expect(frame).toContain("• test/scoring.test.mjs, test/engine.test.mjs, scripts/smoke-test.mjs");
      expect(frame).toContain("   Added coverage for speed math and UI wiring.");
      expect(frame).toContain("   npm test passed");
      expect(frame).not.toContain("• Added a Speed settings panel");
      expect(frame).not.toContain("• Wires speed input/reset");
      expect(frame).not.toContain("   test/scoring.test.mjs, test/engine.test.mjs");
      expect(frame).not.toContain("src/ui/storage.mjs - added");
    } finally {
      unmount();
    }
  });

  it("renders common worker section labels as headings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-section-headings-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "worklog.md"),
      [
        "Task",
        "Implement speed controls.",
        "",
        "User Request",
        "设置速度",
        "",
        "Summary",
        "Added a saved speed setting.",
        "",
        "Files Changed:",
        "- index.html",
        "- Added a Speed settings panel.",
        "",
        "代码质量验收：",
        "核心规则不写在渲染函数中。",
        "",
        "任务 7：测试和烟测补强",
        "运行 npm test。",
        "",
        "Code quality",
        "No game rules leaked into DOM handlers.",
        "",
        "Risks",
        "None blocking.",
        "",
        "Where things are written",
        "- review.md"
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "process ok\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "Added a saved speed setting.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Task");
      expect(frame).toContain("User Request");
      expect(frame).toContain("Summary");
      expect(frame).toContain("Files Changed");
      expect(frame).toContain("代码质量验收");
      expect(frame).toContain("任务 7：测试和烟测补强");
      expect(frame).toContain("Code quality");
      expect(frame).toContain("Risks");
      expect(frame).toContain("Where things are written");
      expect(workerOutputLineTheme("heading")).toMatchObject({ bold: true });
      expect(frame).toContain("   Added a Speed settings panel.");
      expect(frame).not.toContain("Files Changed:");
      expect(frame).not.toContain("代码质量验收：");
    } finally {
      unmount();
    }
  });

  it("renders common markdown blocks instead of raw markdown syntax", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-md-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "requirements.md"),
      [
        "# Requirements",
        "",
        "Use `npm test` and **keep output readable**. See [docs](https://example.test).",
        "Open [worklog.md](/tmp/worklog.md:1) and [dist page](file:///workspace/tetris/dist/index.html).",
        "",
        "- [x] Parse task list",
        "- [ ] Render table",
        "1. Read files",
        "2. Update renderer",
        "",
        "> Critic should see readable notes.",
        "",
        "| Area | Status | Owner |",
        "| --- | --- | --- |",
        "| Logs | Improved | Actor |",
        "| Long markdown column | OK | Critic |",
        "",
        "```bash",
        "npm test",
        "npm run build",
        "```",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "---"
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "judge transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (mock) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "Requirements");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Use npm test and keep output readable. See docs <https://example.test>.");
      expect(frame).toContain("Open worklog.md and dist page.");
      expect(frame).toContain("☑ Parse task list");
      expect(frame).toContain("☐ Render table");
      expect(frame).toContain("1. Read files");
      expect(frame).toContain("2. Update renderer");
      expect(frame).toContain("Critic should see readable notes.");
      expect(frame).toContain("Area");
      expect(frame).toContain("Status");
      expect(frame).toContain("Owner");
      expect(frame).toContain("Logs");
      expect(frame).toContain("Improved");
      expect(frame).toContain("Long markdown column  OK        Critic");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("$ npm run build");
      expect(frame).toContain("| const x = 1;");
      expect(frame).toContain("────");
      expect(frame).not.toContain("`npm test`");
      expect(frame).not.toContain("**keep output readable**");
      expect(frame).not.toContain("/tmp/worklog.md");
      expect(frame).not.toContain("file:///workspace");
      expect(frame).not.toContain("| --- | --- |");
      expect(frame).not.toContain("| npm test");
    } finally {
      unmount();
    }
  });

  it("renders diff blocks embedded in process output as concise structured summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-process-diff-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "npm run build passed",
        "diff --git a/.parallel-codex/sessions/task-1/critic-codex/review.md b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "index 1111111..2222222 100644",
        "--- a/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "+++ b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "@@ -0,0 +1,5 @@",
        "+# Critic Review",
        "+",
        "+APPROVED",
        "+- Evidence item",
        "done after diff"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "done after diff");

      const frame = lastFrame() ?? "";
      expect(frame).toMatch(/npm run build passed\n\s*\n\s*· diff 1 file · \+4/);
      expect(frame).toContain("· diff 1 file · +4 · review.md");
      expect(frame).toContain("done after diff");
      expect(frame).not.toContain("● Update(review.md)");
      expect(frame).not.toContain("└ Added 4 lines");
      expect(frame).not.toContain("  1 + # Critic Review");
      expect(frame).not.toContain("  3 + APPROVED");
      expect(frame).not.toContain("  4 + - Evidence item");
      expect(frame).not.toContain(".parallel-codex/sessions/task-1");
      expect(frame).not.toContain("hunk @@");
      expect(frame).not.toContain("diff --git");
      expect(frame).not.toContain("index 1111111");
      expect(frame).not.toContain("--- a/.parallel-codex");
      expect(frame).not.toContain("+++ b/.parallel-codex");
    } finally {
      unmount();
    }
  });

  it("renders diff -u process blocks with the same structured diff layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-process-unified-diff-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "before unified diff",
        "diff -u a/src/game/engine.mjs b/src/game/engine.mjs",
        "--- a/src/game/engine.mjs",
        "+++ b/src/game/engine.mjs",
        "@@ -2,3 +2,4 @@",
        " const before = true;",
        "-const speed = 5;",
        "+const speed = 8;",
        "+const saved = loadSpeed();",
        " const after = true;",
        "after unified diff"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={30}
      />
    );

    try {
      await waitForFrame(lastFrame, "after unified diff");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("before unified diff");
      expect(frame).toContain("· diff 1 file · +2 · -1 · src/game/engine.mjs");
      expect(frame).toContain("after unified diff");
      expect(frame).not.toContain("● Update(src/game/engine.mjs)");
      expect(frame).not.toContain("└ Added 2 lines, removed 1 line");
      expect(frame).not.toContain("  3 - const speed = 5;");
      expect(frame).not.toContain("  3 + const speed = 8;");
      expect(frame).not.toContain("  4 + const saved = loadSpeed();");
      expect(frame).not.toContain("diff -u a/src/game/engine.mjs");
      expect(frame).not.toContain("--- a/src/game/engine.mjs");
      expect(frame).not.toContain("+++ b/src/game/engine.mjs");
    } finally {
      unmount();
    }
  });

  it("collapses large process diffs into file summaries instead of orphaning patch bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-large-process-diff-"));
    const workerDir = join(root, "critic-mock");
    const diffLines: string[] = ["before large diff"];

    for (let fileIndex = 1; fileIndex <= 5; fileIndex += 1) {
      diffLines.push(
        `diff -u a/src/file-${fileIndex}.mjs b/src/file-${fileIndex}.mjs`,
        `--- a/src/file-${fileIndex}.mjs`,
        `+++ b/src/file-${fileIndex}.mjs`,
        "@@ -1,1 +1,11 @@",
        " const existing = true;"
      );
      for (let lineIndex = 1; lineIndex <= 10; lineIndex += 1) {
        diffLines.push(`+const added${fileIndex}_${lineIndex} = ${lineIndex};`);
      }
    }
    diffLines.push(' console.log("Smoke test passed: app boots.");');
    diffLines.push("after large diff");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "output.log"), diffLines.join("\n"));

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={28}
      />
    );

    try {
      await waitForFrame(lastFrame, "after large diff");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("before large diff");
      expect(frame).toContain("· diff 5 files · +50 · src/file-1.mjs, src/file-2.mjs, src/file-3.mjs, src/file-4.mjs, +1 more");
      expect(frame).toContain("after large diff");
      expect(frame).not.toContain("● Update(src/file-1.mjs)");
      expect(frame).not.toContain("└ Added 10 lines");
      expect(frame).not.toContain("● Update(src/file-5.mjs)");
      expect(frame).not.toContain("const added1_1");
      expect(frame).not.toContain("const added5_10");
      expect(frame).not.toContain("console.log(\"Smoke test passed");
      expect(frame).not.toContain("diff -u a/src/file-1.mjs");
      expect(frame).not.toContain("--- a/src/file-1.mjs");
      expect(frame).not.toContain("+++ b/src/file-1.mjs");
    } finally {
      unmount();
    }
  });

  it("drops bare process diff body fragments that have lost their headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-bare-diff-body-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "before bare body",
        '-import { getDropInterval } from "../src/game/scoring.mjs";',
        '+import { getSpeedAdjustedDropInterval } from "../src/game/scoring.mjs";',
        "after bare body"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "after bare body");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("before bare body");
      expect(frame).toContain("after bare body");
      expect(frame).not.toContain("getDropInterval");
      expect(frame).not.toContain("getSpeedAdjustedDropInterval");
      expect(frame).not.toContain("| -import");
      expect(frame).not.toContain("+import");
    } finally {
      unmount();
    }
  });

  it("drops single bare process diff body lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-single-bare-diff-body-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "before single bare body",
        '+import { getSpeedAdjustedDropInterval } from "./scoring.mjs";',
        "after single bare body"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "after single bare body");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("before single bare body");
      expect(frame).toContain("after single bare body");
      expect(frame).not.toContain("getSpeedAdjustedDropInterval");
      expect(frame).not.toContain("+import");
    } finally {
      unmount();
    }
  });

  it("drops short process code fragments immediately before another diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-code-tail-before-diff-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "before code tail",
        "Collapsed code output: 4 lines",
        " renderer.render(game.getState());",
        "+applySpeedSetting(speedSetting);",
        " requestAnimationFrame(loop);",
        "diff -u a/src/game/scoring.mjs b/src/game/scoring.mjs",
        "--- a/src/game/scoring.mjs",
        "+++ b/src/game/scoring.mjs",
        "@@ -1,1 +1,2 @@",
        " const existing = true;",
        "+const added = true;",
        "after code tail"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={16}
      />
    );

    try {
      await waitForFrame(lastFrame, "after code tail");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("before code tail");
      expect(frame).toContain("· diff 1 file · +1 · src/game/scoring.mjs");
      expect(frame).toContain("after code tail");
      expect(frame).not.toContain("Collapsed code output: 4 lines");
      expect(frame).not.toContain("renderer.render");
      expect(frame).not.toContain("applySpeedSetting");
      expect(frame).not.toContain("requestAnimationFrame");
    } finally {
      unmount();
    }
  });

  it("removes collapsed code summaries sandwiched between process diff summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-diff-code-summary-sandwich-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "diff -u a/src/one.mjs b/src/one.mjs",
        "--- a/src/one.mjs",
        "+++ b/src/one.mjs",
        "@@ -1,1 +1,2 @@",
        " const existing = true;",
        "+const one = true;",
        "Collapsed code output: 4 lines",
        "diff -u a/src/two.mjs b/src/two.mjs",
        "--- a/src/two.mjs",
        "+++ b/src/two.mjs",
        "@@ -1,1 +1,2 @@",
        " const existing = true;",
        "+const two = true;"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "src/two.mjs");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· diff 1 file · +1 · src/one.mjs");
      expect(frame).toContain("· diff 1 file · +1 · src/two.mjs");
      expect(frame).not.toContain("Collapsed code output: 4 lines");

      const lines = frame.split("\n");
      const firstDiff = lines.findIndex((line) => line.includes("· diff 1 file · +1 · src/one.mjs"));
      const secondDiff = lines.findIndex((line) => line.includes("· diff 1 file · +1 · src/two.mjs"));
      expect(firstDiff).toBeGreaterThanOrEqual(0);
      expect(secondDiff).toBe(firstDiff + 1);
    } finally {
      unmount();
    }
  });

  it("hides patch.diff readback command rows when diff summaries already show the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-patch-readback-noise-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"sed -n '1,520p' .parallel-codex/sessions/task-1/actor-codex/patch.diff\" in /tmp/project",
        "succeeded in 0ms:",
        "diff -u a/src/main.mjs b/src/main.mjs",
        "--- a/src/main.mjs",
        "+++ b/src/main.mjs",
        "@@ -1,1 +1,2 @@",
        " const existing = true;",
        "+const added = true;",
        "exec",
        "/bin/zsh -lc \"npm test\" in /tmp/project",
        "succeeded in 12ms:",
        "17 tests passed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={18}
      />
    );

    try {
      await waitForFrame(lastFrame, "17 tests passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· diff 1 file · +1 · src/main.mjs");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("· ok 12ms");
      expect(frame).toContain("17 tests passed");
      expect(frame).not.toContain("$ sed -n");
      expect(frame).not.toContain("patch.diff");
      expect(frame).not.toMatch(/^\s+· ok 0ms\s*$/m);
    } finally {
      unmount();
    }
  });

  it("omits process diff summaries when only no-change fragments remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-no-change-diff-fragment-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "before no-change diff",
        "diff -u a/test/scoring.test.mjs b/test/scoring.test.mjs",
        "--- a/test/scoring.test.mjs",
        "+++ b/test/scoring.test.mjs",
        "@@ -1,2 +1,2 @@",
        " import assert from \"node:assert/strict\";",
        " import test from \"node:test\";",
        "after no-change diff"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "after no-change diff");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("before no-change diff");
      expect(frame).toContain("after no-change diff");
      expect(frame).not.toContain("Update(test/scoring.test.mjs)");
      expect(frame).not.toContain("No line changes");
      expect(frame).not.toContain("diff -u");
    } finally {
      unmount();
    }
  });

  it("hides process diff blocks that duplicate rendered worker artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-dedupe-diff-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "review.md"),
      [
        "# Critic Review",
        "",
        "APPROVED",
        "",
        "Verified speed controls."
      ].join("\n")
    );
    await writeFile(
      join(workerDir, "output.log"),
      [
        "diff --git a/.parallel-codex/sessions/task-1/critic-codex/review.md b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "index 1111111..2222222 100644",
        "--- a/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "+++ b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "@@ -0,0 +1,5 @@",
        "+# Critic Review",
        "+",
        "+APPROVED",
        "+Verified speed controls.",
        "done after duplicated artifact diff"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={30}
      />
    );

    try {
      await waitForFrame(lastFrame, "done after duplicated artifact diff");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Review: approved");
      expect(frame).toContain("done after duplicated artifact diff");
      expect(frame).not.toContain("● Update(review.md)");
      expect(frame).not.toContain("  1 + # Critic Review");
      expect(frame).not.toContain("diff --git");
    } finally {
      unmount();
    }
  });

  it("compacts blank lines left behind by hidden process blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-hidden-block-blanks-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "before duplicate block",
        "",
        "",
        "diff --git a/.parallel-codex/sessions/task-1/critic-codex/review.md b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "index 1111111..2222222 100644",
        "--- a/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "+++ b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "@@ -0,0 +1,1 @@",
        "+APPROVED",
        "",
        "",
        "after duplicate block"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after duplicate block");

      const lines = (lastFrame() ?? "").split("\n");
      const beforeIndex = lines.findIndex((line) => line.includes("before duplicate block"));
      const afterIndex = lines.findIndex((line) => line.includes("after duplicate block"));
      const blankRows = lines.slice(beforeIndex + 1, afterIndex).filter((line) => line.trim() === "");
      const maxBlankRun = lines.reduce(
        (state, line) => {
          const current = line.trim() === "" ? state.current + 1 : 0;
          return {
            current,
            max: Math.max(state.max, current)
          };
        },
        { current: 0, max: 0 }
      ).max;

      expect(beforeIndex).toBeGreaterThanOrEqual(0);
      expect(afterIndex).toBeGreaterThan(beforeIndex);
      expect(blankRows).toHaveLength(1);
      expect(maxBlankRun).toBeLessThanOrEqual(1);
    } finally {
      unmount();
    }
  });

  it("hides bare unified diff hunks when artifacts already summarize the work", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-bare-hunk-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\nNo blockers.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "@@ -0,0 +1,8 @@",
        "+# Critic Review",
        "+",
        "+APPROVED",
        "+- npm test passed",
        "+- npm run smoke passed",
        "after bare hunk"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "after bare hunk");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("APPROVED");
      expect(frame).toContain("after bare hunk");
      expect(frame).not.toContain("@@ -0,0");
      expect(frame).not.toContain("Critic Review");
      expect(frame).not.toContain("npm test passed");
    } finally {
      unmount();
    }
  });

  it("does not let process markdown fences turn later duplicate diffs into code", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-process-fence-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\nNo blockers.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "```dot",
        "digraph skill_flow {",
        "  start -> end",
        "}",
        "diff --git a/.parallel-codex/sessions/task-1/critic-codex/review.md b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "index 1111111..2222222 100644",
        "--- a/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "+++ b/.parallel-codex/sessions/task-1/critic-codex/review.md",
        "@@ -0,0 +1,4 @@",
        "+APPROVED",
        "+- npm test passed",
        "after fenced duplicate diff"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={25}
      />
    );

    try {
      await waitForFrame(lastFrame, "after fenced duplicate diff");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("APPROVED");
      expect(frame).toContain("after fenced duplicate diff");
      expect(frame).not.toContain("| +- npm test passed");
      expect(frame).not.toContain("diff --git");
      expect(frame).not.toContain("```dot");
    } finally {
      unmount();
    }
  });

  it("hides process readback commands for artifacts that are already rendered", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-artifact-readback-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\nRole artifact only.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"sed -n '1,240p' .parallel-codex/sessions/task-1/critic-codex/review.md\" in /tmp/project",
        "succeeded in 0ms:",
        "Critic Review - Feature 0010",
        "PROCESS DUPLICATE SHOULD BE HIDDEN",
        "exec",
        "/bin/zsh -lc 'npm test' in /tmp/project",
        "succeeded in 12ms:",
        "17 tests passed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "17 tests passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("APPROVED");
      expect(frame).toContain("Role artifact only.");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("17 tests passed");
      expect(frame).not.toContain("$ sed -n");
      expect(frame).not.toContain("Critic Review - Feature 0010");
      expect(frame).not.toContain("PROCESS DUPLICATE SHOULD BE HIDDEN");
    } finally {
      unmount();
    }
  });

  it("hides session metadata probes and standalone spinner noise from process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-session-probes-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "⠙",
        "exec",
        "/bin/zsh -lc 'wc -c .parallel-codex/sessions/task-1/features/0010/critic-findings.jsonl' in /tmp/project",
        "succeeded in 0ms:",
        "0 .parallel-codex/sessions/task-1/features/0010/critic-findings.jsonl",
        "exec",
        "/bin/zsh -lc \"find .parallel-codex/sessions/task-1/critic-codex -maxdepth 1 -type f -print -exec ls -l {} \\;\" in /tmp/project",
        "succeeded in 0ms:",
        ".parallel-codex/sessions/task-1/critic-codex/native-session.json",
        "-rw-r--r-- 1 user staff 328 native-session.json",
        "exec",
        "/bin/zsh -lc 'npm test' in /tmp/project",
        "succeeded in 12ms:",
        "17 tests passed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "17 tests passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("APPROVED");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("17 tests passed");
      expect(frame).not.toContain("⠙");
      expect(frame).not.toContain("$ wc -c");
      expect(frame).not.toContain("$ find .parallel-codex");
      expect(frame).not.toContain("critic-findings.jsonl");
      expect(frame).not.toContain("native-session.json");
    } finally {
      unmount();
    }
  });

  it("hides readback commands for session system files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-session-readbacks-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "requirements.md"), "Build falling blocks.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"sed -n '1,240p' /tmp/project/.parallel-codex/sessions/task-1/judge-codex/prompt.md\" in /tmp/project",
        "succeeded in 0ms:",
        "# Role: Judge",
        "Prompt text should be hidden",
        "exec",
        "/bin/zsh -lc \"sed -n '1,200p' /tmp/project/.parallel-codex/sessions/task-1/meta.json\" in /tmp/project",
        "succeeded in 0ms:",
        "{",
        "\"id\": \"task-1\",",
        "\"title\": \"做个俄罗斯方块的游戏\"",
        "}",
        "exec",
        "/bin/zsh -lc \"sed -n '1,200p' /tmp/project/.parallel-codex/sessions/task-1/user-request.md\" in /tmp/project",
        "succeeded in 0ms:",
        "做个俄罗斯方块的游戏",
        "exec",
        "/bin/zsh -lc 'rg -n \"TBD\" .parallel-codex/sessions/task-1/judge-codex/requirements.md' in /tmp/project",
        "exited 1 in 0ms:",
        "tokens used",
        "83,550",
        "已在 worker 目录写好 5 个任务文件：",
        "",
        "- [requirements.md](/tmp/requirements.md)",
        "- [plan.md](/tmp/plan.md)",
        "",
        "我只写了任务文档，没有实现代码。已用 `ls` 和 `wc -l` 确认文件存在。"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "no matches 0ms");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Build falling blocks.");
      expect(frame).toContain("· no matches 0ms · TODO markers");
      expect(frame).not.toContain("$ rg -n");
      expect(frame).not.toContain("prompt.md");
      expect(frame).not.toContain("meta.json");
      expect(frame).not.toContain("user-request.md");
      expect(frame).not.toContain("Prompt text should be hidden");
      expect(frame).not.toContain("\"title\"");
      expect(frame).not.toContain("做个俄罗斯方块的游戏");
    } finally {
      unmount();
    }
  });

  it("hides process readbacks for internal task collaboration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-task-doc-readbacks-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\nNo blockers.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"sed -n '1,260p' .parallel-codex/sessions/task-1/features/0010/spec.md\" in /tmp/project",
        "succeeded in 0ms:",
        "Feature Mailbox",
        "Protocol:",
        "- Actor writes implementation notes to actor-worklog.md.",
        "exec",
        "/bin/zsh -lc \"sed -n '1,320p' .parallel-codex/sessions/task-1/features/0010/actor-worklog.md\" in /tmp/project",
        "succeeded in 0ms:",
        "Actor Feature Worklog",
        "Files Changed",
        "- src/main.mjs",
        "exec",
        "/bin/zsh -lc \"sed -n '1,260p' .parallel-codex/sessions/task-1/actor-codex/worklog.md\" in /tmp/project",
        "succeeded in 0ms:",
        "Actor Worklog",
        "Project Files Reviewed",
        "- index.html",
        "exec",
        "/bin/zsh -lc 'npm test' in /tmp/project",
        "succeeded in 12ms:",
        "17 tests passed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "17 tests passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("APPROVED");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("· ok 12ms");
      expect(frame).toContain("17 tests passed");
      expect(frame).not.toContain("features/0010/spec.md");
      expect(frame).not.toContain("features/0010/actor-worklog.md");
      expect(frame).not.toContain("actor-codex/worklog.md");
      expect(frame).not.toContain("Feature Mailbox");
      expect(frame).not.toContain("Actor Feature Worklog");
      expect(frame).not.toContain("Actor Worklog");
      expect(frame).not.toContain("Project Files Reviewed");
    } finally {
      unmount();
    }
  });

  it("hides process readback commands for Codex skill documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-skill-readback-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "requirements.md"), "Build the game.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"sed -n '1,220p' /Users/me/.codex/plugins/cache/openai-api-curated/superpowers/skills/verification-before-completion/SKILL.md\" in /tmp/project",
        "succeeded in 0ms:",
        "name: verification-before-completion",
        "The Bottom Line",
        "No shortcuts for verification.",
        "exec",
        "/bin/zsh -lc 'rg -n \"TBD\" .parallel-codex/sessions/task-1/judge-codex/requirements.md' in /tmp/project",
        "exited 1 in 0ms:",
        ""
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "Build the game.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Build the game.");
      expect(frame).toContain("· no matches 0ms · TODO markers");
      expect(frame).not.toContain("$ rg -n");
      expect(frame).not.toContain("$ sed -n");
      expect(frame).not.toContain("SKILL.md");
      expect(frame).not.toContain("verification-before-completion");
      expect(frame).not.toContain("The Bottom Line");
      expect(frame).not.toContain("No shortcuts for verification.");
    } finally {
      unmount();
    }
  });

  it("hides assistant narrative transcript blocks when artifacts already summarize the work", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-narrative-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\nNo blockers.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "codex",
        "Blocking findings: none.",
        "",
        "Wrote APPROVED review to review.md.",
        "",
        "The required commands passed fresh: 30 tests, smoke, and build.",
        "",
        "✓ Read judge specs and feature context",
        "✓ Inspect actor patch and replies",
        "",
        "Verified:",
        "- npm test passed",
        "",
        "exec",
        "/bin/zsh -lc 'npm test' in /tmp/project",
        "succeeded in 0ms:",
        "17 tests passed",
        "tokens used",
        "196,931",
        "Blocking findings: none.",
        "",
        "Wrote `APPROVED` review to [review.md](/tmp/review.md:1).",
        "",
        "Verified:",
        "- `npm test` passed, 30/30"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={30}
      />
    );

    try {
      await waitForFrame(lastFrame, "17 tests passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("APPROVED");
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("· ok 0ms");
      expect(frame).toContain("17 tests passed");
      expect(frame).not.toContain("exec");
      expect(frame).not.toContain("/bin/zsh -lc");
      expect(frame).not.toContain("Blocking findings: none.");
      expect(frame).not.toContain("required commands passed fresh");
      expect(frame).not.toContain("Read judge specs");
      expect(frame).not.toContain("Inspect actor patch");
      expect(frame).not.toContain("Wrote APPROVED review");
      expect(frame).not.toContain("Wrote `APPROVED` review");
      expect(frame).not.toContain("Verified:");
      expect(frame).not.toContain("30/30");
      expect(frame).not.toContain("• npm test passed");
    } finally {
      unmount();
    }
  });

  it("hides Claude critic completion prose when a review artifact exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-claude-narrative-"));
    const workerDir = join(root, "critic-claude");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "# Critic Review\n\nAPPROVED\nNo blockers.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ claude --print --permission-mode acceptEdits --output-format text",
        "I've completed the critic review for turn 0005.",
        "",
        "## Verdict: **APPROVED**",
        "",
        "### What I checked",
        "The Actor answered `继续优化` with a focused UX fix.",
        "",
        "### Evidence",
        "- `src/ui/input.mjs:42-52` updates help text.",
        "",
        "I was unable to re-run `npm test` because bash approval gates those in this reviewer sandbox."
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (claude) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "Review: approved");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Review: approved");
      expect(frame).not.toContain("$ claude --print");
      expect(frame).not.toMatch(/\n\s+process\s*$/);
      expect(frame).not.toContain("I've completed the critic review");
      expect(frame).not.toContain("What I checked");
      expect(frame).not.toContain("The Actor answered");
      expect(frame).not.toContain("approval gates");
    } finally {
      unmount();
    }
  });

  it("hides judge completion narrative when role artifacts already summarize it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-judge-narrative-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "requirements.md"), "Requirements are written.\n");
    await writeFile(join(workerDir, "plan.md"), "Plan is written.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "codex",
        "已在 worker 目录写好 5 个任务文件：",
        "",
        "- requirements.md",
        "- plan.md",
        "- acceptance.md",
        "",
        "我只写了任务文档，没有实现代码。已用 ls 和 wc -l 确认文件存在。",
        "",
        "exec",
        "/bin/zsh -lc 'rg -n \"TBD\" .parallel-codex/sessions/task-1/judge-codex/requirements.md' in /tmp/project",
        "exited 1 in 0ms:",
        "tokens used",
        "83,550",
        "已在 worker 目录写好 5 个任务文件：",
        "",
        "- [requirements.md](/tmp/requirements.md)",
        "- [plan.md](/tmp/plan.md)",
        "",
        "我只写了任务文档，没有实现代码。已用 `ls` 和 `wc -l` 确认文件存在。"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "no matches 0ms");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Requirements are written.");
      expect(frame).toContain("Plan is written.");
      expect(frame).toContain("· no matches 0ms · TODO markers");
      expect(frame).not.toContain("$ rg -n");
      expect(frame).not.toContain("已在 worker 目录写好");
      expect(frame).not.toContain("我只写了任务文档");
      expect(frame).not.toContain("/tmp/requirements.md");
      expect(frame).not.toContain("acceptance.md");
    } finally {
      unmount();
    }
  });

  it("renders codex exec transcript pairs as clean command lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-exec-command-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"npm test\" in /tmp/project",
        "succeeded in 12ms:",
        "17 tests passed",
        "exec",
        "/bin/zsh -lc 'npm run smoke' in /tmp/project",
        "failed in 4ms:",
        "Error: smoke failed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "smoke failed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("$ npm test");
      expect(frame).toContain("· ok 12ms");
      expect(frame).toContain("17 tests passed");
      expect(frame).toContain("$ npm run smoke");
      expect(frame).toContain("· fail 4ms");
      expect(frame).toContain("error · smoke failed");
      expect(frame).not.toContain("\n  exec");
      expect(frame).not.toContain("/bin/zsh -lc");
      expect(frame).not.toContain("in /tmp/project");
    } finally {
      unmount();
    }
  });

  it("hides npm lifecycle echo lines while keeping command results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-npm-echo-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"npm run build\" in /tmp/project",
        "succeeded in 372ms:",
        "",
        "> falling-blocks-puzzle@1.0.0 build",
        "> node scripts/build.mjs",
        "",
        "Built static app in dist/",
        "exec",
        "/bin/zsh -lc \"npm run dev\" in /tmp/project",
        "succeeded in 338ms:",
        "",
        "> @scope/package@0.1.0 dev",
        "> vite --host 127.0.0.1",
        "",
        "Unable to bind a local dev server in this environment.",
        "Built static app in dist/",
        "Open file:///tmp/project/dist/index.html directly, or run this script outside the sandbox."
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "dev server unavailable");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("$ npm run build");
      expect(frame).toContain("· ok 372ms · $ npm run build · built dist");
      expect(frame).toContain("$ npm run dev");
      expect(frame).toContain("· ok 338ms · $ npm run dev");
      expect(frame).toContain("· dev server unavailable · built dist fallback · dist/index.html");
      expect(frame).not.toMatch(/\$ npm run dev\s*\n\s*· ok 338ms · \$ npm run dev/);
      expect(frame).not.toMatch(/\n\s*Built static app in dist\/\s*\n/);
      expect(frame).not.toContain("falling-blocks-puzzle@1.0.0");
      expect(frame).not.toContain("@scope/package@0.1.0");
      expect(frame).not.toContain("> node scripts/build.mjs");
      expect(frame).not.toContain("> vite --host");
      expect(frame).not.toContain("Unable to bind a local dev server");
      expect(frame).not.toContain("Open dist/index.html directly");
    } finally {
      unmount();
    }
  });

  it("collapses verbose node test pass output into a single summary row", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-node-test-pass-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"npm test\" in /tmp/project",
        "succeeded in 505ms:",
        "",
        "> falling-blocks-puzzle@1.0.0 test",
        "> node --test test/*.test.mjs",
        "",
        "✔ collision detects walls and floor (0.842583ms)",
        "✔ movement respects walls (0.21425ms)",
        "✔ speed setting changes automatic drop interval (0.157291ms)",
        "✔ color value readouts stay on one line (1.911542ms)",
        "ℹ tests 4",
        "ℹ suites 0",
        "ℹ pass 4",
        "ℹ fail 0",
        "ℹ cancelled 0",
        "ℹ skipped 0",
        "ℹ todo 0",
        "ℹ duration_ms 208.832916",
        "",
        "exec",
        "/bin/zsh -lc \"npm run smoke\" in /tmp/project",
        "succeeded in 12ms:",
        "Smoke test passed"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "smoke passed");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 505ms · $ npm test");
      expect(frame).toContain("· tests 4 passed · 209ms");
      expect(frame).toContain("smoke passed · 12ms");
      expect(frame).not.toContain("· ok 12ms · $ npm run smoke");
      expect(frame).not.toContain("Smoke test passed");
      expect(frame).not.toContain("falling-blocks-puzzle@1.0.0");
      expect(frame).not.toContain("node --test test/*.test.mjs");
      expect(frame).not.toContain("✔ collision detects walls");
      expect(frame).not.toContain("✔ color value readouts");
      expect(frame).not.toContain("ℹ tests 4");
      expect(frame).not.toContain("ℹ duration_ms");
    } finally {
      unmount();
    }
  });

  it("drops parallel command start rows once annotated status summaries identify them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-parallel-command-starts-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"npm test\" in /tmp/project",
        "exec",
        "/bin/zsh -lc \"npm run build\" in /tmp/project",
        "exec",
        "/bin/zsh -lc \"npm run smoke\" in /tmp/project",
        "succeeded in 505ms:",
        "",
        "> falling-blocks-puzzle@1.0.0 test",
        "> node --test test/*.test.mjs",
        "",
        "✔ one test passes (1.1ms)",
        "✔ second test passes (1.2ms)",
        "✔ third test passes (1.3ms)",
        "ℹ tests 3",
        "ℹ pass 3",
        "ℹ fail 0",
        "ℹ duration_ms 11.5",
        "succeeded in 367ms:",
        "",
        "> falling-blocks-puzzle@1.0.0 smoke",
        "> node scripts/smoke-test.mjs",
        "",
        "Smoke test passed",
        "succeeded in 372ms:",
        "",
        "> falling-blocks-puzzle@1.0.0 build",
        "> node scripts/build.mjs",
        "",
        "Built static app in dist/"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "built dist");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 505ms · $ npm test");
      expect(frame).toContain("smoke passed · 367ms");
      expect(frame).toContain("· ok 372ms · $ npm run build · built dist");
      expect(frame).not.toContain("Built static app in dist/");
      expect(frame).not.toMatch(/^\s+\$ npm test\s*$/m);
      expect(frame).not.toMatch(/^\s+\$ npm run smoke\s*$/m);
      expect(frame).not.toContain("· ok 367ms · $ npm run smoke");
      expect(frame).not.toMatch(/^\s+\$ npm run build\s*$/m);
    } finally {
      unmount();
    }
  });

  it("keeps node test failure details visible instead of collapsing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-node-test-fail-"));
    const workerDir = join(root, "critic-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"npm test\" in /tmp/project",
        "failed in 505ms:",
        "",
        "> falling-blocks-puzzle@1.0.0 test",
        "> node --test test/*.test.mjs",
        "",
        "✔ collision detects walls and floor (0.842583ms)",
        "✖ speed setting changes automatic drop interval (0.157291ms)",
        "AssertionError: expected 300 to be 250",
        "ℹ tests 2",
        "ℹ pass 1",
        "ℹ fail 1"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={18}
      />
    );

    try {
      await waitForFrame(lastFrame, "AssertionError");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· fail 505ms · $ npm test");
      expect(frame).toContain("✔ collision detects walls and floor");
      expect(frame).toContain("✖ speed setting changes automatic drop interval");
      expect(frame).toContain("AssertionError: expected 300 to be 250");
      expect(frame).toContain("ℹ fail 1");
      expect(frame).not.toContain("tests 1/2 passed");
    } finally {
      unmount();
    }
  });

  it("renders shell-quoted glob arguments without truncating the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-shell-quote-command-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        "/bin/zsh -lc \"pwd && rg --files -g '\"'\"'!*node_modules*'\"'\"' -g '\"'\"'!*.png'\"'\"' | sed -n '\"'\"'1,200p'\"'\"'\" in /tmp/project",
        "succeeded in 0ms:",
        "/tmp/project",
        "src/main.mjs",
        "package.json"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "package.json");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("$ pwd && rg --files -g '!*node_modules*' -g '!*.png' | sed -n '1,200p'");
      expect(frame).not.toContain("$ pwd && rg --files -g ' ");
      expect(frame).not.toContain("/bin/zsh -lc");
    } finally {
      unmount();
    }
  });

  it("keeps long diff lines and blank context lines visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-long-diff-"));
    const workerDir = join(root, "actor-mock");
    const longLine = [
      "const evidence = '",
      "reviewed judge requirements acceptance criteria plan critic brief actor worklog actor patch ",
      "and preserved every important trailing token UNIQUE_DIFF_TAIL';"
    ].join("");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "patch.diff"),
      [
        "diff --git a/src/review.ts b/src/review.ts",
        "index 1111111..2222222 100644",
        "--- a/src/review.ts",
        "+++ b/src/review.ts",
        "@@ -10,3 +10,4 @@",
        " const before = true;",
        " ",
        `+${longLine}`,
        " const after = true;"
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "actor transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={40}
      />
    );

    try {
      await waitForFrame(lastFrame, "Update(src/review.ts)");

      const frame = lastFrame() ?? "";
      expect(frame).toContain(" 10   const before = true;");
      expect(frame).toMatch(/\n\s*11\s*\n\s*12 \+ const evidence = 'reviewed judge requirements/);
      expect(frame).toContain(" 12 + const evidence = 'reviewed judge requirements");
      expect(frame).toContain(" 13   const after = true;");
      expect(frame).toContain("UNIQUE_DIFF_TAIL");
      expect(frame).not.toContain("…");
    } finally {
      unmount();
    }
  });

  it("assigns subtle background colors to dense log row types", () => {
    const theme = TUI_THEME_PRESETS.codex;
    expect(workerOutputLineTheme("section").backgroundColor).toBe(theme.rail);
    expect(workerOutputLineTheme("command").backgroundColor).toBe(theme.chrome);
    expect(workerOutputLineTheme("error").backgroundColor).toBe(theme.dangerSurface);
    expect(workerOutputLineTheme("diff-add").backgroundColor).toBe(theme.successSurface);
    expect(workerOutputLineTheme("diff-remove").backgroundColor).toBe(theme.dangerSurface);
    expect(workerOutputLineTheme("diff-file")).toMatchObject({
      backgroundColor: theme.surface,
      bold: true,
      color: theme.accent
    });
    expect(workerOutputLineTheme("diff-summary")).toEqual({ backgroundColor: theme.surface, color: theme.text });
    expect(workerOutputLineTheme("diff-context")).toEqual({ backgroundColor: theme.surface, color: theme.muted });
    expect(workerOutputLineTheme("code").backgroundColor).toBe(theme.rail);
    expect(workerOutputLineTheme("json")).toMatchObject({ backgroundColor: theme.rail, color: theme.accent });
    expect(workerOutputLineTheme("source-line").backgroundColor).toBe(theme.surface);
    expect(workerOutputLineFillTheme("group")).toBe(theme.chrome);
    expect(workerOutputLineFillTheme("section")).toBe(theme.rail);
    expect(workerOutputLineFillTheme("command")).toBe(theme.chrome);
    expect(workerOutputLineFillTheme("diff-file")).toBe(theme.surface);
    expect(workerOutputLineFillTheme("diff-summary")).toBe(theme.surface);
    expect(workerOutputLineFillTheme("diff-context")).toBe(theme.surface);
    expect(workerOutputLineFillTheme("content")).toBeNull();
  });

  it("keeps styled log rows free of table gutters", () => {
    expect(workerOutputLineLayout("command", "$ npm test")).toEqual({ gutter: "", body: "$ npm test" });
    expect(workerOutputLineLayout("success", "✓ tests passed")).toEqual({ gutter: "", body: "· ✓ tests passed" });
    expect(workerOutputLineLayout("success", "Smoke test passed: app boots with DOM/canvas shims")).toEqual({
      gutter: "",
      body: "· smoke passed · DOM/canvas ok"
    });
    expect(workerOutputLineLayout("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims")).toEqual({
      gutter: "",
      body: "· smoke passed · 367ms · DOM/canvas ok"
    });
    expect(workerOutputLineLayout("error", "Error: boom")).toEqual({ gutter: "", body: "error · boom" });
    expect(workerOutputLineLayout("list", "done")).toEqual({ gutter: "", body: "• done" });
    expect(workerOutputLineLayout("list", "Feature mailbox features/0009/actor-worklog.md written.")).toEqual({
      gutter: "",
      body: "• mailbox 0009/actor-worklog.md written."
    });
    expect(workerOutputLineLayout("list-detail", "details")).toEqual({ gutter: "", body: "  details" });
    expect(workerOutputLineLayout("list-detail", "No Critic findings were active, so features/0009/actor-replies.jsonl remains empty.")).toEqual({
      gutter: "",
      body: "  No Critic findings were active, so 0009/actor-replies.jsonl remains empty."
    });
    expect(workerOutputLineLayout("code", "const x = 1;")).toEqual({ gutter: "", body: "| const x = 1;" });
    expect(workerOutputLineLayout("section", "features/0010/actor-worklog.md")).toEqual({
      gutter: "",
      body: "file · 0010/actor-worklog.md"
    });
    expect(workerOutputLineLayout("section", "patch.diff")).toEqual({
      gutter: "",
      body: "diff · patch.diff"
    });
    expect(workerOutputLineLayout("section", "features/0010/actor-replies.jsonl")).toEqual({
      gutter: "",
      body: "mail · 0010/actor-replies.jsonl"
    });
    expect(workerOutputLineLayout("section", "features/0010/critic-findings.jsonl")).toEqual({
      gutter: "",
      body: "findings · 0010/critic-findings.jsonl"
    });
    expect(workerOutputLineLayout("quote", "quoted note")).toEqual({
      gutter: "",
      body: "│ quoted note"
    });
    expect(workerOutputLineLayout("summary", "Collapsed code output: 8 lines")).toEqual({
      gutter: "",
      body: "· Collapsed code output: 8 lines"
    });
    expect(workerOutputLineLayout("summary", "succeeded in 0ms: Collapsed code output: 8 lines ($ sed -n '1,260p' test/board.test.mjs)")).toEqual({
      gutter: "",
      body: "· test/board.test.mjs:1-260 · 8 code"
    });
    expect(workerOutputLineLayout("summary", "succeeded in 367ms: ($ npm run smoke)")).toEqual({
      gutter: "",
      body: "· ok 367ms · $ npm run smoke"
    });
    expect(workerOutputLineLayout("command", '$ rg -n "TBD|TODO|implement later|fill in|占位|待定" .parallel-codex/sessions/task-20260630-093326-1980/judge-codex/*.md')).toEqual({
      gutter: "",
      body: "$ rg TODO markers judge-codex/*.md"
    });
    expect(workerOutputLineLayout("command", "$ cat /tmp/project/.parallel-codex/sessions/task-20260630-093326-1980/actor-codex/worklog.md")).toEqual({
      gutter: "",
      body: "$ cat .parallel-codex/<task>/actor-codex/worklog.md"
    });
    expect(workerOutputLineLayout("content", "Open file:///workspace/tetris/dist/index.html directly")).toEqual({
      gutter: "",
      body: "Open dist/index.html directly"
    });
    expect(workerOutputLineLayout("json", "[info] to critic")).toEqual({ gutter: "", body: "[info] to critic" });
    expect(workerOutputLineLayout("json-message", "Fixed it")).toEqual({ gutter: "", body: "Fixed it" });
    expect(workerOutputLineLayout("diff-add", "  1 + added line")).toEqual({ gutter: "", body: "  1 + added line" });
    expect(workerOutputLineLayout("diff-remove", "  1 - removed line")).toEqual({ gutter: "", body: "  1 - removed line" });
    expect(workerOutputLineLayout("diff-context", "  2   context line")).toEqual({
      gutter: "",
      body: "  2   context line"
    });
    expect(workerOutputLineLayout("diff-file", "Update(src/a.ts)")).toEqual({
      gutter: "",
      body: "● Update(src/a.ts)"
    });
    expect(workerOutputLineLayout("diff-summary", "Added 1 line")).toEqual({
      gutter: "",
      body: "└ Added 1 line"
    });
  });

  it("uses compact worker output chrome in narrow terminals", () => {
    expect(workerOutputTitleDisplay("Judge (codex) output (1/4)", 40)).toBe("judge/codex · 1/4");
    expect(workerOutputTitleDisplay("Critic (claude) output (3/4)", 45)).toBe("critic/claude · 3/4");
    expect(workerOutputTitleDisplay("Judge (codex) output (1/4)", 14)).toBe("judge · 1/4");
    expect(workerOutputTitleDisplay("Actor (codex) output (2/4)", 10)).toBe("a 2/4");
    expect(workerOutputTitleDisplay("Actor (codex) output (2/4)", 6)).toBe("a 2/4");
    expect(workerOutputTitleDisplay("Actor (codex) output (2/4)", 3)).toBe("2/4");
    expect(workerOutputTitleDisplay("Critic (claude) output (3/4)", 80)).toBe("critic/claude · 3/4");
    expect(workerOutputHeaderDisplay("Judge (codex) output (1/4)", "tail", 40)).toBe("judge/codex · 1/4 · tail");
    expect(workerOutputHeaderDisplay("Critic (claude) output (3/4)", "back 3/474", 45)).toBe("critic/claude · 3/4 · back 3/474");
    expect(workerOutputHeaderDisplay("Judge (codex) output (1/4)", "tail", 18)).toBe("judge · 1/4 · tail");
    expect(workerOutputHeaderDisplay("Actor (codex) output (2/4)", "tail", 16)).toBe("actor · 2/4");
    expect(workerOutputHeaderDisplay("Actor (codex) output (2/4)", "tail", 14)).toBe("actor · 2/4");
    expect(workerOutputHeaderDisplay("Actor (codex) output (2/4)", "tail", 10)).toBe("a 2/4");
    expect(workerOutputHeaderDisplay("Actor (codex) output (2/4)", "tail", 8)).toBe("a 2/4");
    expect(workerOutputHeaderDisplay("Actor (codex) output (2/4)", "tail", 6)).toBe("a 2/4");
    expect(workerOutputScrollDisplay(0, 474, 40)).toBe("tail");
    expect(workerOutputScrollDisplay(3, 474, 40)).toBe("back 3/474");
    expect(workerOutputScrollDisplay(3, 474, 24)).toBe("3/474");
    expect(workerOutputScrollDisplay(0, 474, 80)).toBe("tail");
    expect(workerOutputScrollDisplay(3, 474, 80)).toBe("back 3/474");
    expect(workerOutputScrollDisplay(474, 474, 80)).toBe("top");
  });

  it("bottom-aligns short worker tail bodies only when scrollback exists", () => {
    expect(workerOutputTailTopPaddingLines(0, 20, 4, 8)).toBe(4);
    expect(workerOutputTailTopPaddingLines(0, 20, 6, 8)).toBe(0);
    expect(workerOutputTailTopPaddingLines(0, 20, 3, 4)).toBe(0);
    expect(workerOutputTailTopPaddingLines(0, 20, 8, 8)).toBe(0);
    expect(workerOutputTailTopPaddingLines(3, 20, 4, 8)).toBe(0);
    expect(workerOutputTailTopPaddingLines(0, 0, 4, 8)).toBe(0);
  });

  it("does not start a worker viewport on a blank separator row", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-leading-blank-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\n");
    await writeFile(join(workerDir, "output.log"), "process one\nprocess two\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={4}
      />
    );

    try {
      await waitForFrame(lastFrame, "process two");

      const lines = (lastFrame() ?? "").split("\n");
      expect(lines[1]?.trim()).toBe("process");
      expect(lines[2]?.trim()).toBe("process one");
      expect(lines[3]?.trim()).toBe("process two");
      expect(workerOutputVisibleStart([
        { kind: "content" },
        { kind: "blank" },
        { kind: "blank" },
        { kind: "summary" }
      ], 1, 4)).toBe(3);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "None." },
        { kind: "blank", text: "" },
        { kind: "group", text: "process" },
        { kind: "summary", text: "ok" }
      ], 0, 4, { preferGroup: "process" })).toBe(2);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "None." },
        { kind: "heading", text: "Critic findings" },
        { kind: "content", text: "(empty)" },
        { kind: "blank", text: "" },
        { kind: "group", text: "process" },
        { kind: "summary", text: "ok" }
      ], 0, 6, { preferGroup: "process" })).toBe(1);
      expect(workerOutputVisibleStart([
        { kind: "heading", text: "Blocking Findings" },
        { kind: "content", text: "None." },
        { kind: "heading", text: "Critic findings" },
        { kind: "content", text: "(empty)" },
        { kind: "group", text: "process" },
        { kind: "summary", text: "ok" }
      ], 0, 6, { preferGroup: "process" })).toBe(0);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "APPROVED" },
        { kind: "heading", text: "Blocking Findings" },
        { kind: "content", text: "None." },
        { kind: "group", text: "process" },
        { kind: "summary", text: "ok" }
      ], 0, 5, { preferGroup: "process" })).toBe(0);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "Requirement 1" },
        { kind: "content", text: "Requirement 2" },
        { kind: "content", text: "Requirement 3" },
        { kind: "content", text: "Requirement 4" },
        { kind: "heading", text: "Verification" },
        { kind: "content", text: "npm test passed" },
        { kind: "content", text: "npm run build passed" },
        { kind: "blank", text: "" },
        { kind: "group", text: "process" },
        { kind: "summary", text: "ok" }
      ], 0, 10, { preferGroup: "process" })).toBe(0);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "Critic review: APPROVED" },
        { kind: "content", text: "Blocking Findings: None." },
        { kind: "content", text: "Critic findings: (empty)" },
        { kind: "blank", text: "" },
        { kind: "section", text: "file · 0010/decisions.md" },
        { kind: "content", text: "Feature: 0010" },
        { kind: "blank", text: "" },
        { kind: "group", text: "process" },
        { kind: "summary", text: "ok" }
      ], 0, 9, { preferGroup: "process" })).toBe(4);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "Feature: 0005" },
        { kind: "content", text: "Turn: 0005" },
        { kind: "blank", text: "" },
        { kind: "content", text: "Supervisor summary: Complex task completed." },
        { kind: "blank", text: "" },
        { kind: "content", text: "Critic review:" },
        { kind: "content", text: "Critic Review — Turn 0005" },
        { kind: "content", text: "Verdict: APPROVED" },
        { kind: "blank", text: "" },
        { kind: "section", text: "file · 0007/decisions.md" },
        { kind: "content", text: "Feature: 0007" },
        { kind: "section", text: "file · 0010/decisions.md" },
        { kind: "content", text: "Feature: 0010" }
      ], 0, 13, { preferGroup: "process" })).toBe(9);
      expect(workerOutputVisibleStart([
        { kind: "section", text: "file · 0007/decisions.md" },
        { kind: "content", text: "Feature: 0007" },
        { kind: "content", text: "Turn: 0007" },
        { kind: "blank", text: "" },
        { kind: "content", text: "Supervisor summary: Complex task completed." },
        { kind: "blank", text: "" },
        { kind: "content", text: "Critic review: APPROVED" },
        { kind: "content", text: "Blocking Findings: None." },
        { kind: "content", text: "Critic findings: (empty)" },
        { kind: "blank", text: "" },
        { kind: "section", text: "file · 0010/decisions.md" },
        { kind: "content", text: "Feature: 0010" },
        { kind: "content", text: "Turn: 0010" }
      ], 0, 13, { preferLatestSection: true })).toBe(10);
      expect(workerOutputVisibleStart([
        { kind: "list", text: "• src/game.mjs" },
        { kind: "list-detail", text: "Wires speed controls." },
        { kind: "heading", text: "Verification" }
      ], 0, 3)).toBe(0);
      expect(workerOutputVisibleStart([
        { kind: "list-detail", text: "Wires speed controls." },
        { kind: "list-detail", text: "Persists speed setting." },
        { kind: "heading", text: "Verification" },
        { kind: "list", text: "• npm test passed" }
      ], 0, 4)).toBe(2);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "Verification: tests 30/30 · smoke passed · build passed" },
        { kind: "content", text: "Findings: none" },
        { kind: "blank", text: "" },
        { kind: "group", text: "process" },
        { kind: "error", text: "error · Codex context window full" }
      ], 0, 5, { preferGroup: "process" })).toBe(0);
      expect(workerOutputVisibleStart([
        { kind: "content", text: "tests 30/30" },
        { kind: "content", text: "smoke · build" },
        { kind: "content", text: "dev" },
        { kind: "content", text: "Findings: none" },
        { kind: "blank", text: "" },
        { kind: "group", text: "process" },
        { kind: "error", text: "error · Codex context window full" }
      ], 0, 7, { preferGroup: "process" })).toBe(0);
    } finally {
      unmount();
    }
  });

  it("aligns tail worker logs to the process group instead of showing artifact fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-tail-process-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "review.md"),
      [
        "# Review",
        "",
        "APPROVED",
        "",
        "## Blocking Findings",
        "",
        "None.",
        "",
        "Critic findings:",
        "(empty)"
      ].join("\n")
    );
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 505ms: ($ npm test)",
        "Node tests passed: 30/30",
        "succeeded in 372ms: ($ npm run build) Build output: dist/"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (mock) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={7}
      />
    );

    try {
      await waitForFrame(lastFrame, "built dist");

      const lines = (lastFrame() ?? "").split("\n");
      expect(lines[1]?.trim()).not.toBe("None.");
      expect(lastFrame() ?? "").not.toContain("None.");
      expect(lastFrame() ?? "").not.toContain("Critic findings");
      expect(lastFrame() ?? "").toContain("· ok 505ms · $ npm test");
      expect(lastFrame() ?? "").toContain("· ok 372ms · $ npm run build · built dist");
    } finally {
      unmount();
    }
  });

  it("keeps compact title and scroll labels intact in ultra narrow worker views", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-ultra-title-"));
    const workerDir = join(root, "judge-codex");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "requirements.md"),
      Array.from({ length: 20 }, (_, index) => `Requirement ${index + 1}`).join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "process tail\n");

    const previousColumns = process.stdout.columns;
    process.stdout.columns = 24;
    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output (1/4)"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={8}
      />
    );

    try {
      await waitForFrame(lastFrame, "tail");

      const frame = lastFrame() ?? "";
    expect(frame).toContain("judge · 1/4 · tail");
    expect(frame).toContain("tail");
    expect(frame).not.toContain("1/4   tail");
  } finally {
      process.stdout.columns = previousColumns;
      unmount();
    }
  });

  it("keeps exact-fit worker titles from wrapping after Ink padding", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-exact-title-"));
    const workerDir = join(root, "critic-claude");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "review.md"), "APPROVED\n");
    await writeFile(
      join(workerDir, "output.log"),
      Array.from({ length: 24 }, (_, index) => `process line ${index + 1}`).join("\n")
    );

    const previousColumns = process.stdout.columns;
    process.stdout.columns = 28;
    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (claude) output (3/4)"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={6}
      />
    );

    try {
      await waitForFrame(lastFrame, "tail");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("critic · 3/4 · tail");
      expect(frame).not.toContain("critic/claude · 3/4 ·");
      expect(frame).not.toMatch(/\n\s*ail\b/);
    } finally {
      process.stdout.columns = previousColumns;
      unmount();
    }
  });

  it("splits diff rows into stable line number, sign, and code columns", () => {
    expect(workerOutputDiffColumns("  1 + added line")).toEqual({
      lineNumber: "  1",
      sign: "+",
      code: "added line"
    });
    expect(workerOutputDiffColumns(" 10   context line")).toEqual({
      lineNumber: " 10",
      sign: " ",
      code: "context line"
    });
    expect(workerOutputDiffColumns(" 11   ")).toEqual({
      lineNumber: " 11",
      sign: " ",
      code: ""
    });
    expect(workerOutputDiffColumns("123 - removed line")).toEqual({
      lineNumber: "123",
      sign: "-",
      code: "removed line"
    });
  });

  it("wraps long diff rows with continuation lines aligned to the code column", () => {
    expect(workerOutputDiffDisplayLines(" 22 + npm run dev was attempted with a file:// fallback.", 32)).toEqual([
      " 22 + npm run dev was attempted",
      "      with a file:// fallback."
    ]);
    const contextLines = workerOutputDiffDisplayLines("  7   context keeps its column", 24);
    expect(contextLines[0]).toMatch(/^  7   /);
    expect(contextLines[1]).toMatch(/^      \S/);
    expect(contextLines.map((line) => line.slice(6).trim()).join(" ")).toBe("context keeps its column");
  });

  it("wraps ordinary worker log rows instead of truncating them in narrow terminals", () => {
    expect(workerOutputBodyDisplayLines("list", "只能靠鼠标点击，键盘或触控缺失", 18)).toEqual([
      "• 只能靠鼠标点击，",
      "  键盘或触控缺失"
    ]);
    expect(workerOutputBodyDisplayLines("ordered-list", "12. 影子落点显示当前方块的最终下落位置。", 22)).toEqual([
      "12. 影子落点显示当前方",
      "    块的最终下落位置。"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed read summaries: 18 chunks, 1494 lines (package.json, main.mjs, game/engine.mjs, +14 more)", 36)).toEqual([
      "· read 18 chunks · 1494 lines"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed diff: 3 files, added 73 lines, removed 1 line (test/engine.test.mjs, test/storage.test.mjs, scripts/smoke-test.mjs)", 56)).toEqual([
      "· diff 3 files · +73 · -1 · engine.test.mjs, +2 more"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed diff: 3 files, added 73 lines, removed 1 line (test/engine.test.mjs, test/storage.test.mjs, scripts/smoke-test.mjs)", 20)).toEqual([
      "· diff 3 · +73 · -1"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed diff: 12 files, added 120 lines, removed 31 lines (src/a.ts, src/b.ts, +10 more)", 16)).toEqual([
      "· diff 12 · +120"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed diff: 12 files, added 120 lines, removed 31 lines (src/a.ts, src/b.ts, +10 more)", 14)).toEqual([
      "· diff 12"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed read summaries: 6 chunks, 804 lines (main.mjs, ui/storage.mjs, game/scoring.mjs, +3 more)", 56)).toEqual([
      "· read 6 chunks · 804 lines · main.mjs, +5 more"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed read summaries: 4 chunks, 437 lines (scripts/build.mjs, styles.css, dist/index.html)", 26)).toEqual([
      "· read 4 · 437 lines"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Collapsed read summaries: 18 chunks, 1494 lines (package.json, main.mjs, game/engine.mjs, +14 more)", 16)).toEqual([
      "· read 18 · 1494"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Dev server fallback: dist/index.html", 56)).toEqual([
      "· dev server unavailable · built dist fallback"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Dev server fallback: dist/index.html", 38)).toEqual([
      "· dev fallback · dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Dev server fallback: dist/index.html", 26)).toEqual([
      "· dev fallback · dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Dev server fallback: dist/index.html", 12)).toEqual([
      "· dev · dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Dev server fallback: dist/index.html", 8)).toEqual([
      "· dev"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 372ms: ($ npm run build) Build output: dist/", 56)).toEqual([
      "· ok 372ms · $ npm run build · built dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 372ms: ($ npm run build) Build output: dist/", 38)).toEqual([
      "· ok 372ms · build · dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 505ms: ($ npm test)", 26)).toEqual([
      "· ok 505ms · test"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 372ms: ($ npm run build) Build output: dist/", 26)).toEqual([
      "· ok 372ms · build · dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 372ms: ($ npm run build) Build output: dist/", 16)).toEqual([
      "· build · dist"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 372ms: ($ npm run build) Build output: dist/", 8)).toEqual([
      "· build"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 338ms: ($ npm run dev)", 26)).toEqual([
      "· ok 338ms · dev"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 338ms: ($ npm run dev)", 8)).toEqual([
      "· dev"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Node tests passed: 30/30 in 209ms", 16)).toEqual([
      "· tests 30 ok"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "Node tests passed: 30/30 in 209ms", 12)).toEqual([
      "· tests 30"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 0ms: Collapsed file list output: 24 paths ($ rg --files)", 20)).toEqual([
      "· files 24 paths"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "succeeded in 0ms: Collapsed file list output: 24 paths ($ rg --files)", 14)).toEqual([
      "· files 24"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "No matches in 0ms ($ rg TODO markers judge-codex/*.md)", 18)).toEqual([
      "· no TODO"
    ]);
    expect(workerOutputBodyDisplayLines("summary", "No matches in 0ms ($ rg TODO markers judge-codex/*.md)", 16)).toEqual([
      "· no TODO"
    ]);
    expect(workerOutputBodyDisplayLines("content", "critic-findings.jsonl is empty after writing the static dist/ fallback.", 28)).toEqual([
      "findings.jsonl is empty",
      "after writing the static",
      "dist fallback."
    ]);
    expect(workerOutputBodyDisplayLines("content", "feature; critic-findings.jsonl is empty.", 20)).toEqual([
      "feature; findings is",
      "empty."
    ]);
    expect(workerOutputBodyDisplayLines("content", "No active Critic findings were present for this feature; critic-findings.jsonl is empty.", 20)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "No active Critic findings were present for this feature; critic-findings.jsonl is empty.", 10)).toEqual([
      "None."
    ]);
    expect(workerOutputBodyDisplayLines("content", "No active Critic findings were present for this feature; critic-findings.jsonl is empty.", 42)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "No active Critic findings were present for this feature; critic-findings.jsonl is empty.", 80)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 42)).toEqual([
      "tests 30/30 · smoke · build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 38)).toEqual([
      "tests 30/30 · smoke · build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 36)).toEqual([
      "tests 30/30 · smoke · build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 76)).toEqual([
      "Verify: tests 30/30 · smoke · build · dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 30)).toEqual([
      "tests 30/30 · smoke",
      "build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 26)).toEqual([
      "tests 30/30 · smoke",
      "build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 20)).toEqual([
      "tests 30/30 · smoke",
      "build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 18)).toEqual([
      "tests 30/30",
      "smoke · build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 16)).toEqual([
      "tests 30/30",
      "smoke",
      "build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 12)).toEqual([
      "tests 30/30",
      "smoke",
      "build+dev"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback", 36).some((line, index) =>
      index > 0 && line.trimStart().startsWith("·")
    )).toBe(false);
    expect(workerOutputBodyDisplayLines("content", "Supervisor summary: Complex task completed.", 16)).toEqual([
      "Summary: done"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Supervisor summary: Complex task completed.", 12)).toEqual([
      "Done"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Summary: done", 12)).toEqual([
      "Done"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Critic review: APPROVED", 16)).toEqual([
      "Review: approved"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Review: approved", 14)).toEqual([
      "Approved"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Feature: 0010 · Turn: 0010", 16)).toEqual([
      "Feature 0010"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Blocking: none", 42)).toEqual([
      "No blockers."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Blocking: none", 30)).toEqual([
      "No blockers."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Blocking: none", 16)).toEqual([
      "No blockers."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Blocking: none", 8)).toEqual([
      "No block"
    ]);
    expect(workerOutputBodyDisplayLines("content", "Findings: none", 42)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Findings: none", 30)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Findings: none", 20)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Findings: none", 16)).toEqual([
      "No findings."
    ]);
    expect(workerOutputBodyDisplayLines("content", "Findings: none", 8)).toEqual([
      "No find"
    ]);
    expect(workerOutputBodyDisplayLines("heading", "Critic Findings", 12)).toEqual([
      "Findings"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 76)).toEqual([
      "error · Codex context window full · start a new thread or clear history"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 56)).toEqual([
      "error · context full; new thread"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 34)).toEqual([
      "error · context full; new thread"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 30)).toEqual([
      "err · ctx full; new thread"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 26)).toEqual([
      "err · ctx full; new thread"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 20)).toEqual([
      "err · ctx full",
      "start new thread"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 16)).toEqual([
      "err · ctx full"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 12)).toEqual([
      "err · ctx"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 8)).toEqual([
      "err ctx"
    ]);
    expect(workerOutputBodyDisplayLines("error", "ERROR: Codex ran out of room in the model's context window. Start a new thread before retrying.", 6)).toEqual([
      "ctx"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims and controls mutate HUD state.", 34)).toEqual([
      "· smoke passed · DOM/canvas ok"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims and controls mutate HUD state.", 38)).toEqual([
      "· smoke passed · 367ms · DOM/canvas ok"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims and controls mutate HUD state.", 76)).toEqual([
      "· smoke passed · 367ms · DOM/canvas ok"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims and controls mutate HUD state.", 100)).toEqual([
      "· smoke passed · 367ms · DOM/canvas ok"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed: app boots with DOM/canvas shims and controls mutate HUD state.", 34)).toEqual([
      "· smoke passed · DOM/canvas ok"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims and controls mutate HUD state.", 20)).toEqual([
      "· smoke passed"
    ]);
    expect(workerOutputBodyDisplayLines("success", "Smoke test passed in 367ms: app boots with DOM/canvas shims and controls mutate HUD state.", 12)).toEqual([
      "· smoke"
    ]);
    expect(workerOutputBodyDisplayLines("list", "npm run dev could not bind a port in this sandbox and produced the static dist/ fallback.", 20)).toEqual([
      "• dev fallback."
    ]);
  });

  it("renders nl-style source output with stable line number and code columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-source-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        '/bin/zsh -lc "nl -ba src/main.mjs | sed -n \'1,20p\'"',
        "succeeded in 0ms:",
        "1\timport { TetrisGame } from \"./game/engine.mjs\";",
        "2\t",
        "10\t  score: document.querySelector(\"#score\"),"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "TetrisGame");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("   1  import { TetrisGame } from \"./game/engine.mjs\";");
      expect(frame).toMatch(/\n\s*2\s*\n/);
      expect(frame).toContain("  10    score: document.querySelector(\"#score\"),");
      expect(frame).not.toContain("1\timport");
    } finally {
      unmount();
    }
  });

  it("collapses long source-listing command output in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-source-collapse-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        '/bin/zsh -lc "nl -ba src/main.mjs | sed -n \'130,150p\'"',
        "succeeded in 0ms:",
        "139\t  resetKeysButton: elements.resetKeysButton,",
        "140\t  keyBindStatus: elements.keyBindStatus,",
        "141\t  storage",
        "142\t});",
        "143\t",
        "144\tapplyPieceColors(pieceColors);",
        "145\tapplySpeedSetting(speedSetting);",
        "146\trenderer.render(game.getState());",
        "147\trequestAnimationFrame(loop);",
        "next command output"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "9 source");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· main.mjs:130-150 · 9 source");
      expect(frame).toContain("next command output");
      expect(frame).not.toContain("$ nl -ba src/main.mjs");
      expect(frame).not.toContain("succeeded in 0ms:");
      expect(frame).not.toContain("exec");
      expect(frame).not.toContain("resetKeysButton");
      expect(frame).not.toContain("requestAnimationFrame");
    } finally {
      unmount();
    }
  });

  it("pairs consecutive source dump commands with their collapsed summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-grouped-commands-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        '/bin/zsh -lc "sed -n \'1,260p\' src/game/scoring.mjs" in /tmp/tetris',
        "exec",
        '/bin/zsh -lc "sed -n \'1,260p\' index.html" in /tmp/tetris',
        "succeeded in 0ms:",
        "const first = 1;",
        "const second = 2;",
        "const third = 3;",
        "const fourth = 4;",
        "const fifth = 5;",
        "",
        "succeeded in 0ms:",
        "<!doctype html>",
        "<html>",
        "<body>",
        "<main id=\"app\"></main>",
        "</body>",
        "</html>",
        "after grouped dumps"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after grouped dumps");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· game/scoring.mjs:1-260 · 5 code");
      expect(frame).toContain("· index.html:1-260 · 6 code");
      expect(frame).toContain("after grouped dumps");
      expect(frame).not.toContain("$ sed -n '1,260p'");
      expect(frame).not.toContain("const first");
      expect(frame).not.toContain("<main id=\"app\"");
    } finally {
      unmount();
    }
  });

  it("compacts long runs of file read summaries into one readable row", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-read-run-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms: Collapsed code output: 38 lines ($ sed -n '1,260p' src/game/board.mjs)",
        "",
        "succeeded in 0ms: Collapsed code output: 133 lines ($ sed -n '1,260p' src/ui/render.mjs)",
        "",
        "succeeded in 0ms: Collapsed code output: 226 lines ($ sed -n '1,260p' src/styles.css)",
        "",
        "succeeded in 0ms: Collapsed code output: 67 lines ($ sed -n '261,520p' src/styles.css)",
        "",
        "succeeded in 0ms: Collapsed code output: 41 lines ($ sed -n '1,260p' src/ui/input.mjs)",
        "",
        "succeeded in 0ms: Collapsed code output: 29 lines ($ sed -n '1,260p' src/game/randomizer.mjs)",
        "",
        "$ rg TODO markers judge-codex/*.md",
        "exited 1 in 0ms:"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "read 6 chunks");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("read 6 chunks · 534 lines · game/board.mjs, ui/render.mjs, styles.css, +2 more");
      expect(frame).toContain("· no matches 0ms · TODO markers");
      expect(frame).not.toContain("$ rg TODO markers judge-codex/*.md");
      expect(frame).not.toContain("game/board.mjs:1-260 · 38 code");
      expect(frame).not.toContain("game/randomizer.mjs:1-260 · 29 code");
    } finally {
      unmount();
    }
  });

  it("hides directory listing preludes before collapsed command output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-ls-prelude-collapse-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "exec",
        '/bin/zsh -lc "ls -la dist && sed -n \'1,80p\' dist/index.html" in /tmp/tetris',
        "exec",
        '/bin/zsh -lc "nl -ba src/styles.css | sed -n \'120,130p\'" in /tmp/tetris',
        "succeeded in 0ms:",
        "total 80",
        "drwxr-xr-x@  5 etsiva  staff    160 Jul  2 09:51 .",
        "drwxr-xr-x@ 10 etsiva  staff    320 Jul  2 09:51 ..",
        "-rw-r--r--@  1 etsiva  staff  31770 Jul  2 09:51 app.js",
        "-rw-r--r--@  1 etsiva  staff   6601 Jul  2 09:51 index.html",
        "<!doctype html>",
        "<html>",
        "<body>",
        "<main id=\"app\"></main>",
        "</body>",
        "</html>",
        "",
        "succeeded in 0ms:",
        "120\t.game-shell {",
        "121\t  display: grid;",
        "122\t  grid-template-columns: minmax(0, 1fr) 320px;",
        "123\t}",
        "124\t.hud {",
        "125\t  display: grid;",
        "126\t  gap: 12px;",
        "127\t}",
        "128\t.stat {",
        "129\t  color: white;",
        "130\t}",
        "after mixed grouped dumps"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after mixed grouped dumps");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· dist/index.html:1-80 · 6 code");
      expect(frame).toContain("· styles.css:120-130 · 11 source");
      expect(frame).toContain("after mixed grouped dumps");
      expect(frame).not.toContain("$ ls -la dist");
      expect(frame).not.toContain("total 80");
      expect(frame).not.toContain("31770 Jul");
      expect(frame).not.toContain(".game-shell");
      expect(frame).not.toContain("<main id=\"app\"");
    } finally {
      unmount();
    }
  });

  it("parses nl-style source rows without stealing markdown ordered lists", () => {
    expect(workerOutputSourceColumns("1\timport x from \"x\";")).toEqual({
      lineNumber: "1",
      code: "import x from \"x\";"
    });
    expect(workerOutputSourceColumns("10    score: value")).toEqual({
      lineNumber: "10",
      code: "score: value"
    });
    expect(workerOutputSourceColumns("1. Read files")).toBeNull();
    expect(workerOutputSourceDisplayLines("22\tconst value = alpha beta gamma delta epsilon;", 30)).toEqual([
      "  22  const value = alpha beta",
      "      gamma delta epsilon;"
    ]);
  });

  it("wraps Chinese code and source rows by display width", () => {
    const codeRows = workerOutputCodeDisplayLines("const label = \"继续优化这个并行编码终端界面不要乱\";", 28);
    const sourceRows = workerOutputSourceDisplayLines("139\tconst label = \"继续优化这个并行编码终端界面不要乱\";", 28);

    expect(codeRows.length).toBeGreaterThan(1);
    expect(sourceRows.length).toBeGreaterThan(1);
    expect(Math.max(...codeRows.map((line) => displayWidth(line)))).toBeLessThanOrEqual(28);
    expect(Math.max(...sourceRows.map((line) => displayWidth(line)))).toBeLessThanOrEqual(28);
    expect(sourceRows[1]).toMatch(/^      \S/);
  });

  it("wraps HTML-like process output and decodes common entities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-html-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        '<span class="panel-label">Keys</span>',
        '<p id="keyboardHelp">&larr;/A &rarr;/D move &middot; &darr;/S soft &middot; &uarr;/X rotate &middot; Z reverse &middot; Space drop UNIQUE_HTML_TAIL</p>',
        "",
        "succeeded in 0ms:",
        "120    border: 1px solid rgba(255, 255, 255, 0.12);"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={12}
      />
    );

    try {
      await waitForFrame(lastFrame, "Keys");

      const frame = lastFrame() ?? "";
      expect(frame).toContain('<span class="panel-label">Keys</span>');
      expect(frame).toContain("←/A");
      expect(frame).toContain("→/D move");
      expect(frame).toContain("UNIQUE_HTML_TAIL");
      expect(frame).not.toContain("&larr;");
      expect(frame).not.toContain("…");
      const wrappedCode = workerOutputCodeDisplayLines(
        '<p id="keyboardHelp">←/A →/D move · Space drop UNIQUE_HTML_TAIL</p>',
        40
      );
      expect(wrappedCode).toHaveLength(2);
      expect(wrappedCode[0]).toMatch(/^\| <p id="keyboardHelp">←\/A →\/D move/);
      expect(wrappedCode[1]).toMatch(/^  \S.*UNIQUE_HTML_TAIL<\/p>$/);
    } finally {
      unmount();
    }
  });

  it("collapses long HTML-like command output in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-html-collapse-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        '<div class="stats">',
        '<div class="stat">',
        "<span>Score</span>",
        '<strong id="score">0</strong>',
        "</div>",
        '<div class="stat">',
        "<span>Lines</span>",
        '<strong id="lines">0</strong>',
        "</div>",
        "after html dump"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "code 9 lines");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code 9 lines");
      expect(frame).toContain("after html dump");
      expect(frame).not.toContain("succeeded in 0ms:");
      expect(frame).not.toContain('<div class="stats">');
      expect(frame).not.toContain('<strong id="lines">0</strong>');
    } finally {
      unmount();
    }
  });

  it("collapses multiline HTML tags with attributes in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-html-attributes-collapse-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "<!doctype html>",
        "<html lang=\"zh-CN\">",
        "<main id=\"app\" class=\"game-shell\">",
        "<canvas",
        "id=\"board\"",
        "class=\"game-board\"",
        "width=\"300\"",
        "height=\"600\"",
        "aria-label=\"10 by 20 falling-block board\"",
        "></canvas>",
        "</main>",
        "</html>",
        "after html attributes"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "code 12 lines");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("code 12 lines");
      expect(frame).toContain("after html attributes");
      expect(frame).not.toContain("<!doctype html>");
      expect(frame).not.toContain("aria-label=");
      expect(frame).not.toContain("> </canvas>");
    } finally {
      unmount();
    }
  });

  it("collapses long JavaScript-like command output in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-js-collapse-"));
    const workerDir = join(root, "critic-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "await writeFile(",
        "  resolve(dist, \"index.html\"),",
        "  html.replace('<script type=\"module\" src=\"./src/main.mjs\"></script>', '<script src=\"./app.js\"></script>')",
        ");",
        "",
        "const bundledSource = [];",
        "const bundleFiles = [",
        "\"src/game/randomizer.mjs\",",
        "\"src/game/pieces.mjs\",",
        "\"src/game/board.mjs\",",
        "];",
        "for (const file of bundleFiles) {",
        "  const source = await readFile(resolve(root, file), \"utf8\");",
        "  bundledSource.push(source);",
        "}",
        "function stripModuleSyntax(source) {",
        "  return source",
        "    .replace(/import\\s+[\\s\\S]*?\\s+from\\s+[\"'][^\"']+[\"'];\\n/g, \"\")",
        "    .replace(/^export\\s+/gm, \"\");",
        "}",
        "console.log(\"Built static app in dist/\");",
        "after js dump"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Critic (codex) output"
        role="critic"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "code 20 lines");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code 20 lines");
      expect(frame).toContain("after js dump");
      expect(frame).not.toContain("succeeded in 0ms:");
      expect(frame).not.toContain("await writeFile");
      expect(frame).not.toContain(".replace(/^export");
      expect(frame).not.toContain("src/game/randomizer.mjs");
      expect(frame).not.toContain("bundledSource.push");
    } finally {
      unmount();
    }
  });

  it("collapses JavaScript array and object literal fragments in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-js-fragments-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "const elements = new Map([",
        "[\"#app\", createRoot()],",
        "[\"#board\", createCanvas(\"board\", 300, 600)],",
        "[\"#next\", createCanvas(\"next\", 112, 112)],",
        "[\"#score\", createElement(\"score\")],",
        "[\"#pauseButton\", createElement(\"pauseButton\")]",
        "]);",
        "",
        "function createElement(id, dataset = {}) {",
        "return {",
        "...createElement(id),",
        "id,",
        "dataset,",
        "textContent: \"\",",
        "listeners: new Map(),",
        "addEventListener(type, callback) {",
        "this.listeners.set(type, callback);",
        "},",
        "dispatch(type, event = {}) {",
        "const callback = this.listeners.get(type);",
        "callback?.({",
        "preventDefault() {},",
        "...event",
        "});",
        "}",
        "};",
        "}",
        "after js fragments"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after js fragments");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code ");
      expect(frame).toContain("after js fragments");
      expect(frame).not.toContain("[\"#app\"");
      expect(frame).not.toContain("id,");
      expect(frame).not.toContain("dataset,");
      expect(frame).not.toContain("...createElement");
      expect(frame).not.toContain("...event");
      expect(frame).not.toContain("preventDefault");
    } finally {
      unmount();
    }
  });

  it("collapses dotted spread and short conditional JavaScript fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-js-short-fragments-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "...this.active,",
        "...state.overlay,",
        "...piece.position,",
        "...next.preview,",
        "",
        "succeeded in 0ms:",
        "} else if (state.paused) {",
        "elements.overlay.textContent = \"Paused\";",
        "elements.overlay.dataset.visible = \"true\";",
        "} else {",
        "after short fragments"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={18}
      />
    );

    try {
      await waitForFrame(lastFrame, "after short fragments");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code 4 lines");
      expect(frame).toContain("after short fragments");
      expect(frame).not.toContain("...this.active");
      expect(frame).not.toContain("state.paused");
      expect(frame).not.toContain("overlay.textContent");
    } finally {
      unmount();
    }
  });

  it("collapses opening braces and compound assignment code fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-js-brace-assignment-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "{",
        "\"name\": \"tetris\",",
        "\"type\": \"module\",",
        "}",
        "",
        "succeeded in 0ms:",
        "accumulated += delta;",
        "elapsed -= frame;",
        "score *= multiplier;",
        "level %= maxLevel;",
        "after assignment fragments"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={18}
      />
    );

    try {
      await waitForFrame(lastFrame, "after assignment fragments");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code 4 lines");
      expect(frame).toContain("after assignment fragments");
      expect(frame).not.toContain("\"name\"");
      expect(frame).not.toContain("accumulated +=");
      expect(frame).not.toContain("score *=");
    } finally {
      unmount();
    }
  });

  it("collapses import, private-field, indexed assignment, and CSS selector fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-mixed-code-fragments-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "import {",
        "BOARD_HEIGHT,",
        "BOARD_WIDTH,",
        "cloneBoard,",
        "lockPiece,",
        "clearCompletedLines",
        "} from \"../src/game/board.mjs\";",
        "board[BOARD_HEIGHT - 1] = Array(BOARD_WIDTH).fill(\"I\");",
        "board[BOARD_HEIGHT - 2][0] = \"T\";",
        "export class SevenBagRandomizer {",
        "#random;",
        "#queue;",
        "#createBag() {",
        "return shuffle(TETROMINO_TYPES);",
        "}",
        "}",
        "*::before,",
        "*::after {",
        "scroll-behavior: auto !important;",
        "transition-duration: 0.01ms !important;",
        "animation-duration: 0.01ms !important;",
        "}",
        "after mixed fragments"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after mixed fragments");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code ");
      expect(frame).toContain("after mixed fragments");
      expect(frame).not.toContain("clearCompletedLines");
      expect(frame).not.toContain("} from");
      expect(frame).not.toContain("board[BOARD_HEIGHT");
      expect(frame).not.toContain("#queue");
      expect(frame).not.toContain("#createBag");
      expect(frame).not.toContain("*::before");
      expect(frame).not.toContain("scroll-behavior");
    } finally {
      unmount();
    }
  });

  it("collapses CSS selector and media-query fragments in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-css-fragments-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        ".stat span,",
        ".panel-label {",
        "font-size: 0.62rem;",
        "}",
        "",
        ".stat strong {",
        "font-size: 1rem;",
        "}",
        "",
        ".score-model {",
        "display: none;",
        "}",
        "",
        "@media (prefers-reduced-motion: reduce) {",
        "*,",
        "*::before,",
        "*::after {",
        "scroll-behavior: auto !important;",
        "transition-duration: 0.01ms !important;",
        "animation-duration: 0.01ms !important;",
        "}",
        "after css fragments"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after css fragments");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code ");
      expect(frame).toContain("after css fragments");
      expect(frame).not.toContain(".stat span");
      expect(frame).not.toContain(".panel-label");
      expect(frame).not.toContain("@media");
      expect(frame).not.toContain("*::before");
      expect(frame).not.toContain("scroll-behavior");
    } finally {
      unmount();
    }
  });

  it("collapses CSS root variables and custom property fragments in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-css-root-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        ":root {",
        "color-scheme: dark;",
        "--bg: #0f1218;",
        "--panel: #171d2a;",
        "--panel-strong: #20283a;",
        "--text: #eef4ff;",
        "--muted: #9da9bd;",
        "--accent: #48d7c1;",
        "--accent-2: #ffca5f;",
        "}",
        "after root variables"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={16}
      />
    );

    try {
      await waitForFrame(lastFrame, "after root variables");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code 10 lines");
      expect(frame).toContain("after root variables");
      expect(frame).not.toContain(":root");
      expect(frame).not.toContain("--accent");
      expect(frame).not.toContain("color-scheme");
    } finally {
      unmount();
    }
  });

  it("collapses CSS value continuations and complex selectors in process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-css-values-collapse-"));
    const workerDir = join(root, "judge-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "output.log"),
      [
        "succeeded in 0ms:",
        "body {",
        "background:",
        "radial-gradient(circle at top left, rgba(72, 215, 193, 0.16), transparent 30rem),",
        "linear-gradient(135deg, #0f1218 0%, #16131e 45%, #101824 100%);",
        "color: var(--text);",
        "font-family:",
        "Inter,",
        "ui-sans-serif,",
        "system-ui,",
        "-apple-system,",
        "BlinkMacSystemFont,",
        "\"Segoe UI\",",
        "sans-serif;",
        "}",
        "",
        ".state-overlay[data-visible=\"true\"] {",
        "opacity: 1;",
        "}",
        "",
        ".action-row button:first-child {",
        "background: linear-gradient(180deg, #24635f, #173b3d);",
        "}",
        "after css values"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Judge (codex) output"
        role="judge"
        logPath={join(workerDir, "output.log")}
        height={24}
      />
    );

    try {
      await waitForFrame(lastFrame, "after css values");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("· ok 0ms · code ");
      expect(frame).toContain("after css values");
      expect(frame).not.toContain("radial-gradient");
      expect(frame).not.toContain("font-family");
      expect(frame).not.toContain("BlinkMacSystemFont");
      expect(frame).not.toContain(".state-overlay");
      expect(frame).not.toContain("button:first-child");
    } finally {
      unmount();
    }
  });

  it("hides noisy process transcript blocks while keeping actionable errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-noise-"));
    const workerDir = join(root, "actor-mock");

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "worklog.md"), "Implemented speed controls.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "$ codex exec resume abc --skip-git-repo-check -",
        "2026-07-02T02:10:31.189874Z ERROR codex_models_manager::manager: failed to refresh available models: stream disconnected before completion: body: {\"data\":[{\"id\":\"gpt-5.5\"}],\"object\":\"list\"}",
        "# Role: Actor",
        "",
        "Read Judge files:",
        "- requirements.md",
        "- plan.md",
        "",
        "Feature mailbox writes:",
        "- actor-worklog.md",
        "- actor-replies.jsonl",
        "",
        "User request:",
        "设置速度",
        "",
        "ERROR: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
        "tokens used",
        "0"
      ].join("\n")
    );

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (codex) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={20}
      />
    );

    try {
      await waitForFrame(lastFrame, "Implemented speed controls.");

      const frame = lastFrame() ?? "";
      expect(frame).toContain("Implemented speed controls.");
      expect(frame).toContain("error · Codex context window full · start a new thread or clear history");
      expect(frame).not.toContain("codex_models_manager");
      expect(frame).not.toContain("{\"data\"");
      expect(frame).not.toContain("# Role: Actor");
      expect(frame).not.toContain("Feature mailbox writes");
      expect(frame).not.toContain("tokens used");
    } finally {
      unmount();
    }
  });

  it("uses expanded wrapped diff rows for the worker log scroll range", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-scroll-diff-"));
    const workerDir = join(root, "actor-mock");
    const viewports: Array<{ offset: number; maxOffset: number }> = [];

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "patch.diff"),
      [
        "diff --git a/src/long.ts b/src/long.ts",
        "index 1111111..2222222 100644",
        "--- a/src/long.ts",
        "+++ b/src/long.ts",
        "@@ -1,1 +1,1 @@",
        "+alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega repeated repeated repeated repeated repeated repeated repeated repeated repeated repeated repeated repeated"
      ].join("\n")
    );
    await writeFile(join(workerDir, "output.log"), "actor transcript\n");

    const { lastFrame, unmount } = render(
      <WorkerOutputView
        title="Actor (mock) output"
        role="actor"
        logPath={join(workerDir, "output.log")}
        height={5}
        onViewportChange={(viewport) => viewports.push(viewport)}
      />
    );

    try {
      await waitForFrame(lastFrame, "actor/mock");
      await waitForViewport(viewports, (viewport) => viewport.maxOffset > 4);
      expect(Math.max(...viewports.map((viewport) => viewport.maxOffset))).toBeGreaterThan(4);
    } finally {
      unmount();
    }
  });

  it("keeps nano worker log rendering responsive with large source-heavy transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-output-nano-large-"));
    const workerDir = join(root, "actor-mock");
    const previousColumns = process.stdout.columns;

    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "worklog.md"), "Implemented controls.\n");
    await writeFile(
      join(workerDir, "output.log"),
      [
        "process transcript start",
        "$ codex exec --sandbox workspace-write -",
        "Collapsed code output: 400 lines",
        "succeeded in 367ms:",
        "succeeded in 372ms:",
        ...Array.from({ length: 1200 }, (_, index) =>
          `${String(index + 1).padStart(4, " ")}  const value${index} = \"a long source listing line that should not be wrapped in nano mode\";`
        ),
        "ERROR: Codex ran out of room in the model's context window. Start a new thread or clear history.",
        "ERROR: Codex ran out of room in the model's context window. Start a new thread or clear history."
      ].join("\n")
    );

    try {
      for (const width of [10, 12]) {
        process.stdout.columns = width;
        const { lastFrame, unmount } = render(
          <WorkerOutputView
            title="Actor (mock) output (2/4)"
            role="actor"
            logPath={join(workerDir, "output.log")}
            height={8}
            terminalWidth={width}
          />
        );

        try {
          await waitForFrame(lastFrame, "ctx");

          const frame = lastFrame() ?? "";
          expect(frame).toContain("process");
          expect(frame).toContain("ctx");
          expect(frame).not.toContain("Loading worker log");
          expect(frame).not.toContain("$ codex");
          expect(frame).not.toContain("Collapsed");
          expect(frame).not.toContain("367ms");
          expect(frame).not.toContain("372ms");
          expect(frame).not.toContain("value1199");
          expect(frame.match(/\bctx\b/g)?.length ?? 0).toBe(1);
          expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(width);
        } finally {
          unmount();
        }
      }
    } finally {
      process.stdout.columns = previousColumns;
    }
  });
});

async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const frame = lastFrame() ?? "";
    if (frame.includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${text}\nFrame:\n${lastFrame() ?? ""}`);
}

async function waitForViewport(
  viewports: Array<{ offset: number; maxOffset: number }>,
  predicate: (viewport: { offset: number; maxOffset: number }) => boolean = () => true
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (viewports.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for viewport callback");
}
