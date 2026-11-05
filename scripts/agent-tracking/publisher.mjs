import { evaluateActivity } from "./activity.mjs";
import { prunePublishedDiscoveryReceipts } from "./discovery.mjs";
import { reconcileViews } from "./views.mjs";
import { TrackerError } from "./github.mjs";
import { readRegistry, writeRegistry, textFields, projectionSynchronized } from "./state.mjs";
import { applyEvent, validateEvent } from "./events.mjs";
import { createHash } from "node:crypto";
import { validateConfig } from "./config.mjs";
import { receiptOwnershipMatches } from "./recovery.mjs";
import { compactReceipts } from "./receipts.mjs";

function setFields(github, config, itemId, record) {
  const values = { status: record.status ?? null, activity: record.activity ?? null, ...Object.fromEntries(Object.keys(textFields).map(key => [key, record[key] ?? null])) };
  const variables = {};
  const definitions = [];
  const operations = [];
  for (const [index, [key, value]] of Object.entries(values).entries()) {
    const field = config.fields[key];
    const clearing = value === null || value === "";
    definitions.push(`$input${index}:${clearing ? "ClearProjectV2ItemFieldValueInput" : "UpdateProjectV2ItemFieldValueInput"}!`);
    variables[`input${index}`] = { projectId: config.project.id, itemId, fieldId: field.id, ...(clearing ? {} : { value: field.options ? { singleSelectOptionId: field.options[value] } : { text: String(value) } }) };
    operations.push(`f${index}:${clearing ? "clearProjectV2ItemFieldValue" : "updateProjectV2ItemFieldValue"}(input:$input${index}){projectV2Item{id}}`);
  }
  github.graph(`mutation TrackerSetFields(${definitions.join(",")}){${operations.join(" ")}}`, variables);
}

