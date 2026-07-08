import { resolve } from "node:path";

export interface CliArgs {
  appRoot: string;
  doctor: boolean;
  explicitWorkspace: string | null;
  help: boolean;
  init: boolean;
  workspaceRoot: string;
  taskId: string | null;
  version: boolean;
}

const allowedValueOptions = new Set(["--app-root", "--workspace", "-w", "--task", "-t"]);
const allowedBooleanOptions = new Set(["--doctor", "--help", "-h", "--init", "--version", "-v"]);

export function parseCliArgs(args: string[], cwd: string): CliArgs {
  const appRootFlagIndex = lastFlagIndex(args, (arg) => arg === "--app-root" || arg.startsWith("--app-root="));
  const workspaceFlagIndex = lastFlagIndex(
    args,
    (arg) => arg === "--workspace" || arg.startsWith("--workspace=") || arg === "-w" || arg.startsWith("-w=")
  );
  const taskFlagIndex = lastFlagIndex(args, (arg) => arg === "--task" || arg.startsWith("--task=") || arg === "-t" || arg.startsWith("-t="));
  const doctor = args.includes("--doctor");
  const help = args.includes("--help") || args.includes("-h");
  const init = args.includes("--init");
  const version = args.includes("--version") || args.includes("-v");
  const appRootValue = flagValue(args, appRootFlagIndex);
  const appRoot = appRootValue ? resolve(cwd, appRootValue) : cwd;
  const explicitWorkspace = flagValue(args, workspaceFlagIndex);
  const workspaceRoot = explicitWorkspace ? resolve(cwd, explicitWorkspace) : cwd;
  const taskId = flagValue(args, taskFlagIndex);

  return {
    appRoot,
    doctor,
    explicitWorkspace,
    help,
    init,
    workspaceRoot,
    taskId,
    version
  };
}

export function validateCliArgs(args: string[]): string[] {
  const errors: string[] = [];
  for (const arg of args) {
    if (arg === "--") {
      break;
    }

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
  return errors;
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
