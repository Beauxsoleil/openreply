import { describe, it, expect, vi, afterEach } from "vitest";

import {
  getUserInfo,
  isProfessionalInstagramAccount,
} from "../lib/meta/client";

describe("isProfessionalInstagramAccount", () => {
  it.each(["BUSINESS", "CREATOR"])(
    "accepts a %s account",
    (account_type) => {
      expect(isProfessionalInstagramAccount({ account_type })).toBe(true);
    }
  );

  it("rejects a PERSONAL account", () => {
    expect(
      isProfessionalInstagramAccount({ account_type: "PERSONAL" })
    ).toBe(false);
  });

  it("fails open when Meta does not return an account type", () => {
    expect(isProfessionalInstagramAccount({})).toBe(true);
    expect(
      isProfessionalInstagramAccount({ account_type: undefined })
    ).toBe(true);
  });
});

describe("getUserInfo requests account_type", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for account_type and returns it", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seenUrls.push(url);
        return new Response(
          JSON.stringify({
            id: "1",
            user_id: "100",
            username: "someone",
            account_type: "PERSONAL",
          })
        );
      })
    );

    const user = await getUserInfo("token");

    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain("account_type");
    expect(user.account_type).toBe("PERSONAL");
    expect(isProfessionalInstagramAccount(user)).toBe(false);
  });
});
