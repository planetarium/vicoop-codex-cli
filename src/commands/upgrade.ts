import { createHash } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { printError } from "../cli/help-errors.js";
import { VERSION } from "../index.js";

const REPO = "planetarium/vicoop-codex-cli";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface UpgradeCmdOptions {
  /** Only report whether a newer version exists; don't download anything. */
  check: boolean;
  /** Re-download and reinstall even if already on the latest version. */
  force: boolean;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

/**
 * Map the current Node/Bun runtime to the release asset suffix produced by
 * `.github/workflows/release.yml`. Returns null on an unsupported platform.
 */
function assetSuffixForPlatform(): string | null {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "windows-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return null;
}

/**
 * Detect whether we're running as a Bun-compiled standalone binary (which we
 * can replace in place) rather than via `node`/`bun` from a source checkout or
 * an `npm install -g`. In the standalone case `process.execPath` is the CLI
 * binary itself; otherwise it's the interpreter.
 */
function runningAsStandaloneBinary(): boolean {
  const base = basename(process.execPath).toLowerCase();
  return base !== "node" && base !== "node.exe" && base !== "bun" && base !== "bun.exe";
}

/** Compare two `x.y.z[-pre]` versions. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre: pre ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  // A release version (no pre-release tag) outranks a pre-release of the same core.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const res = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "vicoop-codex-cli",
    },
  });
  if (res.status === 404) {
    throw new Error("No published releases were found for this repository.");
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status} for the latest release.`);
  }
  return (await res.json()) as ReleaseInfo;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "vicoop-codex-cli" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Parse a `sha256  filename` line from SHA256SUMS.txt for the given asset. */
function expectedSha(sumsText: string, assetName: string): string | null {
  for (const line of sumsText.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && basename(m[2]) === assetName) return m[1].toLowerCase();
  }
  return null;
}

export async function upgradeCommand(opts: UpgradeCmdOptions): Promise<number> {
  let release: ReleaseInfo;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    if (err instanceof TypeError || (err as { code?: string })?.code === "ENOTFOUND") {
      printError(
        `Couldn't reach GitHub to check for updates: ${(err as Error).message ?? String(err)}\n\n` +
          "Check your internet connection and try again.",
      );
      return 5;
    }
    printError((err as Error).message ?? String(err));
    return 4;
  }

  const latest = release.tag_name.replace(/^v/, "");
  const cmp = compareVersions(latest, VERSION);

  if (cmp <= 0 && !opts.force) {
    process.stdout.write(
      cmp === 0
        ? `Already on the latest version (${VERSION}).\n`
        : `Current version (${VERSION}) is newer than the latest release (${latest}); nothing to do.\n`,
    );
    return 0;
  }

  if (opts.check) {
    process.stdout.write(
      `A newer version is available: ${VERSION} → ${latest}\n` +
        `Run \`vicoop-codex upgrade\` to install it.\n`,
    );
    return 0;
  }

  const suffix = assetSuffixForPlatform();
  if (!suffix) {
    printError(
      `No prebuilt binary is available for this platform (${process.platform}/${process.arch}).\n\n` +
        `Download or build manually from:\n  ${RELEASES_PAGE}`,
    );
    return 6;
  }

  if (!runningAsStandaloneBinary()) {
    printError(
      "Self-upgrade only works for the standalone binary releases.\n\n" +
        "This looks like a source / npm install. Update it with one of:\n" +
        "  • git pull && npm run cli:install   (source checkout)\n" +
        "  • npm install -g vicoop-codex-cli@latest\n\n" +
        `Or grab a standalone binary from:\n  ${RELEASES_PAGE}`,
    );
    return 7;
  }

  const assetName = `vicoop-codex-${latest}-${suffix}`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    printError(
      `Release ${latest} has no asset named '${assetName}'.\n\n` +
        `Available assets:\n${release.assets.map((a) => `  • ${a.name}`).join("\n")}`,
    );
    return 6;
  }
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS.txt");

  const target = process.execPath;
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.upgrade-${process.pid}`);

  try {
    process.stdout.write(`Downloading ${assetName}…\n`);
    const binary = await download(asset.browser_download_url);

    if (sumsAsset) {
      const sumsText = (await download(sumsAsset.browser_download_url)).toString("utf8");
      const want = expectedSha(sumsText, assetName);
      if (!want) {
        printError(`SHA256SUMS.txt has no entry for ${assetName}; refusing to install.`);
        return 8;
      }
      const got = createHash("sha256").update(binary).digest("hex");
      if (got !== want) {
        printError(
          `Checksum mismatch for ${assetName} — refusing to install.\n` +
            `  expected ${want}\n  got      ${got}`,
        );
        return 8;
      }
      process.stdout.write("Checksum verified.\n");
    } else {
      process.stdout.write("Warning: no SHA256SUMS.txt in this release; skipping checksum verification.\n");
    }

    await writeFile(tmp, binary, { mode: 0o755 });
    await chmod(tmp, 0o755);

    if (process.platform === "win32") {
      // Windows can't overwrite a running .exe, but it can rename it. Move the
      // running binary aside, then move the new one into place.
      const old = `${target}.old`;
      await unlink(old).catch(() => {});
      await rename(target, old);
      await rename(tmp, target);
      // Best-effort: the old binary is still locked while we run; leave it for
      // the OS / next invocation to clean up.
    } else {
      // Atomic on the same filesystem; safe even though the binary is running.
      await rename(tmp, target);
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    printError(`Upgrade failed: ${(err as Error).message ?? String(err)}`);
    return 4;
  }

  process.stdout.write(`Upgraded ${VERSION} → ${latest}.\n`);
  return 0;
}
