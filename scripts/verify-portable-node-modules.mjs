#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const payloadDir = path.resolve(process.argv[2] ?? process.cwd());
const nodeModulesDir = path.join(payloadDir, "node_modules");

function walk(dir, onEntry) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    onEntry(fullPath, entry);
    if (entry.isDirectory()) {
      walk(fullPath, onEntry);
    }
  }
}

const absoluteSymlinks = [];

walk(nodeModulesDir, (entryPath, entry) => {
  if (!entry.isSymbolicLink()) {
    return;
  }
  const target = fs.readlinkSync(entryPath);
  if (!path.isAbsolute(target)) {
    return;
  }
  absoluteSymlinks.push({
    link: path.relative(payloadDir, entryPath),
    target,
  });
});

if (absoluteSymlinks.length > 0) {
  console.error(
    `node_modules contains ${absoluteSymlinks.length} absolute symlink(s); installer payloads must be relocatable.`,
  );
  for (const item of absoluteSymlinks.slice(0, 20)) {
    console.error(`absolute symlink: ${item.link} -> ${item.target}`);
  }
  if (absoluteSymlinks.length > 20) {
    console.error(`...and ${absoluteSymlinks.length - 20} more`);
  }
  process.exit(1);
}
