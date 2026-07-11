import { join } from "node:path";
import { readTextIfExists } from "../core/file-store.js";

export interface SummaryDirs {
  judgeDir: string;
  actorDir: string;
  criticDir: string;
  turnDir?: string;
  featureActorWorklogPath?: string;
  featureCriticFindingsPath?: string;
  changedPaths?: string[];
  verification?: string;
}

export async function buildSupervisorSummary(dirs: SummaryDirs): Promise<string> {
  const turnRequirements = dirs.turnDir ? await readTextIfExists(join(dirs.turnDir, "requirements.md")) : "";
  const requirements = turnRequirements.trim()
    ? turnRequirements
    : await readTextIfExists(join(dirs.judgeDir, "requirements.md"));
  const featureWorklog = dirs.featureActorWorklogPath
    ? await readTextIfExists(dirs.featureActorWorklogPath)
    : "";
  const worklog = featureWorklog.trim() ? featureWorklog : await readTextIfExists(join(dirs.actorDir, "worklog.md"));
  const review = await readTextIfExists(join(dirs.criticDir, "review.md"));
  const findings = dirs.featureCriticFindingsPath
    ? await readTextIfExists(dirs.featureCriticFindingsPath)
    : "";
  const changedFiles = changedFilesSummary(dirs.changedPaths ?? []);
  const verification = dirs.verification?.trim() || verificationEvidence(review);

  return [
    "Complex task completed.",
    "",
    "Requirements:",
    excerpt(requirements),
    "",
    "Actor work:",
    excerpt(worklog),
    "",
    "Changed files:",
    excerpt(changedFiles),
    "",
    "Critic review:",
    excerpt(review),
    "",
    "Verification:",
    excerpt(verification),
    "",
    "Critic findings:",
    excerpt(findings)
  ].join("\n");
}

function changedFilesSummary(paths: string[]): string {
  const unique = [...new Set(paths.map(sanitizeSummaryPath).filter(Boolean))].sort();
  if (unique.length === 0) {
    return "";
  }
  const visible = unique.slice(0, 50);
  return [
    ...visible.map((path) => `- ${path}`),
    ...(unique.length > visible.length ? [`- ... and ${unique.length - visible.length} more`] : [])
  ].join("\n");
}

function verificationEvidence(review: string): string {
  const lines = review.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const decision = lines
    .map(cleanReviewDecisionLine)
    .find((line) => /^(?:APPROVED|REVISION_REQUIRED|REJECTED|FAILED)\b/i.test(line));
  const evidence = lines.filter((line) => (
    !/^#{1,6}\s*(?:review|verification)\b/i.test(line)
    && !/^(?:verification|tests?)\s*:$/i.test(line)
    && /(?:`[^`]*(?:test|build|lint|typecheck|check)[^`]*`|\b(?:passed|verified|verification|tests?|build|lint|typecheck|smoke)\b)/i.test(line)
    && cleanReviewDecisionLine(line) !== decision
  ));
  const uniqueEvidence = [...new Set(evidence)].slice(0, 12);
  return [
    ...(decision ? [`Critic decision: ${decision.match(/^(?:APPROVED|REVISION_REQUIRED|REJECTED|FAILED)/i)?.[0]?.toUpperCase() ?? decision}`] : []),
    ...uniqueEvidence
  ].join("\n");
}

function cleanReviewDecisionLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\*\*([^*]+)\*\*$/, "$1")
    .trim();
}

function sanitizeSummaryPath(path: string): string {
  return path
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

function excerpt(text: string): string {
  const trimmed = escapeSupervisorSectionDelimiters(text).trim();
  if (!trimmed) {
    return "(empty)";
  }
  const codePoints = Array.from(trimmed);
  return codePoints.length > 800 ? `${codePoints.slice(0, 797).join("")}...` : trimmed;
}

function escapeSupervisorSectionDelimiters(text: string): string {
  return text.split(/\r?\n/).map((line) => (
    /^(?:Requirements|Actor work|Changed files|Critic review|Verification|Critic findings):\s*$/i.test(line.trim())
      ? `> ${line.trim()}`
      : line
  )).join("\n");
}
