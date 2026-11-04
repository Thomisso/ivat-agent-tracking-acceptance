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
  const match = body.match(/^<!-- ivat-agent-tracker:registry:v1 -->\s*```json\n([\s\S]+)\n```\s*$/);
  if (!match) throw new TrackerError("registry_invalid");
  const state = JSON.parse(match[1]);
  if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || !state.tickets || !state.receipts) throw new TrackerError("registry_invalid");
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
