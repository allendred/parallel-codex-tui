import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(dirname(require.resolve("node-pty")));
  const helperPath = join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper");

  if (existsSync(helperPath)) {
    const mode = statSync(helperPath).mode & 0o777;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helperPath, mode | 0o111);
      process.stdout.write("parallel-codex-tui: repaired node-pty spawn-helper permissions\n");
    }
  }
}
