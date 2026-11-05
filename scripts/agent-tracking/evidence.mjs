import { parentDeclaration } from "./relationships.mjs";
import { spawnSync } from "node:child_process";
import { TrackerError } from "./github.mjs";

export function localBranchRevision(branch) {
  const ref = `refs/heads/${branch}`;
  if (spawnSync("git", ["check-ref-format", ref]).status !== 0) throw new TrackerError("branch_missing");
  const result = spawnSync("git", ["show-ref", "--verify", "--hash", ref], { encoding: "utf8" });
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim())) throw new TrackerError("branch_missing");
  return result.stdout.trim();
}

export function localCommit(value) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], { encoding: "utf8" });
  if (result.status !== 0) throw new TrackerError("revision_missing");
  return result.stdout.trim();
}
export function localAncestor(base, head) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", base, head]);
  if (result.status === 1) throw new TrackerError("revision_not_in_history");
  if (result.status !== 0) throw new TrackerError("git_evidence_failed");
}
export function remoteCommit(github, config, value) {
  return github.request(`repos/${config.repository}/commits/${encodeURIComponent(value)}`);
}
export function remoteAncestor(github, config, base, head) {
  const comparison = github.request(`repos/${config.repository}/compare/${base}...${head}`);
  if (!["ahead", "identical"].includes(comparison.status) || comparison.merge_base_commit?.sha !== base) throw new TrackerError("revision_not_in_history");
}
export function currentParent(github, config, number) {
  try {
    const parent = github.request(`repos/${config.repository}/issues/${number}/parent`);
    return { number: parent.number, repository: blockerRepository(parent, config.repository) };
  } catch (error) {
    if (error.code !== "github_not_found") throw error;
    const issue = github.request(`repos/${config.repository}/issues/${number}`);
    const declaration = parentDeclaration(issue.body ?? "", number);
    if (declaration.unresolved) throw new TrackerError("parent_declaration_unresolved");
    return { number: declaration.number, repository: config.repository };
  }
}
export function verifyContext(github, config, ticket) {
  if (!ticket.integrationContext) return;
  const parent = currentParent(github, config, ticket.number);
  if (parent.repository !== config.repository) throw new TrackerError("parent_repository_unsupported");
  if (parent.number !== ticket.integrationContext.specification) throw new TrackerError("specification_mismatch");
}
export function verifyReviewedTip(github, config, ticket, revision) {
  verifyContext(github, config, ticket);
  if (remoteCommit(github, config, ticket.branch).sha !== revision) throw new TrackerError("review_revision_changed");
  remoteCommit(github, config, revision);
}

export function localIntegration(ticket, value) {
  if (!ticket.integrationContext) throw new TrackerError("integration_context_required");
  if (ticket.review?.outcome !== "clean" || ticket.review.findings.length) throw new TrackerError("clean_review_required");
  if (localCommit(`refs/heads/${ticket.branch}`) !== ticket.review.revision) throw new TrackerError("review_revision_changed");
  const commit = localCommit(value);
  localAncestor(commit, localCommit(`refs/heads/${ticket.integrationContext.branch}`));
  const details = spawnSync("git", ["show", "-s", "--format=%T %P", commit], { encoding: "utf8" });
  if (details.status !== 0) throw new TrackerError("git_evidence_failed");
  const [tree, ...parents] = details.stdout.trim().split(" ");
  if (commit !== ticket.review.revision) {
    if (parents.length !== 2 || parents[1] !== ticket.review.revision) throw new TrackerError("reviewed_tip_not_integrated");
    const merge = spawnSync("git", ["merge-tree", "--write-tree", parents[0], parents[1]], { encoding: "utf8" });
    if (merge.status !== 0 || merge.stdout.trim() !== tree) throw new TrackerError("integration_resolution_requires_review");
  }
  return { commit, tree };
}
export function verifyIntegration(github, config, ticket, proof) {
  if (!ticket.integrationContext) throw new TrackerError("integration_context_required");
  if (ticket.review?.outcome !== "clean" || ticket.review.findings.length) throw new TrackerError("clean_review_required");
  verifyReviewedTip(github, config, ticket, ticket.review.revision);
  const commit = remoteCommit(github, config, proof.commit);
  if (commit.sha !== ticket.review.revision && (commit.parents?.length !== 2 || commit.parents[1].sha !== ticket.review.revision)) throw new TrackerError("reviewed_tip_not_integrated");
  if (commit.commit?.tree?.sha !== proof.tree) throw new TrackerError("integration_tree_mismatch");
  const tip = remoteCommit(github, config, ticket.integrationContext.branch).sha;
  remoteAncestor(github, config, proof.commit, tip);
  return { specification: ticket.integrationContext.specification, branch: ticket.integrationContext.branch, commit: proof.commit, tree: proof.tree, reviewedRevision: ticket.review.revision, branchTip: tip };
}

