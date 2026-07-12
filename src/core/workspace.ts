import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { ensureDir, pathExists, pathIsDirectory, readJson, readTextIfExists, writeJson, writeText } from "./file-store.js";
import { runWithLeaseFinalization } from "./lease-finalization.js";
import { acquireProcessMutationTurn } from "./process-mutation-turn.js";

const lastWorkspaceFile = "last-workspace";
const workspacesFile = "workspaces.json";
const maxRememberedWorkspaces = 20;
const workspaceRegistryIntentPrefix = ".workspace-registry-claim-";

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
  if ((await pathExists(resolved)) && !(await pathIsDirectory(resolved))) {
    throw new Error(`Workspace path exists but is not a directory: ${resolved}`);
  }
  await ensureDir(resolved);
  await ensureDir(join(resolved, ".parallel-codex"));
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
    entries.push({ path: legacy, last_used_at: "" });
  }

  const seen = new Set<string>();
  const unique = entries
    .map((entry, index) => ({
      path: resolveStoredWorkspacePath(appRoot, entry.path),
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

  const choices = await Promise.all(
    unique.map(async (entry) => {
      const exists = await pathExists(entry.path);
      const isDirectory = exists && (await pathIsDirectory(entry.path));
      return {
        path: entry.path,
        exists: isDirectory,
        lastUsedAt: entry.lastUsedAt,
        selectable: !exists || isDirectory
      };
    })
  );

  return choices
    .filter((choice) => choice.selectable)
    .map(({ selectable: _selectable, ...choice }) => choice);
}

async function rememberWorkspace(appRoot: string, workspaceRoot: string): Promise<void> {
  const resolved = resolveWorkspacePath(process.cwd(), workspaceRoot);
  const mutationTurn = await acquireProcessMutationTurn(join(appRoot, ".parallel-codex"), {
    intentPrefix: workspaceRegistryIntentPrefix,
    timeoutMessage: "Timed out waiting to update the workspace registry."
  });

  await runWithLeaseFinalization("Workspace registry update", mutationTurn, async () => {
    const current = await readWorkspaceEntries(appRoot);
    const next: WorkspaceRegistry = {
      version: 1,
      workspaces: [
        { path: resolved, last_used_at: new Date().toISOString() },
        ...current.filter((entry) => resolveStoredWorkspacePath(appRoot, entry.path) !== resolved)
      ].slice(0, maxRememberedWorkspaces)
    };

    await writeJson(workspacesPath(appRoot), WorkspaceRegistrySchema.parse(next));
    await writeText(lastWorkspacePath(appRoot), `${resolved}\n`);
  });
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

function resolveStoredWorkspacePath(appRoot: string, value: string): string {
  return resolveWorkspacePath(appRoot, value);
}
