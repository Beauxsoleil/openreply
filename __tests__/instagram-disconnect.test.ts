import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  context: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { instagramAccount: { deleteMany: state.deleteMany } },
}));
vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role),
  getCurrentWorkspaceContext: state.context,
}));

import { POST } from "../app/api/instagram/disconnect/route";

function request(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/instagram/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.context.mockResolvedValue({ workspaceId: "ws_1", role: "ADMIN" });
  state.deleteMany.mockResolvedValue({ count: 1 });
});

describe("Instagram disconnect", () => {
  it("refuses to disconnect when no account id is given", async () => {
    const response = await POST(request({}));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/instagramAccountId is required/);
    expect(state.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only the named account", async () => {
    const response = await POST(request({ instagramAccountId: "acc_1" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(state.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1", id: "acc_1" },
    });
  });

  it("requires a signed-in workspace member", async () => {
    state.context.mockResolvedValue(null);

    const response = await POST(request({ instagramAccountId: "acc_1" }));

    expect(response.status).toBe(401);
    expect(state.deleteMany).not.toHaveBeenCalled();
  });
});
