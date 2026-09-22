// Scripted real bridge child for test/application-composition.test.ts. It
// records its own descriptor view and environment keys into the evidence
// root named by its static config, then behaves like the custody child:
//   no-join: on stdin EOF write a no_join_action outcome to fd 3 and exit 0;
//   hung:    ignore SIGTERM and never exit cooperatively (SIGKILL reaps it).
// It never speaks bridge-session/v2, so a timed join is refused by the
// accepted adapter itself; that refusal is part of what the test records.
import { fstatSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setInterval } from "node:timers";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const fds = readdirSync("/dev/fd").map(Number).filter(Number.isInteger).flatMap((fd) => {
  try { const stat = fstatSync(fd, { bigint: true }); return [{ fd, file: stat.isFile(), dev: stat.dev.toString(), ino: stat.ino.toString() }]; }
  catch { return []; }
});
writeFileSync(path.join(config.evidenceRoot, "child.pid"), String(process.pid));
writeFileSync(path.join(config.evidenceRoot, "child.json"), JSON.stringify({ fds, env: Object.keys(process.env) }));
const outcome = { schema: "bridge-process-outcome/v1", ...config.custody, outcome: "no_join_action", reason: "join_not_issued", observedAt: "2026-09-02T14:31:00.000Z" };
if (config.bundleVersion === "hung") {
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => { writeSync(3, JSON.stringify(outcome) + "\n"); process.exit(0); });
}
