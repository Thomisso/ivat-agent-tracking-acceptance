import { buildActivityPayload } from "./activity.mjs";
import { randomUUID } from "node:crypto";
import { localBranchRevision } from "./evidence.mjs";
import { TrackerError } from "./github.mjs";
import { readRegistry } from "./state.mjs";
import { validateEvent } from "./events.mjs";
import { withJournal } from "./journal.mjs";
import { lifecycleCommands, buildLifecyclePayload } from "./lifecycle.mjs";
import { validateConfig } from "./config.mjs";
import { synchronize as sync, quarantineRun } from "./outbox.mjs";
import { collectLocalFacts } from "./recovery.mjs";

export function runCommand(command, github, config, options) {
  return withJournal(config, (journal, save) => {
    if (command === "show") return options.local ? { ok: true, local: journal } : { ok: true, local: journal, remote: readRegistry(github, config).state };
    if (command === "sync") return sync(github, config, journal, save, options);
    const at = options.at ?? new Date().toISOString();
    let event;
    if (command === "discover") {
      const payload = options.parent ? { parent: Number(options.parent), expectedSelectionRevision: readRegistry(github, config).state.selectionRevision ?? 0 } : {};
      event = { id: randomUUID(), type: "discover", at, payload };
    } else if (command === "start") {
      if (journal.pending.length) throw new TrackerError("pending_events_require_sync");
      if (journal.run) throw new TrackerError("run_already_owned");
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (remote.owner) throw new TrackerError("run_already_owned");
      event = { id: randomUUID(), type: "start", runId: options.run ?? randomUUID(), generation: remote.generation, sequence: 0, at, payload: {} };
      journal.nextSequence = 1;
    } else if (command === "stop") {
      if (!journal.run) throw new TrackerError("owned_run_required");
      event = { id: randomUUID(), type: "stop", ...journal.run, sequence: journal.nextSequence, at, payload: { reason: options.reason } };
    } else if (command === "resume") {
      if (journal.pending.length && !options.recover) sync(github, config, journal, save, options);
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (remote.owner) {
        if (options.recover) {
          if (options.run !== remote.owner.runId) throw new TrackerError("expected_run_required");
          if (github.request("user").login !== remote.owner.account) throw new TrackerError("run_actor_mismatch");
          event = { id: randomUUID(), type: "takeover", runId: remote.owner.runId, generation: remote.generation, sequence: 0, at, payload: { fromRunId: remote.owner.runId, fromGeneration: remote.generation, reason: options.reason, source: "remote-recovery", localFacts: collectLocalFacts(remote, remote.owner.runId) } };
        } else {
          if (!journal.run || remote.owner.runId !== journal.run.runId || remote.owner.generation !== journal.run.generation || journal.lastConfirmed?.owner?.runId !== journal.run.runId || journal.lastConfirmed.owner.generation !== journal.run.generation) throw new TrackerError("owned_run_required");
          event = { id: randomUUID(), type: "resume", ...journal.run, sequence: journal.nextSequence, at, payload: { source: "local", localFacts: collectLocalFacts(remote, remote.owner.runId) } };
        }
      } else {
        const prior = remote.runHistory?.[remote.generation];
        if (!prior || prior.kind !== "stopped" || (options.run ?? journal.stoppedRun?.runId) !== prior.runId) throw new TrackerError("stopped_run_required");
        if (!options.recover && journal.stoppedRun?.runId !== prior.runId) throw new TrackerError("owned_run_required");
        if (github.request("user").login !== prior.account) throw new TrackerError("run_actor_mismatch");
        event = { id: randomUUID(), type: "restart", runId: prior.runId, generation: remote.generation, sequence: 0, at, payload: { reason: options.recover ? options.reason : options.reason ?? "Explicitly resumed stopped run", source: options.recover ? "remote-recovery" : "local-restart", localFacts: collectLocalFacts(remote, prior.runId) } };
        journal.nextSequence = 1;
      }
    } else if (command === "takeover") {
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (!remote.owner || options["from-run"] !== remote.owner.runId || Number(options["from-generation"]) !== remote.owner.generation) throw new TrackerError("run_superseded");
      if (github.request("user").login !== remote.owner.account) throw new TrackerError("run_actor_mismatch");
      event = { id: randomUUID(), type: "takeover", runId: options.run ?? randomUUID(), generation: remote.generation, sequence: 0, at, payload: { fromRunId: remote.owner.runId, fromGeneration: remote.owner.generation, reason: options.reason, source: "takeover", localFacts: collectLocalFacts(remote, remote.owner.runId) } };
    } else if (["repair", "observe-activity"].includes(command)) {
      event = { id: randomUUID(), type: command, at, payload: {} };
    } else if (command === "claim") {
      if (!journal.run) throw new TrackerError("owned_run_required");
      if (journal.stopRequested) throw new TrackerError("run_stop_pending");
      const branchRevision = localBranchRevision(options.branch);
      event = { id: randomUUID(), type: "claim", ...journal.run, sequence: journal.nextSequence, at, payload: { issue: Number(options.issue), agent: options.agent, branch: options.branch, branchRevision, ...(options.spec || options["integration-branch"] ? { integrationContext: { specification: Number(options.spec), branch: options["integration-branch"] } } : {}), result: options.result ?? "Implementation started" } };
    } else if (command === "activity" || lifecycleCommands.includes(command)) {
      if (!journal.run) throw new TrackerError("owned_run_required");
      if (journal.stopRequested) throw new TrackerError("run_stop_pending");
      event = { id: randomUUID(), type: command, ...journal.run, sequence: journal.nextSequence, at, payload: command === "activity" ? buildActivityPayload(options) : buildLifecyclePayload(command, options, journal.lastConfirmed) };
    } else throw new TrackerError("command_unknown");
    validateEvent(event);
    if (["restart", "takeover"].includes(event.type)) {
      if (journal.pending.length) quarantineRun(journal, save, "explicit_recovery");
      journal.nextSequence = 1;
    }
    journal.pending.push(event);
    if (event.type === "stop") journal.stopRequested = event.id;
    if (!["start", "restart", "takeover", "repair", "discover", "observe-activity"].includes(event.type)) journal.nextSequence++;
    save();
    const result = sync(github, config, journal, save, options);
    const outcome = journal.lastConfirmed?.receipts[event.id]?.outcome;
    return outcome ? { ...result, outcome } : result;
  });
}
