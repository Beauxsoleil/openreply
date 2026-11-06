import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  workspaceId: vi.fn(),
  getAccount: vi.fn(),
  windowStatus: vi.fn(),
  isConfirmed: vi.fn(),
  sendDM: vi.fn(),
  createContext: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: state.workspaceId,
}));
vi.mock("@/lib/instagram-accounts", () => ({
  getWorkspaceInstagramAccount: state.getAccount,
}));
vi.mock("@/lib/instagram/messaging-window", () => ({
  getMessagingWindowStatus: state.windowStatus,
}));
vi.mock("@/lib/instagram/delivery-errors", () => ({
  isConfirmedSendRejection: state.isConfirmed,
}));
vi.mock("@/lib/instagram/provider", () => ({
  getConversations: vi.fn(),
  sendDirectMessage: state.sendDM,
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
  createInstagramContext: state.createContext,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: state.reserve,
  releaseDMSlot: state.release,
}));

import { POST } from "../app/api/instagram/conversations/route";

function request(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/instagram/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const account = { id: "row_1", instagramId: "ig_1", username: "test_account" };

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceId.mockResolvedValue("ws_1");
  state.getAccount.mockResolvedValue(account);
  state.windowStatus.mockResolvedValue({
    state: "unknown",
    lastInteractionAt: null,
  });
  state.reserve.mockResolvedValue({
    allowed: true,
    currentCount: 1,
    remainingDMs: 749,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  state.release.mockResolvedValue(0);
  state.createContext.mockResolvedValue({
    provider: "META",
    accessToken: "token",
  });
  state.sendDM.mockResolvedValue({ message_id: "m1" });
  state.isConfirmed.mockReturnValue(false);
});

describe("manual inbox send — rate limiting and messaging window", () => {
  it("sends when the window is unknown and a slot is available", async () => {
    const response = await POST(
      request({ recipientId: "user_1", text: "hello" })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(state.sendDM).toHaveBeenCalledTimes(1);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("returns 409 without sending when the window is known closed", async () => {
    state.windowStatus.mockResolvedValue({
      state: "closed",
      lastInteractionAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const response = await POST(
      request({ recipientId: "user_1", text: "hello" })
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatch(/24-hour messaging window/);
    expect(state.sendDM).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
  });

  it("returns 429 without sending when the hourly cap is reached", async () => {
    state.reserve.mockResolvedValue({
      allowed: false,
      currentCount: 750,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const response = await POST(
      request({ recipientId: "user_1", text: "hello" })
    );
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.error).toMatch(/hourly DM limit/);
    expect(state.sendDM).not.toHaveBeenCalled();
  });

  it("returns 503 when the rate limiter itself is unavailable", async () => {
    state.reserve.mockRejectedValue(new Error("Redis down"));

    const response = await POST(
      request({ recipientId: "user_1", text: "hello" })
    );

    expect(response.status).toBe(503);
    expect(state.sendDM).not.toHaveBeenCalled();
  });

  it("releases the slot when the send is a confirmed rejection", async () => {
    const { MetaApiError } = await import("@/lib/instagram/provider");
    state.sendDM.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Invalid recipient")
    );
    state.isConfirmed.mockReturnValue(true);

    const response = await POST(
      request({ recipientId: "user_1", text: "hello" })
    );

    expect(response.status).toBe(502);
    expect(state.release).toHaveBeenCalledWith("ig_1");
  });
});
