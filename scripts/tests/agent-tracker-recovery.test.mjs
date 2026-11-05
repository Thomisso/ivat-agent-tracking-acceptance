import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

test("explicit stop and restart retain phase and historical ownership until deliberate reclaim", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "recovery-owner").status, 0);
  assert.equal(repo.run("claim", "--issue", "201", "--agent", "first-worker", "--branch", "feat/ticket").status, 0);
  const stopped = repo.run("stop", "--reason", "Controller work paused");
  assert.equal(stopped.status, 0, stopped.stderr);
  const inactive = resultJson(repo.run("show")).remote;
  assert.equal(inactive.owner, null);
  assert.equal(inactive.runHistory[1].kind, "stopped");
  assert.equal(inactive.tickets[201].status, "implementing");
  assert.equal(inactive.tickets[201].activity, "inactive");
  assert.equal(inactive.tickets[201].generation, 1);
  const resumed = repo.run("resume", "--run", "recovery-owner");
  assert.equal(resumed.status, 0, resumed.stderr);
  const restarted = resultJson(repo.run("show")).remote;
  assert.equal(restarted.owner.runId, "recovery-owner");
  assert.equal(restarted.owner.generation, 2);
  assert.equal(restarted.tickets[201].generation, 1);
  assert.equal(restarted.tickets[201].activity, "inactive");
  const reclaimed = repo.run("claim", "--issue", "201", "--agent", "replacement-worker", "--branch", "feat/ticket");
  assert.equal(reclaimed.status, 0, reclaimed.stderr);
  const current = resultJson(repo.run("show")).remote;
  assert.equal(current.tickets[201].generation, 2);
  assert.equal(current.tickets[201].status, "implementing");
  assert.equal(current.tickets[201].agent, "replacement-worker");
  assert.equal(current.tickets[201].activity, "unverified");
});

test("cross-computer recovery is explicit and fences the original generation including old acknowledgments", t => {
  const first = trackerFixture(t);
  assert.equal(first.setup().status, 0);
  assert.equal(first.run("start", "--run", "shared-logical-run").status, 0);
  assert.equal(first.run("claim", "--issue", "201", "--agent", "original-worker", "--branch", "feat/ticket").status, 0);
  const originalClaim = JSON.parse(first.remote().dispatches.at(-1));
  const replacement = first.clone();
  assert.equal(replacement.setup().status, 0);
  assert.equal(resultJson(replacement.run("resume", "--run", "shared-logical-run")).error, "owned_run_required");
  const recovered = replacement.run("resume", "--recover", "--run", "shared-logical-run", "--reason", "Explicit recovery on replacement computer");
  assert.equal(recovered.status, 0, recovered.stderr);
  const state = resultJson(replacement.run("show")).remote;
  assert.equal(state.owner.runId, "shared-logical-run");
  assert.equal(state.owner.generation, 2);
  assert.equal(state.runHistory[1].kind, "superseded");
  assert.equal(state.tickets[201].generation, 1);
  assert.equal(state.tickets[201].activity, "inactive");
  assert.equal(state.recovery.missingLocalHistory, true);
  const before = replacement.remote().registry;
  const staleWorker = replacement.worker(originalClaim);
  assert.equal(staleWorker.status, 1);
  assert.equal(resultJson(staleWorker).error, "run_superseded");
  assert.equal(replacement.remote().registry, before);
  const oldSync = first.run("sync");
  assert.equal(oldSync.status, 1);
  assert.equal(resultJson(oldSync).error, "run_superseded");
  assert.equal(resultJson(first.run("show", "--local")).local.run, null);
});

test("deliberate reclaim after stop preserves the reviewed phase and evidence under the new generation", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "reviewed-recovery").status, 0);
  assert.equal(repo.run("claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket").status, 0);
  const revision = repo.git("rev-parse", "feat/ticket");
  const reviewed = repo.run("review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Focused checks passed", "--result", "Implementation complete");
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const previous = resultJson(repo.run("show")).remote.tickets[201];
  assert.equal(repo.run("stop", "--reason", "Move reviewed work to another controller").status, 0);
  assert.equal(repo.run("resume", "--run", "reviewed-recovery").status, 0);
  const claimed = repo.run("claim", "--issue", "201", "--agent", "replacement-implementer", "--branch", "feat/ticket");
  assert.equal(claimed.status, 0, claimed.stderr);
  const record = resultJson(repo.run("show")).remote.tickets[201];
  assert.equal(record.status, "review");
  assert.equal(record.stateAt, previous.stateAt);
  assert.deepEqual(record.review, previous.review);
  assert.equal(record.generation, 2);
  assert.equal(record.activity, "inactive");
  assert.equal(repo.run("review-start", "--issue", "201", "--reviewer", "independent-reviewer", "--result", "Reading preserved review evidence").status, 0);
  assert.equal(resultJson(repo.run("sync")).synchronized, true);
});

