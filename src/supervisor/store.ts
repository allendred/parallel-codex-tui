import { randomUUID } from "node:crypto";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import {
  appendJsonLine,
  ensureDir,
  pathExists,
  readJson,
  readTextIfExists,
  removeIfExists,
  writeJson
} from "../core/file-store.js";
import { processIsAlive, readProcessStartToken } from "../core/process-identity.js";
import {
  SupervisorCommandSchema,
  SupervisorControllerSchema,
  SupervisorRunEventSchema,
  SupervisorRunRequestSchema,
  SupervisorRunStateSchema,
  type SupervisorCommand,
  type SupervisorController,
  type SupervisorRunEvent,
  type SupervisorRunRequest,
  type SupervisorRunState
} from "./protocol.js";

const SUPERVISOR_DIR = "supervisor";
const RUNS_DIR = "runs";
const REQUEST_FILE = "request.json";
const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";
const COMMANDS_FILE = "commands.jsonl";
const CONTROLLER_FILE = "controller.json";
const ACKNOWLEDGED_FILE = "acknowledged.json";

export interface SupervisorRunFiles {
  dir: string;
  requestPath: string;
  statePath: string;
  eventsPath: string;
  commandsPath: string;
  controllerPath: string;
  acknowledgedPath: string;
}

export interface SupervisorRunRecord {
  files: SupervisorRunFiles;
  state: SupervisorRunState;
}

export interface SupervisorControllerLease {
  owner: SupervisorController;
  release(): Promise<void>;
}

export function supervisorRoot(workspaceRoot: string, dataDir: string): string {
  return join(workspaceRoot, dataDir, SUPERVISOR_DIR);
}

export function supervisorRunsRoot(workspaceRoot: string, dataDir: string): string {
  return join(supervisorRoot(workspaceRoot, dataDir), RUNS_DIR);
}

export function supervisorRunFiles(runDir: string): SupervisorRunFiles {
  return {
    dir: runDir,
    requestPath: join(runDir, REQUEST_FILE),
    statePath: join(runDir, STATE_FILE),
    eventsPath: join(runDir, EVENTS_FILE),
    commandsPath: join(runDir, COMMANDS_FILE),
    controllerPath: join(runDir, CONTROLLER_FILE),
    acknowledgedPath: join(runDir, ACKNOWLEDGED_FILE)
  };
}

export function createSupervisorRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

export async function createSupervisorRun(
  workspaceRoot: string,
  dataDir: string,
  request: SupervisorRunRequest
): Promise<SupervisorRunFiles> {
  const runsRoot = supervisorRunsRoot(workspaceRoot, dataDir);
  const files = supervisorRunFiles(join(runsRoot, request.run_id));
  const stagingFiles = supervisorRunFiles(join(
    runsRoot,
    `.${request.run_id}.${process.pid}.${randomUUID().slice(0, 8)}.pending`
  ));
  const now = request.created_at;
  await ensureDir(stagingFiles.dir);
  try {
    await writeJson(stagingFiles.requestPath, SupervisorRunRequestSchema.parse(request));
    await writeSupervisorRunState(stagingFiles, {
      version: 1,
      run_id: request.run_id,
      kind: request.kind,
      status: "queued",
      app_root: request.app_root,
      workspace_root: request.workspace_root,
      created_at: now,
      updated_at: now,
      ...(request.kind === "handle-request" ? {} : { task_id: request.task_id })
    });
    await rename(stagingFiles.dir, files.dir);
  } catch (error) {
    await rm(stagingFiles.dir, { recursive: true, force: true });
    throw error;
  }
  return files;
}

export async function readSupervisorRunRequest(files: SupervisorRunFiles): Promise<SupervisorRunRequest> {
  return readJson(files.requestPath, SupervisorRunRequestSchema);
}

export async function readSupervisorRunState(files: SupervisorRunFiles): Promise<SupervisorRunState> {
  return readJson(files.statePath, SupervisorRunStateSchema);
}

export async function writeSupervisorRunState(
  files: SupervisorRunFiles,
  state: SupervisorRunState
): Promise<void> {
  await writeJson(files.statePath, SupervisorRunStateSchema.parse(state));
}

export async function appendSupervisorEvent(
  files: SupervisorRunFiles,
  event: SupervisorRunEvent
): Promise<void> {
  await appendJsonLine(files.eventsPath, SupervisorRunEventSchema.parse(event));
}

export async function readSupervisorEvents(files: SupervisorRunFiles): Promise<SupervisorRunEvent[]> {
  return readJsonLines(files.eventsPath, SupervisorRunEventSchema);
}

