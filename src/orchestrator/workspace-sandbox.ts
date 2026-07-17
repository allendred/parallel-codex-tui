import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ensureDir, pathExists, pathIsDirectory, writeJson } from "../core/file-store.js";

const MAX_TEXT_MERGE_BYTES = 10 * 1024 * 1024;
const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const LIVE_COMMIT_PROTOCOL = "atomic-claim-v1";

export interface ParallelWorkspaceManagerOptions {
  workspaceRoot: string;
  taskDir: string;
  dataDir: string;
}

export interface ParallelWorkspaceManagerDependencies {
  writeIntegrationCheckpoint?: (path: string, value: Record<string, unknown>) => Promise<void>;
  removeIntegrationIntent?: (path: string) => Promise<void>;
  liveCommitHook?: (event: LiveCommitHookEvent) => Promise<void>;
}

export interface LiveCommitHookEvent {
  path: string;
  phase: "before-claim" | "before-publish";
}

export interface PrepareWorkspaceWaveInput {
  turnId: string;
  wave: number;
  featureIds: string[];
}

export interface FeatureWorkspaceWave {
  turnId: string;
  wave: number;
  rootDir: string;
  baselineDir: string;
  stagingDir: string;
  integrationDir: string;
  verificationDir: string;
  conflictDir: string;
  featureIds: string[];
  featureDirs: ReadonlyMap<string, string>;
  reviewDirs: ReadonlyMap<string, string>;
}

export interface WorkspaceIntegrationResult {
  changedPaths: string[];
}

interface MissingEntry {
  type: "missing";
}

interface FileEntry {
  type: "file";
  hash: string;
  mode: number;
  size: number;
}

interface SymlinkEntry {
  type: "symlink";
  target: string;
}

type WorkspaceEntry = MissingEntry | FileEntry | SymlinkEntry;

interface CopyOperation {
  path: string;
  sourcePath?: string;
  content?: Buffer;
  expected: WorkspaceEntry;
  incoming: WorkspaceEntry;
}

interface MergePlan {
  operations: CopyOperation[];
  changedPaths: string[];
  conflicts: string[];
}

interface MergeFileResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface IntegrationCommitIntent {
  version: 1;
  state: "committing";
  turn_id: string;
  wave: number;
  feature_ids: string[];
  commit_id?: string;
  commit_protocol?: typeof LIVE_COMMIT_PROTOCOL;
  changed_paths: string[];
}

export class WorkspaceMergeConflictError extends Error {
  readonly paths: string[];
  readonly conflictDir: string;
  readonly wave?: number;
  readonly featureId?: string;
  readonly waveFeatureIds: string[];
  readonly integratedFeatureIds: string[];

  constructor(
    paths: string[],
    conflictDir: string,
    context: {
      wave?: number;
      featureId?: string;
      waveFeatureIds?: string[];
      integratedFeatureIds?: string[];
    } = {}
  ) {
    const count = paths.length;
    super(
      `Workspace integration conflict in ${count} ${count === 1 ? "path" : "paths"}: ${paths.join(", ")}. `
      + `The live workspace was not changed. Conflict evidence: ${conflictDir}`
    );
    this.name = "WorkspaceMergeConflictError";
    this.paths = paths;
    this.conflictDir = conflictDir;
    this.wave = context.wave;
    this.featureId = context.featureId;
    this.waveFeatureIds = [...(context.waveFeatureIds ?? [])];
    this.integratedFeatureIds = [...(context.integratedFeatureIds ?? [])];
  }
}

export class WorkspaceLiveMutationError extends Error {
  readonly paths: string[];

  constructor(
    paths: string[],
    context: "before-commit" | "during-commit" | "pending-commit" = "before-commit"
  ) {
    const count = paths.length;
    super(
      `Live workspace changed outside orchestration in ${count} ${count === 1 ? "path" : "paths"}: ${paths.join(", ")}. `
      + (context === "pending-commit"
        ? "Pending integration recovery was blocked and its commit intent was preserved."
        : context === "during-commit"
          ? "The integration intent was preserved and the concurrent content was not overwritten."
          : "The isolated wave was not integrated.")
    );
    this.name = "WorkspaceLiveMutationError";
    this.paths = paths;
  }
}

export class ParallelWorkspaceManager {
  private readonly workspaceRoot: string;
  private readonly taskDir: string;
  private readonly dataRelativePath: string | null;
  private readonly writeIntegrationCheckpoint: (path: string, value: Record<string, unknown>) => Promise<void>;
  private readonly removeIntegrationIntent: (path: string) => Promise<void>;
  private readonly liveCommitHook: (event: LiveCommitHookEvent) => Promise<void>;

