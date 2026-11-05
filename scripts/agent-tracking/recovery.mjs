import { TrackerError } from "./github.mjs";
import { execFileSync } from "node:child_process";
import { currentParent, localBranchRevision } from "./evidence.mjs";

export const recoveryTypes = new Set(["stop", "restart", "takeover", "resume", "repair"]);

export function validateRecoveryPayload(event, text) {
  const fields = { stop: ["reason"], restart: ["reason", "source", "localFacts"], takeover: ["fromRunId", "fromGeneration", "reason", "source", "localFacts"], resume: ["localFacts", "source"], repair: [] }[event.type];
  if (!fields || Object.keys(event.payload).some(key => !fields.includes(key))) throw new TrackerError("event_invalid");
  if (["stop", "restart", "takeover"].includes(event.type)) text(event.payload.reason);
  if (["restart", "takeover"].includes(event.type) && event.sequence !== 0) throw new TrackerError("event_invalid");
  if (event.type === "restart" && !["remote-recovery", "local-restart"].includes(event.payload.source)) throw new TrackerError("event_invalid");
  if (event.type === "resume" && event.payload.source !== undefined && event.payload.source !== "local") throw new TrackerError("event_invalid");
  if (event.type === "takeover") {
    text(event.payload.fromRunId, 100);
    if (!Number.isSafeInteger(event.payload.fromGeneration) || event.payload.fromGeneration <= 0) throw new TrackerError("event_invalid");
    if (event.payload.source !== undefined && !["remote-recovery", "takeover"].includes(event.payload.source)) throw new TrackerError("event_invalid");
  }
  if (event.payload.localFacts !== undefined) {
    if (!event.payload.localFacts || typeof event.payload.localFacts !== "object" || Array.isArray(event.payload.localFacts)) throw new TrackerError("event_invalid");
    for (const [issue, fact] of Object.entries(event.payload.localFacts)) {
      if (!/^[1-9][0-9]*$/.test(issue) || !fact || typeof fact !== "object" || Object.keys(fact).some(key => !["branchRevision", "availableCommits"].includes(key)) || (fact.branchRevision !== null && (typeof fact.branchRevision !== "string" || !/^[a-f0-9]{40}$/.test(fact.branchRevision))) || !Array.isArray(fact.availableCommits) || fact.availableCommits.length > 8 || fact.availableCommits.some(revision => typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision))) throw new TrackerError("event_invalid");
    }
  }
}

function referencedRevisions(record) {
  return [...new Set([record.workingRevision, record.review?.base, record.review?.revision, record.integration?.commit, record.integration?.reviewedRevision, record.integration?.branchTip].filter(revision => typeof revision === "string" && /^[a-f0-9]{40}$/.test(revision)))];
}

export function collectLocalFacts(state, runId) {
  const facts = {};
  for (const record of Object.values(state.tickets).filter(record => record.runId === runId)) {
    let branchRevision = null;
    if (typeof record.branch === "string") {
      try { branchRevision = localBranchRevision(record.branch); } catch { /* Unavailable on this computer. */ }
    }
    const availableCommits = referencedRevisions(record).filter(revision => {
      try { execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { stdio: "pipe" }); return true; } catch { return false; }
    });
    facts[record.number] = { branchRevision, availableCommits };
  }
  return facts;
}

function reconcileRecords(state, event, github, config, runId) {
  for (const record of Object.values(state.tickets).filter(record => record.runId === runId)) {
    const unverified = [];
    const evidence = { observedAt: event.at, source: event.payload.source ?? "local", unverified };
    try {
      const issue = github.request(`repos/${config.repository}/issues/${record.number}`);
      record.title = issue.title; record.nodeId = issue.node_id; record.url = issue.html_url;
      evidence.issueState = issue.state;
    } catch (error) { unverified.push(`issue_unverified:${error.code ?? "unavailable"}`); }
    try {
      evidence.parent = currentParent(github, config, record.number);
      if (evidence.parent.number !== record.parent || (evidence.parent.number !== null && evidence.parent.repository !== (record.parentRepository ?? config.repository))) unverified.push("parent_context_changed");
    } catch (error) { unverified.push(`parent_unverified:${error.code ?? "unavailable"}`); }
    const local = event.payload.localFacts?.[record.number];
    if (!local?.branchRevision) unverified.push("local_branch_unavailable");
    else {
      evidence.localBranchRevision = local.branchRevision;
      if (record.workingRevision && local.branchRevision !== record.workingRevision) unverified.push("working_branch_changed");
    }
    if (!local?.branchRevision && record.branch) {
      try { evidence.remoteBranchRevision = github.request(`repos/${config.repository}/git/ref/heads/${encodeURIComponent(record.branch)}`).object.sha; }
      catch (error) { unverified.push(`remote_branch_unverified:${error.code ?? "unavailable"}`); }
    }
    for (const revision of referencedRevisions(record)) {
      if (local?.availableCommits.includes(revision)) continue;
      try { github.request(`repos/${config.repository}/git/commits/${revision}`); }
      catch { unverified.push(`commit_unavailable:${revision}`); }
    }
    if (record.pullRequest != null) {
      const value = String(record.pullRequest);
      const number = /^#?[1-9][0-9]*$/.test(value) ? Number(value.replace("#", "")) : value.startsWith(`https://github.com/${config.repository}/pull/`) ? Number(value.split("/").at(-1)) : null;
      if (!Number.isSafeInteger(number) || number <= 0) unverified.push("pull_request_reference_unverified");
      else {
        try { const pr = github.request(`repos/${config.repository}/pulls/${number}`); evidence.pullRequest = { number, state: pr.state, headRevision: pr.head.sha, mergedAt: pr.merged_at }; }
        catch (error) { unverified.push(`pull_request_unverified:${error.code ?? "unavailable"}`); }
      }
    }
    if (event.payload.source === "remote-recovery") unverified.push("unpublished_history_not_recovered");
    record.recoveryEvidence = evidence;
    if (record.activity !== "inactive") {
      record.activity = "unverified";
      if (record.activityEpisode) record.activityEpisode.startedAt = event.at;
    }
  }
}

