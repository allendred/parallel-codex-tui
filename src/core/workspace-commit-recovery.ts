import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sessionsRoot } from "./paths.js";

const TASK_DIRECTORY_PATTERN = /^task-/;
const TURN_DIRECTORY_PATTERN = /^turn-(\d{4,})$/;
const WAVE_DIRECTORY_PATTERN = /^wave-(\d{4,})$/;
const COMMIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export interface WorkspaceCommitRecovery {
  cleaned: number;
  preserved: number;
}

interface CommitEvidence {
  version: 1;
  state: "committing" | "integrated";
  turnId: string;
  wave: number;
  featureIds: string[];
  commitId?: string;
  changedPaths: string[];
}

export async function reconcileWorkspaceCommitIntents(
  projectRoot: string,
  dataDir: string
): Promise<WorkspaceCommitRecovery> {
  const recovery: WorkspaceCommitRecovery = { cleaned: 0, preserved: 0 };
  const taskEntries = await directoryEntries(sessionsRoot(projectRoot, dataDir));

  for (const taskEntry of taskEntries) {
    if (!taskEntry.isDirectory() || !TASK_DIRECTORY_PATTERN.test(taskEntry.name)) {
      continue;
    }
    const workspacesDir = join(sessionsRoot(projectRoot, dataDir), taskEntry.name, "workspaces");
    for (const turnEntry of await directoryEntries(workspacesDir)) {
      const turnMatch = turnEntry.isDirectory() ? TURN_DIRECTORY_PATTERN.exec(turnEntry.name) : null;
      if (!turnMatch) {
        continue;
      }
      for (const waveEntry of await directoryEntries(join(workspacesDir, turnEntry.name))) {
        const waveMatch = waveEntry.isDirectory() ? WAVE_DIRECTORY_PATTERN.exec(waveEntry.name) : null;
        if (!waveMatch) {
          continue;
        }
        const waveDir = join(workspacesDir, turnEntry.name, waveEntry.name);
        const pendingPath = join(waveDir, "integration.pending.json");
        const pendingRecord = await readJsonRecord(pendingPath);
        if (pendingRecord === undefined) {
          continue;
        }
        const pending = parseCommitEvidence(pendingRecord, "committing");
        const integrated = parseCommitEvidence(
          await readJsonRecord(join(waveDir, "integration.json")),
          "integrated"
        );
        const directoryTurnId = turnMatch[1];
        const directoryWave = Number(waveMatch[1]);
        if (
          !pending
          || !integrated
          || pending.turnId !== directoryTurnId
          || pending.wave !== directoryWave
          || !sameCommit(pending, integrated)
        ) {
          recovery.preserved += 1;
          continue;
        }
        try {
          await rm(pendingPath, { force: true });
          recovery.cleaned += 1;
        } catch {
          recovery.preserved += 1;
        }
      }
    }
  }
  return recovery;
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

function parseCommitEvidence(
  record: Record<string, unknown> | null | undefined,
  state: CommitEvidence["state"]
): CommitEvidence | null {
  const featureIds = stringArray(record?.feature_ids);
  const changedPaths = stringArray(record?.changed_paths);
  const commitId = record?.commit_id;
  if (
    record?.version !== 1
    || record.state !== state
    || typeof record.turn_id !== "string"
    || !Number.isInteger(record.wave)
    || (record.wave as number) < 1
    || !featureIds
    || !changedPaths
    || (commitId !== undefined && (typeof commitId !== "string" || !COMMIT_ID_PATTERN.test(commitId)))
  ) {
    return null;
  }
  return {
    version: 1,
    state,
    turnId: record.turn_id,
    wave: record.wave as number,
    featureIds,
    ...(typeof commitId === "string" ? { commitId } : {}),
    changedPaths
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : null;
}

function sameCommit(pending: CommitEvidence, integrated: CommitEvidence): boolean {
  return pending.turnId === integrated.turnId
    && pending.wave === integrated.wave
    && sameStrings(pending.featureIds, integrated.featureIds)
    && sameStrings(pending.changedPaths, integrated.changedPaths)
    && (pending.commitId === undefined || pending.commitId === integrated.commitId);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
