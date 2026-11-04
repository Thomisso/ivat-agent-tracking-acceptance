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
    if (key === "disable-native-workflows") options[key] = true;
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
    } else if (command === "worker") result = processWorker(github, config, JSON.parse(process.env.TRACKER_EVENT ?? "null"));
    else result = runCommand(command, github, config, options);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof TrackerError ? error.code : "tracker_failed" }));
  process.exitCode = 1;
}
