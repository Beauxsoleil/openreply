import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  accounts: { findMany: vi.fn() },
  webhookEvent: { create: vi.fn(), update: vi.fn() },
  dmLog: { findMany: vi.fn() },
  queueAdd: vi.fn(),
  recordInteraction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: state.accounts,
    webhookEvent: state.webhookEvent,
    dmLog: state.dmLog,
  },
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: state.queueAdd }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));

vi.mock("@/lib/instagram/messaging-window", () => ({
  recordRecipientInteraction: state.recordInteraction,
}));

import { processInstagramWebhook } from "../lib/queue/process-webhook";
import type { parseCommentEvents } from "../lib/meta/webhook";

type WebhookEntry = Parameters<typeof parseCommentEvents>[0]["entry"][number];

function payload(entry: WebhookEntry) {
  return { object: "instagram", entry: [entry] };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.accounts.findMany.mockResolvedValue([
    { id: "row_1", instagramId: "ig_1", workspaceId: "ws_1" },
  ]);
  state.webhookEvent.create.mockResolvedValue({ id: "evt_1" });
  state.webhookEvent.update.mockResolvedValue({});
  state.dmLog.findMany.mockResolvedValue([]);
  state.recordInteraction.mockResolvedValue(undefined);
  state.queueAdd.mockResolvedValue({});
});

describe("processInstagramWebhook records recipient interactions", () => {
  it("records an inbound DM before enqueueing the reply job", async () => {
    await processInstagramWebhook({
      payload: payload({
        id: "ig_1",
        time: 1700000000,
        messaging: [
          {
            sender: { id: "user_1" },
            recipient: { id: "ig_1" },
            message: { mid: "m1", text: "hi" },
          },
        ],
      }),
      provider: "META",
    });

    expect(state.recordInteraction).toHaveBeenCalledWith("row_1", "user_1");
    expect(state.queueAdd).toHaveBeenCalledWith(
      "process-message",
      expect.objectContaining({ senderId: "user_1" }),
      expect.anything()
    );
  });

  it("records a button tap before enqueueing the reveal job", async () => {
    await processInstagramWebhook({
      payload: payload({
        id: "ig_1",
        time: 1700000000,
        messaging: [
          {
            sender: { id: "user_1" },
            recipient: { id: "ig_1" },
            postback: { mid: "m2", payload: "reveal:auto_1" },
          },
        ],
      }),
      provider: "META",
    });

    expect(state.recordInteraction).toHaveBeenCalledWith("row_1", "user_1");
    expect(state.queueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ userId: "user_1" }),
      expect.anything()
    );
  });

  it("does not record a comment: a private reply is exempt from the window", async () => {
    await processInstagramWebhook({
      payload: payload({
        id: "ig_1",
        time: 1700000000,
        changes: [
          {
            field: "comments",
            value: {
              id: "c1",
              text: "LINK",
              from: { id: "user_1", username: "user_1" },
              media: { id: "media_1" },
            },
          },
        ],
      }),
      provider: "META",
    });

    expect(state.recordInteraction).not.toHaveBeenCalled();
    expect(state.queueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({ commentId: "c1" }),
      expect.anything()
    );
  });

  it("does not record a read receipt: reading does not open the window", async () => {
    await processInstagramWebhook({
      payload: payload({
        id: "ig_1",
        time: 1700000000,
        messaging: [
          {
            sender: { id: "user_1" },
            recipient: { id: "ig_1" },
            read: { watermark: 1700000000 },
          },
        ],
      }),
      provider: "META",
    });

    expect(state.recordInteraction).not.toHaveBeenCalled();
  });
});
