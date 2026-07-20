import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RouteDecision, TaskMeta } from "../domain/schemas.js";
import { RouteDecisionSchema, TurnMetaSchema } from "../domain/schemas.js";
import { loadCollaborationTimeline } from "./collaboration-timeline.js";
import { pathExists, readJson, readTextIfExists } from "./file-store.js";
import { loadTaskSessionDetails } from "./task-session-details.js";

export type TaskReportComparisonState =
  | "match"
  | "drift"
  | "missing"
  | "unexpected"
  | "unavailable";

export interface TaskReportEntry {
  type: "missing" | "file" | "symlink" | "other" | "unavailable";
  sha256?: string;
  mode?: number;
  size?: number;
  target?: string;
  detail?: string;
}

export interface TaskReportPathComparison {
  path: string;
  state: TaskReportComparisonState;
  source: {
    turn_id: string;
    wave: number;
    feature_ids: string[];
  };
  expected: TaskReportEntry;
  current: TaskReportEntry;
}

export interface TaskReportReconciliation {
  state: "clean" | "drifted" | "unavailable" | "no-integrations";
  integrated_waves: number;
  changed_paths: number;
  counts: Record<TaskReportComparisonState, number>;
  paths: TaskReportPathComparison[];
  issues: string[];
}

export interface TaskReportTurn {
  turn_id: string;
  created_at: string;
  request: string;
  route?: RouteDecision;
  requirements?: string;
  plan?: string;
  acceptance_criteria?: string;
  supervisor_summary?: string;
  feature_plan?: unknown;
  judge_validation?: unknown;
  completion_contract?: unknown;
  final_acceptance?: unknown;
  final_acceptance_validation?: unknown;
}

export interface TaskReport {
  format: "parallel-codex-task-report-v1";
  generated_at: string;
  task: TaskMeta;
  workspace: {
    path: string;
    reconciliation: TaskReportReconciliation;
  };
  turns: TaskReportTurn[];
  features: Array<{
    id: string;
    turn_id: string;
    title: string;
    description: string;
    depends_on: string[];
    state: string;
    updated_at: string;
    actor_engine?: string;
    actor_model?: string;
    critic_engine?: string;
    critic_model?: string;
    findings: number;
    replies: number;
    resolved_findings?: number;
    unresolved_findings?: number;
    latest_finding?: string;
    latest_reply?: string;
  }>;
  workers: Array<{
    id: string;
    turn_id: string;
    feature_id?: string;
    feature_title?: string;
    role: string;
    engine: string;
    model: string;
    model_provider?: string;
    state: string;
    phase: string;
    summary: string;
    last_activity_at: string;
    native_session?: {
      id: string;
      cwd: string;
      writable_dirs: string[];
      created_at: string;
      last_used_at: string;
      source: string;
    };
  }>;
  integrations: Array<{
    turn_id: string;
    wave: number;
    feature_ids: string[];
    changed_paths: string[];
    verification?: unknown;
    verification_review?: string;
  }>;
}

export interface BuildTaskReportInput {
  task: TaskMeta;
  taskDir: string;
  workspaceRoot: string;
  generatedAt: string;
}

interface IntegratedWave {
  turnId: string;
  wave: number;
  featureIds: string[];
  changedPaths: string[];
  rootDir: string;
  integrationDir: string;
}

