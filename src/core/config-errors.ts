import { ZodError } from "zod";

export function formatConfigErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => ({
        message: issue.message,
        path: issue.path.map(String).join(".") || "config"
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n");
  }

  return error instanceof Error ? error.message : String(error);
}
