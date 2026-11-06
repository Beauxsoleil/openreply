/**
 * Seed idempotency on a real Postgres database.
 *
 * Run with your OWN test database (never the shared openreply_test one):
 *
 *   createdb openreply_test_demo
 *   TEST_DATABASE_URL=<redacted> npm test -- demo-mode-seed
 *
 * Uses a throwaway schema inside that database, applies every migration in
 * prisma/migrations, and drops the schema afterwards — the same pattern as
 * __tests__/integrations.db.test.ts.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));

import { seedDemo } from "../prisma/seed-demo";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `demo_seed_${randomBytes(4).toString("hex")}`;
let sql: Client;

async function counts() {
  const [users, workspaces, accounts, campaigns, logs] = await Promise.all([
    state.db.user.count({ where: { email: "demo@example.test" } }),
    state.db.workspace.count({ where: { name: "Demo workspace" } }),
    state.db.instagramAccount.count({
      where: { instagramId: "demo-instagram-account" },
    }),
    state.db.automation.count({
      where: { name: { in: ["Free Guide", "Pricing info", "Free checklist"] } },
    }),
    state.db.dmLog.count({ where: { isDemo: true } }),
  ]);
  return { users, workspaces, accounts, campaigns, logs };
}

describe.skipIf(!databaseUrl)("demo seed idempotency on real PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      await sql.query(readFileSync(path.join(root, dir.name, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("running the seed twice creates the same rows", async () => {
    await seedDemo();
    const first = await counts();
    expect(first).toEqual({
      users: 1,
      workspaces: 1,
      accounts: 1,
      campaigns: 3,
      logs: 0,
    });

    await seedDemo();
    expect(await counts()).toEqual(first);
  });

  it("seeds a demo account with no real credential", async () => {
    await seedDemo();
    const account = await state.db.instagramAccount.findUniqueOrThrow({
      where: { instagramId: "demo-instagram-account" },
    });
    expect(account.isDemo).toBe(true);
    expect(account.accessToken).toBe("DEMO_NO_REAL_TOKEN");
    expect(account.username).toBe("demo-brand");
  });
});
