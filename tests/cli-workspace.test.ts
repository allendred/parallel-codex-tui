import { PassThrough, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectWorkspaceForCli } from "../src/cli-workspace.js";
import { writeText } from "../src/core/file-store.js";
import { prepareWorkspace } from "../src/core/workspace.js";

describe("selectWorkspaceForCli", () => {
  it("returns explicit workspaces without prompting", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-explicit-"));
    const workspace = join(appRoot, "game");
    await prepareWorkspace(appRoot, workspace);
    const stdin = fakeInput("");
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        explicitWorkspace: workspace,
        stdin,
        stdout
      })
    ).resolves.toBe(workspace);
    expect(stdout.output()).toBe("");
  });

  it("uses a missing explicit workspace as the default create target when remembered projects exist", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-missing-explicit-"));
    const remembered = join(appRoot, "remembered");
    const missing = join(appRoot, "missing");
    await prepareWorkspace(appRoot, remembered);
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        explicitWorkspace: missing,
        stdin: fakeInput("\n"),
        stdout
      })
    ).resolves.toBe(missing);
    expect(stdout.output()).toContain("Workspace does not exist:");
    expect(stdout.output()).toContain(missing);
    expect(stdout.output()).toContain("Select workspace:");
    expect(stdout.output()).toContain(`Workspace [${missing}, 1/1, n]:`);
  });

  it("still lets a TTY user choose a remembered workspace instead of a missing explicit workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-missing-explicit-choice-"));
    const remembered = join(appRoot, "remembered");
    const missing = join(appRoot, "missing");
    await prepareWorkspace(appRoot, remembered);

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        explicitWorkspace: missing,
        stdin: fakeInput("1\n"),
        stdout: fakeOutput()
      })
    ).resolves.toBe(remembered);
  });

  it("prompts before using an explicit workspace path that is an existing file", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-file-explicit-"));
    const remembered = join(appRoot, "remembered");
    const fileWorkspace = join(appRoot, "workspace-file");
    await prepareWorkspace(appRoot, remembered);
    await writeText(fileWorkspace, "not a directory");
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        explicitWorkspace: fileWorkspace,
        stdin: fakeInput("1\n"),
        stdout
      })
    ).resolves.toBe(remembered);
    expect(stdout.output()).toContain("Workspace is not a directory:");
    expect(stdout.output()).toContain(fileWorkspace);
  });

  it("does not default to an explicit workspace path that is an existing file on first run", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-first-run-file-explicit-"));
    const fileWorkspace = join(appRoot, "workspace-file");
    await writeText(fileWorkspace, "not a directory");
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        explicitWorkspace: fileWorkspace,
        stdin: fakeInput("\n"),
        stdout
      })
    ).resolves.toBe(appRoot);
    expect(stdout.output()).toContain("Workspace is not a directory:");
    expect(stdout.output()).toContain("Workspace path:");
    expect(stdout.output()).not.toContain(`Workspace path [${fileWorkspace}]`);
  });

  it("lets a TTY user choose a remembered workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-choice-"));
    const first = join(appRoot, "first");
    const second = join(appRoot, "second");
    await prepareWorkspace(appRoot, first);
    await prepareWorkspace(appRoot, second);

    const stdout = fakeOutput();
    const selected = await selectWorkspaceForCli({
      appRoot,
      cwd: appRoot,
      stdin: fakeInput("2\n"),
      stdout
    });

    expect(selected).toBe(first);
    expect(stdout.output()).toContain("Select workspace:");
    expect(stdout.output()).toContain("n. Create/open another folder");
  });

  it("lets a TTY user create another workspace path", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-new-"));
    await prepareWorkspace(appRoot, join(appRoot, "remembered"));

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("n created\n"),
        stdout: fakeOutput()
      })
    ).resolves.toBe(join(appRoot, "created"));
  });

  it("expands home-relative paths entered from the workspace picker", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-home-"));
    await prepareWorkspace(appRoot, join(appRoot, "remembered"));

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("n ~/created-from-picker\n"),
        stdout: fakeOutput()
      })
    ).resolves.toBe(join(homedir(), "created-from-picker"));
  });

  it("lets a TTY user type n and then answer the path prompt", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-new-step-"));
    await prepareWorkspace(appRoot, join(appRoot, "remembered"));

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("n\ncreated-step\n"),
        stdout: fakeOutput()
      })
    ).resolves.toBe(join(appRoot, "created-step"));
  });

  it("lets a first-run TTY user create a workspace when no projects are remembered", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-first-run-"));
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("fresh-project\n"),
        stdout
      })
    ).resolves.toBe(join(appRoot, "fresh-project"));
    expect(stdout.output()).toContain("Workspace path");
  });

  it("uses cwd for first-run TTY startup when the user accepts the default path", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-default-"));

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("\n"),
        stdout: fakeOutput()
      })
    ).resolves.toBe(appRoot);
  });

  it("does not prompt non-TTY startup and reuses the last remembered workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-nontty-"));
    const workspace = join(appRoot, "remembered");
    await prepareWorkspace(appRoot, workspace);
    const stdout = fakeOutput({ tty: false });

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("", { tty: false }),
        stdout
      })
    ).resolves.toBe(workspace);
    expect(stdout.output()).toBe("");
  });

  it("can skip the picker for command modes that should not prompt", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-skip-picker-"));
    const workspace = join(appRoot, "remembered");
    await prepareWorkspace(appRoot, workspace);
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        stdin: fakeInput("2\n"),
        stdout,
        interactive: false
      })
    ).resolves.toBe(workspace);
    expect(stdout.output()).toBe("");
  });
});

function fakeInput(text: string, options: { tty?: boolean } = {}): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  stream.isTTY = options.tty ?? true;
  const chunks = text.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
  for (const [index, chunk] of chunks.entries()) {
    setTimeout(() => {
      stream.write(chunk);
      if (index === chunks.length - 1) {
        setTimeout(() => stream.end(), 20);
      }
    }, 20 + index * 30);
  }
  return stream;
}

function fakeOutput(options: { tty?: boolean } = {}): NodeJS.WriteStream & { output: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    }
  }) as NodeJS.WriteStream & { output: () => string };
  stream.isTTY = options.tty ?? true;
  stream.output = () => text;
  return stream;
}
