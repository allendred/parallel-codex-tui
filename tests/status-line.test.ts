import { describe, expect, it } from "vitest";
import {
  formatFooterHelp,
  formatSelectedWorkerStatus,
  formatStatusLine,
  formatWorkerRuntimeStatus
} from "../src/tui/status-line.js";

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

  it("formats runtime worker status with phase and summary", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "failed",
        phase: "process-idle-timeout",
        summary: "claude produced no output for 300000ms",
        native_session_id: "abc123"
      })
    ).toBe("failed/process-idle-timeout native:abc123: claude produced no output for 300000ms");
  });

  it("keeps footer help short and mode aware", () => {
    expect(formatFooterHelp("chat")).toBe("^W logs · Tab worker · ^O attach");
    expect(formatFooterHelp("worker")).toBe("wheel/Pg · Tab worker · ^O attach · Esc chat");
    expect(formatFooterHelp("native")).toBe("wheel/Pg · ^] logs");
  });
});
