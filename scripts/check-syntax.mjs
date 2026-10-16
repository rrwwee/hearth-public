import { spawnSync } from "node:child_process";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSources } from "./source-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = discoverSources(root);

// Keep interpreter startup hooks from executing code during syntax checks.
const env = { ...process.env };
for (const name of ["NODE_OPTIONS", "BASH_ENV", "ENV"]) delete env[name];
const pythonParser = "import ast, sys, tokenize; path = sys.argv[1]; "
  + "source = tokenize.open(path); ast.parse(source.read(), filename=path); source.close()";

for (const path of files) {
  const absolute = join(root, path);
  let command;
  let args;
  switch (extname(path)) {
    case ".py":
      command = "python3";
      args = ["-I", "-B", "-c", pythonParser, absolute];
      break;
    case ".sh":
      command = "bash";
      args = ["--noprofile", "--norc", "-n", absolute];
      break;
    default:
      command = process.execPath;
      args = ["--check", absolute];
  }
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`Syntax check failed: ${path}`);
    if (result.error) console.error(result.error.message);
    if (result.signal) console.error(`${command} terminated by ${result.signal}`);
    process.exit(result.status || 1);
  }
}
console.log(`Syntax check passed: ${files.length} source files checked.`);
