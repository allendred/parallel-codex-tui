import { describe, expect, it, vi } from "vitest";
import { commitWorkspaceTransition } from "../src/cli-workspace-transition.js";

interface TestWorkspace {
  name: string;
}

describe("CLI workspace transition", () => {
  it("renders the prepared workspace before closing the previous runtime", () => {
    const previous = { name: "previous" };
    const next = { name: "next" };
    const events: string[] = [];

    const current = commitWorkspaceTransition({
      previous,
      next,
      render: (workspace) => events.push(`render:${workspace.name}`),
      close: (workspace) => events.push(`close:${workspace.name}`),
      deferClose: (workspace) => events.push(`defer:${workspace.name}`)
    });

    expect(current).toBe(next);
    expect(events).toEqual(["render:next", "close:previous"]);
  });

  it("closes the prepared runtime and leaves the previous one open when rendering fails", () => {
    const previous = { name: "previous" };
    const next = { name: "next" };
    const renderError = new Error("render failed");
    const close = vi.fn<(workspace: TestWorkspace) => void>();

    expect(() => commitWorkspaceTransition({
      previous,
      next,
      render: () => {
        throw renderError;
      },
      close,
      deferClose: vi.fn()
    })).toThrow(renderError);

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(next);
  });

  it("preserves rendering and prepared-runtime cleanup failures together", () => {
    const renderError = new Error("render failed");
    const cleanupError = new Error("next close failed");

    const failure = captureFailure(() => commitWorkspaceTransition({
      previous: { name: "previous" },
      next: { name: "next" },
      render: () => {
        throw renderError;
      },
      close: () => {
        throw cleanupError;
      },
      deferClose: vi.fn()
    }));

    expect(failure.message).toContain("render failed");
    expect(failure.message).toContain("prepared workspace cleanup failed: next close failed");
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([renderError, cleanupError]);
  });

  it("keeps a committed switch successful when closing the previous runtime fails", () => {
    const previous = { name: "previous" };
    const next = { name: "next" };
    const closeError = new Error("previous close failed");
    const deferClose = vi.fn<(workspace: TestWorkspace, error: unknown) => void>();

    const current = commitWorkspaceTransition({
      previous,
      next,
      render: vi.fn(),
      close: () => {
        throw closeError;
      },
      deferClose
    });

    expect(current).toBe(next);
    expect(deferClose).toHaveBeenCalledWith(previous, closeError);
  });
});

function captureFailure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected Error, received ${String(error)}`);
  }
  throw new Error("Expected operation to fail.");
}
