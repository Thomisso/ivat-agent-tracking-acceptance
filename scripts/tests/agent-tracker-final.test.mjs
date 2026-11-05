import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}
function prepare(t, specification = true) {
  const repo = trackerFixture(t);
  repo.git("checkout", "feat/ticket");
  writeFileSync(path.join(repo.directory, "implementation.txt"), "Reviewed delivered behavior\n");
  repo.git("add", "implementation.txt");
  repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "-m", "Implement behavior");
  const revision = repo.git("rev-parse", "feat/ticket");
  repo.git("branch", "integration/spec");
  repo.updateRemote(remote => {
    remote.issues = {
      200: { id: "I_200", number: 200, title: "Specification", url: "https://github.com/example/project/issues/200", state: "OPEN", labels: [], body: "", subIssues: { totalCount: 1 }, repository: { nameWithOwner: "example/project" } },
      201: { id: "I_201", number: 201, title: "Implementation", url: "https://github.com/example/project/issues/201", state: "OPEN", labels: ["ready-for-agent"], body: "", parent: specification ? { id: "I_200", number: 200, title: "Specification", url: "https://github.com/example/project/issues/200", repository: { nameWithOwner: "example/project" } } : null, subIssues: { totalCount: 0 }, repository: { nameWithOwner: "example/project" } },
    };
    remote.parents = { 201: specification ? 200 : null };
    remote.subIssues = { 200: [201] };
    remote.pulls = { 300: { number: 300, node_id: "PR_300", html_url: "https://github.com/example/project/pull/300", state: "open", draft: true, merged: false, merged_at: null, merge_commit_sha: null, head: { ref: specification ? "integration/spec" : "feat/ticket", sha: revision, repo: { full_name: "example/project" } }, base: { ref: "main", repo: { full_name: "example/project" } } } };
  });
  assert.equal(repo.setup().status, 0);
  execute(repo, "discover");
  execute(repo, "start", "--run", "final-run");
  execute(repo, "claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket", ...(specification ? ["--spec", "200", "--integration-branch", "integration/spec"] : []));
  execute(repo, "review", "--issue", "201", "--base", repo.git("rev-parse", "main"), "--revision", revision, "--checks", "Focused tests, typecheck and lint passed", "--result", "Implementation complete");
  execute(repo, "review-result", "--issue", "201", "--reviewer", "ticket-reviewer", "--revision", revision, "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent ticket/base/diff review", "--result", "No hard findings");
  if (specification) execute(repo, "integrate", "--issue", "201", "--integration-commit", revision, "--result", "Reviewed ticket integrated");
  return { ...repo, revision, issue: specification ? "200" : "201" };
}

test("integrated children leave independent whole-specification gates outstanding", t => {
  const repo = prepare(t);
  execute(repo, "final-pr", "--issue", "200", "--pr", "300", "--result", "Integration PR opened");
  const parent = execute(repo, "show").remote.tickets[200];
  assert.equal(parent.summary.counts.integrated, 1);
  assert.equal(parent.summary.checks, "outstanding");
  assert.equal(parent.summary.review, "outstanding");
  assert.equal(parent.summary.revision, repo.revision);
  assert.equal(parent.summary.pullRequest.state, "draft");
  assert.match(repo.remote().comments[200][0].body, /Shared checks: outstanding/);
  const handoff = repo.run("final-handoff", "--issue", "200", "--result", "Hand over specification");
  assert.equal(resultJson(handoff).error, "final_checks_required");
  assert.equal(repo.remote().pulls[300].draft, true);
});

function checks(repo, failed = false) {
  const names = repo.issue === "200" ? ["test:serial", "typecheck", "lint", "build", "runtime"] : ["focused", "typecheck", "lint", "runtime"];
  return names.map(name => ({ name, status: failed && name === "lint" ? "failed" : "passed", evidence: `https://github.com/example/project/actions/runs/123#${name}` }));
}
function bind(repo) { return execute(repo, "final-pr", "--issue", repo.issue, "--pr", "300", "--result", "Final PR bound"); }
function finalChecks(repo, values = checks(repo)) {
  return execute(repo, "final-checks", "--issue", repo.issue, "--revision", repo.revision, "--checks", JSON.stringify(values), "--result", "Controller reports actual check results");
}
function finalReview(repo, extra = []) {
  return repo.run("final-review", "--issue", repo.issue, "--revision", repo.revision, "--reviewer", "combined-reviewer", "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent review of entire specification and diff", "--evidence", "https://github.com/example/project/issues/200#issuecomment-123", "--result", "Combined review complete", ...extra);
}

