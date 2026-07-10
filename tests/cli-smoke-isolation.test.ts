import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI smoke isolation", () => {
  it("gives every workspace launch an explicit app root", async () => {
    const testsDir = join(process.cwd(), "tests");
    const smokeFiles = (await readdir(testsDir))
      .filter((name) => name.startsWith("cli-") && name.endsWith("-smoke.test.ts"))
      .sort();
    const offenders: string[] = [];

    for (const file of smokeFiles) {
      const source = await readFile(join(testsDir, file), "utf8");
      for (const match of source.matchAll(/"src\/cli\.tsx"([\s\S]*?)\]/g)) {
        const args = match[1] ?? "";
        if (!args.includes("--workspace") || args.includes("--app-root")) {
          continue;
        }
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
