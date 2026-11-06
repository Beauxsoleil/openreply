import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicksBy,
  normalizeTopKeywords,
} from "@/lib/tracking/analytics";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { buildReportUrl } from "@/lib/reports/share";

// Per-campaign GET: one campaign (same shape as the list endpoint) plus its
// recent DM logs, so the detail page no longer fetches every campaign to
// show one, and can show which comments failed and why.
export const dynamic = "force-dynamic";

const RECENT_LOGS_LIMIT = 20;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = await params;

  const automation = await prisma.automation.findFirst({
    where: { id, workspaceId },
    include: {
      instagramAccount: {
        select: { username: true, instagramId: true },
      },
      _count: {
        select: { dmLogs: true },
      },
      trackedLinks: {
        select: {
          id: true,
          slug: true,
          label: true,
          destinationUrl: true,
          _count: { select: { clicks: true } },
        },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
  });

  if (!automation) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  const [statusCounts, clickRows, keywordCounts, recentLogs] =
    await Promise.all([
      prisma.dmLog.groupBy({
        by: ["automationId", "status"],
        where: { workspaceId, automationId: id },
        _count: { _all: true },
      }),
      prisma.linkClick.findMany({
        where: { workspaceId, automationId: id },
        select: CLICK_ROW_SELECT,
      }),
      prisma.dmLog.groupBy({
        by: ["automationId", "matchedKeyword"],
        where: { workspaceId, automationId: id, matchedKeyword: { not: null } },
        _count: { _all: true },
      }),
      prisma.dmLog.findMany({
        where: { workspaceId, automationId: id },
        orderBy: { createdAt: "desc" },
        take: RECENT_LOGS_LIMIT,
        select: {
          id: true,
          commenterName: true,
          commentText: true,
          status: true,
          errorMessage: true,
          createdAt: true,
        },
      }),
    ]);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of statusCounts) {
    const count = row._count._all;
    if (row.status === "SENT") sent += count;
    if (row.status === "FAILED") failed += count;
    if (row.status.startsWith("SKIPPED_")) skipped += count;
  }
  const clicks =
    countUniqueClicksBy(clickRows, (row) => row.automationId).get(id) ?? 0;
  const topKeywords = normalizeTopKeywords(
    keywordCounts.map((row) => ({
      matchedKeyword: row.matchedKeyword,
      _count: row._count._all,
    })),
    3
  );

  return NextResponse.json(
    {
      success: true,
      data: {
        ...automation,
        trackedLinks: automation.trackedLinks.map((link) => ({
          ...link,
          trackedUrl: buildTrackedUrl(link.slug),
        })),
        reportUrl: automation.reportShareSlug
          ? buildReportUrl(automation.reportShareSlug)
          : null,
        analytics: {
          sent,
          skipped,
          failed,
          clicks,
          ctr: calculateCtr(clicks, sent),
          topKeywords,
        },
        recentLogs,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
