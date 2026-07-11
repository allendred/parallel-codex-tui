export type TaskResultOutcome = "approved" | "revision-required" | "completed";

export interface TaskResultSections {
  requirements: string;
  implementation: string;
  review: string;
  findings: string;
}

export interface TaskResultSummary {
  outcome: TaskResultOutcome;
  sections: TaskResultSections;
}

export interface TaskResultMessage {
  from: "user" | "system";
  text: string;
  taskId?: string;
}

const RESULT_SECTIONS = [
  { key: "requirements", heading: "Requirements:", redundantHeading: /^(?:requirements|scope)$/i },
  { key: "implementation", heading: "Actor work:", redundantHeading: /^(?:actor work|worklog|implementation)$/i },
  { key: "review", heading: "Critic review:", redundantHeading: /^(?:critic review|review)$/i },
  { key: "findings", heading: "Critic findings:", redundantHeading: /^(?:critic findings|findings)$/i }
] as const;

export function parseTaskResultSummary(text: string): TaskResultSummary | null {
  const lines = text.split(/\r?\n/);
  if (!/^Complex task completed\.$/i.test((lines[0] ?? "").trim())) {
    return null;
  }

  const indexes = RESULT_SECTIONS.map((section) => (
    lines.findIndex((line) => line.trim().toLowerCase() === section.heading.toLowerCase())
  ));
  if (indexes.every((index) => index < 0)) {
    return null;
  }

  const values = RESULT_SECTIONS.map((section, sectionIndex) => {
    const start = indexes[sectionIndex] ?? -1;
    if (start < 0) {
      return "";
    }
    const end = indexes
      .slice(sectionIndex + 1)
      .filter((index) => index > start)
      .reduce((minimum, index) => Math.min(minimum, index), lines.length);
    return normalizeTaskResultSection(lines.slice(start + 1, end), section.redundantHeading);
  });
  const sections: TaskResultSections = {
    requirements: values[0] ?? "",
    implementation: values[1] ?? "",
    review: values[2] ?? "",
    findings: values[3] ?? ""
  };

  return {
    outcome: taskResultOutcome(sections.review),
    sections
  };
}

export function latestTaskResultMessageIndex(
  messages: readonly TaskResultMessage[],
  taskId?: string | null
): number {
  if (taskId) {
    const scoped = findTaskResultMessageIndex(messages, (message) => message.taskId === taskId);
    if (scoped >= 0) {
      return scoped;
    }
    return findTaskResultMessageIndex(messages, (message) => message.taskId === undefined);
  }
  return findTaskResultMessageIndex(messages, () => true);
}

function findTaskResultMessageIndex(
  messages: readonly TaskResultMessage[],
  matchesScope: (message: TaskResultMessage) => boolean
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.from === "system"
      && matchesScope(message)
      && parseTaskResultSummary(message.text)
    ) {
      return index;
    }
  }
  return -1;
}

function normalizeTaskResultSection(lines: string[], redundantHeading: RegExp): string {
  const normalized = lines
    .map(sanitizeTaskResultLine)
    .filter((line, index, all) => !isRedundantTaskResultHeading(line, redundantHeading, index, all));

  while (normalized[0]?.trim() === "") {
    normalized.shift();
  }
  while (normalized.at(-1)?.trim() === "") {
    normalized.pop();
  }

  const value = normalized.join("\n").trim();
  return /^\(empty\)$/i.test(value) ? "" : value;
}

function sanitizeTaskResultLine(line: string): string {
  return line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trimEnd();
}

function isRedundantTaskResultHeading(
  line: string,
  redundantHeading: RegExp,
  index: number,
  all: string[]
): boolean {
  const heading = line.trim().replace(/^#{1,6}\s+/, "").replace(/:$/, "");
  if (!redundantHeading.test(heading)) {
    return false;
  }
  return all.slice(0, index).every((previous) => previous.trim() === "");
}

function taskResultOutcome(review: string): TaskResultOutcome {
  for (const line of review.split(/\r?\n/)) {
    const decision = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/^\*\*([^*]+)\*\*$/, "$1")
      .trim();
    if (/^(?:REVISION_REQUIRED|REJECTED|FAILED)\b/i.test(decision)) {
      return "revision-required";
    }
    if (/^APPROVED\b/i.test(decision)) {
      return "approved";
    }
  }
  return "completed";
}
