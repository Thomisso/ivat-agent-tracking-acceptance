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
    run: (...args) => spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, GH_TOKEN: "synthetic-actions-credential", PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: remote, TRACKER_COMMAND: command } }),
    worker: (event, environment = {}) => spawnSync(process.execPath, [command, "worker"], { cwd: directory, encoding: "utf8", env: { ...process.env, GH_TOKEN: "synthetic-actions-credential", PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: remote, TRACKER_COMMAND: command, GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/agent-tracking.yml@refs/heads/main", GITHUB_ACTOR: "maintainer", TRACKER_EVENT: JSON.stringify(event), ...environment } }),
  };
}

test("tracker refuses missing configuration without claiming successful setup", t => {
  const repo = repository(t);
  const result = repo.run("doctor");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "configuration_missing");
});

test("failed publication remains durably pending and later sync preserves the original claim time", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  assert.equal(repo.run("start", "--run", "recoverable-run").status, 0);
  repo.updateRemote(state => { state.fail = "network unavailable"; });
  const claim = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--at", "2026-11-04T12:00:00.000Z", "--wait-seconds", "0");
  assert.equal(claim.status, 1);
  assert.equal(JSON.parse(claim.stderr).error, "publication_pending");
  repo.updateRemote(state => { delete state.fail; });
  assert.equal(JSON.parse(repo.run("show").stdout).local.pending.length, 1);
  const synchronized = repo.run("sync");
  assert.equal(synchronized.status, 0, synchronized.stderr);
  const shown = JSON.parse(repo.run("show").stdout);
  assert.equal(shown.local.pending.length, 0);
  assert.equal(shown.remote.tickets[201].stateAt, "2026-11-04T12:00:00.000Z");
});

test("claim refuses a nonexistent local branch before creating implementation evidence", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  assert.equal(repo.run("start", "--run", "owned-run").status, 0);
  const result = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "invented-branch");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "branch_missing");
});

test("one owner claims a ticket through a serialized worker and repeated sync keeps one item/comment", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const start = repo.run("start", "--run", "run-first");
  assert.equal(start.status, 0, start.stderr);
  const claim = repo.run("claim", "--issue", "201", "--agent", "implementer-one", "--branch", "feat/ticket", "--result", "Implementation started");
  assert.equal(claim.status, 0, claim.stderr);
  const record = JSON.parse(repo.run("show").stdout).remote.tickets["201"];
  assert.equal(record.agent, "implementer-one");
  assert.equal(record.account, "maintainer");
  assert.equal(record.status, "implementing");
  assert.equal(record.activity, "unverified");
  assert.equal(record.activityAt, null);
  const offlineRecord = JSON.parse(repo.run("show", "--local").stdout).local.lastConfirmed.tickets["201"];
  assert.equal(offlineRecord.branch, "feat/ticket");
  assert.equal(repo.run("sync").status, 0);
  assert.equal(Object.keys(repo.remote().items).length, 1);
  assert.equal(repo.remote().ticketComments.length, 1);
  const second = repo.run("start", "--run", "run-second");
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stderr).error, "run_already_owned");
});

test("setup selects a real project and repeats without duplicate fields or registry comments", t => {
  const repo = repository(t);
  const setup = () => repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99");
  const firstSetup = setup();
  assert.equal(firstSetup.status, 0, firstSetup.stderr);
  const first = repo.remote();
  assert.ok(first.fields.find(field => field.name === "Status").options.some(option => option.name === "Implementace"));
  assert.equal(setup().status, 0);
  assert.equal(repo.remote().fields.length, first.fields.length);
  assert.equal(repo.remote().registry, first.registry);
  assert.equal(JSON.parse(repo.run("doctor").stdout).ok, true);
});

test("setup refuses competing native workflows unless their removal is explicit", t => {
  const repo = repository(t);
  repo.updateRemote(state => { state.workflows = [{ id: "WF_done", name: "Item closed", enabled: true }]; });
  const args = ["setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99"];
  const refused = repo.run(...args);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).error, "native_workflows_enabled");
  assert.equal(repo.remote().workflows.length, 1);
  const accepted = repo.run(...args, "--disable-native-workflows");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(repo.remote().workflows.length, 0);
});

