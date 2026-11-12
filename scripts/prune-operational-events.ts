/**
 * OperationalEvent retention prune (manual job — never automatic).
 *
 * Dry-run by default: reports how many rows match the retention policy
 * without deleting anything.
 *
 *   npm run prune:operational-events
 *   npm run prune:operational-events -- --older-than-days 3 --max-rows 10000
 *
 * To actually delete, pass --apply AND set OPERATIONAL_EVENT_PRUNE_CONFIRM=1.
 * Only run after a verified Neon backup exists (see
 * docs/operational-event-retention.md).
 *
 *   OPERATIONAL_EVENT_PRUNE_CONFIRM=1 npm run prune:operational-events -- --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db/client";
import { pruneOperationalEvents } from "../lib/ops/prune-operational-events";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function argNumber(argv: string[], name: string): number | undefined {
  const value = argValue(argv, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  if (apply && process.env.OPERATIONAL_EVENT_PRUNE_CONFIRM !== "1") {
    console.error(
      "Refusing to delete: --apply requires OPERATIONAL_EVENT_PRUNE_CONFIRM=1.\n" +
        "Run without --apply for a dry-run, and back up Neon first (see docs/operational-event-retention.md)."
    );
    process.exitCode = 1;
    return;
  }

  const result = await pruneOperationalEvents(prisma, {
    redisFailureOlderThanDays: argNumber(argv, "--older-than-days"),
    resolvedOlderThanDays: argNumber(argv, "--resolved-older-than-days"),
    batchSize: argNumber(argv, "--batch-size"),
    maxRows: argNumber(argv, "--max-rows"),
    dryRun: !apply,
    sleepMsBetweenBatches: argNumber(argv, "--sleep-ms"),
  });

  if (result.dryRun) {
    console.log(
      `Dry-run: ${result.wouldDelete} OperationalEvent rows match the retention policy` +
        (result.stoppedEarly ? " (capped by --max-rows; re-run to count more)" : "") +
        ".\nNothing was deleted. Add --apply with OPERATIONAL_EVENT_PRUNE_CONFIRM=1 to delete."
    );
  } else {
    console.log(
      `Deleted ${result.deleted} OperationalEvent rows in ${result.batches} batches` +
        (result.stoppedEarly ? " (stopped at --max-rows; re-run to continue)" : "") +
        "."
    );
  }
}

main()
  .catch((error) => {
    console.error(
      "Prune failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