test("shared checks and independent combined review report failure and invalidate on changed revision", t => {
  const repo = prepare(t);
  bind(repo);
  finalChecks(repo, checks(repo, true));
  assert.equal(execute(repo, "show").remote.tickets[200].summary.checks, "failed");
  finalChecks(repo);
  const selfReview = finalReview(repo, ["--reviewer", "implementer"]);
  assert.equal(resultJson(selfReview).error, "reviewer_not_independent");
  assert.equal(finalReview(repo, ["--spec", "fail", "--findings", '["Missing final gate"]']).status, 0);
  assert.equal(execute(repo, "show").remote.tickets[200].summary.review, "failed");
  assert.equal(finalReview(repo).status, 0);
  assert.equal(execute(repo, "show").remote.tickets[200].summary.review, "passed");
  repo.git("checkout", "integration/spec");
  repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "--allow-empty", "-m", "Later revision");
  const next = repo.git("rev-parse", "HEAD");
  repo.updateRemote(remote => { remote.pulls[300].head.sha = next; });
  bind(repo);
  const parent = execute(repo, "show").remote.tickets[200];
  assert.equal(parent.summary.checks, "invalidated");
  assert.equal(parent.summary.review, "invalidated");
  assert.equal(parent.final.checks.revision, repo.revision);
  assert.equal(parent.final.review.revision, repo.revision);
  assert.equal(repo.remote().pulls[300].draft, true);
});

function evidenceComplete(repo) {
  bind(repo); finalChecks(repo);
  const reviewed = finalReview(repo);
  assert.equal(reviewed.status, 0, reviewed.stderr);
}

test("final handoff changes the actual PR only after complete publication and applicable evidence", t => {
  const repo = prepare(t);
  evidenceComplete(repo);
  repo.updateRemote(remote => { remote.failure = { match: "TrackerSetFields", phase: "after", remaining: 1 }; });
  const partial = repo.run("final-handoff", "--issue", "200", "--result", "Ready handoff", "--wait-seconds", "0");
  assert.equal(resultJson(partial).error, "publication_pending");
  assert.equal(repo.remote().pulls[300].draft, true);
  const queued = repo.run("final-handoff", "--issue", "200", "--result", "Cannot bypass pending projection", "--wait-seconds", "0");
  assert.equal(resultJson(queued).error, "synchronization_required");
  execute(repo, "sync", "--wait-seconds", "0");
  assert.equal(repo.remote().pulls[300].draft, false);
  execute(repo, "final-handoff", "--issue", "200", "--result", "Repeated handoff");
  assert.equal(repo.remote().readyTransitions, 1);
  assert.equal(execute(repo, "show").remote.tickets[200].final.handoff.state, "ready");
  assert.equal(execute(repo, "show").remote.tickets[201].status, "integrated");
});

function mergeDelivery(repo, numbers = [Number(repo.issue)], resultRevision = repo.revision) {
  repo.git("branch", "-f", "main", resultRevision);
  repo.updateRemote(remote => {
    Object.assign(remote.pulls[300], { state: "closed", draft: false, merged: true, merged_at: "2026-11-05T15:00:00Z", merge_commit_sha: resultRevision });
    for (const number of numbers) {
      remote.issues[number].state = "CLOSED";
      const pr = { number: 300, merged: true, mergedAt: "2026-11-05T15:00:00Z", mergeCommit: { oid: resultRevision }, baseRefName: "main", repository: { nameWithOwner: "example/project", defaultBranchRef: { name: "main" } } };
      remote.finalMerges ??= {};
      remote.finalMerges[number] = { state: "CLOSED", stateReason: "COMPLETED", closedByPullRequestsReferences: { nodes: [pr], pageInfo: { hasNextPage: false } }, timelineItems: { nodes: [{ __typename: "ClosedEvent", createdAt: "2026-11-05T15:00:00Z", closer: { __typename: "PullRequest", ...pr } }] } };
    }
  });
}

