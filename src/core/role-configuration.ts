import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { pathExists, readJson, removeIfExists, writeJson } from "./file-store.js";
import {
  claimTaskRunLease,
  TaskRunLeaseConflictError,
  type TaskRunLease
} from "./process-ownership.js";
import {
  EngineNameSchema,
  WorkerModelNameSchema,
  type EngineName,
  type WorkerRole
} from "../domain/schemas.js";
import type { WorkerModelRunConfig } from "../workers/types.js";

export const CONFIGURABLE_ROLES = ["main", "judge", "actor", "critic"] as const satisfies readonly WorkerRole[];
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];
export type RoleConfigurationScope = "next" | "task" | "future";

const RoleExecutionTargetSchema = z.object({
  engine: EngineNameSchema,
  model: WorkerModelNameSchema
}).strict();

const RoleExecutionSelectionSchema = z.object({
  main: RoleExecutionTargetSchema,
  judge: RoleExecutionTargetSchema,
  actor: RoleExecutionTargetSchema,
  critic: RoleExecutionTargetSchema
}).strict();

const RoleConfigurationFileSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().datetime(),
  roles: RoleExecutionSelectionSchema
}).strict();

export interface RoleExecutionTarget {
  engine: EngineName;
  model: string;
}

export type RoleExecutionSelection = Record<ConfigurableRole, RoleExecutionTarget>;

export interface RoleProviderOption {
  id: EngineName;
  model: string;
  modelProvider: string;
  assignable: boolean;
}

export interface RoleConfigurationSnapshot {
  baseline: RoleExecutionSelection;
  future: RoleExecutionSelection;
  next: RoleExecutionSelection | null;
  task: RoleExecutionSelection | null;
  activeTurn: RoleExecutionSelection | null;
  providers: RoleProviderOption[];
}

export interface OpenRoleConfigurationInput {
  config: AppConfig;
  appRoot: string;
  workspaceRoot: string;
}

export class RoleConfigurationManager {
  private futureSelection: RoleExecutionSelection;

  private constructor(
    private readonly config: AppConfig,
    private readonly appRoot: string,
    private readonly workspaceRoot: string,
    private readonly baselineSelection: RoleExecutionSelection,
    futureSelection: RoleExecutionSelection
  ) {
    this.futureSelection = cloneRoleSelection(futureSelection);
    applyRoleEngines(this.config, futureSelection);
  }

  static async open(input: OpenRoleConfigurationInput): Promise<RoleConfigurationManager> {
    const baseline = configuredRoleSelection(input.config);
    const futurePath = roleFutureConfigurationPath(input.appRoot, input.config.dataDir);
    const persisted = await readRoleConfigurationIfValid(futurePath, input.config);
    return new RoleConfigurationManager(
      input.config,
      input.appRoot,
      input.workspaceRoot,
      baseline,
      persisted ?? baseline
    );
  }

  static transient(config: AppConfig): RoleConfigurationManager {
    const baseline = configuredRoleSelection(config);
    return new RoleConfigurationManager(
      config,
      config.projectRoot,
      config.projectRoot,
      baseline,
      baseline
    );
  }

  async snapshot(taskDir?: string | null): Promise<RoleConfigurationSnapshot> {
    const [next, task, activeTurn] = await Promise.all([
      readRoleConfigurationIfValid(this.nextPath(), this.config),
      taskDir ? readRoleConfigurationIfValid(roleTaskConfigurationPath(taskDir), this.config) : null,
      taskDir ? this.readLatestTurnSelection(taskDir) : null
    ]);
    return {
      baseline: cloneRoleSelection(this.baselineSelection),
      future: cloneRoleSelection(this.futureSelection),
      next,
      task,
      activeTurn,
      providers: roleProviderOptions(this.config)
    };
  }

