import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { TrackerError } from "./github.mjs";
import { readRegistry } from "./state.mjs";
import { validateEvent } from "./events.mjs";
import { withJournal } from "./journal.mjs";
import { validateConfig } from "./config.mjs";

function sync(github, config, journal, save, options) {
  const seconds = Number(options["wait-seconds"] ?? 120);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new TrackerError("wait_invalid");
  while (journal.pending.length) {
    const event = journal.pending[0];
    try {
      const dispatched = github.request(`repos/${config.repository}/actions/workflows/${config.workflow}/dispatches`, { method: "POST", body: { ref: config.codeRef, inputs: { event: JSON.stringify(event) } } });
      if (dispatched?.workflow_run_id) { journal.dispatches ??= {}; journal.dispatches[event.id] = dispatched.workflow_run_id; save(); }
    } catch { throw new TrackerError("publication_pending"); }
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      let remote;
      try { remote = readRegistry(github, config).state; } catch { throw new TrackerError("publication_pending"); }
      const receipt = remote.receipts[event.id];
      journal.lastConfirmed = remote;
      if (receipt?.state === "published") {
        if (event.type === "start") journal.run = { runId: event.runId, generation: receipt.generation };
        journal.pending.shift(); journal.publishedRevision = remote.publishedRevision; save();
        break;
      }
      if (receipt?.state === "rejected") {
        journal.pending.shift(); journal.rejected.push({ id: event.id, error: receipt.error }); save();
        throw new TrackerError(receipt.error);
      }
      if (Date.now() >= deadline) throw new TrackerError("publication_pending");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  return { ok: true, synchronized: true, revision: journal.publishedRevision, run: journal.run };
}

export function runCommand(command, github, config, options) {
  return withJournal(config, (journal, save) => {
    if (command === "show") return options.local ? { ok: true, local: journal } : { ok: true, local: journal, remote: readRegistry(github, config).state };
    if (command === "sync") return sync(github, config, journal, save, options);
    const at = options.at ?? new Date().toISOString();
    let event;
    if (command === "start") {
      if (journal.pending.length) throw new TrackerError("pending_events_require_sync");
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (remote.owner) throw new TrackerError("run_already_owned");
      event = { id: randomUUID(), type: "start", runId: options.run ?? randomUUID(), generation: remote.generation, sequence: 0, at, payload: {} };
      journal.nextSequence = 1;
    } else if (command === "claim") {
      if (!journal.run) throw new TrackerError("owned_run_required");
      let branchRevision;
      try { branchRevision = execFileSync("git", ["rev-parse", "--verify", `refs/heads/${options.branch}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { throw new TrackerError("branch_missing"); }
      event = { id: randomUUID(), type: "claim", ...journal.run, sequence: journal.nextSequence, at, payload: { issue: Number(options.issue), agent: options.agent, branch: options.branch, branchRevision, result: options.result ?? "Implementation started" } };
    } else throw new TrackerError("command_unknown");
    validateEvent(event);
    journal.pending.push(event);
    if (command !== "start") journal.nextSequence++;
    save();
    return sync(github, config, journal, save, options);
  });
}
