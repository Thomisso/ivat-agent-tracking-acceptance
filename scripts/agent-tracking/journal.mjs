import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

export function withJournal(config, action) {
  const directory = journalDirectory(config);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "lock");
  try { fs.mkdirSync(lock); } catch { throw new TrackerError("local_run_busy"); }
  try {
    fs.writeFileSync(path.join(lock, "pid"), `${process.pid}`);
    const file = path.join(directory, "journal.json");
    const journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1, run: null, nextSequence: 1, pending: [], rejected: [], publishedRevision: 0 };
    return action(journal, () => saveJournal(directory, journal));
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
