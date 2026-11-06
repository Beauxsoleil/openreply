import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { DmStatus } from "@/app/generated/prisma/client";

const CSV_EXPORT_LIMIT = 1000;

function csvCell(value: string | null): string {
  const text = value ?? "";
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10))
  );
  const status = searchParams.get("status");
  const instagramAccountId = searchParams.get("instagramAccountId");
  const skip = (page - 1) * limit;
  const parsedStatus =
    status && Object.values(DmStatus).includes(status as DmStatus)
      ? (status as DmStatus)
      : null;

  // Text search across comment text and commenter name.
  const q = searchParams.get("q")?.trim() || null;
  // Inclusive date range on createdAt (YYYY-MM-DD, local calendar dates).
  const fromRaw = searchParams.get("from");
  const toRaw = searchParams.get("to");
  const from = fromRaw ? new Date(`${fromRaw}T00:00:00.000Z`) : null;
  const to = toRaw ? new Date(`${toRaw}T23:59:59.999Z`) : null;
  const createdAt =
    from && !Number.isNaN(from.getTime()) && to && !Number.isNaN(to.getTime())
      ? { gte: from, lte: to }
      : from && !Number.isNaN(from.getTime())
        ? { gte: from }
        : to && !Number.isNaN(to.getTime())
          ? { lte: to }
          : undefined;

  const where = {
    workspaceId,
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {}),
    ...(q
      ? {
          OR: [
            { commentText: { contains: q, mode: "insensitive" as const } },
            { commenterName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  // CSV export: the filtered set (paged table stays JSON).
  if (searchParams.get("format") === "csv") {
    const rows = await prisma.dmLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: CSV_EXPORT_LIMIT,
      include: {
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    });
    const header = [
      "createdAt",
      "commenterName",
      "commentText",
      "campaign",
      "account",
      "status",
      "errorMessage",
    ].join(",");
    const lines = rows.map((row) =>
      [
        row.createdAt.toISOString(),
        csvCell(row.commenterName),
        csvCell(row.commentText),
        csvCell(row.automation.name),
        csvCell(row.instagramAccount.username),
        row.status,
        csvCell(row.errorMessage),
      ].join(",")
    );
    return new NextResponse([header, ...lines].join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dm-logs.csv"',
      },
    });
  }

  const [logs, total] = await Promise.all([
    prisma.dmLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        automation: { select: { name: true, keywords: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.dmLog.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
}