test("standalone final completion needs actual merge and current PR closure and reconciles after controller stop", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo);
  repo.updateRemote(remote => { remote.issues[201].state = "CLOSED"; remote.pulls[300].state = "closed"; });
  execute(repo, "reconcile");
  assert.equal(execute(repo, "show").remote.tickets[201].status, "review");
  mergeDelivery(repo);
  execute(repo, "stop", "--reason", "Human will merge while controller is stopped");
  const passive = repo.worker(null, { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_RUN_ID: "456" });
  assert.equal(passive.status, 0, passive.stderr);
  const ticket = execute(repo, "show").remote.tickets[201];
  assert.equal(ticket.status, "done");
  assert.equal(ticket.delivery.resultCommit, repo.revision);
  assert.equal(ticket.integrationContext, null);
  assert.match(repo.remote().ticketComments[0].body, /Delivery evidence/);
});

test("integration completion verifies the parent and every child closure independently", t => {
  const repo = prepare(t);
  evidenceComplete(repo);
  mergeDelivery(repo, [200]);
  execute(repo, "reconcile");
  assert.notEqual(execute(repo, "show").remote.tickets[200].status, "done");
  mergeDelivery(repo, [200, 201]);
  execute(repo, "reconcile");
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[200].status, "done");
  assert.equal(state.tickets[201].status, "done");
  assert.equal(state.tickets[200].summary.counts.done, 1);
});

test("explicit cancellation needs a reason and remains distinct from interruption or delivery", t => {
  const repo = prepare(t, false);
  const missing = repo.run("cancel", "--issue", "201", "--result", "Cancel implementation");
  assert.equal(resultJson(missing).error, "event_invalid");
  execute(repo, "stop", "--reason", "Interrupted controller");
  assert.equal(execute(repo, "show").remote.tickets[201].status, "review");
  execute(repo, "resume");
  execute(repo, "cancel", "--issue", "201", "--reason", "Maintainer abandoned this scope", "--result", "Explicit cancellation");
  execute(repo, "reconcile");
  const ticket = execute(repo, "show").remote.tickets[201];
  assert.equal(ticket.status, "cancelled");
  assert.equal(ticket.cancellation.reason, "Maintainer abandoned this scope");
  assert.equal(ticket.activity, "inactive");
  assert.equal(ticket.delivery, undefined);
});

test("manual Project moves report a conflict and restore evidence without controlling agents", t => {
  const repo = prepare(t, false);
  const before = execute(repo, "show").remote;
  repo.updateRemote(remote => { remote.items.I_201.values.status = { singleSelectOptionId: "status-4" }; });
  execute(repo, "reconcile");
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[201].status, "review");
  assert.equal(state.tickets[201].agent, "implementer");
  assert.equal(state.owner.runId, before.owner.runId);
  assert.ok(state.tickets[201].manualConflict.fields.includes("status"));
  assert.match(repo.remote().ticketComments[0].body, /Unsupported Project field/);
  assert.deepEqual(repo.remote().items.I_201.values.status, { singleSelectOptionId: "status-2" });
});

test("reopen and an explicitly attested merged reversal invalidate old delivery and cannot launch work", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo); mergeDelivery(repo);
  execute(repo, "reconcile");
  assert.equal(execute(repo, "show").remote.tickets[201].status, "done");
  repo.updateRemote(remote => { remote.issues[201].state = "OPEN"; remote.finalMerges[201].state = "OPEN"; remote.finalMerges[201].timelineItems.nodes = [{ __typename: "ReopenedEvent" }]; });
  execute(repo, "reconcile");
  let ticket = execute(repo, "show").remote.tickets[201];
  assert.equal(ticket.status, "review");
  assert.equal(ticket.delivery.current, false);
  assert.equal(ticket.activity, "inactive");
  mergeDelivery(repo);
  execute(repo, "reconcile");
  repo.git("checkout", "-b", "reversal", "main");
  repo.git("revert", "--no-commit", repo.revision);
  repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "-m", "Remove delivered behavior");
  const reversal = repo.git("rev-parse", "HEAD");
  repo.git("branch", "-f", "main", reversal);
  repo.updateRemote(remote => { remote.pulls[301] = { ...remote.pulls[300], number: 301, node_id: "PR_301", html_url: "https://github.com/example/project/pull/301", merge_commit_sha: reversal, head: { ...remote.pulls[300].head, sha: reversal, ref: "reversal" } }; });
  execute(repo, "reverse", "--issue", "201", "--delivery-pr", "300", "--reversal-pr", "301", "--reason", "Maintainer reverted the delivered behavior", "--evidence", "https://github.com/example/project/pull/301#issuecomment-456", "--result", "Reviewed reversal removes this delivery");
  execute(repo, "reconcile");
  ticket = execute(repo, "show").remote.tickets[201];
  assert.equal(ticket.delivery.current, false);
  assert.equal(ticket.reversal.state, "merged");
  assert.equal(ticket.status, "review");
  assert.equal(ticket.activity, "inactive");
  assert.equal(ticket.delivery.reason, "delivery_reversed");
});