export async function buildTaskReport(input: BuildTaskReportInput): Promise<{
  report: TaskReport;
  markdown: string;
}> {
  const taskSummary = {
    ...input.task,
    turnCount: 0,
    workerCount: 0,
    nativeSessionCount: 0
  };
  const [turns, timeline, details, integrations, reconciliation] = await Promise.all([
    readTaskReportTurns(input.taskDir),
    loadCollaborationTimeline(input.task.id, input.taskDir),
    loadTaskSessionDetails({ task: taskSummary, taskDir: input.taskDir }),
    readTaskReportIntegrations(input.taskDir),
    reconcileTaskWorkspace(input.taskDir, input.workspaceRoot)
  ]);
  const report: TaskReport = {
    format: "parallel-codex-task-report-v1",
    generated_at: input.generatedAt,
    task: input.task,
    workspace: {
      path: input.workspaceRoot,
      reconciliation
    },
    turns,
    features: timeline.features.map((feature) => ({
      id: feature.id,
      turn_id: feature.turnId,
      title: feature.title,
      description: feature.description,
      depends_on: feature.dependsOn,
      state: feature.state,
      updated_at: feature.updatedAt,
      ...(feature.actorEngine ? { actor_engine: feature.actorEngine } : {}),
      ...(feature.actorModel ? { actor_model: feature.actorModel } : {}),
      ...(feature.criticEngine ? { critic_engine: feature.criticEngine } : {}),
      ...(feature.criticModel ? { critic_model: feature.criticModel } : {}),
      findings: feature.findings,
      replies: feature.replies,
      ...(typeof feature.resolvedFindings === "number"
        ? { resolved_findings: feature.resolvedFindings }
        : {}),
      ...(typeof feature.unresolvedFindings === "number"
        ? { unresolved_findings: feature.unresolvedFindings }
        : {}),
      ...(feature.latestFinding ? { latest_finding: feature.latestFinding } : {}),
      ...(feature.latestReply ? { latest_reply: feature.latestReply } : {})
    })),
    workers: details.workers.map((worker) => ({
      id: worker.id,
      turn_id: worker.turnId,
      ...(worker.featureId ? { feature_id: worker.featureId } : {}),
      ...(worker.featureTitle ? { feature_title: worker.featureTitle } : {}),
      role: worker.role,
      engine: worker.engine,
      model: worker.model,
      ...(worker.modelProvider ? { model_provider: worker.modelProvider } : {}),
      state: worker.state,
      phase: worker.phase,
      summary: worker.summary,
      last_activity_at: worker.lastActivityAt,
      ...(worker.nativeSession ? {
        native_session: {
          id: worker.nativeSession.sessionId,
          cwd: worker.nativeSession.cwd,
          writable_dirs: worker.nativeSession.writableDirs,
          created_at: worker.nativeSession.createdAt,
          last_used_at: worker.nativeSession.lastUsedAt,
          source: worker.nativeSession.source
        }
      } : {})
    })),
    integrations
  };
  return { report, markdown: renderTaskReportMarkdown(report) };
}

export async function reconcileTaskWorkspace(
  taskDir: string,
  workspaceRoot: string
): Promise<TaskReportReconciliation> {
  const { waves, issues, sawIntegrationRecord } = await readIntegratedWaves(taskDir);
  const authoritative = new Map<string, IntegratedWave>();
  for (const wave of waves) {
    for (const changedPath of wave.changedPaths) {
      authoritative.set(changedPath, wave);
    }
  }
  const paths = await Promise.all([...authoritative.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([changedPath, wave]): Promise<TaskReportPathComparison> => {
      const expected = await inspectReportEntry(wave.integrationDir, changedPath);
      const current = await inspectReportEntry(workspaceRoot, changedPath);
      return {
        path: changedPath,
        state: compareTaskReportEntries(expected, current),
        source: {
          turn_id: wave.turnId,
          wave: wave.wave,
          feature_ids: wave.featureIds
        },
        expected,
        current
      };
    }));
  const counts = emptyComparisonCounts();
  for (const path of paths) {
    counts[path.state] += 1;
  }
  const state = paths.length === 0
    ? sawIntegrationRecord || issues.length > 0 ? "unavailable" : "no-integrations"
    : counts.unavailable > 0
      ? "unavailable"
      : counts.drift + counts.missing + counts.unexpected > 0
        ? "drifted"
        : "clean";
  return {
    state,
    integrated_waves: waves.length,
    changed_paths: paths.length,
    counts,
    paths,
    issues
  };
}