for (const phase of ["review", "integrated"]) {
  test(`historical ${phase} reclaim stays inactive and refuses a different revision without replacing evidence`, t => {
    const repo = trackerFixture(t);
    assert.equal(repo.setup().status, 0);
    assert.equal(repo.run("start", "--run", "pinned-recovery").status, 0);
    assert.equal(repo.run("claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket", "--spec", "200", "--integration-branch", "integration/spec").status, 0);
    const revision = repo.git("rev-parse", "feat/ticket");
    assert.equal(repo.run("review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Focused checks passed", "--result", "Implementation complete").status, 0);
    assert.equal(repo.run("review-result", "--issue", "201", "--revision", revision, "--reviewer", "independent-reviewer", "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Reviewer received the ticket and diff without implementation context", "--result", "Clean independent review").status, 0);
    if (phase === "integrated") {
      repo.git("branch", "integration/spec", revision);
      assert.equal(repo.run("integrate", "--issue", "201", "--integration-commit", revision, "--result", "Reviewed tip integrated").status, 0);
    }
    const previous = resultJson(repo.run("show")).remote.tickets[201];
    assert.equal(repo.run("stop", "--reason", "Stop workers before historical transfer").status, 0);
    assert.equal(repo.run("resume", "--run", "pinned-recovery").status, 0);
    // A renamed branch at the same tip still carries the same code evidence.
    repo.git("branch", "feat/recovered", revision);
    const claimed = repo.run("claim", "--issue", "201", "--agent", "replacement-worker", "--branch", "feat/recovered");
    assert.equal(claimed.status, 0, claimed.stderr);
    const reclaimed = resultJson(repo.run("show")).remote.tickets[201];
    assert.equal(reclaimed.status, phase);
    assert.equal(reclaimed.activity, "inactive");
    assert.equal(reclaimed.activityAt, null);
    assert.equal(reclaimed.workingRevision, revision);
    assert.equal(reclaimed.stateAt, previous.stateAt);
    assert.deepEqual(reclaimed.review, previous.review);
    assert.deepEqual(reclaimed.integration, previous.integration);
    assert.equal(repo.run("stop", "--reason", "Stop before checking revision mismatch").status, 0);
    repo.git("checkout", "feat/recovered");
    repo.git("-c", "user.name=Recovery test", "-c", "user.email=recovery@example.test", "commit", "--allow-empty", "-m", "Unreviewed later work");
    assert.equal(repo.run("resume", "--run", "pinned-recovery").status, 0);
    const beforeRefusal = resultJson(repo.run("show")).remote.tickets[201];
    const changed = repo.run("claim", "--issue", "201", "--agent", "later-worker", "--branch", "feat/recovered", "--wait-seconds", "0");
    assert.equal(changed.status, 1, changed.stdout);
    assert.equal(resultJson(changed).error, "historical_revision_mismatch");
    assert.deepEqual(resultJson(repo.run("show")).remote.tickets[201], beforeRefusal);
    assert.equal(resultJson(repo.run("show", "--local")).local.pending.length, 0);
    assert.equal(resultJson(repo.run("sync")).synchronized, true);
  });
}

test("a lost dispatch response is acknowledged from canonical state without dropping or duplicating work", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "response-lost").status, 0);
  repo.updateRemote(remote => { remote.failure = { match: "POST repos/example/project/actions/workflows/agent-tracking.yml/dispatches", phase: "after", remaining: 1 }; });
  const claimed = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.equal(resultJson(claimed).synchronized, true);
  const state = resultJson(repo.run("show"));
  assert.equal(state.local.pending.length, 0);
  assert.equal(state.remote.revision, 2);
  assert.equal(Object.keys(repo.remote().items).length, 1);
  assert.equal(repo.remote().ticketComments.length, 1);
});

