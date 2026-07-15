---
name: release
description: How to cut a release of vicoop-codex-cli. Use when asked to release, publish, ship a new version, bump the version, create a tag, build the binaries, add a changeset, or troubleshoot the release GitHub Actions workflow.
---

# Releasing vicoop-codex-cli

Releases are **Changesets-driven**. Each behavior-affecting PR ships a
`.changeset/*.md` file declaring the bump (patch/minor/major) + a human summary.
Changesets accumulates those into a **"Version Packages" PR**; **merging that PR is
what cuts a release** — it bumps `package.json`, writes `CHANGELOG.md`, pushes the
`vX.Y.Z` tag, creates the GitHub Release, and builds/attaches the binaries.

Changesets is used purely for **versioning + changelog**. This repo does **not**
publish to npm — the release artifacts are the four standalone binaries on the
GitHub Release. The pushed `vX.Y.Z` tag is still the released-version source of
truth (stamped into the sources at build time by `scripts/inject-version.mjs`).

The whole flow lives in `.github/workflows/version.yml`. `release.yml` is now a
**manual fallback only** (`workflow_dispatch`) for rebuilding binaries for an
existing tag.

## The normal flow (per contributor)

1. Open your PR as usual. If it changes runtime behavior, add a changeset:

   ```bash
   npm run changeset          # interactive: pick bump type + write a summary
   ```

   This writes a `.changeset/<random-name>.md` file — commit it with your PR.
   Chore/docs/CI-only PRs that don't affect a release need **no** changeset.

   To pick the bump type by hand, a changeset file is just:

   ```md
   ---
   "vicoop-codex-cli": minor
   ---

   Human-readable summary of the change.
   ```

2. Merge your PR to `main`. `version.yml` runs and opens (or refreshes) a
   **"chore: version packages"** PR that rolls up all pending changesets into the
   next `package.json` version + `CHANGELOG.md`.

3. **Merge the "Version Packages" PR when you want to cut the release.** On that
   merge, `version.yml`:
   - runs `changeset tag` → creates the `vX.Y.Z` tag and pushes it,
   - creates the GitHub Release with the `CHANGELOG.md` entry as the body,
   - cross-compiles the four standalone binaries with **Bun** and attaches them +
     `SHA256SUMS.txt`.

That's it — no manual tagging, no manual binary builds.

### What the binary build produces

- `vicoop-codex-<version>-windows-x64.exe`
- `vicoop-codex-<version>-macos-arm64`
- `vicoop-codex-<version>-linux-x64`
- `vicoop-codex-<version>-linux-arm64`
- `SHA256SUMS.txt`

All cross-compiled from a single Linux runner via `bun build --compile`.

## Why no npm publish / no PAT

- `.changeset/config.json` sets `access: "restricted"` and the workflow uses
  `changeset tag` (not `changeset publish`), so nothing is ever pushed to a
  registry.
- Everything (tag push + release + binaries) happens **inside one workflow run**,
  so the default `GITHUB_TOKEN` suffices. (A tag pushed by `GITHUB_TOKEN` does not
  trigger *other* workflows — folding the build into `version.yml` sidesteps that.)

## Manual binary rebuild (recovery)

If a release's binaries failed to build/upload, or you hand-pushed a tag, rebuild
them without re-cutting the release:

1. GitHub → Actions → **release (manual rebuild)** → *Run workflow*.
2. Enter the existing tag (e.g. `v0.8.2`).

This checks out the tag, rebuilds the four binaries, and re-attaches them to that
tag's GitHub Release (`.github/workflows/release.yml`).

## Verify a release

Confirm at `https://github.com/planetarium/vicoop-codex-cli/releases` that the four
binaries and `SHA256SUMS.txt` are attached, and that the release body matches the
`CHANGELOG.md` entry. Smoke-test the matching binary:

```bash
./vicoop-codex-<version>-<platform> --version   # must print <version>
sha256sum -c SHA256SUMS.txt                      # in the dir with the binaries
```

## Build/run the binaries locally (before merging)

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

- **No "Version Packages" PR appeared.** There are no pending changesets on `main`.
  Add one (`npm run changeset`) in a PR and merge it. Check the `version.yml` run
  under Actions.
- **Merged the Version PR but no release / no binaries.** The binary steps only run
  when `changeset tag` actually pushed a **new** tag (`published == 'true'`). If the
  target version was already tagged, nothing happens — bump again via a changeset.
  Check the `version.yml` run logs.
- **Binary reports the wrong `--version`.** The version is stamped from
  `package.json` into `const VERSION = "…"` in `src/index.ts` at build time by
  `scripts/inject-version.mjs`. If that constant is renamed/removed the injection
  step fails fast — keep the `const VERSION = "…";` line intact.
- **Wrong bump type shipped.** Changesets aggregates: if any pending changeset is
  `minor`, the release is at least `minor`. Fix by editing/removing the offending
  `.changeset/*.md` before the Version PR merges.
- **Adding a platform.** Add a `compile <bun-target> "<artifact-name>"` line to the
  "Compile standalone binaries" step in **both** `.github/workflows/version.yml`
  and `.github/workflows/release.yml` (they share the compile block).
- **Re-releasing the same version.** Delete the tag and its GitHub Release first
  (`git push origin :refs/tags/vX.Y.Z` + remove the release in the UI), then use the
  **release (manual rebuild)** workflow, or cut a fresh version via a new changeset.

## macOS / Windows signing (known gap)

Binaries are **not** code-signed or notarized. macOS users may need
`xattr -d com.apple.quarantine ./vicoop-codex`; Windows users may see a SmartScreen
prompt. Add signing/notarization steps to the workflow if distribution requires it.
