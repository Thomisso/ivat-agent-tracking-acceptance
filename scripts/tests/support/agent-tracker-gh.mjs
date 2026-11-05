#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
const file = process.env.TRACKER_FAKE_GITHUB;
const remote = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const rawEndpoint = args[args.indexOf("api") + 1];
const endpoint = rawEndpoint.split("?")[0];
const page = Number(new URLSearchParams(rawEndpoint.split("?")[1]).get("page") ?? 1);
const input = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : {};
const operation = endpoint === "graphql" ? input.query.match(/(?:query|mutation)\s+(\w+)/)?.[1] : `${method} ${endpoint}`;
const injected = remote.failure?.remaining > 0 && operation === remote.failure.match ? { ...remote.failure } : null;
if (injected) {
  remote.failure.remaining--;
  fs.writeFileSync(file, JSON.stringify(remote));
  if (injected.phase === "before") { console.error("simulated connection failure"); process.exit(1); }
}
let response;
const parent = number => {
  if ((remote.issues?.[number] && !remote.issues[number].parent && !Object.hasOwn(remote.parents ?? {}, number)) || remote.parents?.[number] === null) { console.error("HTTP 404: Not Found"); process.exit(1); }
  return remote.issues?.[number]?.parent ?? { number: remote.parents?.[number] ?? 200 };
};
if (remote.fail) {
  console.error(remote.fail);
  process.exit(1);
}
if (endpoint === "graphql") {
  const variables = input.variables ?? {};
  const value = variables.input ?? {};
  switch (operation) {
    case "TrackerItemFields": {
      const item = Object.values(remote.items).find(item => item.id === variables.id);
      if (!item) { response = { node: null }; break; }
      response = { node: { fieldValues: { nodes: Object.entries(item.values).filter(([,value]) => value !== null).map(([id, value]) => ({ field: { id }, ...(value.singleSelectOptionId ? { optionId: value.singleSelectOptionId } : { text: value.text }) })), pageInfo: { hasNextPage: false } } } }; break;
    }
    case "TrackerReady": {
      const pr = Object.values(remote.pulls).find(pr => pr.node_id === value.pullRequestId);
      if (pr.draft) remote.readyTransitions = (remote.readyTransitions ?? 0) + 1;
      pr.draft = false;
      if (remote.advanceTargetDuringReady) {
        execFileSync("git", ["branch", "-f", "main", remote.advanceTargetDuringReady], { stdio: "pipe" });
        delete remote.advanceTargetDuringReady;
      }
      if (remote.pushDuringReady) { pr.head.sha = remote.pushDuringReady; delete remote.pushDuringReady; }
      response = { markPullRequestReadyForReview: { pullRequest: { id: pr.node_id, isDraft: false, headRefOid: pr.head.sha, baseRefName: pr.base.ref } } }; break;
    }
    case "TrackerRestoreDraft": {
      const pr = Object.values(remote.pulls).find(pr => pr.node_id === value.pullRequestId); pr.draft = true;
      response = { convertPullRequestToDraft: { pullRequest: { id: pr.node_id, isDraft: true } } }; break;
    }
    case "TrackerFinalMerge": response = { repository: { issue: remote.finalMerges?.[variables.number] ?? { state: "OPEN", stateReason: null, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } }, timelineItems: { nodes: [] } } } }; break;
    case "TrackerDiscovery": {
      const all = Object.values(remote.issues ?? {}).filter(issue => issue.state === "OPEN" && issue.labels.includes("ready-for-agent"));
      const start = Number(variables.after ?? 0);
      const size = remote.discoveryPageSize ?? 100;
      const nodes = all.slice(start, start + size);
      response = { repository: { issues: { nodes, pageInfo: { hasNextPage: start + size < all.length, endCursor: String(start + size) } } } };
      break;
    }
    case "TrackerDiscoveryIssue": response = { repository: { issue: remote.issues?.[variables.number] ?? null } }; break;
    case "TrackerViews": response = { node: { views: { nodes: remote.views ?? [], pageInfo: { hasNextPage: false } } } }; break;
    case "TrackerCreateView": {
      remote.views ??= [];
      const view = { id: `view-${remote.views.length}`, ...value, filter: "", configuration: { visibleFields: { nodes: value.configuration.visibleFieldIds.map(id => ({ id })) } }, groupByFields: { nodes: [] }, verticalGroupByFields: { nodes: value.layout === "BOARD_LAYOUT" ? [{ id: "status" }] : [] } };
      remote.views.push(view);
      if (remote.failNextViewCreate) { delete remote.failNextViewCreate; fs.writeFileSync(file, JSON.stringify(remote)); console.error("network unavailable after create"); process.exit(1); }
      response = { createProjectV2View: { view } }; break;
    }
    case "TrackerUpdateView": {
      const view = remote.views.find(view => view.id === value.viewId);
      Object.assign(view, value, { configuration: { visibleFields: { nodes: value.configuration.visibleFieldIds.map(id => ({ id })) } } });
      response = { updateProjectV2View: { view } }; break;
    }
    case "TrackerProject": response = { user: { projectV2: remote.project } }; break;
    case "TrackerFields": response = { node: { fields: { nodes: remote.fields, pageInfo: { hasNextPage: false } } } }; break;
    case "TrackerWorkflows": response = { node: { workflows: { nodes: remote.workflows ?? [], pageInfo: { hasNextPage: false } } } }; break;
    case "TrackerDeleteWorkflow": remote.workflows = remote.workflows.filter(workflow => workflow.id !== value.workflowId); response = { deleteProjectV2Workflow: { deletedWorkflowId: value.workflowId } }; break;
    case "TrackerAddItem": {
      remote.items ??= {};
      remote.items[value.contentId] ??= { id: `item-${value.contentId}`, values: {} };
      response = { addProjectV2ItemById: { item: { id: remote.items[value.contentId].id } } };
      break;
    }
    case "TrackerSetFields": {
      response = {};
      for (const [index, field] of Object.values(variables).entries()) {
        const item = Object.values(remote.items).find(item => item.id === field.itemId);
        item.values[field.fieldId] = field.value ?? null;
        response[`f${index}`] = { projectV2Item: { id: item.id } };
      }
      break;
    }
    case "TrackerUpdateField": {
      const field = remote.fields.find(item => item.id === value.fieldId);
      field.options = value.singleSelectOptions.map((option, index) => ({ ...option, id: `${field.id}-${index}` }));
      response = { updateProjectV2Field: { projectV2Field: field } };
      break;
    }
    case "TrackerCreateField": {
      const field = { id: `field-${remote.fields.length}`, name: value.name, dataType: value.dataType };
      if (value.singleSelectOptions) field.options = value.singleSelectOptions.map((option, index) => ({ ...option, id: `${field.id}-${index}` }));
      remote.fields.push(field);
      response = { createProjectV2Field: { projectV2Field: field } };
      break;
    }
    default: throw new Error(`Unmodelled GraphQL operation ${operation}`);
  }
  response = { data: response };
} else if (/^repos\/example\/project\/actions\/runs\/\d+$/.test(endpoint)) {
  response = { created_at: "2026-11-05T12:00:00Z" };
} else if (endpoint === "user") {
  response = { login: "maintainer" };
} else if (endpoint === "repos/example/project") {
  response = { full_name: "example/project", owner: { login: "example", type: "User" }, default_branch: "main" };
} else if (endpoint === "repos/example/project/issues/99/comments" && method === "GET") {
  let body = remote.registry;
  if (remote.staleRegistry?.remaining > 0) { body = remote.staleRegistry.body; remote.staleRegistry.remaining--; }
  response = body ? [{ id: 900, body }] : [];
} else if (endpoint === "repos/example/project/issues/99/comments" && method === "POST") {
  remote.registry = input.body;
  response = { id: 900, body: input.body };
} else if (endpoint === "repos/example/project/issues/comments/900" && method === "PATCH") {
  remote.registry = input.body;
  response = { id: 900, body: input.body };
} else if (endpoint.startsWith("repos/example/project/commits/")) {
  const revision = decodeURIComponent(endpoint.slice("repos/example/project/commits/".length));
  if (remote.unavailableRevisions?.includes(revision)) { console.error("HTTP 404: Not Found"); process.exit(1); }
  const sha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], { encoding: "utf8" }).trim();
  const parents = execFileSync("git", ["show", "-s", "--format=%P", sha], { encoding: "utf8" }).trim().split(" ").filter(Boolean).map(sha => ({ sha }));
  const tree = execFileSync("git", ["show", "-s", "--format=%T", sha], { encoding: "utf8" }).trim();
  response = { sha, parents, commit: { tree: { sha: tree } } };
} else if (endpoint.startsWith("repos/example/project/compare/")) {
  const [base, head] = endpoint.slice("repos/example/project/compare/".length).split("...");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", base, head]);
  response = { status: base === head ? "identical" : ancestor.status === 0 ? "ahead" : "diverged", merge_base_commit: { sha: execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim() } };
} else if (/^repos\/example\/project\/pulls\/\d+$/.test(endpoint)) {
  response = remote.pulls?.[endpoint.split("/")[4]];
  if (remote.pushOnPullRead && --remote.pushOnPullRead.remaining === 0) {
    response.head.sha = remote.pushOnPullRead.sha;
    delete remote.pushOnPullRead;
  }
  if (!response) { console.error("HTTP 404 Not Found"); process.exit(1); }
} else if (/^repos\/example\/project\/issues\/\d+\/sub_issues$/.test(endpoint)) {
  response = (remote.subIssues?.[endpoint.split("/")[4]] ?? []).slice((page - 1) * 100, page * 100).map(child => typeof child === "object" ? child : { number: child });
} else if (/^repos\/example\/project\/issues\/\d+\/dependencies\/blocked_by$/.test(endpoint)) {
  const number = endpoint.split("/")[4];
  if (remote.issues?.[number]?.dependenciesUnavailable) { console.error("404 Not Found"); process.exit(1); }
  response = (remote.dependencies?.[number] ?? remote.issues?.[number]?.blockers ?? []).slice((page - 1) * 100, page * 100);
} else if (/^repos\/example\/project\/issues\/\d+$/.test(endpoint) && remote.issues?.[endpoint.split("/")[4]]) {
  const issue = remote.issues[endpoint.split("/")[4]];
  response = { ...issue, node_id: issue.id, html_url: issue.url, state: issue.state.toLowerCase() };
} else if (endpoint === "repos/example/project/issues/201") {
  response = { number: 201, node_id: "I_201", title: "A real issue", html_url: "https://github.com/example/project/issues/201", state: "open" };
} else if (endpoint === "repos/example/project/issues/201/parent") {
  response = parent(endpoint.split("/")[4]);
} else if (/^repos\/example\/project\/git\/commits\/[a-f0-9]{40}$/.test(endpoint)) {
  const sha = endpoint.split("/").at(-1);
  if (remote.missingCommits?.includes(sha)) { console.error("HTTP 404 Not Found"); process.exit(1); }
  response = { sha };
} else if (endpoint.startsWith("repos/example/project/git/ref/heads/")) {
  const branch = decodeURIComponent(endpoint.slice("repos/example/project/git/ref/heads/".length));
  if (!remote.branches?.[branch]) { console.error("HTTP 404 Not Found"); process.exit(1); }
  response = { object: { sha: remote.branches[branch] } };
} else if (endpoint === "repos/example/project/issues/201/assignees") {
  remote.assignees = input.assignees;
  response = {};
} else if (endpoint === "repos/example/project/issues/201/comments" && method === "GET") {
  response = remote.ticketComments ?? [];
} else if (endpoint === "repos/example/project/issues/201/comments" && method === "POST") {
  remote.ticketComments ??= [];
  remote.ticketComments.push({ id: 901, body: input.body });
  response = remote.ticketComments.at(-1);
} else if (endpoint === "repos/example/project/issues/comments/901" && method === "PATCH") {
  remote.ticketComments[0].body = input.body;
  response = remote.ticketComments[0];
} else if (endpoint === "repos/example/project/actions/workflows/agent-tracking.yml/dispatches") {
  remote.dispatches ??= [];
  remote.dispatches.push(input.inputs.event);
  fs.writeFileSync(file, JSON.stringify(remote));
  const worker = remote.deferDispatch ? { status: 0 } : spawnSync(process.execPath, [process.env.TRACKER_COMMAND, "worker"], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/agent-tracking.yml@refs/heads/main", GITHUB_ACTOR: "maintainer", TRACKER_EVENT: input.inputs.event },
  });
  if (worker.status !== 0) console.error(worker.stderr);
  if (injected?.phase === "after") { console.error("simulated connection failure after remote effect"); process.exit(1); }
  console.log(JSON.stringify({ workflow_run_id: 123, run_url: "https://api.github.com/repos/example/project/actions/runs/123", html_url: "https://github.com/example/project/actions/runs/123" }));
  process.exit(0);
} else if (endpoint === "repos/other/repository/issues/200/comments") {
  remote.foreignComments ??= [];
  if (method === "POST") remote.foreignComments.push({ id: 9200, body: input.body });
  response = method === "POST" ? remote.foreignComments.at(-1) : remote.foreignComments;
} else if (endpoint === "repos/other/repository/issues/comments/9200" && method === "PATCH") {
  remote.foreignComments[0].body = input.body; response = remote.foreignComments[0];
} else if (/^repos\/example\/project\/issues\/\d+$/.test(endpoint)) {
  const number = Number(endpoint.split("/")[4]);
  response = { number, node_id: `I_${number}`, title: `Ticket ${number}`, body: remote.issueBodies?.[number] ?? "", html_url: `https://github.com/example/project/issues/${number}`, state: "open" };
} else if (/^repos\/example\/project\/issues\/\d+\/parent$/.test(endpoint)) {
  response = parent(endpoint.split("/")[4]);
} else if (/^repos\/example\/project\/issues\/\d+\/assignees$/.test(endpoint)) {
  remote.extraAssignees ??= {}; remote.extraAssignees[endpoint.split("/")[4]] = input.assignees; response = {};
} else if (/^repos\/example\/project\/issues\/\d+\/comments$/.test(endpoint)) {
  const number = endpoint.split("/")[4];
  remote.comments ??= {};
  remote.comments[number] ??= [];
  if (method === "POST") remote.comments[number].push({ id: 1000 + Number(number), body: input.body });
  response = method === "POST" ? remote.comments[number].at(-1) : remote.comments[number];
} else if (/^repos\/example\/project\/issues\/comments\/\d+$/.test(endpoint) && method === "PATCH") {
  const comment = Object.values(remote.comments).flat().find(comment => comment.id === Number(endpoint.split("/").at(-1)));
  comment.body = input.body; response = comment;
} else throw new Error(`Unmodelled REST operation ${method} ${endpoint}`);
fs.writeFileSync(file, JSON.stringify(remote));
if (injected?.phase === "after") { console.error("simulated connection failure after remote effect"); process.exit(1); }
console.log(JSON.stringify(response));
