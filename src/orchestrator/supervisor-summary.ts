import { join } from "node:path";
import { readTextIfExists } from "../core/file-store.js";

export interface SummaryDirs {
  judgeDir: string;
  actorDir: string;
  criticDir: string;
  turnDir?: string;
  featureActorWorklogPath?: string;
  featureCriticFindingsPath?: string;
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

  return [
    "Complex task completed.",
    "",
    "Requirements:",
    excerpt(requirements),
    "",
    "Actor work:",
    excerpt(worklog),
    "",
    "Critic review:",
    excerpt(review),
    "",
    "Critic findings:",
    excerpt(findings)
  ].join("\n");
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(empty)";
  }
  return trimmed.length > 800 ? `${trimmed.slice(0, 797)}...` : trimmed;
}
