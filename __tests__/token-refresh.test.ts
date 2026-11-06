import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRefresh, mockDecrypt, mockEncrypt, mockUpdate } = vi.hoisted(
  () => ({
    mockRefresh: vi.fn(),
    mockDecrypt: vi.fn(),
    mockEncrypt: vi.fn(),
    mockUpdate: vi.fn(),
  })
);

vi.mock("@/lib/meta/client", () => ({
  refreshLongLivedToken: mockRefresh,
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecrypt,
  encryptToken: mockEncrypt,
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { instagramAccount: { update: mockUpdate } },
}));

import { refreshInstagramAccountToken } from "../lib/meta/token-refresh";

beforeEach(() => {
  vi.clearAllMocks();
  mockDecrypt.mockReturnValue("current_token");
  mockEncrypt.mockReturnValue("encrypted_new_token");
  mockRefresh.mockResolvedValue({
    accessToken: "new_token",
    expiresIn: 5184000,
  });
  mockUpdate.mockResolvedValue({});
});

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "row_1",
    provider: "META" as const,
    accessToken: "encrypted_old_token",
    username: "test_account",
    ...overrides,
  };
}

describe("refreshInstagramAccountToken", () => {
  it("refreshes, persists the new token encrypted, and returns it", async () => {
    const acc = account();
    const before = Date.now();

    const result = await refreshInstagramAccountToken(acc);

    expect(mockDecrypt).toHaveBeenCalledWith("encrypted_old_token");
    expect(mockRefresh).toHaveBeenCalledWith("current_token");
    expect(mockEncrypt).toHaveBeenCalledWith("new_token");
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "row_1" },
      data: {
        accessToken: "encrypted_new_token",
        tokenExpiresAt: expect.any(Date),
      },
    });
    const expiry = mockUpdate.mock.calls[0][0].data.tokenExpiresAt as Date;
    expect(expiry.getTime()).toBeGreaterThanOrEqual(
      before + 5184000 * 1000 - 1000
    );
    expect(result.accessToken).toBe("new_token");
    expect(result.tokenExpiresAt).toEqual(expiry);
    // The in-memory record is updated so later sends in the same job use
    // the fresh token instead of the stale one.
    expect(acc.accessToken).toBe("encrypted_new_token");
  });

  it("refuses non-Meta accounts without calling Meta", async () => {
    await expect(
      refreshInstagramAccountToken(account({ provider: "ZERNIO" }))
    ).rejects.toThrow("only supported for Meta accounts");
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not persist anything when Meta rejects the refresh", async () => {
    mockRefresh.mockRejectedValue(new Error("invalid token"));

    await expect(refreshInstagramAccountToken(account())).rejects.toThrow(
      "invalid token"
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not persist anything when the stored token cannot be decrypted", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("bad key");
    });

    await expect(refreshInstagramAccountToken(account())).rejects.toThrow(
      "bad key"
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
