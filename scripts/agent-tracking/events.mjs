import { TrackerError } from "./github.mjs";

export function text(value, limit = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f]|\b(?:gh[pousr]_|github_pat_|sb_secret_)[A-Za-z0-9_]+/.test(value)) throw new TrackerError("event_invalid");
  return value;
}

export function validateEvent(event) {
  const allowed = ["id", "type", "runId", "generation", "sequence", "at", "payload"];
  if (!event || Object.keys(event).some(key => !allowed.includes(key)) || Buffer.byteLength(JSON.stringify(event)) > 8 * 1024) throw new TrackerError("event_invalid");
  text(event.id, 100); text(event.runId, 100);
  if (!/^[\w-]+$/.test(event.id) || !/^[\w-]+$/.test(event.runId) || !Number.isInteger(event.generation) || event.generation < 0 || !Number.isInteger(event.sequence) || event.sequence < 0 || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new TrackerError("event_invalid");
  if (event.type === "start") {
    if (Object.keys(event.payload).length || event.sequence !== 0) throw new TrackerError("event_invalid");
  } else if (event.type === "claim") {
    if (Object.keys(event.payload).some(key => !["issue", "agent", "branch", "branchRevision", "result"].includes(key)) || !Number.isInteger(event.payload.issue) || event.payload.issue <= 0 || !/^[a-f0-9]{40}$/.test(event.payload.branchRevision ?? "")) throw new TrackerError("event_invalid");
    text(event.payload.agent, 100); text(event.payload.branch, 200); text(event.payload.result);
  } else throw new TrackerError("event_type_unknown");
  return event;
}

export function applyEvent(state, event, { github, config, actor }) {
  validateEvent(event);
  if (event.type === "start") {
    if (state.owner) throw new TrackerError("run_already_owned");
    if (event.generation !== state.generation) throw new TrackerError("run_superseded");
    state.generation++;
    state.owner = { runId: event.runId, generation: state.generation, account: actor, startedAt: event.at, sequence: 0 };
  } else {
    if (!state.owner || state.owner.runId !== event.runId || state.owner.generation !== event.generation) throw new TrackerError("run_superseded");
    if (state.owner.account !== actor) throw new TrackerError("run_actor_mismatch");
    if (event.sequence !== state.owner.sequence + 1) throw new TrackerError("event_out_of_order");
    if (state.tickets[event.payload.issue]) throw new TrackerError("ticket_already_claimed");
    const issue = github.request(`repos/${config.repository}/issues/${event.payload.issue}`);
    if (issue.pull_request || issue.state !== "open") throw new TrackerError("implementation_issue_required");
    let parent = null;
    try { parent = github.request(`repos/${config.repository}/issues/${issue.number}/parent`)?.number ?? null; } catch (error) { if (error.code !== "github_not_found") throw error; }
    state.tickets[issue.number] = {
      number: issue.number, nodeId: issue.node_id, title: issue.title, url: issue.html_url, parent,
      account: state.owner.account, agent: event.payload.agent, reviewer: null, branch: event.payload.branch, workingRevision: event.payload.branchRevision,
      pullRequest: null, status: "implementing", activity: "unverified", stateAt: event.at, activityAt: null,
      result: event.payload.result, runId: event.runId, generation: event.generation, revision: state.revision + 1,
    };
    state.owner.sequence = event.sequence;
  }
  state.revision++;
  state.receipts[event.id] = { state: "pending", runId: event.runId, generation: state.generation, sequence: event.sequence, revision: state.revision };
  return state;
}
