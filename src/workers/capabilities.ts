import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { AppConfig } from "../core/config.js";
import type { EngineName } from "../domain/schemas.js";
import { workerProvider } from "./provider.js";
import type { WorkerCapabilityRunConfig } from "./types.js";

export type DiagnosedWorkerEngine = EngineName;

export interface CapabilityCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CapabilityCommandRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
) => Promise<CapabilityCommandResult>;

export interface AgentCapabilityDiagnostics {
  ok: boolean;
  lines: string[];
}

export interface AgentCapabilityOptions {
  includeRouter: boolean;
  workerEngines: DiagnosedWorkerEngine[];
  availableCommands?: ReadonlySet<string>;
  runner?: CapabilityCommandRunner;
  timeoutMs?: number;
}

type CapabilitySurface = "automated" | "resume" | "native";

interface CapabilityTarget {
  command: string;
  engine: DiagnosedWorkerEngine;
  capabilities: WorkerCapabilityRunConfig;
  surfaces: Set<CapabilitySurface>;
}

interface CapabilityProbeSpec {
  args: string[];
  label: string;
  requiredOptions: string[];
  usagePattern: RegExp;
}

export async function diagnoseAgentCapabilities(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  options: AgentCapabilityOptions
): Promise<AgentCapabilityDiagnostics> {
  const targets = capabilityTargets(config, options);
  const runner = options.runner ?? runCapabilityCommand;
  const timeoutMs = options.timeoutMs ?? 3000;
  const reports = await Promise.all(targets.map(async (target) => {
    if (options.availableCommands && !options.availableCommands.has(target.command)) {
      return null;
    }
    return diagnoseCapabilityTarget(target, config, env, runner, timeoutMs);
  }));
  const lines = reports.flatMap((report) => report?.lines ?? []);
  const ok = reports.every((report) => report?.ok !== false);

  if (targets.some((target) => target.surfaces.has("native"))) {
    lines.push("native workspace trust: interactive (confirm only workspaces you trust when prompted)");
  }

  return { ok, lines };
}

function capabilityTargets(config: AppConfig, options: AgentCapabilityOptions): CapabilityTarget[] {
  const targets = new Map<string, CapabilityTarget>();
  const addTarget = (
    engine: DiagnosedWorkerEngine,
    command: string,
    capabilities: WorkerCapabilityRunConfig,
    surface: CapabilitySurface
  ) => {
    const key = `${engine}\0${command}\0${capabilities.profile}`;
    const current = targets.get(key) ?? { engine, command, capabilities, surfaces: new Set<CapabilitySurface>() };
    current.surfaces.add(surface);
    targets.set(key, current);
  };

  if (options.includeRouter) {
    addTarget("codex", config.router.codex.command, {
      profile: "codex",
      writableDirArgs: [],
      freshSessionArgs: []
    }, "automated");
  }
  for (const engine of [...new Set(options.workerEngines)]) {
    const worker = workerProvider(config, engine).config;
    addTarget(engine, worker.command, worker.capabilities, "automated");
    if (worker.nativeSession.enabled) {
      addTarget(engine, worker.command, worker.capabilities, "resume");
      addTarget(engine, worker.interactive.command, worker.capabilities, "native");
    }
  }

  return [...targets.values()];
}

async function diagnoseCapabilityTarget(
  target: CapabilityTarget,
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  runner: CapabilityCommandRunner,
  timeoutMs: number
): Promise<AgentCapabilityDiagnostics> {
  const configuredIssues = configuredCapabilityIssues(target, config);
  if (configuredIssues.length > 0) {
    return {
      ok: false,
      lines: [`${capabilityTargetLabel(target)}: incompatible (${configuredIssues.join("; ")})`]
    };
  }
  if (target.capabilities.profile === "generic") {
    return {
      ok: true,
      lines: [`${capabilityTargetLabel(target)}: declared (${genericCapabilitySummary(target)})`]
    };
  }

  const specs = capabilityProbeSpecs(target);
  const results = await Promise.all(specs.map(async (spec) => ({
    spec,
    result: await runner(target.command, spec.args, env, timeoutMs)
  })));
  const incompatible: string[] = [];
  const unverified: string[] = [];

  for (const { spec, result } of results) {
    const output = stripTerminalControl(`${result.stdout}\n${result.stderr}`);
    if (result.timedOut) {
      unverified.push(`${spec.label} help timed out`);
      continue;
    }
    if (result.exitCode !== 0 || !spec.usagePattern.test(output)) {
      unverified.push(`${spec.label} help not recognized`);
      continue;
    }
    const missing = spec.requiredOptions.filter((option) => !output.includes(option));
    if (missing.length > 0) {
      incompatible.push(`${spec.label} missing ${missing.join(", ")}`);
    }
  }

  if (target.capabilities.profile === "codex" && target.surfaces.has("native")) {
    const sandbox = configuredCodexSandbox(workerProvider(config, target.engine).config.interactive.args);
    if (sandbox === "read-only") {
      incompatible.push("native resume uses read-only but feature attach requires writable --add-dir roots");
    }
  }

  const label = capabilityTargetLabel(target);
  if (incompatible.length > 0) {
    return {
      ok: false,
      lines: [`${label}: incompatible (${incompatible.join("; ")})`]
    };
  }
  if (unverified.length > 0) {
    return {
      ok: true,
      lines: [`${label}: warning (${unverified.join("; ")}; compatibility unverified)`]
    };
  }
  return {
    ok: true,
    lines: [`${label}: ok (${specs.map((spec) => spec.label).join(", ")})`]
  };
}