test("permission refusal remains distinct from a transient connection failure and does not leak credentials", t => {
  const repo = repository(t);
  const args = ["setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99"];
  repo.updateRemote(state => { state.fail = "missing required scope project; gho_secret_must_not_escape"; });
  const denied = repo.run(...args);
  assert.equal(JSON.parse(denied.stderr).error, "github_permission_denied");
  assert.ok(!denied.stderr.includes("gho_secret"));
  repo.updateRemote(state => { state.fail = "connection unavailable"; });
  assert.equal(JSON.parse(repo.run(...args).stderr).error, "github_connection_failed");
});

test("linked worktrees observe the same owning run and cannot start an independent controller", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  assert.equal(repo.run("start", "--run", "shared-owner").status, 0);
  const linked = path.join(repo.directory, "linked");
  execFileSync("git", ["worktree", "add", linked, "-b", "linked"], { cwd: repo.directory, stdio: "pipe" });
  const config = path.join(repo.directory, ".github/agent-tracking.json");
  const env = { ...process.env, GH_TOKEN: "synthetic-actions-credential", PATH: `${path.join(repo.directory, "bin")}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: path.join(repo.directory, "github.json"), TRACKER_COMMAND: command };
  const shown = spawnSync(process.execPath, [command, "show", "--config", config], { cwd: linked, env, encoding: "utf8" });
  assert.equal(JSON.parse(shown.stdout).local.run.runId, "shared-owner");
  const second = spawnSync(process.execPath, [command, "start", "--run", "second-owner", "--config", config], { cwd: linked, env, encoding: "utf8" });
  assert.equal(JSON.parse(second.stderr).error, "run_already_owned");
});

test("doctor refuses incomplete field configuration instead of declaring setup valid", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const file = path.join(repo.directory, ".github/agent-tracking.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.fields.agent;
  writeFileSync(file, JSON.stringify(config));
  const refused = repo.run("doctor");
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).error, "configuration_invalid");
});

test("uncertain registry ownership refuses preflight, new controllers and worker mutation", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const priorOwner = { runId: "prior-run", generation: 1, account: "maintainer", startedAt: "2026-11-04T12:00:00.000Z", sequence: 1 };
  const baseline = { schemaVersion: 1, revision: 2, generation: 1, publishedRevision: 2, tickets: { "201": { number: 201, status: "implementing", runId: "prior-run", generation: 1 } }, receipts: {} };
  const malformed = [
    { label: "missing owner", state: baseline },
    { label: "string owner", state: { ...baseline, owner: "free" } },
    { label: "empty owner", state: { ...baseline, owner: {} } },
    { label: "owner generation mismatch", state: { ...baseline, owner: { ...priorOwner, generation: 2 } } },
    { label: "missing sequence", state: { ...baseline, owner: { ...priorOwner, sequence: undefined } } },
    { label: "string sequence", state: { ...baseline, owner: { ...priorOwner, sequence: "1" } } },
    { label: "invalid owner account", state: { ...baseline, owner: { ...priorOwner, account: null } } },
    { label: "invalid owner start time", state: { ...baseline, owner: { ...priorOwner, startedAt: "unknown" } } },
    { label: "null owner with owned work", state: { ...baseline, owner: null } },
    { label: "null owner after an unexplained generation", state: { ...baseline, owner: null, tickets: {} } },
    { label: "owned work without a controlling generation", state: { ...baseline, owner: null, generation: 0 } },
    { label: "ticket from a different run", state: { ...baseline, owner: { ...priorOwner, runId: "another-run" } } },
    { label: "unsafe generation counter", state: { ...baseline, generation: Number.MAX_SAFE_INTEGER + 1, owner: { ...priorOwner, generation: Number.MAX_SAFE_INTEGER + 1 } } },
  ];
  const start = { id: "ownership-probe", type: "start", runId: "new-controller", generation: 1, sequence: 0, at: "2026-11-05T00:00:00.000Z", payload: {} };
  for (const { label, state } of malformed) {
    repo.updateRemote(remote => { remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n`; });
    const before = repo.remote();
    for (const result of [repo.run("doctor"), repo.run("start", "--run", "new-controller", "--wait-seconds", "0"), repo.worker(start)]) {
      assert.equal(result.status, 1, label);
      assert.equal(JSON.parse(result.stderr).error, "registry_invalid", label);
    }
    assert.deepEqual(repo.remote(), before, `${label}: no canonical, dispatch, Project or issue effects`);
    assert.equal(repo.remote().dispatches?.length ?? 0, 0, label);
  }
});