test("repository configuration declares applicable final checks and missing named evidence stays outstanding", t => {
  const repo = prepare(t, false);
  const file = path.join(repo.directory, ".github/agent-tracking.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.finalChecks = { specification: ["tracker-tests", "syntax", "diff"], standalone: ["tracker-tests", "syntax", "diff"] };
  writeFileSync(file, JSON.stringify(config));
  bind(repo);
  const incomplete = [{ name: "tracker-tests", status: "passed", evidence: "Real isolated tracker tests passed on the named revision" }];
  finalChecks(repo, incomplete);
  assert.equal(execute(repo, "show").remote.tickets[201].summary.checks, "outstanding");
  finalChecks(repo, [...incomplete, { name: "syntax", status: "passed", evidence: "Real node syntax checks passed" }, { name: "diff", status: "passed", evidence: "Real git diff check passed" }]);
  assert.equal(execute(repo, "show").remote.tickets[201].summary.checks, "passed");
  config.finalChecks.standalone = [];
  writeFileSync(file, JSON.stringify(config));
  assert.equal(resultJson(repo.run("show")).error, "configuration_invalid");
});

test("squashed results need exact content applicability and differing output needs renewed actual-result evidence", t => {
  for (const changedResult of [false, true]) {
    const repo = prepare(t, false);
    evidenceComplete(repo);
    repo.git("checkout", "-b", "squashed-result", "main");
    repo.git("merge", "--squash", "feat/ticket");
    if (changedResult) {
      writeFileSync(path.join(repo.directory, "extra.txt"), "Additional resulting behavior needs checks and review\n");
      repo.git("add", "extra.txt");
    }
    repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "-m", "Squashed delivery");
    const result = repo.git("rev-parse", "HEAD");
    mergeDelivery(repo, [201], result);
    execute(repo, "reconcile");
    let ticket = execute(repo, "show").remote.tickets[201];
    assert.equal(ticket.status, changedResult ? "review" : "done");
    assert.equal(ticket.summary.checks, changedResult ? "invalidated" : "passed");
    if (changedResult) {
      finalChecks({ ...repo, revision: result });
      assert.equal(finalReview({ ...repo, revision: result }).status, 0);
      execute(repo, "reconcile");
      ticket = execute(repo, "show").remote.tickets[201];
      assert.equal(ticket.status, "done");
      assert.equal(ticket.delivery.resultCommit, result);
    } else {
      assert.equal(ticket.final.checks.revision, repo.revision);
      assert.equal(ticket.final.checks.appliesTo, result);
    }
  }
});

test("partial and repeated old final reconciliation rereads reopening instead of restoring obsolete completion", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo); mergeDelivery(repo);
  repo.updateRemote(remote => { remote.failure = { match: "TrackerSetFields", phase: "after", remaining: 1 }; });
  const partial = repo.run("reconcile", "--wait-seconds", "0");
  assert.equal(resultJson(partial).error, "publication_pending");
  const old = JSON.parse(repo.remote().dispatches.at(-1));
  repo.updateRemote(remote => { remote.issues[201].state = "OPEN"; remote.finalMerges[201].state = "OPEN"; remote.finalMerges[201].timelineItems.nodes = [{ __typename: "ReopenedEvent" }]; });
  execute(repo, "sync", "--wait-seconds", "0");
  assert.equal(execute(repo, "show").remote.tickets[201].status, "review");
  assert.equal(repo.worker(old).status, 0);
  assert.equal(execute(repo, "show").remote.tickets[201].delivery.current, false);
  assert.equal(repo.remote().ticketComments.length, 1);
});

