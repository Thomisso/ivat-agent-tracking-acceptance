import assert from "node:assert/strict";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

const limit = 60 * 1024;
const prefix = "Focused capacity fixture checks passed; retained Unicode detail: ";
const proof = prefix + "ř".repeat(900 - prefix.length);
const envelope = state => `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n`;
function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}

function pendingPublication(t, bytes) {
  const repo = trackerFixture(t);
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "capacity-owner");
  execute(repo, "claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket");
  const revision = repo.git("rev-parse", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", proof, "--result", "Implementation retained for review");
  execute(repo, "review-result", "--issue", "201", "--reviewer", "independent-reviewer", "--revision", revision, "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent review of fixture implementation", "--result", "Reviewed evidence retained");
  repo.updateRemote(remote => { remote.deferDispatch = true; remote.failure = { match: "TrackerSetFields", phase: "before", remaining: 1 }; });
  assert.equal(resultJson(repo.run("repair")).error, "publication_pending");
  const event = JSON.parse(repo.remote().dispatches.at(-1));
  assert.equal(repo.worker(event).status, 1);
  const state = execute(repo, "show").remote;
  assert.equal(state.receipts[event.id].state, "pending");
  assert.equal(state.publishedRevision, state.revision, "a pending repair still prevents acknowledgment at the same phase revision");
  const original = structuredClone(state.tickets[201]);
  // Model a retained backlog from the public-produced record, including its
  // bounded review evidence and literal clocks. Only transport/durable state
  // is controlled; publication and acknowledgment use the actual worker.
  for (let number = 202; Buffer.byteLength(envelope(state)) < bytes; number++) {
    state.tickets[number] = { ...structuredClone(original), number, nodeId: `I_${number}`, title: `Retained delivery ${number}`, url: `https://github.com/example/project/issues/${number}`, projectItemId: `item-I_${number}` };
  }
  let excess = Buffer.byteLength(envelope(state)) - bytes;
  for (const record of Object.values(state.tickets).filter(record => record.number !== 201)) {
    const detailBytes = Buffer.byteLength(record.review.checks) - prefix.length;
    const removed = Math.min(excess, detailBytes);
    const kept = detailBytes - removed;
    record.review.checks = prefix + "ř".repeat(Math.floor(kept / 2)) + "x".repeat(kept % 2);
    excess -= removed;
    assert.ok(record.review.checks.length <= 1000);
    if (!excess) break;
  }
  assert.equal(excess, 0);
  assert.equal(Buffer.byteLength(envelope(state)), bytes);
  repo.updateRemote(remote => { remote.registry = envelope(state); });
  return { repo, event, before: structuredClone(state), original };
}

test("a retained pending registry above 48 KiB publishes and acknowledges without dropping evidence or the owner cursor", t => {
  const { repo, event, before, original } = pendingPublication(t, 52 * 1024);
  const retried = repo.worker(event);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(execute(repo, "sync").synchronized, true);
  const shown = execute(repo, "show");
  assert.equal(shown.local.pending.length, 0);
  assert.deepEqual(shown.remote.owner, before.owner);
  assert.deepEqual(shown.remote.tickets[201], original);
  for (const [number, record] of Object.entries(before.tickets)) {
    assert.deepEqual(shown.remote.tickets[number].review, record.review);
    for (const key of ["status", "agent", "runId", "generation", "stateAt", "activityAt"]) assert.deepEqual(shown.remote.tickets[number][key], record[key]);
  }
  assert.equal(shown.remote.receipts[event.id].state, "published");
  assert.equal(shown.remote.receipts[before.owner.lastEventId].state, "published");
  assert.equal(shown.remote.publishedRevision, shown.remote.revision);
  assert.ok(Buffer.byteLength(repo.remote().registry) > 48 * 1024);
  assert.ok(Buffer.byteLength(repo.remote().registry) <= limit);
});

test("the UTF-8 full-wrapper byte bound refuses an oversized acknowledgment without truncation or false synchronization", t => {
  const { repo, event, before } = pendingPublication(t, limit);
  const literal = repo.remote().registry;
  assert.ok(literal.length < 48 * 1024, "multibyte evidence distinguishes bytes from characters");
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < limit - 2, "JSON alone has room for pending to published; the complete wrapper does not");
  const retried = repo.worker(event);
  assert.equal(retried.status, 1);
  assert.equal(resultJson(retried).error, "registry_capacity_exceeded");
  assert.equal(repo.remote().registry, literal);
  assert.equal(resultJson(repo.run("sync")).error, "publication_pending");
  const shown = execute(repo, "show");
  assert.deepEqual(shown.remote, before);
  assert.equal(shown.remote.receipts[event.id].state, "pending");
  assert.equal(shown.remote.publishedRevision, before.publishedRevision);
  assert.equal(shown.local.pending.length, 1);
});
