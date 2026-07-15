import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { delimiter, join } from "node:path";
import { prepareAppRoot } from "./core/app-root.js";
import { formatConfigErrorMessage } from "./core/config-errors.js";
import { configPath, loadConfig, withUiThemeOverride } from "./core/config.js";
import { ensureDir, pathExists } from "./core/file-store.js";
import { routerRuntimeDir } from "./core/paths.js";
import { diagnoseRouterFailure } from "./core/router-audit.js";
import { routeRequestWithCodex, routerProxyConfigured, type CodexRouteRunner } from "./core/router.js";
import { prepareWorkspace } from "./core/workspace.js";
import type { RouteDecision } from "./domain/schemas.js";
import { auditTuiThemeContrast, TUI_THEME_MIN_CONTRAST_RATIO, type TuiThemeContrastAudit } from "./tui/theme-contrast.js";
import { formatTuiThemePreview } from "./tui/theme-preview.js";
import { resolveTuiTheme } from "./tui/theme.js";
import {
  diagnoseAgentCapabilities,
  type CapabilityCommandRunner
} from "./workers/capabilities.js";
import { runLiveAgentProbes, type LiveAgentProbeOptions } from "./workers/live-probe.js";

export interface DoctorResult {
  ok: boolean;
  text: string;
}

export interface SystemProxyEndpoint {
  host: string;
  port: number;
}

