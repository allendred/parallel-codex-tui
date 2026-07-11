import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ensureDir, pathExists, readJson, removeIfExists, writeJson } from "./file-store.js";

const execFileAsync = promisify(execFile);

const TaskRunOwnerSchema = z.object({
  version: z.literal(1),
  owner_id: z.string().min(1),
  pid: z.number().int().positive(),
  acquired_at: z.string().datetime(),
  process_start_token: z.string().min(1).optional()
});

const TaskRunClaimIntentSchema = z.object({
  version: z.literal(1),
  intent_id: z.string().min(1),
  pid: z.number().int().positive(),
  created_at: z.string().datetime(),
  choosing: z.boolean(),
  ticket: z.number().int().nonnegative(),
  process_start_token: z.string().min(1).optional()
});

const CLAIM_INTENT_PREFIX = ".run-owner-claim-";
const CLAIM_INTENT_SUFFIX = ".json";
const CLAIM_INTENT_TIMEOUT_MS = 5000;
const CLAIM_INTENT_POLL_MS = 5;

const WorkerProcessRecordSchema = z.object({
  version: z.literal(1),
  worker_id: z.string().min(1),
  pid: z.number().int().positive(),
  process_group_id: z.number().int().positive().optional(),
  process_start_token: z.string().min(1).optional(),
  owner_pid: z.number().int().positive(),
  command: z.string().min(1),
  started_at: z.string().datetime()
});

export type TaskRunOwner = z.infer<typeof TaskRunOwnerSchema>;
type TaskRunClaimIntent = z.infer<typeof TaskRunClaimIntentSchema>;
type TaskRunMutationIdentity = Pick<TaskRunClaimIntent, "pid" | "process_start_token">;
export type WorkerProcessRecord = z.infer<typeof WorkerProcessRecordSchema>;
export type TaskRunLeaseInspection = {
  state: "missing" | "active" | "stale";
  owner: TaskRunOwner | null;
};
export type WorkerProcessTermination =
  | "missing"
  | "not-running"
  | "identity-mismatch"
  | "unverifiable"
  | "still-running"
  | "terminated";

export interface ClaimTaskRunLeaseOptions {
  ownerId?: string;
  pid?: number;
  now?: () => Date;
}

export interface TaskRunLease {
  owner: TaskRunOwner;
  release(): Promise<void>;
}

export class TaskRunLeaseConflictError extends Error {
  constructor(readonly owner: TaskRunOwner | null) {
    super(`Task is already running in another parallel-codex-tui process (pid ${owner?.pid ?? "unknown"}).`);
    this.name = "TaskRunLeaseConflictError";
  }
}

export interface WriteWorkerProcessRecordInput {
  workerId: string;
  pid: number;
  command: string;
  processGroupId?: number;
  now?: () => Date;
}

export function taskRunOwnerPath(taskDir: string): string {
  return join(taskDir, "run-owner.json");
}

export function workerProcessRecordPath(workerDir: string): string {
  return join(workerDir, "process.json");
}

export async function claimTaskRunLease(
  taskDir: string,
  options: ClaimTaskRunLeaseOptions = {}
): Promise<TaskRunLease> {
  const pid = options.pid ?? process.pid;
  const owner: TaskRunOwner = TaskRunOwnerSchema.parse({
    version: 1,
    owner_id: options.ownerId ?? randomUUID(),
    pid,
    acquired_at: (options.now ?? (() => new Date()))().toISOString(),
    ...await optionalProcessStartToken(pid)
  });
  const path = taskRunOwnerPath(taskDir);
  await ensureDir(taskDir);
  const mutationTurn = await acquireTaskRunMutationTurn(taskDir);

  try {
    if (await writeJsonExclusive(path, owner)) {
      return {
        owner,
        release: () => releaseTaskRunLease(taskDir, path, owner.owner_id)
      };
    }
    const inspection = await inspectTaskRunLease(taskDir);
    if (inspection.state === "active") {
      throw new TaskRunLeaseConflictError(inspection.owner);
    }
    await removeOwnedLease(path, inspection.owner?.owner_id);
    if (await writeJsonExclusive(path, owner)) {
      return {
        owner,
        release: () => releaseTaskRunLease(taskDir, path, owner.owner_id)
      };
    }
    const current = await inspectTaskRunLease(taskDir);
    throw new TaskRunLeaseConflictError(current.owner);
  } finally {
    await mutationTurn.release();
  }
}

