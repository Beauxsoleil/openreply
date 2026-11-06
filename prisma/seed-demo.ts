/**
 * Demo-mode seed script: `npm run db:seed-demo`
 *
 * Creates (idempotently — safe to run twice) the fixtures demo mode needs:
 * - a demo user, `demo@example.test`
 * - a workspace, "Demo workspace", owned by that user
 * - a demo Instagram account, @demo-brand, flagged `isDemo` with NO real
 *   credential (its access token is the DEMO_NO_REAL_TOKEN placeholder)
 * - three sample campaigns bound to that account
 *
 * Nothing here touches the Meta API, enqueues a job, or sends a message.
 * Run it with DEMO_MODE=1 in `.env` (see docs/demo.md). It only ever
 * creates/updates the demo rows identified below; it never deletes or
 * modifies any other user, workspace, account, or campaign.
 */

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db/client";
import { DEMO_TOKEN_PLACEHOLDER } from "@/lib/demo";

/**
 * tsx does not load `.env` the way `next dev` does, so the CLI entry point
 * reads it here (only keys not already set in the environment). Kept tiny
 * and local to this script: no new dependency, no dotenv.
 */
function loadDotEnv() {
  if (process.env.DATABASE_URL) return;
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env file: DATABASE_URL must come from the environment instead.
  }
}

export const DEMO_USER_EMAIL = "demo@example.test";
export const DEMO_WORKSPACE_NAME = "Demo workspace";
export const DEMO_INSTAGRAM_ID = "demo-instagram-account";
export const DEMO_USERNAME = "demo-brand";

const DEMO_CAMPAIGNS = [
  {
    name: "Free Guide",
    goal: "Send the free starter guide when someone asks for it.",
    keywords: ["guide"],
    dmMessage:
      "Hey {username}! Here's your free starter guide — thanks for asking. (Demo: this DM was simulated, nothing was sent to Instagram.)",
  },
  {
    name: "Pricing info",
    goal: "Answer pricing questions with the price list.",
    keywords: ["price", "pricing", "cost"],
    dmMessage:
      "Hey {username}! Here's the price list you asked for. (Demo: this DM was simulated, nothing was sent to Instagram.)",
  },
  {
    name: "Free checklist",
    goal: "Send the launch checklist when someone asks for it.",
    keywords: ["checklist"],
    dmMessage:
      "Hey {username}! Here's your free launch checklist. (Demo: this DM was simulated, nothing was sent to Instagram.)",
  },
] as const;

/**
 * Seed (or re-seed) the demo fixtures. Idempotent: every row is found by a
 * unique key first and updated in place, so a second run changes nothing
 * and creates nothing new.
 */
export async function seedDemo() {
  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: { name: "Demo User" },
    create: { email: DEMO_USER_EMAIL, name: "Demo User" },
  });

  let workspace = await prisma.workspace.findFirst({
    where: { ownerId: user.id, name: DEMO_WORKSPACE_NAME },
  });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: { name: DEMO_WORKSPACE_NAME, ownerId: user.id },
    });
  }

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    update: { role: "OWNER" },
    create: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
  });

  const account = await prisma.instagramAccount.upsert({
    where: { instagramId: DEMO_INSTAGRAM_ID },
    update: {
      workspaceId: workspace.id,
      username: DEMO_USERNAME,
      name: "Demo Brand",
      accessToken: DEMO_TOKEN_PLACEHOLDER,
      isDemo: true,
    },
    create: {
      workspaceId: workspace.id,
      instagramId: DEMO_INSTAGRAM_ID,
      username: DEMO_USERNAME,
      name: "Demo Brand",
      provider: "META",
      accessToken: DEMO_TOKEN_PLACEHOLDER,
      isDemo: true,
    },
  });

  for (const campaign of DEMO_CAMPAIGNS) {
    const existing = await prisma.automation.findFirst({
      where: { workspaceId: workspace.id, name: campaign.name },
    });
    if (existing) {
      await prisma.automation.update({
        where: { id: existing.id },
        data: {
          instagramAccountId: account.id,
          goal: campaign.goal,
          keywords: [...campaign.keywords],
          dmMessage: campaign.dmMessage,
          matchAnyPost: true,
          isActive: true,
        },
      });
    } else {
      await prisma.automation.create({
        data: {
          workspaceId: workspace.id,
          instagramAccountId: account.id,
          name: campaign.name,
          goal: campaign.goal,
          keywords: [...campaign.keywords],
          dmMessage: campaign.dmMessage,
          matchAnyPost: true,
          isActive: true,
        },
      });
    }
  }

  const counts = {
    users: await prisma.user.count({ where: { email: DEMO_USER_EMAIL } }),
    workspaces: await prisma.workspace.count({
      where: { ownerId: user.id, name: DEMO_WORKSPACE_NAME },
    }),
    accounts: await prisma.instagramAccount.count({
      where: { instagramId: DEMO_INSTAGRAM_ID },
    }),
    campaigns: await prisma.automation.count({
      where: { workspaceId: workspace.id },
    }),
  };
  console.log("[Demo seed] Demo fixtures ready:", counts);
  console.log(
    "[Demo seed] Sign in as demo@example.test (magic link), then open a campaign and simulate a comment."
  );
  return { user, workspace, account, counts };
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  loadDotEnv();
  seedDemo()
    .catch((error) => {
      console.error("[Demo seed] Failed:", error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect().catch(() => {}));
}
