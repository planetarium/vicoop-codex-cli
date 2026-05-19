#!/usr/bin/env node
import("../dist/index.js").then((mod) => mod.main()).catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
