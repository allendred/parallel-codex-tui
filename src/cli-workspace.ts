import { pathExists, pathIsDirectory } from "./core/file-store.js";
import { listWorkspaceChoices, resolveWorkspacePath, resolveWorkspaceSelection } from "./core/workspace.js";
import { promptForWorkspaceTui } from "./cli-workspace-picker.js";

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
    const explicitExists = await pathExists(explicit);
    const explicitIsDirectory = explicitExists && (await pathIsDirectory(explicit));
    if (!explicitIsDirectory && input.interactive !== false && shouldPromptForWorkspace(stdin, stdout)) {
      return promptForWorkspaceTui({
        cwd: input.cwd,
        choices: await listWorkspaceChoices(input.appRoot),
        invalidExplicitWorkspace: {
          path: explicit,
          reason: explicitExists ? "file" : "missing"
        },
        stdin,
        stdout
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

  return promptForWorkspaceTui({
    cwd: input.cwd,
    choices,
    stdin,
    stdout
  });
}

function shouldPromptForWorkspace(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}
