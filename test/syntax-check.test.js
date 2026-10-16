import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "./fixtures/environment.js";

const repo = fileURLToPath(new URL("..", import.meta.url));

function sourceExport(context) {
  const root = mkdtempSync(join(tmpdir(), "hearth syntax export "));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["package.json", "server.js", "demo", "lib", "public", "pi", "scripts", "test", "docs/benchmarks"]) {
    cpSync(join(repo, path), join(root, path), {
      recursive: true,
      filter: source => basename(source) !== "__pycache__" && !source.endsWith(".pyc"),
    });
  }
  return {
    root,
    write(path, contents) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    },
    check() {
      return spawnSync("npm", ["run", "--silent", "check:syntax"], {
        cwd: root, encoding: "utf8", env: fixtureEnvironment(), timeout: 30_000,
      });
    },
  };
}

test("syntax check rejects an error in a later shell file in a source export", context => {
  const fixture = sourceExport(context);
  fixture.write("pi/dashboard/lib/vpn.sh", "if then\n");
  const result = fixture.check();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /pi\/dashboard\/lib\/vpn\.sh/);
  assert.match(result.stderr, /syntax error/);
});

for (const [path, contents, status] of [
  ["new root module.js", "const broken = ;\n", 1],
  ["demo/new fixture.mjs", "export const broken = ;\n", 1],
  ["lib/nested/new module.cjs", "module.exports = ;\n", 1],
  ["public/new module.js", "const broken = ;\n", 1],
  ["pi/dashboard/new helper.py", "if True\n", 1],
  ["scripts/new check.sh", "if then\n", 2],
  ["test/fixtures/new fixture.py", "if True\n", 1],
  ["test/deploy-systemd/new helper.sh", "if then\n", 2],
  ["test/vpn-systemd/new helper.py", "if True\n", 1],
  ["test/vpn-systemd/new helper.sh", "if then\n", 2],
  ["docs/benchmarks/new helper.py", "if True\n", 1],
  ["docs/benchmarks/new helper.mjs", "export const broken = ;\n", 1],
]) {
  test(`syntax check discovers and rejects ${path}`, context => {
    const fixture = sourceExport(context);
    fixture.write(path, contents);
    const result = fixture.check();
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(path), result.stderr);
    assert.match(result.stderr, /SyntaxError|syntax error/);
  });
}

test("syntax check accepts a source export without executing files or creating bytecode", context => {
  const fixture = sourceExport(context);
  assert.equal(existsSync(join(fixture.root, ".git")), false);
  fixture.write("lib/do not execute.js", "throw new Error('must only parse');\n");
  fixture.write("lib/do not execute.mjs", "throw new Error('must only parse');\n");
  fixture.write("lib/do not execute.cjs", "throw new Error('must only parse');\n");
  fixture.write("pi/dashboard/do not execute.py", "raise Exception('must only parse')\n");
  fixture.write("scripts/do not execute.sh", "exit 97\n");
  fixture.write("test/fixtures/encoded.py", Buffer.from("# coding: latin-1\nname = 'caf\xe9'\n", "latin1"));
  const result = fixture.check();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const generated = readdirSync(fixture.root, { recursive: true })
    .filter(path => path.endsWith(".pyc") || path.split(/[\\/]/).includes("__pycache__"));
  assert.deepEqual(generated, []);
});

test("syntax tests tolerate pre-existing bytecode without changing it", context => {
  const fixture = sourceExport(context);
  const cachedPaths = ["pi/dashboard/__pycache__/existing.cpython-314.pyc", "test/fixtures/existing.pyc"];
  const cachedBytes = Buffer.from("pre-existing bytecode");
  for (const path of cachedPaths) fixture.write(path, cachedBytes);
  const env = fixtureEnvironment();
  // This subprocess starts its own test runner, outside the current worker.
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap",
    "--test-name-pattern=^syntax check accepts a source export without executing files or creating bytecode$",
    "test/syntax-check.test.js",
  ], { cwd: fixture.root, encoding: "utf8", env, timeout: 30_000 });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  for (const path of cachedPaths) assert.deepEqual(readFileSync(join(fixture.root, path)), cachedBytes);
});

test("syntax check excludes dependencies, generated output, private data, scratch files and symlinks", context => {
  const fixture = sourceExport(context);
  for (const path of [
    "node_modules/broken.js", "lib/node_modules/broken.js", "test/__pycache__/broken.py",
    "coverage/broken.js", "public/coverage/broken.js", "public/dist/broken.js", "lib/build/broken.js",
    "state/broken.py", "pi/dashboard/state/broken.py", ".demo-state/broken.py",
    "lib/.scratch/broken.js", "lib/.hidden.js", "scripts/tmp/broken.sh", "test/temp/broken.py",
    "docs/benchmarks/scratch/broken.py", "config/private.py", "pi/dashboard/config/private.py",
    "public/background.local.js", "docs/not-a-source-tree/broken.py",
  ]) fixture.write(path, "if then\n");
  fixture.write("private-target/broken.py", "if True\n");
  symlinkSync(join(fixture.root, "private-target/broken.py"), join(fixture.root, "lib/link.py"));
  symlinkSync(join(fixture.root, "private-target"), join(fixture.root, "test/link"));
  const result = fixture.check();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("syntax check does not follow a source tree replaced by a symlink", context => {
  const fixture = sourceExport(context);
  rmSync(join(fixture.root, "demo"), { recursive: true });
  fixture.write("private-target/broken.py", "if True\n");
  symlinkSync(join(fixture.root, "private-target"), join(fixture.root, "demo"));
  const result = fixture.check();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
