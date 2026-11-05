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
  if (Object.hasOwn(state, "selectionRevision") && (!counter(state.selectionRevision) || state.selectionRevision > state.revision)) throw new TrackerError("registry_invalid");
  const owner = state.owner;
  const validOwner = value => record(value) && identity(value.runId) && identity(value.account) && counter(value.generation) && value.generation > 0 && counter(value.sequence) && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)) && new Date(value.startedAt).toISOString() === value.startedAt;
  const history = state.runHistory ?? {};
  if (!record(history)) throw new TrackerError("registry_invalid");
  for (const [generation, previous] of Object.entries(history)) {
    if (!validOwner(previous) || String(previous.generation) !== generation || previous.generation > state.generation || !["stopped", "superseded"].includes(previous.kind) || !identity(previous.endedBy) || previous.endedBy !== previous.account || !identity(previous.eventId) || typeof previous.reason !== "string" || !previous.reason.trim() || previous.reason.length > 1000 || typeof previous.endedAt !== "string" || !Number.isFinite(Date.parse(previous.endedAt)) || new Date(previous.endedAt).toISOString() !== previous.endedAt || Date.parse(previous.endedAt) < Date.parse(previous.startedAt)) throw new TrackerError("registry_invalid");
  }
  if (owner === null) {
    if (state.generation !== 0 && history[state.generation]?.kind !== "stopped") throw new TrackerError("registry_invalid");
  } else if (!validOwner(owner) || owner.generation !== state.generation || history[owner.generation]) throw new TrackerError("registry_invalid");
  for (const [id, receipt] of Object.entries(state.receipts)) {
    if (!identity(id) || !record(receipt) || !["pending", "published", "rejected"].includes(receipt.state) || !counter(receipt.revision) || receipt.revision > state.revision || (receipt.runId != null && (!identity(receipt.runId) || !counter(receipt.generation) || !counter(receipt.sequence)))) throw new TrackerError("registry_invalid");
    if ((Object.hasOwn(receipt, "fingerprint") && (typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint))) || (receipt.state === "rejected" && (typeof receipt.error !== "string" || !/^[a-z][a-z0-9_]*$/.test(receipt.error)))) throw new TrackerError("registry_invalid");
  }
  if (owner && Object.hasOwn(owner, "lastEventId")) {
    if (!identity(owner.lastEventId)) throw new TrackerError("registry_invalid");
    const receipt = state.receipts[owner.lastEventId];
    if (!receipt || receipt.runId !== owner.runId || receipt.generation !== owner.generation || receipt.sequence !== owner.sequence) throw new TrackerError("registry_invalid");
  }
  if (owner === null && state.generation > 0) {
    const previous = history[state.generation];
    const receipt = state.receipts[previous.eventId];
    if (!receipt || receipt.type !== "stop" || receipt.runId !== previous.runId || receipt.generation !== previous.generation || receipt.sequence !== previous.sequence || receipt.state === "rejected") throw new TrackerError("registry_invalid");
  }
  for (const ticket of Object.values(state.tickets)) {
    if (!record(ticket)) throw new TrackerError("registry_invalid");
    if (ticket.runId != null && !(owner && ticket.runId === owner.runId && ticket.generation === owner.generation)) {
      const previous = history[ticket.generation];
      if (!previous || previous.runId !== ticket.runId || ticket.activity !== "inactive") throw new TrackerError("registry_invalid");
    }
  }
  return state;
}

export function projectionSynchronized(state) {
  return state.publishedRevision === state.revision && !Object.values(state.receipts).some(receipt => receipt.state === "pending");
}

export function readRegistry(github, config) {
  const comments = github.pages(`repos/${config.repository}/issues/${config.registryIssue}/comments`);
  const matches = comments.filter(comment => comment.body.startsWith(registryMarker));
  if (matches.length !== 1) throw new TrackerError(matches.length ? "registry_ambiguous" : "registry_missing");
  return { commentId: matches[0].id, state: parseRegistry(matches[0].body) };
}

export function writeRegistry(github, config, commentId, state) {
  const body = renderRegistry(state);
  parseRegistry(body);
  return github.request(`repos/${config.repository}/issues/comments/${commentId}`, { method: "PATCH", body: { body } });
}