test("a dead controller lock and removed ticket worktree preserve durable queued work for resume", async t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "durable-controller").status, 0);
  const linked = repo.linked();
  repo.updateRemote(remote => { remote.deferDispatch = true; });
  const child = linked.spawn("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--at", "2026-11-05T00:00:00.000Z", "--wait-seconds", "600");
  t.after(() => child.kill("SIGKILL"));
  const deadline = Date.now() + 10000;
  while (repo.remote().dispatches.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(repo.remote().dispatches.length, 2);
  assert.equal(resultJson(repo.run("show", "--local")).error, "local_run_busy");
  child.kill("SIGKILL");
  await once(child, "exit");
  repo.git("worktree", "remove", "--force", linked.directory);
  repo.updateRemote(remote => { remote.deferDispatch = false; });
  const resumed = repo.run("resume");
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = resultJson(repo.run("show"));
  assert.equal(state.local.pending.length, 0);
  assert.equal(state.remote.tickets[201].stateAt, "2026-11-05T00:00:00.000Z");
  assert.equal(state.remote.owner.generation, 1);
  assert.equal(state.remote.tickets[201].status, "implementing");
});

test("resume repairs missing membership and reports unavailable Git evidence without inventing phase completion", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "evidence-owner").status, 0);
  assert.equal(repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket").status, 0);
  const originalTime = resultJson(repo.run("show")).remote.tickets[201].stateAt;
  const review = { base: "e".repeat(40), revision: "f".repeat(40), standardsPassed: true, specPassed: true };
  repo.updateRemote(remote => {
    const state = JSON.parse(remote.registry.match(/```json\n([\s\S]+)\n```/)[1]);
    state.tickets[201].status = "review";
    state.tickets[201].review = review;
    remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n`;
    remote.items = {};
    remote.missingCommits = [review.base, review.revision];
    remote.parents = { 201: 999 };
  });
  repo.git("branch", "-D", "feat/ticket");
  const resumed = repo.run("resume");
  assert.equal(resumed.status, 0, resumed.stderr);
  const record = resultJson(repo.run("show")).remote.tickets[201];
  assert.equal(record.status, "review");
  assert.equal(record.stateAt, originalTime);
  assert.deepEqual(record.review, review);
  assert.ok(record.recoveryEvidence.unverified.includes("local_branch_unavailable"));
  assert.ok(record.recoveryEvidence.unverified.includes(`commit_unavailable:${review.revision}`));
  assert.ok(record.recoveryEvidence.unverified.includes("parent_context_changed"));
  assert.equal(record.activity, "unverified");
  assert.equal(Object.keys(repo.remote().items).length, 1);
  assert.equal(repo.remote().ticketComments.length, 1);
});

test("receipt compaction preserves the latest unacknowledged owned outcome and every pending projection", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "bounded-history").status, 0);
  repo.updateRemote(remote => { remote.deferDispatch = true; });
  const queued = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  assert.equal(resultJson(queued).error, "publication_pending");
  const claim = JSON.parse(repo.remote().dispatches.at(-1));
  assert.equal(repo.worker(claim).status, 0);
  assert.equal(resultJson(repo.run("show")).remote.owner.lastEventId, claim.id);
  repo.updateRemote(remote => {
    const state = JSON.parse(remote.registry.match(/```json\n([\s\S]+)\n```/)[1]);
    for (let index = 0; index < 40; index++) state.receipts[`past-repair-${index}`] = { state: "published", type: "repair", revision: 2 };
    state.receipts["unverified-repair"] = { state: "pending", type: "repair", revision: 2 };
    remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n`;
    remote.failure = { match: "TrackerSetFields", phase: "before", remaining: 1 };
    remote.deferDispatch = false;
  });
  const repair = { id: "repair-across-bound", type: "repair", at: "2026-11-05T00:00:00.000Z", payload: {} };
  assert.equal(repo.worker(repair).status, 1);
  const interrupted = resultJson(repo.run("show")).remote;
  assert.equal(interrupted.receipts[claim.id].state, "published");
  assert.equal(interrupted.receipts["unverified-repair"].state, "pending");
  assert.equal(interrupted.receipts[repair.id].state, "pending");
  assert.ok(Object.keys(interrupted.receipts).length <= 35);
  const synced = repo.run("sync", "--wait-seconds", "0");
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(resultJson(synced).synchronized, true);
  assert.equal(resultJson(repo.run("show")).local.pending.length, 0);
  assert.ok(Object.keys(resultJson(repo.run("show")).remote.receipts).length <= 33);
  assert.equal(Object.keys(repo.remote().items).length, 1);
  assert.equal(repo.remote().ticketComments.length, 1);
});

