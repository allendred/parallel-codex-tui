import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { prepareAppRoot } from "./core/app-root.js";
import { configPath, loadConfig } from "./core/config.js";
import { pathExists } from "./core/file-store.js";
import { prepareWorkspace } from "./core/workspace.js";

export interface DoctorResult {
  ok: boolean;
  text: string;
}

type ConfiguredEngine = "router-codex" | "codex" | "claude" | "mock";
type WorkerEngine = "codex" | "claude";

export async function runDoctor(appRoot: string, workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<DoctorResult> {
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
    config = await loadConfig(appRoot);
    lines.push(`config: ok (${localConfigPath})`);
  } catch (error) {
    ok = false;
    lines.push(`config: invalid (${localConfigPath}; ${(error as Error).message})`);
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
