import { projectionSynchronized } from "./state.mjs";
import { TrackerError } from "./github.mjs";
import { remoteCommit, remoteAncestor, finalMerge, verifyIntegration, verifyReviewedTip, verifyContext } from "./evidence.mjs";

export const finalCommands = ["final-pr", "final-checks", "final-review", "final-handoff", "cancel", "reverse"];
export function buildFinalPayload(command, options) {
  const common = { issue: Number(options.issue), result: options.result };
  if (command === "cancel") return { ...common, reason: options.reason };
  if (command === "reverse") return { ...common, reason: options.reason, deliveryPr: Number(options["delivery-pr"]), reversalPr: Number(options["reversal-pr"]), evidence: options.evidence };
  if (command === "final-pr") return { ...common, pullRequest: Number(options.pr) };
  if (command === "final-checks") return { ...common, revision: options.revision, checks: parse(options.checks) };
  if (command === "final-review") return { ...common, revision: options.revision, reviewer: options.reviewer, standards: options.standards, spec: options.spec, findings: parse(options.findings), independence: options.independence, evidence: options.evidence };
  return common;
}
function parse(value) { try { return JSON.parse(value); } catch { throw new TrackerError("event_invalid"); } }
export function validateFinal(event, text) {
  const p = event.payload;
  const extra = { "final-pr": ["pullRequest"], "final-checks": ["revision", "checks"], "final-review": ["revision", "reviewer", "standards", "spec", "findings", "independence", "evidence"], "final-handoff": [], "cancel": ["reason"], "reverse": ["reason", "deliveryPr", "reversalPr", "evidence"] }[event.type];
  if (!extra || Object.keys(p).some(key => !["issue", "result", ...extra].includes(key)) || !Number.isSafeInteger(p.issue) || p.issue <= 0 || (event.type === "final-pr" && (!Number.isSafeInteger(p.pullRequest) || p.pullRequest <= 0))) throw new TrackerError("event_invalid");
  text(p.result);
  if (["cancel", "reverse"].includes(event.type)) text(p.reason);
  if (event.type === "reverse") {
    text(p.evidence, 500);
    if (![p.deliveryPr, p.reversalPr].every(number => Number.isSafeInteger(number) && number > 0) || p.deliveryPr === p.reversalPr) throw new TrackerError("event_invalid");
  }
  if (["final-checks", "final-review"].includes(event.type) && !/^[a-f0-9]{40}$/.test(p.revision ?? "")) throw new TrackerError("event_invalid");
  if (event.type === "final-checks") {
    if (!Array.isArray(p.checks) || p.checks.length > 10 || new Set(p.checks.map(c => c?.name)).size !== p.checks.length) throw new TrackerError("event_invalid");
    for (const check of p.checks) {
      if (!check || Object.keys(check).some(key => !["name", "status", "evidence"].includes(key)) || !["passed", "failed", "outstanding"].includes(check.status)) throw new TrackerError("event_invalid");
      text(check.name, 100); text(check.evidence, 500);
    }
  }
  if (event.type === "final-review") {
    text(p.reviewer, 100); text(p.independence); text(p.evidence, 500);
    if (!["pass", "fail"].includes(p.standards) || !["pass", "fail"].includes(p.spec) || !Array.isArray(p.findings) || p.findings.length > 10) throw new TrackerError("event_invalid");
    for (const finding of p.findings) text(finding, 500);
    if ((p.standards === "fail" || p.spec === "fail") && !p.findings.length) throw new TrackerError("review_findings_required");
  }
}
function readPr(github, config, number, { allowChangedTarget = false } = {}) {
  const pr = github.request(`repos/${config.repository}/pulls/${number}`);
  const repository = github.request(`repos/${config.repository}`);
  if (pr.base.repo.full_name !== config.repository || pr.head.repo?.full_name !== config.repository || (!allowChangedTarget && pr.base.ref !== repository.default_branch)) throw new TrackerError("final_pr_target_invalid");
  const head = remoteCommit(github, config, pr.head.sha);
  return { number, url: pr.html_url, nodeId: pr.node_id, branch: pr.head.ref, revision: pr.head.sha, tree: head.commit.tree.sha, target: pr.base.ref, state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "ready", mergedAt: pr.merged_at, mergeCommit: pr.merged ? pr.merge_commit_sha : null };
}
function issueKey(issue, config) {
  const repository = (typeof issue.repository === "string" ? issue.repository : issue.repository?.full_name ?? issue.repository?.nameWithOwner) ?? issue.repository_url?.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/)?.[1] ?? issue.html_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? config.repository;
  return repository.toLowerCase() === config.repository.toLowerCase() ? issue.number : `${repository}#${issue.number}`;
}
function hasParent(child, parent, config) {
  return child.parent === parent.number && (child.parentRepository ?? config.repository).toLowerCase() === (parent.repository ?? config.repository).toLowerCase();
}
function childrenFor(state, record, github, config) {
  if (record.role !== "specification") return [];
  let native;
  try { native = github.pages(`repos/${config.repository}/issues/${record.number}/sub_issues`); }
  catch (error) { if (error.code !== "github_not_found") throw error; native = []; }
  return [...new Set([...native.map(child => issueKey(child, config)), ...Object.values(state.tickets).filter(child => hasParent(child, record, config)).map(child => issueKey(child, config))])];
}
function applicable(evidence, revision, pass) {
  if (!evidence) return "outstanding";
  if (evidence.revision !== revision && evidence.appliesTo !== revision) return "invalidated";
  return pass(evidence) ? "passed" : "failed";
}
function requiredChecks(record, config) { return config.finalChecks[record.role === "specification" ? "specification" : "standalone"]; }
function checkStatus(evidence, record, config) {
  if (!evidence) return "outstanding";
  if (evidence.revision !== record.final.revision && evidence.appliesTo !== record.final.revision) return "invalidated";
  if (evidence.results.some(check => check.status === "failed")) return "failed";
  return requiredChecks(record, config).every(name => evidence.results.some(check => check.name === name && check.status === "passed")) ? "passed" : "outstanding";
}
export function updateSummary(state, record, github, config) {
  const repository = record.repository ?? config.repository;
  if (repository.toLowerCase() !== config.repository.toLowerCase()) {
    // Discovery retains foreign parent context, but this controller has no
    // whole-specification evidence authority for another repository.
    record.summary = { scope: "context_only", repository };
    return;
  }
  const f = record.final;
  const children = childrenFor(state, record, github, config);
  const counts = { ready: 0, implementing: 0, review: 0, integrated: 0, done: 0, blocked: 0, cancelled: 0, untracked: 0 };
  for (const child of children) counts[state.tickets[child]?.status ?? "untracked"]++;
  record.summary = { counts, children, revision: f?.revision ?? null, checks: checkStatus(f?.checks, record, config), review: applicable(f?.review, f?.revision, evidence => evidence.outcome === "clean"), pullRequest: f?.pullRequest ?? null };
}
function requireImplementation(state, record, github, config) {
  const merged = record.final.pullRequest.state === "merged";
  if (record.role === "specification") {
    for (const number of record.summary.children) {
      const child = state.tickets[number];
      if (child?.reversal?.state === "merged") throw new TrackerError("delivery_reversed");
      if (child?.reversal?.state === "unverified") throw new TrackerError("reversal_unverified");
      if (!child || !["integrated", "done"].includes(child.status) || child.integrationContext?.specification !== record.number || child.integrationContext.branch !== record.final.branch) throw new TrackerError("final_children_required");
      verifyContext(github, config, child);
      if (merged) remoteAncestor(github, config, child.integration.commit, record.final.pullRequest.revision);
      else verifyIntegration(github, config, child, child.integration);
    }
    if (!record.summary.children.length) throw new TrackerError("final_children_required");
  } else {
    if (!["review", "done"].includes(record.status) || record.review?.outcome !== "clean" || record.integrationContext || record.branch !== record.final.branch) throw new TrackerError("clean_review_required");
    if (!merged) verifyReviewedTip(github, config, record, record.final.revision);
    if (record.review.revision !== record.final.pullRequest.revision) throw new TrackerError("review_revision_changed");
  }
}
export function requireFinalGate(state, record, github, config) {
  updateSummary(state, record, github, config);
  if (record.summary.scope === "context_only") throw new TrackerError("specification_repository_unsupported");
  if (record.cancellation) throw new TrackerError("implementation_cancelled");
  if (record.reversal?.state === "merged") throw new TrackerError("delivery_reversed");
  if (record.reversal?.state === "unverified") throw new TrackerError("reversal_unverified");
  if (record.summary.checks !== "passed") throw new TrackerError("final_checks_required");
  if (record.summary.review !== "passed") throw new TrackerError("final_review_required");
  requireImplementation(state, record, github, config);
}
export function applyFinal(state, event, { github, config }) {
  const p = event.payload;
  const record = state.tickets[p.issue];
  if (!record || (!["cancel", "reverse"].includes(event.type) && record.role !== "specification" && (record.runId !== event.runId || record.generation !== event.generation))) throw new TrackerError("ticket_not_claimed");
  if (event.type === "cancel") {
    if (record.delivery?.current) throw new TrackerError("implementation_already_delivered");
    invalidateDelivery(record, "Explicit cancellation", event.at);
    record.cancellation = { reason: p.reason, at: event.at, previousStatus: record.status, runId: event.runId, generation: event.generation };
    record.status = "cancelled"; record.activity = "inactive";
    if (record.final?.handoff?.state === "pending") record.final.handoff.state = "cancelled";
  } else if (event.type === "reverse") {
    if ((record.final?.pullRequest.number ?? record.delivery?.number) !== p.deliveryPr) throw new TrackerError("delivery_reference_mismatch");
    const original = readPr(github, config, p.deliveryPr);
    if (original.state !== "merged") throw new TrackerError("final_merge_required");
    const reversal = readPr(github, config, p.reversalPr);
    if (reversal.mergeCommit === original.mergeCommit) throw new TrackerError("reversal_reference_invalid");
    if (reversal.state === "closed") throw new TrackerError("reversal_not_merged");
    record.reversal = { deliveryPr: p.deliveryPr, pullRequest: reversal, reason: p.reason, evidence: p.evidence, at: event.at, attestation: p.result, runId: event.runId, generation: event.generation, state: "pending" };
    reconcileFinalFacts(state, github, config, event.at);
  } else if (event.type === "final-pr") {
    if (record.cancellation) throw new TrackerError("implementation_cancelled");
    if (record.reversal && record.reversal.deliveryPr !== p.pullRequest) { record.lastReversal = record.reversal; delete record.reversal; }
    const pr = readPr(github, config, p.pullRequest);
    record.final = { ...record.final, branch: pr.branch, runId: event.runId, generation: event.generation };
    refreshPr(record.final, pr, github, config);
    record.pullRequest = pr.url;
    updateSummary(state, record, github, config);
  } else {
    const f = record.final;
    if (!f || f.runId !== event.runId || f.generation !== event.generation) throw new TrackerError("final_pr_required");
    const pr = readPr(github, config, f.pullRequest.number);
    if (event.type === "final-checks" || event.type === "final-review") {
      if (p.revision !== (pr.mergeCommit ?? pr.revision) || p.revision !== f.revision) throw new TrackerError("final_revision_changed");
      if (event.type === "final-checks") {
        const required = requiredChecks(record, config);
        if (p.checks.some(check => !required.includes(check.name))) throw new TrackerError("final_check_unknown");
        const status = p.checks.some(check => check.status === "failed") ? "failed" : required.every(name => p.checks.some(check => check.name === name && check.status === "passed")) ? "passed" : "outstanding";
        f.checks = { revision: p.revision, tree: f.tree, status, required, results: p.checks, at: event.at, result: p.result };
      } else {
        const implementers = record.role === "specification" ? Object.values(state.tickets).filter(child => hasParent(child, record, config)).flatMap(child => [child.agent, child.review?.implementer]) : [record.agent, record.review?.implementer];
        if (implementers.includes(p.reviewer)) throw new TrackerError("reviewer_not_independent");
        f.review = { ...p, at: event.at, tree: f.tree, outcome: p.standards === "pass" && p.spec === "pass" && !p.findings.length ? "clean" : "findings" };
      }
      f.pullRequest = pr;
      updateSummary(state, record, github, config);
    } else {
      if (!projectionSynchronized(state)) throw new TrackerError("synchronization_required");
      if (pr.revision !== f.revision || pr.branch !== f.branch) throw new TrackerError("final_revision_changed");
      if (!["draft", "ready"].includes(pr.state)) throw new TrackerError("final_pr_open_required");
      requireFinalGate(state, record, github, config);
      f.handoff = { eventId: event.id, runId: event.runId, generation: event.generation, revision: f.revision, nodeId: pr.nodeId, pullRequest: pr.number, branch: pr.branch, target: pr.target, state: "pending", at: event.at };
    }
  }
  record.stateAt = event.at; record.result = p.result; record.revision = state.revision + 1;
}
export function renderFinal(record) {
  if (!record.summary) return "";
  const s = record.summary;
  if (s.scope === "context_only") return `\n- Foreign specification context only: child counts and final gates are not tracked for ${s.repository}. Inspect the [original specification](${record.url}).\n`;
  return `\n- Child phases: ${JSON.stringify(s.counts)}\n- Shared checks: ${s.checks}\n- Combined review: ${s.review}\n- Resulting revision: ${s.revision ?? "not bound"}\n- Final PR: ${s.pullRequest ? `[${s.pullRequest.state}](${s.pullRequest.url})` : "outstanding"}\n${record.cancellation ? `- Cancellation evidence: ${JSON.stringify(record.cancellation)}\n` : ""}${record.reversal ? `- Explicit reversal evidence: ${JSON.stringify(record.reversal)}\n` : ""}${record.final?.gate ? `- Final gate: ${JSON.stringify(record.final.gate)}\n` : ""}${record.delivery ? `- Delivery evidence: ${JSON.stringify(record.delivery)}\n` : ""}${record.final?.handoff ? `- Final handoff: ${JSON.stringify(record.final.handoff)}\n` : ""}${record.final?.checks ? `- Shared check evidence: ${JSON.stringify(record.final.checks)}\n` : ""}${record.final?.review ? `- Combined review evidence: ${JSON.stringify(record.final.review)}\n` : ""}`;
}