export async function inspectTaskRunLease(taskDir: string): Promise<TaskRunLeaseInspection> {
  const path = taskRunOwnerPath(taskDir);
  if (!(await pathExists(path))) {
    return { state: "missing", owner: null };
  }
  const owner = await readValidJson(path, TaskRunOwnerSchema);
  if (!owner) {
    return { state: "stale", owner: null };
  }
  if (!processIsAlive(owner.pid)) {
    return { state: "stale", owner };
  }
  if (owner.process_start_token) {
    const currentToken = await readProcessStartToken(owner.pid);
    if (!currentToken || currentToken !== owner.process_start_token) {
      return { state: "stale", owner };
    }
  }
  return { state: "active", owner };
}

export async function clearStaleTaskRunLease(taskDir: string, owner?: TaskRunOwner | null): Promise<void> {
  const mutationTurn = await acquireTaskRunMutationTurn(taskDir);
  try {
    const inspection = await inspectTaskRunLease(taskDir);
    if (inspection.state !== "stale") {
      return;
    }
    await removeOwnedLease(taskRunOwnerPath(taskDir), owner?.owner_id ?? inspection.owner?.owner_id);
  } finally {
    await mutationTurn.release();
  }
}

export async function writeWorkerProcessRecord(
  workerDir: string,
  input: WriteWorkerProcessRecordInput
): Promise<WorkerProcessRecord> {
  const record = WorkerProcessRecordSchema.parse({
    version: 1,
    worker_id: input.workerId,
    pid: input.pid,
    ...(input.processGroupId ? { process_group_id: input.processGroupId } : {}),
    owner_pid: process.pid,
    command: input.command,
    started_at: (input.now ?? (() => new Date()))().toISOString(),
    ...await optionalProcessStartToken(input.pid)
  });
  await writeJson(workerProcessRecordPath(workerDir), record);
  return record;
}

export async function clearWorkerProcessRecord(workerDir: string): Promise<void> {
  await removeIfExists(workerProcessRecordPath(workerDir));
}

