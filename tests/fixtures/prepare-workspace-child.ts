import { pathExists, writeText } from "../../src/core/file-store.js";
import { prepareWorkspace } from "../../src/core/workspace.js";

const [appRoot, workspace, gatePath, readyPath] = process.argv.slice(2);
if (!appRoot || !workspace || !gatePath || !readyPath) {
  throw new Error("Expected app root, workspace, gate, and ready paths.");
}

await writeText(readyPath, "ready\n");
const deadline = Date.now() + 10_000;
while (!(await pathExists(gatePath))) {
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for workspace registration gate.");
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

await prepareWorkspace(appRoot, workspace);
