import { prisma } from "@/lib/db/client";
import { refreshLongLivedToken } from "./client";
import { decryptToken, encryptToken } from "./oauth";

// The account fields a token refresh needs. Structural: a Prisma
// InstagramAccount satisfies this, and the worker passes its
// `automation.instagramAccount` straight in.
export interface RefreshableInstagramAccount {
  id: string;
  provider: "META" | "ZERNIO";
  accessToken: string;
  username?: string | null;
  // Unified Login accounts carry a never-expiring system-user token, which
  // has no refresh endpoint. Absent in older call sites; treated as false.
  isUnifiedLogin?: boolean | null;
}

/**
 * Refresh a Meta long-lived token and persist the new one encrypted.
 *
 * Shared by the daily refresh cron and the worker's in-flight retry: a token
 * that expires mid-day should not wait for 05:00 to work again.
 *
 * The passed account's `accessToken` is updated in place to the new encrypted
 * token, so later sends in the same job build their context from the fresh
 * token instead of retrying with the stale one.
 *
 * Throws when the provider is not META, the stored token cannot be
 * decrypted, or Meta rejects the refresh. Callers decide how to surface
 * that (the worker rethrows the original TokenExpiredError; the cron records
 * an OperationalEvent).
 */
export async function refreshInstagramAccountToken(
  account: RefreshableInstagramAccount
): Promise<{ accessToken: string; tokenExpiresAt: Date }> {
  if (account.provider !== "META") {
    throw new Error("Token refresh is only supported for Meta accounts");
  }

  // A Unified Login system-user token never expires and Meta offers no
  // endpoint to refresh it. Refuse loudly instead of spending a
  // graph.instagram.com refresh call that can only fail — the callers
  // (daily cron, worker retry) treat a throw here as "leave the stored
  // token alone", which is exactly right for a token that never expires.
  if (account.isUnifiedLogin) {
    throw new Error(
      "Token refresh is not supported for Unified Login accounts: system-user tokens never expire"
    );
  }

  const currentToken = decryptToken(account.accessToken);
  const { accessToken: newToken, expiresIn } =
    await refreshLongLivedToken(currentToken);
  const encryptedToken = encryptToken(newToken);
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  await prisma.instagramAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptedToken,
      tokenExpiresAt,
    },
  });

  account.accessToken = encryptedToken;
  return { accessToken: newToken, tokenExpiresAt };
}