test("head changes during ready mutation restore draft and do not acknowledge successful handoff", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo);
  repo.git("checkout", "-b", "later", "feat/ticket");
  repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "--allow-empty", "-m", "Concurrent new head");
  repo.updateRemote(remote => { remote.pushDuringReady = repo.git("rev-parse", "HEAD"); });
  const handoff = repo.run("final-handoff", "--issue", "201", "--result", "Attempt ready handoff", "--wait-seconds", "0");
  assert.equal(resultJson(handoff).error, "final_revision_changed");
  assert.equal(repo.remote().pulls[300].draft, true);
  assert.equal(execute(repo, "show").remote.tickets[201].final.handoff.state, "refused");
});

test("native child identities retain foreign-repository number collisions as outstanding work", t => {
  const repo = prepare(t);
  evidenceComplete(repo);
  repo.updateRemote(remote => { remote.subIssues[200] = [...Array.from({ length: 100 }, (_, index) => ({ number: 400 + index })), { number: 201, repository_url: "https://api.github.com/repos/example/project" }, { number: 201, repository_url: "https://api.github.com/repos/other/repository" }]; });
  execute(repo, "reconcile");
  const parent = execute(repo, "show").remote.tickets[200];
  assert.equal(parent.summary.counts.integrated, 1);
  assert.equal(parent.summary.counts.untracked, 101);
  assert.ok(parent.summary.children.includes("other/repository#201"));
  const handoff = repo.run("final-handoff", "--issue", "200", "--result", "Cannot hide foreign implementation");
  assert.equal(resultJson(handoff).error, "final_children_required");
  assert.equal(repo.remote().pulls[300].draft, true);
});

test("an explicitly registered child reversal invalidates its own and the whole specification delivery", t => {
  const repo = prepare(t);
  evidenceComplete(repo); mergeDelivery(repo, [200, 201]); execute(repo, "reconcile");
  repo.git("checkout", "-b", "child-reversal", "main");
  repo.git("revert", "--no-commit", repo.revision);
  repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "-m", "Undo delivered child behavior");
  const reversal = repo.git("rev-parse", "HEAD");
  repo.git("branch", "-f", "main", reversal);
  repo.updateRemote(remote => { remote.pulls[301] = { ...remote.pulls[300], number: 301, node_id: "PR_301", html_url: "https://github.com/example/project/pull/301", merge_commit_sha: reversal, head: { ...remote.pulls[300].head, sha: reversal, ref: "child-reversal" } }; });
  execute(repo, "reverse", "--issue", "201", "--delivery-pr", "300", "--reversal-pr", "301", "--reason", "The identified child implementation was reversed", "--evidence", "https://github.com/example/project/pull/301#issuecomment-456", "--result", "Independent reviewer attests the child behavior was undone");
  execute(repo, "reconcile");
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[201].reversal.state, "merged");
  assert.equal(state.tickets[201].delivery.current, false);
  assert.equal(state.tickets[200].delivery.current, false);
  assert.notEqual(state.tickets[201].status, "done");
  assert.notEqual(state.tickets[200].status, "done");
});

test("manual conflict evidence survives partial restoration and excludes legitimate phase changes", t => {
  const repo = prepare(t, false);
  repo.updateRemote(remote => {
    const agentField = remote.fields.find(field => field.name === "Agent").id;
    remote.items.I_201.values[agentField] = { text: "unsupported-manual-agent" };
    remote.items.I_201.values.status = { singleSelectOptionId: "status-4" };
    remote.failure = { match: "TrackerSetFields", phase: "after", remaining: 1 };
  });
  const partial = repo.run("review-result", "--issue", "201", "--reviewer", "ticket-reviewer", "--revision", repo.revision, "--standards", "fail", "--spec", "pass", "--findings", '["Actual review requires fixes"]', "--independence", "Independent ticket review", "--result", "Reviewer returned implementation for fixes", "--wait-seconds", "0");
  assert.equal(resultJson(partial).error, "publication_pending");
  execute(repo, "sync", "--wait-seconds", "0");
  const ticket = execute(repo, "show").remote.tickets[201];
  assert.equal(ticket.status, "implementing");
  assert.equal(ticket.agent, "implementer");
  assert.deepEqual(ticket.manualConflict.fields.sort(), ["agent", "status"]);
  assert.match(repo.remote().ticketComments[0].body, /Unsupported Project field edit/);
  assert.equal(repo.remote().ticketComments.length, 1);
});

