/**
 * Demo-mode safety helpers.
 *
 * A demo Instagram account is a database row, not a real connection: it
 * carries no usable credential (its access token is the placeholder below)
 * and is flagged `isDemo` in the schema. Every real send path must refuse
 * such an account — defence in depth, so a demo row can never reach the
 * Meta API even if a job for it is somehow enqueued.
 */

import { isDemoMode } from "@/lib/env";

/** The only access-token value a demo Instagram account ever carries. */
export const DEMO_TOKEN_PLACEHOLDER = "DEMO_NO_REAL_TOKEN";

export type DemoAccountLike = {
  isDemo?: boolean | null;
  accessToken?: string | null;
};

/**
 * True when the account is a demo account: flagged `isDemo`, or carrying the
 * demo placeholder token. Either marker alone is enough to refuse a send.
 */
export function isDemoAccount(
  account: DemoAccountLike | null | undefined
): boolean {
  if (!account) return false;
  return (
    account.isDemo === true ||
    account.accessToken === DEMO_TOKEN_PLACEHOLDER
  );
}

const DEMO_REFUSAL_MESSAGE = "Refused to send real DM for demo account";

/**
 * Refuse a real DM send for a demo account. Logs the refusal (the exact log
 * line operators grep for) and throws, so callers that already hold a send
 * in flight fail loudly instead of silently dropping it.
 *
 * Also refuses any send while `DEMO_MODE=1` is on unless the caller says the
 * job is explicitly simulated — demo mode must never send a real message,
 * even for a non-demo account row that somehow exists in a demo database.
 */
export function assertNotDemoSend(
  account: DemoAccountLike | null | undefined,
  opts?: { simulated?: boolean }
): void {
  if (opts?.simulated) return;
  if (isDemoAccount(account) || isDemoMode()) {
    console.error(`[Demo Mode] ${DEMO_REFUSAL_MESSAGE}`);
    throw new Error(DEMO_REFUSAL_MESSAGE);
  }
}

export { DEMO_REFUSAL_MESSAGE };
