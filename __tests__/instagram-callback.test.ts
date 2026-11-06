import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  auth: vi.fn(),
  workspaceMember: { findFirst: vi.fn() },
  instagramAccount: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  operationalEvent: { create: vi.fn() },
  canConnect: vi.fn(),
  getLongLivedToken: vi.fn(),
  getUserInfo: vi.fn(),
  subscribe: vi.fn(),
  encryptToken: vi.fn(),
  exchangeCode: vi.fn(),
  verifyState: vi.fn(),
  canManage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: state.auth }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspaceMember: state.workspaceMember,
    instagramAccount: state.instagramAccount,
    operationalEvent: state.operationalEvent,
  },
}));
vi.mock("@/lib/env", () => ({
  getBaseUrl: () => "https://example.test",
}));
vi.mock("@/lib/instagram-accounts", () => ({
  canConnectInstagramAccount: state.canConnect,
}));
vi.mock("@/lib/meta/client", () => ({
  getLongLivedToken: state.getLongLivedToken,
  getUserInfo: state.getUserInfo,
  isProfessionalInstagramAccount: (user: { account_type?: string }) =>
    user.account_type !== "PERSONAL",
  subscribeInstagramAccountToWebhooks: state.subscribe,
}));
vi.mock("@/lib/meta/oauth", () => ({
  encryptToken: state.encryptToken,
  exchangeCodeForToken: state.exchangeCode,
  verifyOAuthState: state.verifyState,
}));
vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: state.canManage,
}));

import { GET } from "../app/api/instagram/callback/route";

function request() {
  return new NextRequest(
    "https://example.test/api/instagram/callback?code=code123&state=state123"
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.verifyState.mockReturnValue({ workspaceId: "ws_1" });
  state.auth.mockResolvedValue({ user: { id: "user_1" } });
  state.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" });
  state.canManage.mockReturnValue(true);
  state.exchangeCode.mockResolvedValue({ accessToken: "short_token" });
  state.getLongLivedToken.mockResolvedValue({
    accessToken: "long_token",
    expiresIn: 5184000,
  });
  state.subscribe.mockResolvedValue({ success: true });
  state.canConnect.mockResolvedValue({ allowed: true, reason: null });
  state.encryptToken.mockReturnValue("encrypted_token");
  state.instagramAccount.findUnique.mockResolvedValue(null);
  state.instagramAccount.updateMany.mockResolvedValue({ count: 0 });
  state.instagramAccount.create.mockResolvedValue({});
  state.operationalEvent.create.mockResolvedValue({});
});

describe("Instagram connect callback — personal accounts", () => {
  it("rejects a personal account before storing anything", async () => {
    state.getUserInfo.mockResolvedValue({
      id: "1",
      user_id: "100",
      username: "someone",
      account_type: "PERSONAL",
    });

    const response = await GET(request());

    expect(response.headers.get("location")).toBe(
      "https://example.test/settings?instagram=personal_account"
    );
    expect(state.canConnect).not.toHaveBeenCalled();
    expect(state.instagramAccount.create).not.toHaveBeenCalled();
    expect(state.subscribe).not.toHaveBeenCalled();
  });

  it("connects a Business account", async () => {
    state.getUserInfo.mockResolvedValue({
      id: "1",
      user_id: "100",
      username: "someone",
      account_type: "BUSINESS",
    });

    const response = await GET(request());

    expect(response.headers.get("location")).toBe(
      "https://example.test/dashboard?connected=true"
    );
    expect(state.instagramAccount.create).toHaveBeenCalled();
  });

  it("connects a Creator account", async () => {
    state.getUserInfo.mockResolvedValue({
      id: "1",
      user_id: "100",
      username: "someone",
      account_type: "CREATOR",
    });

    const response = await GET(request());

    expect(response.headers.get("location")).toBe(
      "https://example.test/dashboard?connected=true"
    );
    expect(state.instagramAccount.create).toHaveBeenCalled();
  });

  it("fails open when Meta does not return an account type", async () => {
    state.getUserInfo.mockResolvedValue({
      id: "1",
      user_id: "100",
      username: "someone",
    });

    const response = await GET(request());

    expect(response.headers.get("location")).toBe(
      "https://example.test/dashboard?connected=true"
    );
    expect(state.instagramAccount.create).toHaveBeenCalled();
  });
});
