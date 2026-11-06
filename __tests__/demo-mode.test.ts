import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockPrisma, mockGetCurrentWorkspaceId } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findUnique: vi.fn() },
    dmLog: { create: vi.fn() },
  },
  mockGetCurrentWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: mockGetCurrentWorkspaceId,
}));

import { isDemoMode } from "../lib/env";
import {
  assertNotDemoSend,
  isDemoAccount,
  DEMO_TOKEN_PLACEHOLDER,
  DEMO_REFUSAL_MESSAGE,
} from "../lib/demo";
import { sendDirectMessage } from "../lib/instagram/send-messages";
import { POST } from "../app/api/demo/simulate-comment/route";

const demoCampaign = {
  id: "camp-1",
  workspaceId: "ws-1",
  keywords: ["guide"],
  matchAnyWord: false,
  wholeWordMatch: true,
  dmMessage: "Hey {username}! Here's your guide.",
  instagramAccountId: "acc-1",
  instagramAccount: { id: "acc-1", username: "demo-brand", isDemo: true },
};

function postSimulate(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/demo/simulate-comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mockGetCurrentWorkspaceId.mockResolvedValue("ws-1");
  mockPrisma.automation.findUnique.mockResolvedValue(demoCampaign);
  mockPrisma.dmLog.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "log-1",
    ...data,
  }));
});

describe("isDemoMode flag parsing", () => {
  it("is off when DEMO_MODE is unset", () => {
    expect(isDemoMode()).toBe(false);
  });

  it("accepts 1 and true", () => {
    vi.stubEnv("DEMO_MODE", "1");
    expect(isDemoMode()).toBe(true);
    vi.stubEnv("DEMO_MODE", "true");
    expect(isDemoMode()).toBe(true);
    vi.stubEnv("DEMO_MODE", "TRUE");
    expect(isDemoMode()).toBe(true);
  });

  it("rejects 0, false, and other values", () => {
    for (const value of ["0", "false", "yes", "on", ""]) {
      vi.stubEnv("DEMO_MODE", value);
      expect(isDemoMode()).toBe(false);
    }
  });
});

describe("simulate-comment endpoint gating", () => {
  it("returns 404 when DEMO_MODE is off", async () => {
    vi.stubEnv("DEMO_MODE", "0");
    const res = await postSimulate({
      campaignId: "camp-1",
      commentText: "send me the guide!",
      username: "demo-fan",
    });
    expect(res.status).toBe(404);
    // Never reaches auth or the database while off.
    expect(mockGetCurrentWorkspaceId).not.toHaveBeenCalled();
    expect(mockPrisma.automation.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when demo mode is on but there is no session", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    mockGetCurrentWorkspaceId.mockResolvedValue(null);
    const res = await postSimulate({
      campaignId: "camp-1",
      commentText: "send me the guide!",
      username: "demo-fan",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a campaign in another workspace", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    mockPrisma.automation.findUnique.mockResolvedValue({
      ...demoCampaign,
      workspaceId: "ws-other",
    });
    const res = await postSimulate({
      campaignId: "camp-1",
      commentText: "send me the guide!",
      username: "demo-fan",
    });
    expect(res.status).toBe(404);
  });
});

describe("simulate-comment keyword matching (real matcher)", () => {
  it("matches a keyword and returns the DM that would be sent", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    const res = await postSimulate({
      campaignId: "camp-1",
      commentText: "please send me the GUIDE!",
      username: "demo-fan",
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.data.matched).toBe(true);
    expect(payload.data.matchedKeyword).toBe("guide");
    expect(payload.data.dmText).toBe("Hey demo-fan! Here's your guide.");
    expect(payload.data.simulated).toBe(true);
    expect(payload.data.isDemo).toBe(true);
    // Logged as a simulated SENT row — never enqueued, never sent.
    expect(mockPrisma.dmLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SENT",
          isDemo: true,
          matchedKeyword: "guide",
          commentText: "please send me the GUIDE!",
        }),
      })
    );
  });

  it("returns a no-match result and logs it as simulated", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    const res = await postSimulate({
      campaignId: "camp-1",
      commentText: "nice photo!",
      username: "demo-fan",
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.matched).toBe(false);
    expect(payload.data.matchedKeyword).toBeNull();
    expect(payload.data.dmText).toBeNull();
    expect(mockPrisma.dmLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_NO_MATCH",
          isDemo: true,
        }),
      })
    );
  });

  it("does not match a partial word when whole-word matching is on", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    const res = await postSimulate({
      campaignId: "camp-1",
      commentText: "I need guidance here",
      username: "demo-fan",
    });
    const payload = await res.json();
    expect(payload.data.matched).toBe(false);
  });
});

describe("send-path guard", () => {
  it("flags a demo account by isDemo and by placeholder token", () => {
    expect(isDemoAccount({ isDemo: true, accessToken: "whatever" })).toBe(true);
    expect(
      isDemoAccount({ isDemo: false, accessToken: DEMO_TOKEN_PLACEHOLDER })
    ).toBe(true);
    expect(isDemoAccount({ isDemo: false, accessToken: "real-token" })).toBe(
      false
    );
    expect(isDemoAccount(null)).toBe(false);
    expect(isDemoAccount(undefined)).toBe(false);
  });

  it("refuses to send for a demo account", () => {
    expect(() =>
      assertNotDemoSend({ isDemo: true, accessToken: "whatever" })
    ).toThrow(DEMO_REFUSAL_MESSAGE);
    expect(() =>
      assertNotDemoSend({ isDemo: false, accessToken: DEMO_TOKEN_PLACEHOLDER })
    ).toThrow(DEMO_REFUSAL_MESSAGE);
  });

  it("refuses to send for any account while DEMO_MODE=1", () => {
    vi.stubEnv("DEMO_MODE", "1");
    expect(() =>
      assertNotDemoSend({ isDemo: false, accessToken: "real-token" })
    ).toThrow(DEMO_REFUSAL_MESSAGE);
  });

  it("allows a real account when demo mode is off", () => {
    vi.stubEnv("DEMO_MODE", "0");
    expect(() =>
      assertNotDemoSend({ isDemo: false, accessToken: "real-token" })
    ).not.toThrow();
  });

  it("refuses at the send layer when the context carries the demo token", async () => {
    await expect(
      sendDirectMessage({
        context: { provider: "META", accessToken: DEMO_TOKEN_PLACEHOLDER },
        instagramAccountId: "demo-instagram-account",
        userId: "someone",
        message: "hello",
      })
    ).rejects.toThrow(DEMO_REFUSAL_MESSAGE);
  });
});
