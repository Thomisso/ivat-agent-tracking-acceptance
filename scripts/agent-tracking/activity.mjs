import { TrackerError } from "./github.mjs";

const fiveMinutes = 5 * 60 * 1000;
const fifteenMinutes = 15 * 60 * 1000;
export function observationTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TrackerError("event_invalid");
  return value;
}
export function buildActivityPayload(options) {
  if (Object.keys(options).some(key => !["issue", "agent", "role", "state", "source", "observed-at", "reference", "at", "wait-seconds", "config"].includes(key))) throw new TrackerError("event_invalid");
  return { issue: Number(options.issue), agent: options.agent, role: options.role, state: options.state, source: options.source, observedAt: options["observed-at"], reference: options.reference };
}
export function validateActivity(event, text) {
  const p = event.payload;
  if (Object.keys(p).some(key => !["issue", "agent", "role", "state", "source", "observedAt", "reference"].includes(key)) || !Number.isSafeInteger(p.issue) || p.issue <= 0 || !["implementer", "reviewer"].includes(p.role) || !["working", "waiting", "stopped"].includes(p.state) || !["agent_message", "run_observation"].includes(p.source)) throw new TrackerError("event_invalid");
  text(p.agent, 100); text(p.reference, 500); observationTime(p.observedAt);
  if (/\b(?:Bearer|Authorization|cookie|session[_ -]?(?:id|token))\b|\/(?:Users|home|tmp|private|root)\//i.test(p.reference)) throw new TrackerError("event_invalid");
  if (Date.parse(p.observedAt) > Date.parse(event.at)) throw new TrackerError("observation_in_future");
}
export function beginActivityEpisode(ticket, at, role = "implementer", state = "working") {
  ticket.activityEpisode = { agent: role === "reviewer" ? ticket.reviewer : ticket.agent, role, startedAt: at, state };
  ticket.activityAt = null;
  ticket.activityObservation = null;
  ticket.activityPublishedAt = null;
  delete ticket.activityPublicationPending;
}
function expectedRole(ticket) {
  if (ticket.status === "implementing") return "implementer";
  if (ticket.status === "review" && ticket.review?.outcome === "working") return "reviewer";
  return null;
}
export function activityValue(state, ticket, now = Date.now()) {
  const role = expectedRole(ticket);
  if (!role || !state.owner || ticket.runId !== state.owner.runId || ticket.generation !== state.owner.generation || ticket.role === "specification" || ["waiting", "stopped"].includes(ticket.activityEpisode?.state)) return "inactive";
  if (!ticket.activityAt || Date.parse(ticket.activityAt) < Date.parse(ticket.activityEpisode?.startedAt ?? ticket.stateAt) || (ticket.activityEpisode?.inactiveAt && Date.parse(ticket.activityAt) <= Date.parse(ticket.activityEpisode.inactiveAt)) || now - Date.parse(ticket.activityAt) > fifteenMinutes) return "unverified";
  return "confirmed";
}
export function applyActivity(state, event) {
  const p = event.payload; const ticket = state.tickets[p.issue];
  if (!ticket || ticket.runId !== event.runId || ticket.generation !== event.generation) throw new TrackerError("ticket_not_claimed");
  const role = expectedRole(ticket);
  if (!role || p.role !== role || p.agent !== (role === "implementer" ? ticket.agent : ticket.reviewer)) throw new TrackerError("activity_agent_mismatch");
  const episode = ticket.activityEpisode ?? { startedAt: ticket.review?.handoffAt ?? ticket.stateAt, state: "working" };
  if (Date.parse(p.observedAt) > Date.now()) throw new TrackerError("observation_in_future");
  const boundary = episode.inactiveAt ?? episode.startedAt;
  if (Date.parse(p.observedAt) < Date.parse(boundary) || (episode.inactiveAt && Date.parse(p.observedAt) === Date.parse(boundary))) throw new TrackerError("activity_episode_superseded");
  if (ticket.activityAt && Date.parse(p.observedAt) <= Date.parse(ticket.activityAt)) return "older_observation";
  if (p.state === "working" && ticket.activityPublishedAt && Date.now() - Date.parse(ticket.activityPublishedAt) < fiveMinutes) {
    if (episode.state === "working") return "throttled";
    ticket.activityEpisode = { ...episode, state: "working" };
    ticket.activity = activityValue(state, ticket);
    ticket.revision = state.revision + 1;
    return "adopted";
  }
  ticket.activityEpisode = { ...episode, agent: p.agent, role, state: p.state, ...(p.state === "working" ? {} : { inactiveAt: p.observedAt }) };
  if (p.state === "working") {
    ticket.activityAt = p.observedAt;
    ticket.activityObservation = { agent: p.agent, role, source: p.source, observedAt: p.observedAt, reference: p.reference };
    ticket.activityPublicationPending = true;
  } else ticket.activityStateObservation = { ...p };
  ticket.activity = activityValue(state, ticket);
  ticket.revision = state.revision + 1;
  return "adopted";
}
export function evaluateActivity(state) {
  let changed = false;
  for (const ticket of Object.values(state.tickets)) {
    const value = activityValue(state, ticket);
    if (ticket.activity !== value) { ticket.activity = value; ticket.revision = state.revision + 1; changed = true; }
  }
  return changed;
}
