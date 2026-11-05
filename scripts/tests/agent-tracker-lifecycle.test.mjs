import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const command = new URL("../agent-tracker.mjs", import.meta.url).pathname;

function repository(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-tracker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Tracker test", "-c", "user.email=tracker@example.test", "commit", "--allow-empty", "-m", "Fixture"], { cwd: directory, stdio: "pipe" });
  execFileSync("git", ["branch", "feat/ticket"], { cwd: directory, stdio: "pipe" });
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  copyFileSync(new URL("support/agent-tracker-gh.mjs", import.meta.url), path.join(bin, "gh"));
  chmodSync(path.join(bin, "gh"), 0o755);
  const remote = path.join(directory, "github.json");
  writeFileSync(remote, JSON.stringify({ project: { id: "PVT_test", title: "Agent work", url: "https://github.com/users/example/projects/1" }, fields: [{ id: "status", name: "Status", dataType: "SINGLE_SELECT", options: [] }, { id: "parent", name: "Parent issue", dataType: "PARENT_ISSUE" }, { id: "title", name: "Title", dataType: "TITLE" }] }));
  return {
    directory,
    remote: () => JSON.parse(readFileSync(remote, "utf8")),
    updateRemote: update => { const state = JSON.parse(readFileSync(remote, "utf8")); update(state); writeFileSync(remote, JSON.stringify(state)); },
    run: (...args) => spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: remote, TRACKER_COMMAND: command } }),
    worker: event => spawnSync(process.execPath, [command, "worker"], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: remote, TRACKER_COMMAND: command, GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/agent-tracking.yml@refs/heads/main", GITHUB_ACTOR: "maintainer", TRACKER_EVENT: JSON.stringify(event) } }),
  };
}