export async function appendSupervisorCommand(
  files: SupervisorRunFiles,
  command: SupervisorCommand
): Promise<void> {
  await appendJsonLine(files.commandsPath, SupervisorCommandSchema.parse(command));
}

export async function readSupervisorCommands(files: SupervisorRunFiles): Promise<SupervisorCommand[]> {
  return readJsonLines(files.commandsPath, SupervisorCommandSchema);
}

export async function acknowledgeSupervisorRun(files: SupervisorRunFiles): Promise<void> {
  await writeJson(files.acknowledgedPath, {
    version: 1,
    acknowledged_at: new Date().toISOString(),
    pid: process.pid
  });
}

export async function supervisorRunIsAcknowledged(files: SupervisorRunFiles): Promise<boolean> {
  return pathExists(files.acknowledgedPath);
}

export async function readSupervisorController(
  files: SupervisorRunFiles
): Promise<SupervisorController | null> {
  return readValidJson(files.controllerPath, SupervisorControllerSchema);
}

export async function listSupervisorRuns(
  workspaceRoot: string,
  dataDir: string
): Promise<SupervisorRunRecord[]> {
  const root = supervisorRunsRoot(workspaceRoot, dataDir);
  if (!(await pathExists(root))) {
    return [];
  }
  const names = await readdir(root);
  const records: SupervisorRunRecord[] = [];
  for (const name of names) {
    if (!name.startsWith("run-")) {
      continue;
    }
    const files = supervisorRunFiles(join(root, name));
    const state = await readValidJson(files.statePath, SupervisorRunStateSchema);
    if (state) {
      records.push({ files, state });
    }
  }
  return records.sort((left, right) => left.state.created_at.localeCompare(right.state.created_at));
}

export function supervisorRunIsTerminal(state: SupervisorRunState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}

export async function supervisorRunProcessIsActive(state: SupervisorRunState): Promise<boolean> {
  if (!state.pid || !processIsAlive(state.pid)) {
    return false;
  }
  if (!state.process_start_token) {
    return true;
  }
  return await readProcessStartToken(state.pid) === state.process_start_token;
}

export async function claimSupervisorController(
  files: SupervisorRunFiles,
  options: { controllerId?: string; pid?: number; now?: () => Date } = {}
): Promise<SupervisorControllerLease | null> {
  const pid = options.pid ?? process.pid;
  const owner = SupervisorControllerSchema.parse({
    version: 1,
    controller_id: options.controllerId ?? randomUUID(),
    pid,
    acquired_at: (options.now ?? (() => new Date()))().toISOString(),
    ...await optionalProcessStartToken(pid)
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await writeJsonExclusive(files.controllerPath, owner)) {
      return {
        owner,
        release: () => releaseSupervisorController(files, owner.controller_id)
      };
    }
    const current = await readValidJson(files.controllerPath, SupervisorControllerSchema);
    if (current && await supervisorControllerIsActive(current)) {
      return null;
    }
    await removeControllerIfOwned(files.controllerPath, current?.controller_id);
  }
  return null;
}

async function releaseSupervisorController(files: SupervisorRunFiles, controllerId: string): Promise<void> {
  await removeControllerIfOwned(files.controllerPath, controllerId);
}

async function removeControllerIfOwned(path: string, controllerId?: string): Promise<void> {
  if (controllerId) {
    const current = await readValidJson(path, SupervisorControllerSchema);
    if (!current || current.controller_id !== controllerId) {
      return;
    }
  }
  await removeIfExists(path);
}

export async function supervisorControllerIsActive(controller: SupervisorController): Promise<boolean> {
  if (!processIsAlive(controller.pid)) {
    return false;
  }
  if (!controller.process_start_token) {
    return true;
  }
  return await readProcessStartToken(controller.pid) === controller.process_start_token;
}

async function optionalProcessStartToken(pid: number): Promise<{ process_start_token?: string }> {
  const token = await readProcessStartToken(pid);
  return token ? { process_start_token: token } : {};
}

async function writeJsonExclusive(path: string, value: unknown): Promise<boolean> {
  try {
    await ensureDir(dirname(path));
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function readJsonLines<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema
): Promise<Array<z.output<TSchema>>> {
  const text = await readTextIfExists(path);
  const records: Array<z.output<TSchema>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) {
        records.push(parsed.data);
      }
    } catch {
      // A partial final line is ignored until the next poll completes it.
    }
  }
  return records;
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
