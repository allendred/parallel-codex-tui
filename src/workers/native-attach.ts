import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { spawn } from "node-pty";
import type { AppConfig } from "../core/config.js";
import { pathExists, pathIsDirectory, readJson, readTextIfExists, removeIfExists, writeJson } from "../core/file-store.js";
import { NativeSessionSchema, TaskMetaSchema, type EngineName, type NativeSession } from "../domain/schemas.js";
import type { WorkerLogRef } from "../orchestrator/orchestrator.js";
import { detectResumeSessionId } from "./native-session-detection.js";
import type { WorkerCapabilityRunConfig, WorkerModelRunConfig } from "./types.js";

const require = createRequire(import.meta.url);

export interface NativeAttachLaunchInput {
  config: AppConfig;
  worker: WorkerLogRef;
}

export interface NativeAttachLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  sessionId: string;
  label: string;
  cols?: number;
  rows?: number;
}

export interface NativeAttachProcessHandlers {
  onOutput?: (chunk: string) => void;
  onClose?: (code: number) => void;
  onError?: (error: Error) => void;
}

export interface NativeAttachProcessRef {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export async function buildNativeAttachLaunch(input: NativeAttachLaunchInput): Promise<NativeAttachLaunch> {
  return buildNativeSessionLaunch(input, "resume");
}

export async function buildNativeForkLaunch(input: NativeAttachLaunchInput): Promise<NativeAttachLaunch> {
  return buildNativeSessionLaunch(input, "fork");
}

async function buildNativeSessionLaunch(
  input: NativeAttachLaunchInput,
  mode: "resume" | "fork"
): Promise<NativeAttachLaunch> {
  const nativeSession = await readWorkerNativeSession(input.worker);
  const workerConfig = input.config.workers[input.worker.engine];
  const modelConfig = workerConfig.model;
  const env = modelEnvironment(modelConfig);
  const interactiveArgs = mode === "fork"
    ? workerConfig.interactive.forkArgs
    : workerConfig.interactive.args;
  if (mode === "fork" && interactiveArgs.length === 0) {
    throw new Error(
      `Native session fork is not configured for ${input.worker.engine}. `
      + `Set workers.${input.worker.engine}.interactive.forkArgs with a {sessionId} template.`
    );
  }
  const workerDir = dirname(input.worker.statusPath);
  const taskDir = dirname(workerDir);
  if (!(await pathExists(nativeSession.cwd))) {
    throw new Error(`Native session workspace not found for ${input.worker.label}: ${nativeSession.cwd}`);
  }
  if (!(await pathIsDirectory(nativeSession.cwd))) {
    throw new Error(`Native session workspace is not a directory for ${input.worker.label}: ${nativeSession.cwd}`);
  }
  const recordedDirs = nativeSession.writable_dirs?.length
    ? nativeSession.writable_dirs
    : isWithin(nativeSession.cwd, join(taskDir, "workspaces")) ? [taskDir] : [];
  const additionalDirs: string[] = [];
  for (const directory of recordedDirs) {
    if (directory !== nativeSession.cwd && await pathIsDirectory(directory)) {
      additionalDirs.push(directory);
    }
  }

  return {
    command: workerConfig.interactive.command,
    args: nativeAttachArgs({
      args: [
        ...interactiveArgs,
        ...modelConfig.args
      ].map((arg) => renderTemplate(arg, nativeSession.session_id, modelConfig)),
      capabilities: workerConfig.capabilities,
      additionalDirs
    }),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    cwd: nativeSession.cwd,
    sessionId: nativeSession.session_id,
    label: mode === "fork" ? `${input.worker.label} · fork` : input.worker.label
  };
}

function nativeAttachArgs(input: {
  args: string[];
  capabilities: WorkerCapabilityRunConfig;
  additionalDirs: string[];
}): string[] {
  if (input.additionalDirs.length === 0 || input.capabilities.writableDirArgs.length === 0) {
    return input.args;
  }
  const args = input.capabilities.profile === "codex"
    ? withCodexWritableSandbox(input.args)
    : input.args;
  return [
    ...args,
    ...[...new Set(input.additionalDirs)].flatMap((directory) => (
      input.capabilities.writableDirArgs.map((arg) => arg.replaceAll("{dir}", directory))
    ))
  ];
}

function withCodexWritableSandbox(args: string[]): string[] {
  const sandbox = codexSandboxSelection(args);
  if (sandbox === "read-only") {
    throw new Error(
      "Codex native attach cannot use recorded worker directories with a read-only sandbox. "
      + "Set workers.codex.interactive.args to workspace-write or danger-full-access."
    );
  }
  return sandbox ? args : [...args, "--sandbox", "workspace-write"];
}

function codexSandboxSelection(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      return "danger-full-access";
    }
    if (arg === "--sandbox" || arg === "-s") {
      return args[index + 1]?.trim().toLowerCase() || null;
    }
    const match = arg.match(/^(?:--sandbox|-s)=(.+)$/);
    if (match) {
      return match[1]?.trim().toLowerCase() || null;
    }
  }
  return null;
}

function isWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

export function startNativeAttachProcess(
  launch: NativeAttachLaunch,
  handlers: NativeAttachProcessHandlers = {}
): NativeAttachProcessRef {
  ensureNodePtySpawnHelperExecutable();
  const child = spawn(launch.command, launch.args, {
    name: "xterm-256color",
    cols: launch.cols ?? process.stdout.columns ?? 120,
    rows: launch.rows ?? process.stdout.rows ?? 30,
    cwd: launch.cwd,
    env: {
      ...process.env,
      ...(launch.env ?? {}),
      TERM: process.env.TERM || "xterm-256color"
    }
  });
  let closed = false;

  child.onData((chunk) => {
    handlers.onOutput?.(chunk);
  });
  child.onExit(({ exitCode }) => {
    closed = true;
    handlers.onClose?.(exitCode);
  });

  return {
    write(input: string): void {
      child.write(input);
    },
    resize(cols: number, rows: number): void {
      if (closed) {
        return;
      }
      child.resize(
        Math.max(1, Math.trunc(cols)),
        Math.max(1, Math.trunc(rows))
      );
    },
    kill(): void {
      if (closed) {
        return;
      }
      child.kill("SIGTERM");
    }
  };
}

function modelEnvironment(modelConfig: WorkerModelRunConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(modelConfig.env ?? {}).map(([name, value]) => [name, renderTemplate(value, "", modelConfig)])
  );
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform === "win32") {
    return;
  }

  const packageRoot = dirname(dirname(require.resolve("node-pty")));
  const helperPath = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (!existsSync(helperPath)) {
    return;
  }

  try {
    accessSync(helperPath, constants.X_OK);
  } catch {
    chmodSync(helperPath, 0o755);
  }
}

async function readWorkerNativeSession(worker: WorkerLogRef): Promise<NativeSession> {
  const workerDir = dirname(worker.statusPath);
  const nativePath = join(workerDir, "native-session.json");
  const record = await readAttachNativeSessionIfValid(nativePath);
  if (!record) {
    const recoveredCodex = await recoverCodexNativeSession(worker, workerDir);
    if (recoveredCodex) {
      await writeJson(nativePath, NativeSessionSchema.parse(recoveredCodex));
      return recoveredCodex;
    }
    const recovered = await recoverClaudeNativeSession(worker, workerDir);
    if (recovered) {
      await writeJson(nativePath, NativeSessionSchema.parse(recovered));
      return recovered;
    }
    throw new Error(`No native session for ${worker.label} · run once before attach`);
  }
  if (record.engine !== worker.engine) {
    throw new Error(`Native session engine mismatch for ${worker.label}: expected ${worker.engine}, got ${record.engine}`);
  }
  if (record.worker_id !== worker.id || record.role !== worker.role) {
    throw new Error(
      `Native session worker mismatch for ${worker.label}: expected ${worker.role}/${worker.id}, got ${record.role}/${record.worker_id}`
    );
  }
  return record;
}