function archiveOwner(state, event, actor, kind) {
  if (Date.parse(event.at) < Date.parse(state.owner.startedAt)) throw new TrackerError("event_invalid");
  state.runHistory ??= {};
  const owner = state.owner;
  state.runHistory[owner.generation] = { ...owner, endedAt: event.at, endedBy: actor, reason: event.payload.reason, kind, eventId: event.id };
  for (const record of Object.values(state.tickets)) {
    if (record.runId === owner.runId && record.generation === owner.generation) record.activity = "inactive";
  }
}

export function applyRecoveryEvent(state, event, { actor, github, config }) {
  if (event.type === "stop") {
    archiveOwner(state, event, actor, "stopped");
    state.owner = null;
  } else if (event.type === "restart") {
    const stopped = state.runHistory?.[state.generation];
    if (state.owner || !stopped || stopped.kind !== "stopped" || stopped.runId !== event.runId || stopped.account !== actor || event.generation !== state.generation) throw new TrackerError("stopped_run_required");
    if (Date.parse(event.at) < Date.parse(stopped.endedAt)) throw new TrackerError("event_invalid");
    state.generation++;
    state.owner = { runId: event.runId, generation: state.generation, account: actor, startedAt: event.at, sequence: 0 };
    state.recovery = { at: event.at, source: event.payload.source, previousRun: stopped.runId, previousGeneration: stopped.generation, missingLocalHistory: event.payload.source === "remote-recovery" };
    reconcileRecords(state, event, github, config, stopped.runId);
  } else if (event.type === "takeover") {
    if (!state.owner || state.owner.runId !== event.payload.fromRunId || state.owner.generation !== event.payload.fromGeneration || event.generation !== state.generation) throw new TrackerError("run_superseded");
    if (state.owner.account !== actor) throw new TrackerError("run_actor_mismatch");
    archiveOwner(state, event, actor, "superseded");
    state.generation++;
    state.owner = { runId: event.runId, generation: state.generation, account: actor, startedAt: event.at, sequence: 0 };
    state.recovery = { at: event.at, source: event.payload.source ?? "takeover", previousRun: event.payload.fromRunId, previousGeneration: event.payload.fromGeneration, missingLocalHistory: true };
    reconcileRecords(state, event, github, config, event.payload.fromRunId);
  } else if (event.type === "resume") reconcileRecords(state, event, github, config, event.runId);
}

export function receiptOwnershipMatches(state, event, receipt) {
  if (!["runId", "generation", "sequence"].some(key => Object.hasOwn(event, key))) return true;
  if (event.type === "stop") return state.owner === null && state.generation === event.generation && state.runHistory?.[event.generation]?.eventId === event.id;
  const generation = ["start", "restart", "takeover"].includes(event.type) ? receipt.generation : event.generation;
  return Boolean(state.owner && state.owner.runId === event.runId && state.owner.generation === generation);
}

export function submissionOwnershipMatches(state, event) {
  if (!["runId", "generation", "sequence"].some(key => Object.hasOwn(event, key))) return true;
  if (state.receipts[event.id]?.state === "pending") return receiptOwnershipMatches(state, event, state.receipts[event.id]);
  if (event.type === "start") return !state.owner && state.generation === event.generation;
  if (event.type === "restart") return !state.owner && state.generation === event.generation && state.runHistory?.[state.generation]?.runId === event.runId;
  if (event.type === "takeover") return state.owner?.runId === event.payload.fromRunId && state.owner.generation === event.payload.fromGeneration && state.generation === event.generation;
  return Boolean(state.owner && state.owner.runId === event.runId && state.owner.generation === event.generation);
}

export function isHistoricalTicket(state, ticket) {
  const owner = state.runHistory?.[ticket.generation];
  return ticket.activity === "inactive" && owner?.runId === ticket.runId && owner.generation === ticket.generation;
}