export function publishTicket(github, config, record, state = { tickets: {} }) {
  const itemId = github.graph(`mutation TrackerAddItem($input:AddProjectV2ItemByIdInput!){addProjectV2ItemById(input:$input){item{id}}}`, { input: { projectId: config.project.id, contentId: record.nodeId } }).addProjectV2ItemById.item.id;
  if (record.account) github.request(`repos/${record.repository ?? config.repository}/issues/${record.number}/assignees`, { method: "POST", body: { assignees: [record.account] } });
  setFields(github, config, itemId, record);
  const marker = `<!-- ivat-agent-tracker:ticket:${config.project.id} -->`;
  const comments = github.pages(`repos/${record.repository ?? config.repository}/issues/${record.number}/comments`).filter(comment => comment.body.startsWith(marker));
  if (comments.length > 1) throw new TrackerError("ticket_comment_ambiguous");
  const recovery = record.recoveryEvidence ? `- Recovery evidence (${record.recoveryEvidence.source}, ${record.recoveryEvidence.observedAt}): ${record.recoveryEvidence.unverified.join(", ") || "referenced facts available; worker activity remains separate"}\n` : "";
  const fallbackChildren = Object.values(state.tickets).filter(child => child.parentSource === "fallback" && child.parent === record.number && (child.parentRepository ?? config.repository).toLowerCase() === (record.repository ?? config.repository).toLowerCase());
  const fallbackOverview = fallbackChildren.length ? `\nThe native Parent issue filter excludes text-only fallback relationships. These tracked issues remain accessible below and in the table with its filter cleared:\n${fallbackChildren.map(child => `- Tracker fallback (opening Part of declaration): [${child.repository ?? config.repository}#${child.number}](${child.url})`).join("\n")}\n` : "";
  const body = record.role === "specification" ? `${marker}\n\nAgent tracking: [Project](${config.project.url})\n\nSpecification context. Inspect the Agent specification table with native Parent issue filter \`parent-issue:"${record.repository ?? config.repository}#${record.number}"\`.\n${fallbackOverview}` : `${marker}\n\nAgent tracking: [Project](${config.project.url})\n\n- Run: ${record.runId}; generation ${record.generation}; revision ${record.revision}\n- Agent: ${record.agent}\n- Branch: ${record.branch} (${record.workingRevision})\n- Phase: ${record.status}\n- Activity: ${record.activity}\n- State observed (UTC): ${record.stateAt}\n- Activity observed (UTC): ${record.activityAt ?? "not verified"}\n- Activity provenance: ${record.activityObservation ? JSON.stringify(record.activityObservation) : "not verified"}\n- Latest result: ${record.result}\n${recovery}${record.review ? `- Review evidence: ${JSON.stringify(record.review)}\n` : ""}${record.integration ? `- Integration evidence: ${JSON.stringify(record.integration)}\n` : ""}${record.blockage ? `- Blockage: ${JSON.stringify(record.blockage)}\n` : ""}${record.dependencies ? `- Dependencies: ${JSON.stringify(record.dependencies)}\n` : ""}`;
  if (comments.length) github.request(`repos/${record.repository ?? config.repository}/issues/comments/${comments[0].id}`, { method: "PATCH", body: { body } });
  else github.request(`repos/${record.repository ?? config.repository}/issues/${record.number}/comments`, { method: "POST", body: { body } });

}

export function processWorker(github, config, event, environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_JOB !== "publish" || !environment.GITHUB_WORKFLOW_REF?.startsWith(`${config.repository}/.github/workflows/${config.workflow}@`)) throw new TrackerError("serialized_worker_required");
  if (!/^[\w-]+$/.test(environment.GITHUB_ACTOR ?? "")) throw new TrackerError("worker_actor_invalid");
  if (!environment.GH_TOKEN?.trim()) throw new TrackerError("actions_credential_missing");
  validateEvent(event);
  validateConfig(github, config);
  const { commentId, state } = readRegistry(github, config);
  const previous = state.receipts[event.id];
  const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  if (previous?.fingerprint && previous.fingerprint !== fingerprint) throw new TrackerError("event_identity_conflict");
  if (previous && !receiptOwnershipMatches(state, event, previous)) return { ok: false, error: "run_superseded" };
  if (!previous) {
    try { applyEvent(state, event, { github, config, actor: environment.GITHUB_ACTOR }); }
    catch (error) {
      if (!(error instanceof TrackerError) || error.code.startsWith("github_")) throw error;
      if (error.code === "event_out_of_order") return { ok: false, error: error.code };
      if (state.owner && state.owner.runId === event.runId && state.owner.generation === event.generation && state.owner.account === environment.GITHUB_ACTOR && event.sequence === state.owner.sequence + 1) { state.owner.sequence = event.sequence; state.owner.lastEventId = event.id; }
      state.receipts[event.id] = { state: "rejected", type: event.type, error: error.code, runId: event.runId, generation: event.generation, sequence: event.sequence, revision: state.revision, fingerprint };
      compactReceipts(state);

      writeRegistry(github, config, commentId, state);
      return { ok: false, error: error.code };
    }
    state.receipts[event.id].fingerprint = fingerprint;
    if (event.type === "discover" && ["issues", "schedule"].includes(environment.GITHUB_EVENT_NAME) && event.id === `discovery-${environment.GITHUB_RUN_ID}`) state.receipts[event.id].automaticDiscovery = true;
    prunePublishedDiscoveryReceipts(state);
    compactReceipts(state);
    // Canonical intent is durable before any multi-effect Project projection.
    writeRegistry(github, config, commentId, state);
  } else if (previous.state === "rejected") return { ok: false, error: previous.error };
  if (!projectionSynchronized(state)) {
    // A pending confirmation can expire while its transport is interrupted.
    if (evaluateActivity(state)) {
      state.revision++;
      writeRegistry(github, config, commentId, state);
    }
    for (const record of Object.values(state.tickets)) publishTicket(github, config, record, state);
    if (state.membershipDiscovered) reconcileViews(github, config, state);
    // Start the cadence only after every required external projection succeeds.
    // The registry ACK commits this clock; retries keep the observation identity.
    for (const record of Object.values(state.tickets).filter(record => record.activityPublicationPending)) {
      record.activityPublishedAt = new Date().toISOString();
      delete record.activityPublicationPending;
    }
    state.publishedRevision = state.revision;
    for (const receipt of Object.values(state.receipts)) if (receipt.state === "pending" && receipt.revision <= state.publishedRevision) receipt.state = "published";
    compactReceipts(state);
    prunePublishedDiscoveryReceipts(state);

    writeRegistry(github, config, commentId, state);
  }
  return { ok: true, revision: state.revision, synchronized: projectionSynchronized(state) };
}