function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function begin(t, context = []) {
  const repo = repository(t);
  execute(repo, "setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99");
  execute(repo, "start", "--run", "lifecycle");
  execute(repo, "claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket", ...context);
  return repo;
}
function git(repo, ...args) { return execFileSync("git", args, { cwd: repo.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function shown(repo) { return execute(repo, "show").remote.tickets[201]; }

test("standalone implementation reaches waiting review with focused checks bound to the actual branch tip", t => {
  const repo = begin(t);
  const revision = git(repo, "rev-parse", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Focused tracker tests, typecheck and lint passed", "--result", "Implementation complete");
  const ticket = shown(repo);
  assert.equal(ticket.status, "review");
  assert.equal(ticket.activity, "inactive");
  assert.equal(ticket.reviewer, null);
  assert.equal(ticket.review.revision, revision);
  assert.equal(ticket.review.checks, "Focused tracker tests, typecheck and lint passed");
  assert.equal(ticket.integrationContext, null);
});

function handoff(repo) {
  const revision = git(repo, "rev-parse", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", git(repo, "rev-parse", "main"), "--revision", revision, "--checks", "Focused tests, typecheck and lint passed", "--result", "Implementation complete");
  return revision;
}
function reviewResult(repo, options = []) {
  return repo.run("review-result", "--issue", "201", "--revision", git(repo, "rev-parse", "feat/ticket"), "--reviewer", "independent-reviewer", "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Reviewer received ticket, base and diff without implementation context", "--result", "Independent review complete", ...options);
}
test("reviewer observations distinguish working from waiting and hard findings return to implementation", t => {
  const repo = begin(t);
  handoff(repo);
  const masquerade = repo.run("review-start", "--issue", "201", "--reviewer", "implementer", "--result", "Reviewing now");
  assert.equal(JSON.parse(masquerade.stderr).error, "reviewer_not_independent");
  execute(repo, "review-start", "--issue", "201", "--reviewer", "independent-reviewer", "--result", "Reviewer reports reading the diff");
  assert.equal(shown(repo).activity, "confirmed");
  assert.equal(shown(repo).reviewer, "independent-reviewer");
  const findings = reviewResult(repo, ["--standards", "fail", "--findings", '["Missing ownership guard"]']);
  assert.equal(findings.status, 0, findings.stderr);
  assert.equal(shown(repo).status, "implementing");
  assert.deepEqual(shown(repo).review.findings, ["Missing ownership guard"]);
  assert.equal(shown(repo).activity, "unverified");
  handoff(repo);
  assert.equal(reviewResult(repo).status, 0);
  assert.equal(shown(repo).review.outcome, "clean");
  assert.equal(shown(repo).activity, "inactive");
});

function commitWork(repo) {
  git(repo, "checkout", "feat/ticket");
  writeFileSync(path.join(repo.directory, "change.txt"), "reviewed implementation\n");
  git(repo, "add", "change.txt");
  git(repo, "-c", "user.name=Tracker test", "-c", "user.email=tracker@example.test", "commit", "-m", "Implement ticket");
}
function integration(repo) {
  git(repo, "checkout", "-b", "integration/spec", "main");
  git(repo, "-c", "user.name=Tracker test", "-c", "user.email=tracker@example.test", "merge", "--no-ff", "feat/ticket", "-m", "Integrate reviewed ticket");
  return git(repo, "rev-parse", "HEAD");
}
test("same-spec integration requires clean review of the exact incorporated branch tip", t => {
  const repo = begin(t, ["--spec", "200", "--integration-branch", "integration/spec"]);
  commitWork(repo);
  handoff(repo);
  const merge = integration(repo);
  const args = ["integrate", "--issue", "201", "--integration-commit", merge, "--result", "Reviewed ticket integrated"];
  const premature = repo.run(...args);
  assert.equal(JSON.parse(premature.stderr).error, "clean_review_required");
  assert.equal(reviewResult(repo).status, 0);
  const unrelated = repo.run("integrate", "--issue", "201", "--integration-commit", git(repo, "rev-parse", "main"), "--result", "Invented integration");
  assert.equal(unrelated.status, 1);
  execute(repo, ...args);
  assert.equal(shown(repo).status, "integrated");
  assert.equal(shown(repo).integration.commit, merge);
  assert.equal(shown(repo).integrationContext.specification, 200);
  assert.equal(shown(repo).integration.branch, "integration/spec");
  assert.equal(shown(repo).activity, "inactive");
  assert.equal(repo.remote().closedIssues?.length ?? 0, 0);
});
test("a reviewed ancestor cannot approve later unreviewed work", t => {
  const repo = begin(t, ["--spec", "200", "--integration-branch", "integration/spec"]);
  handoff(repo);
  assert.equal(reviewResult(repo).status, 0);
  commitWork(repo);
  const merge = integration(repo);
  const result = repo.run("integrate", "--issue", "201", "--integration-commit", merge, "--result", "Attempt to integrate later work");
  assert.equal(JSON.parse(result.stderr).error, "review_revision_changed");
  assert.equal(shown(repo).status, "review");
});

test("explicit blockage preserves the justified phase and requires a meaningful resolution", t => {
  const repo = begin(t);
  handoff(repo);
  execute(repo, "block", "--issue", "201", "--reason", "Review fixture is unavailable", "--reference", "https://github.com/example/project/issues/202", "--condition", "Fixture becomes available", "--result", "Waiting for missing input");
  assert.equal(shown(repo).status, "blocked");
  assert.equal(shown(repo).blockage.resumePhase, "review");
  assert.equal(shown(repo).activity, "inactive");
  const unresolved = repo.run("resume-phase", "--issue", "201");
  assert.equal(JSON.parse(unresolved.stderr).error, "event_invalid");
  execute(repo, "resume-phase", "--issue", "201", "--resolution", "Fixture restored and review can continue", "--result", "Review resumed");
  assert.equal(shown(repo).status, "review");
  assert.equal(shown(repo).blockage, null);
  assert.equal(shown(repo).lastBlockage.resolution, "Fixture restored and review can continue");
});

test("an open reviewed internal blocker unblocks only the same integration context and preserves every other blocker", t => {
  const repo = begin(t, ["--spec", "200", "--integration-branch", "integration/spec"]);
  commitWork(repo); handoff(repo); assert.equal(reviewResult(repo).status, 0);
  const merge = integration(repo);
  execute(repo, "integrate", "--issue", "201", "--integration-commit", merge, "--result", "Reviewed work integrated");
  repo.updateRemote(remote => { remote.dependencies = { 202: [{ number: 201, state: "open", repository_url: "https://api.github.com/repos/example/project" }] }; });
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  let ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "ready");
  assert.equal(ticket.dependencies.blockers[0].kind, "internal-integration");
  repo.updateRemote(remote => { remote.dependencies[202][0].repository_url = "https://api.github.com/repos/another/repository"; });
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "blocked");
  assert.equal(ticket.dependencies.blockers[0].kind, "external-final-merge");
  repo.updateRemote(remote => { remote.dependencies[202][0].repository_url = "https://api.github.com/repos/example/project"; remote.dependencies[202].push({ number: 203, state: "closed", repository_url: "https://api.github.com/repos/example/project" }); });
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "blocked");
  assert.equal(ticket.dependencies.blockers.length, 2);
  assert.equal(ticket.dependencies.blockers[1].satisfied, false);
  assert.equal(shown(repo).status, "integrated");
});

function finalMergeFacts(repo, { state = "CLOSED", target = "main", closure = "ClosedEvent" } = {}) {
  const commit = git(repo, "rev-parse", "main");
  const pr = { number: 900, merged: true, mergedAt: "2026-11-05T09:00:00Z", mergeCommit: { oid: commit }, baseRefName: target, repository: { nameWithOwner: "example/project", defaultBranchRef: { name: "main" } } };
  return { state, stateReason: state === "CLOSED" ? "COMPLETED" : null, closedByPullRequestsReferences: { nodes: [pr], pageInfo: { hasNextPage: false } }, timelineItems: { nodes: [{ __typename: closure, createdAt: "2026-11-05T09:00:00Z", closer: { __typename: "PullRequest", ...pr } }] } };
}
test("external blockers require the current closure's final merged PR into the actual target", t => {
  const repo = begin(t);
  repo.updateRemote(remote => { remote.dependencies = { 202: [{ number: 203, state: "closed", repository_url: "https://api.github.com/repos/example/project" }] }; remote.finalMerges = { 203: finalMergeFacts(repo, { state: "OPEN", closure: "ReopenedEvent" }) }; });
  execute(repo, "readiness", "--issue", "202");
  assert.equal(execute(repo, "show").remote.tickets[202].status, "blocked");
  repo.updateRemote(remote => { remote.finalMerges[203] = finalMergeFacts(repo, { target: "integration/another-spec" }); });
  execute(repo, "readiness", "--issue", "202");
  assert.equal(execute(repo, "show").remote.tickets[202].status, "blocked");
  repo.updateRemote(remote => { remote.finalMerges[203] = finalMergeFacts(repo); });
  execute(repo, "readiness", "--issue", "202");
  const ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "ready");
  assert.equal(ticket.dependencies.blockers[0].evidence.pullRequest, 900);
  assert.equal(ticket.dependencies.blockers[0].evidence.target, "main");
});
test("readiness reads every native dependency page and preserves active work and explicit obstacles", t => {
  const repo = begin(t);
  repo.updateRemote(remote => { remote.dependencies = { 201: Array.from({ length: 101 }, (_, index) => ({ number: index + 300, state: "open", repository_url: "https://api.github.com/repos/example/project" })) }; });
  execute(repo, "readiness", "--issue", "201");
  assert.equal(shown(repo).dependencies.blockers.length, 101);
  assert.equal(shown(repo).status, "implementing");
  assert.equal(shown(repo).result, "Implementation started");
  execute(repo, "block", "--issue", "201", "--reason", "Missing input", "--condition", "Human supplies input", "--result", "Waiting for input");
  repo.updateRemote(remote => { remote.dependencies[201] = []; });
  execute(repo, "readiness", "--issue", "201");
  assert.equal(shown(repo).status, "blocked");
  assert.equal(shown(repo).blockage.reason, "Missing input");
});

test("a delayed review result cannot bless a replacement handoff revision", t => {
  const repo = begin(t);
  const old = handoff(repo);
  assert.equal(reviewResult(repo, ["--standards", "fail", "--findings", '["Fix required"]']).status, 0);
  commitWork(repo); handoff(repo);
  const delayed = reviewResult(repo, ["--revision", old]);
  assert.equal(JSON.parse(delayed.stderr).error, "review_revision_changed");
  assert.equal(shown(repo).review.outcome, "waiting");
});

test("local-only review evidence stays pending until the Actions authority can corroborate it", t => {
  const repo = begin(t);
  const revision = git(repo, "rev-parse", "feat/ticket");
  repo.updateRemote(remote => { remote.unavailableRevisions = ["feat/ticket"]; });
  const pending = repo.run("review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Focused checks passed", "--result", "Implementation complete", "--wait-seconds", "0");
  assert.equal(JSON.parse(pending.stderr).error, "publication_pending");
  const local = execute(repo, "show", "--local").local;
  assert.equal(local.pending.length, 1);
  assert.equal(local.lastConfirmed.tickets[201].status, "implementing");
  repo.updateRemote(remote => { remote.unavailableRevisions = []; });
  execute(repo, "sync");
  assert.equal(shown(repo).status, "review");
});

test("claim accepts only a literal existing branch and rejects revision selectors before dispatch", t => {
  const repo = begin(t);
  const count = repo.remote().dispatches.length;
  for (const branch of ["main^{commit}", "feat/ticket~0", "main..feat/ticket"]) {
    const result = repo.run("claim", "--issue", "202", "--agent", "another-worker", "--branch", branch, "--wait-seconds", "0");
    assert.equal(JSON.parse(result.stderr).error, "branch_missing");
  }
  assert.equal(repo.remote().dispatches.length, count);
});

test("a changed native parent cannot inherit the old specification review context", t => {
  const repo = begin(t, ["--spec", "200", "--integration-branch", "integration/spec"]);
  handoff(repo);
  repo.updateRemote(remote => { remote.parents = { 201: 999 }; });
  const result = reviewResult(repo);
  assert.equal(JSON.parse(result.stderr).error, "specification_mismatch");
  assert.equal(shown(repo).review.outcome, "waiting");
});

test("one controller preserves parallel worker identities while independently reviewing a ticket", t => {
  const repo = begin(t);
  git(repo, "branch", "feat/other");
  execute(repo, "claim", "--issue", "202", "--agent", "parallel-implementer", "--branch", "feat/other", "--result", "Parallel implementation started", "--wait-seconds", "0");
  handoff(repo);
  execute(repo, "review-start", "--issue", "201", "--reviewer", "independent-reviewer", "--result", "Reviewer reports inspecting the diff");
  const tickets = execute(repo, "show").remote.tickets;
  assert.equal(tickets[201].reviewer, "independent-reviewer");
  assert.equal(tickets[202].agent, "parallel-implementer");
  assert.equal(tickets[202].status, "implementing");
  assert.equal(tickets[201].runId, tickets[202].runId);
});

test("a readiness-created ticket can be claimed while preserving its bound integration context", t => {
  const repo = begin(t);
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  execute(repo, "claim", "--issue", "202", "--agent", "next-worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  const ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "implementing");
  assert.equal(ticket.agent, "next-worker");
  assert.deepEqual(ticket.integrationContext, { specification: 200, branch: "integration/spec" });
  assert.equal(ticket.dependencies.ready, true);
  const repeated = repo.run("claim", "--issue", "202", "--agent", "competing-worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  assert.equal(JSON.parse(repeated.stderr).error, "ticket_already_claimed");
});

test("an external blocker cannot reuse another repository's same-number closing PR", t => {
  const repo = begin(t);
  const facts = finalMergeFacts(repo);
  facts.timelineItems.nodes[0].closer.repository = { nameWithOwner: "another/repository", defaultBranchRef: { name: "main" } };
  repo.updateRemote(remote => { remote.dependencies = { 202: [{ number: 203, state: "closed", repository_url: "https://api.github.com/repos/example/project" }] }; remote.finalMerges = { 203: facts }; });
  execute(repo, "readiness", "--issue", "202");
  const ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "blocked");
  assert.equal(ticket.dependencies.blockers[0].satisfied, false);
});

test("readiness resolves the documented parent fallback before binding the specification", t => {
  const repo = begin(t);
  repo.updateRemote(remote => { remote.parents = { 202: null }; remote.issueBodies = { 202: "Part of #200\n\nImplementation ticket" }; });
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  const ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.parent, 200);
  assert.equal(ticket.status, "ready");
  assert.equal(ticket.integrationContext.specification, 200);
});

test("claim rechecks readiness dependencies and refuses changing an unowned ticket's integration context", t => {
  const repo = begin(t);
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  const claim = ["claim", "--issue", "202", "--agent", "next-worker", "--branch", "feat/ticket", "--wait-seconds", "0"];
  const changedContext = repo.run(...claim, "--spec", "200", "--integration-branch", "integration/another-spec");
  assert.equal(JSON.parse(changedContext.stderr).error, "integration_context_mismatch");
  repo.updateRemote(remote => { remote.dependencies = { 202: [{ number: 203, state: "open", repository_url: "https://api.github.com/repos/example/project" }] }; });
  const changedDependencies = repo.run(...claim);
  assert.equal(JSON.parse(changedDependencies.stderr).error, "implementation_dependencies_unsatisfied");
  execute(repo, "readiness", "--issue", "202");
  const blocked = repo.run(...claim);
  assert.equal(JSON.parse(blocked.stderr).error, "ticket_not_ready");
  const ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "blocked");
  assert.equal(ticket.runId, null);
  assert.equal(ticket.integrationContext.branch, "integration/spec");
});

