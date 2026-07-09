import { describe, expect, it } from "vitest";
import {
  formatFooterHelp,
  formatSelectedWorkerStatus,
  formatStatusLine,
  formatWorkerRuntimeStatus
} from "../src/tui/status-line.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("formatStatusLine", () => {
  it("formats idle state", () => {
    expect(formatStatusLine(null)).toBe("idle");
  });

  it("formats worker states", () => {
    expect(
      formatStatusLine({
        taskId: "task-a1b2",
        judge: "done",
        actor: "running",
        critic: "waiting"
      })
    ).toBe("a1b2 | judge done | actor run | critic wait");
  });

  it("formats main chat state", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "running"
      })
    ).toBe("main | main run");
  });

  it("formats worker states as a compact summary instead of full worker logs", () => {
    const state = {
      taskId: "task-a1b2",
      workers: [
        { label: "Actor (codex)", status: "running/editing native:019f1e36...: writing files" },
        { label: "Critic (claude)", status: "done/process-exited: claude exited with code 0" },
        { label: "Critic (codex)", status: "failed/process-idle-timeout: codex produced no output" }
      ]
    };

    expect(formatStatusLine(state)).toBe("a1b2 | workers 3 | fail 1 run 1 done 1");
    expect(formatSelectedWorkerStatus(state, 1)).toBe("critic/claude done");
  });

  it("shortens dated task ids for the footer", () => {
    expect(
      formatStatusLine({
        taskId: "task-20260630-093326-1980",
        workers: [
          { label: "Judge (codex)", status: "done/process-exited" },
          { label: "Actor (codex)", status: "failed/process-exited" }
        ]
      })
    ).toBe("093326-1980 | workers 2 | fail 1 done 1");
  });

  it("formats runtime worker status as readable status text", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "failed",
        phase: "process-idle-timeout",
        summary: "claude produced no output for 300000ms",
        native_session_id: "abc123"
      })
    ).toBe("failed · idle timeout · session abc123 · claude produced no output for 300000ms");
  });

  it("keeps runtime worker status compact when the session id is long", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "done",
        phase: "process-exited",
        summary: "",
        native_session_id: "019f1b9b-768b-7753-9c3b-33b17f25bc6b"
      })
    ).toBe("done · exited · session 019f1b9b... · no summary");
  });

  it("truncates runtime worker status by terminal display width", () => {
    const status = formatWorkerRuntimeStatus({
      state: "running",
      phase: "editing",
      summary: "正在编写俄罗斯方块游戏界面并修复状态栏中文显示宽度问题让底部提示在窄屏也稳定",
      native_session_id: "abc123"
    });

    expect(status).toContain("...");
    expect(displayWidth(status)).toBeLessThanOrEqual(96);
  });

  it("omits empty runtime worker phases instead of showing filler text", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "running",
        phase: "",
        summary: "writing files"
      })
    ).toBe("running · writing files");
  });

  it("keeps footer help short and mode aware", () => {
    expect(formatFooterHelp("chat")).toBe("^W logs · Tab worker · ^O attach");
    expect(formatFooterHelp("worker")).toBe("wheel/Pg · Tab worker · ^O attach · Esc chat");
    expect(formatFooterHelp("native")).toBe("wheel/Pg · ^] logs");
  });
});
