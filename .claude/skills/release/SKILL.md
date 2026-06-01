---
name: release
description: How to cut a release of vicoop-codex-cli. Use when asked to release, publish, ship a new version, bump the version, create a tag, build the binaries, or troubleshoot the release GitHub Actions workflow.
---

# Releasing vicoop-codex-cli

Releases are **tag-driven** and fully automated by `.github/workflows/release.yml`.
There is **no** release-on-merge: merging to `main` only runs the build/type-check
gate (`.github/workflows/ci.yml`). A release happens **only** when a `v*` tag is
pushed to GitHub.

The pushed tag is the **source of truth** for the released version.

## What the release workflow does

On `push` of a tag matching `v*`, the `release` job (on `ubuntu-latest`):

1. Derives the version from the tag (`v1.2.3` → `1.2.3`) and validates it is semver.
   Tags with a pre-release suffix before any `+build` metadata (e.g. `v1.2.3-rc.1`)
   are published as a GitHub **pre-release**.
2. Injects the version into `package.json` and `src/index.ts` via
   `scripts/inject-version.mjs` (build-only — **not** committed).
3. Runs `npm ci` then `npm run build` (`tsc` → `dist/`).
4. Cross-compiles four standalone binaries with **Bun** (`bun build --compile`),
   all from the single Linux runner:
   - `vicoop-codex-<version>-windows-x64.exe`
   - `vicoop-codex-<version>-macos-arm64`
   - `vicoop-codex-<version>-linux-x64`
   - `vicoop-codex-<version>-linux-arm64`
5. Generates `SHA256SUMS.txt` for the binaries.
6. Publishes a GitHub Release for the tag (auto-generated notes) with the binaries
   and `SHA256SUMS.txt` attached, using `softprops/action-gh-release@v2`.

## How to cut a release

Pick the next version (semver). Then either:

**Option A — let npm bump `package.json` and create the tag:**

```bash
npm version patch          # or: minor | major   → creates the vX.Y.Z tag locally
git push && git push --tags
```

**Option B — tag by hand:**

```bash
git tag v1.2.3
git push origin v1.2.3
```

That is all. The tag push triggers the workflow; no manual binary builds are needed.

Notes:
- The workflow injects the version from the tag, so the committed `package.json`
  version does not strictly need to match the tag. Keeping them in sync (Option A)
  is recommended for clarity.
- Pre-release: `git tag v1.2.3-rc.1` → published as a GitHub pre-release.

## Verify a release

After the workflow finishes, confirm at
`https://github.com/planetarium/vicoop-codex-cli/releases` that the four binaries
and `SHA256SUMS.txt` are attached. Smoke-test the matching binary:

```bash
./vicoop-codex-<version>-<platform> --version   # must print <version>
```

Checksum verification:

```bash
sha256sum -c SHA256SUMS.txt   # run in the directory containing the binaries
```

## Build/run the binaries locally (for testing before tagging)

Requires [Bun](https://bun.sh) installed.

```bash
npm ci
node scripts/inject-version.mjs 0.0.0-dev   # optional: stamp a test version
npm run build                               # tsc → dist/
bun build ./bin/vicoop-codex.js --compile --target=bun-darwin-arm64 --outfile=/tmp/vicoop-codex
/tmp/vicoop-codex --version
```

Valid Bun targets used by the pipeline: `bun-windows-x64`, `bun-darwin-arm64`,
`bun-linux-x64`, `bun-linux-arm64`.

## Troubleshooting

- **Workflow didn't run.** It only triggers on tags matching `v*`. Confirm the tag
  was pushed (`git push origin <tag>`), not just created locally, and that it
  starts with `v`.
- **"is not a valid semver tag" error.** The tag (minus `v`) must match
  `X.Y.Z` with an optional `-prerelease` and/or `+build` suffix. Re-tag correctly.
- **Binary reports the wrong `--version`.** The version comes from
  `const VERSION = "…"` in `src/index.ts`, rewritten at build time by
  `scripts/inject-version.mjs`. If that constant is renamed/removed, the injection
  step fails fast — keep the `const VERSION = "…";` line intact.
- **Re-releasing the same tag.** Delete the tag and GitHub Release first
  (`git push origin :refs/tags/v1.2.3` and remove the release in the GitHub UI),
  then re-tag. `action-gh-release` updates an existing release for the tag rather
  than erroring.
- **Adding a platform.** Add a `compile <bun-target> "<artifact-name>"` line to the
  "Compile standalone binaries" step in `.github/workflows/release.yml`.

## macOS / Windows signing (known gap)

Binaries are **not** code-signed or notarized. macOS users may need
`xattr -d com.apple.quarantine ./vicoop-codex`; Windows users may see a SmartScreen
prompt. Add signing/notarization steps to the workflow if distribution requires it.
