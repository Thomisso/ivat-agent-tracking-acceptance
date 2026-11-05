import assert from "node:assert/strict";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

const issue = (number, extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, state: "OPEN", labels: [], body: "", subIssues: { totalCount: 0 }, repository: { nameWithOwner: "example/project" }, ...extra });
function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}
function begin(t, at) {
  const repo = trackerFixture(t);
  if (at) repo.now(at);
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "entry-run");
  return repo;
}

test("a never-discovered ticket cannot claim past an unsatisfied native dependency", t => {
  const repo = begin(t);
  repo.updateRemote(remote => {
    remote.issues = { 202: issue(202), 203: issue(203) };
    remote.dependencies = { 202: [{ number: 203, repository_url: "https://api.github.com/repos/example/project" }] };
  });
  const claim = repo.run("claim", "--issue", "202", "--agent", "worker", "--branch", "feat/ticket");
  assert.equal(resultJson(claim).error, "implementation_dependencies_unsatisfied");
  assert.equal(execute(repo, "show").remote.tickets[202], undefined);
  repo.updateRemote(remote => { remote.issues[203].state = "CLOSED"; });
  assert.equal(resultJson(repo.run("claim", "--issue", "202", "--agent", "worker", "--branch", "feat/ticket")).error, "implementation_dependencies_unsatisfied");
  execute(repo, "readiness", "--issue", "202");
  const waiting = execute(repo, "show").remote.tickets[202];
  assert.equal(waiting.status, "blocked");
  assert.equal(waiting.dependencies.ready, false);
  assert.equal(waiting.agent, undefined);
});

test("direct claim and new readiness classify specifications like discovery", t => {
  for (const shape of ["body", "native_children"]) {
    const repo = begin(t);
    repo.updateRemote(remote => {
      remote.issues = { 200: issue(200, { body: shape === "body" ? "## Problem Statement\nNeed\n## Solution\nApproach\n## User Stories\nStory" : "", subIssues: { totalCount: shape === "native_children" ? 1 : 0 } }) };
      remote.subIssues = { 200: shape === "native_children" ? [201] : [] };
    });
    assert.equal(resultJson(repo.run("readiness", "--issue", "200")).error, "implementation_issue_required");
    assert.equal(resultJson(repo.run("claim", "--issue", "200", "--agent", "worker", "--branch", "feat/ticket")).error, "implementation_issue_required");
    assert.equal(execute(repo, "show").remote.tickets[200], undefined);
    repo.updateRemote(remote => { remote.issues[200].labels = ["ready-for-agent"]; });
    execute(repo, "discover");
    assert.equal(execute(repo, "show").remote.tickets[200].role, "specification");
  }
});

test("direct claim and new readiness retain native foreign and fallback parent identities", t => {
  for (const command of ["claim", "readiness"]) for (const source of ["native", "fallback"]) {
    const repo = begin(t);
    repo.updateRemote(remote => {
      remote.issues = { 200: issue(200, { labels: ["ready-for-agent"], body: "## Problem Statement\nNeed\n## Solution\nApproach\n## User Stories\nStory" }) };
    });
    execute(repo, "discover");
    repo.updateRemote(remote => {
      remote.issues[202] = issue(202, source === "native" ? { parent: { id: "I_foreign_200", number: 200, title: "Foreign parent", url: "https://github.com/other/repository/issues/200", html_url: "https://github.com/other/repository/issues/200", repository_url: "https://api.github.com/repos/other/repository", repository: { nameWithOwner: "other/repository" } } } : { body: "Part of #300" });
      if (source === "fallback") remote.parents = { 202: null };
    });
    execute(repo, command, "--issue", "202", ...(command === "claim" ? ["--agent", "worker", "--branch", "feat/ticket"] : []));
    const state = execute(repo, "show").remote;
    assert.equal(state.tickets[202].parent, source === "native" ? 200 : 300);
    assert.equal(state.tickets[202].parentRepository, source === "native" ? "other/repository" : "example/project");
    assert.equal(state.tickets[202].parentSource, source);
    assert.deepEqual(state.tickets[200].summary.children, []);
    assert.equal(state.tickets[200].summary.counts.implementing, 0);
    if (state.tickets["other/repository#200"]) assert.equal(state.tickets["other/repository#200"].repository, "other/repository");
  }
});