async function readTaskReportTurns(taskDir: string): Promise<TaskReportTurn[]> {
  const turnsRoot = join(taskDir, "turns");
  let entries;
  try {
    entries = await readdir(turnsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const turns = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map(async (entry): Promise<TaskReportTurn | null> => {
      const dir = join(turnsRoot, entry.name);
      try {
        const meta = await readJson(join(dir, "turn.json"), TurnMetaSchema);
        if (meta.turn_id !== entry.name) {
          return null;
        }
        const [
          request,
          route,
          requirements,
          plan,
          acceptanceCriteria,
          summary,
          featurePlan,
          judgeValidation,
          contract,
          acceptance,
          validation
        ] = await Promise.all([
          readTextIfExists(join(dir, "user.md")),
          readRouteDecision(join(dir, "route.json")),
          readTextIfExists(join(dir, "requirements.md")),
          readTextIfExists(join(dir, "plan.md")),
          readTextIfExists(join(dir, "acceptance.md")),
          readTextIfExists(join(dir, "supervisor-summary.md")),
          readOptionalJson(join(dir, "feature-plan.json")),
          readOptionalJson(join(dir, "judge-validation.json")),
          readOptionalJson(join(dir, "completion-contract.json")),
          readOptionalJson(join(dir, "final-acceptance.json")),
          readOptionalJson(join(dir, "final-acceptance-validation.json"))
        ]);
        return {
          turn_id: meta.turn_id,
          created_at: meta.created_at,
          request: request.trimEnd(),
          ...(route ? { route } : {}),
          ...(requirements.trim() ? { requirements: requirements.trimEnd() } : {}),
          ...(plan.trim() ? { plan: plan.trimEnd() } : {}),
          ...(acceptanceCriteria.trim() ? { acceptance_criteria: acceptanceCriteria.trimEnd() } : {}),
          ...(summary.trim() ? { supervisor_summary: summary.trimEnd() } : {}),
          ...(featurePlan !== undefined ? { feature_plan: featurePlan } : {}),
          ...(judgeValidation !== undefined ? { judge_validation: judgeValidation } : {}),
          ...(contract !== undefined ? { completion_contract: contract } : {}),
          ...(acceptance !== undefined ? { final_acceptance: acceptance } : {}),
          ...(validation !== undefined ? { final_acceptance_validation: validation } : {})
        };
      } catch {
        return null;
      }
    }));
  return turns
    .filter((turn): turn is TaskReportTurn => turn !== null)
    .sort((left, right) => left.turn_id.localeCompare(right.turn_id));
}

async function readTaskReportIntegrations(taskDir: string): Promise<TaskReport["integrations"]> {
  const { waves } = await readIntegratedWaves(taskDir);
  return Promise.all(waves.map(async (wave) => {
    const [verification, verificationReview] = await Promise.all([
      readOptionalJson(join(wave.rootDir, "verification.json")),
      readTextIfExists(join(wave.rootDir, "verification-review.md"))
    ]);
    return {
      turn_id: wave.turnId,
      wave: wave.wave,
      feature_ids: wave.featureIds,
      changed_paths: wave.changedPaths,
      ...(verification !== undefined ? { verification } : {}),
      ...(verificationReview.trim() ? { verification_review: verificationReview.trimEnd() } : {})
    };
  }));
}

async function readRouteDecision(path: string): Promise<RouteDecision | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  try {
    return await readJson(path, RouteDecisionSchema);
  } catch {
    return undefined;
  }
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  try {
    return JSON.parse(await readTextIfExists(path)) as unknown;
  } catch {
    return undefined;
  }
}

