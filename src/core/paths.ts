import { join } from "node:path";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTaskTimestamp(date: Date): string {
  return (
    [
      date.getUTCFullYear(),
      pad(date.getUTCMonth() + 1),
      pad(date.getUTCDate())
    ].join("") + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export function sessionsRoot(projectRoot: string, dataDir: string): string {
  return join(projectRoot, dataDir, "sessions");
}

export function routerRuntimeDir(appRoot: string, dataDir: string): string {
  return join(appRoot, dataDir, "router");
}

export function taskDir(projectRoot: string, dataDir: string, taskId: string): string {
  return join(sessionsRoot(projectRoot, dataDir), taskId);
}
