import fs, { promises as fsp } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';

const events = [];
const originals = Object.fromEntries(['mkdtemp', 'mkdir', 'writeFile', 'chmod', 'symlink', 'copyFile', 'cp', 'rm', 'readFile'].map(name => [name, fsp[name].bind(fsp)]));
for (const name of ['mkdtemp', 'mkdir', 'writeFile', 'chmod', 'symlink', 'copyFile', 'cp']) {
  fsp[name] = async (...args) => {
    const start = performance.now();
    try { return await originals[name](...args); }
    finally { events.push({ kind: 'fs', name, duration_ms: performance.now() - start }); }
  };
}
fsp.rm = async (...args) => {
  if (/hearth-(vpn-test|deploy)-/.test(String(args[0])) && args[1]?.recursive) {
    try {
      const data = await originals.readFile(`${args[0]}/commands.jsonl`, 'utf8');
      const commands = data.trim().split('\n').filter(Boolean).map(JSON.parse);
      const counts = {};
      for (const row of commands) {
        const command = Array.isArray(row) ? row[0] : row.command;
        counts[command] = (counts[command] || 0) + 1;
      }
      events.push({ kind: 'commands', counts });
    } catch (error) { events.push({ kind: 'commands-error', code: error.code }); }
  }
  return originals.rm(...args);
};
const spawn = cp.spawn;
cp.spawn = (...args) => {
  const start = performance.now();
  const child = spawn(...args);
  child.once('close', (code, signal) => events.push({ kind: 'child', command: args[0], code, signal, duration_ms: performance.now() - start }));
  return child;
};
syncBuiltinESMExports();
process.on('exit', () => fs.appendFileSync(process.env.ISSUE21_PROFILE_OUTPUT, JSON.stringify({ pid: process.pid, events }) + '\n'));
