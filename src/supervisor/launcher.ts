import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireProcessMutationTurn, type ProcessMutationTurn } from "../core/process-mutation-turn.js";
import type { SupervisorRunRequest } from "./protocol.js";
import {
  readSupervisorRunState,
  supervisorRoot,
  type SupervisorRunFiles
} from "./store.js";

const SUBMISSION_INTENT_PREFIX = ".run-submission-";
const SUBMISSION_RELEASE_ATTEMPTS = 3;

export type SupervisorLauncher = (
  files: SupervisorRunFiles,
  request: SupervisorRunRequest
) => Promise<void>;

export type SupervisorSubmissionTurnAcquirer = (
  workspaceRoot: string,
  dataDir: string
) => Promise<ProcessMutationTurn>;

export interface SupervisorSubmissionTurnResult<Result> {
  value: Result;
  releaseError: Error | null;
}

export function acquireSupervisorSubmissionTurn(
  workspaceRoot: string,
  dataDir: string
): Promise<ProcessMutationTurn> {
  return acquireProcessMutationTurn(supervisorRoot(workspaceRoot, dataDir), {
    intentPrefix: SUBMISSION_INTENT_PREFIX,
    timeoutMs: 10000,
    pollMs: 10,
    timeoutMessage: "Timed out waiting to submit a Supervisor run."
  });
}

export async function runWithSupervisorSubmissionTurn<Result>(
  workspaceRoot: string,
  dataDir: string,
  run: () => Promise<Result>,
  acquire: SupervisorSubmissionTurnAcquirer = acquireSupervisorSubmissionTurn
): Promise<SupervisorSubmissionTurnResult<Result>> {
  const turn = await acquire(workspaceRoot, dataDir);
  const outcome = await run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const releaseError = await releaseSupervisorSubmissionTurn(turn);

  if (!outcome.ok) {
    if (releaseError) {
      throw new Error(
        `${errorMessage(outcome.error)}; Supervisor submission lock cleanup failed: ${releaseError.message}`,
        { cause: new AggregateError([outcome.error, releaseError]) }
      );
    }
    throw outcome.error;
  }

  return { value: outcome.value, releaseError };
}

export function supervisorSubmissionLockWarning(error: Error): string {
  return `Run submission succeeded, but lock cleanup failed after ${SUBMISSION_RELEASE_ATTEMPTS} attempts: ${error.message}`;
}

export async function launchSupervisorProcess(
  files: SupervisorRunFiles,
  _request: SupervisorRunRequest
): Promise<void> {
  const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
  if (!entrypoint) {
    throw new Error("Cannot locate the parallel-codex-tui CLI entrypoint for Supervisor launch.");
  }
  const errorLog = openSync(join(files.dir, "supervisor.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, entrypoint], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      PCT_SUPERVISOR_RUN_DIR: files.dir
    },
    stdio: ["ignore", "ignore", errorLog]
  });
  try {
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
  } finally {
    closeSync(errorLog);
  }
  let exitCode: number | null | undefined;
  const onExit = (code: number | null) => {
    exitCode = code;
  };
  child.once("exit", onExit);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await readSupervisorRunState(files);
    if (state.status !== "queued") {
      child.off("exit", onExit);
      child.unref();
      return;
    }
    if (exitCode !== undefined) {
      throw new Error(`Supervisor process exited before startup (code ${exitCode ?? "signal"}).`);
    }
    await delay(25);
  }
  child.off("exit", onExit);
  try {
    child.kill("SIGTERM");
  } catch {
    // The startup timeout below remains the useful error when the child already exited.
  }
  throw new Error("Supervisor process did not publish startup state within 5s.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function releaseSupervisorSubmissionTurn(turn: ProcessMutationTurn): Promise<Error | null> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= SUBMISSION_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await turn.release();
      return null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < SUBMISSION_RELEASE_ATTEMPTS) {
        await delay(attempt * 10);
      }
    }
  }
  return lastError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
