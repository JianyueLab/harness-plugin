import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readGenMetadata,
  sqliteBackend,
  readViaBun,
  readViaNode,
  readViaCli,
} from "../src/lib/sqlite.mjs";

const req = createRequire(import.meta.url);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-sqlite-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name, rows) {
  const file = path.join(dir, name);
  const db = new Database(file, { create: true });
  db.run("CREATE TABLE `gen_metadata` (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`))");
  const insert = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  for (const [idx, data] of rows) insert.run(idx, data, data.length);
  db.close();
  return file;
}

test("readGenMetadata: reads rows after a cursor, in order", () => {
  const file = fixture("a.db", [
    [0, Buffer.from([1, 2, 3])],
    [7, Buffer.from([4, 5])],
    [9, Buffer.from([6])],
  ]);

  const rows = readGenMetadata(file, 0);

  expect(rows.map((r) => r.idx)).toEqual([7, 9]);
  expect(Buffer.from(rows[0].data)).toEqual(Buffer.from([4, 5]));
});

test("readGenMetadata: returns an empty array when nothing is new", () => {
  const file = fixture("b.db", [[3, Buffer.from([1])]]);
  expect(readGenMetadata(file, 3)).toEqual([]);
});

test("readGenMetadata: returns an empty array for a database that is not there", () => {
  expect(readGenMetadata(path.join(dir, "missing.db"), 0)).toEqual([]);
});

test("readGenMetadata: returns null for a corrupt database", () => {
  const file = path.join(dir, "corrupt.db");
  fs.writeFileSync(file, "not a database");
  expect(readGenMetadata(file, 0)).toEqual(null);
});

test("readGenMetadata: returns null for a database missing the gen_metadata table", () => {
  const file = path.join(dir, "notab.db");
  const db = new Database(file, { create: true });
  db.run("CREATE TABLE other (id integer)");
  db.close();
  expect(readGenMetadata(file, 0)).toEqual(null);
});

test("reports which backend it used", () => {
  expect(["bun", "node", "cli"]).toContain(sqliteBackend());
});

// Tests for each backend directly, so all three paths can be verified

test("readViaBun: reads rows and returns null on error", () => {
  const file = fixture("bun.db", [
    [1, Buffer.from([10, 20])],
    [3, Buffer.from([30])],
  ]);

  // Success case
  const rows = readViaBun(Database, file, 1);
  expect(rows.map((r) => r.idx)).toEqual([3]);
  expect(Buffer.from(rows[0].data)).toEqual(Buffer.from([30]));

  // Corrupt database
  const corrupt = path.join(dir, "bun-corrupt.db");
  fs.writeFileSync(corrupt, "garbage");
  expect(readViaBun(Database, corrupt, 0)).toEqual(null);

  // Missing table
  const notab = path.join(dir, "bun-notab.db");
  const db = new Database(notab, { create: true });
  db.run("CREATE TABLE other (id integer)");
  db.close();
  expect(readViaBun(Database, notab, 0)).toEqual(null);
});

test("readViaNode: reads rows and returns null on error", () => {
  let DatabaseSync;
  try {
    DatabaseSync = req("node:sqlite").DatabaseSync;
  } catch {
    console.log("SKIP readViaNode: node:sqlite not available");
    return;
  }

  const file = fixture("node.db", [
    [2, Buffer.from([40, 50])],
    [5, Buffer.from([60])],
  ]);

  // Success case
  const rows = readViaNode(DatabaseSync, file, 2);
  expect(rows.map((r) => r.idx)).toEqual([5]);
  expect(Buffer.from(rows[0].data)).toEqual(Buffer.from([60]));

  // Corrupt database
  const corrupt = path.join(dir, "node-corrupt.db");
  fs.writeFileSync(corrupt, "garbage");
  expect(readViaNode(DatabaseSync, corrupt, 0)).toEqual(null);

  // Missing table
  const notab = path.join(dir, "node-notab.db");
  const db = new Database(notab, { create: true });
  db.run("CREATE TABLE other (id integer)");
  db.close();
  expect(readViaNode(DatabaseSync, notab, 0)).toEqual(null);
});

test("readViaCli: reads rows and returns null on error", () => {
  // Check if sqlite3 CLI is available
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    console.log("SKIP readViaCli: sqlite3 not available on PATH");
    return;
  }

  const file = fixture("cli.db", [
    [4, Buffer.from([70, 80])],
    [6, Buffer.from([90])],
  ]);

  // Success case
  const rows = readViaCli(file, 4);
  expect(rows.map((r) => r.idx)).toEqual([6]);
  expect(Buffer.from(rows[0].data)).toEqual(Buffer.from([90]));

  // Corrupt database
  const corrupt = path.join(dir, "cli-corrupt.db");
  fs.writeFileSync(corrupt, "garbage");
  expect(readViaCli(corrupt, 0)).toEqual(null);

  // Missing table
  const notab = path.join(dir, "cli-notab.db");
  const db = new Database(notab, { create: true });
  db.run("CREATE TABLE other (id integer)");
  db.close();
  expect(readViaCli(notab, 0)).toEqual(null);
});
