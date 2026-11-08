/**
 * Publishing models migration, tested against a real Postgres.
 *
 * The migration adds MediaAsset, ScheduledPost and PublishAttempt plus the
 * PublishKind / PublishStatus enums. A unit test cannot catch a wrong FK
 * action, a missing index, or a mistyped column, so this suite applies the
 * migration files in order inside its own throwaway Postgres schema and
 * checks the resulting tables, then exercises the Prisma client against them.
 * Skipped without a database:
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres \
 *     npx vitest run __tests__/publishing-migration.db.test.ts
 *
 * Each run builds the schema from prisma/migrations inside its own throwaway
 * Postgres schema and drops it at the end, so it never touches existing data.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
const PUBLISHING_MIGRATION = "20261107184400_add_publishing_models";

const schema = `publishing_${randomBytes(4).toString("hex")}`;
let sql: Client;
let db: PrismaClient;

function migrationDirs() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(name: string) {
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

describe.skipIf(!DATABASE_URL)("publishing migration on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);

    const dirs = migrationDirs();
    expect(dirs).toContain(PUBLISHING_MIGRATION);
    for (const dir of dirs) {
      await sql.query(migrationSql(dir));
    }

    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema }),
    });

    await db.user.create({ data: { id: "pub-owner", email: "publishing@example.test" } });
    await db.workspace.create({ data: { id: "pub-ws", name: "pub", ownerId: "pub-owner" } });
    await db.instagramAccount.create({
      data: {
        id: "pub-acct", workspaceId: "pub-ws", instagramId: "pub-ig",
        username: "pub", accessToken: "local-only-secret",
      },
    });
    await db.automation.create({
      data: {
        id: "pub-campaign", workspaceId: "pub-ws", instagramAccountId: "pub-acct",
        name: "Publish campaign", keywords: ["LINK"], dmMessage: "Your link", isActive: true,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  describe("the migration", () => {
    it("creates the three publishing tables", async () => {
      const { rows } = await sql.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name IN ('MediaAsset', 'ScheduledPost', 'PublishAttempt')
         ORDER BY table_name`,
        [schema]
      );
      expect(rows.map((r) => r.table_name)).toEqual(["MediaAsset", "PublishAttempt", "ScheduledPost"]);
    });

    it("creates the PublishKind and PublishStatus enums with the expected values", async () => {
      const { rows } = await sql.query<{ typname: string; enumlabel: string }>(
        `SELECT t.typname, e.enumlabel
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE n.nspname = $1 AND t.typname IN ('PublishKind', 'PublishStatus')
         ORDER BY t.typname, e.enumsortorder`,
        [schema]
      );
      const labels = (name: string) => rows.filter((r) => r.typname === name).map((r) => r.enumlabel);
      expect(labels("PublishKind")).toEqual(["IMAGE", "REEL"]);
      expect(labels("PublishStatus")).toEqual([
        "DRAFT", "SCHEDULED", "PREPARING", "PUBLISHING", "PUBLISHED", "FAILED", "RECONCILE_REQUIRED", "CANCELED",
      ]);
    });

    it("gives MediaAsset a BIGINT byteSize and the workspace/storageKey unique key", async () => {
      const { rows } = await sql.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'MediaAsset' AND column_name IN ('byteSize', 'originalName', 'storageKey')
         ORDER BY column_name`,
        [schema]
      );
      expect(rows).toEqual([
        { column_name: "byteSize", data_type: "bigint", is_nullable: "NO" },
        { column_name: "originalName", data_type: "text", is_nullable: "YES" },
        { column_name: "storageKey", data_type: "text", is_nullable: "NO" },
      ]);
      const { rows: indexes } = await sql.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'MediaAsset' ORDER BY indexname`,
        [schema]
      );
      expect(indexes.map((r) => r.indexname)).toContain("MediaAsset_workspaceId_storageKey_key");
      expect(indexes.map((r) => r.indexname)).toContain("MediaAsset_workspaceId_createdAt_idx");
    });

    it("gives ScheduledPost the worker's due-posts index and the expected defaults", async () => {
      const { rows } = await sql.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
        `SELECT column_name, column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'ScheduledPost'
           AND column_name IN ('status', 'caption', 'timezone', 'attemptCount', 'automationActivateOnPublish', 'leaseUntil')
         ORDER BY column_name`,
        [schema]
      );
      expect(rows).toEqual([
        { column_name: "attemptCount", column_default: "0", is_nullable: "NO" },
        { column_name: "automationActivateOnPublish", column_default: "false", is_nullable: "NO" },
        { column_name: "caption", column_default: "''::text", is_nullable: "NO" },
        { column_name: "leaseUntil", column_default: null, is_nullable: "YES" },
        { column_name: "status", column_default: "'DRAFT'::\"PublishStatus\"", is_nullable: "NO" },
        { column_name: "timezone", column_default: "'UTC'::text", is_nullable: "NO" },
      ]);
      const { rows: indexes } = await sql.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'ScheduledPost' ORDER BY indexname`,
        [schema]
      );
      expect(indexes.map((r) => r.indexname)).toEqual([
        "ScheduledPost_instagramAccountId_scheduledAt_idx",
        "ScheduledPost_pkey",
        "ScheduledPost_status_scheduledAt_idx",
        "ScheduledPost_workspaceId_scheduledAt_idx",
      ]);
    });

    it("wires the foreign keys with the intended delete actions", async () => {
      const { rows } = await sql.query<{ table_name: string; constraint_name: string; delete_rule: string }>(
        `SELECT tc.table_name, tc.constraint_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
         WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_name IN ('MediaAsset', 'ScheduledPost', 'PublishAttempt')
         ORDER BY tc.table_name, tc.constraint_name`,
        [schema]
      );
      expect(rows).toEqual([
        { table_name: "MediaAsset", constraint_name: "MediaAsset_workspaceId_fkey", delete_rule: "CASCADE" },
        { table_name: "PublishAttempt", constraint_name: "PublishAttempt_postId_fkey", delete_rule: "CASCADE" },
        { table_name: "ScheduledPost", constraint_name: "ScheduledPost_automationId_fkey", delete_rule: "SET NULL" },
        { table_name: "ScheduledPost", constraint_name: "ScheduledPost_instagramAccountId_fkey", delete_rule: "CASCADE" },
        { table_name: "ScheduledPost", constraint_name: "ScheduledPost_mediaAssetId_fkey", delete_rule: "RESTRICT" },
        { table_name: "ScheduledPost", constraint_name: "ScheduledPost_workspaceId_fkey", delete_rule: "CASCADE" },
      ]);
    });
  });

  describe("reading and writing through Prisma", () => {
    it("round-trips a post, its media and an attempt, with byteSize as BigInt", async () => {
      const asset = await db.mediaAsset.create({
        data: {
          id: "pub-asset", workspaceId: "pub-ws", storageKey: "pub/photo.jpg",
          originalName: "photo.jpg", mimeType: "image/jpeg", byteSize: BigInt(123456789),
          width: 1080, height: 1350,
        },
      });
      expect(typeof asset.byteSize).toBe("bigint");
      expect(asset.byteSize).toBe(BigInt(123456789));

      const post = await db.scheduledPost.create({
        data: {
          id: "pub-post", workspaceId: "pub-ws", instagramAccountId: "pub-acct",
          mediaAssetId: "pub-asset", caption: "hello", kind: "IMAGE",
          status: "SCHEDULED", scheduledAt: new Date("2026-11-08T12:00:00Z"),
          timezone: "America/Boise", automationId: "pub-campaign",
          automationActivateOnPublish: true,
        },
      });
      expect(post.status).toBe("SCHEDULED");
      expect(post.attemptCount).toBe(0);
      expect(post.automationActivateOnPublish).toBe(true);

      const attempt = await db.publishAttempt.create({
        data: {
          id: "pub-attempt", postId: "pub-post", outcome: "success",
          details: { containerId: "1789" },
        },
      });
      expect(attempt.outcome).toBe("success");

      const read = await db.scheduledPost.findUniqueOrThrow({
        where: { id: "pub-post" },
        include: { mediaAsset: true, attempts: true },
      });
      expect(read.mediaAsset.byteSize).toBe(BigInt(123456789));
      expect(read.attempts).toHaveLength(1);
      expect(read.attempts[0].details).toEqual({ containerId: "1789" });

      const due = await db.scheduledPost.findMany({
        where: { status: "SCHEDULED", scheduledAt: { lte: new Date("2026-11-08T13:00:00Z") } },
      });
      expect(due.map((p) => p.id)).toEqual(["pub-post"]);
    });

    it("rejects a duplicate storageKey in the same workspace but allows it elsewhere", async () => {
      await expect(
        db.mediaAsset.create({
          data: {
            id: "pub-asset-dup", workspaceId: "pub-ws", storageKey: "pub/photo.jpg",
            mimeType: "image/jpeg", byteSize: BigInt(1),
          },
        })
      ).rejects.toThrow(/Unique constraint failed/);
      await db.workspace.create({ data: { id: "pub-ws-2", name: "other", ownerId: "pub-owner" } });
      const other = await db.mediaAsset.create({
        data: {
          id: "pub-asset-other", workspaceId: "pub-ws-2", storageKey: "pub/photo.jpg",
          mimeType: "image/jpeg", byteSize: BigInt(1),
        },
      });
      expect(other.workspaceId).toBe("pub-ws-2");
    });

    it("blocks deleting media still referenced by a post, and cascades attempts with the post", async () => {
      await expect(db.mediaAsset.delete({ where: { id: "pub-asset" } })).rejects.toThrow();
      expect(await db.mediaAsset.findUnique({ where: { id: "pub-asset" } })).not.toBeNull();

      await db.scheduledPost.delete({ where: { id: "pub-post" } });
      expect(await db.publishAttempt.count({ where: { postId: "pub-post" } })).toBe(0);
      await db.mediaAsset.delete({ where: { id: "pub-asset" } });
      expect(await db.mediaAsset.findUnique({ where: { id: "pub-asset" } })).toBeNull();
    });

    it("nulls the automation link when the campaign is deleted", async () => {
      const asset = await db.mediaAsset.create({
        data: {
          id: "pub-asset-2", workspaceId: "pub-ws", storageKey: "pub/photo2.jpg",
          mimeType: "image/jpeg", byteSize: BigInt(2),
        },
      });
      const post = await db.scheduledPost.create({
        data: {
          id: "pub-post-2", workspaceId: "pub-ws", instagramAccountId: "pub-acct",
          mediaAssetId: asset.id, kind: "REEL", automationId: "pub-campaign",
        },
      });
      expect(post.automationId).toBe("pub-campaign");
      await db.automation.delete({ where: { id: "pub-campaign" } });
      const after = await db.scheduledPost.findUniqueOrThrow({ where: { id: "pub-post-2" } });
      expect(after.automationId).toBeNull();
      expect(after.automationActivateOnPublish).toBe(false);
    });
  });
});
