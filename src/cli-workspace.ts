import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { basename } from "node:path";
import { pathExists } from "./core/file-store.js";
import { listWorkspaceChoices, resolveWorkspacePath, resolveWorkspaceSelection, type WorkspaceChoice } from "./core/workspace.js";

export interface CliWorkspaceInput {
  appRoot: string;
  cwd: string;
  explicitWorkspace?: string | null;
  interactive?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export async function selectWorkspaceForCli(input: CliWorkspaceInput): Promise<string> {
  if (input.explicitWorkspace?.trim()) {
    const explicit = resolveWorkspacePath(input.cwd, input.explicitWorkspace);
    const stdin = input.stdin ?? process.stdin;
    const stdout = input.stdout ?? process.stdout;
    if (!(await pathExists(explicit)) && input.interactive !== false && shouldPromptForWorkspace(stdin, stdout)) {
      return promptForWorkspace({
        cwd: input.cwd,
        choices: await listWorkspaceChoices(input.appRoot),
        missingExplicitWorkspace: explicit,
        stdin: stdin as ReadStream,
        stdout: stdout as WriteStream
      });
    }
    return resolveWorkspaceSelection(input);
  }

  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const choices = await listWorkspaceChoices(input.appRoot);

  if (input.interactive === false || !shouldPromptForWorkspace(stdin, stdout)) {
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
  missingExplicitWorkspace?: string;
  stdin: ReadStream;
  stdout: WriteStream;
}): Promise<string> {
  if (input.missingExplicitWorkspace) {
    input.stdout.write(`Workspace does not exist: ${input.missingExplicitWorkspace}\n`);
  }

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
      return await promptForNewWorkspace(rl, input.cwd, input.missingExplicitWorkspace);
    }

    const answer = (await rl.question(`Workspace [1/${input.choices.length}, n]: `)).trim();
    if (!answer || answer === "1") {
      return input.choices[0]?.path ?? input.cwd;
    }

    const newWorkspaceMatch = answer.match(/^n(?:ew)?\s+(.+)$/i);
    if (newWorkspaceMatch?.[1]?.trim()) {
      return resolveWorkspacePath(input.cwd, newWorkspaceMatch[1].trim());
    }

    if (/^n(?:ew)?$/i.test(answer)) {
      return await promptForNewWorkspace(rl, input.cwd, input.missingExplicitWorkspace);
    }

    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= input.choices.length) {
      return input.choices[index - 1]?.path ?? input.cwd;
    }

    return resolveWorkspacePath(input.cwd, answer);
  } finally {
    rl.close();
  }
}

async function promptForNewWorkspace(
  rl: ReturnType<typeof createInterface>,
  cwd: string,
  defaultWorkspace?: string
): Promise<string> {
  const prompt = defaultWorkspace ? `Workspace path [${defaultWorkspace}]: ` : "Workspace path: ";
  const answer = (await rl.question(prompt)).trim();
  if (answer) {
    return resolveWorkspacePath(cwd, answer);
  }
  return defaultWorkspace ?? cwd;
}

function workspaceLabel(choice: WorkspaceChoice): string {
  const marker = choice.exists ? "" : " (will create)";
  return `${basename(choice.path) || choice.path}  ${choice.path}${marker}`;
}