test("a pruned passive discovery retry observes current facts and preserves newer owned progress", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  const issue = number => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body: "", state: "OPEN", subIssues: { totalCount: 0 }, labels: [] });
  repo.updateRemote(remote => { remote.issues = { 200: issue(200), 201: { ...issue(201), parent: issue(200), labels: ["ready-for-agent"] } }; });
  assert.equal(repo.run("discover").status, 0);
  const discovery = JSON.parse(repo.remote().dispatches.at(-1));
  assert.equal(repo.run("start", "--run", "latest-progress").status, 0);
  assert.equal(repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket").status, 0);
  const owned = resultJson(repo.run("show")).remote.tickets[201];
  repo.updateRemote(remote => {
    const snapshot = JSON.parse(remote.registry.match(/```json\n([\s\S]+)\n```/)[1]);
    for (let index = 0; index < 40; index++) snapshot.receipts[`later-repair-${index}`] = { state: "published", type: "repair", revision: snapshot.revision };
    remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`;
    remote.issues[201].parent = issue(300);
    remote.issues[201].labels = [];
    remote.issues[302] = { ...issue(302), parent: null, labels: ["ready-for-agent"] };
  });
  assert.equal(repo.run("repair").status, 0);
  assert.equal(resultJson(repo.run("show")).remote.receipts[discovery.id], undefined);
  assert.equal(repo.worker(discovery).status, 0);
  const current = resultJson(repo.run("show")).remote;
  assert.equal(current.receipts[discovery.id].state, "published");
  assert.deepEqual(current.tickets[201], owned);
  assert.equal(current.tickets[302].status, "ready");
  assert.equal(Object.keys(repo.remote().items).length, 3);
});

test("a pruned selection retry cannot rewind a newer view selection", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("discover", "--parent", "200", "--wait-seconds", "0").status, 0);
  const oldSelection = JSON.parse(repo.remote().dispatches.at(-1));
  repo.updateRemote(remote => {
    const snapshot = JSON.parse(remote.registry.match(/```json\n([\s\S]+)\n```/)[1]);
    for (let index = 0; index < 40; index++) snapshot.receipts[`newer-repair-${index}`] = { state: "published", type: "repair", revision: snapshot.revision };
    remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`;
  });
  assert.equal(repo.run("repair", "--wait-seconds", "0").status, 0);
  assert.equal(resultJson(repo.run("show")).remote.receipts[oldSelection.id], undefined);
  assert.equal(repo.run("discover", "--parent", "300", "--wait-seconds", "0").status, 0);
  const stale = repo.worker(oldSelection);
  assert.equal(stale.status, 1);
  assert.equal(resultJson(stale).error, "selection_superseded");
  const latest = resultJson(repo.run("show")).remote;
  assert.equal(latest.selectedParent, 300);
  assert.equal(latest.views.table.filter, 'parent-issue:"example/project#300"');
  assert.equal(repo.run("discover", "--parent", "200", "--wait-seconds", "0").status, 0);
  assert.equal(resultJson(repo.run("show")).remote.selectedParent, 200);
});

test("unknown or live local lock ownership is refused without deleting the lock", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "protected-lock").status, 0);
  const root = path.resolve(repo.directory, repo.git("rev-parse", "--git-common-dir"), "agent-tracker");
  const directory = path.join(root, fs.readdirSync(root)[0], "lock");
  for (const owner of [null, { pid: process.pid, host: "unverified-other-computer", token: "owner" }, { pid: process.pid, host: os.hostname(), token: "00000000-0000-4000-8000-000000000000" }]) {
    fs.mkdirSync(directory);
    if (owner) fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify(owner));
    const before = repo.remote().registry;
    const resumed = repo.run("resume");
    assert.equal(resumed.status, 1);
    assert.equal(resultJson(resumed).error, owner?.host === os.hostname() ? "local_run_busy" : "local_lock_unverified");
    assert.ok(fs.existsSync(directory));
    assert.equal(repo.remote().registry, before);
    fs.rmSync(directory, { recursive: true });
  }
});

