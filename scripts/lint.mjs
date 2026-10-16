import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSources } from "./source-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = discoverSources(root, { includeHooks: true });
const groups = {
  JavaScript: files.filter(path => [".js", ".mjs", ".cjs"].includes(extname(path))),
  Python: files.filter(path => extname(path) === ".py"),
  Shell: files.filter(path => extname(path) === ".sh"
    || (path.startsWith(".githooks/") && ![".js", ".mjs", ".cjs", ".py"].includes(extname(path)))),
};

try {
  for (const [language, paths] of Object.entries(groups)) {
    if (!paths.length) throw new Error(`No ${language} source files discovered`);
  }
  const eslint = join(root, "node_modules/eslint/bin/eslint.js");
  const ruff = join(root, ".venv-lint/bin/ruff");
  const shellcheck = join(root, ".venv-lint/bin/shellcheck");
  for (const [name, path] of [["ESLint", eslint], ["Ruff", ruff], ["ShellCheck", shellcheck]]) {
    if (!existsSync(path)) throw new Error(`${name} is missing; see README.md development lint setup`);
  }
  const checks = [
    ["ESLint", process.execPath, [eslint, "--config", join(root, "eslint.config.mjs"), "--no-config-lookup", "--no-ignore", "--max-warnings=0", ...groups.JavaScript]],
    ["Ruff", ruff, ["check", "--config", join(root, "ruff.toml"), "--no-cache", ...groups.Python]],
    ["ShellCheck", shellcheck, ["--norc", "--severity=info", "--source-path=SCRIPTDIR", "--", ...groups.Shell]],
  ];
  let failed = false;
  for (const [name, command, args] of checks) {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw new Error(`${name} could not start: ${result.error.message}`);
    if (result.status !== 0) {
      console.error(`${name} failed${result.signal ? ` (${result.signal})` : ""}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`Lint passed: ${groups.JavaScript.length} JavaScript, ${groups.Python.length} Python, ${groups.Shell.length} shell files.`);
} catch (error) {
  console.error(`Lint failed: ${error.message}`);
  process.exitCode = 1;
}
