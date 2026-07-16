import { spawn } from "node:child_process";

const MAX_CLIPBOARD_CHARACTERS = 200_000;

export interface ClipboardWriteResult {
  method: string;
  characters: number;
}

export interface ClipboardWriteOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], text: string) => Promise<void>;
  writeTerminal?: (sequence: string) => void;
}

export async function copyTextToClipboard(
  text: string,
  options: ClipboardWriteOptions = {}
): Promise<ClipboardWriteResult> {
  const value = normalizeClipboardText(text);
  if (!value) {
    throw new Error("No visible text to copy");
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runClipboardCommand;
  for (const candidate of clipboardCommands(platform, env)) {
    try {
      await runCommand(candidate.command, candidate.args, value);
      return { method: candidate.method, characters: Array.from(value).length };
    } catch {
      // Try the next local clipboard integration before falling back to OSC 52.
    }
  }

  const writeTerminal = options.writeTerminal ?? ((sequence: string) => {
    process.stdout.write(sequence);
  });
  writeTerminal(osc52ClipboardSequence(value));
  return { method: "osc52", characters: Array.from(value).length };
}

export function normalizeClipboardText(text: string): string {
  const lines = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines[0] === "") {
    lines.shift();
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
  const clean = lines.join("\n");
  return Array.from(clean).slice(0, MAX_CLIPBOARD_CHARACTERS).join("");
}

export function osc52ClipboardSequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Array<{ method: string; command: string; args: string[] }> {
  if (platform === "darwin") {
    return [{ method: "pbcopy", command: "/usr/bin/pbcopy", args: [] }];
  }
  if (platform !== "linux") {
    return [];
  }

  return [
    ...(env.WAYLAND_DISPLAY
      ? [{ method: "wl-copy", command: "wl-copy", args: [] }]
      : []),
    ...(env.DISPLAY
      ? [
          { method: "xclip", command: "xclip", args: ["-selection", "clipboard"] },
          { method: "xsel", command: "xsel", args: ["--clipboard", "--input"] }
        ]
      : [])
  ];
}

function runClipboardCommand(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      finish(code === 0
        ? undefined
        : new Error(`${command} exited ${code ?? "without a code"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin?.on("error", (error) => finish(error));
    child.stdin?.end(text);
  });
}
