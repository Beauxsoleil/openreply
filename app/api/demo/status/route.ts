import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/env";

// Lets client UI (e.g. the campaign detail page) show demo-only panels
// without rendering a server value into every page. Reveals nothing but
// whether this instance runs in demo mode.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ success: true, data: { demoMode: isDemoMode() } });
}
