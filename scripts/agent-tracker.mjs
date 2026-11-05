#!/usr/bin/env node
import { GitHub, TrackerError } from "./agent-tracking/github.mjs";
import { loadConfig, setup, validateConfig } from "./agent-tracking/config.mjs";
import { runCommand } from "./agent-tracking/commands.mjs";
import { processWorker } from "./agent-tracking/publisher.mjs";

try {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) throw new TrackerError("arguments_invalid");
    const key = args[index].slice(2);
    if (["disable-native-workflows", "local", "recover"].includes(key)) options[key] = true;
    else {
      if (args[index + 1] === undefined || args[index + 1].startsWith("--")) throw new TrackerError("arguments_invalid");
      options[key] = args[++index];
    }
  }
  const github = new GitHub();
  let result;
  if (command === "setup") result = setup(github, options);
  else {
    const config = loadConfig(options);
    if (command === "doctor") {
      const checked = validateConfig(github, config);
      result = { ok: true, project: checked.project.url };
    } else if (command === "worker") {
      let event = process.env.TRACKER_EVENT ? JSON.parse(process.env.TRACKER_EVENT) : null;
      if (!process.env.GH_TOKEN?.trim()) throw new TrackerError("actions_credential_missing");
      if (!event && ["issues", "schedule", "pull_request_target", "push"].includes(process.env.GITHUB_EVENT_NAME) && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")) {
        if (process.env.GITHUB_EVENT_NAME === "schedule" && process.env.TRACKER_SCHEDULE === "*/5 * * * *") {
          event = { id: `activity-${process.env.GITHUB_RUN_ID}`, type: "observe-activity", at: new Date().toISOString(), payload: {} };
        } else {
          const run = github.request(`repos/${config.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
          event = { id: `discovery-${process.env.GITHUB_RUN_ID}`, type: "reconcile", at: new Date(run.created_at).toISOString(), payload: {} };
        }
      }
      result = processWorker(github, config, event);
    }
    else result = runCommand(command, github, config, options);
  }
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof TrackerError ? error.code : "tracker_failed" }));
  process.exitCode = 1;
}