test("a discovered dependency-blocked ticket becomes claimable after same-spec integration evidence", t => {
  const repo = begin(t, ["--spec", "200", "--integration-branch", "integration/spec"]);
  commitWork(repo); handoff(repo); assert.equal(reviewResult(repo).status, 0);
  execute(repo, "integrate", "--issue", "201", "--integration-commit", integration(repo), "--result", "Reviewed blocker integrated");
  const issue = (number, extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body: "", state: "OPEN", repository: { nameWithOwner: "example/project" }, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], ...extra });
  const parent = issue(200, { subIssues: { totalCount: 2 } });
  repo.updateRemote(remote => { remote.issues = { 200: parent, 201: issue(201, { parent }), 202: issue(202, { parent, blockers: [{ number: 201, state: "open", repository_url: "https://api.github.com/repos/example/project" }] }) }; });
  execute(repo, "discover", "--parent", "200", "--wait-seconds", "0");
  assert.equal(execute(repo, "show").remote.tickets[202].status, "blocked");
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec");
  assert.equal(execute(repo, "show").remote.tickets[202].status, "ready");
  execute(repo, "claim", "--issue", "202", "--agent", "next-worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[202].status, "implementing");
  assert.equal(state.tickets[201].status, "integrated");
  assert.equal(state.tickets[200].role, "specification");
  assert.equal(state.tickets[200].status, null);
  assert.equal(state.views.board.groupingVerified, true);
});

