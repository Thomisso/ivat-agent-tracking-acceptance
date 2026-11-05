import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
const mode = process.argv[2];
if (mode === "syntax") {
  function check(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) check(file);
      else if (entry.name.endsWith(".mjs")) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
    }
  }
  check("scripts");
} else if (mode === "diff") {
  const empty = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], { encoding: "utf8" }).trim();
  execFileSync("git", ["diff", "--check", empty, "HEAD"], { stdio: "inherit" });
} else process.exitCode = 1;
