import { describe, expect, it } from "vitest";
import { isAttachShortcut, isExitShortcut, isLogsShortcut, mouseScrollDelta, scrollDelta } from "../src/tui/keyboard.js";
import * as keyboardModule from "../src/tui/keyboard.js";

describe("keyboard shortcuts", () => {
  it("recognizes Ink ctrl-letter input for logs and native attach", () => {
    expect(isLogsShortcut("w", { ctrl: true })).toBe(true);
    expect(isAttachShortcut("o", { ctrl: true })).toBe(true);
  });

  it("recognizes raw control characters for logs and native attach", () => {
    expect(isLogsShortcut("\u0017", { ctrl: false })).toBe(true);
    expect(isAttachShortcut("\u000f", { ctrl: false })).toBe(true);
  });

  it("recognizes ctrl-c as an outer exit shortcut", () => {
    expect(isExitShortcut("c", { ctrl: true })).toBe(true);
    expect(isExitShortcut("\u0003", { ctrl: false })).toBe(true);
  });

  it("recognizes ctrl-n as the new-task shortcut", () => {
    const isNewTaskShortcut = (
      keyboardModule as typeof keyboardModule & {
        isNewTaskShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isNewTaskShortcut;

    expect(isNewTaskShortcut).toBeTypeOf("function");
    expect(isNewTaskShortcut?.("n", { ctrl: true })).toBe(true);
    expect(isNewTaskShortcut?.("\u000e", { ctrl: false })).toBe(true);
    expect(isNewTaskShortcut?.("n", { ctrl: false })).toBe(false);
  });

  it("recognizes ctrl-p as the workspace switcher shortcut", () => {
    const isWorkspaceShortcut = (
      keyboardModule as typeof keyboardModule & {
        isWorkspaceShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isWorkspaceShortcut;

    expect(isWorkspaceShortcut).toBeTypeOf("function");
    expect(isWorkspaceShortcut?.("p", { ctrl: true })).toBe(true);
    expect(isWorkspaceShortcut?.("\u0010", { ctrl: false })).toBe(true);
    expect(isWorkspaceShortcut?.("p", { ctrl: false })).toBe(false);
  });

  it("recognizes ctrl-g as the Router diagnostics shortcut", () => {
    const isRouterDiagnosticsShortcut = (
      keyboardModule as typeof keyboardModule & {
        isRouterDiagnosticsShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isRouterDiagnosticsShortcut;

    expect(isRouterDiagnosticsShortcut).toBeTypeOf("function");
    expect(isRouterDiagnosticsShortcut?.("g", { ctrl: true })).toBe(true);
    expect(isRouterDiagnosticsShortcut?.("\u0007", { ctrl: false })).toBe(true);
    expect(isRouterDiagnosticsShortcut?.("g", { ctrl: false })).toBe(false);
  });

  it("recognizes ctrl-b as the Worker overview shortcut", () => {
    const isWorkerOverviewShortcut = (
      keyboardModule as typeof keyboardModule & {
        isWorkerOverviewShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isWorkerOverviewShortcut;

    expect(isWorkerOverviewShortcut).toBeTypeOf("function");
    expect(isWorkerOverviewShortcut?.("b", { ctrl: true })).toBe(true);
    expect(isWorkerOverviewShortcut?.("\u0002", { ctrl: false })).toBe(true);
    expect(isWorkerOverviewShortcut?.("b", { ctrl: false })).toBe(false);
  });

  it("recognizes ctrl-t as the Task sessions shortcut", () => {
    const isTaskSessionsShortcut = (
      keyboardModule as typeof keyboardModule & {
        isTaskSessionsShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isTaskSessionsShortcut;

    expect(isTaskSessionsShortcut).toBeTypeOf("function");
    expect(isTaskSessionsShortcut?.("t", { ctrl: true })).toBe(true);
    expect(isTaskSessionsShortcut?.("\u0014", { ctrl: false })).toBe(true);
    expect(isTaskSessionsShortcut?.("t", { ctrl: false })).toBe(false);
  });

  it("recognizes ctrl-d as the task-result shortcut", () => {
    const isTaskResultShortcut = (
      keyboardModule as typeof keyboardModule & {
        isTaskResultShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isTaskResultShortcut;

    expect(isTaskResultShortcut).toBeTypeOf("function");
    expect(isTaskResultShortcut?.("d", { ctrl: true })).toBe(true);
    expect(isTaskResultShortcut?.("\u0004", { ctrl: false })).toBe(true);
    expect(isTaskResultShortcut?.("d", { ctrl: false })).toBe(false);
  });

  it("recognizes ctrl-s as the status details shortcut", () => {
    const isStatusDetailsShortcut = (
      keyboardModule as typeof keyboardModule & {
        isStatusDetailsShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isStatusDetailsShortcut;

    expect(isStatusDetailsShortcut).toBeTypeOf("function");
    expect(isStatusDetailsShortcut?.("s", { ctrl: true })).toBe(true);
    expect(isStatusDetailsShortcut?.("\u0013", { ctrl: false })).toBe(true);
    expect(isStatusDetailsShortcut?.("s", { ctrl: false })).toBe(false);
  });

  it("recognizes worker log search and semantic jump shortcuts", () => {
    const isWorkerSearchShortcut = (
      keyboardModule as typeof keyboardModule & {
        isWorkerSearchShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isWorkerSearchShortcut;
    const workerLogJumpKind = (
      keyboardModule as typeof keyboardModule & {
        workerLogJumpKind?: (input: string) => "error" | "diff" | null;
      }
    ).workerLogJumpKind;

    expect(isWorkerSearchShortcut).toBeTypeOf("function");
    expect(isWorkerSearchShortcut?.("f", { ctrl: true })).toBe(true);
    expect(isWorkerSearchShortcut?.("\u0006", { ctrl: false })).toBe(true);
    expect(isWorkerSearchShortcut?.("f", { ctrl: false })).toBe(false);
    expect(workerLogJumpKind).toBeTypeOf("function");
    expect(workerLogJumpKind?.("e")).toBe("error");
    expect(workerLogJumpKind?.("E")).toBe("error");
    expect(workerLogJumpKind?.("d")).toBe("diff");
    expect(workerLogJumpKind?.("D")).toBe("diff");
    expect(workerLogJumpKind?.("plain")).toBeNull();
  });

  it("recognizes ctrl-y as copy without colliding with plain input", () => {
    const isCopyShortcut = (
      keyboardModule as typeof keyboardModule & {
        isCopyShortcut?: (input: string, key: { ctrl?: boolean }) => boolean;
      }
    ).isCopyShortcut;

    expect(isCopyShortcut).toBeTypeOf("function");
    expect(isCopyShortcut?.("y", { ctrl: true })).toBe(true);
    expect(isCopyShortcut?.("\u0019", { ctrl: false })).toBe(true);
    expect(isCopyShortcut?.("y", { ctrl: false })).toBe(false);
  });

  it("does not treat plain letters as shortcuts", () => {
    expect(isLogsShortcut("w", { ctrl: false })).toBe(false);
    expect(isAttachShortcut("o", { ctrl: false })).toBe(false);
  });

  it("maps page and ctrl keys to scroll deltas", () => {
    expect(scrollDelta("", { pageUp: true }, 12)).toBe(12);
    expect(scrollDelta("", { pageDown: true }, 12)).toBe(-12);
    expect(scrollDelta("u", { ctrl: true }, 12)).toBe(12);
    expect(scrollDelta("d", { ctrl: true }, 12)).toBe(-12);
    expect(scrollDelta("u", { ctrl: false }, 12)).toBe(0);
  });

  it("maps raw terminal PageUp and PageDown sequences for chat history", () => {
    const rawPageScrollDelta = (
      keyboardModule as typeof keyboardModule & {
        rawPageScrollDelta?: (input: string, pageSize: number) => number;
      }
    ).rawPageScrollDelta;

    expect(rawPageScrollDelta).toBeTypeOf("function");
    expect(rawPageScrollDelta?.("\x1b[5~", 12)).toBe(12);
    expect(rawPageScrollDelta?.("\x1b[6~", 12)).toBe(-12);
    expect(rawPageScrollDelta?.("\x1b[5~\x1b[5~\x1b[6~", 12)).toBe(12);
    expect(rawPageScrollDelta?.("plain text", 12)).toBe(0);
  });

  it("maps raw terminal Up and Down sequences for draft history", () => {
    const rawHistoryDelta = (
      keyboardModule as typeof keyboardModule & {
        rawHistoryDelta?: (input: string) => number;
      }
    ).rawHistoryDelta;

    expect(rawHistoryDelta).toBeTypeOf("function");
    expect(rawHistoryDelta?.("\x1b[A")).toBe(1);
    expect(rawHistoryDelta?.("\x1bOA")).toBe(1);
    expect(rawHistoryDelta?.("\x1b[B")).toBe(-1);
    expect(rawHistoryDelta?.("\x1bOB")).toBe(-1);
    expect(rawHistoryDelta?.("\x1b[A\x1b[A\x1b[B")).toBe(1);
    expect(rawHistoryDelta?.("plain text")).toBe(0);
    expect(rawHistoryDelta?.("\x1b[C\x1b[D")).toBe(0);
  });

  it("separates unmodified alternate-scroll arrows from modified history arrows", () => {
    const rawPlainArrowDelta = (
      keyboardModule as typeof keyboardModule & {
        rawPlainArrowDelta?: (input: string) => number;
      }
    ).rawPlainArrowDelta;

    expect(rawPlainArrowDelta).toBeTypeOf("function");
    expect(rawPlainArrowDelta?.("\x1b[A\x1b[A\x1b[A")).toBe(3);
    expect(rawPlainArrowDelta?.("\x1bOB\x1bOB\x1bOB")).toBe(-3);
    expect(rawPlainArrowDelta?.("\x1b[1;5A\x1b[1;5B")).toBe(0);
  });

  it("maps SGR mouse wheel sequences to scroll deltas", () => {
    expect(mouseScrollDelta("\x1b[<64;10;5M", 3)).toBe(3);
    expect(mouseScrollDelta("\x1b[<65;10;5M", 3)).toBe(-3);
    expect(mouseScrollDelta("\x1b[<68;10;5M", 3)).toBe(3);
    expect(mouseScrollDelta("\x1b[<69;10;5M", 3)).toBe(-3);
  });

  it("maps legacy X10 mouse wheel sequences to scroll deltas", () => {
    expect(mouseScrollDelta("\x1b[M`*%", 3)).toBe(3);
    expect(mouseScrollDelta("\x1b[Ma*%", 3)).toBe(-3);
  });

  it("sums multiple mouse wheel events in one raw input chunk", () => {
    expect(mouseScrollDelta("\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M", 3)).toBe(3);
    expect(mouseScrollDelta("\x1b[M`*%\x1b[M`*%", 3)).toBe(6);
  });

  it("ignores non-wheel mouse sequences", () => {
    expect(mouseScrollDelta("\x1b[<0;10;5M", 3)).toBe(0);
    expect(mouseScrollDelta("plain text", 3)).toBe(0);
  });
});