test("a lost ready response remains pending and retry acknowledges the single actual transition", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo);
  repo.updateRemote(remote => { remote.failure = { match: "TrackerReady", phase: "after", remaining: 1 }; });
  const lost = repo.run("final-handoff", "--issue", "201", "--result", "Observed authorized handoff", "--wait-seconds", "0");
  assert.equal(resultJson(lost).error, "publication_pending");
  assert.equal(repo.remote().pulls[300].draft, false);
  execute(repo, "sync", "--wait-seconds", "0");
  assert.equal(repo.remote().readyTransitions, 1);
  assert.equal(execute(repo, "show").remote.tickets[201].final.handoff.state, "ready");
});

test("untracked native children remain outstanding when final evidence is missing instead of crashing reconciliation", t => {
  const repo = prepare(t);
  bind(repo);
  repo.updateRemote(remote => { remote.subIssues[200].push(999); });
  execute(repo, "reconcile");
  const parent = execute(repo, "show").remote.tickets[200];
  assert.equal(parent.summary.counts.untracked, 1);
  assert.equal(parent.summary.checks, "outstanding");
  assert.equal(parent.final.gate.error, "final_checks_required");
  assert.notEqual(parent.status, "done");
});

test("failed draft restoration after a ready-head race is completed on retry before refusing handoff", t => {
  for (const phase of ["before", "after"]) {
    const repo = prepare(t, false);
    evidenceComplete(repo);
    repo.git("checkout", "-b", "later", "feat/ticket");
    repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "--allow-empty", "-m", "Concurrent head");
    repo.updateRemote(remote => {
      remote.pushDuringReady = repo.git("rev-parse", "HEAD");
      remote.failure = { match: "TrackerRestoreDraft", phase, remaining: 1 };
    });
    const partial = repo.run("final-handoff", "--issue", "201", "--result", "Authorized final handoff", "--wait-seconds", "0");
    assert.equal(resultJson(partial).error, "publication_pending");
    const retried = repo.run("sync", "--wait-seconds", "0");
    assert.equal(resultJson(retried).error, "final_revision_changed");
    assert.equal(repo.remote().pulls[300].draft, true);
    assert.equal(execute(repo, "show").remote.tickets[201].final.handoff.state, "refused");
  }
});

test("already-ready retry checks its final observed head before acknowledging old gates", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo);
  repo.updateRemote(remote => { remote.failure = { match: "TrackerReady", phase: "after", remaining: 1 }; });
  const lost = repo.run("final-handoff", "--issue", "201", "--result", "Authorized handoff", "--wait-seconds", "0");
  assert.equal(resultJson(lost).error, "publication_pending");
  repo.git("checkout", "-b", "later", "feat/ticket");
  repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "--allow-empty", "-m", "Push races with ready retry");
  repo.updateRemote(remote => { remote.pushOnPullRead = { remaining: 2, sha: repo.git("rev-parse", "HEAD") }; });
  const retry = repo.run("sync", "--wait-seconds", "0");
  assert.equal(resultJson(retry).error, "final_revision_changed");
  assert.equal(repo.remote().pulls[300].draft, true);
  assert.equal(execute(repo, "show").remote.tickets[201].final.handoff.state, "refused");
});

test("verified current delivery cannot be relabelled as undelivered cancellation", t => {
  const repo = prepare(t, false);
  evidenceComplete(repo); mergeDelivery(repo); execute(repo, "reconcile");
  const before = execute(repo, "show").remote.tickets[201];
  const cancellation = repo.run("cancel", "--issue", "201", "--reason", "Attempt to cancel already delivered implementation", "--result", "Cannot undo delivery by cancelling tracking");
  assert.equal(resultJson(cancellation).error, "implementation_already_delivered");
  const after = execute(repo, "show").remote.tickets[201];
  assert.equal(after.status, "done");
  assert.equal(after.delivery.current, true);
  assert.deepEqual(after.delivery, before.delivery);
  assert.equal(after.cancellation, undefined);
});