  constructor(
    options: ParallelWorkspaceManagerOptions,
    dependencies: ParallelWorkspaceManagerDependencies = {}
  ) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.taskDir = resolve(options.taskDir);
    const candidateDataRoot = resolve(this.workspaceRoot, options.dataDir);
    const dataRoot = isWithin(candidateDataRoot, this.workspaceRoot) ? candidateDataRoot : null;
    this.dataRelativePath = dataRoot ? relative(this.workspaceRoot, dataRoot) : null;
    this.writeIntegrationCheckpoint = dependencies.writeIntegrationCheckpoint ?? writeJson;
    this.removeIntegrationIntent = dependencies.removeIntegrationIntent
      ?? ((path) => rm(path, { force: true }));
    this.liveCommitHook = dependencies.liveCommitHook ?? (async () => undefined);
  }

  async prepareWave(input: PrepareWorkspaceWaveInput): Promise<FeatureWorkspaceWave> {
    const wave = this.describeWave(input);

    await rm(wave.rootDir, { recursive: true, force: true });
    await cloneTree(this.workspaceRoot, wave.baselineDir, (path) => this.excludeFromSource(path));
    await cloneTree(wave.baselineDir, wave.stagingDir);

    for (const featureDir of wave.featureDirs.values()) {
      await cloneTree(wave.baselineDir, featureDir);
    }

    await writeJson(join(wave.rootDir, "workspace.json"), {
      version: 1,
      workspace_root: this.workspaceRoot,
      turn_id: input.turnId,
      wave: input.wave,
      baseline: wave.baselineDir,
      staging: wave.stagingDir,
      integration: wave.integrationDir,
      verification: wave.verificationDir,
      features: Object.fromEntries(wave.featureDirs),
      reviews: Object.fromEntries(wave.reviewDirs)
    });
    return wave;
  }

  async restoreWave(input: PrepareWorkspaceWaveInput): Promise<FeatureWorkspaceWave | null> {
    const wave = this.describeWave(input);
    const manifest = await readJsonRecord(join(wave.rootDir, "workspace.json"));
    if (
      manifest?.version !== 1
      || manifest.workspace_root !== this.workspaceRoot
      || manifest.turn_id !== input.turnId
      || manifest.wave !== input.wave
      || !recordKeysEqual(manifest.features, input.featureIds)
      || !(await pathIsDirectory(wave.baselineDir))
      || !(await pathIsDirectory(wave.stagingDir))
    ) {
      return null;
    }
    for (const featureDir of wave.featureDirs.values()) {
      if (!(await pathIsDirectory(featureDir))) {
        return null;
      }
    }
    const pendingCommit = await this.readPendingCommit(wave);
    if (pendingCommit) {
      await this.recoverOwnedCommitArtifacts(wave, pendingCommit);
      await this.assertLiveWorkspaceCommitResumable(wave);
      return wave;
    }
    try {
      await this.assertLiveWorkspaceUnchanged(wave);
      return wave;
    } catch (error) {
      if (error instanceof WorkspaceLiveMutationError) {
        return null;
      }
      throw error;
    }
  }

  private describeWave(input: PrepareWorkspaceWaveInput): FeatureWorkspaceWave {
    if (!Number.isInteger(input.wave) || input.wave < 1) {
      throw new Error(`Workspace wave must be a positive integer: ${input.wave}`);
    }
    if (!/^\d{4,}$/.test(input.turnId)) {
      throw new Error(`Unsafe workspace turn id: ${input.turnId}`);
    }
    if (input.featureIds.length === 0 || new Set(input.featureIds).size !== input.featureIds.length) {
      throw new Error("Workspace wave requires unique feature ids.");
    }
    for (const featureId of input.featureIds) {
      if (!FEATURE_ID_PATTERN.test(featureId)) {
        throw new Error(`Unsafe workspace feature id: ${featureId}`);
      }
    }

    const rootDir = join(
      this.taskDir,
      "workspaces",
      `turn-${input.turnId}`,
      `wave-${String(input.wave).padStart(4, "0")}`
    );
    const baselineDir = join(rootDir, "baseline");
    const stagingDir = join(rootDir, "staging");
    const integrationDir = join(rootDir, "integration");
    const verificationDir = join(rootDir, "verification");
    const conflictDir = join(rootDir, "conflicts");
    const featureDirs = new Map<string, string>();
    const reviewDirs = new Map<string, string>();

    for (const featureId of input.featureIds) {
      const featureDir = join(rootDir, "features", featureId);
      featureDirs.set(featureId, featureDir);
      reviewDirs.set(featureId, join(rootDir, "reviews", featureId));
    }

    const wave: FeatureWorkspaceWave = {
      turnId: input.turnId,
      wave: input.wave,
      rootDir,
      baselineDir,
      stagingDir,
      integrationDir,
      verificationDir,
      conflictDir,
      featureIds: [...input.featureIds],
      featureDirs,
      reviewDirs
    };
    return wave;
  }

  async stageWave(wave: FeatureWorkspaceWave): Promise<WorkspaceIntegrationResult> {
    const pendingCommit = await this.readPendingCommit(wave);
    if (pendingCommit) {
      await this.recoverOwnedCommitArtifacts(wave, pendingCommit);
      await this.assertLiveWorkspaceCommitResumable(wave);
      return { changedPaths: pendingCommit.changed_paths };
    }
    await this.assertLiveWorkspaceUnchanged(wave);
    await rm(wave.conflictDir, { recursive: true, force: true });
    await rm(wave.stagingDir, { recursive: true, force: true });
    await rm(wave.integrationDir, { recursive: true, force: true });
    await rm(wave.verificationDir, { recursive: true, force: true });
    await cloneTree(wave.baselineDir, wave.stagingDir);

    for (const [featureIndex, featureId] of wave.featureIds.entries()) {
      const featureDir = wave.featureDirs.get(featureId);
      if (!featureDir) {
        throw new Error(`Feature workspace missing for ${featureId}`);
      }
      const featureConflictDir = join(wave.conflictDir, featureId);
      const plan = await planWorkspaceMerge(
        wave.baselineDir,
        featureDir,
        wave.stagingDir,
        featureConflictDir,
        (path) => this.excludeRelativePath(path)
      );
      if (plan.conflicts.length > 0) {
        throw new WorkspaceMergeConflictError(plan.conflicts, featureConflictDir, {
          wave: wave.wave,
          featureId,
          waveFeatureIds: wave.featureIds,
          integratedFeatureIds: wave.featureIds.slice(0, featureIndex)
        });
      }
      await applyMergePlan(wave.stagingDir, plan);
    }

    await cloneTree(wave.stagingDir, wave.integrationDir);
    const changedPaths = await workspaceChangedPaths(
      wave.baselineDir,
      wave.integrationDir,
      (path) => this.excludeRelativePath(path)
    );
    await this.writeIntegrationCheckpoint(join(wave.rootDir, "integration.json"), {
      version: 1,
      state: "staged",
      turn_id: wave.turnId,
      wave: wave.wave,
      feature_ids: wave.featureIds,
      changed_paths: changedPaths
    });
    return { changedPaths };
  }

  async discardWavesFrom(turnId: string, firstWave: number): Promise<void> {
    if (!/^\d{4,}$/.test(turnId)) {
      throw new Error(`Unsafe workspace turn id: ${turnId}`);
    }
    if (!Number.isInteger(firstWave) || firstWave < 1) {
      throw new Error(`Workspace wave must be a positive integer: ${firstWave}`);
    }
    const turnRoot = join(this.taskDir, "workspaces", `turn-${turnId}`);
    if (!(await pathIsDirectory(turnRoot))) {
      return;
    }
    for (const entry of await readdir(turnRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const match = entry.name.match(/^wave-(\d+)$/);
      if (match && Number(match[1] ?? 0) >= firstWave) {
        await rm(join(turnRoot, entry.name), { recursive: true, force: true });
      }
    }
    await rm(join(turnRoot, "final-verification"), { recursive: true, force: true });
    await rm(join(turnRoot, "final-verification.json"), { force: true });
  }

  async prepareVerificationWorkspace(wave: FeatureWorkspaceWave): Promise<string> {
    await rm(wave.verificationDir, { recursive: true, force: true });
    await cloneTree(wave.integrationDir, wave.verificationDir);
    return wave.verificationDir;
  }

  async prepareFeatureReviewWorkspace(wave: FeatureWorkspaceWave, featureId: string): Promise<string> {
    const featureDir = wave.featureDirs.get(featureId);
    const reviewDir = wave.reviewDirs.get(featureId);
    if (!featureDir || !reviewDir) {
      throw new Error(`Feature review workspace missing for ${featureId}`);
    }
    await rm(reviewDir, { recursive: true, force: true });
    await cloneTree(featureDir, reviewDir);
    return reviewDir;
  }

  async prepareFinalVerificationWorkspace(turnId: string): Promise<string> {
    if (!/^\d{4,}$/.test(turnId)) {
      throw new Error(`Unsafe workspace turn id: ${turnId}`);
    }
    const turnRoot = join(this.taskDir, "workspaces", `turn-${turnId}`);
    const verificationDir = join(turnRoot, "final-verification");
    await rm(verificationDir, { recursive: true, force: true });
    await cloneTree(this.workspaceRoot, verificationDir, (path) => this.excludeFromSource(path));
    await writeJson(join(turnRoot, "final-verification.json"), {
      version: 1,
      workspace_root: this.workspaceRoot,
      turn_id: turnId,
      verification: verificationDir
    });
    return verificationDir;
  }

  async commitWave(wave: FeatureWorkspaceWave): Promise<WorkspaceIntegrationResult> {
    const pendingCommit = await this.readPendingCommit(wave);
    if (pendingCommit) {
      await this.recoverOwnedCommitArtifacts(wave, pendingCommit);
      await this.assertLiveWorkspaceCommitResumable(wave);
    } else {
      await this.assertLiveWorkspaceUnchanged(wave);
    }
    const liveConflictDir = join(wave.conflictDir, "live-workspace");
    const livePlan = await planWorkspaceMerge(
      wave.baselineDir,
      wave.integrationDir,
      this.workspaceRoot,
      liveConflictDir,
      (path) => this.excludeRelativePath(path)
    );
    if (livePlan.conflicts.length > 0) {
      throw new WorkspaceMergeConflictError(livePlan.conflicts, liveConflictDir);
    }

    const changedPaths = pendingCommit?.changed_paths ?? await workspaceChangedPaths(
      wave.baselineDir,
      wave.integrationDir,
      (path) => this.excludeRelativePath(path)
    );
    const pendingPath = this.pendingCommitPath(wave);
    const commitId = pendingCommit?.commit_id ?? randomUUID();
    if (!pendingCommit || pendingCommit.commit_protocol !== LIVE_COMMIT_PROTOCOL) {
      await this.writeIntegrationCheckpoint(pendingPath, {
        version: 1,
        state: "committing",
        turn_id: wave.turnId,
        wave: wave.wave,
        feature_ids: wave.featureIds,
        commit_id: commitId,
        commit_protocol: LIVE_COMMIT_PROTOCOL,
        changed_paths: changedPaths
      });
    }
    await applyMergePlan(this.workspaceRoot, livePlan, commitId, this.liveCommitHook);
    const incompletePaths = await workspaceChangedPaths(
      wave.integrationDir,
      this.workspaceRoot,
      (path) => this.excludeRelativePath(path)
    );
    if (incompletePaths.length > 0) {
      throw new Error(`Live workspace commit verification failed: ${incompletePaths.join(", ")}`);
    }
    await this.writeIntegrationCheckpoint(join(wave.rootDir, "integration.json"), {
      version: 1,
      state: "integrated",
      turn_id: wave.turnId,
      wave: wave.wave,
      feature_ids: wave.featureIds,
      commit_id: commitId,
      commit_protocol: LIVE_COMMIT_PROTOCOL,
      changed_paths: changedPaths
    });
    try {
      await this.removeIntegrationIntent(pendingPath);
    } catch {
      // The integrated checkpoint is authoritative; a later retry can remove the redundant intent.
    }
    return { changedPaths };
  }

  async integrateWave(wave: FeatureWorkspaceWave): Promise<WorkspaceIntegrationResult> {
    await this.stageWave(wave);
    return this.commitWave(wave);
  }

  async assertLiveWorkspaceUnchanged(wave: FeatureWorkspaceWave): Promise<void> {
    const paths = await workspaceChangedPaths(
      wave.baselineDir,
      this.workspaceRoot,
      (path) => this.excludeRelativePath(path)
    );
    if (paths.length > 0) {
      throw new WorkspaceLiveMutationError(paths);
    }
  }

  private pendingCommitPath(wave: FeatureWorkspaceWave): string {
    return join(wave.rootDir, "integration.pending.json");
  }

  private async readPendingCommit(wave: FeatureWorkspaceWave): Promise<IntegrationCommitIntent | null> {
    const path = this.pendingCommitPath(wave);
    if (!(await pathExists(path))) {
      return null;
    }
    const record = await readJsonRecord(path);
    const featureIds = readStringArray(record?.feature_ids);
    const changedPaths = readStringArray(record?.changed_paths);
    const commitId = typeof record?.commit_id === "string" && COMMIT_ID_PATTERN.test(record.commit_id)
      ? record.commit_id
      : undefined;
    const commitProtocol = record?.commit_protocol === LIVE_COMMIT_PROTOCOL
      ? LIVE_COMMIT_PROTOCOL
      : undefined;
    const expectedChangedPaths = await workspaceChangedPaths(
      wave.baselineDir,
      wave.integrationDir,
      (item) => this.excludeRelativePath(item)
    );
    if (
      record?.version !== 1
      || record.state !== "committing"
      || record.turn_id !== wave.turnId
      || record.wave !== wave.wave
      || !featureIds
      || !changedPaths
      || (record.commit_id !== undefined && !commitId)
      || (record.commit_protocol !== undefined && !commitProtocol)
      || !sameStrings(featureIds, wave.featureIds)
      || !sameStrings(changedPaths, expectedChangedPaths)
    ) {
      throw new Error(`Invalid integration commit intent: ${path}`);
    }
    return {
      version: 1,
      state: "committing",
      turn_id: wave.turnId,
      wave: wave.wave,
      feature_ids: featureIds,
      ...(commitId ? { commit_id: commitId } : {}),
      ...(commitProtocol ? { commit_protocol: commitProtocol } : {}),
      changed_paths: changedPaths
    };
  }

  private async recoverOwnedCommitArtifacts(
    wave: FeatureWorkspaceWave,
    intent: IntegrationCommitIntent
  ): Promise<void> {
    if (!intent.commit_id) {
      return;
    }
    for (const path of intent.changed_paths) {
      const tempPath = mergeOperationTempPath(this.workspaceRoot, path, intent.commit_id);
      const backupPath = mergeOperationBackupPath(this.workspaceRoot, path, intent.commit_id);
      const [baseline, integration] = await Promise.all([
        inspectEntry(join(wave.baselineDir, path)),
        inspectEntry(join(wave.integrationDir, path))
      ]);
      await recoverOwnedCommitPath({
        path,
        targetPath: join(this.workspaceRoot, path),
        tempPath,
        backupPath,
        baseline,
        integration,
        commitProtocol: intent.commit_protocol
      });
    }
  }

  private async assertLiveWorkspaceCommitResumable(wave: FeatureWorkspaceWave): Promise<void> {
    const exclude = (path: string) => this.excludeRelativePath(path);
    const [baseline, integration, live] = await Promise.all([
      workspaceManifest(wave.baselineDir, exclude),
      workspaceManifest(wave.integrationDir, exclude),
      workspaceManifest(this.workspaceRoot, exclude)
    ]);
    const paths = [...new Set([...baseline.keys(), ...integration.keys(), ...live.keys()])].sort();
    const unsafe = paths.filter((path) => {
      const current = live.get(path) ?? missingEntry();
      return !sameEntry(current, baseline.get(path) ?? missingEntry())
        && !sameEntry(current, integration.get(path) ?? missingEntry());
    });
    if (unsafe.length > 0) {
      throw new WorkspaceLiveMutationError(unsafe, "pending-commit");
    }
  }

  private excludeFromSource(path: string): boolean {
    const absolutePath = resolve(path);
    return this.excludeRelativePath(relative(this.workspaceRoot, absolutePath));
  }

  private excludeRelativePath(path: string): boolean {
    const segments = path.split(sep);
    if (segments.includes(".git")) {
      return true;
    }
    return Boolean(
      this.dataRelativePath
      && (path === this.dataRelativePath || path.startsWith(`${this.dataRelativePath}${sep}`))
    );
  }
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function recordKeysEqual(value: unknown, expected: string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? [...value]
    : null;
}

function sameStrings(left: string[], right: string[]): boolean {
  const actual = [...left].sort();
  const expected = [...right].sort();
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

async function workspaceChangedPaths(
  baselineRoot: string,
  incomingRoot: string,
  exclude: (relativePath: string) => boolean
): Promise<string[]> {
  const [baseline, incoming] = await Promise.all([
    workspaceManifest(baselineRoot, exclude),
    workspaceManifest(incomingRoot, exclude)
  ]);
  return [...new Set([...baseline.keys(), ...incoming.keys()])]
    .filter((path) => !exclude(path))
    .filter((path) => !sameEntry(baseline.get(path) ?? missingEntry(), incoming.get(path) ?? missingEntry()))
    .sort();
}

async function cloneTree(sourceRoot: string, targetRoot: string, exclude: (path: string) => boolean = () => false): Promise<void> {
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  if (exclude(source)) {
    return;
  }
  await mkdir(target, { recursive: true });
  await cloneDirectory(source, target, exclude);
}

async function cloneDirectory(sourceDir: string, targetDir: string, exclude: (path: string) => boolean): Promise<void> {
  const sourceStat = await lstat(sourceDir);
  await chmod(targetDir, sourceStat.mode & 0o777).catch(() => undefined);
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    if (exclude(sourcePath)) {
      continue;
    }
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await cloneDirectory(sourcePath, targetPath, exclude);
      continue;
    }
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), targetPath);
      continue;
    }
    if (entry.isFile()) {
      const stat = await lstat(sourcePath);
      await copyFile(sourcePath, targetPath, constants.COPYFILE_FICLONE);
      await chmod(targetPath, stat.mode & 0o777);
    }
  }
}