function sameHandoffPr(pr, handoff) {
  return pr.nodeId === handoff.nodeId && pr.number === handoff.pullRequest && pr.branch === handoff.branch && pr.target === handoff.target && pr.revision === handoff.revision;
}
function verifyHandoffTarget(github, config, handoff) {
  handoff.targetRevision = remoteCommit(github, config, handoff.target).sha;
  try { remoteAncestor(github, config, handoff.targetRevision, handoff.revision); }
  catch (error) {
    if (error.code === "revision_not_in_history") throw new TrackerError("final_target_changed");
    throw error;
  }
}
function restoreDraft(github, config, pr) {
  github.graph(`mutation TrackerRestoreDraft($input:ConvertPullRequestToDraftInput!){convertPullRequestToDraft(input:$input){pullRequest{id isDraft}}}`, { input: { pullRequestId: pr.nodeId } });
  const restored = readPr(github, config, pr.number, { allowChangedTarget: true });
  if (restored.nodeId !== pr.nodeId || restored.state !== "draft") throw new TrackerError("github_draft_restore_unverified");
  return restored;
}
// Runs only after the durable intent and all ordinary required projections.
// GitHub has no expected-head input for this mutation; read back and fail closed.
export function finishFinalHandoffs(state, github, config, persist) {
  let changed = false;
  for (const record of Object.values(state.tickets)) {
    const f = record.final;
    const handoff = f?.handoff;
    if (handoff?.state !== "pending") continue;
    changed = true;
    const owned = () => state.owner?.runId === handoff.runId && state.owner.generation === handoff.generation;
    const bound = () => f.pullRequest.number === handoff.pullRequest && f.pullRequest.nodeId === handoff.nodeId && f.branch === handoff.branch;
    try {
      if (!owned()) throw new TrackerError("run_superseded");
      if (!bound()) throw new TrackerError("final_handoff_superseded");
      const pr = readPr(github, config, handoff.pullRequest);
      if (!sameHandoffPr(pr, handoff)) throw new TrackerError("final_revision_changed");
      if (!["draft", "ready"].includes(pr.state)) throw new TrackerError("final_pr_open_required");
      requireFinalGate(state, record, github, config);
      verifyHandoffTarget(github, config, handoff);
      if (pr.state === "draft") {
        // Persist the possible effect before calling GitHub. Failed/lost
        // compensation can then be retried without approving obsolete gates.
        handoff.effectAttempted = true;
        persist();
        const returned = github.graph(`mutation TrackerReady($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input:$input){pullRequest{id isDraft headRefOid baseRefName}}}`, { input: { pullRequestId: pr.nodeId, clientMutationId: handoff.eventId } }).markPullRequestReadyForReview.pullRequest;
        if (returned.id !== handoff.nodeId) throw new TrackerError("github_ready_identity_unverified");
        if (returned.headRefOid !== handoff.revision || returned.baseRefName !== handoff.target) throw new TrackerError("final_revision_changed");
        if (returned.isDraft) throw new TrackerError("final_ready_unverified");
      }
      // This read is checked for both a fresh mutation and an already-ready
      // retry. Never assign an unchecked final read to an acknowledged handoff.
      const actual = readPr(github, config, handoff.pullRequest);
      if (!sameHandoffPr(actual, handoff)) throw new TrackerError("final_revision_changed");
      if (actual.state !== "ready") throw new TrackerError("final_ready_unverified");
      verifyHandoffTarget(github, config, handoff);
      handoff.state = "ready";
      f.pullRequest = actual;
    } catch (error) {
      if (!(error instanceof TrackerError) || error.code.startsWith("github_")) throw error;
      if (handoff.effectAttempted && owned() && bound()) {
        let actual = readPr(github, config, handoff.pullRequest, { allowChangedTarget: true });
        if (actual.nodeId !== handoff.nodeId) throw new TrackerError("github_ready_identity_unverified");
        if (actual.state === "ready") actual = restoreDraft(github, config, actual);
        refreshPr(f, actual, github, config);
      }
      handoff.state = "refused"; handoff.error = error.code;
      const receipt = state.receipts[handoff.eventId];
      if (receipt) { receipt.state = "rejected"; receipt.error = error.code; }
    }
    updateSummary(state, record, github, config);
  }
  return changed;
}
function refreshPr(f, pr, github, config) {
  f.pullRequest = pr;
  f.revision = pr.mergeCommit ?? pr.revision;
  f.tree = pr.mergeCommit ? remoteCommit(github, config, pr.mergeCommit).commit.tree.sha : pr.tree;
  for (const evidence of [f.checks, f.review]) {
    if (pr.mergeCommit && evidence?.revision === pr.revision && evidence.tree === f.tree) {
      evidence.appliesTo = pr.mergeCommit;
      evidence.applicability = "Merged result has the exact checked/reviewed tree";
    }
  }
}
function invalidateDelivery(record, reason, at) {
  if (!record?.delivery?.current) return;
  record.delivery = { ...record.delivery, current: false, invalidatedAt: at, reason };
  record.status = record.cancellation ? "cancelled" : record.delivery.previousStatus;
  record.activity = "inactive";
  record.result = `Delivery invalidated: ${reason}`;
  record.stateAt = at;
}
function recordDelivery(record, pr, result, at) {
  if (record.delivery?.current && record.delivery.resultCommit === pr.mergeCommit) return;
  const previousStatus = record.delivery?.previousStatus ?? record.status ?? null;
  record.delivery = { current: true, pullRequest: pr.url, number: pr.number, headRevision: pr.revision, resultCommit: pr.mergeCommit, tree: result.commit.tree.sha, previousStatus, verifiedAt: at };
  record.status = "done"; record.activity = "inactive"; record.stateAt = at;
  record.result = "Required evidence applies to the final merged result and current issue closure";
}
export function reconcileFinalFacts(state, github, config, at) {
  const before = new Map(Object.values(state.tickets).map(record => [record, JSON.stringify(record)]));
  // A delivered child need not have its own final PR record. Resolve every
  // explicitly registered reversal before evaluating its specification gate.
  for (const record of Object.values(state.tickets).filter(record => record.reversal)) {
    try {
      const reversal = readPr(github, config, record.reversal.pullRequest.number);
      record.reversal.pullRequest = reversal;
      if (reversal.state === "merged" && reversal.mergeCommit) {
        remoteAncestor(github, config, reversal.mergeCommit, remoteCommit(github, config, reversal.target).sha);
        record.reversal.state = "merged";
        invalidateDelivery(record, "delivery_reversed", at);
      }
    } catch (error) {
      if (!(error instanceof TrackerError) || error.code.startsWith("github_")) throw error;
      record.reversal.state = "unverified";
      record.reversal.error = error.code;
      invalidateDelivery(record, "reversal_unverified", at);
    }
  }

  for (const record of Object.values(state.tickets).filter(record => record.final)) {
    const f = record.final;
    const pr = readPr(github, config, f.pullRequest.number);
    refreshPr(f, pr, github, config);
    updateSummary(state, record, github, config);
    let refusal;
    try {
      requireFinalGate(state, record, github, config);
      if (pr.state !== "merged" || !pr.mergedAt || !pr.mergeCommit) throw new TrackerError("final_merge_required");
      const result = remoteCommit(github, config, pr.mergeCommit);
      remoteAncestor(github, config, pr.mergeCommit, remoteCommit(github, config, pr.target).sha);
      const subjects = [record, ...record.summary.children.map(number => state.tickets[number])];
      const closure = new Map();
      for (const subject of subjects) {
        const delivered = finalMerge(github, config.repository, subject.number);
        closure.set(subject.number, delivered?.pullRequest === pr.number && delivered?.commit === pr.mergeCommit && delivered.target === pr.target);
      }
      for (const subject of subjects.slice(1)) {
        if (closure.get(subject.number)) recordDelivery(subject, pr, result, at);
        else invalidateDelivery(subject, "Current issue closure is not the verified final delivery", at);
      }
      if (!subjects.every(subject => closure.get(subject.number))) throw new TrackerError("final_issue_closure_required");
      recordDelivery(record, pr, result, at);
      f.gate = { status: "passed", revision: f.revision };
    } catch (error) {
      if (!(error instanceof TrackerError) || error.code.startsWith("github_")) throw error;
      refusal = error.code;
    }
    if (refusal) {
      f.gate = { status: "outstanding", error: refusal, revision: f.revision };
      invalidateDelivery(record, refusal, at);
      if (!["final_issue_closure_required", "final_children_required", "implementation_cancelled", "delivery_reversed", "reversal_unverified"].includes(refusal) || record.reversal?.state === "merged") {
        for (const number of record.summary.children) invalidateDelivery(state.tickets[number], refusal, at);
      }
    }
    updateSummary(state, record, github, config);
  }
  for (const record of Object.values(state.tickets).filter(record => record.role === "specification")) updateSummary(state, record, github, config);
  for (const [record, prior] of before) if (JSON.stringify(record) !== prior) record.revision = state.revision + 1;
}