test("a foreign parent context cannot inherit a same-number local specification summary", t => {
  const repo = prepare(t);
  repo.updateRemote(remote => {
    remote.issues[202] = { ...remote.issues[201], id: "I_202", number: 202, title: "Local work with foreign parent", url: "https://github.com/example/project/issues/202", parent: { id: "I_foreign_200", number: 200, title: "Foreign parent context", url: "https://github.com/other/repository/issues/200", repository: { nameWithOwner: "other/repository" } } };
  });
  execute(repo, "discover");
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[200].summary.counts.integrated, 1);
  const foreign = state.tickets["other/repository#200"];
  assert.equal(foreign.summary.scope, "context_only");
  assert.equal(foreign.summary.repository, "other/repository");
  assert.equal(foreign.summary.counts, undefined);
  assert.equal(foreign.status, null);
  assert.match(repo.remote().foreignComments[0].body, /Foreign specification context only/);
  assert.doesNotMatch(repo.remote().foreignComments[0].body, /Child phases:/);
  assert.equal(state.tickets[202].parentRepository, "other/repository");
});

test("an agent of an unrelated foreign parent may independently review a same-number local specification", t => {
  const repo = prepare(t);
  repo.git("branch", "feat/foreign-context");
  repo.updateRemote(remote => {
    remote.issues[202] = { ...remote.issues[201], id: "I_202", number: 202, title: "Work in another parent context", url: "https://github.com/example/project/issues/202", parent: { id: "I_foreign_200", number: 200, title: "Foreign specification", url: "https://github.com/other/repository/issues/200", html_url: "https://github.com/other/repository/issues/200", repository_url: "https://api.github.com/repos/other/repository", repository: { nameWithOwner: "other/repository" } } };
  });
  execute(repo, "discover");
  execute(repo, "claim", "--issue", "202", "--agent", "foreign-worker", "--branch", "feat/foreign-context", "--result", "Separate parent work claimed");
  bind(repo); finalChecks(repo);
  const review = finalReview(repo, ["--reviewer", "foreign-worker"]);
  assert.equal(review.status, 0, review.stderr);
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[200].summary.review, "passed");
  assert.equal(state.tickets[200].summary.counts.integrated, 1);
  assert.equal(state.tickets[202].parentRepository, "other/repository");
  assert.equal(state.tickets["other/repository#200"].summary.scope, "context_only");
});

test("target content absent from the checked head refuses fresh and already-ready handoff and compensates a race", t => {
  const outcomes = [];
  for (const mode of ["before", "during", "already_ready"]) {
    const repo = prepare(t, false);
    evidenceComplete(repo);
    repo.git("checkout", "-b", "advanced-target", "main");
    writeFileSync(path.join(repo.directory, "target.txt"), "New target content absent from the checked head\n");
    repo.git("add", "target.txt");
    repo.git("-c", "user.name=Final test", "-c", "user.email=final@example.test", "commit", "-m", "Advance final target");
    const target = repo.git("rev-parse", "HEAD");
    let result;
    if (mode === "before") {
      repo.git("branch", "-f", "main", target);
      result = repo.run("final-handoff", "--issue", "201", "--result", "Checked head omits new target content");
    } else if (mode === "during") {
      repo.updateRemote(remote => { remote.advanceTargetDuringReady = target; });
      result = repo.run("final-handoff", "--issue", "201", "--result", "Target races with the authorized ready effect");
    } else {
      repo.updateRemote(remote => { remote.failure = { match: "TrackerReady", phase: "after", remaining: 1 }; });
      assert.equal(resultJson(repo.run("final-handoff", "--issue", "201", "--result", "Ready response lost before target advance")).error, "publication_pending");
      repo.git("branch", "-f", "main", target);
      result = repo.run("sync");
    }
    outcomes.push({ mode, error: resultJson(result).error, draft: repo.remote().pulls[300].draft, handoff: execute(repo, "show").remote.tickets[201].final.handoff.state });
  }
  assert.deepEqual(outcomes, [
    { mode: "before", error: "final_target_changed", draft: true, handoff: "refused" },
    { mode: "during", error: "final_target_changed", draft: true, handoff: "refused" },
    { mode: "already_ready", error: "final_target_changed", draft: true, handoff: "refused" },
  ]);
});
