import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGenMetadata, sqliteBackend } from "../src/lib/sqlite.mjs";

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

test("reads rows after a cursor, in order", () => {
  const file = fixture("a.db", [
    [0, Buffer.from([1, 2, 3])],
    [7, Buffer.from([4, 5])],
    [9, Buffer.from([6])],
  ]);

  const rows = readGenMetadata(file, 0);

  expect(rows.map((r) => r.idx)).toEqual([7, 9]);
  expect(Buffer.from(rows[0].data)).toEqual(Buffer.from([4, 5]));
});

test("returns an empty array when nothing is new", () => {
  const file = fixture("b.db", [[3, Buffer.from([1])]]);
  expect(readGenMetadata(file, 3)).toEqual([]);
});

test("returns an empty array for a database that is not there", () => {
  expect(readGenMetadata(path.join(dir, "missing.db"), 0)).toEqual([]);
});

test("reports which backend it used", () => {
  expect(["bun", "node", "cli"]).toContain(sqliteBackend());
});
