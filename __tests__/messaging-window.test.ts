import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUnique, mockUpsert } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    recipientInteraction: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
  },
}));

import {
  recordRecipientInteraction,
  getMessagingWindowStatus,
  MESSAGING_WINDOW_MS,
} from "../lib/instagram/messaging-window";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("messaging window", () => {
  it("records an interaction as an upsert keyed by account and recipient", async () => {
    const at = new Date("2026-11-05T12:00:00.000Z");
    await recordRecipientInteraction("row_1", "user_1", at);

    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        instagramAccountId_recipientId: {
          instagramAccountId: "row_1",
          recipientId: "user_1",
        },
      },
      create: {
        instagramAccountId: "row_1",
        recipientId: "user_1",
        lastInteractionAt: at,
      },
      update: { lastInteractionAt: at },
    });
  });

  it("reports unknown when no interaction was ever recorded", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      getMessagingWindowStatus("row_1", "user_1")
    ).resolves.toEqual({ state: "unknown", lastInteractionAt: null });
  });

  it("reports open for an interaction within the last 24 hours", async () => {
    const last = new Date("2026-11-05T12:00:00.000Z");
    const now = new Date(last.getTime() + MESSAGING_WINDOW_MS - 1000);
    mockFindUnique.mockResolvedValue({ lastInteractionAt: last });

    await expect(
      getMessagingWindowStatus("row_1", "user_1", now)
    ).resolves.toEqual({ state: "open", lastInteractionAt: last });
  });

  it("reports open exactly at the 24-hour boundary", async () => {
    const last = new Date("2026-11-05T12:00:00.000Z");
    const now = new Date(last.getTime() + MESSAGING_WINDOW_MS);
    mockFindUnique.mockResolvedValue({ lastInteractionAt: last });

    const status = await getMessagingWindowStatus("row_1", "user_1", now);
    expect(status.state).toBe("open");
  });

  it("reports closed for an interaction older than 24 hours", async () => {
    const last = new Date("2026-11-05T12:00:00.000Z");
    const now = new Date(last.getTime() + MESSAGING_WINDOW_MS + 1000);
    mockFindUnique.mockResolvedValue({ lastInteractionAt: last });

    await expect(
      getMessagingWindowStatus("row_1", "user_1", now)
    ).resolves.toEqual({ state: "closed", lastInteractionAt: last });
  });
});