async function planWorkspaceMerge(
  baselineRoot: string,
  incomingRoot: string,
  targetRoot: string,
  conflictDir: string,
  exclude: (relativePath: string) => boolean = () => false
): Promise<MergePlan> {
  const [baseline, incoming] = await Promise.all([
    workspaceManifest(baselineRoot, exclude),
    workspaceManifest(incomingRoot, exclude)
  ]);
  const paths = [...new Set([...baseline.keys(), ...incoming.keys()])].sort();
  const operations: CopyOperation[] = [];
  const changedPaths: string[] = [];
  const conflicts: string[] = [];

  for (const path of paths) {
    if (exclude(path)) {
      continue;
    }
    const baselineEntry = baseline.get(path) ?? missingEntry();
    const incomingEntry = incoming.get(path) ?? missingEntry();
    if (sameEntry(baselineEntry, incomingEntry)) {
      continue;
    }
    const targetPath = join(targetRoot, path);
    const targetEntry = await inspectEntry(targetPath);

    if (sameEntry(targetEntry, incomingEntry)) {
      continue;
    }
    if (sameEntry(targetEntry, baselineEntry)) {
      operations.push({
        path,
        expected: targetEntry,
        incoming: incomingEntry,
        ...(incomingEntry.type !== "missing" ? { sourcePath: join(incomingRoot, path) } : {})
      });
      changedPaths.push(path);
      continue;
    }

    const merged = await tryTextMerge({
      path,
      baselineRoot,
      incomingRoot,
      targetRoot,
      baselineEntry,
      incomingEntry,
      targetEntry,
      conflictDir
    });
    if (merged?.clean) {
      operations.push({
        path,
        expected: targetEntry,
        incoming: {
          type: "file",
          hash: hashBuffer(merged.content),
          mode: targetEntry.type === "file" ? targetEntry.mode : incomingEntry.type === "file" ? incomingEntry.mode : 0o644,
          size: merged.content.length
        },
        content: merged.content
      });
      changedPaths.push(path);
      continue;
    }

    conflicts.push(path);
    if (!merged) {
      await writeJson(join(conflictDir, `${path}.json`), {
        path,
        reason: "binary-or-structural-conflict",
        baseline: describeEntry(baselineEntry),
        target: describeEntry(targetEntry),
        incoming: describeEntry(incomingEntry)
      });
    }
  }

  return {
    operations,
    changedPaths: [...new Set(changedPaths)].sort(),
    conflicts: [...new Set(conflicts)].sort()
  };
}

