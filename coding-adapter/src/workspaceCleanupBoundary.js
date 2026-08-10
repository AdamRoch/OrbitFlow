#!/usr/bin/env node

import { readdirSync, rmSync, statSync } from "node:fs";

const [expectedDevice, expectedInode] = process.argv.slice(2);
if (!/^\d+$/.test(expectedDevice ?? "") || !/^\d+$/.test(expectedInode ?? "")) {
  process.exit(1);
}

try {
  const current = statSync(".");
  if (
    !current.isDirectory() ||
    String(current.dev) !== expectedDevice ||
    String(current.ino) !== expectedInode
  ) {
    process.exit(1);
  }
  for (const entry of readdirSync(".")) {
    rmSync(entry, { recursive: true, force: false });
  }
} catch {
  process.exit(1);
}