function capabilityProbeSpecs(target: CapabilityTarget): CapabilityProbeSpec[] {
  if (target.capabilities.profile === "claude") {
    return [{
      args: ["--help"],
      label: "print/resume/permissions/add-dir",
      requiredOptions: ["--print", "--resume", "--permission-mode", "--add-dir"],
      usagePattern: /Usage:\s+claude\b/i
    }];
  }

  const specs: CapabilityProbeSpec[] = [];
  if (target.surfaces.has("automated")) {
    specs.push({
      args: ["--help"],
      label: "approval policy",
      requiredOptions: ["--ask-for-approval"],
      usagePattern: /Usage:\s+codex\b/i
    });
    specs.push({
      args: ["exec", "--help"],
      label: "exec sandbox/add-dir",
      requiredOptions: ["--sandbox", "--add-dir", "--skip-git-repo-check"],
      usagePattern: /Usage:\s+codex exec\b/i
    });
  }
  if (target.surfaces.has("resume")) {
    specs.push({
      args: ["exec", "resume", "--help"],
      label: "exec resume",
      requiredOptions: ["--skip-git-repo-check"],
      usagePattern: /Usage:\s+codex exec resume\b/i
    });
  }
  if (target.surfaces.has("native")) {
    specs.push({
      args: ["resume", "--help"],
      label: "native resume sandbox/add-dir",
      requiredOptions: ["--sandbox", "--add-dir"],
      usagePattern: /Usage:\s+codex resume\b/i
    });
  }
  return specs;
}

function configuredCapabilityIssues(target: CapabilityTarget, config: AppConfig): string[] {
  const worker = workerProvider(config, target.engine).config;
  const issues: string[] = [];
  if (
    target.surfaces.has("resume")
    && worker.nativeSession.enabled
    && !worker.nativeSession.resumeArgs.some((arg) => arg.includes("{sessionId}"))
  ) {
    issues.push("nativeSession.resumeArgs missing {sessionId}");
  }
  if (
    target.surfaces.has("native")
    && worker.nativeSession.enabled
    && !worker.interactive.args.some((arg) => arg.includes("{sessionId}"))
  ) {
    issues.push("interactive.args missing {sessionId}");
  }
  return issues;
}

function genericCapabilitySummary(target: CapabilityTarget): string {
  const writableDirs = target.capabilities.writableDirArgs.length > 0
    ? "writable dirs via template"
    : "process-managed writes";
  const freshSession = target.capabilities.freshSessionArgs.length > 0
    ? "client-assigned fresh session"
    : "output-detected fresh session";
  const nativeResume = target.surfaces.has("native") || target.surfaces.has("resume")
    ? "native resume configured"
    : "fresh runs";
  return `generic CLI, ${writableDirs}, ${freshSession}, ${nativeResume}`;
}

function configuredCodexSandbox(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--sandbox" || arg === "-s") {
      return args[index + 1]?.trim().toLowerCase() || null;
    }
    const match = arg.match(/^(?:--sandbox|-s)=(.+)$/);
    if (match) {
      return match[1]?.trim().toLowerCase() || null;
    }
    if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      return "danger-full-access";
    }
  }
  return null;
}

function capabilityTargetLabel(target: CapabilityTarget): string {
  const executable = basename(target.command);
  return executable === target.engine
    ? `${target.engine} capabilities`
    : `${target.engine} capabilities (${executable})`;
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

function runCapabilityCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CapabilityCommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024
    }, (error, stdout, stderr) => {
      const processError = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean } | null;
      resolve({
        exitCode: typeof processError?.code === "number" ? processError.code : processError ? null : 0,
        stdout,
        stderr,
        timedOut: Boolean(processError?.killed)
      });
    });
  });
}
