import { discoverTickets } from "./discovery.mjs";
import { currentParent, dependencyReadiness } from "./evidence.mjs";
import { lifecycleCommands, validateLifecycle, applyLifecycle } from "./lifecycle.mjs";
import { TrackerError } from "./github.mjs";

export function text(value, limit = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f]|\b(?:gh[pousr]_|github_pat_|sb_secret_)[A-Za-z0-9_]+/.test(value)) throw new TrackerError("event_invalid");
  return value;
}

export function validateEvent(event) {
  const allowed = ["id", "type", "runId", "generation", "sequence", "at", "payload"];
  if (!event || Object.keys(event).some(key => !allowed.includes(key)) || Buffer.byteLength(JSON.stringify(event)) > 8 * 1024) throw new TrackerError("event_invalid");
  text(event.id, 100);
  if (event.type === "discover") {
    if (!/^[\w-]+$/.test(event.id) || Object.keys(event).some(key => !["id", "type", "at", "payload"].includes(key)) || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) || Object.keys(event.payload).some(key => key !== "parent") || (event.payload.parent !== undefined && (!Number.isInteger(event.payload.parent) || event.payload.parent <= 0))) throw new TrackerError("event_invalid");
    return event;
  }
  text(event.runId, 100);
  if (!/^[\w-]+$/.test(event.id) || !/^[\w-]+$/.test(event.runId) || !Number.isInteger(event.generation) || event.generation < 0 || !Number.isInteger(event.sequence) || event.sequence < 0 || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new TrackerError("event_invalid");
  if (event.type === "start") {
    if (Object.keys(event.payload).length || event.sequence !== 0) throw new TrackerError("event_invalid");
  } else if (event.type === "claim") {
    if (Object.keys(event.payload).some(key => !["issue", "agent", "branch", "branchRevision", "integrationContext", "result"].includes(key)) || !Number.isInteger(event.payload.issue) || event.payload.issue <= 0 || !/^[a-f0-9]{40}$/.test(event.payload.branchRevision ?? "")) throw new TrackerError("event_invalid");
    if (event.payload.integrationContext) {
      const context = event.payload.integrationContext;
      if (Object.keys(context).some(key => !["specification", "branch"].includes(key)) || !Number.isInteger(context.specification) || context.specification <= 0) throw new TrackerError("event_invalid");
      text(context.branch, 200);
    }
    text(event.payload.agent, 100); text(event.payload.branch, 200); text(event.payload.result);
  } else if (lifecycleCommands.includes(event.type)) validateLifecycle(event, text);
  else throw new TrackerError("event_type_unknown");
  return event;
}

export function applyEvent(state, event, { github, config, actor }) {
  validateEvent(event);
  if (event.type === "discover") {
    discoverTickets(state, { github, config, at: event.at });
    state.membershipDiscovered = true;
    if (event.payload.parent) state.selectedParent = event.payload.parent;
  } else if (event.type === "start") {
    if (state.owner) throw new TrackerError("run_already_owned");
    if (event.generation !== state.generation) throw new TrackerError("run_superseded");
    state.generation++;
    state.owner = { runId: event.runId, generation: state.generation, account: actor, startedAt: event.at, sequence: 0 };
  } else {
    if (!state.owner || state.owner.runId !== event.runId || state.owner.generation !== event.generation) throw new TrackerError("run_superseded");
    if (state.owner.account !== actor) throw new TrackerError("run_actor_mismatch");
    if (event.sequence !== state.owner.sequence + 1) throw new TrackerError("event_out_of_order");
    if (event.type !== "claim") {
      applyLifecycle(state, event, { github, config });
      state.owner.sequence = event.sequence;
    } else {
    const existing = state.tickets[event.payload.issue];
    if (existing?.runId != null) throw new TrackerError("ticket_already_claimed");
    if (existing?.role === "specification") throw new TrackerError("implementation_issue_required");
    if (existing && existing.status !== "ready") throw new TrackerError("ticket_not_ready");
    const requestedContext = event.payload.integrationContext;
    if (existing?.integrationContext && requestedContext && (existing.integrationContext.specification !== requestedContext.specification || existing.integrationContext.branch !== requestedContext.branch)) throw new TrackerError("integration_context_mismatch");
    const integrationContext = existing?.integrationContext ?? requestedContext ?? null;
    const issue = github.request(`repos/${config.repository}/issues/${event.payload.issue}`);
    if (issue.pull_request || issue.state !== "open") throw new TrackerError("implementation_issue_required");
    const observedParent = currentParent(github, config, issue.number);
    const parent = observedParent.number;
    if (integrationContext && observedParent.repository !== config.repository) throw new TrackerError("parent_repository_unsupported");
    if (integrationContext && parent !== integrationContext.specification) throw new TrackerError("specification_mismatch");
    const dependencies = existing ? dependencyReadiness(state, { ...existing, parent, integrationContext }, { github, config }) : null;
    if (dependencies && !dependencies.ready) throw new TrackerError("implementation_dependencies_unsatisfied");
    state.tickets[issue.number] = {
      ...existing, ...(dependencies ? { dependencies } : {}),
      role: "implementation", repository: config.repository, number: issue.number, nodeId: issue.node_id, title: issue.title, url: issue.html_url, parent,
      account: state.owner.account, agent: event.payload.agent, reviewer: null, branch: event.payload.branch, workingRevision: event.payload.branchRevision,
      integrationContext, pullRequest: null, status: "implementing", activity: "unverified", stateAt: event.at, activityAt: null,
      result: event.payload.result, runId: event.runId, generation: event.generation, revision: state.revision + 1,
    };
    state.owner.sequence = event.sequence;
    }
  }
  state.revision++;
  state.receipts[event.id] = { state: "pending", runId: event.runId, generation: state.generation, sequence: event.sequence, revision: state.revision };
  return state;
}
