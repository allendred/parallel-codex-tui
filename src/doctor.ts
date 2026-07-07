import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { configPath, loadConfig } from "./core/config.js";
import { pathExists } from "./core/file-store.js";

export interface DoctorResult {
  ok: boolean;
  text: string;
}

export async function runDoctor(appRoot: string, workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<DoctorResult> {
  const lines = ["parallel-codex-tui doctor"];
  let ok = true;

  if (isSupportedNodeVersion(process.versions.node)) {
    lines.push(`Node.js: ok (${process.versions.node})`);
  } else {
    ok = false;
    lines.push(`Node.js: unsupported (${process.versions.node}; need 22.5+)`);
  }

  if (await pathExists(workspaceRoot)) {
    lines.push(`workspace: ok (${workspaceRoot})`);
  } else {
    ok = false;
    lines.push(`workspace: missing (${workspaceRoot})`);
  }

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

  return {
    ok,
    text: `${lines.join("\n")}\n`
  };
}

function isSupportedNodeVersion(version: string): boolean {
  const [majorRaw = "0", minorRaw = "0"] = version.split(".");
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);

  return major > 22 || (major === 22 && minor >= 5);
}

function configuredCommands(config: Awaited<ReturnType<typeof loadConfig>>): string[] {
  const engines = new Set<string>();

  if (config.router.defaultMode === "auto") {
    engines.add("router-codex");
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

  return Array.from(
    new Set(
      Array.from(engines)
        .map((engine) => commandForEngine(config, engine))
        .filter((command): command is string => Boolean(command) && command !== "mock")
    )
  );
}

function commandForEngine(config: Awaited<ReturnType<typeof loadConfig>>, engine: string): string | null {
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