test("unavailable dependency evidence cannot clear a discovered blocked ticket", t => {
  const repo = begin(t);
  repo.updateRemote(remote => { remote.issues = { 202: { id: "I_202", number: 202, title: "Waiting for dependencies", url: "https://github.com/example/project/issues/202", body: "", state: "OPEN", subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], dependenciesUnavailable: true } }; });
  execute(repo, "discover", "--wait-seconds", "0");
  assert.equal(execute(repo, "show").remote.tickets[202].status, "blocked");
  const result = repo.run("readiness", "--issue", "202", "--wait-seconds", "0");
  assert.equal(JSON.parse(result.stderr).error, "dependency_evidence_missing");
  assert.equal(execute(repo, "show").remote.tickets[202].status, "blocked");
});

test("a later Parent fallback survives discovery, contextual readiness and claim", t => {
  const repo = begin(t);
  const issue = (number, extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body: "", state: "OPEN", repository: { nameWithOwner: "example/project" }, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], ...extra });
  repo.updateRemote(remote => { remote.issues = { 200: issue(200, { subIssues: { totalCount: 1 } }), 202: issue(202, { body: "Opening context\n\nOne\nTwo\nThree\n\n## Parent\n\nPart of #200\n\n## Implementation\nDetails" }) }; });
  execute(repo, "discover", "--parent", "200", "--wait-seconds", "0");
  assert.equal(execute(repo, "show").remote.tickets[202].parent, 200);
  execute(repo, "readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec", "--wait-seconds", "0");
  execute(repo, "claim", "--issue", "202", "--agent", "next-worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  const ticket = execute(repo, "show").remote.tickets[202];
  assert.equal(ticket.status, "implementing");
  assert.equal(ticket.parentSource, "fallback");
  assert.equal(ticket.integrationContext.specification, 200);
});

