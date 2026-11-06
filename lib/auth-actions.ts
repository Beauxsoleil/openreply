"use server";

import { signOut } from "@/lib/auth";

/**
 * Sign the current user out from the TopBar. A server action (not a client
 * `next-auth/react` call) so the session is ended server-side, matching the
 * magic-link sign-in on the login page, which is a server action too.
 */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