  async apply(
    scope: RoleConfigurationScope,
    roles: RoleExecutionSelection,
    taskDir?: string | null
  ): Promise<void> {
    const parsed = parseRoleSelection(roles, this.config);
    if (scope === "future") {
      await writeRoleConfiguration(this.futurePath(), parsed);
      this.futureSelection = cloneRoleSelection(parsed);
      applyRoleEngines(this.config, parsed);
      return;
    }
    if (scope === "next") {
      await this.withNextConfigurationLease(() => writeRoleConfiguration(this.nextPath(), parsed));
      return;
    }
    if (!taskDir) {
      throw new Error("No active Task is available for a current-task role configuration.");
    }
    await writeRoleConfiguration(roleTaskConfigurationPath(taskDir), parsed);
  }

  async clear(scope: RoleConfigurationScope, taskDir?: string | null): Promise<void> {
    if (scope === "future") {
      await removeIfExists(this.futurePath());
      this.futureSelection = cloneRoleSelection(this.baselineSelection);
      applyRoleEngines(this.config, this.futureSelection);
      return;
    }
    if (scope === "next") {
      await this.withNextConfigurationLease(() => removeIfExists(this.nextPath()));
      return;
    }
    if (!taskDir) {
      throw new Error("No active Task is available for a current-task role configuration.");
    }
    await removeIfExists(roleTaskConfigurationPath(taskDir));
  }

  async selectionForRequest(taskDir?: string | null): Promise<RoleExecutionSelection> {
    const taskSelection = await this.selectionForTask(taskDir);
    return this.withNextConfigurationLease(async () => {
      const next = await readRoleConfigurationIfValid(this.nextPath(), this.config);
      if (!next) {
        return taskSelection;
      }
      await removeIfExists(this.nextPath());
      return next;
    });
  }

  async selectionForTask(taskDir?: string | null): Promise<RoleExecutionSelection> {
    const taskSelection = taskDir
      ? await readRoleConfigurationIfValid(roleTaskConfigurationPath(taskDir), this.config)
      : null;
    return cloneRoleSelection(taskSelection ?? this.futureSelection);
  }

  async writeTurnSelection(turnDir: string, roles: RoleExecutionSelection): Promise<void> {
    await writeRoleConfiguration(roleTurnConfigurationPath(turnDir), parseRoleSelection(roles, this.config));
  }

  async readTurnSelection(turnDir: string): Promise<RoleExecutionSelection | null> {
    return readRoleConfigurationIfValid(roleTurnConfigurationPath(turnDir), this.config);
  }

  async modelForTurn(
    turnDir: string,
    role: ConfigurableRole,
    engine: EngineName
  ): Promise<WorkerModelRunConfig> {
    const selection = await this.readTurnSelection(turnDir);
    const target = selection?.[role];
    return roleModelConfiguration(this.config, target?.engine === engine ? target : { engine, model: "" });
  }

  modelForTarget(target: RoleExecutionTarget): WorkerModelRunConfig {
    return roleModelConfiguration(this.config, target);
  }

  futureRoles(): RoleExecutionSelection {
    return cloneRoleSelection(this.futureSelection);
  }

  baselineRoles(): RoleExecutionSelection {
    return cloneRoleSelection(this.baselineSelection);
  }

  validate(roles: RoleExecutionSelection): RoleExecutionSelection {
    return parseRoleSelection(roles, this.config);
  }

  workspaceRootPath(): string {
    return this.workspaceRoot;
  }

  private futurePath(): string {
    return roleFutureConfigurationPath(this.appRoot, this.config.dataDir);
  }

  private nextPath(): string {
    return roleNextConfigurationPath(this.workspaceRoot, this.config.dataDir);
  }

  private nextLeaseDir(): string {
    return join(this.workspaceRoot, this.config.dataDir, ".role-configuration-next-lock");
  }

  private async withNextConfigurationLease<T>(run: () => Promise<T>): Promise<T> {
    let lease: TaskRunLease | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        lease = await claimTaskRunLease(this.nextLeaseDir());
        break;
      } catch (error) {
        if (!(error instanceof TaskRunLeaseConflictError) || attempt === 79) {
          throw error;
        }
        await delay(25);
      }
    }
    if (!lease) {
      throw new Error("Timed out waiting to update the next-request role configuration.");
    }
    try {
      return await run();
    } finally {
      await lease.release();
    }
  }

  private async readLatestTurnSelection(taskDir: string): Promise<RoleExecutionSelection | null> {
    const turnsDir = join(taskDir, "turns");
    if (!(await pathExists(turnsDir))) {
      return null;
    }
    const entries = await readdir(turnsDir, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    return latest
      ? readRoleConfigurationIfValid(roleTurnConfigurationPath(join(turnsDir, latest)), this.config)
      : null;
  }
}