test("verified initial freedom permits unclaimed ticket and specification metadata", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const snapshot = { schemaVersion: 1, revision: 2, generation: 0, owner: null, publishedRevision: 2, tickets: { "200": { number: 200, kind: "specification" }, "201": { number: 201, status: "ready", runId: null } }, receipts: {} };
  repo.updateRemote(remote => { remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`; });
  const checked = repo.run("doctor");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).ok, true);
});


test("passive discovery includes approved waiting work and parent context without owning a run", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  repo.updateRemote(remote => {
    remote.issues = {
      210: { id: "I_210", number: 210, title: "Approved ticket", url: "https://github.com/example/project/issues/210", body: "## Parent\nPart of #200\n## What to build\nBuild it", state: "OPEN", parent: null, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] },
      200: { id: "I_200", number: 200, title: "Specification", url: "https://github.com/example/project/issues/200", body: "## Problem Statement\nNeed work\n## Solution\nBuild\n## User Stories\nStory", state: "OPEN", parent: null, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] },
      199: { id: "I_199", number: 199, title: "Historical ticket", state: "CLOSED", labels: ["ready-for-agent"] },
    };
  });
  const discovered = repo.run("discover", "--parent", "200", "--wait-seconds", "0");
  assert.equal(discovered.status, 0, discovered.stderr);
  const shown = JSON.parse(repo.run("show").stdout).remote;
  assert.equal(shown.owner, null);
  assert.equal(shown.generation, 0);
  assert.equal(shown.tickets[210].status, "ready");
  assert.equal(shown.tickets[210].activity, "inactive");
  assert.equal(shown.tickets[210].parent, 200);
  assert.equal(shown.tickets[200].role, "specification");
  assert.equal(shown.tickets[200].status, null);
  assert.equal(shown.tickets[199], undefined);
  assert.deepEqual(Object.keys(repo.remote().items).sort(), ["I_200", "I_210"]);
  assert.equal(repo.remote().views.find(view => view.layout === "TABLE_LAYOUT").filter, 'parent-issue:"example/project#200"');
  assert.match(repo.remote().comments[200][0].body, /fallback.*\[.*#210\].*issues\/210/i);
  assert.match(repo.remote().comments[200][0].body, /native Parent issue filter excludes/i);
});

test("discovered waiting work can be claimed and rediscovery preserves active ownership after label removal", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  repo.updateRemote(remote => { remote.issues = { 201: { id: "I_201", number: 201, title: "Waiting work", url: "https://github.com/example/project/issues/201", body: "", state: "OPEN", parent: null, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] } }; });
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  assert.equal(repo.run("start", "--run", "discover-claim").status, 0);
  const claim = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  assert.equal(claim.status, 0, claim.stderr);
  const active = JSON.parse(repo.run("show").stdout).remote.tickets[201];
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  assert.deepEqual(JSON.parse(repo.run("show").stdout).remote.tickets[201], active);
  repo.updateRemote(remote => { remote.issues[201].labels = []; });
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  assert.deepEqual(JSON.parse(repo.run("show").stdout).remote.tickets[201], active);
  assert.equal(repo.remote().ticketComments.length, 1);
  assert.deepEqual(repo.remote().issues[201].labels, []);
});


test("issue and scheduled worker triggers discover newly approved work without a controller", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  repo.updateRemote(remote => { remote.issues = { 220: { id: "I_220", number: 220, title: "Newly approved work", url: "https://github.com/example/project/issues/220", body: "", state: "OPEN", parent: null, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] } }; });
  const triggered = repo.worker(undefined, { GITHUB_EVENT_NAME: "issues", GITHUB_RUN_ID: "12345" });
  assert.equal(triggered.status, 0, triggered.stderr);
  const first = JSON.parse(repo.run("show").stdout).remote.tickets[220];
  assert.equal(first.status, "ready");
  repo.updateRemote(remote => { remote.issues[220].state = "CLOSED"; });
  assert.equal(repo.worker(undefined, { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "12346" }).status, 0);
  assert.deepEqual(JSON.parse(repo.run("show").stdout).remote.tickets[220], first);
  assert.equal(repo.worker(undefined, { GITHUB_EVENT_NAME: "issues", GITHUB_RUN_ID: "12345" }).status, 0);
  assert.equal(Object.keys(repo.remote().items).length, 1);
});

test("unresolved parent discovery refuses the batch without leaking partially selected membership", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  repo.updateRemote(remote => { remote.issues = {
    210: { id: "I_210", number: 210, title: "First valid ticket", url: "https://github.com/example/project/issues/210", body: "", state: "OPEN", subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] },
    211: { id: "I_211", number: 211, title: "Missing parent", url: "https://github.com/example/project/issues/211", body: "Part of #404", state: "OPEN", subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] },
  }; });
  const result = repo.run("discover", "--wait-seconds", "0");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "discovery_parent_missing");
  assert.deepEqual(JSON.parse(repo.run("show").stdout).remote.tickets, {});
  assert.deepEqual(repo.remote().items ?? {}, {});
});

test("discovery follows every page, prefers native parent and keeps dependency and specification meanings", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const issue = (number, body = "", extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body, state: "OPEN", subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], ...extra });
  repo.updateRemote(remote => {
    remote.discoveryPageSize = 1;
    remote.issues = {
      210: issue(210, "Part of #999", { parent: issue(200, "", { state: "CLOSED", labels: [] }), blockers: [{ number: 100, state: "open" }] }),
      211: issue(211, "Part of #200, #999"),
      212: issue(212, "## Acceptance criteria\nReferences #999 are not parent declarations"),
      213: issue(213, "Blocked by: #210"),
      214: issue(214, "## Problem Statement\nNeed\n## Solution\nApproach\n## User Stories\nStory"),
      215: issue(215, "Part of #215"),
      216: issue(216, "Part of #0"),
    };
  });
  const discovery = repo.run("discover", "--wait-seconds", "0");
  assert.equal(discovery.status, 0, discovery.stderr);
  const tickets = JSON.parse(repo.run("show").stdout).remote.tickets;
  assert.equal(tickets[210].parent, 200);
  assert.equal(tickets[210].parentSource, "native");
  assert.equal(tickets[210].status, "blocked");
  assert.equal(tickets[200].role, "specification");
  assert.equal(tickets[211].status, "blocked");
  assert.match(tickets[211].result, /Parent declaration is unresolved/);
  assert.equal(tickets[212].parent, null);
  assert.equal(tickets[212].status, "ready");
  assert.equal(tickets[213].status, "ready");
  assert.equal(tickets[214].role, "specification");
  assert.equal(tickets[215].role, "implementation");
  assert.equal(tickets[215].status, "blocked");
  assert.equal(tickets[216].status, "blocked");
  assert.equal(tickets[999], undefined);
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  assert.deepEqual(JSON.parse(repo.run("show").stdout).remote.tickets, tickets);
  assert.equal(Object.keys(repo.remote().items).length, 8);
  assert.equal(repo.remote().comments[200].length, 1);
});

test("partial discovery publication retries one event and retains terminal items without historical backfill", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  repo.updateRemote(remote => {
    remote.failNextViewCreate = true;
    remote.issues = { 210: { id: "I_210", number: 210, title: "Approved work", url: "https://github.com/example/project/issues/210", body: "", state: "OPEN", subIssues: { totalCount: 0 }, labels: ["ready-for-agent"] } };
  });
  const failed = repo.run("discover", "--wait-seconds", "0");
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stderr).error, "publication_pending");
  const pending = JSON.parse(repo.run("show").stdout);
  assert.equal(pending.local.pending.length, 1);
  assert.equal(pending.remote.publishedRevision, 0);
  assert.equal(pending.remote.tickets[210].status, "ready");
  assert.equal(repo.run("sync", "--wait-seconds", "0").status, 0);
  assert.equal(Object.keys(repo.remote().items).length, 1);
  assert.equal(repo.remote().comments[210].length, 1);
  assert.equal(repo.remote().views.length, 2);
  const shown = JSON.parse(repo.run("show").stdout).remote;
  assert.equal(shown.receipts[pending.local.pending[0].id].state, "published");
  const terminal = { ...shown.tickets[210], status: "cancelled", result: "Explicitly cancelled by maintainer" };
  repo.updateRemote(remote => {
    const snapshot = { ...shown, tickets: { 210: terminal } };
    remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`;
    remote.issues[210].state = "CLOSED";
    remote.issues[210].labels = [];
    remote.issues[209] = { ...remote.issues[210], id: "I_209", number: 209, labels: ["ready-for-agent"] };
  });
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  const retained = JSON.parse(repo.run("show").stdout).remote.tickets;
  assert.equal(retained[210].status, "cancelled");
  assert.equal(retained[210].result, "Explicitly cancelled by maintainer");
  assert.equal(retained[210].activity, "inactive");
  assert.equal(retained[210].agent, null);
  assert.equal(retained[210].runId, null);
  assert.equal(retained[210].nodeId, "I_210");
  assert.equal(retained[209], undefined);
});

