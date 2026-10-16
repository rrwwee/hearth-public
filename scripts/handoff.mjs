#!/usr/bin/env node
// Read-only PR evidence collection. Review outcomes remain supplied assertions.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const deadline = performance.now() + 30_000;
const cleanupBudget = 100;
const collectionDeadline = deadline - cleanupBudget;
const activeCommands = new Set();
let interrupted = false;

function stop(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
}
function interrupt() {
  interrupted = true;
  for (const cancel of activeCommands) cancel();
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

function command(program, args) {
  return new Promise((resolve, reject) => {
    if (interrupted || performance.now() >= collectionDeadline) return reject(new Error('Collection interrupted or 30-second deadline exhausted'));
    const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
    if (program === 'git') {
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
      env.GIT_OPTIONAL_LOCKS = '0';
      args = ['-c', 'core.fsmonitor=false', ...args];
    }
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false, settled = false, stopping = false;
    let cleanupTimer;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, collectionDeadline - performance.now()));
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      activeCommands.delete(cancel);
      if (interrupted || timedOut) {
        // A direct child that cannot exit promptly must not keep Node alive.
        child.unref();
        return reject(new Error('Collection interrupted or 30-second deadline exhausted'));
      }
      if (error) return reject(error);
      resolve(stdout);
    }
    function cancel() {
      if (settled || stopping) return;
      stopping = true;
      stop(child);
      // Escaped descendants can retain the write ends after their parent exits.
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return finish();
      child.once('exit', () => finish());
      cleanupTimer = setTimeout(() => finish(), Math.max(0, Math.min(cleanupBudget, deadline - performance.now())));
    }
    activeCommands.add(cancel);
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', finish);
    child.on('close', code => {
      if (code !== 0) {
        const error = new Error(`${program}: ${stderr.trim() || `exit ${code}`}`);
        error.stdout = stdout;
        return finish(error);
      }
      finish();
    });
  });
}

async function api(endpoint, paginated = false) {
  const args = ['api', '--hostname', 'github.com', endpoint];
  if (paginated) args.push('--paginate', '--slurp');
  return JSON.parse(await command('gh', args));
}
function requireShape(condition, message) {
  if (!condition) throw new Error(`Invalid evidence: ${message}`);
}
function observation(status, detail, data = {}) { return { status, detail, ...data }; }
async function observe(action) {
  try { return await action(); } catch (error) { return observation('unknown', error.message); }
}
function remoteRepository(url) {
  const match = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}
