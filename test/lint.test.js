import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "./fixtures/environment.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const hasTools = ["node_modules/eslint/bin/eslint.js", ".venv-lint/bin/ruff", ".venv-lint/bin/shellcheck"]
  .every(path => existsSync(join(repo, path)));
// Deployment validation runs npm test without development dependencies.
const toolOptions = { skip: hasTools ? false : "Install the development lint tools to run lint integration tests" };

function fixture(context, { tools = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hearth lint export "));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const f = {
    root,
    write(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    check() {
      return spawnSync("npm", ["run", "--silent", "lint"], {
        cwd: root, encoding: "utf8", env: fixtureEnvironment(), timeout: 30_000,
      });
    },
  };
  for (const path of ["package.json", "eslint.config.mjs", "ruff.toml", "scripts/lint.mjs", "scripts/source-files.mjs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  if (tools) {
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
    symlinkSync(join(repo, ".venv-lint"), join(root, ".venv-lint"));
  }
  f.write("lib/valid.js", "export const pid = process.pid;\n");
  f.write("public/valid.js", "document.title = 'fixture';\n");
  f.write("pi/dashboard/valid.py", "print('fixture')\n");
  f.write(".githooks/pre-commit", '#!/usr/bin/env bash\nprintf "%s\\n" "fixture"\n');
  return f;
}

test("lint rejects an undefined JavaScript name through its canonical command", toolOptions, context => {
  const f = fixture(context);
  f.write("lib/new module.mjs", "missingName();\n");
  const result = f.check();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no-undef/);
  assert.match(result.stdout + result.stderr, /new module\.mjs/);
});

for (const [path, contents, diagnostic] of [
  ["new root.js", "absent();\n", "no-undef"],
  ["demo/new fixture.mjs", "absent();\n", "no-undef"],
  ["lib/new module.cjs", "module.exports = absent;\n", "no-undef"],
  ["scripts/new check.mjs", "absent();\n", "no-undef"],
  ["test/new.test.js", "absent();\n", "no-undef"],
  ["docs/benchmarks/new helper.mjs", "absent();\n", "no-undef"],
  ["public/browser.js", "console.log(process.pid);\n", "no-undef"],
  ["lib/server.js", "document.title = 'invalid';\n", "no-undef"],
  ["test/fixtures/new fixture.py", "import missing_unused_module\n", "F401"],
  ["test/vpn-systemd/new helper.py", "print(undefined_name)\n", "F821"],
  ["test/deploy-systemd/new helper.sh", '#!/usr/bin/env bash\nprintf "%s" $1\n', "SC2086"],
  [".githooks/new-hook", '#!/bin/sh\nprintf "%s" $1\n', "SC2086"],
  ["lib/stale.js", "// eslint-disable-next-line no-undef\nconsole.log('valid');\n", "Unused eslint-disable"],
]) {
  test(`lint discovers and rejects ${path}`, toolOptions, context => {
    const f = fixture(context);
    f.write(path, contents);
    const result = f.check();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok((result.stdout + result.stderr).includes(path), result.stdout + result.stderr);
    assert.ok((result.stdout + result.stderr).includes(diagnostic), result.stdout + result.stderr);
  });
}

test("lint accepts valid exported sources and excludes private, generated and linked files", toolOptions, context => {
  const f = fixture(context);
  assert.equal(existsSync(join(f.root, ".git")), false);
  f.write("lib/common.cjs", "module.exports = process.pid;\n");
  f.write(".githooks/helper.mjs", "console.log(process.pid);\n");
  f.write(".githooks/helper.py", "print('hook helper')\n");
  f.write("public/valid.mjs", "window.document.title = 'valid';\n");
  f.write("test/intentional.js", "try { throw 1; } catch (error) { console.log('handled'); }\nconst { removed, ...rest } = { removed: 1, kept: 2 }; console.log(rest);\n");
  // Compact Python layout and ShellCheck style-level advice are outside policy.
  f.write("test/valid.py", "a = 1; print(a)\n");
  f.write("scripts/valid.sh", '#!/bin/bash\nn=1\nprintf "%s" "$(( $n + 1 ))"\n');
  for (const path of ["config/private.py", "pi/dashboard/config/private.py", "lib/.hidden.js",
    "lib/node_modules/broken.js", "test/__pycache__/broken.py", "lib/dist/broken.js", "public/coverage/broken.js",
    "lib/build/broken.js", "pi/dashboard/state/broken.py", "scripts/tmp/broken.sh", "test/temp/broken.py",
    "docs/benchmarks/scratch/broken.py", "public/background.local.js", "private-target/broken.py",
    ".githooks/.backup.sh", ".githooks/.scratch/broken.sh"]) {
    f.write(path, "deliberately invalid content\n");
  }
  symlinkSync(join(f.root, "private-target"), join(f.root, "demo"));
  symlinkSync(join(f.root, "private-target/broken.py"), join(f.root, "lib/link.py"));
  const result = f.check();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Lint passed:/);
});

for (const [language, path] of [["Python", "pi/dashboard/valid.py"], ["Shell", ".githooks/pre-commit"]]) {
  test(`lint fails clearly when no ${language} files are discovered`, context => {
    const f = fixture(context, { tools: false });
    rmSync(join(f.root, path));
    const result = f.check();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`No ${language} source files discovered`));
  });
}

test("lint fails clearly when no JavaScript files are discovered", context => {
  const f = fixture(context, { tools: false });
  // Keep the runner executable while moving it outside maintained source scope.
  renameSync(join(f.root, "scripts"), join(f.root, ".runner"));
  for (const path of ["lib", "public", "eslint.config.mjs"]) rmSync(join(f.root, path), { recursive: true });
  f.write("package.json", JSON.stringify({ type: "module", scripts: { lint: "node .runner/lint.mjs" } }));
  const result = f.check();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /No JavaScript source files discovered/);
});

for (const tool of ["ESLint", "Ruff", "ShellCheck"]) {
  test(`lint fails clearly when ${tool} is missing`, context => {
    const f = fixture(context, { tools: false });
    if (tool !== "ESLint") f.write("node_modules/eslint/bin/eslint.js", "");
    if (tool === "ShellCheck") f.write(".venv-lint/bin/ruff", "");
    const result = f.check();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`${tool} is missing`));
  });
}