test("takeover refuses unverifiable or changed ownership before dispatch", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "verified-owner").status, 0);
  const clone = repo.clone();
  assert.equal(clone.setup().status, 0);
  const count = repo.remote().dispatches.length;
  const before = repo.remote().registry;
  assert.equal(resultJson(clone.run("takeover", "--run", "replacement", "--from-run", "verified-owner", "--from-generation", "2", "--reason", "Wrong generation")).error, "run_superseded");
  repo.updateRemote(remote => { remote.fail = "network unavailable"; });
  assert.equal(resultJson(clone.run("takeover", "--run", "replacement", "--from-run", "verified-owner", "--from-generation", "1", "--reason", "Unavailable ownership")).error, "github_connection_failed");
  assert.equal(repo.remote().dispatches.length, count);
  assert.equal(repo.remote().registry, before);
});

test("out-of-order future events stay retryable and late old sequences never regain authority", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "ordered-owner").status, 0);
  const before = repo.remote().registry;
  const future = { id: "future-event", type: "resume", runId: "ordered-owner", generation: 1, sequence: 2, at: "2026-11-05T00:00:00.000Z", payload: {} };
  assert.equal(resultJson(repo.worker(future)).error, "event_out_of_order");
  assert.equal(repo.remote().registry, before);
  const first = { ...future, id: "first-event", sequence: 1 };
  assert.equal(repo.worker(first).status, 0);
  assert.equal(repo.worker(future).status, 0);
  const old = { ...first, id: "different-old-event" };
  assert.equal(resultJson(repo.worker(old)).error, "event_superseded");
  const state = resultJson(repo.run("show")).remote;
  assert.equal(state.owner.sequence, 2);
  assert.equal(state.owner.lastEventId, future.id);
});

test("retries after individual remote effects preserve pending intent and converge without duplicate comments", t => {
  for (const match of ["PATCH repos/example/project/issues/comments/900", "TrackerSetFields", "POST repos/example/project/issues/201/comments"]) {
    const repo = trackerFixture(t);
    assert.equal(repo.setup().status, 0);
    assert.equal(repo.run("start", "--run", "partial-effects").status, 0);
    repo.updateRemote(remote => { remote.failure = { match, phase: "after", remaining: 1 }; });
    const claim = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--wait-seconds", "0");
    assert.equal(resultJson(claim).error, "publication_pending", match);
    const pending = resultJson(repo.run("show"));
    assert.equal(pending.local.pending.length, 1, match);
    assert.equal(pending.local.lastConfirmed.revision, 1, match);
    assert.equal(pending.remote.revision, 2, match);
    assert.equal(pending.remote.publishedRevision, 1, match);
    const synced = repo.run("sync", "--wait-seconds", "0");
    assert.equal(synced.status, 0, `${match}: ${synced.stderr}`);
    assert.equal(resultJson(synced).synchronized, true, match);
    assert.equal(Object.keys(repo.remote().items).length, 1, match);
    assert.equal(repo.remote().ticketComments.length, 1, match);
  }
});

test("an older asynchronous registry response cannot downgrade the durable known state", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  const initial = repo.remote().registry;
  assert.equal(repo.run("start", "--run", "monotonic-owner").status, 0);
  assert.equal(repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket").status, 0);
  repo.updateRemote(remote => { remote.staleRegistry = { body: initial, remaining: 1 }; });
  const synchronized = repo.run("sync");
  assert.equal(synchronized.status, 1);
  assert.equal(resultJson(synchronized).error, "registry_snapshot_stale");
  const local = resultJson(repo.run("show", "--local")).local;
  assert.equal(local.lastConfirmed.revision, 2);
  assert.equal(local.lastObserved.revision, 2);
  assert.equal(local.run.generation, 1);
  assert.equal(repo.run("sync").status, 0);
});

test("a contradictory stop timestamp is refused without releasing or corrupting ownership", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "chronological-owner", "--at", "2026-11-05T00:00:00.000Z").status, 0);
  const stopped = repo.run("stop", "--reason", "Invalid historical stop", "--at", "2026-11-04T00:00:00.000Z", "--wait-seconds", "0");
  assert.equal(stopped.status, 1);
  assert.equal(resultJson(stopped).error, "event_invalid");
  assert.equal(repo.run("doctor").status, 0);
  assert.equal(resultJson(repo.run("show")).remote.owner.runId, "chronological-owner");
});