test("changed native parents refresh active context without altering execution or review evidence", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const issue = number => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body: "", state: "OPEN", subIssues: { totalCount: 0 }, labels: [] });
  repo.updateRemote(remote => { remote.issues = { 200: issue(200), 201: { ...issue(201), body: "Part of #200", parent: null, labels: ["ready-for-agent"] } }; });
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  assert.equal(repo.run("start", "--run", "parent-change").status, 0);
  assert.equal(repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--wait-seconds", "0").status, 0);
  const snapshot = JSON.parse(repo.run("show").stdout).remote;
  const active = { ...snapshot.tickets[201], reviewEvidence: { reviewedRevision: "a".repeat(40), result: "Independent review passed" }, integrationContext: { specification: 200, branch: "integration/original" } };
  repo.updateRemote(remote => {
    snapshot.tickets[201] = active;
    remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`;
    remote.issues[201].parent = issue(300);
  });
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  const shown = JSON.parse(repo.run("show").stdout).remote;
  assert.deepEqual(shown.tickets[201], { ...active, parent: 300, parentRepository: "example/project", parentSource: "native" });
  assert.equal(shown.tickets[300].role, "specification");
  assert.doesNotMatch(repo.remote().comments[200][0].body, /issues\/201/);
});

test("automatic discovery keeps bounded published wakeup receipts and preserves manual acknowledgments", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const snapshot = JSON.parse(repo.run("show").stdout).remote;
  snapshot.receipts = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`discovery-${index}`, { state: "published", automaticDiscovery: true, revision: index + 1 }]));
  snapshot.receipts["manual-discovery"] = { state: "published", revision: 1 };
  snapshot.receipts["pending-automatic"] = { state: "pending", automaticDiscovery: true, revision: 1 };
  snapshot.revision = 40;
  snapshot.publishedRevision = 40;
  repo.updateRemote(remote => { remote.failNextViewCreate = true; remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`; });
  const failed = repo.worker(undefined, { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "999" });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(repo.run("show").stdout).remote.receipts["pending-automatic"].state, "pending");
  const result = repo.worker(undefined, { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "999" });
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(repo.run("show").stdout).remote;
  assert.equal(Object.values(shown.receipts).filter(receipt => receipt.automaticDiscovery && receipt.state === "published").length, 32);
  assert.equal(shown.receipts["manual-discovery"].state, "published");
  assert.equal(shown.receipts["discovery-999"].state, "published");
  assert.equal(shown.receipts["discovery-0"], undefined);
  assert.equal(repo.worker(undefined, { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "0" }).status, 0);
  assert.equal(JSON.parse(repo.run("show").stdout).remote.owner, null);
});

