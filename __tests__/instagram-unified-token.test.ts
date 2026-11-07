import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => {
  class MetaApiError extends Error {}
  class PermissionError extends MetaApiError {}
  return {
    MetaApiError,
    PermissionError,
    context: vi.fn(),
    upsert: vi.fn(),
    eventCreate: vi.fn(),
    listAssigned: vi.fn(),
    getUserInfo: vi.fn(),
    subscribe: vi.fn(),
    canConnect: vi.fn(),
    encrypt: vi.fn(),
  };
});

vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role),
  getCurrentWorkspaceContext: state.context,
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: { upsert: state.upsert },
    operationalEvent: { create: state.eventCreate },
  },
}));

vi.mock("@/lib/meta/client", () => ({
  listAssignedInstagramAccounts: state.listAssigned,
  getUserInfo: state.getUserInfo,
  // Same rule as the real helper: only PERSONAL is rejected; a missing
  // account_type fails open.
  isProfessionalInstagramAccount: (user: { account_type?: string }) =>
    user.account_type === undefined || user.account_type !== "PERSONAL",
  subscribeInstagramAccountToWebhooks: state.subscribe,
  MetaApiError: state.MetaApiError,
  PermissionError: state.PermissionError,
}));

vi.mock("@/lib/meta/oauth", () => ({
  encryptToken: state.encrypt,
}));

vi.mock("@/lib/instagram-accounts", () => ({
  canConnectInstagramAccount: state.canConnect,
}));

import { POST } from "../app/api/instagram/unified-token/route";

const TOKEN = "SUAT-TOKEN-FROM-META";
const IG_ID = "17841404707268563";

function request(body: Record<string, unknown>) {
  return new NextRequest(
    "https://example.test/api/instagram/unified-token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.context.mockResolvedValue({ workspaceId: "ws_1", role: "ADMIN" });
  state.listAssigned.mockResolvedValue([
    { id: IG_ID, username: "beaux_viola" },
  ]);
  state.getUserInfo.mockResolvedValue({
    id: IG_ID,
    user_id: IG_ID,
    username: "beaux_viola",
    account_type: "CREATOR",
  });
  state.subscribe.mockResolvedValue({ success: true });
  state.canConnect.mockResolvedValue({ allowed: true, reason: null });
  state.encrypt.mockImplementation((token: string) => `enc:${token}`);
  state.upsert.mockResolvedValue({
    id: "acc_1",
    username: "beaux_viola",
    instagramId: IG_ID,
    webhookSubscribed: true,
  });
  state.eventCreate.mockResolvedValue({});
});

