import { describe, it, expect, vi, afterEach } from "vitest";

import {
  getFollowerCountSeries,
  getMediaInsights,
  getUserInfo,
  getUserMedia,
  listAssignedInstagramAccounts,
  PermissionError,
  sendDirectMessage,
  subscribeInstagramAccountToWebhooks,
} from "../lib/meta/client";

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response
) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return handler(url, init);
    })
  );
  return seen;
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body));
}

function metaErrorJson(code: number, message = "Permission denied") {
  return new Response(
    JSON.stringify({ error: { message, type: "OAuthException", code } })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Unified Login host parameterization", () => {
  it("sends DMs to graph.facebook.com for Unified Login accounts", async () => {
    const seen = stubFetch(() =>
      okJson({ recipient_id: "user_1", message_id: "mid_1" })
    );

    const result = await sendDirectMessage(
      "suat",
      "17841404707268563",
      "user_1",
      "hi",
      "facebook"
    );

    expect(result.message_id).toBe("mid_1");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("https://graph.facebook.com/");
    expect(seen[0].url).toContain("/17841404707268563/messages");
  });

  it("keeps graph.instagram.com as the default host", async () => {
    const seen = stubFetch(() =>
      okJson({ recipient_id: "user_1", message_id: "mid_1" })
    );

    await sendDirectMessage("token", "17841404707268563", "user_1", "hi");

    expect(seen[0].url).toContain("https://graph.instagram.com/");
  });

  it("reads the account by professional account ID on graph.facebook.com", async () => {
    const seen = stubFetch(() =>
      okJson({
        id: "17841404707268563",
        username: "beaux_viola",
        account_type: "CREATOR",
      })
    );

    const user = await getUserInfo("suat", "17841404707268563", "facebook");

    expect(seen[0].url).toContain("https://graph.facebook.com/");
    expect(seen[0].url).toContain("/17841404707268563?");
    // graph.facebook.com has no separate user_id field: the node's id IS
    // the professional account ID, so it is filled in for callers that
    // read user_id (webhook matching, the messaging API).
    expect(user.user_id).toBe("17841404707268563");
    expect(user.username).toBe("beaux_viola");
  });

  it("does not request account_type on graph.facebook.com", async () => {
    const seen = stubFetch(() =>
      okJson({
        id: "17841404707268563",
        username: "beaux_viola",
        name: "Joel Viola",
        followers_count: 472,
      })
    );

    const user = await getUserInfo("suat", "17841404707268563", "facebook");

    // account_type is not a field on the Instagram node in Meta's
    // Facebook Graph API: requesting it fails the whole read with (#100)
    // "Tried accessing nonexisting field (account_type)" — which is what
    // rejected a valid Unified Login token on 2026-11-06. The
    // professional-account check fails open when the field is absent.
    expect(seen[0].url).not.toContain("account_type");
    expect(user.username).toBe("beaux_viola");
    expect(user.followers_count).toBe(472);
    expect(user.account_type).toBeUndefined();
  });

  it("refuses getUserInfo on graph.facebook.com without an account ID", async () => {
    const seen = stubFetch(() => okJson({}));

    await expect(getUserInfo("suat", undefined, "facebook")).rejects.toThrow(
      "requires an Instagram account ID"
    );
    expect(seen).toHaveLength(0);
  });

  it("keeps reading /me on graph.instagram.com by default", async () => {
    const seen = stubFetch(() =>
      okJson({
        id: "app_scoped",
        user_id: "17841404707268563",
        username: "beaux_viola",
        account_type: "CREATOR",
      })
    );

    const user = await getUserInfo("token");

    expect(seen[0].url).toContain("https://graph.instagram.com/");
    expect(seen[0].url).toContain("/me?");
    expect(user.user_id).toBe("17841404707268563");
  });

  it("reads media from /{ig-user-id}/media on graph.facebook.com", async () => {
    const seen = stubFetch(() => okJson({ data: [] }));

    await getUserMedia("suat", 5, "17841404707268563", "facebook");

    expect(seen[0].url).toContain("https://graph.facebook.com/");
    expect(seen[0].url).toContain("/17841404707268563/media");
  });

  it("subscribes webhooks on graph.facebook.com for Unified Login accounts", async () => {
    const seen = stubFetch(() => okJson({ success: true }));

    await subscribeInstagramAccountToWebhooks(
      "17841404707268563",
      "suat",
      "facebook"
    );

    expect(seen[0].url).toContain("https://graph.facebook.com/");
    expect(seen[0].url).toContain("/17841404707268563/subscribed_apps");
    const body = JSON.parse(String(seen[0].init?.body));
    expect(body.subscribed_fields).toEqual(["comments", "messages"]);
  });

  it("lists the accounts a system-user token covers", async () => {
    const seen = stubFetch(() =>
      okJson({
        data: [
          { id: "17841404707268563", username: "beaux_viola" },
          { id: "17841404707268564", username: "second_account" },
        ],
      })
    );

    const accounts = await listAssignedInstagramAccounts("suat");

    expect(seen[0].url).toContain("https://graph.facebook.com/");
    expect(seen[0].url).toContain("/me/assigned_instagram_accounts");
    expect(accounts).toEqual([
      { id: "17841404707268563", username: "beaux_viola" },
      { id: "17841404707268564", username: "second_account" },
    ]);
  });
});

describe("insights graceful degradation on graph.facebook.com", () => {
  it("returns empty insights instead of throwing on a missing permission", async () => {
    stubFetch(() => metaErrorJson(100));

    const insights = await getMediaInsights(
      "suat",
      "media_1",
      ["views", "reach"],
      "facebook"
    );

    expect(insights).toEqual({});
  });

  it("still throws PermissionError on the instagram host", async () => {
    stubFetch(() => metaErrorJson(100));

    await expect(
      getMediaInsights("token", "media_1", ["views", "reach"])
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("returns null follower series instead of throwing on a missing permission", async () => {
    stubFetch(() => metaErrorJson(100));

    const series = await getFollowerCountSeries(
      "suat",
      "17841404707268563",
      7,
      "facebook"
    );

    expect(series).toBeNull();
  });

  it("still throws PermissionError for the follower series on the instagram host", async () => {
    stubFetch(() => metaErrorJson(100));

    await expect(
      getFollowerCountSeries("token", "17841404707268563", 7)
    ).rejects.toBeInstanceOf(PermissionError);
  });
});
