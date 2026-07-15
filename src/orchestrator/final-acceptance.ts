import { z } from "zod";

const FinalAcceptanceItemSchema = z.object({
  criterion_id: z.string().regex(/^A-\d{1,4}$/),
  status: z.enum(["passed", "failed"]),
  evidence: z.string().trim().min(1).max(4000)
}).strict();

export const FinalJudgeAcceptanceSchema = z.object({
  version: z.literal(1),
  decision: z.enum(["approved", "rejected"]),
  summary: z.string().trim().min(1).max(4000),
  acceptance: z.array(FinalAcceptanceItemSchema).min(1).max(100),
  changed_paths: z.array(z.string().trim().min(1).max(1000)).max(10000)
}).strict();

export type FinalJudgeAcceptance = z.infer<typeof FinalJudgeAcceptanceSchema>;

export interface FinalJudgeValidationReport {
  version: 1;
  state: "valid" | "invalid";
  decision: "approved" | "rejected" | "unknown";
  issues: string[];
}

export function validateFinalJudgeAcceptance(
  input: unknown,
  expectedCriterionIds: string[],
  expectedChangedPaths: string[]
): { acceptance: FinalJudgeAcceptance | null; report: FinalJudgeValidationReport } {
  const parsed = FinalJudgeAcceptanceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      acceptance: null,
      report: {
        version: 1,
        state: "invalid",
        decision: "unknown",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      }
    };
  }

  const acceptance = parsed.data;
  const issues: string[] = [];
  const actualIds = acceptance.acceptance.map((item) => item.criterion_id);
  const duplicateIds = repeated(actualIds);
  if (duplicateIds.length > 0) {
    issues.push(`duplicate acceptance criteria: ${duplicateIds.join(", ")}`);
  }
  const expectedIds = [...new Set(expectedCriterionIds)].sort();
  const uniqueActualIds = [...new Set(actualIds)].sort();
  const missingIds = expectedIds.filter((id) => !uniqueActualIds.includes(id));
  const unknownIds = uniqueActualIds.filter((id) => !expectedIds.includes(id));
  if (missingIds.length > 0) {
    issues.push(`missing acceptance criteria: ${missingIds.join(", ")}`);
  }
  if (unknownIds.length > 0) {
    issues.push(`unknown acceptance criteria: ${unknownIds.join(", ")}`);
  }

  const failedIds = acceptance.acceptance
    .filter((item) => item.status === "failed")
    .map((item) => item.criterion_id);
  if (acceptance.decision === "approved" && failedIds.length > 0) {
    issues.push(`approved decision contains failed criteria: ${failedIds.join(", ")}`);
  }
  if (acceptance.decision === "rejected" && failedIds.length === 0) {
    issues.push("rejected decision must identify at least one failed criterion");
  }

  const expectedPaths = [...new Set(expectedChangedPaths)].sort();
  const actualPaths = [...new Set(acceptance.changed_paths)].sort();
  if (acceptance.changed_paths.length !== actualPaths.length) {
    issues.push(`duplicate changed paths: ${repeated(acceptance.changed_paths).join(", ")}`);
  }
  const missingPaths = expectedPaths.filter((path) => !actualPaths.includes(path));
  const unknownPaths = actualPaths.filter((path) => !expectedPaths.includes(path));
  if (missingPaths.length > 0) {
    issues.push(`missing changed paths: ${missingPaths.join(", ")}`);
  }
  if (unknownPaths.length > 0) {
    issues.push(`unknown changed paths: ${unknownPaths.join(", ")}`);
  }

  return {
    acceptance,
    report: {
      version: 1,
      state: issues.length === 0 ? "valid" : "invalid",
      decision: acceptance.decision,
      issues
    }
  };
}

function repeated(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}
