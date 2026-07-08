#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { ZodError } from "zod";
import { parseCliArgs, validateCliArgs } from "./cli-args.js";
import { selectWorkspaceForCli } from "./cli-workspace.js";
import { createRuntime } from "./bootstrap.js";
import { configPath, writeDefaultConfig } from "./core/config.js";
import { pathExists } from "./core/file-store.js";
import { runDoctor } from "./doctor.js";
import { App } from "./tui/App.js";
import { version } from "./version.js";

const helpText = `Usage: parallel-codex-tui [options]

Options:
  -w, --workspace <path>  Project workspace for worker sessions and edits
      --app-root <path>   App root for configuration lookup
  -t, --task <id>         Open an existing task session
      --init              Write .parallel-codex/config.toml if missing
      --doctor            Check local configuration and agent commands
  -v, --version           Print the current version
  -h, --help              Print this help message

Options with values also accept --name=value and -x=value forms.`;

main().catch((error) => {
  process.stderr.write(`${formatStartupError(error)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const cliArgErrors = validateCliArgs(rawArgs);
  if (cliArgErrors.length > 0) {
    process.stderr.write(`${cliArgErrors.join("\n")}\n`);
    process.exit(1);
  }

  const cliArgs = parseCliArgs(rawArgs, process.cwd());
  const localConfigPath = configPath(cliArgs.appRoot);

  if (cliArgs.help) {
    console.log(helpText);
  } else if (cliArgs.version) {
    console.log(`parallel-codex-tui ${version}`);
  } else if (cliArgs.doctor) {
    const workspaceRoot = await selectWorkspaceForCli({
      appRoot: cliArgs.appRoot,
      cwd: process.cwd(),
      explicitWorkspace: cliArgs.explicitWorkspace,
      interactive: false
    });
    const result = await runDoctor(cliArgs.appRoot, workspaceRoot);
    process.stdout.write(result.text);
    process.exitCode = result.ok ? 0 : 1;
  } else if (cliArgs.init) {
    if (await pathExists(localConfigPath)) {
      console.log(`Config already exists: ${localConfigPath}`);
    } else {
      await writeDefaultConfig(cliArgs.appRoot);
      console.log(`Wrote ${localConfigPath}`);
    }
  } else {
    const workspaceRoot = await selectWorkspaceForCli({
      appRoot: cliArgs.appRoot,
      cwd: process.cwd(),
      explicitWorkspace: cliArgs.explicitWorkspace
    });
    const runtime = await createRuntime(cliArgs.appRoot, workspaceRoot);
    if (cliArgs.taskId && !(await runtime.sessions.hasTask(cliArgs.taskId))) {
      throw new Error(`Task session not found in workspace ${runtime.workspaceRoot}: ${cliArgs.taskId}`);
    }
    const latestTask = await runtime.sessions.latestTask();
    const initialTaskId = cliArgs.taskId ?? latestTask?.id ?? null;

    render(
      <App
        config={runtime.config}
        orchestrator={runtime.orchestrator}
        cwd={runtime.workspaceRoot}
        initialTaskId={initialTaskId}
      />,
      { exitOnCtrlC: false }
    );
  }
}

function formatStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isConfigStartupError(error)) {
    return `Config error: ${message}\nRun parallel-codex-tui --doctor for details.`;
  }
  return `Startup error: ${message}`;
}

function isConfigStartupError(error: unknown): boolean {
  if (error instanceof ZodError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.startsWith("Invalid config section ") ||
    error.name.toLowerCase().includes("toml") ||
    error.message.toLowerCase().includes("toml")
  );
}
