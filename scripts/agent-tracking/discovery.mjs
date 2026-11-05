import { currentParent } from "./evidence.mjs";
import { parentDeclaration, parentMetadata } from "./relationships.mjs";
import { TrackerError } from "./github.mjs";

const issueFields = `id number title url body state repository{nameWithOwner} parent{id number title url repository{nameWithOwner}} subIssues(first:1){totalCount}`;

export function isSpecification(issue) {
  return issue.subIssues?.totalCount > 0 || [/^##\s+Problem Statement\s*$/im, /^##\s+Solution\s*$/im, /^##\s+User Stories\s*$/im].every(pattern => pattern.test(issue.body ?? ""));
}

export function readImplementationIssue(github, config, number) {
  const issue = github.request(`repos/${config.repository}/issues/${number}`);
  if (issue.pull_request || issue.state !== "open") throw new TrackerError("implementation_issue_required");
  // Classification needs existence, not a complete child count. One native
  // child is sufficient to distinguish a specification from implementation.
  const children = github.request(`repos/${config.repository}/issues/${number}/sub_issues?per_page=1`);
  if (!Array.isArray(children)) throw new TrackerError("issue_classification_unverified");
  if (isSpecification({ ...issue, subIssues: { totalCount: children.length } })) throw new TrackerError("implementation_issue_required");
  return issue;
}

function readIssue(github, repository, number) {
  const [owner, name] = repository.split("/");
  const issue = github.graph(`query TrackerDiscoveryIssue($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${issueFields}}}}`, { owner, name, number }).repository.issue;
  if (!issue) throw new TrackerError("discovery_parent_missing");
  return issue;
}

function readiness(github, config, issue) {
  let blockers;
  try { blockers = github.pages(`repos/${config.repository}/issues/${issue.number}/dependencies/blocked_by`); }
  catch (error) { if (error.code !== "github_not_found") throw error; }
  const waiting = { status: "blocked", result: "Dependency delivery has not been verified; closure alone does not establish delivery" };
  // Native edges are canonical when available. Passive discovery has no
  // review/integration/final-merge attestation for any referenced dependency.
  if (blockers) return blockers.length ? waiting : { status: "ready", result: "Approved implementation is waiting to be claimed" };
  const opening = (issue.body ?? "").split(/^##\s+/m)[0];
  const fallback = opening.match(/^Blocked by:\s*(.*)$/im)?.[1];
  if (fallback === undefined) return { status: "blocked", result: "Implementation dependencies could not be verified" };
  const numbers = [...fallback.matchAll(/#(\d+)/g)].map(match => Number(match[1]));
  if (numbers.length) return waiting;
  if (!/^\s*(?:none|no blockers|n\/a)[.\s]*$/i.test(fallback)) return { status: "blocked", result: "Implementation dependencies are unresolved" };
  return { status: "ready", result: "Approved implementation is waiting to be claimed" };
}

export function discoverTickets(state, { github, config, at }) {
  const [owner, name] = config.repository.split("/");
  const issues = [];
  let after = null;
  do {
    const connection = github.graph(`query TrackerDiscovery($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,states:OPEN,labels:["ready-for-agent"]){nodes{${issueFields}} pageInfo{hasNextPage endCursor}}}}`, { owner, name, after }).repository.issues;
    issues.push(...connection.nodes);
    if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after)) throw new TrackerError("discovery_pagination_invalid");
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  const tickets = { ...state.tickets };
  const add = (issue, role, parent = null, extra = {}) => {
    const repository = issue.repository?.nameWithOwner ?? config.repository;
    // Cross-repository parent context uses its qualified identity, never a local number collision.
    const key = repository.toLowerCase() === config.repository.toLowerCase() ? issue.number : `${repository}#${issue.number}`;
    if (tickets[key]) return;
    tickets[key] = { number: issue.number, nodeId: issue.id, title: issue.title, url: issue.url, repository, role, parent,
      account: null, agent: null, reviewer: null, branch: null, workingRevision: null, pullRequest: null,
      status: null, activity: "inactive", stateAt: at, activityAt: null, result: "Parent specification context", runId: null, generation: null, revision: state.revision + 1, ...extra };
  };
  for (const issue of issues) {
    const specification = isSpecification(issue);
    if (specification) { add(issue, "specification"); continue; }
    const declaration = issue.parent ? { number: null, unresolved: false } : parentDeclaration(issue.body ?? "", issue.number);
    const parent = issue.parent ?? (declaration.number ? readIssue(github, config.repository, declaration.number) : null);
    if (parent) add(parent, "specification");
    const relationship = { parent: parent?.number ?? null, parentRepository: parent?.repository?.nameWithOwner ?? (parent ? config.repository : null), parentSource: issue.parent ? "native" : parent ? "fallback" : declaration.unresolved ? "unresolved" : null };
    if (tickets[issue.number]) {
      // Reconcile observed relationships, never execution state or attested
      // integration context. Lifecycle commands validate that context separately.
      tickets[issue.number] = { ...tickets[issue.number], ...relationship };
      continue;
    }
    const gate = declaration.unresolved ? { status: "blocked", result: "Parent declaration is unresolved; use native parent or consistent Part of #N declarations at the opening or in Parent sections" } : readiness(github, config, issue);
    const blockage = gate.status === "blocked" && !declaration.unresolved ? { kind: "dependency", reason: gate.result, reference: null, condition: "Every blocker passes same-spec integration or external final merge", resumePhase: "ready", at } : null;
    add(issue, "implementation", relationship.parent, { ...gate, ...(blockage ? { blockage } : {}), ...relationship });
  }
  // Membership selection is deliberately narrow, but observed relationships
  // of already tracked local work must stay current after label/closure changes.
  for (const record of Object.values(state.tickets).filter(record => record.role === "implementation" && (record.repository ?? config.repository).toLowerCase() === config.repository.toLowerCase())) {
    let observed;
    try { observed = currentParent(github, config, record.number); }
    catch (error) {
      if (error.code !== "parent_declaration_unresolved") throw error;
      // Ambiguous fallback remains unverified; do not retain a stale parent
      // or abort unrelated passive records. Owned verification stays strict.
      observed = { number: null, repository: null, source: "unresolved" };
    }
    if (observed.number !== null) {
      const key = observed.repository.toLowerCase() === config.repository.toLowerCase() ? observed.number : `${observed.repository}#${observed.number}`;
      if (!tickets[key]) {
        const parent = github.request(`repos/${observed.repository}/issues/${observed.number}`);
        add({ id: parent.node_id, number: parent.number, title: parent.title, url: parent.html_url, repository: { nameWithOwner: observed.repository } }, "specification");
      }
    }
    tickets[record.number] = { ...tickets[record.number], ...parentMetadata(observed) };
  }
  state.tickets = tickets;
}

export function prunePublishedDiscoveryReceipts(state) {
  const published = Object.entries(state.receipts).filter(([, receipt]) => receipt.automaticDiscovery === true && receipt.state === "published").sort(([, first], [, second]) => second.revision - first.revision);
  for (const [id] of published.slice(32)) delete state.receipts[id];
}
