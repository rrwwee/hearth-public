import test from "node:test";
import assert from "node:assert/strict";
import { demoCluster } from "../demo/fixtures.js";
import { credentialObservations } from "./fixtures/cluster-credentials.js";

// Minimal browser boundary: run the full application with controlled API
// responses and observe its rendered content, rather than calling its helpers.
class Element {
  children = [];
  dataset = {};
  style = { setProperty() {} };
  className = "";
  classList = { add() {}, toggle() {} };
  hidden = false;
  value = "";
  html = "";
  set innerHTML(value) { this.html = value; this.children = []; }
  set textContent(value) { this.html = value; this.children = []; }
  get textContent() { return this.html + this.children.map((child) => child.textContent).join(" "); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.html = ""; this.children = children; }
  addEventListener() {}
  setAttribute() {}
}

let fixtureId = 0;

async function dashboard(t, cluster) {
  const elements = new Map();
  const intervals = [];
  const document = {
    body: new Element(),
    querySelector(selector) {
      if (!selector.startsWith("#")) return null;
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement() { return new Element(); },
  };
  const browserGlobals = { document,
    fetch: async (url) => ({ json: async () => url === "/api/cluster"
      ? { ok: true, cluster } : { ok: false, error: "fixture unavailable" } }),
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); },
    requestAnimationFrame: (callback) => callback(),
    CSS: { escape: (value) => value },
  };
  // Tests in this file run sequentially. Restore each global after its test;
  // native import exercises the real application and its module dependencies.
  for (const [name, value] of Object.entries(browserGlobals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  await import(`../public/app.js?fixture=${fixtureId++}`);
  await new Promise(setImmediate);
  return { elements, refresh: async () => {
    await intervals.find((entry) => entry.ms === 15000).callback();
  } };
}

test("dashboard shows unavailable jobs beside valid node metrics without a password prompt", async (t) => {
  const cluster = demoCluster();
  cluster.queries.jobs = { status: "failed" };
  cluster.jobs = null;
  cluster.states = null;
  cluster.userSummaries = null;
  for (const node of cluster.nodes) { node.jobs = null; node.jobCount = null; }
  const view = await dashboard(t, cluster);
  const text = view.elements.get("#clusterStatus").textContent;
  assert.match(text, /Jobs unavailable/);
  assert.match(text, /Job details unavailable/);
  assert.match(text, /forge01/);
  assert.match(text, /power/);
  assert.match(text, /degraded/);
  assert.doesNotMatch(text, /no running jobs/);
  assert.equal(view.elements.get("#authForm").hidden, true);
});

test("dashboard retains current jobs when node data is unavailable", async (t) => {
  const cluster = demoCluster();
  cluster.queries.nodes = { status: "timed_out" };
  cluster.nodes = null;
  const view = await dashboard(t, cluster);
  const text = view.elements.get("#clusterStatus").textContent;
  assert.match(text, /latent-dynamics/);
  assert.match(text, /Nodes unavailable/);
  assert.doesNotMatch(text, /gpu unallocated 0\/0/);
});

test("dashboard replaces previous jobs on failure and requires explicit validity", async (t) => {
  const cluster = demoCluster();
  const view = await dashboard(t, cluster);
  assert.match(view.elements.get("#clusterStatus").textContent, /latent-dynamics/);
  delete cluster.queries;
  await view.refresh();
  const text = view.elements.get("#clusterStatus").textContent;
  assert.match(text, /Jobs unavailable/);
  assert.doesNotMatch(text, /latent-dynamics/);
});

test("dashboard distinguishes a valid empty queue from unavailable jobs", async (t) => {
  const cluster = demoCluster();
  cluster.jobs = [];
  cluster.states = {};
  cluster.userSummaries = [];
  const view = await dashboard(t, cluster);
  const text = view.elements.get("#clusterStatus").textContent;
  assert.match(text, /no jobs/);
  assert.doesNotMatch(text, /Jobs unavailable/);
});

for (const { name, need, cluster } of credentialObservations) {
  test(`dashboard credential prompt: ${name}`, async (t) => {
    const view = await dashboard(t, cluster);
    assert.equal(view.elements.get("#authForm").hidden, need === null);
    if (need) {
      assert.equal(view.elements.get("#authTarget").value, need);
      assert.equal(view.elements.get("#authLabel").textContent, need);
      assert.equal(view.elements.get("#authPassword").placeholder, `${need} password`);
    }
  });
}

test("dashboard clears the current prompt when a later observation has no credential need", async (t) => {
  const cluster = structuredClone(credentialObservations[1].cluster);
  const view = await dashboard(t, cluster);
  assert.equal(view.elements.get("#authForm").hidden, false);
  view.elements.get("#authPassword").value = "fixture-only";
  view.elements.get("#authStatus").textContent = "sending";
  cluster.health.checks = [{ key: "ticket", ok: false, state: "unknown" }];
  await view.refresh();
  assert.equal(view.elements.get("#authForm").hidden, true);
  assert.equal(view.elements.get("#authPassword").value, "");
  assert.equal(view.elements.get("#authStatus").textContent, "");
});