describe("POST /api/instagram/unified-token", () => {
  it("requires a signed-in workspace member", async () => {
    state.context.mockResolvedValue(null);

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error).toBe("unauthorized");
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("requires an owner or admin role", async () => {
    state.context.mockResolvedValue({ workspaceId: "ws_1", role: "MEMBER" });

    const response = await POST(request({ token: TOKEN }));

    expect(response.status).toBe(403);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("rejects a missing or blank token without calling Meta", async () => {
    for (const body of [{}, { token: "" }, { token: "   " }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("missing_token");
    }
    expect(state.listAssigned).not.toHaveBeenCalled();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("returns a friendly error when Meta rejects the token, without leaking it", async () => {
    state.listAssigned.mockRejectedValue(
      new state.PermissionError("bad token")
    );

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("meta_error");
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(state.upsert).not.toHaveBeenCalled();
    // The failure is recorded for Diagnostics; the token is not in it.
    expect(state.eventCreate).toHaveBeenCalled();
    expect(JSON.stringify(state.eventCreate.mock.calls)).not.toContain(TOKEN);
  });

  it("rejects a token linked to no Instagram account", async () => {
    state.listAssigned.mockResolvedValue([]);

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("no_instagram_accounts");
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("asks the user to pick when the token covers several accounts", async () => {
    state.listAssigned.mockResolvedValue([
      { id: IG_ID, username: "beaux_viola" },
      { id: "17841404707268564", username: "second_account" },
    ]);

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("multiple_accounts");
    expect(payload.accounts).toEqual([
      { id: IG_ID, username: "beaux_viola" },
      { id: "17841404707268564", username: "second_account" },
    ]);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("connects the selected account when several are covered", async () => {
    state.listAssigned.mockResolvedValue([
      { id: IG_ID, username: "beaux_viola" },
      { id: "17841404707268564", username: "second_account" },
    ]);
    state.getUserInfo.mockResolvedValue({
      id: "17841404707268564",
      user_id: "17841404707268564",
      username: "second_account",
      account_type: "BUSINESS",
    });

    const response = await POST(
      request({ token: TOKEN, instagramId: "17841404707268564" })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(state.getUserInfo).toHaveBeenCalledWith(
      TOKEN,
      "17841404707268564",
      "facebook"
    );
    expect(state.upsert).toHaveBeenCalled();
  });

  it("rejects an unknown selected account without calling Meta further", async () => {
    const response = await POST(request({ token: TOKEN, instagramId: "999" }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("account_not_found");
    expect(payload.accounts).toEqual([
      { id: IG_ID, username: "beaux_viola" },
    ]);
    expect(state.getUserInfo).not.toHaveBeenCalled();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("rejects personal accounts, like the Instagram Login callback", async () => {
    state.getUserInfo.mockResolvedValue({
      id: IG_ID,
      user_id: IG_ID,
      username: "beaux_viola",
      account_type: "PERSONAL",
    });

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("personal_account");
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("connects when Meta returns no account_type (fails open)", async () => {
    // graph.facebook.com's Instagram node has no account_type field, so
    // getUserInfo on the facebook host never returns one. The connect
    // must still succeed: the professional-account check fails open on
    // an absent account_type, and Unified Login only issues tokens for
    // professional accounts.
    state.getUserInfo.mockResolvedValue({
      id: IG_ID,
      user_id: IG_ID,
      username: "beaux_viola",
      name: "Joel Viola",
      followers_count: 472,
    });

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(state.upsert).toHaveBeenCalled();
  });

  it("rejects an account already connected elsewhere", async () => {
    state.canConnect.mockResolvedValue({
      allowed: false,
      reason: "already_connected",
    });

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("already_connected");
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("stores the token encrypted, never-expiring, and never returns it", async () => {
    const response = await POST(request({ token: `  ${TOKEN}  ` }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      success: true,
      data: {
        id: "acc_1",
        username: "beaux_viola",
        instagramId: IG_ID,
        webhookSubscribed: true,
        isUnifiedLogin: true,
      },
    });
    // The raw token appears nowhere in the response.
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    // The token is trimmed before verification and stored encrypted.
    expect(state.encrypt).toHaveBeenCalledWith(TOKEN);
    expect(state.getUserInfo).toHaveBeenCalledWith(
      TOKEN,
      IG_ID,
      "facebook"
    );
    expect(state.subscribe).toHaveBeenCalledWith(IG_ID, TOKEN, "facebook");
    expect(state.upsert).toHaveBeenCalledWith({
      where: { instagramId: IG_ID },
      update: expect.objectContaining({
        accessToken: `enc:${TOKEN}`,
        tokenExpiresAt: null,
        webhookSubscribed: true,
        provider: "META",
        workspaceId: "ws_1",
        isUnifiedLogin: true,
      }),
      create: expect.objectContaining({
        instagramId: IG_ID,
        accessToken: `enc:${TOKEN}`,
        tokenExpiresAt: null,
        isUnifiedLogin: true,
      }),
    });
    // Nothing passed to the database carries the raw token.
    expect(JSON.stringify(state.upsert.mock.calls)).not.toContain(
      `"accessToken":"${TOKEN}"`
    );
  });

  it("still connects when webhook subscription fails, marked pending", async () => {
    state.subscribe.mockRejectedValue(new Error("subscribe failed"));
    state.upsert.mockResolvedValue({
      id: "acc_1",
      username: "beaux_viola",
      instagramId: IG_ID,
      webhookSubscribed: false,
    });

    const response = await POST(request({ token: TOKEN }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ webhookSubscribed: false }),
      })
    );
  });
});
