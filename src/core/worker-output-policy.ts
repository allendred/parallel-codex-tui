export type WorkerOutputProfile = "codex" | "claude" | "generic";

export function workerBuffersOutputUntilCompletion(
  profile: WorkerOutputProfile,
  args: readonly string[]
): boolean {
  if (profile !== "claude" || !args.some((arg) => arg === "--print" || arg === "-p")) {
    return false;
  }

  const outputFormat = readOptionValue(args, "--output-format");
  return outputFormat === undefined || outputFormat === "text" || outputFormat === "json";
}

function readOptionValue(args: readonly string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === option) {
      return args[index + 1]?.trim().toLowerCase();
    }
    if (arg?.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1).trim().toLowerCase();
    }
  }
  return undefined;
}
