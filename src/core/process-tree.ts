import type { ChildProcess } from "node:child_process";

export interface ProcessTreeCleanupOptions {
  processGroup: boolean;
  label: string;
  termGraceMs?: number;
  killWaitMs?: number;
  pollMs?: number;
}

export class ProcessTreeCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessTreeCleanupError";
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeCleanupOptions
): Promise<void> {
  const pid = child.pid;
  if (!pid || !processTreeIsAlive(child, options.processGroup)) {
    return;
  }
  const termGraceMs = options.termGraceMs ?? 250;
  const killWaitMs = options.killWaitMs ?? 500;
  const pollMs = options.pollMs ?? 20;

  try {
    if (processGroupLeaderWasReused(child, options.processGroup)) {
      return;
    }
    signalProcessTree(pid, "SIGTERM", options.processGroup);
    if (await waitForProcessTreeExit(child, options.processGroup, termGraceMs, pollMs)) {
      return;
    }
    signalProcessTree(pid, "SIGKILL", options.processGroup);
    if (await waitForProcessTreeExit(child, options.processGroup, killWaitMs, pollMs)) {
      return;
    }
  } catch (error) {
    throw new ProcessTreeCleanupError(
      `Could not terminate ${options.label} ${pid}: ${errorMessage(error)}`
    );
  }
  throw new ProcessTreeCleanupError(
    `${options.label} group ${pid} remained alive after SIGKILL.`
  );
}

export function processTreeIsAlive(child: ChildProcess, processGroup: boolean): boolean {
  const pid = child.pid;
  if (!pid) {
    return false;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    if (processGroupLeaderWasReused(child, processGroup)) {
      return false;
    }
    return processGroup && signalTargetIsAlive(-pid);
  }
  if (processGroup && signalTargetIsAlive(-pid)) {
    return true;
  }
  return signalTargetIsAlive(pid);
}

function processGroupLeaderWasReused(child: ChildProcess, processGroup: boolean): boolean {
  // POSIX keeps the numeric PID reserved while the original process group still exists.
  return processGroup
    && (child.exitCode !== null || child.signalCode !== null)
    && typeof child.pid === "number"
    && signalTargetIsAlive(child.pid);
}

async function waitForProcessTreeExit(
  child: ChildProcess,
  processGroup: boolean,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeIsAlive(child, processGroup)) {
      return true;
    }
    await delay(pollMs);
  }
  return !processTreeIsAlive(child, processGroup);
}

function signalProcessTree(pid: number, signal: NodeJS.Signals, processGroup: boolean): void {
  try {
    process.kill(processGroup ? -pid : pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function signalTargetIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
