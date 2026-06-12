import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StoredTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

export interface AuthFile {
  auth_mode: "chatgpt";
  tokens: StoredTokens;
  last_refresh: string;
}

const LEGACY_ENV_VAR = "CODEX_VICOOP_HOME";
const LEGACY_DIR_NAME = ".codex-vicoop";

function authDir(): string {
  const override = process.env.VICOOP_CODEX_HOME ?? process.env[LEGACY_ENV_VAR];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".vicoop-codex");
}

export function authFilePath(): string {
  return path.join(authDir(), "auth.json");
}

/**
 * Root credentials directory (honors VICOOP_CODEX_HOME / the legacy override).
 * The single-account `auth.json` lives directly inside it; multi-account state
 * lives in `accounts/` and `state.json` alongside.
 */
export function homeDir(): string {
  return authDir();
}

/** Directory holding one `<key>.json` per enrolled account (multi-account pool). */
export function accountsDir(): string {
  return path.join(authDir(), "accounts");
}

/** Path to the small CLI state file ({ activeKey, strategy }). */
export function statePath(): string {
  return path.join(authDir(), "state.json");
}

let migrationChecked = false;
export async function migrateLegacyDirIfNeeded(): Promise<void> {
  if (migrationChecked) return;
  migrationChecked = true;
  if (process.env.VICOOP_CODEX_HOME || process.env[LEGACY_ENV_VAR]) return;
  const newDir = path.join(os.homedir(), ".vicoop-codex");
  const legacyDir = path.join(os.homedir(), LEGACY_DIR_NAME);
  try {
    await fs.access(newDir);
    return;
  } catch {
    // new dir doesn't exist
  }
  try {
    await fs.access(legacyDir);
  } catch {
    return;
  }
  try {
    await fs.rename(legacyDir, newDir);
    process.stderr.write(
      `Migrated credentials directory: ${legacyDir} → ${newDir}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `Failed to migrate ${legacyDir} → ${newDir}: ${(err as Error).message}. Run \`vicoop-codex login\` to re-authenticate.\n`,
    );
  }
}

export async function readAuth(): Promise<AuthFile | null> {
  await migrateLegacyDirIfNeeded();
  try {
    const raw = await fs.readFile(authFilePath(), "utf8");
    return JSON.parse(raw) as AuthFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeAuth(auth: AuthFile): Promise<void> {
  await migrateLegacyDirIfNeeded();
  const dir = authDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = authFilePath();
  const serialized = JSON.stringify(auth, null, 2);
  await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort on platforms without chmod semantics (e.g. Windows)
  }
}

export async function clearAuth(): Promise<void> {
  await migrateLegacyDirIfNeeded();
  try {
    await fs.unlink(authFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