async function readIntegratedWaves(taskDir: string): Promise<{
  waves: IntegratedWave[];
  issues: string[];
  sawIntegrationRecord: boolean;
}> {
  const workspacesRoot = join(taskDir, "workspaces");
  const waves: IntegratedWave[] = [];
  const issues: string[] = [];
  let sawIntegrationRecord = false;
  let turnEntries;
  try {
    turnEntries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch {
    return { waves, issues, sawIntegrationRecord };
  }
  for (const turnEntry of turnEntries
    .filter((entry) => entry.isDirectory() && /^turn-\d{4,}$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const turnId = turnEntry.name.slice("turn-".length);
    const turnRoot = join(workspacesRoot, turnEntry.name);
    let waveEntries;
    try {
      waveEntries = await readdir(turnRoot, { withFileTypes: true });
    } catch (error) {
      issues.push(`${turnEntry.name}: ${errorMessage(error)}`);
      continue;
    }
    for (const waveEntry of waveEntries
      .filter((entry) => entry.isDirectory() && /^wave-\d{4,}$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(turnRoot, waveEntry.name, "integration.json");
      if (!(await pathExists(path))) {
        continue;
      }
      sawIntegrationRecord = true;
      const value = await readOptionalJson(path);
      if (!isRecord(value)) {
        issues.push(`${turnEntry.name}/${waveEntry.name}: malformed integration.json`);
        continue;
      }
      if (value.state !== "integrated") {
        continue;
      }
      const wave = Number(value.wave);
      const featureIds = stringArray(value.feature_ids);
      const changedPaths = stringArray(value.changed_paths);
      if (!Number.isInteger(wave) || wave < 1 || !featureIds || !changedPaths) {
        issues.push(`${turnEntry.name}/${waveEntry.name}: invalid integrated checkpoint`);
        continue;
      }
      waves.push({
        turnId: typeof value.turn_id === "string" ? value.turn_id : turnId,
        wave,
        featureIds,
        changedPaths,
        rootDir: join(turnRoot, waveEntry.name),
        integrationDir: join(turnRoot, waveEntry.name, "integration")
      });
    }
  }
  waves.sort((left, right) => (
    left.turnId.localeCompare(right.turnId)
    || left.wave - right.wave
  ));
  return { waves, issues, sawIntegrationRecord };
}

async function inspectReportEntry(root: string, changedPath: string): Promise<TaskReportEntry> {
  const safe = safeWorkspacePath(root, changedPath);
  if (!safe) {
    return { type: "unavailable", detail: "unsafe relative path" };
  }
  const segments = relative(resolve(root), safe).split(sep);
  let parent = resolve(root);
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const stat = await lstat(parent);
      if (stat.isSymbolicLink()) {
        return { type: "unavailable", detail: "parent path is a symbolic link" };
      }
      if (!stat.isDirectory()) {
        return { type: "missing" };
      }
    } catch (error) {
      if (isMissingError(error)) {
        return { type: "missing" };
      }
      return { type: "unavailable", detail: errorMessage(error) };
    }
  }
  try {
    const stat = await lstat(safe);
    if (stat.isSymbolicLink()) {
      return { type: "symlink", target: await readlink(safe) };
    }
    if (stat.isFile()) {
      const content = await readFile(safe);
      return {
        type: "file",
        sha256: createHash("sha256").update(content).digest("hex"),
        mode: stat.mode & 0o777,
        size: stat.size
      };
    }
    return { type: "other", detail: stat.isDirectory() ? "directory" : "special entry" };
  } catch (error) {
    return isMissingError(error)
      ? { type: "missing" }
      : { type: "unavailable", detail: errorMessage(error) };
  }
}

function safeWorkspacePath(root: string, changedPath: string): string | null {
  if (!changedPath || changedPath.includes("\0") || isAbsolute(changedPath)) {
    return null;
  }
  const base = resolve(root);
  const candidate = resolve(base, changedPath);
  const relativePath = relative(base, candidate);
  return relativePath
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? candidate
    : null;
}

function compareTaskReportEntries(
  expected: TaskReportEntry,
  current: TaskReportEntry
): TaskReportComparisonState {
  if (expected.type === "unavailable" || current.type === "unavailable") {
    return "unavailable";
  }
  if (expected.type === "missing") {
    return current.type === "missing" ? "match" : "unexpected";
  }
  if (current.type === "missing") {
    return "missing";
  }
  if (expected.type !== current.type) {
    return "drift";
  }
  if (expected.type === "file" && current.type === "file") {
    return expected.sha256 === current.sha256 && expected.mode === current.mode ? "match" : "drift";
  }
  if (expected.type === "symlink" && current.type === "symlink") {
    return expected.target === current.target ? "match" : "drift";
  }
  return expected.detail === current.detail ? "match" : "drift";
}

function emptyComparisonCounts(): Record<TaskReportComparisonState, number> {
  return { match: 0, drift: 0, missing: 0, unexpected: 0, unavailable: 0 };
}

function renderTaskReportMarkdown(report: TaskReport): string {
  const lines = [
    `# Task Report: ${escapeMarkdownText(report.task.title)}`,
    "",
    `- Task: \`${escapeCode(report.task.id)}\``,
    `- Status: \`${report.task.status}\``,
    `- Mode: \`${report.task.mode}\``,
    `- Created: ${report.task.created_at}`,
    `- Generated: ${report.generated_at}`,
    `- Workspace: \`${escapeCode(report.workspace.path)}\``,
    "",
    "## Workspace Reconciliation",
    "",
    `State: **${report.workspace.reconciliation.state}**. `
      + `${report.workspace.reconciliation.integrated_waves} integrated wave(s), `
      + `${report.workspace.reconciliation.changed_paths} changed path(s).`,
    ""
  ];
  if (report.workspace.reconciliation.paths.length > 0) {
    lines.push(
      "| State | Path | Source | Expected | Current |",
      "| --- | --- | --- | --- | --- |",
      ...report.workspace.reconciliation.paths.map((entry) => (
        `| ${entry.state} | \`${escapeCode(entry.path)}\` | turn ${entry.source.turn_id}, wave ${entry.source.wave} | `
        + `${describeReportEntry(entry.expected)} | ${describeReportEntry(entry.current)} |`
      )),
      ""
    );
  }
  if (report.workspace.reconciliation.issues.length > 0) {
    lines.push(
      "### Reconciliation Issues",
      "",
      ...report.workspace.reconciliation.issues.map((issue) => `- ${escapeMarkdownText(issue)}`),
      ""
    );
  }
  lines.push("## Turns", "");
  if (report.turns.length === 0) {
    lines.push("No valid turn records were found.", "");
  }
  for (const turn of report.turns) {
    lines.push(
      `### Turn ${turn.turn_id}`,
      "",
      `- Created: ${turn.created_at}`,
      ...(turn.route ? [
        `- Route: \`${turn.route.mode}\` via \`${turn.route.source ?? "configured"}\``,
        `- Reason: ${escapeMarkdownText(turn.route.reason)}`
      ] : []),
      "",
      "**Request**",
      "",
      ...(turn.request ? quoteMarkdown(turn.request) : ["> (empty)" ]),
      ""
    );
    if (turn.supervisor_summary) {
      lines.push("**Supervisor summary**", "", turn.supervisor_summary, "");
    }
    for (const [label, value] of [
      ["Requirements", turn.requirements],
      ["Plan", turn.plan],
      ["Acceptance criteria", turn.acceptance_criteria]
    ] as const) {
      if (value) {
        lines.push(`**${label}**`, "", value, "");
      }
    }
    for (const [label, value] of [
      ["Feature plan", turn.feature_plan],
      ["Judge validation", turn.judge_validation],
      ["Completion contract", turn.completion_contract],
      ["Final acceptance", turn.final_acceptance],
      ["Final acceptance validation", turn.final_acceptance_validation]
    ] as const) {
      if (value !== undefined) {
        lines.push(`**${label}**`, "", fencedJson(value), "");
      }
    }
  }
  lines.push("## Features", "");
  if (report.features.length === 0) {
    lines.push("No Feature records were found.", "");
  } else {
    lines.push(
      "| State | Turn | Feature | Actor | Critic | Findings | Replies | Latest review evidence |",
      "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
      ...report.features.map((feature) => (
        `| ${feature.state} | ${feature.turn_id} | ${escapeTableText(feature.title)} (\`${escapeCode(feature.id)}\`) | `
        + `${escapeTableText(workerAssignment(feature.actor_engine, feature.actor_model))} | `
        + `${escapeTableText(workerAssignment(feature.critic_engine, feature.critic_model))} | `
        + `${feature.findings} | ${feature.replies} | `
        + `${escapeTableText(feature.latest_finding ?? feature.latest_reply ?? "-")} |`
      )),
      ""
    );
  }
  lines.push("## Integration And Verification", "");
  if (report.integrations.length === 0) {
    lines.push("No integrated Wave records were found.", "");
  }
  for (const integration of report.integrations) {
    lines.push(
      `### Turn ${integration.turn_id}, Wave ${integration.wave}`,
      "",
      `- Features: ${integration.feature_ids.map((id) => `\`${escapeCode(id)}\``).join(", ") || "none"}`,
      `- Changed paths: ${integration.changed_paths.length}`,
      ...integration.changed_paths.map((path) => `  - \`${escapeCode(path)}\``),
      ""
    );
    if (integration.verification_review) {
      lines.push("**Verification review**", "", integration.verification_review, "");
    }
    if (integration.verification !== undefined) {
      lines.push("**Verification evidence**", "", fencedJson(integration.verification), "");
    }
  }
  lines.push("## Workers", "");
  if (report.workers.length === 0) {
    lines.push("No Worker records were found.", "");
  } else {
    lines.push(
      "| State | Turn | Role | Engine / model | Feature | Native session | Worker | Summary |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...report.workers.map((worker) => (
        `| ${worker.state} | ${worker.turn_id} | ${worker.role} | `
        + `${escapeTableText(workerAssignment(worker.engine, worker.model, worker.model_provider))} | `
        + `${escapeTableText(worker.feature_title ?? worker.feature_id ?? "-")} | `
        + `${escapeTableText(worker.native_session?.id ?? "-")} | \`${escapeCode(worker.id)}\` | `
        + `${escapeTableText(worker.summary || "-")} |`
      )),
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function quoteMarkdown(value: string): string[] {
  return value.split(/\r?\n/).map((line) => `> ${line}`);
}

function fencedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const longestRun = Math.max(0, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${json}\n${fence}`;
}

function describeReportEntry(entry: TaskReportEntry): string {
  if (entry.type === "file") {
    return `file ${entry.sha256?.slice(0, 12) ?? "?"} mode ${entry.mode?.toString(8) ?? "?"}`;
  }
  if (entry.type === "symlink") {
    return `symlink \`${escapeCode(entry.target ?? "") }\``;
  }
  return entry.detail ? `${entry.type}: ${escapeTableText(entry.detail)}` : entry.type;
}

function workerAssignment(engine?: string, model?: string, provider?: string): string {
  if (!engine) {
    return "-";
  }
  const configured = [provider, model].filter(Boolean).join("/");
  return configured ? `${engine} (${configured})` : engine;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&").replace(/\r?\n/g, " ");
}

function escapeTableText(value: string): string {
  return escapeMarkdownText(value).replace(/\r?\n/g, " ");
}

function escapeCode(value: string): string {
  return value.replaceAll("`", "\\`").replace(/\r?\n/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? [...value]
    : null;
}

function isMissingError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
