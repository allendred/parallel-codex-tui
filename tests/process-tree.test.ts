import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processTreeIsAlive, terminateProcessTree } from "../src/core/process-tree.js";

describe("process tree identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not signal a process group whose exited leader PID was reused", async () => {
    const child = exitedChild(4242);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 4242 && signal === 0) {
        return true;
      }
      if (pid === -4242 && signal === 0) {
        return true;
      }
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    expect(processTreeIsAlive(child, true)).toBe(false);
    await expect(terminateProcessTree(child, {
      processGroup: true,
      label: "test worker"
    })).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("still terminates an original process group whose leader exited without PID reuse", async () => {
    const child = exitedChild(4343);
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 4343 && signal === 0) {
        throw processError("ESRCH");
      }
      if (pid === -4343 && signal === 0) {
        if (groupAlive) {
          return true;
        }
        throw processError("ESRCH");
      }
      if (pid === -4343 && signal === "SIGTERM") {
        groupAlive = false;
        return true;
      }
      throw new Error(`Unexpected signal ${String(signal)} for ${pid}`);
    });

    expect(processTreeIsAlive(child, true)).toBe(true);
    await expect(terminateProcessTree(child, {
      processGroup: true,
      label: "test worker",
      termGraceMs: 20,
      pollMs: 1
    })).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(-4343, "SIGTERM");
  });
});

function exitedChild(pid: number): ChildProcess {
  return {
    pid,
    exitCode: 0,
    signalCode: null
  } as ChildProcess;
}

function processError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
