import { ensureDir, pathExists, pathIsDirectory } from "./file-store.js";

export async function prepareAppRoot(appRoot: string): Promise<string> {
  if ((await pathExists(appRoot)) && !(await pathIsDirectory(appRoot))) {
    throw new Error(`App root path exists but is not a directory: ${appRoot}`);
  }

  await ensureDir(appRoot);
  return appRoot;
}
