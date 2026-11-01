import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { sqlTransaction } from "../sqlite.js";

test("sqlTransaction rethrows the operation error when rollback fails", () => {
  const db = new DatabaseSync(":memory:");
  const original = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (sql === "ROLLBACK") throw new Error("rollback failed");
    return original(sql);
  };
  assert.throws(
    () =>
      sqlTransaction(db, () => {
        throw new Error("operation failed");
      }),
    (error: unknown) => error instanceof Error && error.message === "operation failed",
  );
});

test("sqlTransaction commits successful work", () => {
  const dir = mkdtempSync(join(tmpdir(), "ml-sqlite-"));
  const path = join(dir, "ledger.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE t (n INTEGER)");
    sqlTransaction(db, () => {
      db.prepare("INSERT INTO t VALUES (1)").run();
    });
    assert.equal(db.prepare("SELECT n FROM t").get()?.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
