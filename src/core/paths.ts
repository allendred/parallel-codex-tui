import { join } from "node:path";
import { TaskSessionIdSchema } from "../domain/schemas.js";

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
  if (!taskSessionIdIsValid(taskId)) {
    throw new Error(`Invalid task session id: ${JSON.stringify(taskId)}`);
  }
  return join(sessionsRoot(projectRoot, dataDir), taskId);
}

export function taskSessionIdIsValid(taskId: string): boolean {
  return TaskSessionIdSchema.safeParse(taskId).success;
}
