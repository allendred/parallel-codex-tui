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
  const appRoot =
    appRootFlagIndex >= 0 && args[appRootFlagIndex + 1]
      ? resolve(cwd, args[appRootFlagIndex + 1])
      : cwd;
  const explicitWorkspace =
    workspaceFlagIndex >= 0 && args[workspaceFlagIndex + 1] ? args[workspaceFlagIndex + 1] : null;
  const workspaceRoot =
    explicitWorkspace ? resolve(cwd, explicitWorkspace) : cwd;
  const taskId = taskFlagIndex >= 0 && args[taskFlagIndex + 1] ? args[taskFlagIndex + 1] : null;

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
