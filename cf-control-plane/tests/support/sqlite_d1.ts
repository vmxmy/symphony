import { readFileSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";

type BoundValue = string | number | null;

type D1LikeStatement = {
  bind: (...params: BoundValue[]) => D1LikeStatement;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
  run: () => Promise<{ meta: { changes: number; last_row_id: number } }>;
};

export function createMigratedDatabase(): Database {
  const db = new Database(":memory:");
  const migrations = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  return db;
}

export function asD1(db: Database): D1Database {
  return {
    prepare(sql: string): D1LikeStatement {
      let bound: BoundValue[] = [];
      const statement = db.query(sql);
      const d1Statement: D1LikeStatement = {
        bind(...params: BoundValue[]) {
          bound = params;
          return d1Statement;
        },
        async first<T = unknown>() {
          return (statement.get(...bound) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...bound) as T[] };
        },
        async run() {
          const r = statement.run(...bound);
          return {
            meta: {
              changes: r.changes,
              last_row_id: Number(r.lastInsertRowid),
            },
          };
        },
      };
      return d1Statement;
    },
  } as unknown as D1Database;
}
