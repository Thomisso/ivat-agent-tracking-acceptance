import { TrackerError } from "./github.mjs";
import { localCommit, localAncestor, verifyReviewedTip, remoteAncestor, localIntegration, verifyIntegration, dependencyReadiness, currentParent } from "./evidence.mjs";

export const lifecycleCommands = ["review", "review-start", "review-result", "integrate", "block", "resume-phase", "readiness"];
export function buildLifecyclePayload(command, options, state) {
  if (command === "readiness") return { issue: Number(options.issue), integrationContext: options.spec || options["integration-branch"] ? { specification: Number(options.spec), branch: options["integration-branch"] } : null };
  const ticket = state?.tickets[options.issue];
  if (!ticket) throw new TrackerError("ticket_not_claimed");
  if (command === "block") return { issue: Number(options.issue), reason: options.reason, reference: options.reference ?? null, condition: options.condition, result: options.result };
  if (command === "resume-phase") return { issue: Number(options.issue), resolution: options.resolution, result: options.result };
  if (command === "integrate") return { issue: Number(options.issue), ...localIntegration(ticket, options["integration-commit"]), result: options.result };
  if (command === "review-start") return { issue: Number(options.issue), reviewer: options.reviewer, result: options.result };
  if (command === "review-result") {
    let findings;
    try { findings = JSON.parse(options.findings); } catch { throw new TrackerError("event_invalid"); }
    return { issue: Number(options.issue), reviewer: options.reviewer, revision: localCommit(options.revision), standards: options.standards, spec: options.spec, findings, independence: options.independence, result: options.result };
  }
  const revision = localCommit(options.revision);
  if (localCommit(`refs/heads/${ticket.branch}`) !== revision) throw new TrackerError("review_revision_changed");
  const base = localCommit(options.base);
  localAncestor(base, revision);
  return { issue: Number(options.issue), base, revision, checks: options.checks, result: options.result };
}
export function validateLifecycle(event, text) {
  const p = event.payload;
  if (!Number.isInteger(p.issue) || p.issue <= 0) throw new TrackerError("event_invalid");
  if (event.type === "readiness") {
    if (Object.keys(p).some(key => !["issue", "integrationContext"].includes(key))) throw new TrackerError("event_invalid");
    const context = p.integrationContext;
    if (context) {
      if (Object.keys(context).some(key => !["specification", "branch"].includes(key)) || !Number.isInteger(context.specification) || context.specification <= 0) throw new TrackerError("event_invalid");
      text(context.branch, 200);
    }
    return;
  }
  text(p.result);
  if (event.type === "block" || event.type === "resume-phase") {
    const allowed = event.type === "block" ? ["issue", "reason", "reference", "condition", "result"] : ["issue", "resolution", "result"];
    if (Object.keys(p).some(key => !allowed.includes(key))) throw new TrackerError("event_invalid");
    if (event.type === "block") { text(p.reason); text(p.condition); if (p.reference !== null) text(p.reference, 300); }
    else text(p.resolution);
    return;
  }
  if (event.type === "integrate") {
    if (Object.keys(p).some(key => !["issue", "commit", "tree", "result"].includes(key)) || !/^[a-f0-9]{40}$/.test(p.commit ?? "") || !/^[a-f0-9]{40}$/.test(p.tree ?? "")) throw new TrackerError("event_invalid");
    return;
  }
  if (event.type === "review-start" || event.type === "review-result") {
    const allowed = event.type === "review-start" ? ["issue", "reviewer", "result"] : ["issue", "reviewer", "result", "revision", "standards", "spec", "findings", "independence"];
    if (Object.keys(p).some(key => !allowed.includes(key))) throw new TrackerError("event_invalid");
    text(p.reviewer, 100);
    if (event.type === "review-result") {
      if (!/^[a-f0-9]{40}$/.test(p.revision ?? "")) throw new TrackerError("event_invalid");
      if (!["pass", "fail"].includes(p.standards) || !["pass", "fail"].includes(p.spec) || !Array.isArray(p.findings) || p.findings.length > 20) throw new TrackerError("event_invalid");
      for (const finding of p.findings) text(finding, 500);
      text(p.independence);
      if ((p.standards === "fail" || p.spec === "fail") && !p.findings.length) throw new TrackerError("review_findings_required");
    }
    return;
  }
  if (Object.keys(p).some(key => !["issue", "base", "revision", "checks", "result"].includes(key)) || !Number.isInteger(p.issue) || p.issue <= 0 || !/^[a-f0-9]{40}$/.test(p.base ?? "") || !/^[a-f0-9]{40}$/.test(p.revision ?? "")) throw new TrackerError("event_invalid");
  text(p.checks); text(p.result);
}
export function applyLifecycle(state, event, { github, config }) {
  if (event.type === "readiness") return applyReadiness(state, event, { github, config });
  const ticket = state.tickets[event.payload.issue];
  if (!ticket || ticket.runId !== event.runId || ticket.generation !== event.generation) throw new TrackerError("ticket_not_claimed");
  const p = event.payload;
  if (event.type === "block") {
    if (!["implementing", "review", "integrated"].includes(ticket.status)) throw new TrackerError("phase_invalid");
    ticket.blockage = { kind: "obstacle", reason: p.reason, reference: p.reference, condition: p.condition, resumePhase: ticket.status, at: event.at };
    ticket.status = "blocked"; ticket.activity = "inactive";
    ticket.stateAt = event.at; ticket.result = p.result; ticket.revision = state.revision + 1;
    return;
  }
  if (event.type === "resume-phase") {
    if (ticket.status !== "blocked" || !ticket.blockage) throw new TrackerError("phase_invalid");
    let phase = ticket.blockage.resumePhase;
    if (phase === "review") {
      try { verifyReviewedTip(github, config, ticket, ticket.review.revision); }
      catch (error) { if (error.code !== "review_revision_changed") throw error; phase = "implementing"; ticket.review.outcome = "invalidated"; }
    }
    if (phase === "integrated") verifyIntegration(github, config, ticket, ticket.integration);
    ticket.lastBlockage = { ...ticket.blockage, resolution: p.resolution, resolvedAt: event.at };
    ticket.blockage = null; ticket.status = phase; ticket.activity = phase === "implementing" ? "unverified" : "inactive";
    ticket.stateAt = event.at; ticket.result = p.result; ticket.revision = state.revision + 1;
    return;
  }
  if (event.type === "integrate") {
    if (ticket.status !== "review") throw new TrackerError("phase_invalid");
    ticket.integration = { ...verifyIntegration(github, config, ticket, p), at: event.at, result: p.result };
    ticket.status = "integrated"; ticket.activity = "inactive";
    ticket.stateAt = event.at; ticket.result = p.result; ticket.revision = state.revision + 1;
    return;
  }
  if (event.type !== "review") {
    if (ticket.status !== "review" || !ticket.review) throw new TrackerError("phase_invalid");
    if (p.reviewer === ticket.agent || p.reviewer === ticket.review.implementer) throw new TrackerError("reviewer_not_independent");
    if (ticket.reviewer && ticket.reviewer !== p.reviewer) throw new TrackerError("reviewer_mismatch");
    if (event.type === "review-result" && p.revision !== ticket.review.revision) throw new TrackerError("review_revision_changed");
    verifyReviewedTip(github, config, ticket, ticket.review.revision);
    ticket.reviewer = p.reviewer;
    if (event.type === "review-start") {
      ticket.review.outcome = "working";
      ticket.activity = "confirmed"; ticket.activityAt = event.at;
      ticket.activityObservation = { agent: p.reviewer, at: event.at, result: p.result };
    } else {
      const clean = p.standards === "pass" && p.spec === "pass" && p.findings.length === 0;
      Object.assign(ticket.review, { reviewer: p.reviewer, standards: p.standards, spec: p.spec, findings: p.findings, independence: p.independence, result: p.result, at: event.at, outcome: clean ? "clean" : "findings" });
      ticket.status = clean ? "review" : "implementing";
      ticket.activity = clean ? "inactive" : "unverified";
    }
    ticket.stateAt = event.at; ticket.result = p.result; ticket.revision = state.revision + 1;
    return;
  }
  if (ticket.status !== "implementing") throw new TrackerError("phase_invalid");
  verifyReviewedTip(github, config, ticket, p.revision);
  remoteAncestor(github, config, p.base, p.revision);
  if (ticket.review) ticket.lastReview = ticket.review;
  ticket.review = { implementer: ticket.agent, base: p.base, revision: p.revision, checks: p.checks, implementationComplete: true, checksStatus: "passed", handoffAt: event.at, outcome: "waiting" };
  ticket.workingRevision = p.revision;
  ticket.status = "review"; ticket.activity = "inactive"; ticket.reviewer = null;
  ticket.stateAt = event.at; ticket.result = p.result; ticket.revision = state.revision + 1;
}

