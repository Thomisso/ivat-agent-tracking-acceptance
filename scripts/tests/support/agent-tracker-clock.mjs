// External process clock for command-boundary tests; production has no clock bypass.
import { existsSync, readFileSync } from "node:fs";
const SystemDate = Date;
const now = () => process.env.TRACKER_CLOCK_FILE && existsSync(process.env.TRACKER_CLOCK_FILE) ? SystemDate.parse(readFileSync(process.env.TRACKER_CLOCK_FILE, "utf8")) : SystemDate.now();
globalThis.Date = class extends SystemDate {
  constructor(...args) { super(...(args.length ? args : [now()])); }
  static now() { return now(); }
};
