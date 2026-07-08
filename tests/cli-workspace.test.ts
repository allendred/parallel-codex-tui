import { PassThrough, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectWorkspaceForCli } from "../src/cli-workspace.js";
import { prepareWorkspace } from "../src/core/workspace.js";

describe("selectWorkspaceForCli", () => {
  it("returns explicit workspaces without prompting", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-explicit-"));
    const stdin = fakeInput("");
    const stdout = fakeOutput();

    await expect(
      selectWorkspaceForCli({
        appRoot,
        cwd: appRoot,
        explicitWorkspace: "game",
        stdin,
        stdout
      })
    ).resolves.toBe(join(appRoot, "game"));
    expect(stdout.output()).toBe("");
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