function applyReadiness(state, event, { github, config }) {
  const p = event.payload;
  let record = state.tickets[p.issue];
  if (!record) {
    const issue = github.request(`repos/${config.repository}/issues/${p.issue}`);
    if (issue.pull_request || issue.state !== "open") throw new TrackerError("implementation_issue_required");
    const observedParent = currentParent(github, config, p.issue);
    if (p.integrationContext && observedParent.repository !== config.repository) throw new TrackerError("parent_repository_unsupported");
    const parent = observedParent.number;
    record = { number: issue.number, nodeId: issue.node_id, title: issue.title, url: issue.html_url, parent, role: "implementation", status: "ready", activity: "inactive", runId: null, generation: null, stateAt: event.at, activityAt: null, integrationContext: p.integrationContext };
  }
  if (record.role === "specification") throw new TrackerError("implementation_issue_required");
  if (p.integrationContext && p.integrationContext.specification !== record.parent) throw new TrackerError("specification_mismatch");
  if (p.integrationContext && record.integrationContext && (p.integrationContext.specification !== record.integrationContext.specification || p.integrationContext.branch !== record.integrationContext.branch)) throw new TrackerError("integration_context_mismatch");
  const candidate = { ...record, integrationContext: record.integrationContext ?? p.integrationContext };
  const dependencies = dependencyReadiness(state, candidate, { github, config });
  Object.assign(record, { integrationContext: candidate.integrationContext, dependencies });
  if (record.status === "ready" || (record.status === "blocked" && record.blockage?.kind === "dependency")) {
    record.status = dependencies.ready ? "ready" : "blocked";
    record.blockage = dependencies.ready ? null : { kind: "dependency", reason: "Implementation dependencies are not satisfied", reference: dependencies.blockers.filter(blocker => !blocker.satisfied).map(blocker => `${blocker.repository}#${blocker.number}`).join(", "), condition: "Every blocker passes same-spec integration or external final merge", resumePhase: "ready", at: event.at };
    record.activity = "inactive"; record.stateAt = event.at;
    record.result = dependencies.ready ? "Implementation dependencies satisfied; waiting to be claimed" : "Waiting for implementation dependencies";
  }
  record.revision = state.revision + 1;
  state.tickets[p.issue] = record;
}
