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
