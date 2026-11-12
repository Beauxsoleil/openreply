/**
 * OperationalEvent growth monitoring.
 *
 * The November 2026 flood wrote ~2.3M OperationalEvent rows in six days
 * (~300/minute) before anyone noticed, because nothing watched the table's
 * growth rate. This check counts rows written in the last hour and trips
 * `warning` / `critical` at tunable thresholds. It is wired into
 * /api/health, so an uptime monitor on the health endpoint alerts when the
 * error log starts flooding again.
 *
 * Normal volume is a handful of rows per hour (sweep summaries, token
 * refreshes, the odd failure), so the defaults — warn at 500/hour,
 * critical at 5,000/hour — leave wide headroom while still catching a
 * flood within the hour.
 */

import type { PrismaClient } from "@/app/generated/prisma/client";

export type OperationalEventGrowthStatus = "ok" | "warning" | "critical";

export interface OperationalEventGrowth {
  status: OperationalEventGrowthStatus;
  rowsLastHour: number;
  workerErrorRowsLastHour: number;
  totalRows: number;
  detail: string;
}

export interface GrowthThresholds {
  warnPerHour?: number;
  criticalPerHour?: number;
}

type OperationalEventCounter = Pick<
  PrismaClient["operationalEvent"],
  "count"
>;

export const DEFAULT_GROWTH_WARN_PER_HOUR = 500;
export const DEFAULT_GROWTH_CRITICAL_PER_HOUR = 5000;

export async function checkOperationalEventGrowth(
  client: { operationalEvent: OperationalEventCounter },
  thresholds: GrowthThresholds = {}
): Promise<OperationalEventGrowth> {
  const warn =
    thresholds.warnPerHour ??
    Number(
      process.env.OPERATIONAL_EVENT_GROWTH_WARN_PER_HOUR ??
        DEFAULT_GROWTH_WARN_PER_HOUR
    );
  const critical =
    thresholds.criticalPerHour ??
    Number(
      process.env.OPERATIONAL_EVENT_GROWTH_CRITICAL_PER_HOUR ??
        DEFAULT_GROWTH_CRITICAL_PER_HOUR
    );

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [rowsLastHour, workerErrorRowsLastHour, totalRows] = await Promise.all([
    client.operationalEvent.count({ where: { createdAt: { gt: since } } }),
    client.operationalEvent.count({
      where: {
        createdAt: { gt: since },
        source: "WORKER",
        level: "ERROR",
      },
    }),
    client.operationalEvent.count(),
  ]);

  const status: OperationalEventGrowthStatus =
    rowsLastHour >= critical
      ? "critical"
      : rowsLastHour >= warn
        ? "warning"
        : "ok";
  const detail =
    `${rowsLastHour} OperationalEvent rows in the last hour ` +
    `(${workerErrorRowsLastHour} WORKER/ERROR), ${totalRows} total`;
  return { status, rowsLastHour, workerErrorRowsLastHour, totalRows, detail };
}
