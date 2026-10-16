import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

// Fixed repository-owned roots and exclusions also work in deployment exports.
export function discoverSources(root, { includeHooks = false } = {}) {
  const sourceTrees = ["demo", "lib", "public", "pi/dashboard", "scripts", "test", "docs/benchmarks"];
  const excludedDirectories = new Set([
    "node_modules", "__pycache__", "coverage", "dist", "build", "state", "tmp", "temp", "scratch",
  ]);
  const extensions = new Set([".js", ".mjs", ".cjs", ".py", ".sh"]);
  const files = [];

  function discover(directory, recursive) {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || path === "pi/dashboard/config" || path.startsWith("public/background.local.")) continue;
      if (entry.isDirectory() && recursive && !excludedDirectories.has(entry.name)) discover(path, true);
      if (entry.isFile() && (extensions.has(extname(entry.name))
        || (directory === ".githooks" && /^#![^\n]*\b(?:bash|sh)\b/.test(readFileSync(join(root, path), "utf8"))))) files.push(path);
    }
  }

  discover("", false);
  for (const directory of [...sourceTrees, ...(includeHooks ? [".githooks"] : [])]) {
    let parent = root;
    const containsSymlink = directory.split("/").some(part => {
      parent = join(parent, part);
      return lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink();
    });
    if (!containsSymlink) discover(directory, true);
  }

  return files.sort();
}
