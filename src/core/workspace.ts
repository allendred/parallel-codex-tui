import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { ensureDir, pathExists, readJson, readTextIfExists, writeJson, writeText } from "./file-store.js";

const lastWorkspaceFile = "last-workspace";
const workspacesFile = "workspaces.json";
const maxRememberedWorkspaces = 20;

const WorkspaceRegistrySchema = z.object({
  version: z.literal(1).default(1),
  workspaces: z
    .array(
      z.object({
        path: z.string().min(1),
        last_used_at: z.string().min(1)
      })
    )
    .default([])
});

type WorkspaceRegistry = z.infer<typeof WorkspaceRegistrySchema>;

export interface WorkspaceSelectionInput {
  appRoot: string;
  cwd: string;
  explicitWorkspace?: string | null;
}

export interface WorkspaceChoice {
  path: string;
  exists: boolean;
  lastUsedAt: string | null;
}

export async function resolveWorkspaceSelection(input: WorkspaceSelectionInput): Promise<string> {
  if (input.explicitWorkspace?.trim()) {
    return resolveWorkspacePath(input.cwd, input.explicitWorkspace);
  }

  const [latest] = await listWorkspaceChoices(input.appRoot);
  return latest ? latest.path : input.cwd;
}

export async function prepareWorkspace(appRoot: string, workspaceRoot: string): Promise<string> {
  const resolved = resolveWorkspacePath(process.cwd(), workspaceRoot);
  await ensureDir(resolved);
  await rememberWorkspace(appRoot, resolved);
  return resolved;
}

export async function hasSavedWorkspace(appRoot: string): Promise<boolean> {
  return (await listWorkspaceChoices(appRoot)).length > 0;
}

export async function listWorkspaceChoices(appRoot: string): Promise<WorkspaceChoice[]> {
  const entries = await readWorkspaceEntries(appRoot);
  const legacy = (await readTextIfExists(lastWorkspacePath(appRoot))).trim();
  if (legacy) {
    entries.push({ path: resolveWorkspacePath(process.cwd(), legacy), last_used_at: "" });
  }

  const seen = new Set<string>();
  const unique = entries
    .map((entry, index) => ({
      path: resolveWorkspacePath(process.cwd(), entry.path),
      lastUsedAt: entry.last_used_at || null,
      order: index
    }))
    .filter((entry) => {
      if (seen.has(entry.path)) {
        return false;
      }
      seen.add(entry.path);
      return true;
    })
    .sort((left, right) => {
      const byDate = (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "");
      return byDate === 0 ? left.order - right.order : byDate;
    });

  return Promise.all(
    unique.map(async (entry) => ({
      path: entry.path,
      exists: await pathExists(entry.path),
      lastUsedAt: entry.lastUsedAt
    }))
  );
}

async function rememberWorkspace(appRoot: string, workspaceRoot: string): Promise<void> {
  const now = new Date().toISOString();
  const resolved = resolveWorkspacePath(process.cwd(), workspaceRoot);
  const current = await readWorkspaceEntries(appRoot);
  const next: WorkspaceRegistry = {
    version: 1,
    workspaces: [
      { path: resolved, last_used_at: now },
      ...current.filter((entry) => resolveWorkspacePath(process.cwd(), entry.path) !== resolved)
    ].slice(0, maxRememberedWorkspaces)
  };

  await writeText(lastWorkspacePath(appRoot), `${resolved}\n`);
  await writeJson(workspacesPath(appRoot), WorkspaceRegistrySchema.parse(next));
}

async function readWorkspaceEntries(appRoot: string): Promise<WorkspaceRegistry["workspaces"]> {
  const file = workspacesPath(appRoot);
  if (!(await pathExists(file))) {
    return [];
  }

  try {
    return (await readJson(file, WorkspaceRegistrySchema)).workspaces;
  } catch {
    return [];
  }
}

function lastWorkspacePath(appRoot: string): string {
  return join(appRoot, ".parallel-codex", lastWorkspaceFile);
}

function workspacesPath(appRoot: string): string {
  return join(appRoot, ".parallel-codex", workspacesFile);
}

export function resolveWorkspacePath(cwd: string, value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  return resolve(cwd, value);
}
