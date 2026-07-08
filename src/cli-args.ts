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

export function parseCliArgs(args: string[], cwd: string): CliArgs {
  const appRootFlagIndex = args.findIndex((arg) => arg === "--app-root");
  const workspaceFlagIndex = args.findIndex((arg) => arg === "--workspace" || arg === "-w");
  const taskFlagIndex = args.findIndex((arg) => arg === "--task" || arg === "-t");
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

function flagValue(args: string[], flagIndex: number): string | null {
  const value = flagIndex >= 0 ? args[flagIndex + 1] : null;
  return value && !value.startsWith("-") ? value : null;
}
