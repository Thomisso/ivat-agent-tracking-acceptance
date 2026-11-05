import assert from "node:assert/strict";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";
const T = "2026-11-05T12:00:00.000Z";
function execute(repo, ...args) { const result = repo.run(...args); assert.equal(result.status, 0, result.stderr); return resultJson(result); }
function begin(t) { const repo = trackerFixture(t); repo.now(T); assert.equal(repo.setup().status, 0); execute(repo, "start", "--run", "activity-run"); execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket"); return repo; }
function shown(repo) { return execute(repo, "show").remote; }
function activity(repo, at = T, ...extra) { return repo.run("activity", "--issue", "201", "--agent", "worker", "--role", "implementer", "--state", "working", "--source", "run_observation", "--observed-at", at, "--reference", "Worker run observed running focused checks", ...extra); }
function values(repo) { return Object.values(repo.remote().items)[0].values; }

test("genuine worker observation confirms independently of phase and rejects timer-only evidence", t => {
  const repo = begin(t); const before = shown(repo);
  assert.equal(before.tickets[201].activity, "unverified");
  repo.now("2026-11-05T12:01:00.000Z");
  const timer = activity(repo, T, "--source", "timer"); assert.equal(resultJson(timer).error, "event_invalid");
  const actual = activity(repo); assert.equal(actual.status, 0, actual.stderr);
  const state = shown(repo); const ticket = state.tickets[201];
  assert.equal(ticket.activity, "confirmed"); assert.equal(ticket.activityAt, T);
  assert.equal(ticket.stateAt, T); assert.equal(ticket.activityPublishedAt, "2026-11-05T12:01:00.000Z");
  assert.equal(ticket.status, "implementing"); assert.equal(ticket.result, "Implementation started");
  assert.equal(state.owner.runId, before.owner.runId); assert.equal(ticket.agent, "worker");
  const field = repo.remote().fields.find(field => field.name === "Confirmed activity (UTC)");
  assert.equal(values(repo)[field.id].text, T);
  assert.match(repo.remote().ticketComments[0].body, /Activity observed \(UTC\): 2026-11-05T12:00:00.000Z/);
});

test("review and known waiting episodes bind genuine observations to the current worker", t => {
  const repo = begin(t);
  const wrong = activity(repo, T, "--agent", "other-worker"); assert.equal(resultJson(wrong).error, "activity_agent_mismatch");
  assert.equal(activity(repo).status, 0);
  repo.now("2026-11-05T12:01:00.000Z");
  assert.equal(activity(repo, "2026-11-05T12:01:00.000Z", "--state", "waiting").status, 0);
  assert.equal(shown(repo).tickets[201].activity, "inactive");
  const old = activity(repo); assert.equal(resultJson(old).error, "activity_episode_superseded");
  const revision = repo.git("rev-parse", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Focused checks passed", "--result", "Implementation complete");
  assert.equal(shown(repo).tickets[201].activity, "inactive");
  repo.now("2026-11-05T12:20:00.000Z");
  execute(repo, "review-start", "--issue", "201", "--reviewer", "reviewer", "--observed-at", "2026-11-05T12:02:00.000Z", "--result", "Reviewer reports inspecting the diff");
  const ticket = shown(repo).tickets[201];
  assert.equal(ticket.activity, "unverified");
  assert.equal(ticket.activityAt, "2026-11-05T12:02:00.000Z");
  assert.equal(ticket.activityObservation.agent, "reviewer");
  assert.equal(ticket.activityObservation.source, "agent_message");
  const staleImplementer = activity(repo, "2026-11-05T12:20:00.000Z"); assert.equal(resultJson(staleImplementer).error, "activity_agent_mismatch");
  execute(repo, "review-result", "--issue", "201", "--revision", revision, "--reviewer", "reviewer", "--standards", "fail", "--spec", "pass", "--findings", '["Fix ownership guard"]', "--independence", "Independent review", "--result", "Changes required");
  assert.equal(shown(repo).tickets[201].activity, "unverified");
  const delayed = activity(repo, "2026-11-05T12:03:00.000Z"); assert.equal(resultJson(delayed).error, "activity_episode_superseded");
});

test("successful publication clock limits activity and never delays phase evidence", t => {
  const repo = begin(t); assert.equal(activity(repo).status, 0);
  const original = JSON.parse(repo.remote().dispatches.at(-1));
  repo.now("2026-11-05T12:04:59.999Z");
  const throttled = activity(repo, "2026-11-05T12:04:59.999Z"); assert.equal(throttled.status, 0); assert.equal(resultJson(throttled).outcome, "throttled");
  assert.equal(shown(repo).tickets[201].activityAt, T);
  assert.equal(shown(repo).tickets[201].activityPublishedAt, T);
  repo.now("2026-11-05T12:05:00.000Z");
  assert.equal(activity(repo, "2026-11-05T12:05:00.000Z").status, 0);
  assert.equal(shown(repo).tickets[201].activityAt, "2026-11-05T12:05:00.000Z");
  assert.equal(repo.worker(original).status, 0);
  assert.equal(activity(repo).status, 0);
  assert.equal(shown(repo).tickets[201].activityPublishedAt, "2026-11-05T12:05:00.000Z");
  repo.now("2026-11-05T12:06:00.000Z");
  const revision = repo.git("rev-parse", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Focused checks passed", "--result", "Implementation complete");
  assert.equal(shown(repo).tickets[201].status, "review"); assert.equal(shown(repo).tickets[201].activity, "inactive");
});

test("independent evaluation expires only strictly older confirmations and converges without changing phase or owner", t => {
  const repo = begin(t); assert.equal(activity(repo).status, 0); const before = shown(repo);
  repo.now("2026-11-05T12:15:00.000Z"); execute(repo, "observe-activity");
  assert.equal(shown(repo).tickets[201].activity, "confirmed");
  repo.now("2026-11-05T12:15:00.001Z"); const independent = repo.clone(); assert.equal(independent.setup().status, 0); execute(independent, "observe-activity");
  let state = shown(repo); assert.equal(state.tickets[201].activity, "unverified");
  for (const key of ["status", "stateAt", "activityAt", "result", "agent", "runId", "generation", "branch", "workingRevision"]) assert.deepEqual(state.tickets[201][key], before.tickets[201][key]);
  assert.deepEqual(state.owner, before.owner);
  const revision = state.revision; const comments = repo.remote().ticketComments;
  repo.now("2026-11-05T12:35:00.000Z"); execute(repo, "observe-activity");
  state = shown(repo); assert.equal(state.revision, revision); assert.deepEqual(repo.remote().ticketComments, comments);
  execute(repo, "stop", "--reason", "Workers stopped");
  execute(repo, "observe-activity"); assert.equal(shown(repo).tickets[201].activity, "inactive"); assert.equal(shown(repo).owner, null);
});


test("scheduled Actions evaluates from execution time with independent credentials and no controller", t => {
  const repo = begin(t); assert.equal(activity(repo).status, 0);
  repo.now("2026-11-05T12:25:00.000Z");
  const schedule = { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "456", TRACKER_SCHEDULE: "*/5 * * * *", GH_TOKEN: "synthetic-actions-credential" };
  const missing = repo.worker(null, { ...schedule, GH_TOKEN: "" }); assert.equal(resultJson(missing).error, "actions_credential_missing");
  const result = repo.worker(null, schedule); assert.equal(result.status, 0, result.stderr);
  const ticket = shown(repo).tickets[201]; assert.equal(ticket.activity, "unverified"); assert.equal(ticket.activityAt, T); assert.equal(ticket.status, "implementing");
  repo.updateRemote(remote => { remote.fail = "HTTP 403: project permission missing"; });
  const permissions = repo.worker(null, schedule); assert.equal(resultJson(permissions).error, "github_permission_denied");
  repo.updateRemote(remote => { remote.fail = "network unavailable"; });
  const transport = repo.worker(null, schedule); assert.equal(resultJson(transport).error, "github_connection_failed");
});

test("delayed genuine confirmations keep original time across partial publication retry", t => {
  const repo = begin(t); repo.now("2026-11-05T12:20:00.000Z");
  repo.updateRemote(remote => { remote.failure = { match: "TrackerSetFields", phase: "after", remaining: 1 }; });
  const partial = activity(repo); assert.equal(resultJson(partial).error, "publication_pending");
  let state = shown(repo); assert.equal(state.tickets[201].activity, "unverified"); assert.equal(state.tickets[201].activityAt, T); assert.equal(state.tickets[201].activityPublishedAt, null);
  repo.now("2026-11-05T12:25:00.000Z"); execute(repo, "sync");
  state = shown(repo); assert.equal(state.tickets[201].activityAt, T); assert.equal(state.tickets[201].activityPublishedAt, "2026-11-05T12:25:00.000Z"); assert.equal(state.tickets[201].activity, "unverified");
  repo.now("2026-11-05T12:25:01.000Z"); assert.equal(activity(repo, "2026-11-05T12:25:01.000Z").status, 0);
  assert.equal(shown(repo).tickets[201].activityAt, T);
  assert.equal(repo.remote().ticketComments.length, 1); assert.equal(Object.keys(repo.remote().items).length, 1);
});

test("an older observer wakeup evaluates newer confirmations and superseding ownership at execution", t => {
  const repo = begin(t); assert.equal(activity(repo).status, 0);
  const oldActivity = JSON.parse(repo.remote().dispatches.at(-1));
  const wakeup = { id: "old-observer", type: "observe-activity", at: T, payload: {} };
  repo.now("2026-11-05T12:20:00.000Z"); assert.equal(repo.worker(wakeup).status, 0);
  assert.equal(shown(repo).tickets[201].activity, "unverified");
  assert.equal(activity(repo, "2026-11-05T12:20:00.000Z").status, 0);
  // Its old receipt is replayed after a newer canonical observation.
  assert.equal(repo.worker(wakeup).status, 0);
  let state = shown(repo); assert.equal(state.tickets[201].activity, "confirmed"); assert.equal(state.tickets[201].activityAt, "2026-11-05T12:20:00.000Z");
  execute(repo, "takeover", "--from-run", "activity-run", "--from-generation", "1", "--run", "replacement", "--reason", "Explicit recovery");
  execute(repo, "claim", "--issue", "201", "--agent", "replacement-worker", "--branch", "feat/ticket");
  assert.equal(repo.worker(wakeup).status, 0);
  assert.equal(resultJson(repo.worker(oldActivity)).error, "run_superseded");
  state = shown(repo); assert.equal(state.owner.runId, "replacement"); assert.equal(state.tickets[201].agent, "replacement-worker"); assert.equal(state.tickets[201].activity, "unverified"); assert.equal(state.tickets[201].activityAt, null);
  // Bound terminal receipt retention while retaining pending/ownership evidence.
  for (let index = 0; index < 34; index++) assert.equal(repo.worker({ ...wakeup, id: `observer-${index}` }).status, 0);
  assert.equal(repo.worker(wakeup).status, 0);
  assert.equal(resultJson(repo.worker(oldActivity)).error, "run_superseded");
  state = shown(repo); assert.equal(state.tickets[201].activity, "unverified"); assert.equal(state.tickets[201].status, "implementing"); assert.equal(state.owner.runId, "replacement");
});

test("a confirmation that expires while publication is interrupted is unverified on retry", t => {
  const repo = begin(t);
  repo.updateRemote(remote => { remote.failure = { match: "TrackerSetFields", phase: "before", remaining: 1 }; });
  assert.equal(resultJson(activity(repo)).error, "publication_pending");
  repo.now("2026-11-05T12:20:00.000Z"); execute(repo, "sync");
  const state = shown(repo); assert.equal(state.tickets[201].activity, "unverified"); assert.equal(state.tickets[201].activityAt, T);
  const field = repo.remote().fields.find(field => field.name === "Activity");
  assert.equal(values(repo)[field.id].singleSelectOptionId, field.options.find(option => option.name === "Neověřená").id);
});


test("invalid provenance and old worker episodes cannot alter phase or evidence", t => {
  const repo = begin(t); const before = shown(repo).tickets[201];
  for (const extra of [["--source", "write_success"], ["--reference", "session_id private"], ["--reference", "/Users/operator/private/session"], ["--unknown", "value"], ["--observed-at", "2026-11-05T12:00:00Z"]]) assert.equal(resultJson(activity(repo, T, ...extra)).error, "event_invalid");
  assert.equal(resultJson(activity(repo, "2026-11-05T12:01:00.000Z")).error, "observation_in_future");
  assert.deepEqual(shown(repo).tickets[201], before);
  assert.equal(activity(repo).status, 0);
  repo.now("2026-11-05T12:01:00.000Z"); assert.equal(activity(repo, "2026-11-05T12:01:00.000Z", "--state", "stopped").status, 0);
  repo.now("2026-11-05T12:02:00.000Z"); assert.equal(activity(repo, "2026-11-05T12:02:00.000Z").status, 0);
  assert.equal(shown(repo).tickets[201].activity, "unverified"); assert.equal(shown(repo).tickets[201].activityAt, T);
  repo.now("2026-11-05T12:05:00.000Z"); assert.equal(activity(repo, "2026-11-05T12:05:00.000Z").status, 0); assert.equal(shown(repo).tickets[201].activity, "confirmed");
  repo.now("2026-11-05T12:06:00.000Z"); execute(repo, "block", "--issue", "201", "--reason", "Missing input", "--condition", "Input restored", "--result", "Waiting for input");
  repo.now("2026-11-05T13:00:00.000Z"); execute(repo, "observe-activity"); assert.equal(shown(repo).tickets[201].activity, "inactive");
  const blocked = shown(repo).tickets[201]; assert.equal(resultJson(activity(repo, "2026-11-05T13:00:00.000Z")).error, "activity_agent_mismatch"); assert.deepEqual(shown(repo).tickets[201], blocked);
});
