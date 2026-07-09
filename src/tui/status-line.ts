export interface StatusLineState {
  taskId: string;
  main?: string;
  judge?: string;
  actor?: string;
  critic?: string;
  workers?: Array<{
    label: string;
    status: string;
  }>;
}

export interface RuntimeWorkerStatus {
  state: string;
  phase: string;
  summary: string;
  native_session_id?: string;
}

export type FooterHelpMode = "chat" | "worker" | "native";

export function formatStatusLine(state: StatusLineState | null): string {
  if (!state) {
    return "idle";
  }

  const parts = [compactTaskId(state.taskId)];
  if (state.workers?.length) {
    parts.push(formatWorkerSummary(state.workers));
    return parts.join(" | ");
  }

  if (state.main) {
    parts.push(`main ${compactStatus(state.main)}`);
  }
  if (state.judge) {
    parts.push(`judge ${compactStatus(state.judge)}`);
  }
  if (state.actor) {
    parts.push(`actor ${compactStatus(state.actor)}`);
  }
  if (state.critic) {
    parts.push(`critic ${compactStatus(state.critic)}`);
  }

  return parts.join(" | ");
}

export function formatSelectedWorkerStatus(state: StatusLineState | null, selectedIndex: number): string {
  const worker = state?.workers?.[selectedIndex];
  if (!worker) {
    return "";
  }
  return `${compactWorkerLabel(worker.label)} ${compactStatus(worker.status)}`;
}

export function formatWorkerRuntimeStatus(status: RuntimeWorkerStatus): string {
  const native = status.native_session_id ? ` native:${compactNativeSessionId(status.native_session_id)}` : "";
  const detail = `${status.state}/${status.phase}${native}: ${status.summary.trim() || "no summary"}`;
  return detail.length > 96 ? `${detail.slice(0, 93)}...` : detail;
}

export function formatFooterHelp(mode: FooterHelpMode = "chat"): string {
  if (mode === "native") {
    return "wheel/Pg · ^] logs";
  }
  if (mode === "worker") {
    return "wheel/Pg · Tab worker · ^O attach · Esc chat";
  }
  return "^W logs · Tab worker · ^O attach";
}

function compactNativeSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...` : sessionId;
}

function formatWorkerSummary(workers: NonNullable<StatusLineState["workers"]>): string {
  const counts = new Map<string, number>();
  for (const worker of workers) {
    const state = compactStatus(worker.status);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  const priority = ["fail", "run", "wait", "done"];
  const orderedStates = [
    ...priority.filter((state) => counts.has(state)),
    ...Array.from(counts.keys()).filter((state) => !priority.includes(state)).sort()
  ];
  const summary = orderedStates.map((state) => `${state} ${counts.get(state)}`).join(" ");
  return `workers ${workers.length}${summary ? ` | ${summary}` : ""}`;
}

function compactStatus(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) {
    return "idle";
  }
  const state = trimmed.split(/[/: ]/, 1)[0]?.trim().toLowerCase();
  if (state === "running") {
    return "run";
  }
  if (state === "failed" || state === "error") {
    return "fail";
  }
  if (state === "waiting" || state === "queued") {
    return "wait";
  }
  return state || "idle";
}

function compactTaskId(taskId: string): string {
  const withoutPrefix = taskId.startsWith("task-") ? taskId.slice("task-".length) : taskId;
  const dated = withoutPrefix.match(/^\d{8}-(.+)$/);
  return dated?.[1] ?? withoutPrefix;
}

function compactWorkerLabel(label: string): string {
  const match = label.match(/^\s*([^(]+?)\s*\(([^)]+)\)\s*$/);
  if (match) {
    return `${match[1].trim().toLowerCase()}/${match[2].trim().toLowerCase()}`;
  }
  return label.trim().toLowerCase().replace(/\s+/g, "/");
}
