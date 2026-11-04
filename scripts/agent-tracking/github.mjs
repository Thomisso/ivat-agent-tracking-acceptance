import { spawnSync } from "node:child_process";

export class TrackerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export class GitHub {
  request(endpoint, { method = "GET", body } = {}) {
    const args = ["api", endpoint, "--hostname", "github.com", "--method", method, "-H", "X-GitHub-Api-Version: 2026-03-10"];
    if (body !== undefined) args.push("--input", "-");
    const result = spawnSync("gh", args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    let parsed;
    try { parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null; } catch { /* A proxy may return HTML. */ }
    if (result.status !== 0 || parsed?.errors?.length) {
      const diagnostic = `${result.stderr ?? ""} ${JSON.stringify(parsed?.errors ?? [])}`;
      if (/scope|permission|401|403|unauthori|forbidden/i.test(diagnostic)) throw new TrackerError("github_permission_denied");
      if (/404|not found/i.test(diagnostic)) throw new TrackerError("github_not_found");
      if (parsed?.errors?.length || /422|unprocessable|validation/i.test(diagnostic)) throw new TrackerError("github_request_rejected");
      throw new TrackerError("github_connection_failed");
    }
    return parsed;
  }

  graph(query, variables = {}) { return this.request("graphql", { method: "POST", body: { query, variables } }).data; }

  pages(endpoint) {
    const results = [];
    for (let page = 1; ; page++) {
      const items = this.request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      results.push(...items);
      if (items.length < 100) return results;
    }
  }

  project(owner, number, ownerType = "User") {
    const kind = ownerType === "Organization" ? "organization" : "user";
    const data = this.graph(`query TrackerProject($owner:String!,$number:Int!){ ${kind}(login:$owner){ projectV2(number:$number){ id title url } } }`, { owner, number });
    return data[kind]?.projectV2;
  }

  fields(projectId) {
    return this.graph(`query TrackerFields($id:ID!){ node(id:$id){ ... on ProjectV2 { fields(first:100){ nodes{ ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options{id name color description} } } pageInfo{hasNextPage} } } } }`, { id: projectId }).node.fields;
  }

  workflows(projectId) {
    return this.graph(`query TrackerWorkflows($id:ID!){node(id:$id){... on ProjectV2{workflows(first:100){nodes{id name enabled} pageInfo{hasNextPage}}}}}`, { id: projectId }).node.workflows;
  }
}