async function applyMergePlan(
  targetRoot: string,
  plan: MergePlan,
  commitId?: string,
  liveCommitHook: (event: LiveCommitHookEvent) => Promise<void> = async () => undefined
): Promise<void> {
  const operations = [
    ...plan.operations.filter((item) => item.incoming.type === "missing"),
    ...plan.operations.filter((item) => item.incoming.type !== "missing")
  ];
  for (const operation of operations) {
    if (commitId) {
      await applyCommittedOperation(targetRoot, operation, commitId, liveCommitHook);
    } else if (operation.incoming.type === "missing") {
      await rm(join(targetRoot, operation.path), { recursive: true, force: true });
    } else {
      await applyOperation(targetRoot, operation);
    }
  }
}

async function applyOperation(targetRoot: string, operation: CopyOperation): Promise<void> {
  const targetPath = join(targetRoot, operation.path);
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await prepareOperationTemp(targetPath, tempPath, operation);
  await rm(targetPath, { recursive: true, force: true });
  await rename(tempPath, targetPath);
}

async function applyCommittedOperation(
  targetRoot: string,
  operation: CopyOperation,
  commitId: string,
  liveCommitHook: (event: LiveCommitHookEvent) => Promise<void>
): Promise<void> {
  const targetPath = join(targetRoot, operation.path);
  const tempPath = mergeOperationTempPath(targetRoot, operation.path, commitId);
  const backupPath = mergeOperationBackupPath(targetRoot, operation.path, commitId);
  if (operation.incoming.type !== "missing") {
    await prepareOperationTemp(targetPath, tempPath, operation);
  }

  await liveCommitHook({ path: operation.path, phase: "before-claim" });
  const current = await inspectEntry(targetPath);
  if (!sameEntry(current, operation.expected)) {
    await rm(tempPath, { recursive: true, force: true });
    throw new WorkspaceLiveMutationError([operation.path], "during-commit");
  }

  let claimed = false;
  if (operation.expected.type !== "missing") {
    if ((await inspectEntry(backupPath)).type !== "missing") {
      throw new WorkspaceLiveMutationError([operation.path], "during-commit");
    }
    try {
      await rename(targetPath, backupPath);
      claimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceLiveMutationError([operation.path], "during-commit");
      }
      throw error;
    }
    const backup = await inspectEntry(backupPath);
    if (!sameEntry(backup, operation.expected)) {
      const restored = await restoreClaimedEntry(targetPath, backupPath, backup);
      if (restored) {
        await rm(tempPath, { recursive: true, force: true });
      }
      throw new WorkspaceLiveMutationError([operation.path], "during-commit");
    }
  }

  await liveCommitHook({ path: operation.path, phase: "before-publish" });
  if ((await inspectEntry(targetPath)).type !== "missing") {
    throw new WorkspaceLiveMutationError([operation.path], "during-commit");
  }
  if (operation.incoming.type !== "missing") {
    try {
      await publishPreparedEntry(tempPath, targetPath, operation.incoming);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceLiveMutationError([operation.path], "during-commit");
      }
      throw error;
    }
    await rm(tempPath, { recursive: true, force: true });
  }

  if (claimed) {
    if (!sameEntry(await inspectEntry(backupPath), operation.expected)) {
      throw new WorkspaceLiveMutationError([operation.path], "during-commit");
    }
    await rm(backupPath, { recursive: true, force: true });
  }
}

