import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readProcessStartToken(pid: number): Promise<string | null> {
  if (!processIsAlive(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      const startTick = fields[19];
      if (startTick) {
        return `linux:${startTick}`;
      }
    } catch {
      // Fall through to ps when procfs is unavailable.
    }
  }
  if (process.platform !== "win32") {
    try {
      const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1000
      });
      const value = String(result.stdout).trim().replace(/\s+/g, " ");
      return value ? `ps:${value}` : null;
    } catch {
      return null;
    }
  }
  return null;
}
