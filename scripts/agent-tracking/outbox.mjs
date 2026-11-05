import { randomUUID } from "node:crypto";
import { TrackerError } from "./github.mjs";
import { readRegistry, projectionSynchronized } from "./state.mjs";
import { receiptOwnershipMatches, submissionOwnershipMatches } from "./recovery.mjs";

export function quarantineRun(journal, save, reason) {
  journal.superseded ??= [];
  journal.superseded.push({ run: journal.run, reason, events: journal.pending });
  journal.pending = [];
  journal.run = null;
  delete journal.stopRequested;
  save();
}

function observe(github, config, journal, save) {
  const state = readRegistry(github, config).state;
  const known = journal.lastObserved ?? journal.lastConfirmed;
  if (known && (state.revision < known.revision || state.generation < known.generation || state.publishedRevision < known.publishedRevision || (state.owner && known.owner && state.owner.generation === known.owner.generation && state.owner.runId === known.owner.runId && state.owner.sequence < known.owner.sequence))) throw new TrackerError("registry_snapshot_stale");
  journal.lastObserved = state;
  save();
  return state;
}

function consumeReceipt(journal, event, state, save) {
  const receipt = state.receipts[event.id];
  if (!receipt) return false;
  if (receipt.state === "rejected") {
    journal.pending.shift();
    journal.rejected.push({ id: event.id, error: receipt.error });
    if (event.type === "stop") delete journal.stopRequested;
    save();
    if (["run_superseded", "event_superseded"].includes(receipt.error)) quarantineRun(journal, save, receipt.error);
    throw new TrackerError(receipt.error);
  }
  if (!receiptOwnershipMatches(state, event, receipt)) {
    quarantineRun(journal, save, "run_superseded");
    throw new TrackerError("run_superseded");
  }
  if (receipt.state !== "published") return false;
  if (["start", "restart", "takeover"].includes(event.type)) {
    journal.run = { runId: event.runId, generation: receipt.generation };
    journal.controllerAccount = state.owner.account;
  }
  if (event.type === "stop") {
    journal.stoppedRun = journal.run;
    journal.run = null;
    delete journal.stopRequested;
  }
  journal.pending.shift();
  journal.publishedRevision = state.publishedRevision;
  if (projectionSynchronized(state)) journal.lastConfirmed = state;
  delete journal.publicationError;
  save();
  return true;
}

export function synchronize(github, config, journal, save, options = {}) {
  const seconds = Number(options["wait-seconds"] ?? 120);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new TrackerError("wait_invalid");
  for (;;) {
    while (journal.pending.length) {
      const event = journal.pending[0];
      let current;
      try { current = observe(github, config, journal, save); } catch { throw new TrackerError("publication_pending"); }
      if (consumeReceipt(journal, event, current, save)) continue;
      if (!submissionOwnershipMatches(current, event)) {
        quarantineRun(journal, save, "run_superseded");
        throw new TrackerError("run_superseded");
      }
      try {
        const dispatched = github.request(`repos/${config.repository}/actions/workflows/${config.workflow}/dispatches`, { method: "POST", body: { ref: config.codeRef, inputs: { event: JSON.stringify(event) } } });
        if (dispatched?.workflow_run_id) { journal.dispatches ??= {}; journal.dispatches[event.id] = dispatched.workflow_run_id; save(); }
      } catch (error) {
        // The request may have reached GitHub. The registry receipt, not this
        // response or a workflow conclusion, decides whether it succeeded.
        journal.publicationError = { eventId: event.id, code: error.code ?? "github_connection_failed" };
        save();
      }
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        let state;
        try { state = observe(github, config, journal, save); } catch { throw new TrackerError("publication_pending"); }
        if (consumeReceipt(journal, event, state, save)) break;
        if (Date.now() >= deadline) throw new TrackerError("publication_pending");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
    const state = observe(github, config, journal, save);
    if (journal.run && (!state.owner || state.owner.runId !== journal.run.runId || state.owner.generation !== journal.run.generation || (journal.controllerAccount && state.owner.account !== journal.controllerAccount))) {
      quarantineRun(journal, save, "run_superseded");
      throw new TrackerError("run_superseded");
    }
    if (!projectionSynchronized(state)) {
      journal.pending.push({ id: randomUUID(), type: "repair", at: new Date().toISOString(), payload: {} });
      save();
      continue;
    }
    journal.lastConfirmed = state;
    journal.publishedRevision = state.publishedRevision;
    save();
    return { ok: true, synchronized: true, revision: state.revision, publishedRevision: state.publishedRevision, pending: journal.pending.length, ownership: journal.run ? "current" : state.owner ? "not_owned" : "inactive", run: journal.run };
  }
}
