import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const command = new URL("../../agent-tracker.mjs", import.meta.url).pathname;

export function trackerFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ivat-tracker-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  copyFileSync(new URL("agent-tracker-gh.mjs", import.meta.url), path.join(bin, "gh"));
  chmodSync(path.join(bin, "gh"), 0o755);
  const remote = path.join(root, "github.json");
  writeFileSync(remote, JSON.stringify({ project: { id: "PVT_test", title: "Agent work", url: "https://github.com/users/example/projects/1" }, fields: [{ id: "status", name: "Status", dataType: "SINGLE_SELECT", options: [] }, { id: "parent", name: "Parent issue", dataType: "PARENT_ISSUE" }, { id: "title", name: "Title", dataType: "TITLE" }] }));
  const clock = path.join(root, "clock");
  const environment = { ...process.env, GH_TOKEN: "synthetic-actions-credential", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("agent-tracker-clock.mjs", import.meta.url).pathname}`, TRACKER_CLOCK_FILE: clock, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: remote, TRACKER_COMMAND: command };
  function checkout(directory) {
    mkdirSync(directory);
    const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=Recovery test", "-c", "user.email=recovery@example.test", "commit", "--allow-empty", "-m", "Fixture");
    git("branch", "feat/ticket");
    return client(directory, git);
  }
  function client(directory, git) {
    return {
      directory, git,
      now: at => writeFileSync(clock, at),
      run: (...args) => spawnSync(process.execPath, [command, ...args, "--wait-seconds", "0"], { cwd: directory, encoding: "utf8", env: environment, timeout: 20000 }),
      spawn: (...args) => spawn(process.execPath, [command, ...args], { cwd: directory, env: environment, stdio: "ignore" }),
      worker: (event, workerEnvironment = {}) => spawnSync(process.execPath, [command, "worker"], { cwd: directory, encoding: "utf8", env: { ...environment, GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/agent-tracking.yml@refs/heads/main", GITHUB_ACTOR: "maintainer", TRACKER_EVENT: event ? JSON.stringify(event) : "", ...workerEnvironment } }),
      setup() { return this.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99"); },
      remote: () => JSON.parse(readFileSync(remote, "utf8")),
      updateRemote: update => { const state = JSON.parse(readFileSync(remote, "utf8")); update(state); writeFileSync(remote, JSON.stringify(state)); },
    };
  }
  const primary = checkout(path.join(root, "primary"));
  let clones = 0;
  return { ...primary, clone: () => checkout(path.join(root, `clone-${++clones}`)), linked: () => {
    const directory = path.join(root, `linked-${++clones}`);
    primary.git("worktree", "add", directory, "-b", `linked-${clones}`);
    mkdirSync(path.join(directory, ".github"));
    copyFileSync(path.join(primary.directory, ".github/agent-tracking.json"), path.join(directory, ".github/agent-tracking.json"));
    return client(directory, (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim());
  } };
}

export function resultJson(result) { return JSON.parse(result.stdout || result.stderr); }
