#!/usr/bin/env node
// Injects a release version (derived from the pushed git tag) into the sources
// at build time, so the compiled binary reports the right version.
//
//   node scripts/inject-version.mjs <version>
//
// Updates:
//   1. src/index.ts  — the `const VERSION = "…"` value returned by `--version`
//   2. package.json  — keeps the manifest in sync (not committed; build-only)
//
// The release pipeline is tag-driven: the tag is the source of truth for the
// released version, so these edits live only in the CI runner's checkout.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)*$/.test(version)) {
  console.error(`inject-version: invalid version "${version ?? ""}"`);
  process.exit(1);
}

// 1) src/index.ts — the value reported by `--version`.
const indexPath = new URL("../src/index.ts", import.meta.url);
const index = readFileSync(indexPath, "utf8");
const versionRe = /const VERSION = "[^"]*";/;
// Fail fast if the constant is missing — but check existence separately from
// whether the value changed, since injecting the same version is a valid no-op
// (e.g. tagging v0.1.0 when src already reads "0.1.0").
if (!versionRe.test(index)) {
  console.error("inject-version: VERSION constant not found in src/index.ts");
  process.exit(1);
}
writeFileSync(indexPath, index.replace(versionRe, `const VERSION = "${version}";`));

// 2) package.json — keep the manifest version in sync.
const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`inject-version: set version ${version} in src/index.ts and package.json`);
