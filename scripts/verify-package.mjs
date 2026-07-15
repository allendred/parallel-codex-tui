import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installRoot = mkdtempSync(join(tmpdir(), "parallel-codex-package-"));
let tarballPath = "";

try {
  const packOutput = execFileSync(npmCommand, ["pack", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const jsonStart = packOutput.indexOf("[");
  if (jsonStart < 0) {
    throw new Error(`npm pack did not return JSON: ${packOutput}`);
  }
  const packs = JSON.parse(packOutput.slice(jsonStart));
  if (packs.length !== 1 || !packs[0]?.filename) {
    throw new Error("npm pack must produce exactly one tarball");
  }
  tarballPath = join(root, packs[0].filename);

  execFileSync(npmCommand, [
    "install",
    "--global",
    "--prefix",
    installRoot,
    tarballPath
  ], {
    cwd: root,
    stdio: "inherit"
  });

  const executable = process.platform === "win32"
    ? join(installRoot, "parallel-codex-tui.cmd")
    : join(installRoot, "bin", "parallel-codex-tui");
  const versionOutput = execFileSync(executable, ["--version"], { encoding: "utf8" });
  const helpOutput = execFileSync(executable, ["--help"], { encoding: "utf8" });
  const expectedVersion = `parallel-codex-tui ${packageJson.version}`;
  if (!versionOutput.includes(expectedVersion)) {
    throw new Error(`Installed CLI version mismatch: expected ${expectedVersion}, received ${versionOutput.trim()}`);
  }
  if (!helpOutput.includes("Usage: parallel-codex-tui")) {
    throw new Error("Installed CLI help is missing its usage line");
  }

  process.stdout.write(`package install: ok (${basename(tarballPath)}; ${expectedVersion})\n`);
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(installRoot, { recursive: true, force: true });
}