export async function terminateOwnedWorkerProcess(workerDir: string): Promise<WorkerProcessTermination> {
  const path = workerProcessRecordPath(workerDir);
  if (!(await pathExists(path))) {
    return "missing";
  }
  const record = await readValidJson(path, WorkerProcessRecordSchema);
  if (!record) {
    return "unverifiable";
  }
  const leaderIsAlive = processIsAlive(record.pid);
  if (!ownedProcessIsAlive(record)) {
    await removeIfExists(path);
    return "not-running";
  }
  if (!record.process_start_token) {
    return "unverifiable";
  }
  if (leaderIsAlive) {
    const currentToken = await readProcessStartToken(record.pid);
    if (!currentToken) {
      return "unverifiable";
    }
    if (currentToken !== record.process_start_token) {
      return "identity-mismatch";
    }
  }

  signalOwnedProcess(record, "SIGTERM");
  if (!(await waitForOwnedProcessExit(record, 1500))) {
    if (!targetsProcessGroup(record)) {
      const tokenBeforeKill = await readProcessStartToken(record.pid);
      if (tokenBeforeKill !== record.process_start_token) {
        return "identity-mismatch";
      }
    }
    signalOwnedProcess(record, "SIGKILL");
    await waitForOwnedProcessExit(record, 500);
  }
  if (!ownedProcessIsAlive(record)) {
    await removeIfExists(path);
    return "terminated";
  }
  return "still-running";
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readProcessStartToken(pid: number): Promise<string | null> {
  if (!processIsAlive(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      const startTick = fields[19];
      if (startTick) {
        return `linux:${startTick}`;
      }
    } catch {
      // Fall through to ps when procfs is unavailable.
    }
  }
  if (process.platform !== "win32") {
    try {
      const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1000
      });
      const value = String(result.stdout).trim().replace(/\s+/g, " ");
      return value ? `ps:${value}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function optionalProcessStartToken(pid: number): Promise<{ process_start_token?: string }> {
  const processStartToken = await readProcessStartToken(pid);
  return processStartToken ? { process_start_token: processStartToken } : {};
}

async function writeJsonExclusive(path: string, value: unknown): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function acquireTaskRunMutationTurn(taskDir: string): Promise<{ release(): Promise<void> }> {
  await ensureDir(taskDir);
  const identity = await currentMutationIdentity();
  const intentId = randomUUID();
  const path = claimIntentPath(taskDir, intentId);
  let intent: TaskRunClaimIntent = TaskRunClaimIntentSchema.parse({
    version: 1,
    intent_id: intentId,
    pid: identity.pid,
    created_at: new Date().toISOString(),
    choosing: true,
    ticket: 0,
    ...(identity.process_start_token ? { process_start_token: identity.process_start_token } : {})
  });
  await writeJson(path, intent);

  try {
    const existing = await readActiveClaimIntents(taskDir);
    intent = {
      ...intent,
      choosing: false,
      ticket: Math.max(0, ...existing.map((candidate) => candidate.ticket)) + 1
    };
    await writeJson(path, intent);

    const deadline = Date.now() + CLAIM_INTENT_TIMEOUT_MS;
    while (true) {
      const candidates = await readActiveClaimIntents(taskDir);
      const blocked = candidates.some((candidate) => (
        candidate.intent_id !== intent.intent_id
        && (candidate.choosing || claimIntentPrecedes(candidate, intent))
      ));
      if (!blocked) {
        let released = false;
        return {
          release: async () => {
            if (released) {
              return;
            }
            released = true;
            await removeIfExists(path);
          }
        };
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting to update task run ownership.");
      }
      await delay(CLAIM_INTENT_POLL_MS);
    }
  } catch (error) {
    await removeIfExists(path);
    throw error;
  }
}

async function releaseTaskRunLease(taskDir: string, path: string, ownerId: string): Promise<void> {
  const mutationTurn = await acquireTaskRunMutationTurn(taskDir);
  try {
    await removeOwnedLease(path, ownerId);
  } finally {
    await mutationTurn.release();
  }
}

async function currentMutationIdentity(): Promise<TaskRunMutationIdentity> {
  return {
    pid: process.pid,
    ...await optionalProcessStartToken(process.pid)
  };
}

async function readActiveClaimIntents(taskDir: string): Promise<TaskRunClaimIntent[]> {
  const names = await readdir(taskDir);
  const tokenReads = new Map<number, Promise<string | null>>();
  const active: TaskRunClaimIntent[] = [];

  for (const name of names) {
    if (!name.startsWith(CLAIM_INTENT_PREFIX) || !name.endsWith(CLAIM_INTENT_SUFFIX)) {
      continue;
    }
    const path = join(taskDir, name);
    const intent = await readValidJson(path, TaskRunClaimIntentSchema);
    if (!intent || !processIsAlive(intent.pid)) {
      await removeIfExists(path);
      continue;
    }
    if (intent.process_start_token) {
      let tokenRead = tokenReads.get(intent.pid);
      if (!tokenRead) {
        tokenRead = readProcessStartToken(intent.pid);
        tokenReads.set(intent.pid, tokenRead);
      }
      const currentToken = await tokenRead;
      if (!currentToken || currentToken !== intent.process_start_token) {
        await removeIfExists(path);
        continue;
      }
    }
    active.push(intent);
  }

  return active;
}

function claimIntentPath(taskDir: string, intentId: string): string {
  return join(taskDir, `${CLAIM_INTENT_PREFIX}${intentId}${CLAIM_INTENT_SUFFIX}`);
}

function claimIntentPrecedes(candidate: TaskRunClaimIntent, current: TaskRunClaimIntent): boolean {
  if (candidate.ticket !== current.ticket) {
    return candidate.ticket < current.ticket;
  }
  return candidate.intent_id < current.intent_id;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeOwnedLease(path: string, ownerId?: string): Promise<void> {
  if (ownerId) {
    const current = await readValidJson(path, TaskRunOwnerSchema);
    if (!current || current.owner_id !== ownerId) {
      return;
    }
  }
  await removeIfExists(path);
}

async function readValidJson<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema
): Promise<z.output<TSchema> | null> {
  try {
    return await readJson(path, schema);
  } catch {
    return null;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function signalOwnedProcess(record: WorkerProcessRecord, signal: NodeJS.Signals): void {
  if (targetsProcessGroup(record)) {
    try {
      process.kill(-record.process_group_id!, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  signalProcess(record.pid, signal);
}

function targetsProcessGroup(record: WorkerProcessRecord): record is WorkerProcessRecord & { process_group_id: number } {
  return Boolean(record.process_group_id && process.platform !== "win32");
}

function ownedProcessIsAlive(record: WorkerProcessRecord): boolean {
  return targetsProcessGroup(record)
    ? processGroupIsAlive(record.process_group_id)
    : processIsAlive(record.pid);
}

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForOwnedProcessExit(record: WorkerProcessRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcessIsAlive(record)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return !ownedProcessIsAlive(record);
}
