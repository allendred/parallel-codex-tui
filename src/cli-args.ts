import { resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeTuiThemeName, TUI_THEME_NAMES, type TuiThemeName } from "./tui/theme.js";

export interface CliArgs {
  appRoot: string;
  doctor: boolean;
  explicitWorkspace: string | null;
  help: boolean;
  init: boolean;
  probeRouter: boolean;
  workspaceRoot: string;
  taskId: string | null;
  theme: TuiThemeName | null;
  themes: boolean;
  version: boolean;
}

const allowedValueOptions = new Set(["--app-root", "--workspace", "-w", "--task", "-t", "--theme"]);
const allowedBooleanOptions = new Set(["--doctor", "--help", "-h", "--init", "--probe-router", "--themes", "--version", "-v"]);

export function parseCliArgs(args: string[], cwd: string): CliArgs {
  const optionArgs = argsBeforeTerminator(args);
  const appRootFlagIndex = lastFlagIndex(optionArgs, (arg) => arg === "--app-root" || arg.startsWith("--app-root="));
  const workspaceFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--workspace" || arg.startsWith("--workspace=") || arg === "-w" || arg.startsWith("-w=")
  );
  const taskFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--task" || arg.startsWith("--task=") || arg === "-t" || arg.startsWith("-t=")
  );
  const themeFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--theme" || arg.startsWith("--theme=")
  );
  const doctor = optionArgs.includes("--doctor");
  const help = optionArgs.includes("--help") || optionArgs.includes("-h");
  const init = optionArgs.includes("--init");
  const probeRouter = optionArgs.includes("--probe-router");
  const themes = optionArgs.includes("--themes");
  const version = optionArgs.includes("--version") || optionArgs.includes("-v");
  const appRootValue = flagValue(optionArgs, appRootFlagIndex);
  const appRoot = appRootValue ? resolvePathArg(cwd, appRootValue) : cwd;
  const explicitWorkspace = flagValue(optionArgs, workspaceFlagIndex);
  const workspaceRoot = explicitWorkspace ? resolvePathArg(cwd, explicitWorkspace) : cwd;
  const taskId = flagValue(optionArgs, taskFlagIndex);
  const theme = cliThemeValue(flagValue(optionArgs, themeFlagIndex));

  return {
    appRoot,
    doctor,
    explicitWorkspace,
    help,
    init,
    probeRouter,
    workspaceRoot,
    taskId,
    theme,
    themes,
    version
  };
}

function resolvePathArg(cwd: string, value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  return resolve(cwd, value);
}

export function validateCliArgs(args: string[]): string[] {
  const errors: string[] = [];
  const optionArgs = argsBeforeTerminator(args);
  for (const arg of optionArgs) {
    if (!arg.startsWith("-") || arg === "-") {
      continue;
    }

    if (allowedBooleanOptions.has(arg) || allowedValueOptions.has(arg)) {
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const optionName = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (allowedValueOptions.has(optionName)) {
      continue;
    }

    errors.push(`Unknown option: ${arg}`);
  }

  const themeFlagIndex = lastFlagIndex(optionArgs, (arg) => arg === "--theme" || arg.startsWith("--theme="));
  const rawThemeValue = flagValue(optionArgs, themeFlagIndex);
  if (rawThemeValue?.trim() && !normalizeTuiThemeName(rawThemeValue)) {
    errors.push(`Invalid --theme: ${rawThemeValue.trim()} (expected ${TUI_THEME_NAMES.join(", ")})`);
  }
  if (optionArgs.includes("--probe-router") && !optionArgs.includes("--doctor")) {
    errors.push("--probe-router requires --doctor");
  }
  return errors;
}

function argsBeforeTerminator(args: string[]): string[] {
  const terminatorIndex = args.indexOf("--");
  return terminatorIndex >= 0 ? args.slice(0, terminatorIndex) : args;
}

function lastFlagIndex(args: string[], predicate: (arg: string) => boolean): number {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (predicate(args[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function flagValue(args: string[], flagIndex: number): string | null {
  const flag = flagIndex >= 0 ? args[flagIndex] : null;
  const inlineMatch = flag?.match(/^-{1,2}[^=]+=(.*)$/);
  if (inlineMatch) {
    return inlineMatch[1] || null;
  }

  const value = flagIndex >= 0 ? args[flagIndex + 1] : null;
  return value && !value.startsWith("-") ? value : null;
}

function cliThemeValue(value: string | null): TuiThemeName | null {
  return normalizeTuiThemeName(value);
}