async function prepareOperationTemp(
  targetPath: string,
  tempPath: string,
  operation: CopyOperation
): Promise<void> {
  await ensureDir(dirname(targetPath));
  await rm(tempPath, { recursive: true, force: true });

  if (operation.incoming.type === "file") {
    if (operation.content) {
      await writeFile(tempPath, operation.content);
    } else if (operation.sourcePath) {
      await copyFile(operation.sourcePath, tempPath, constants.COPYFILE_FICLONE);
    } else {
      throw new Error(`Missing source for workspace file: ${operation.path}`);
    }
    await chmod(tempPath, operation.incoming.mode);
  } else if (operation.incoming.type === "symlink") {
    await symlink(operation.incoming.target, tempPath);
  }
}

async function publishPreparedEntry(
  sourcePath: string,
  targetPath: string,
  entry: Exclude<WorkspaceEntry, MissingEntry>
): Promise<void> {
  if (entry.type === "file") {
    await link(sourcePath, targetPath);
  } else {
    await symlink(await readlink(sourcePath), targetPath);
  }
}

async function restoreClaimedEntry(
  targetPath: string,
  backupPath: string,
  entry: WorkspaceEntry
): Promise<boolean> {
  if (entry.type === "missing" || (await inspectEntry(targetPath)).type !== "missing") {
    return false;
  }
  try {
    await publishPreparedEntry(backupPath, targetPath, entry);
    await rm(backupPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function mergeOperationTempPath(targetRoot: string, path: string, commitId: string): string {
  const targetPath = join(targetRoot, path);
  return join(dirname(targetPath), `.${basename(targetPath)}.parallel-codex-${commitId}.tmp`);
}

function mergeOperationBackupPath(targetRoot: string, path: string, commitId: string): string {
  const targetPath = join(targetRoot, path);
  return join(dirname(targetPath), `.${basename(targetPath)}.parallel-codex-${commitId}.backup`);
}

interface RecoverOwnedCommitPathInput {
  path: string;
  targetPath: string;
  tempPath: string;
  backupPath: string;
  baseline: WorkspaceEntry;
  integration: WorkspaceEntry;
  commitProtocol?: typeof LIVE_COMMIT_PROTOCOL;
}

async function recoverOwnedCommitPath(input: RecoverOwnedCommitPathInput): Promise<void> {
  const [initialTemp, backup, initialLive] = await Promise.all([
    inspectEntry(input.tempPath),
    inspectEntry(input.backupPath),
    inspectEntry(input.targetPath)
  ]);
  let temp = initialTemp;
  let live = initialLive;
  if (temp.type !== "missing" && !sameEntry(temp, input.integration)) {
    throw new Error(`Pending integration temp does not match the integration snapshot: ${input.path}`);
  }
  if (backup.type !== "missing" && !sameEntry(backup, input.baseline)) {
    throw new Error(`Pending integration backup does not match the baseline snapshot: ${input.path}`);
  }

  if (backup.type !== "missing") {
    if (sameEntry(live, input.integration)) {
      await rm(input.tempPath, { recursive: true, force: true });
      await rm(input.backupPath, { recursive: true, force: true });
      return;
    }
    if (sameEntry(live, input.baseline)) {
      await rm(input.backupPath, { recursive: true, force: true });
    } else if (live.type === "missing") {
      if (input.integration.type === "missing") {
        await rm(input.backupPath, { recursive: true, force: true });
        return;
      }
      if (temp.type === "missing") {
        throw new Error(`Pending integration replacement is missing: ${input.path}`);
      }
      await publishPendingEntry(input, temp);
      await rm(input.tempPath, { recursive: true, force: true });
      if (!sameEntry(await inspectEntry(input.backupPath), input.baseline)) {
        throw new WorkspaceLiveMutationError([input.path], "pending-commit");
      }
      await rm(input.backupPath, { recursive: true, force: true });
      return;
    } else {
      throw new WorkspaceLiveMutationError([input.path], "pending-commit");
    }
  }

  temp = await inspectEntry(input.tempPath);
  if (temp.type === "missing") {
    return;
  }
  live = await inspectEntry(input.targetPath);
  if (sameEntry(live, input.integration)) {
    await rm(input.tempPath, { recursive: true, force: true });
    return;
  }
  if (!sameEntry(live, input.baseline) && live.type !== "missing") {
    throw new WorkspaceLiveMutationError([input.path], "pending-commit");
  }
  if (
    input.commitProtocol === LIVE_COMMIT_PROTOCOL
    && live.type === "missing"
    && input.baseline.type !== "missing"
  ) {
    throw new WorkspaceLiveMutationError([input.path], "pending-commit");
  }

  let claimed = false;
  if (live.type !== "missing") {
    await rename(input.targetPath, input.backupPath);
    claimed = true;
    if (!sameEntry(await inspectEntry(input.backupPath), input.baseline)) {
      throw new WorkspaceLiveMutationError([input.path], "pending-commit");
    }
  }
  await publishPendingEntry(input, temp);
  await rm(input.tempPath, { recursive: true, force: true });
  if (claimed) {
    if (!sameEntry(await inspectEntry(input.backupPath), input.baseline)) {
      throw new WorkspaceLiveMutationError([input.path], "pending-commit");
    }
    await rm(input.backupPath, { recursive: true, force: true });
  }
}

async function publishPendingEntry(
  input: RecoverOwnedCommitPathInput,
  entry: Exclude<WorkspaceEntry, MissingEntry>
): Promise<void> {
  try {
    await publishPreparedEntry(input.tempPath, input.targetPath, entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceLiveMutationError([input.path], "pending-commit");
    }
    throw error;
  }
}

async function workspaceManifest(
  root: string,
  exclude: (relativePath: string) => boolean
): Promise<Map<string, WorkspaceEntry>> {
  const manifest = new Map<string, WorkspaceEntry>();
  await visitManifest(resolve(root), resolve(root), manifest, exclude);
  return manifest;
}

async function visitManifest(
  root: string,
  current: string,
  manifest: Map<string, WorkspaceEntry>,
  exclude: (relativePath: string) => boolean
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path);
    if (exclude(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await visitManifest(root, path, manifest, exclude);
      continue;
    }
    const inspected = await inspectEntry(path);
    if (inspected.type !== "missing") {
      manifest.set(relativePath, inspected);
    }
  }
}

async function inspectEntry(path: string): Promise<WorkspaceEntry> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      return { type: "symlink", target: await readlink(path) };
    }
    if (stat.isFile()) {
      const content = await readFile(path);
      return {
        type: "file",
        hash: hashBuffer(content),
        mode: stat.mode & 0o777,
        size: stat.size
      };
    }
    return missingEntry();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return missingEntry();
    }
    throw error;
  }
}

