export const TASK_SEARCH_FIELDS = [
  "task",
  "turn",
  "feature",
  "role",
  "provider",
  "model",
  "state"
] as const;

export type TaskSearchField = (typeof TASK_SEARCH_FIELDS)[number];

export interface TaskSearchTerm {
  field: TaskSearchField | "any";
  value: string;
}

export interface TaskSearchDocument {
  task: {
    id: string;
    title: string;
    cwd: string;
    mode: string;
    state: string;
  };
  turns: Array<{
    turnId: string;
    request: string;
  }>;
  workers: Array<{
    id: string;
    featureId: string;
    featureTitle: string;
    role: string;
    provider: string;
    model: string;
    modelProvider: string;
    state: string;
    phase: string;
    summary: string;
  }>;
  nativeSessions: Array<{
    sessionId: string;
    provider: string;
  }>;
}

export interface TaskSearchMatch {
  fields: TaskSearchField[];
  summary: string;
}

interface SearchCandidate {
  field: TaskSearchField | "any";
  value: string;
  summary: string;
}

const TASK_SEARCH_FIELD_SET = new Set<string>(TASK_SEARCH_FIELDS);

export function parseTaskSearchQuery(query: string): TaskSearchTerm[] {
  return tokenizeTaskSearchQuery(query)
    .map((token): TaskSearchTerm | null => {
      const separator = token.indexOf(":");
      if (separator > 0) {
        const field = normalizeTaskSearchValue(token.slice(0, separator));
        const value = normalizeTaskSearchValue(token.slice(separator + 1));
        if (TASK_SEARCH_FIELD_SET.has(field) && value) {
          return { field: field as TaskSearchField, value };
        }
      }
      const value = normalizeTaskSearchValue(token);
      return value ? { field: "any", value } : null;
    })
    .filter((term): term is TaskSearchTerm => term !== null);
}

export function matchTaskSearchDocument(
  query: string | readonly TaskSearchTerm[],
  document: TaskSearchDocument
): TaskSearchMatch | null {
  const terms = typeof query === "string" ? parseTaskSearchQuery(query) : [...query];
  if (terms.length === 0) {
    return { fields: [], summary: "" };
  }
  const candidates = taskSearchCandidates(document);
  const matches: SearchCandidate[] = [];
  for (const term of terms) {
    const match = candidates.find((candidate) => (
      (term.field === "any" || candidate.field === term.field)
      && normalizeTaskSearchValue(candidate.value).includes(term.value)
    ));
    if (!match) {
      return null;
    }
    matches.push(match);
  }

  const fields = [...new Set(matches
    .map((match) => match.field)
    .filter((field): field is TaskSearchField => field !== "any"))];
  const summaries = [...new Set(matches.map((match) => match.summary).filter(Boolean))].slice(0, 2);
  return {
    fields,
    summary: summaries.length > 0 ? `match · ${summaries.join(" · ")}` : "match"
  };
}

function taskSearchCandidates(document: TaskSearchDocument): SearchCandidate[] {
  const candidates: SearchCandidate[] = [
    candidate("task", document.task.id, `task ${compactSearchEvidence(document.task.id)}`),
    candidate("task", document.task.title, `task ${compactSearchEvidence(document.task.title)}`),
    candidate("task", document.task.cwd, `task ${compactSearchEvidence(document.task.cwd)}`),
    candidate("task", document.task.mode, `task ${compactSearchEvidence(document.task.mode)}`),
    candidate("state", document.task.state, `state ${compactSearchEvidence(document.task.state)}`)
  ];

  for (const turn of document.turns) {
    const label = numericTurnLabel(turn.turnId);
    candidates.push(candidate("turn", turn.turnId, label));
    candidates.push(candidate("turn", String(Number(turn.turnId)), label));
    if (turn.request.trim()) {
      candidates.push(candidate(
        "turn",
        turn.request,
        `${label} ${compactSearchEvidence(turn.request, 72)}`
      ));
    }
  }

  for (const worker of document.workers) {
    if (worker.featureId) {
      candidates.push(candidate(
        "feature",
        worker.featureId,
        `feature ${compactSearchEvidence(worker.featureTitle || worker.featureId)}`
      ));
    }
    if (worker.featureTitle) {
      candidates.push(candidate(
        "feature",
        worker.featureTitle,
        `feature ${compactSearchEvidence(worker.featureTitle)}`
      ));
    }
    candidates.push(candidate("role", worker.role, `role ${compactSearchEvidence(worker.role)}`));
    candidates.push(candidate("provider", worker.provider, `provider ${compactSearchEvidence(worker.provider)}`));
    if (worker.modelProvider) {
      candidates.push(candidate(
        "provider",
        worker.modelProvider,
        `provider ${compactSearchEvidence(worker.modelProvider)}`
      ));
    }
    if (worker.model) {
      candidates.push(candidate("model", worker.model, `model ${compactSearchEvidence(worker.model)}`));
    }
    candidates.push(candidate("state", worker.state, `state ${compactSearchEvidence(worker.state)}`));
    candidates.push(candidate("any", worker.id, `worker ${compactSearchEvidence(worker.id)}`));
    candidates.push(candidate("any", worker.phase, `phase ${compactSearchEvidence(worker.phase)}`));
    if (worker.summary) {
      candidates.push(candidate("any", worker.summary, `worker ${compactSearchEvidence(worker.summary, 72)}`));
    }
  }

  for (const session of document.nativeSessions) {
    candidates.push(candidate("any", session.sessionId, `session ${compactSearchEvidence(session.sessionId)}`));
    candidates.push(candidate("provider", session.provider, `provider ${compactSearchEvidence(session.provider)}`));
  }
  return candidates.filter((item) => item.value.trim());
}

function candidate(field: TaskSearchField | "any", value: string, summary: string): SearchCandidate {
  return { field, value, summary };
}

function tokenizeTaskSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of Array.from(query).slice(0, 1000)) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/u.test(character) && !quoted) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeTaskSearchValue(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function numericTurnLabel(turnId: string): string {
  const numeric = Number(turnId);
  return `turn ${Number.isInteger(numeric) ? numeric : compactSearchEvidence(turnId)}`;
}

function compactSearchEvidence(value: string, maxLength = 48): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(clean);
  return points.length > maxLength
    ? `${points.slice(0, Math.max(1, maxLength - 3)).join("")}...`
    : clean;
}