export interface ProxyDiagnosticResult {
  ok: boolean;
  lines: string[];
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;
type ProxyConnector = (host: string, port: number) => Promise<boolean>;

export interface DoctorOptions {
  probeAgents?: boolean;
  probeRouter?: boolean;
  routeRunner?: CodexRouteRunner;
  theme?: Awaited<ReturnType<typeof loadConfig>>["ui"]["theme"] | null;
  capabilityRunner?: CapabilityCommandRunner;
  capabilityTimeoutMs?: number;
  liveAgentProbeOptions?: LiveAgentProbeOptions;
}

type ConfiguredEngine = "router-codex" | "codex" | "claude" | "mock";
type WorkerEngine = "codex" | "claude";

export async function runDoctor(
  appRoot: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DoctorOptions = {}
): Promise<DoctorResult> {
  const lines = ["parallel-codex-tui doctor"];
  let ok = true;
  await prepareAppRoot(appRoot);
  const preparedWorkspace = await prepareWorkspace(appRoot, workspaceRoot);

  if (isSupportedNodeVersion(process.versions.node)) {
    lines.push(`Node.js: ok (${process.versions.node})`);
  } else {
    ok = false;
    lines.push(`Node.js: unsupported (${process.versions.node}; need 24.15+)`);
  }

  lines.push(`workspace: ok (${preparedWorkspace})`);

  const localConfigPath = configPath(appRoot);
  if (!(await pathExists(localConfigPath))) {
    ok = false;
    lines.push(`config: missing (${localConfigPath}; run parallel-codex-tui --init)`);
    return {
      ok,
      text: `${lines.join("\n")}\n`
    };
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    const loadedConfig = await loadConfig(appRoot);
    config = withUiThemeOverride(loadedConfig, options.theme ?? null);
    lines.push(`config: ok (${localConfigPath})`);
    lines.push(`theme: ok (${themeSummary(config.ui.theme, loadedConfig.ui.theme, options.theme ?? null)}; ${themeOverrideSummary(config.ui.colors)})`);
    const theme = resolveTuiTheme({ theme: config.ui.theme, colors: config.ui.colors });
    lines.push(`palette: ${themePaletteSummary(theme)}`);
    lines.push(...formatTuiThemePreview(theme));
    lines.push(...formatThemeContrastAudit(auditTuiThemeContrast(theme)));
  } catch (error) {
    ok = false;
    lines.push(`config: invalid (${localConfigPath})`);
    lines.push(...formatConfigErrorMessage(error).split("\n").map((line) => `config error: ${line}`));
    return {
      ok,
      text: `${lines.join("\n")}\n`
    };
  }

  const includeRouter = config.router.defaultMode === "auto" || options.probeRouter === true;
  if (includeRouter) {
    lines.push(
      `router retry: ${config.router.codex.maxAttempts} attempts; transient only; ${config.router.codex.retryDelayMs}ms backoff (TUI routing; live probe runs once)`
    );
    lines.push(
      `router budget: total ${config.router.codex.timeoutMs}ms; follow-up ${config.router.codex.followUpTimeoutMs}ms; first output ${config.router.codex.firstOutputTimeoutMs}ms; idle ${config.router.codex.idleTimeoutMs}ms`
    );
  }
  const availableCommands = new Set<string>();
  for (const command of configuredCommands(config, includeRouter)) {
    if (await commandExists(command, env)) {
      availableCommands.add(command);
      lines.push(`${command}: ok`);
    } else {
      ok = false;
      lines.push(`${command}: missing`);
    }
  }

  for (const check of configuredEnvironmentChecks(config, env, includeRouter)) {
    if (check.ok) {
      lines.push(`${check.label}: ok`);
    } else {
      ok = false;
      lines.push(`${check.label}: missing env ${check.envName}`);
    }
  }

  const capabilityDiagnostics = await diagnoseAgentCapabilities(config, env, {
    includeRouter,
    workerEngines: configuredWorkerEngines(config),
    availableCommands,
    ...(options.capabilityRunner ? { runner: options.capabilityRunner } : {}),
    ...(options.capabilityTimeoutMs ? { timeoutMs: options.capabilityTimeoutMs } : {})
  });
  lines.push(...capabilityDiagnostics.lines);
  ok = ok && capabilityDiagnostics.ok;

  const proxyDiagnostics = await diagnoseProxyEnvironment(
    config,
    env,
    await detectMacSystemProxy(),
    canConnectProxy,
    { includeRouter }
  );
  lines.push(...proxyDiagnostics.lines);
  ok = ok && proxyDiagnostics.ok;

  if (options.probeAgents) {
    if (ok) {
      const liveAgents = await runLiveAgentProbes(
        config,
        preparedWorkspace,
        configuredWorkerEngines(config),
        options.liveAgentProbeOptions
      );
      lines.push(...liveAgents.lines);
      ok = ok && liveAgents.ok;
    } else {
      lines.push("agent live probe: skipped (preflight failed)");
    }
  } else {
    lines.push("agent live probe: not run (add --probe-agents; may use model quota)");
  }

  if (options.probeRouter) {
    const probe = await runRouterProbe(config, appRoot, options.routeRunner);
    lines.push(probe.line);
    ok = ok && probe.ok;
  } else if (config.router.defaultMode === "auto") {
    lines.push("router live probe: not run (add --probe-router)");
  }

  return {
    ok,
    text: `${lines.join("\n")}\n`
  };
}

export async function diagnoseProxyEnvironment(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  systemProxy: SystemProxyEndpoint | null,
  connect: ProxyConnector = canConnectProxy,
  options: { includeRouter?: boolean } = {}
): Promise<ProxyDiagnosticResult> {
  const contexts: Array<{ label: string; env: Record<string, string>; table: string }> = [];
  if (options.includeRouter ?? config.router.defaultMode === "auto") {
    contexts.push({ label: "router proxy", env: config.router.codex.env, table: "router.codex.env" });
  }
  if (configuredWorkerEngines(config).includes("codex")) {
    contexts.push({
      label: "workers.codex proxy",
      env: config.workers.codex.model.env,
      table: "workers.codex.model.env"
    });
  }

  const connectionCache = new Map<string, Promise<boolean>>();
  const lines: string[] = [];
  let ok = true;
  for (const context of contexts) {
    const endpoint = configuredProxyEndpoint(context.env, env);
    if (!endpoint) {
      if (systemProxy) {
        lines.push(
          `${context.label}: warning (macOS system proxy ${formatProxyEndpoint(systemProxy)} is not inherited; configure [${context.table}])`
        );
      } else {
        lines.push(`${context.label}: direct (no proxy configured)`);
      }
      continue;
    }
    if (endpoint === "invalid") {
      ok = false;
      lines.push(`${context.label}: invalid proxy URL`);
      continue;
    }

    const key = formatProxyEndpoint(endpoint);
    const reachable = await cachedProxyConnection(connectionCache, key, () => connect(endpoint.host, endpoint.port));
    if (reachable) {
      lines.push(`${context.label}: reachable (${key}; local endpoint only)`);
    } else {
      ok = false;
      lines.push(`${context.label}: unreachable (${key})`);
    }
  }

  return { ok, lines };
}

async function runRouterProbe(
  config: LoadedConfig,
  appRoot: string,
  runner?: CodexRouteRunner
): Promise<{ ok: boolean; line: string }> {
  const cwd = routerRuntimeDir(appRoot, config.dataDir);
  await ensureDir(cwd);
  const probeConfig: LoadedConfig = {
    ...config,
    router: {
      ...config.router,
      defaultMode: "auto"
    }
  };

  try {
    const route = await routeRequestWithCodex("hello", probeConfig, runner, cwd);
    if (route.source === "codex") {
      const trace = formatRouterProbeTrace(route, false);
      return {
        ok: true,
        line: `router live probe: ok (${route.mode} in ${Math.round(route.duration_ms ?? 0)}ms${trace ? `; ${trace}` : ""})`
      };
    }
    const trace = formatRouterProbeTrace(route, true);
    const diagnosis = diagnoseRouterFailure({
      ...route,
      reason: route.reason,
      proxy_configured: routerProxyConfigured(config.router.codex.env)
    });
    return {
      ok: false,
      line: `router live probe: failed (${sanitizeDiagnosticText(route.reason)}${trace ? `; ${trace}` : ""}; diagnosis ${diagnosis.summary}; next ${diagnosis.action})`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      line: `router live probe: failed (${sanitizeDiagnosticText(message)})`
    };
  }
}

function formatRouterProbeTrace(route: RouteDecision, includeStage: boolean): string {
  return [
    ...(includeStage && route.router_failure_stage ? [`stage ${route.router_failure_stage}`] : []),
    ...(includeStage && route.router_timeout_kind ? [`timeout ${route.router_timeout_kind}`] : []),
    ...(typeof route.router_dispatch_ms === "number" ? [`dispatch ${Math.round(route.router_dispatch_ms)}ms`] : []),
    ...(typeof route.router_spawn_ms === "number" ? [`spawn ${Math.round(route.router_spawn_ms)}ms`] : []),
    ...formatRouterProbeFirstOutput(route),
    ...(typeof route.router_process_ms === "number" ? [`process ${Math.round(route.router_process_ms)}ms`] : []),
    ...(typeof route.router_parse_ms === "number" ? [`parse ${Math.round(route.router_parse_ms)}ms`] : []),
    ...(typeof route.duration_ms === "number" ? [`total ${Math.round(route.duration_ms)}ms`] : []),
    ...(typeof route.router_stdout_bytes === "number" ? [`stdout ${formatRouterProbeBytes(route.router_stdout_bytes)}`] : []),
    ...(typeof route.router_stderr_bytes === "number" ? [`stderr ${formatRouterProbeBytes(route.router_stderr_bytes)}`] : [])
  ].join("; ");
}

function formatRouterProbeFirstOutput(route: RouteDecision): string[] {
  const streams = [
    ...(typeof route.router_first_stdout_ms === "number"
      ? [{ at: route.router_first_stdout_ms, text: `first stdout ${Math.round(route.router_first_stdout_ms)}ms` }]
      : []),
    ...(typeof route.router_first_stderr_ms === "number"
      ? [{ at: route.router_first_stderr_ms, text: `first stderr ${Math.round(route.router_first_stderr_ms)}ms` }]
      : [])
  ];
  if (streams.length > 0) {
    return streams.sort((left, right) => left.at - right.at).map((stream) => stream.text);
  }
  if (typeof route.router_first_output_ms === "number") {
    return [`first output ${Math.round(route.router_first_output_ms)}ms`];
  }
  return route.router_failure_stage === "waiting-output" ? ["first output none"] : [];
}

function formatRouterProbeBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`;
  }
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@")
    .replace(/\b(api[-_\s]?key|token|authorization)(\s*[:=]\s*)(\S+)/gi, "$1$2***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400) || "unknown error";
}

export function isSupportedNodeVersion(version: string): boolean {
  const [majorRaw = "0", minorRaw = "0"] = version.split(".");
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);

  return major > 24 || (major === 24 && minor >= 15);
}

function configuredCommands(config: Awaited<ReturnType<typeof loadConfig>>, includeRouter: boolean): string[] {
  const commands = includeRouter ? [config.router.codex.command] : [];
  for (const engine of configuredWorkerEngines(config)) {
    const worker = config.workers[engine];
    commands.push(worker.command);
    if (worker.nativeSession.enabled) {
      commands.push(worker.interactive.command);
    }
  }
  return [...new Set(commands.filter((command) => command && command !== "mock"))];
}

function themeOverrideSummary(colors: Awaited<ReturnType<typeof loadConfig>>["ui"]["colors"]): string {
  const entries = Object.entries(colors).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "no color overrides";
  }

  return `colors: ${entries.map(([key, value]) => `${key}=${value}`).join(", ")}`;
}

function themePaletteSummary(theme: ReturnType<typeof resolveTuiTheme>): string {
  return [
    `chrome=${theme.chrome}`,
    `surface=${theme.surface}`,
    `rail=${theme.rail}`,
    `accent=${theme.accent}`
  ].join(", ");
}

function formatThemeContrastAudit(audit: TuiThemeContrastAudit): string[] {
  if (audit.issues.length === 0) {
    return [`theme contrast: ok (minimum ${formatContrastRatio(audit.minimumRatio)}:1 across ${audit.measurements.length} rendered pairs)`];
  }

  return [
    `theme contrast: warning (${audit.issues.length} of ${audit.measurements.length} rendered pairs below ${TUI_THEME_MIN_CONTRAST_RATIO}:1)`,
    ...audit.issues.map(({ foreground, background, ratio }) =>
      `theme contrast issue: ${foreground}/${background} ${formatContrastRatio(ratio)}:1`
    )
  ];
}

function formatContrastRatio(ratio: number): string {
  return ratio.toFixed(2);
}

function themeSummary(
  effectiveTheme: Awaited<ReturnType<typeof loadConfig>>["ui"]["theme"],
  configTheme: Awaited<ReturnType<typeof loadConfig>>["ui"]["theme"],
  cliTheme: Awaited<ReturnType<typeof loadConfig>>["ui"]["theme"] | null
): string {
  if (cliTheme && cliTheme !== configTheme) {
    return `${effectiveTheme} via --theme; config ${configTheme}`;
  }

  return effectiveTheme;
}

function configuredEngines(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: { includeRouter: boolean }
): ConfiguredEngine[] {
  const engines = new Set<ConfiguredEngine>();

  if (options.includeRouter) {
    engines.add("router-codex");
  }

  if (config.router.defaultMode === "auto") {
    engines.add(config.pairing.main);
    engines.add(config.pairing.judge);
    engines.add(config.pairing.actor);
    engines.add(config.pairing.critic);
  } else if (config.router.defaultMode === "simple") {
    engines.add(config.pairing.main);
  } else {
    engines.add(config.pairing.judge);
    engines.add(config.pairing.actor);
    engines.add(config.pairing.critic);
  }

  return Array.from(engines);
}

function configuredWorkerEngines(config: Awaited<ReturnType<typeof loadConfig>>): WorkerEngine[] {
  return configuredEngines(config, { includeRouter: false }).filter(
    (engine): engine is WorkerEngine => engine === "codex" || engine === "claude"
  );
}

function configuredEnvironmentChecks(
  config: Awaited<ReturnType<typeof loadConfig>>,
  env: NodeJS.ProcessEnv,
  includeRouter: boolean
): Array<{ label: string; envName: string; ok: boolean }> {
  const checks: Array<{ label: string; envName: string; ok: boolean }> = [];

  if (includeRouter) {
    for (const [key, value] of Object.entries(config.router.codex.env)) {
      for (const envName of referencedEnvNames(value)) {
        checks.push({
          label: `router.codex.env.${key}`,
          envName,
          ok: Boolean(env[envName])
        });
      }
    }
  }

  for (const engine of configuredWorkerEngines(config)) {
    const worker = engine === "codex" ? config.workers.codex : config.workers.claude;
    for (const [key, value] of Object.entries(worker.model.env)) {
      for (const envName of referencedEnvNames(value)) {
        checks.push({
          label: `workers.${engine}.model.env.${key}`,
          envName,
          ok: Boolean(env[envName])
        });
      }
    }
  }

  return checks;
}

function referencedEnvNames(value: string): string[] {
  return Array.from(value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g), (match) => match[1] ?? "");
}

async function commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (command.includes("/")) {
    return canExecute(command);
  }

  const pathValue = env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (await canExecute(join(dir, `${command}${extension}`))) {
        return true;
      }
    }
  }

  return false;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredProxyEndpoint(
  configured: Record<string, string>,
  processEnvironment: NodeJS.ProcessEnv
): SystemProxyEndpoint | "invalid" | null {
  const effective: Record<string, string | undefined> = {
    ...processEnvironment,
    ...Object.fromEntries(
      Object.entries(configured).map(([name, value]) => [name, renderEnvironmentValue(value, processEnvironment)])
    )
  };
  const value = [
    effective.HTTPS_PROXY,
    effective.https_proxy,
    effective.ALL_PROXY,
    effective.all_proxy,
    effective.HTTP_PROXY,
    effective.http_proxy
  ].find((candidate) => candidate?.trim())?.trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    const port = url.port ? Number(url.port) : defaultProxyPort(url.protocol);
    if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return "invalid";
    }
    return { host: url.hostname, port };
  } catch {
    return "invalid";
  }
}

function renderEnvironmentValue(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

function defaultProxyPort(protocol: string): number {
  if (protocol === "https:") {
    return 443;
  }
  if (protocol.startsWith("socks")) {
    return 1080;
  }
  return 80;
}

function formatProxyEndpoint(endpoint: SystemProxyEndpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}

async function cachedProxyConnection(
  cache: Map<string, Promise<boolean>>,
  key: string,
  connect: () => Promise<boolean>
): Promise<boolean> {
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const pending = connect();
  cache.set(key, pending);
  return pending;
}

async function detectMacSystemProxy(): Promise<SystemProxyEndpoint | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const output = await execFileText("scutil", ["--proxy"]);
  if (!output) {
    return null;
  }
  const https = parseScutilProxy(output, "HTTPS");
  return https ?? parseScutilProxy(output, "HTTP");
}

function parseScutilProxy(output: string, prefix: "HTTP" | "HTTPS"): SystemProxyEndpoint | null {
  const enabled = output.match(new RegExp(`${prefix}Enable\\s*:\\s*(\\d+)`))?.[1] === "1";
  const host = output.match(new RegExp(`${prefix}Proxy\\s*:\\s*(\\S+)`))?.[1];
  const port = Number(output.match(new RegExp(`${prefix}Port\\s*:\\s*(\\d+)`))?.[1]);
  return enabled && host && Number.isInteger(port) && port > 0 ? { host, port } : null;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 1000 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

function canConnectProxy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