test("discovery requires delivery evidence for closed dependencies and treats native edges as canonical", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const issue = (number, body = "", extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, body, state: "OPEN", subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], ...extra });
  repo.updateRemote(remote => { remote.issues = {
    210: issue(210, "", { blockers: [{ number: 100, state: "closed", state_reason: "not_planned" }] }),
    211: issue(211, "Blocked by: #100", { dependenciesUnavailable: true }),
    212: issue(212, "Blocked by: #100"),
    100: issue(100, "", { state: "CLOSED", state_reason: "not_planned", labels: [] }),
  }; });
  const discovery = repo.run("discover", "--wait-seconds", "0");
  assert.equal(discovery.status, 0, discovery.stderr);
  const tickets = JSON.parse(repo.run("show").stdout).remote.tickets;
  assert.equal(tickets[210].status, "blocked", "native closed/not-planned issue has no final delivery proof");
  assert.match(tickets[210].result, /delivery.*verified/i);
  assert.equal(tickets[211].status, "blocked", "fallback closure cannot attest delivery");
  assert.equal(tickets[212].status, "ready", "stale prose cannot override a verified empty native dependency list");
});

test("board verification checks Status columns independently of horizontal grouping", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const discovery = repo.run("discover", "--wait-seconds", "0");
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(JSON.parse(repo.run("show").stdout).remote.views.board.groupingVerified, true, "vertical Status columns work with empty horizontal grouping");
  repo.updateRemote(remote => {
    const board = remote.views.find(view => view.layout === "BOARD_LAYOUT");
    board.groupByFields = { nodes: [{ id: "status" }] };
    board.verticalGroupByFields = { nodes: [{ id: "parent" }] };
  });
  assert.equal(repo.run("discover", "--wait-seconds", "0").status, 0);
  assert.equal(JSON.parse(repo.run("show").stdout).remote.views.board.groupingVerified, false, "horizontal Status grouping cannot stand in for Status columns");
});