test("retained unlabelled open and closed tickets refresh current parents without rewriting reached work", t => {
  for (const state of ["OPEN", "CLOSED"]) {
    const repo = begin(t, "2026-11-05T12:00:00.000Z");
    const parent = issue(200, { labels: ["ready-for-agent"], body: "## Problem Statement\nNeed\n## Solution\nApproach\n## User Stories\nStory", subIssues: { totalCount: 1 } });
    repo.updateRemote(remote => { remote.issues = { 200: parent, 201: issue(201, { labels: ["ready-for-agent"], parent }) }; remote.subIssues = { 200: [201] }; });
    execute(repo, "discover");
    repo.git("branch", "integration/spec");
    const revision = repo.git("rev-parse", "feat/ticket");
    execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--spec", "200", "--integration-branch", "integration/spec");
    execute(repo, "review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Actual focused fixture checks passed", "--result", "Implementation complete");
    execute(repo, "review-result", "--issue", "201", "--reviewer", "independent-reviewer", "--revision", revision, "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent ticket/base/diff review", "--result", "Clean review");
    execute(repo, "integrate", "--issue", "201", "--integration-commit", revision, "--result", "Reviewed work integrated into original context");
    const before = execute(repo, "show").remote.tickets[201];
    repo.updateRemote(remote => {
      remote.issues[300] = issue(300, { labels: ["ready-for-agent"], body: parent.body, subIssues: { totalCount: 1 } });
      remote.issues[201].labels = []; remote.issues[201].state = state; remote.issues[201].parent = remote.issues[300];
      remote.issues[200].subIssues.totalCount = 0;
      remote.subIssues = { 200: [], 300: [201] };
    });
    execute(repo, "reconcile");
    const after = execute(repo, "show").remote;
    assert.equal(after.tickets[201].parent, 300);
    assert.equal(after.tickets[201].parentRepository, "example/project");
    assert.equal(after.tickets[201].parentSource, "native");
    assert.deepEqual(after.tickets[200].summary.children, []);
    assert.deepEqual(after.tickets[300].summary.children, [201]);
    for (const key of ["status", "activity", "stateAt", "activityAt", "runId", "generation", "agent", "reviewer", "result", "review", "integration", "integrationContext"]) assert.deepEqual(after.tickets[201][key], before[key], key);
    assert.equal(after.tickets[201].integrationContext.specification, 200);
    execute(repo, "reconcile");
    assert.deepEqual(execute(repo, "show").remote.tickets[300].summary.children, [201]);
    assert.equal(repo.remote().comments[300].length, 1);
  }
});

test("retained work moving to a foreign parent creates only qualified context", t => {
  const repo = begin(t);
  const parent = issue(200, { labels: ["ready-for-agent"], subIssues: { totalCount: 1 } });
  repo.updateRemote(remote => { remote.issues = { 200: parent, 201: issue(201, { labels: ["ready-for-agent"], parent }) }; remote.subIssues = { 200: [201] }; });
  execute(repo, "discover");
  repo.updateRemote(remote => {
    const foreign = issue(200, { id: "I_foreign_200", title: "Foreign context", url: "https://github.com/other/repository/issues/200", repository: { nameWithOwner: "other/repository" } });
    remote.foreignIssues = { "other/repository#200": foreign };
    remote.issues[201].labels = []; remote.issues[201].parent = foreign;
    remote.issues[200].subIssues.totalCount = 0; remote.subIssues[200] = [];
  });
  execute(repo, "reconcile");
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[201].parentRepository, "other/repository");
  assert.deepEqual(state.tickets[200].summary.children, []);
  assert.equal(state.tickets["other/repository#200"].repository, "other/repository");
  assert.equal(state.tickets["other/repository#200"].nodeId, "I_foreign_200");
  assert.equal(state.tickets["other/repository#200"].summary.scope, "context_only");
});
