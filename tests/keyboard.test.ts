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
