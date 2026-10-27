import fs from "node:fs";
import path from "node:path";
import { createStore } from "../../src/core/store.mjs";

const dir = process.argv[2];
const read = fs.readFileSync;
const write = fs.writeFileSync;
const unlink = fs.unlinkSync;
const readdir = fs.readdirSync;
const exists = fs.existsSync;
const gate = new Int32Array(new SharedArrayBuffer(4));
const marker = (name) => path.join(dir, name);
const signal = (name, value = "1") => write(marker(name), value);
function waitFor(names) {
  const deadline = Date.now() + 6000;
  while (!names.some((name) => exists(marker(name)))) {
    if (Date.now() >= deadline) throw new Error(`Timed out at race barrier: ${names.join(" or ")}`);
    // Synchronize actual processes on observed filesystem events, not elapsed
    // guesses. Atomics releases this process's CPU between condition probes.
    Atomics.wait(gate, 0, 0, 2);
  }
}
waitFor(["roles.json"]);
const roles = JSON.parse(read(marker("roles.json"), "utf8"));
const role = roles[String(process.pid)];
const other = role === "A" ? "B" : "A";
const turns = path.join(dir, "lock-turns");
const lock = path.join(dir, "lock");
let scans = 0;
let capturedMissingChoosing = false;

fs.writeFileSync = function(file, value, ...options) {
  const name = String(file);
  if (path.dirname(name) === turns && name.endsWith(".choosing")) {
    const result = write(file, value, ...options);
    signal(`${role}-choosing`);
    return result;
  }
  if (path.dirname(name) === turns && name.endsWith(".ticket")) {
    signal(`${role}-before-publish`, String(value));
    waitFor([`${other}-before-publish`]);
    if (role === "B") waitFor(["A-snapshot-choosing"]);
  }
  return write(file, value, ...options);
};
fs.readdirSync = function(directory, ...options) {
  if (String(directory) !== turns) return readdir(directory, ...options);
  scans++;
  if (scans === 1) {
    waitFor(["A-choosing"]);
    waitFor(["B-choosing"]);
  }
  const names = readdir(directory, ...options);
  if (role === "A" && scans === 2) {
    const hasChoosing = names.some((name) => name.startsWith(`${roles.BPid}-`) && name.endsWith(".choosing"));
    const hasTicket = names.some((name) => name.startsWith(`${roles.BPid}-`) && name.endsWith(".ticket"));
    if (!hasChoosing || hasTicket) throw new Error("Race snapshot did not contain only B's choosing pathname");
    capturedMissingChoosing = true;
    signal("A-snapshot-choosing");
  } else if (role === "A" && scans > 2) {
    signal("A-rescan");
  }
  return names;
};
fs.unlinkSync = function(file) {
  const result = unlink(file);
  if (role === "B" && path.dirname(String(file)) === turns && String(file).endsWith(".choosing")) signal("B-published");
  return result;
};
fs.readFileSync = function(file, ...options) {
  const name = String(file);
  if (role === "A" && capturedMissingChoosing && path.dirname(name) === turns &&
      path.basename(name).startsWith(`${roles.BPid}-`) && name.endsWith(".choosing")) {
    waitFor(["B-published"]);
    // This is a real ENOENT: B atomically published its real ticket, then
    // removed the choosing entry captured in A's earlier directory snapshot.
  }
  const value = read(file, ...options);
  if (name === lock && String(value) === "dead-pid") {
    if (role === "A") {
      signal("A-stale-observed");
      waitFor(["B-entered"]);
    } else {
      // A correct scan restarts and blocks behind B. The old scan instead
      // passes its guard and reads the stale owner. Let either path progress.
      waitFor(["A-stale-observed", "A-rescan"]);
    }
  }
  return value;
};

const ran = await createStore(dir).withLock(async () => {
  fs.appendFileSync(marker("holders.jsonl"), JSON.stringify({ enter: role }) + "\n");
  signal(`${role}-entered`);
  if (role === "B" && exists(marker("A-stale-observed"))) waitFor(["A-entered"]);
  fs.appendFileSync(marker("holders.jsonl"), JSON.stringify({ exit: role }) + "\n");
});
console.log(JSON.stringify({ role, ran }));
