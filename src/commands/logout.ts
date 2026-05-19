import { authFilePath, clearAuth } from "../auth/store.js";

export async function logoutCommand(): Promise<number> {
  await clearAuth();
  process.stderr.write(`Removed ${authFilePath()}\n`);
  return 0;
}
