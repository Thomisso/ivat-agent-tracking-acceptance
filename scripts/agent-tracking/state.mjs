import { TrackerError } from "./github.mjs";

export const registryMarker = "<!-- ivat-agent-tracker:registry:v1 -->";
export const statuses = { ready: "Připraveno", implementing: "Implementace", review: "Review", integrated: "V integrační větvi", done: "Hotovo", blocked: "Blokováno", cancelled: "Zrušeno" };
export const activities = { confirmed: "Potvrzená", unverified: "Neověřená", inactive: "Neaktivní" };
export const textFields = { agent: "Agent", reviewer: "Review agent", branch: "Branch", pullRequest: "Implementation PR", stateAt: "Confirmed state (UTC)", activityAt: "Confirmed activity (UTC)", result: "Latest result", runId: "Run", revision: "Revision" };

export function initialState() {
  return { schemaVersion: 1, revision: 0, generation: 0, owner: null, tickets: {}, receipts: {}, publishedRevision: 0 };
}

export function renderRegistry(state) {
  const body = `${registryMarker}\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n`;
  if (Buffer.byteLength(body) > 48 * 1024) throw new TrackerError("registry_capacity_exceeded");
  return body;
}

export function parseRegistry(body) {
  const match = typeof body === "string" && body.match(/^<!-- ivat-agent-tracker:registry:v1 -->\s*```json\n([\s\S]+)\n```\s*$/);
  if (!match) throw new TrackerError("registry_invalid");
  let state;
  try { state = JSON.parse(match[1]); } catch { throw new TrackerError("registry_invalid"); }
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const counter = value => Number.isSafeInteger(value) && value >= 0;
  const identity = value => typeof value === "string" && /^[\w-]{1,100}$/.test(value);
  if (!record(state) || state.schemaVersion !== 1 || !counter(state.revision) || !counter(state.generation) || !counter(state.publishedRevision) || state.publishedRevision > state.revision || !record(state.tickets) || !record(state.receipts) || !Object.hasOwn(state, "owner")) throw new TrackerError("registry_invalid");
  const owner = state.owner;
  if (owner === null) {
    // This model has no stop operation yet. An unexplained prior generation
    // cannot establish that the repository is now free to be claimed again.
    if (state.generation !== 0) throw new TrackerError("registry_invalid");
  } else if (!record(owner) || !identity(owner.runId) || !identity(owner.account) || !counter(owner.generation) || owner.generation === 0 || owner.generation !== state.generation || !counter(owner.sequence) || typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt)) || new Date(owner.startedAt).toISOString() !== owner.startedAt) throw new TrackerError("registry_invalid");
  for (const ticket of Object.values(state.tickets)) {
    if (!record(ticket) || (ticket.runId != null && (!owner || ticket.runId !== owner.runId || ticket.generation !== owner.generation))) throw new TrackerError("registry_invalid");
  }
  return state;
}

export function readRegistry(github, config) {
  const comments = github.pages(`repos/${config.repository}/issues/${config.registryIssue}/comments`);
  const matches = comments.filter(comment => comment.body.startsWith(registryMarker));
  if (matches.length !== 1) throw new TrackerError(matches.length ? "registry_ambiguous" : "registry_missing");
  return { commentId: matches[0].id, state: parseRegistry(matches[0].body) };
}

export function writeRegistry(github, config, commentId, state) {
  return github.request(`repos/${config.repository}/issues/comments/${commentId}`, { method: "PATCH", body: { body: renderRegistry(state) } });
}