export function configuredRoleSelection(config: AppConfig): RoleExecutionSelection {
  return Object.fromEntries(CONFIGURABLE_ROLES.map((role) => {
    const engine = config.pairing[role];
    return [role, {
      engine,
      model: config.workers[engine]?.model.name ?? ""
    }];
  })) as RoleExecutionSelection;
}

export function roleSelectionWithEngines(
  route: { judge_engine: EngineName; actor_engine: EngineName; critic_engine: EngineName },
  roles: RoleExecutionSelection
): RoleExecutionSelection {
  return {
    ...cloneRoleSelection(roles),
    judge: roleTargetForEngine(roles.judge, route.judge_engine),
    actor: roleTargetForEngine(roles.actor, route.actor_engine),
    critic: roleTargetForEngine(roles.critic, route.critic_engine)
  };
}

export function roleTargetForEngine(target: RoleExecutionTarget, engine: EngineName): RoleExecutionTarget {
  return target.engine === engine ? { ...target } : { engine, model: "" };
}

export function cloneRoleSelection(roles: RoleExecutionSelection): RoleExecutionSelection {
  return {
    main: { ...roles.main },
    judge: { ...roles.judge },
    actor: { ...roles.actor },
    critic: { ...roles.critic }
  };
}

export function roleFutureConfigurationPath(appRoot: string, dataDir: string): string {
  return join(appRoot, dataDir, "role-configuration.json");
}

export function roleNextConfigurationPath(workspaceRoot: string, dataDir: string): string {
  return join(workspaceRoot, dataDir, "role-configuration.next.json");
}

export function roleTaskConfigurationPath(taskDir: string): string {
  return join(taskDir, "role-configuration.json");
}

export function roleTurnConfigurationPath(turnDir: string): string {
  return join(turnDir, "role-configuration.json");
}

async function readRoleConfigurationIfValid(
  path: string,
  config: AppConfig
): Promise<RoleExecutionSelection | null> {
  if (!(await pathExists(path))) {
    return null;
  }
  const parsed = await readJson(path, RoleConfigurationFileSchema);
  return parseRoleSelection(parsed.roles, config);
}

async function writeRoleConfiguration(path: string, roles: RoleExecutionSelection): Promise<void> {
  await writeJson(path, RoleConfigurationFileSchema.parse({
    version: 1,
    updated_at: new Date().toISOString(),
    roles
  }));
}

function parseRoleSelection(roles: RoleExecutionSelection, config: AppConfig): RoleExecutionSelection {
  const parsed = RoleExecutionSelectionSchema.parse(roles);
  for (const role of CONFIGURABLE_ROLES) {
    if (!config.workers[parsed[role].engine]) {
      throw new Error(`Worker provider is not configured: ${parsed[role].engine}`);
    }
  }
  return cloneRoleSelection(parsed);
}

function roleProviderOptions(config: AppConfig): RoleProviderOption[] {
  return Object.entries(config.workers)
    .map(([id, provider]) => ({
      id,
      model: provider.model.name,
      modelProvider: provider.model.provider,
      assignable: provider.assignable
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function roleModelConfiguration(config: AppConfig, target: RoleExecutionTarget): WorkerModelRunConfig {
  const worker = config.workers[target.engine];
  if (!worker) {
    throw new Error(`Worker provider is not configured: ${target.engine}`);
  }
  return {
    ...worker.model,
    name: target.model.trim() || worker.model.name
  };
}

function applyRoleEngines(config: AppConfig, roles: RoleExecutionSelection): void {
  for (const role of CONFIGURABLE_ROLES) {
    config.pairing[role] = roles[role].engine;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