async function readAttachNativeSessionIfValid(nativePath: string): Promise<NativeSession | null> {
  if (!(await pathExists(nativePath))) {
    return null;
  }

  try {
    return await readJson(nativePath, NativeSessionSchema);
  } catch {
    await removeIfExists(nativePath);
    return null;
  }
}

async function recoverCodexNativeSession(worker: WorkerLogRef, workerDir: string): Promise<NativeSession | null> {
  if (worker.engine !== "codex") {
    return null;
  }

  const taskDir = dirname(workerDir);
  const cwd = await readTaskCwdIfValid(join(taskDir, "meta.json"));
  if (!cwd) {
    return null;
  }

  const output = await readTextIfExists(join(workerDir, "output.log"));
  const sessionId = detectResumeSessionId(output);
  if (!sessionId) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    engine: "codex",
    role: worker.role,
    worker_id: worker.id,
    session_id: sessionId,
    scope: "task",
    cwd,
    created_at: now,
    last_used_at: now,
    source: "output-detected"
  };
}

async function recoverClaudeNativeSession(worker: WorkerLogRef, workerDir: string): Promise<NativeSession | null> {
  if (worker.engine !== "claude") {
    return null;
  }

  const prompt = await readTextIfExists(join(workerDir, "prompt.md"));
  if (!prompt.trim()) {
    return null;
  }

  const taskDir = dirname(workerDir);
  const cwd = await readTaskCwdIfValid(join(taskDir, "meta.json"));
  if (!cwd) {
    return null;
  }

  const match = await findClaudeProjectSession({
    cwd,
    prompt
  });
  if (!match) {
    return null;
  }

  return {
    engine: "claude",
    role: worker.role,
    worker_id: worker.id,
    session_id: match.sessionId,
    scope: "task",
    cwd,
    created_at: match.timestamp,
    last_used_at: match.timestamp,
    source: "claude-project-log"
  };
}

async function readTaskCwdIfValid(metaPath: string): Promise<string | null> {
  if (!(await pathExists(metaPath))) {
    return null;
  }

  try {
    return (await readJson(metaPath, TaskMetaSchema)).cwd;
  } catch {
    return null;
  }
}

async function findClaudeProjectSession(input: { cwd: string; prompt: string }): Promise<{ sessionId: string; timestamp: string } | null> {
  const projectDir = join(claudeProjectsDir(), claudeProjectSlug(input.cwd));
  if (!(await pathExists(projectDir))) {
    return null;
  }

  const entries = await readdir(projectDir, { withFileTypes: true });
  const matches: Array<{ sessionId: string; timestamp: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const candidate = await matchClaudeSessionFile(join(projectDir, entry.name), input);
    if (candidate) {
      matches.push(candidate);
    }
  }

  return matches.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1) ?? null;
}

async function matchClaudeSessionFile(
  path: string,
  input: { cwd: string; prompt: string }
): Promise<{ sessionId: string; timestamp: string } | null> {
  const lines = (await readTextIfExists(path)).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.cwd !== input.cwd && record.type !== "queue-operation") {
      continue;
    }
    if (extractClaudePrompt(record) !== input.prompt) {
      continue;
    }
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    if (sessionId && timestamp) {
      return { sessionId, timestamp };
    }
  }
  return null;
}

function extractClaudePrompt(record: Record<string, unknown>): string | null {
  if (typeof record.content === "string") {
    return record.content;
  }

  const message = record.message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

function claudeProjectsDir(): string {
  return process.env.PARALLEL_CODEX_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function renderTemplate(value: string, sessionId: string, modelConfig: WorkerModelRunConfig | undefined): string {
  return value
    .replaceAll("{sessionId}", sessionId)
    .replaceAll("{model}", modelConfig?.name ?? "")
    .replaceAll("{provider}", modelConfig?.provider ?? "")
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

export function supportsNativeAttach(engine: EngineName): boolean {
  return engine === "codex" || engine === "claude" || engine === "mock";
}