function blockerRepository(blocker, fallback) {
  const match = blocker.repository_url?.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/) ?? blocker.html_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//);
  return match?.[1] ?? fallback;
}
export function finalMerge(github, repository, number) {
  const [owner, name] = repository.split("/");
  const prs = [];
  let cursor = null;
  let issue;
  do {
    const data = github.graph(`query TrackerFinalMerge($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){state stateReason closedByPullRequestsReferences(first:100,after:$cursor,includeClosedPrs:true){nodes{number merged mergedAt mergeCommit{oid} baseRefName repository{nameWithOwner defaultBranchRef{name}}} pageInfo{hasNextPage endCursor}} timelineItems(last:1,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]){nodes{__typename ... on ClosedEvent{createdAt closer{__typename ... on PullRequest{number merged mergeCommit{oid} baseRefName repository{nameWithOwner defaultBranchRef{name}}}}}}}}}}`, { owner, name, number, cursor });
    issue = data.repository?.issue;
    if (!issue) throw new TrackerError("dependency_evidence_missing");
    prs.push(...issue.closedByPullRequestsReferences.nodes);
    const page = issue.closedByPullRequestsReferences.pageInfo;
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) throw new TrackerError("dependency_evidence_missing");
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor);
  if (issue.state !== "CLOSED" || issue.stateReason !== "COMPLETED") return null;
  const closure = issue.timelineItems.nodes.at(-1);
  const closer = closure?.__typename === "ClosedEvent" ? closure.closer : null;
  if (closer?.__typename !== "PullRequest" || closer.repository?.nameWithOwner !== repository) return null;
  const pr = prs.find(pr => pr.number === closer.number && pr.repository.nameWithOwner === repository);
  if (!pr?.merged || !pr.mergedAt || !pr.mergeCommit?.oid || !closer.merged || closer.mergeCommit?.oid !== pr.mergeCommit.oid || pr.baseRefName !== pr.repository.defaultBranchRef?.name || closer.baseRefName !== pr.baseRefName) return null;
  const target = remoteCommit(github, { repository }, pr.baseRefName).sha;
  remoteAncestor(github, { repository }, pr.mergeCommit.oid, target);
  return { pullRequest: pr.number, target: pr.baseRefName, commit: pr.mergeCommit.oid, closedAt: closure.createdAt };
}
export function dependencyReadiness(state, record, { github, config }) {
  verifyContext(github, config, record);
  let dependencies;
  try { dependencies = github.pages(`repos/${config.repository}/issues/${record.number}/dependencies/blocked_by`); }
  catch (error) {
    if (error.code !== "github_not_found") throw error;
    const issue = github.request(`repos/${config.repository}/issues/${record.number}`);
    const opening = (issue.body ?? "").split(/^##\s+/m)[0];
    const fallback = opening.match(/^Blocked by:\s*(.*)$/im)?.[1];
    if (fallback === undefined) throw new TrackerError("dependency_evidence_missing");
    dependencies = [...fallback.matchAll(/#(\d+)/g)].map(match => ({ number: Number(match[1]) }));
    if (!dependencies.length && !/^\s*(?:none|no blockers|n\/a)[.\s]*$/i.test(fallback)) throw new TrackerError("dependency_evidence_missing");
  }
  const blockers = dependencies.map(dependency => {
    const repository = blockerRepository(dependency, config.repository);
    const blocker = repository === config.repository ? state.tickets[dependency.number] : null;
    const context = record.integrationContext;
    if (context && blocker?.status === "integrated" && blocker.parent === record.parent && context.specification === record.parent && blocker.integrationContext?.specification === context.specification && blocker.integrationContext.branch === context.branch) {
      try {
        const evidence = verifyIntegration(github, config, blocker, blocker.integration);
        return { repository, number: dependency.number, satisfied: true, kind: "internal-integration", evidence };
      } catch (error) {
        if (error.code?.startsWith("github_")) throw error;
      }
    }
    const evidence = finalMerge(github, repository, dependency.number);
    return { repository, number: dependency.number, satisfied: Boolean(evidence), kind: "external-final-merge", evidence };
  });
  return { ready: blockers.every(blocker => blocker.satisfied), blockers };
}
