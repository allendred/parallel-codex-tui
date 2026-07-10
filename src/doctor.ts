import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { prepareAppRoot } from "./core/app-root.js";
import { formatConfigErrorMessage } from "./core/config-errors.js";
import { configPath, loadConfig, withUiThemeOverride } from "./core/config.js";
import { pathExists } from "./core/file-store.js";
import { prepareWorkspace } from "./core/workspace.js";
import { auditTuiThemeContrast, TUI_THEME_MIN_CONTRAST_RATIO, type TuiThemeContrastAudit } from "./tui/theme-contrast.js";
import { formatTuiThemePreview } from "./tui/theme-preview.js";
import { resolveTuiTheme } from "./tui/theme.js";

export interface DoctorResult {
  ok: boolean;
  text: string;
}

type ConfiguredEngine = "router-codex" | "codex" | "claude" | "mock";
type WorkerEngine = "codex" | "claude";

export async function runDoctor(
  appRoot: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { theme?: Awaited<ReturnType<typeof loadConfig>>["ui"]["theme"] | null } = {}
): Promise<DoctorResult> {
  const lines = ["parallel-codex-tui doctor"];
  let ok = true;
  await prepareAppRoot(appRoot);
  const preparedWorkspace = await prepareWorkspace(appRoot, workspaceRoot);

  if (isSupportedNodeVersion(process.versions.node)) {
    lines.push(`Node.js: ok (${process.versions.node})`);
  } else {
    ok = false;
    lines.push(`Node.js: unsupported (${process.versions.node}; need 26+)`);
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

  for (const command of configuredCommands(config)) {
    if (await commandExists(command, env)) {
      lines.push(`${command}: ok`);
    } else {
      ok = false;
      lines.push(`${command}: missing`);
    }
  }

  for (const check of configuredWorkerModelEnvChecks(config, env)) {
    if (check.ok) {
      lines.push(`${check.label}: ok`);
    } else {
      ok = false;
      lines.push(`${check.label}: missing env ${check.envName}`);
    }
  }

  return {
    ok,
    text: `${lines.join("\n")}\n`
  };
}

export function isSupportedNodeVersion(version: string): boolean {
  const [majorRaw = "0", minorRaw = "0"] = version.split(".");
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);

  return major >= 26;
}

function configuredCommands(config: Awaited<ReturnType<typeof loadConfig>>): string[] {
  return Array.from(
    new Set(
      configuredEngines(config, { includeRouter: true })
        .map((engine) => commandForEngine(config, engine))
        .filter((command): command is string => Boolean(command) && command !== "mock")
    )
  );
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

function commandForEngine(config: Awaited<ReturnType<typeof loadConfig>>, engine: ConfiguredEngine): string | null {
  if (engine === "router-codex") {
    return config.router.codex.command;
  }

  if (engine === "codex") {
    return config.workers.codex.command;
  }

  if (engine === "claude") {
    return config.workers.claude.command;
  }

  return null;
}

function configuredEngines(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: { includeRouter: boolean }
): ConfiguredEngine[] {
  const engines = new Set<ConfiguredEngine>();

  if (config.router.defaultMode === "auto" && options.includeRouter) {
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

function configuredWorkerModelEnvChecks(
  config: Awaited<ReturnType<typeof loadConfig>>,
  env: NodeJS.ProcessEnv
): Array<{ label: string; envName: string; ok: boolean }> {
  const checks: Array<{ label: string; envName: string; ok: boolean }> = [];

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