async function checkout() {
  const [head, branch, remote, changes] = await Promise.all([
    command('git', ['rev-parse', 'HEAD']),
    command('git', ['branch', '--show-current']),
    command('git', ['remote', 'get-url', 'origin']),
    command('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
  ]);
  requireShape(shaPattern.test(head.trim()), 'local HEAD');
  return { head: head.trim(), branch: branch.trim() || '(detached)', repository: remoteRepository(remote), changes: changes.split('\0').filter(Boolean) };
}
function validatePR(pr, number, repository) {
  requireShape(pr?.number === number && ['open', 'closed'].includes(pr.state), 'PR identity/state');
  requireShape(typeof pr.draft === 'boolean' && typeof pr.merged === 'boolean' && typeof pr.html_url === 'string', 'PR lifecycle');
  requireShape(shaPattern.test(pr.head?.sha) && shaPattern.test(pr.base?.sha), 'PR revisions');
  requireShape(pr.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase() && typeof pr.base.ref === 'string', 'PR target repository');
}
async function policy(repository, branch) {
  const path = `${repository}/`;
  const [rules, classic] = await Promise.all([
    api(`repos/${path}rules/branches/${encodeURIComponent(branch)}`),
    api(`repos/${path}branches/${encodeURIComponent(branch)}/protection`).catch(error => {
      if (error.message.includes('(HTTP 404)') && JSON.parse(error.stdout || '{}').message === 'Branch not protected') return null;
      throw error;
    }),
  ]);
  requireShape(Array.isArray(rules), 'effective branch rules');
  const checks = [];
  let strict = false;
  for (const rule of rules) {
    requireShape(typeof rule?.type === 'string', 'branch rule');
    if (rule.type === 'required_status_checks') {
      requireShape(Array.isArray(rule.parameters?.required_status_checks) && typeof rule.parameters.strict_required_status_checks_policy === 'boolean', 'required-check rule');
      strict ||= rule.parameters.strict_required_status_checks_policy;
      for (const check of rule.parameters.required_status_checks) checks.push({ name: check.context, appId: check.integration_id ?? null });
    }
  }
  if (classic !== null) {
    requireShape(classic && typeof classic === 'object' && typeof classic.url === 'string', 'classic branch protection');
    if (classic.required_status_checks) {
      const required = classic.required_status_checks;
      requireShape(Array.isArray(required.checks) && typeof required.strict === 'boolean', 'classic required checks');
      strict ||= required.strict;
      for (const check of required.checks) checks.push({ name: check.context, appId: check.app_id ?? null });
    }
  }
  requireShape(checks.length > 0, 'no required checks could be established');
  for (const check of checks) requireShape(typeof check.name === 'string' && check.name.length > 0 && (check.appId === null || Number.isInteger(check.appId)), 'required check identity');
  const unique = [...new Map(checks.map(check => [`${check.name}:${check.appId}`, check])).values()];
  return observation('pass', 'Effective rules and classic protection read.', { requiredChecks: unique, strict, ruleTypes: rules.map(rule => rule.type), classicProtection: classic !== null });
}
async function checksFor(repository, head, requiredChecks) {
  const pages = await api(`repos/${repository}/commits/${head}/check-runs?per_page=100`, true);
  requireShape(Array.isArray(pages) && pages.length > 0 && pages.every(page => Array.isArray(page.check_runs) && Number.isInteger(page.total_count)), 'check-run pages');
  const runs = pages.flatMap(page => page.check_runs);
  requireShape(pages.every(page => page.total_count === runs.length), 'incomplete or changing check-run pagination');
  let statuses = [];
  if (requiredChecks.some(check => check.appId === null || check.appId === -1)) {
    const statusPages = await api(`repos/${repository}/commits/${head}/statuses?per_page=100`, true);
    requireShape(Array.isArray(statusPages) && statusPages.length > 0 && statusPages.every(Array.isArray), 'commit-status pages');
    statuses = statusPages.flat();
  }
  const results = [];
  for (const required of requiredChecks) {
    const matches = runs.filter(run => run.name === required.name && (required.appId === null || required.appId === -1 || run.app?.id === required.appId));
    const matchingStatuses = required.appId === null || required.appId === -1 ? statuses.filter(item => item.context === required.name) : [];
    if (!matches.length && !matchingStatuses.length) { results.push({ ...required, status: 'blocked', detail: 'Required check missing.' }); continue; }
    requireShape(matches.every(run => run.head_sha === head && Number.isInteger(run.id) && Number.isInteger(run.app?.id) && Number.isInteger(run.check_suite?.id) && ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(run.status)), 'check-run revision/identity/status');
    const suites = new Map();
    for (const run of matches) {
      const key = `${run.app?.id}:${run.check_suite.id}`;
      if (!suites.has(key) || suites.get(key).id < run.id) suites.set(key, run);
    }
    for (const latest of suites.values()) {
      if (latest.status === 'completed') requireShape(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(latest.conclusion), 'check conclusion');
      const status = latest.status !== 'completed' ? 'blocked' : latest.conclusion === 'success' ? 'pass' : 'blocked';
      results.push({ ...required, status, detail: latest.status === 'completed' ? latest.conclusion : latest.status, url: latest.html_url });
    }
    if (matchingStatuses.length) {
      requireShape(matchingStatuses.every(item => Number.isInteger(item.id) && ['success', 'failure', 'error', 'pending'].includes(item.state)), 'commit status');
      const latest = matchingStatuses.sort((a, b) => b.id - a.id)[0];
      results.push({ ...required, status: latest.state === 'success' ? 'pass' : 'blocked', detail: `commit status: ${latest.state}`, url: latest.target_url });
    }
  }
  return observation(results.every(item => item.status === 'pass') ? 'pass' : 'blocked', `Checks for ${head}.`, { revision: head, results });
}
async function reviewAssertions(file, head, comparisonBase) {
  const evidence = JSON.parse(await readFile(file, 'utf8'));
  requireShape(shaPattern.test(evidence.base) && shaPattern.test(evidence.head), 'review base/head');
  for (const axis of ['standards', 'spec']) {
    const review = evidence[axis];
    requireShape(typeof review?.reviewer === 'string' && review.reviewer.trim() && ['pass', 'fail'].includes(review.outcome) && Array.isArray(review.unresolvedFindings), `${axis} review`);
  }
  requireShape(evidence.standards.reviewer.trim() !== evidence.spec.reviewer.trim(), 'independent reviewers');
  if (evidence.head === head && !comparisonBase) return observation('unknown', 'Cannot establish the current review comparison base.', { kind: 'supplied assertion', evidence });
  const current = evidence.head === head && evidence.base === comparisonBase;
  const passed = ['standards', 'spec'].every(axis => evidence[axis].outcome === 'pass' && evidence[axis].unresolvedFindings.length === 0);
  return observation(current && passed ? 'pass' : 'blocked', !current ? 'Review revisions are stale or comparison base is unknown.' : passed ? 'Both reviewers report passing.' : 'Review findings remain unresolved.', { kind: 'supplied assertion', evidence });
}
function finish(repository, observations, assertions) {
  assertions.kind = 'supplied assertion';
  const states = [...Object.values(observations), assertions].map(item => item.status);
  const exitCode = states.includes('blocked') ? 1 : states.includes('unknown') ? 2 : 0;
  return { repository, observedAt: new Date().toISOString(), handoff: exitCode === 0 ? 'ready' : exitCode === 1 ? 'not-ready' : 'unknown', exitCode, observations, reviewAssertions: assertions };
}
function prState(pr) {
  return JSON.stringify([pr.head.sha, pr.base.ref, pr.base.sha, pr.state, pr.draft, pr.merged, pr.mergeable, pr.mergeable_state]);
}
async function collect(options) {
  const observations = {};
  const initialLocal = await observe(checkout);
  observations.local = initialLocal.head ? observation('unknown', 'Local state observed; comparison with PR head not yet established.', initialLocal) : initialLocal;
  const repository = options.repo || initialLocal.repository;
  if (!repositoryPattern.test(repository || '')) {
    observations.pr = observation('unknown', 'Cannot identify GitHub repository; use --repo owner/name.');
    return finish(repository, observations, observation('unknown', 'Review revisions cannot be checked.'));
  }
  const prefix = `repos/${repository}`;
  let pr;
  try {
    pr = await api(`${prefix}/pulls/${options.pr}`);
    validatePR(pr, Number(options.pr), repository);
  } catch (error) {
    observations.pr = observation('unknown', error.message);
    return finish(repository, observations, observation('unknown', 'Review revisions cannot be checked.'));
  }
  observations.pr = observation(pr.state === 'open' && !pr.draft ? 'pass' : 'blocked', pr.state === 'closed' ? 'PR closed/merged; PR checks do not establish post-merge verification.' : pr.draft ? 'PR is a draft.' : 'Open PR.', { url: pr.html_url, head: pr.head.sha, base: pr.base.sha, target: pr.base.ref, state: pr.state, merged: pr.merged, draft: pr.draft });
  observations.local = initialLocal.head ? observation(initialLocal.changes.length || initialLocal.head !== pr.head.sha || initialLocal.repository?.toLowerCase() !== repository.toLowerCase() ? 'blocked' : 'pass', 'Local checkout; uncommitted changes are not attributed to a task.', initialLocal) : initialLocal;
  observations.policy = await observe(() => policy(repository, pr.base.ref));
  let target;
  observations.freshness = await observe(async () => {
    const ref = await api(`${prefix}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`);
    requireShape(shaPattern.test(ref?.object?.sha), 'live target revision');
    target = ref.object.sha;
    const comparison = await api(`${prefix}/compare/${target}...${pr.head.sha}`);
    requireShape(shaPattern.test(comparison?.merge_base_commit?.sha) && ['ahead', 'behind', 'identical', 'diverged'].includes(comparison.status), 'base comparison');
    if (['ahead', 'identical'].includes(comparison.status)) requireShape(comparison.merge_base_commit.sha === target, 'current comparison base');
    return observation(['ahead', 'identical'].includes(comparison.status) ? 'pass' : 'blocked', comparison.status, { targetRevision: target, comparisonBase: comparison.merge_base_commit.sha });
  });
  observations.checks = observations.policy.status === 'pass'
    ? await observe(() => checksFor(repository, pr.head.sha, observations.policy.requiredChecks))
    : observation('unknown', 'Required checks cannot be evaluated without readable policy.');
  observations.mergeEligibility = observation(pr.mergeable === true && pr.mergeable_state === 'clean' && !pr.draft && pr.state === 'open' ? 'pass' : pr.mergeable === false || ['blocked', 'behind', 'dirty', 'draft'].includes(pr.mergeable_state) || pr.state !== 'open' || pr.draft ? 'blocked' : 'unknown', `GitHub: mergeable=${pr.mergeable}, state=${pr.mergeable_state}. This is not merge authorization.`);
  const assertions = options.reviews ? await observe(() => reviewAssertions(options.reviews, pr.head.sha, observations.freshness.comparisonBase)) : observation('unknown', 'No review evidence supplied.');
  observations.consistency = await observe(async () => {
    const [finalPR, finalTarget, finalLocal] = await Promise.all([api(`${prefix}/pulls/${options.pr}`), api(`${prefix}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`), checkout()]);
    validatePR(finalPR, Number(options.pr), repository);
    const stable = prState(finalPR) === prState(pr) && finalTarget.object?.sha === target && JSON.stringify(finalLocal) === JSON.stringify(initialLocal);
    return observation(stable ? 'pass' : 'unknown', stable ? 'Revisions and local state remained stable during collection.' : 'State changed during collection; rerun the report.');
  });
  return finish(repository, observations, assertions);
}
function print(report, json) {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Handoff: ${report.handoff.toUpperCase()}`);
  if (report.repository) console.log(`Repository: ${report.repository}`);
  for (const [name, item] of Object.entries(report.observations)) {
    console.log(`${name}: ${item.status.toUpperCase()} — ${item.detail}`);
    if (name === 'pr') console.log(`  ${item.url}\n  head ${item.head}; base ${item.base} (${item.target})`);
    if (name === 'local' && item.head) console.log(`  ${item.branch} ${item.head}; ${item.changes.length} uncommitted entries`);
    if (name === 'local') for (const change of item.changes || []) console.log(`  ${JSON.stringify(change)}`);
    if (name === 'freshness' && item.targetRevision) console.log(`  live target ${item.targetRevision}; comparison base ${item.comparisonBase}`);
    for (const result of item.results || []) console.log(`  ${result.name}: ${result.status} (${result.detail})`);
  }
  console.log(`review assertions: ${report.reviewAssertions.status.toUpperCase()} — ${report.reviewAssertions.detail}`);
  const review = report.reviewAssertions.evidence;
  if (review) {
    console.log(`  comparison ${review.base}...${review.head}`);
    for (const axis of ['standards', 'spec']) {
      console.log(`  ${axis}: ${review[axis].outcome} (supplied by ${JSON.stringify(review[axis].reviewer)})`);
      for (const finding of review[axis].unresolvedFindings) console.log(`    Unresolved: ${finding}`);
    }
  }
  if (report.error) console.log(report.error);
}
let json = process.argv.includes('--json');
try {
  const { values } = parseArgs({ options: { pr: { type: 'string' }, repo: { type: 'string' }, reviews: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: false });
  json = values.json;
  if (values.help) {
    console.log('Usage: node scripts/handoff.mjs --pr NUMBER [--repo OWNER/REPO] [--reviews FILE] [--json]\nRead-only 30-second snapshot. Exit 0: ready; 1: blocked; 2: unknown; 130: interrupted.');
  } else {
    requireShape(/^[1-9][0-9]*$/.test(values.pr || '') && (!values.repo || repositoryPattern.test(values.repo)), 'use --pr NUMBER and optional --repo OWNER/REPO');
    const report = await collect(values);
    if (interrupted) { report.exitCode = 130; report.handoff = 'unknown'; }
    print(report, json);
    process.exitCode = interrupted ? 130 : report.exitCode;
  }
} catch (error) {
  print({ handoff: 'unknown', exitCode: interrupted ? 130 : 2, observations: {}, reviewAssertions: observation('unknown', 'Not established.'), error: error.message }, json);
  process.exitCode = interrupted ? 130 : 2;
}
