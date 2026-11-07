import { decryptToken } from "@/lib/meta/oauth";
import { prisma } from "@/lib/db/client";
import type { MetaGraphHost } from "@/lib/meta/client";

export type InstagramContext =
  | {
      provider: "META";
      accessToken: string;
      // Which Graph API host this account's calls go to. Absent in older
      // call sites and tests, which default to the Instagram Login host
      // ("instagram") — see the meta client's host parameter default.
      graphHost?: MetaGraphHost;
      // The account's professional account ID. Required on the facebook
      // host, where /me is the system user rather than the account.
      instagramId?: string;
    }
  | {
      provider: "ZERNIO";
      apiKey: string;
      accountId: string;
      instagramId: string;
      operationId?: string;
    };

export type ProviderAccount = {
  provider: "META" | "ZERNIO";
  workspaceId: string;
  zernioAccountId: string | null;
  instagramId: string;
  accessToken: string;
  // True for Unified Login (Facebook Login for Business) accounts, which
  // call graph.facebook.com. Absent in older call sites; treated as false.
  isUnifiedLogin?: boolean | null;
};

export function hasInstagramCredentials(
  account: Pick<ProviderAccount, "provider" | "accessToken" | "zernioAccountId">
) {
  return account.provider === "ZERNIO"
    ? Boolean(account.zernioAccountId)
    : Boolean(account.accessToken);
}

export async function createInstagramContext(
  account: ProviderAccount,
  operationId?: string
): Promise<InstagramContext> {
  if (account.provider !== "ZERNIO")
    return {
      provider: "META",
      accessToken: decryptToken(account.accessToken),
      graphHost: account.isUnifiedLogin ? "facebook" : "instagram",
      instagramId: account.instagramId,
    };
  if (!account.zernioAccountId)
    throw new Error("Zernio account is not connected");
  const connection = await prisma.zernioConnection.findUnique({
    where: { workspaceId: account.workspaceId },
    select: { apiKey: true },
  });
  if (!connection) throw new Error("Zernio workspace connection is missing");
  return {
    provider: "ZERNIO",
    apiKey: decryptToken(connection.apiKey),
    accountId: account.zernioAccountId,
    instagramId: account.instagramId,
    ...(operationId ? { operationId } : {}),
  };
}

export type ZernioContext = Extract<InstagramContext, { provider: "ZERNIO" }>;
