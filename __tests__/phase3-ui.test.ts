import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockGetCurrentWorkspaceId } = vi.hoisted(() => {
  const mockPrisma = {
    automation: {
      findFirst: vi.fn(),
    },
    dmLog: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    linkClick: {
      findMany: vi.fn(),
    },
  };
  return { mockPrisma, mockGetCurrentWorkspaceId: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: mockGetCurrentWorkspaceId,
}));

import { GET as getCampaign } from "../app/api/campaigns/[id]/route";
import { GET as getLogs } from "../app/api/logs/route";

const campaignRow = {
  id: "campaign_1",
  workspaceId: "workspace_1",
  name: "Example",
  reportShareSlug: "report-slug",
  instagramAccount: { username: "brand", instagramId: "ig_1" },
  _count: { dmLogs: 3 },
  trackedLinks: [
    {
      id: "link_1",
      slug: "abc",
      label: "Open link",
      destinationUrl: "https://example.test/offer",
      _count: { clicks: 1 },
    },
  ],
};

function campaignRequest(id: string) {
  return new NextRequest(`https://example.com/api/campaigns/${id}`);
}

describe("GET /api/campaigns/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceId.mockResolvedValue("workspace_1");
    mockPrisma.automation.findFirst.mockResolvedValue(campaignRow);
    mockPrisma.dmLog.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
      by.includes("matchedKeyword")
        ? [
            {
              automationId: "campaign_1",
              matchedKeyword: "LINK",
              _count: { _all: 2 },
            },
          ]
        : [
            { automationId: "campaign_1", status: "SENT", _count: { _all: 2 } },
            { automationId: "campaign_1", status: "FAILED", _count: { _all: 1 } },
          ]
    );
    mockPrisma.linkClick.findMany.mockResolvedValue([
      { id: "click_1", automationId: "campaign_1", recipientHash: "r1", ipHash: null },
    ]);
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        id: "log_1",
        commenterName: "jane",
        commentText: "LINK please",
        status: "FAILED",
        errorMessage: "24-hour window expired",
        createdAt: new Date("2026-11-04T10:00:00Z"),
      },
    ]);
  });

  it("returns one campaign with analytics and recent logs", async () => {
    const res = await getCampaign(campaignRequest("campaign_1"), {
      params: Promise.resolve({ id: "campaign_1" }),
    });
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.id).toBe("campaign_1");
    expect(payload.data.analytics).toMatchObject({
      sent: 2,
      failed: 1,
      clicks: 1,
      ctr: 50,
    });
    expect(payload.data.analytics.topKeywords).toEqual([
      { keyword: "LINK", count: 2 },
    ]);
    expect(payload.data.trackedLinks[0].trackedUrl).toContain("/r/abc");
    expect(payload.data.reportUrl).toContain("/reports/report-slug");
    expect(payload.data.recentLogs).toHaveLength(1);
    expect(payload.data.recentLogs[0].errorMessage).toBe(
      "24-hour window expired"
    );
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "campaign_1", workspaceId: "workspace_1" },
      })
    );
  });

  it("returns 404 when the campaign belongs to another workspace", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    const res = await getCampaign(campaignRequest("campaign_1"), {
      params: Promise.resolve({ id: "campaign_1" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).success).toBe(false);
  });

  it("returns 401 without a workspace", async () => {
    mockGetCurrentWorkspaceId.mockResolvedValue(null);
    const res = await getCampaign(campaignRequest("campaign_1"), {
      params: Promise.resolve({ id: "campaign_1" }),
    });
    expect(res.status).toBe(401);
  });
});

function logsRequest(query: string) {
  return new NextRequest(`https://example.com/api/logs${query}`);
}

describe("GET /api/logs filters and CSV export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceId.mockResolvedValue("workspace_1");
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    mockPrisma.dmLog.count.mockResolvedValue(0);
  });

  it("passes text search and date range through to the query", async () => {
    const res = await getLogs(
      logsRequest("?q=LINK&from=2026-11-01&to=2026-11-05&status=FAILED")
    );
    expect(res.status).toBe(200);
    const where = mockPrisma.dmLog.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { commentText: { contains: "LINK", mode: "insensitive" } },
      { commenterName: { contains: "LINK", mode: "insensitive" } },
    ]);
    expect(where.createdAt.gte).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(where.createdAt.lte).toEqual(new Date("2026-11-05T23:59:59.999Z"));
    expect(where.status).toBe("FAILED");
  });

  it("exports the filtered set as CSV including the error message", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-11-04T10:00:00Z"),
        commenterName: "jane",
        commentText: 'LINK "please"',
        status: "FAILED",
        errorMessage: "24-hour window expired",
        automation: { name: "Example" },
        instagramAccount: { username: "brand" },
      },
    ]);
    const res = await getLogs(logsRequest("?format=csv&status=FAILED"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("dm-logs.csv");
    const text = await res.text();
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "createdAt,commenterName,commentText,campaign,account,status,errorMessage"
    );
    expect(lines[1]).toContain('"LINK ""please"""');
    expect(lines[1]).toContain("24-hour window expired");
    expect(lines[1]).toContain("FAILED");
  });

  it("returns 401 without a workspace", async () => {
    mockGetCurrentWorkspaceId.mockResolvedValue(null);
    const res = await getLogs(logsRequest(""));
    expect(res.status).toBe(401);
  });
});