async function tryTextMerge(input: {
  path: string;
  baselineRoot: string;
  incomingRoot: string;
  targetRoot: string;
  baselineEntry: WorkspaceEntry;
  incomingEntry: WorkspaceEntry;
  targetEntry: WorkspaceEntry;
  conflictDir: string;
}): Promise<{ clean: boolean; content: Buffer } | null> {
  if (
    input.baselineEntry.type !== "file"
    || input.incomingEntry.type !== "file"
    || input.targetEntry.type !== "file"
    || input.baselineEntry.size > MAX_TEXT_MERGE_BYTES
    || input.incomingEntry.size > MAX_TEXT_MERGE_BYTES
    || input.targetEntry.size > MAX_TEXT_MERGE_BYTES
  ) {
    return null;
  }

  const paths = {
    baseline: join(input.baselineRoot, input.path),
    incoming: join(input.incomingRoot, input.path),
    target: join(input.targetRoot, input.path)
  };
  const [baseline, incoming, target] = await Promise.all([
    readFile(paths.baseline),
    readFile(paths.incoming),
    readFile(paths.target)
  ]);
  if (containsNull(baseline) || containsNull(incoming) || containsNull(target)) {
    return null;
  }

  const alignedMerge = mergeAlignedText(baseline, target, incoming);
  if (alignedMerge) {
    return { clean: true, content: alignedMerge };
  }

  const result = await runGitMergeFile(paths.target, paths.baseline, paths.incoming);
  if (result.code === 0) {
    return { clean: true, content: result.stdout };
  }
  if (result.code === 1) {
    await writeConflictFile(join(input.conflictDir, input.path), result.stdout);
    return { clean: false, content: result.stdout };
  }
  throw new Error(`git merge-file failed for ${input.path}: ${result.stderr.trim() || `exit ${result.code}`}`);
}