test("discovery and lifecycle refuse malformed, conflicting and self-referential parent fallbacks", t => {
  for (const body of ["Part of #200 trailing words", "Part of #200\n\n## Parent\nPart of #300", "## Parent\nPart of #200\n\n## Details\nContext\n\n## Parent\nPart of #300", "Part of #202"]) {
    const repo = begin(t);
    const issue = (number, extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body: "", state: "OPEN", repository: { nameWithOwner: "example/project" }, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], ...extra });
    repo.updateRemote(remote => { remote.issues = { 200: issue(200, { subIssues: { totalCount: 1 }, labels: [] }), 202: issue(202, { body }) }; });
    const invalid = repo.run("readiness", "--issue", "202", "--spec", "200", "--integration-branch", "integration/spec", "--wait-seconds", "0");
    assert.equal(JSON.parse(invalid.stderr).error, "parent_declaration_unresolved", body);
    execute(repo, "discover", "--wait-seconds", "0");
    const ticket = execute(repo, "show").remote.tickets[202];
    assert.equal(ticket.status, "blocked", body);
    assert.equal(ticket.parent, null, body);
    const claim = repo.run("claim", "--issue", "202", "--agent", "next-worker", "--branch", "feat/ticket", "--wait-seconds", "0");
    assert.equal(JSON.parse(claim.stderr).error, "ticket_not_ready", body);
  }
});
