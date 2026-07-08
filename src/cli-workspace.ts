import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { basename, resolve } from "node:path";
import { listWorkspaceChoices, resolveWorkspaceSelection, type WorkspaceChoice } from "./core/workspace.js";

export interface CliWorkspaceInput {
  appRoot: string;
  cwd: string;
  explicitWorkspace?: string | null;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export async function selectWorkspaceForCli(input: CliWorkspaceInput): Promise<string> {
  if (input.explicitWorkspace?.trim()) {
    return resolveWorkspaceSelection(input);
  }

  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const choices = await listWorkspaceChoices(input.appRoot);

  if (!shouldPromptForWorkspace(stdin, stdout)) {
    return resolveWorkspaceSelection(input);
  }

  return promptForWorkspace({
    cwd: input.cwd,
    choices,
    stdin: stdin as ReadStream,
    stdout: stdout as WriteStream
  });
}

function shouldPromptForWorkspace(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

async function promptForWorkspace(input: {
  cwd: string;
  choices: WorkspaceChoice[];
  stdin: ReadStream;
  stdout: WriteStream;
}): Promise<string> {
  if (input.choices.length === 0) {
    input.stdout.write("No workspace selected yet.\n");
  } else {
    input.stdout.write("Select workspace:\n");
    for (const [index, choice] of input.choices.entries()) {
      input.stdout.write(`  ${index + 1}. ${workspaceLabel(choice)}\n`);
    }
    input.stdout.write("  n. Create/open another folder\n");
  }

  const rl = createInterface({ input: input.stdin, output: input.stdout });
  try {
    if (input.choices.length === 0) {
      return await promptForNewWorkspace(rl, input.cwd);
    }

    const answer = (await rl.question(`Workspace [1/${input.choices.length}, n]: `)).trim();
    if (!answer || answer === "1") {
      return input.choices[0]?.path ?? input.cwd;
    }

    const newWorkspaceMatch = answer.match(/^n(?:ew)?\s+(.+)$/i);
    if (newWorkspaceMatch?.[1]?.trim()) {
      return resolve(input.cwd, newWorkspaceMatch[1].trim());
    }

    if (/^n(?:ew)?$/i.test(answer)) {
      return await promptForNewWorkspace(rl, input.cwd);
    }

    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= input.choices.length) {
      return input.choices[index - 1]?.path ?? input.cwd;
    }

    return resolve(input.cwd, answer);
  } finally {
    rl.close();
  }
}

async function promptForNewWorkspace(rl: ReturnType<typeof createInterface>, cwd: string): Promise<string> {
  const answer = (await rl.question("Workspace path: ")).trim();
  return answer ? resolve(cwd, answer) : cwd;
}

function workspaceLabel(choice: WorkspaceChoice): string {
  const marker = choice.exists ? "" : " (will create)";
  return `${basename(choice.path) || choice.path}  ${choice.path}${marker}`;
}
