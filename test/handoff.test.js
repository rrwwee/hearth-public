import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixtureEnvironment } from './fixtures/environment.js';

const script = resolve('scripts/handoff.mjs');
const sha = 'a'.repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hearth handoff '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = fixtureEnvironment();
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  const git = (...args) => {
    const p = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    return p.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'source.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'feature');
  writeFileSync(join(root, 'source.txt'), 'implementation\n');
  git('commit', '-am', 'implementation');
  const head = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/example/hearth.git');
  const responses = {
    'repos/example/hearth/pulls/12': { number: 12, state: 'open', draft: false, merged: false, html_url: 'https://github.com/example/hearth/pull/12', mergeable: true, mergeable_state: 'clean', head: { sha: head, ref: 'feature', repo: { full_name: 'example/hearth' } }, base: { sha: base, ref: 'main', repo: { full_name: 'example/hearth' } } },
    'repos/example/hearth/git/ref/heads/main': { object: { sha: base } },
    'repos/example/hearth/rules/branches/main': [{ type: 'pull_request', parameters: {} }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'verify', integration_id: 15368 }] } }],
    'repos/example/hearth/branches/main/protection': { error: 'Branch not protected (HTTP 404)', body: { message: 'Branch not protected' } },
    [`repos/example/hearth/compare/${base}...${head}`]: { status: 'ahead', merge_base_commit: { sha: base } },
    [`repos/example/hearth/commits/${head}/check-runs?per_page=100`]: [{ total_count: 1, check_runs: [{ id: 1, name: 'verify', head_sha: head, app: { id: 15368 }, check_suite: { id: 1 }, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/hearth/actions/runs/1' }] }],
  };
  const reviews = { base, head, standards: { reviewer: 'standards-agent', outcome: 'pass', unresolvedFindings: [] }, spec: { reviewer: 'spec-agent', outcome: 'pass', unresolvedFindings: [] } };
  const data = join(root, '..', `${root.split('/').at(-1)}.json`);
  const reviewFile = `${data}.reviews`;
  const bin = join(root, '..', `${root.split('/').at(-1)}-bin`);
  mkdirSync(bin);
  t.after(() => { rmSync(data, { force: true }); rmSync(reviewFile, { force: true }); rmSync(bin, { recursive: true, force: true }); });
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (process.env.FIXTURE_WAIT) { fs.writeFileSync(process.env.FIXTURE_WAIT, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }\nif (args[0] !== 'api' || !args.includes('--hostname') || !args.includes('github.com') || args.some(x => ['POST','PATCH','PUT','DELETE'].includes(x))) process.exit(90);\nconst data = JSON.parse(fs.readFileSync(process.env.FIXTURE_RESPONSES));\nconst key = args.find(x => x.startsWith('repos/'));\nlet value = data[key];\nif (value?.sequence) { const sequence = value.sequence; value = sequence.length > 1 ? sequence.shift() : sequence[0]; fs.writeFileSync(process.env.FIXTURE_RESPONSES, JSON.stringify(data)); }\nif (value === undefined) { console.error('Unexpected API: ' + key); process.exit(91); }\nif (value.error) { console.log(JSON.stringify(value.body || {})); console.error(value.error); process.exit(1); }\nconsole.log(JSON.stringify(value));\n`, { mode: 0o755 });
  function prepare() {
    writeFileSync(data, JSON.stringify(responses));
    writeFileSync(reviewFile, JSON.stringify(reviews));
    return { ...env, PATH: `${bin}:${env.PATH}`, FIXTURE_RESPONSES: data };
  }
  function launch(settings = {}) {
    return spawn(process.execPath, [script, '--pr', '12', '--reviews', reviewFile, '--json'], { cwd: root, env: { ...prepare(), ...settings } });
  }
  function run(extra = [], json = true) {
    const childEnv = prepare();
    const before = git('status', '--porcelain=v1');
    const p = spawnSync(process.execPath, [script, '--pr', '12', '--reviews', reviewFile, ...(json ? ['--json'] : []), ...extra], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 10000 });
    assert.equal(git('status', '--porcelain=v1'), before, 'reporter changed the checkout');
    return { ...p, report: json && p.stdout.trim() ? JSON.parse(p.stdout) : null };
  }
  return { root, git, base, head, responses, reviews, run, launch, reviewFile, bin };
}

async function assertExited(pid, milliseconds) {
  const deadline = performance.now() + milliseconds;
  do {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  } while (performance.now() < deadline);
  assert.fail(`Process ${pid} did not exit within ${milliseconds}ms`);
}

// Keep the escaped writer alive until after the reporter has exited. Its PID
// handshake also gives cleanup ownership when an assertion or watchdog fails.
async function escapedWriterFixture(t) {
  let child, completion, owner;
  t.after(async () => {
    child?.kill('SIGKILL');
    if (owner && existsSync(owner)) {
      const pid = Number(readFileSync(owner, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await assertExited(pid, 1000);
    }
    if (completion) await finishWithin(1000);
  });
  const f = fixture(t);
  const marker = join(f.bin, 'escaped.json');
  owner = join(f.bin, 'escaped.pid');
  const writer = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, parentPid: Number(process.argv[1]) })); setInterval(() => {}, 1000);`;
  writeFileSync(join(f.bin, 'gh'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}, String(process.pid)], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
require('node:fs').writeFileSync(${JSON.stringify(owner)}, String(child.pid));
child.unref();
console.log('{}');
`, { mode: 0o755 });
  const started = performance.now();
  child = f.launch();
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  completion = new Promise((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveClose({ code, stdout, stderr }));
  });
  // Attach a handler immediately, including while waiting for the PID handshake.
  completion.catch(() => {});
  async function finishWithin(milliseconds) {
    let watchdog;
    try {
      return await Promise.race([
        completion,
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`Reporter exceeded ${milliseconds}ms watchdog`)), milliseconds); }),
      ]);
    } finally { clearTimeout(watchdog); }
  }
  const handshakeDeadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < handshakeDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  assert.ok(existsSync(marker), 'escaped writer started');
  const { pid, parentPid } = JSON.parse(readFileSync(marker, 'utf8'));
  // Ensure this exercises an exited direct child whose pipe remains open.
  await assertExited(parentPid, Math.max(1, handshakeDeadline - Date.now()));
  return { child, pid, started, finishWithin };
}

test('reports a verified current PR handoff without modifying the checkout', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.handoff, 'ready');
  assert.equal(result.report.observations.pr.head, f.head);
  assert.equal(result.report.observations.mergeEligibility.status, 'pass');
  assert.equal(result.report.reviewAssertions.status, 'pass');
  assert.equal(result.report.reviewAssertions.kind, 'supplied assertion');
  assert.match(f.run([], false).stdout, /READY/);
});

test('does not reuse stale, pending, failed, skipped, missing, or wrong-source checks', t => {
  for (const scenario of ['stale', 'pending', 'failed', 'skipped', 'missing', 'wrong-source']) {
    const f = fixture(t);
    const page = f.responses[`repos/example/hearth/commits/${f.head}/check-runs?per_page=100`][0];
    if (scenario === 'stale') page.check_runs[0].head_sha = sha;
    if (scenario === 'pending') page.check_runs[0].status = 'in_progress';
    if (scenario === 'failed') page.check_runs[0].conclusion = 'failure';
    if (scenario === 'skipped') page.check_runs[0].conclusion = 'skipped';
    if (scenario === 'missing') { page.check_runs = []; page.total_count = 0; }
    if (scenario === 'wrong-source') page.check_runs[0].app.id = 7;
    const result = f.run();
    assert.notEqual(result.status, 0, scenario);
    assert.notEqual(result.report.observations.checks.status, 'pass', scenario);
    assert.equal(result.report.observations.mergeEligibility.status, 'pass', 'eligibility is separately reported');
  }
});

test('rejects stale or failing reviewer assertions without obscuring passing CI', t => {
  for (const scenario of ['head', 'base', 'outcome', 'finding', 'same-reviewer']) {
    const f = fixture(t);
    if (scenario === 'head') f.reviews.head = sha;
    if (scenario === 'base') f.reviews.base = sha;
    if (scenario === 'outcome') f.reviews.spec.outcome = 'fail';
    if (scenario === 'finding') f.reviews.spec.unresolvedFindings = ['Missing requirement'];
    if (scenario === 'same-reviewer') f.reviews.spec.reviewer = f.reviews.standards.reviewer;
    const result = f.run();
    assert.notEqual(result.status, 0, scenario);
    assert.notEqual(result.report.reviewAssertions.status, 'pass', scenario);
    assert.equal(result.report.observations.checks.status, 'pass');
  }
});

test('uncommitted files block handoff and are preserved, while PR checks remain visible', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'private-work.txt'), 'keep this work');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.report.observations.local.status, 'blocked');
  assert.equal(result.report.observations.checks.status, 'pass');
  assert.equal(readFileSync(join(f.root, 'private-work.txt'), 'utf8'), 'keep this work');
});

test('unknown mergeability and unavailable policy cannot produce readiness', t => {
  for (const scenario of ['mergeability', 'rules', 'classic']) {
    const f = fixture(t);
    if (scenario === 'mergeability') {
      f.responses['repos/example/hearth/pulls/12'].mergeable = null;
      f.responses['repos/example/hearth/pulls/12'].mergeable_state = 'unknown';
    } else {
      const path = scenario === 'rules' ? 'rules/branches/main' : 'branches/main/protection';
      f.responses[`repos/example/hearth/${path}`] = { error: 'Not Found (HTTP 404)', body: { message: 'Not Found' } };
    }
    const result = f.run();
    assert.equal(result.status, 2, scenario);
    assert.equal(result.report.handoff, 'unknown');
  }
});

test('reports unavailable GitHub as unknown and does not invent a review', t => {
  const f = fixture(t);
  f.responses['repos/example/hearth/pulls/12'] = { error: 'API unavailable (HTTP 503)' };
  const result = f.run();
  assert.equal(result.status, 2);
  assert.equal(result.report.handoff, 'unknown');
});

test('does not call a merged PR ready or use its checks as post-merge verification', t => {
  const f = fixture(t);
  Object.assign(f.responses['repos/example/hearth/pulls/12'], { state: 'closed', merged: true, mergeable: null, mergeable_state: 'unknown' });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.report.observations.pr.detail, /post-merge/);
});

test('all duplicate check suites must pass; a newer success cannot hide another failed suite', t => {
  const f = fixture(t);
  const page = f.responses[`repos/example/hearth/commits/${f.head}/check-runs?per_page=100`][0];
  page.check_runs.push({ ...page.check_runs[0], id: 2, check_suite: { id: 2 } });
  page.check_runs[0].conclusion = 'failure';
  page.total_count = 2;
  const result = f.run();
  assert.equal(result.status, 1);
});

test('a required commit status is read from the exact head and cannot be hidden by a check run', t => {
  const f = fixture(t);
  f.responses['repos/example/hearth/rules/branches/main'][1].parameters.required_status_checks[0].integration_id = null;
  const endpoint = `repos/example/hearth/commits/${f.head}/statuses?per_page=100`;
  f.responses[endpoint] = [[{ id: 1, context: 'verify', state: 'failure' }]];
  assert.equal(f.run().status, 1);
  f.responses[endpoint][0].push({ id: 2, context: 'verify', state: 'success' });
  assert.equal(f.run().status, 0);
});

test('moving head or target during collection returns an inconclusive snapshot', t => {
  for (const field of ['head', 'target']) {
    const f = fixture(t);
    const endpoint = field === 'head' ? 'repos/example/hearth/pulls/12' : 'repos/example/hearth/git/ref/heads/main';
    const initial = structuredClone(f.responses[endpoint]);
    const later = structuredClone(initial);
    if (field === 'head') later.head.sha = sha;
    else later.object.sha = sha;
    f.responses[endpoint] = { sequence: [initial, later] };
    const result = f.run();
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.report.observations.consistency.status, 'unknown');
  }
});

test('a same-head draft transition cannot leave a ready snapshot', t => {
  const f = fixture(t);
  const initial = structuredClone(f.responses['repos/example/hearth/pulls/12']);
  f.responses['repos/example/hearth/pulls/12'] = { sequence: [initial, { ...initial, draft: true }] };
  assert.equal(f.run().status, 2);
});

test('offline reports retain local identity instead of discarding collected facts', t => {
  const f = fixture(t);
  f.responses['repos/example/hearth/pulls/12'] = { error: 'Network unavailable' };
  const result = f.run();
  assert.equal(result.status, 2);
  assert.equal(result.report.observations.local.head, f.head);
});

test('missing review evidence and malformed check responses remain unknown', t => {
  const f = fixture(t);
  assert.equal(f.run(['--reviews', '/no-such-hearth-review-file']).status, 2);
  const endpoint = `repos/example/hearth/commits/${f.head}/check-runs?per_page=100`;
  f.responses[endpoint][0].total_count = 5;
  assert.equal(f.run().status, 2);
});

test('a different local revision and a stale branch cannot pass handoff', t => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.base);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.report.observations.local.status, 'blocked');
  f.git('checkout', 'feature');
  f.responses[`repos/example/hearth/compare/${f.base}...${f.head}`].status = 'diverged';
  assert.equal(f.run().status, 1);
});

test('classic protection requirements supplement effective rules', t => {
  const f = fixture(t);
  f.responses['repos/example/hearth/branches/main/protection'] = { url: 'https://api.github.com/repos/example/hearth/branches/main/protection', required_status_checks: { strict: true, checks: [{ context: 'another-check', app_id: 15368 }] } };
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.report.observations.policy.requiredChecks.length, 2);
  assert.match(JSON.stringify(result.report.observations.checks), /another-check/);
});

test('a successful rerun replaces the failed attempt within the same check suite', t => {
  const f = fixture(t);
  const page = f.responses[`repos/example/hearth/commits/${f.head}/check-runs?per_page=100`][0];
  page.check_runs.push({ ...page.check_runs[0], id: 2 });
  page.check_runs[0].conclusion = 'failure';
  page.total_count = 2;
  assert.equal(f.run().status, 0);
});

test('interrupting a waiting GitHub request stops collection and returns a machine-readable unknown', async t => {
  const f = fixture(t);
  const marker = join(f.root, '..', `${f.root.split('/').at(-1)}.waiting`);
  t.after(() => rmSync(marker, { force: true }));
  const child = f.launch({ FIXTURE_WAIT: marker });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const completion = new Promise(resolveClose => child.on('close', code => resolveClose(code)));
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  assert.ok(existsSync(marker), 'fake GitHub request started');
  child.kill('SIGINT');
  assert.equal(await completion, 130);
  const report = JSON.parse(output);
  assert.equal(report.exitCode, 130);
  assert.equal(report.handoff, 'unknown');
  const requestPid = Number(readFileSync(marker, 'utf8'));
  assert.throws(() => process.kill(requestPid, 0), /ESRCH/);
});

test('SIGINT completes while an escaped descendant retains the exited CLI output pipes', async t => {
  const f = await escapedWriterFixture(t);
  f.child.kill('SIGINT');
  // One second allows scheduler slack; it is not an extra production budget.
  const result = await f.finishWithin(1000);
  assert.equal(result.code, 130, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 130);
  assert.equal(report.handoff, 'unknown');
  assert.doesNotThrow(() => process.kill(f.pid, 0), 'reporter did not wait for writer EOF');
});

test('the total deadline completes while an escaped descendant retains output pipes', async t => {
  const f = await escapedWriterFixture(t);
  // The production budget is 30 seconds, including cleanup. Allow one second
  // of scheduler/startup slack; never kill the writer to satisfy this bound.
  const result = await f.finishWithin(Math.max(1, 31_000 - (performance.now() - f.started)));
  const elapsed = performance.now() - f.started;
  assert.ok(elapsed >= 29_000 && elapsed < 31_000, `elapsed ${elapsed}ms`);
  assert.equal(result.code, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 2);
  assert.equal(report.handoff, 'unknown');
  assert.match(JSON.stringify(report.observations), /deadline exhausted/);
  assert.doesNotThrow(() => process.kill(f.pid, 0), 'reporter did not wait for writer EOF');
});

test('the human report includes unresolved findings under their review axis', t => {
  const f = fixture(t);
  f.reviews.spec.unresolvedFindings = ['The configuration migration is incomplete.'];
  const result = f.run([], false);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /spec:.*\n\s+Unresolved: The configuration migration is incomplete\./);
});
