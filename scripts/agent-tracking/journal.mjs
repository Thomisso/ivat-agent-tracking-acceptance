import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { TrackerError } from "./github.mjs";

export function journalDirectory(config) {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const scope = createHash("sha256").update(`${config.repository}:${config.registryIssue}:${config.project.id}`).digest("hex").slice(0, 16);
  return path.join(path.resolve(common), "agent-tracker", scope);
}

export function saveJournal(directory, journal) {
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, path.join(directory, "journal.json"));
  const parent = fs.openSync(directory, "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function lockOwner(directory) {
  let contents;
  try {
    contents = fs.readFileSync(path.join(directory, "owner.json"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new TrackerError("local_lock_unverified");
    // The initial tracker used a numeric local PID file. Unknown or partial
    // records are never reclaimed on age alone.
    try {
      const pid = fs.readFileSync(path.join(directory, "pid"), "utf8").trim();
      if (/^[1-9][0-9]*$/.test(pid) && Number.isSafeInteger(Number(pid))) return { pid: Number(pid), token: null };
    } catch { /* No verified owner record. */ }
    throw new TrackerError("local_lock_unverified");
  }
  try {
    const owner = JSON.parse(contents);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== os.hostname() || typeof owner.token !== "string") throw new Error("unknown owner");
    return owner;
  } catch { throw new TrackerError("local_lock_unverified"); }
}

function definitelyDead(owner) {
  try { process.kill(owner.pid, 0); return false; }
  catch (error) {
    if (error.code === "ESRCH") return true;
    throw new TrackerError("local_lock_unverified");
  }
}

function acquireLock(directory, depth = 0) {
  if (depth > 8) throw new TrackerError("local_lock_unverified");
  try { fs.mkdirSync(directory); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = fs.lstatSync(directory);
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new TrackerError("local_lock_unverified");
    if (!definitelyDead(lockOwner(directory))) throw new TrackerError("local_run_busy");
    // Elect one reclaimer inside the exact old lock. A competing reclaimer
    // sees this process alive; a crashed reclaimer can itself be recovered.
    const releaseRecovery = acquireLock(path.join(directory, "recovery"), depth + 1);
    try {
      const current = fs.lstatSync(directory);
      if (current.ino !== previous.ino || current.dev !== previous.dev || !definitelyDead(lockOwner(directory))) throw new TrackerError("local_run_busy");
      const retired = `${directory}.retired-${randomUUID()}`;
      fs.renameSync(directory, retired);
      fs.rmSync(retired, { recursive: true, force: true });
    } finally { releaseRecovery(); }
    try { fs.mkdirSync(directory); } catch { throw new TrackerError("local_run_busy"); }
  }
  const owner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  const descriptor = fs.openSync(path.join(directory, "owner.json"), "wx", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  return () => {
    try {
      if (lockOwner(directory).token === owner.token) fs.rmSync(directory, { recursive: true, force: true });
    } catch { /* A retired lock is gone; never delete a replacement lock. */ }
  };
}

export function withJournal(config, action) {
  const directory = journalDirectory(config);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(directory, "lock"));
  try {
    const file = path.join(directory, "journal.json");
    const journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1, run: null, nextSequence: 1, pending: [], rejected: [], publishedRevision: 0 };
    return action(journal, () => saveJournal(directory, journal));
  } finally { release(); }
}
