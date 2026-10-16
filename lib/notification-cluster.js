import { indexOwnJobs, indexOwnTerminalJobs, jobStartCandidates, jobTerminalCandidates,
  pruneKnownTerminalJobs, terminalNotification, passwordNeedForCluster } from "./notification-policy.js";

function validRecords(jobs) {
  return Array.isArray(jobs) && jobs.every((job) => (
    job && typeof job === "object" && ["string", "number"].includes(typeof job.id)
    && String(job.id).trim() && typeof job.state === "string" && job.state.trim()
    && typeof job.user === "string" && job.user.trim()
  ));
}

function validJobObservation(cluster) {
  if (cluster.queries?.jobs?.status !== "ok" || !validRecords(cluster.jobs)) return false;
  const seen = new Map();
  for (const job of cluster.jobs) {
    const value = JSON.stringify(Object.fromEntries(Object.keys(job).sort().map((key) => [key, job[key]])));
    const key = String(job.id);
    if (seen.has(key) && seen.get(key) !== value) return false;
    seen.set(key, value);
  }
  return true;
}

export function observeCluster(config, state, cluster, now, enqueue) {
  if (!cluster || typeof cluster.reachable !== "boolean") throw new Error("Invalid cluster observation");
  if (cluster.reachable && (typeof cluster.user !== "string" || !cluster.user.trim())) {
    throw new Error("Invalid cluster user");
  }
  if (validJobObservation(cluster)) {
    const jobs = indexOwnJobs(cluster);
    if (state.clusterInitialized) {
      for (const job of jobStartCandidates(jobs, state.jobs)) {
        enqueue("job.running", "Cluster job started", `${job.name || "job"} (${job.id}) is now running.`, {
          tags: "rocket", priority: "default", key: `${job.id}:${job.submittedAt || "unknown"}`,
        });
      }
    }
    state.jobs = jobs;
    state.clusterInitialized = true;
    state.initialized = true;
    state.jobNotificationVersion = 3;
  }
  if (cluster.accountingAvailable === true && validRecords(cluster.terminalJobs)) {
    const terminalJobs = indexOwnTerminalJobs(cluster);
    if (state.terminalInitialized) {
      for (const { key, job } of jobTerminalCandidates(terminalJobs, state.knownTerminalJobs)) {
        const event = terminalNotification(job);
        enqueue(event.kind, event.title, event.message, { ...event, key });
      }
    }
    for (const key of Object.keys(terminalJobs)) {
      if (!Object.hasOwn(state.knownTerminalJobs, key)) state.knownTerminalJobs[key] = now;
    }
    state.terminalInitialized = true;
    state.knownTerminalJobs = pruneKnownTerminalJobs(state.knownTerminalJobs, now);
  }
  const detectedNeed = passwordNeedForCluster(cluster);
  const previousCheck = (cluster.health?.checks || []).find((check) => (
    check.key === (state.passwordNeed === "vpn" ? "vpn" : "ticket")
  ));
  const recovered = cluster.reachable || cluster.configured === false || previousCheck?.ok === true;
  const need = detectedNeed || (recovered ? null : state.passwordNeed);
  if (need !== state.passwordNeed || (need && !state.passwordEpisodeId)) {
    state.passwordNeed = need;
    state.passwordEpisodeId = need ? `${need}:${now}` : null;
    state.passwordNotifiedAt = 0;
  }
  state.pending = state.pending.filter((event) => (
    !event.episodeId || event.episodeId === state.passwordEpisodeId
  ));
  if (need && !state.pending.some((event) => event.episodeId === state.passwordEpisodeId)
      && (!state.passwordNotifiedAt || now - state.passwordNotifiedAt >= config.reminderMs)) {
    enqueue(`${need}.password_needed`,
      need === "vpn" ? "Hearth VPN needs password" : "Hearth cluster needs password",
      need === "vpn"
        ? "Tap to open Hearth and enter the university VPN password."
        : "Tap to open Hearth and refresh the cluster login.",
      { tags: "key", priority: "high", link: "dashboard", key: state.passwordEpisodeId,
        episodeId: state.passwordEpisodeId });
  }
}