async function runGitMergeFile(target: string, baseline: string, incoming: string): Promise<MergeFileResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [
      "merge-file",
      "-p",
      "-L",
      "current",
      "-L",
      "baseline",
      "-L",
      "incoming",
      target,
      baseline,
      incoming
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({
      code: code ?? 2,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

async function writeConflictFile(path: string, content: Buffer): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

function sameEntry(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "missing") {
    return true;
  }
  if (left.type === "symlink" && right.type === "symlink") {
    return left.target === right.target;
  }
  return left.type === "file"
    && right.type === "file"
    && left.hash === right.hash
    && left.mode === right.mode;
}

function describeEntry(entry: WorkspaceEntry): Record<string, unknown> {
  if (entry.type === "missing") {
    return { type: "missing" };
  }
  if (entry.type === "symlink") {
    return { type: "symlink", target: entry.target };
  }
  return { type: "file", hash: entry.hash, mode: entry.mode, size: entry.size };
}

function missingEntry(): MissingEntry {
  return { type: "missing" };
}

function hashBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function containsNull(content: Buffer): boolean {
  return content.includes(0);
}

function mergeAlignedText(baseline: Buffer, target: Buffer, incoming: Buffer): Buffer | null {
  const baselineLines = splitLines(baseline.toString("utf8"));
  const targetLines = splitLines(target.toString("utf8"));
  const incomingLines = splitLines(incoming.toString("utf8"));
  if (baselineLines.length !== targetLines.length || baselineLines.length !== incomingLines.length) {
    return null;
  }

  const merged: string[] = [];
  for (let index = 0; index < baselineLines.length; index += 1) {
    const baselineLine = baselineLines[index];
    const targetLine = targetLines[index];
    const incomingLine = incomingLines[index];
    if (targetLine === incomingLine) {
      merged.push(targetLine);
    } else if (targetLine === baselineLine) {
      merged.push(incomingLine);
    } else if (incomingLine === baselineLine) {
      merged.push(targetLine);
    } else {
      return null;
    }
  }
  return Buffer.from(merged.join(""), "utf8");
}

function splitLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function isWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}
