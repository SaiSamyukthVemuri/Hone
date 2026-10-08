import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Exercise the REAL auth-allowlist function, not a test double of updateSession.
// A synthetic anonymous Supabase answer is sufficient to establish whether a
// public path is sent to the practitioner login before Next renders it.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }),
}));
vi.mock("@/lib/admin", () => ({
  isAdmin: () => false,
}));

async function navigate(path: string) {
  const request = new NextRequest("https://hone.care" + path);
  const response = await updateSession(request);
  return { response, request };
}

describe("public route trailing slashes at the real Supabase auth gate", () => {
  it("passes shipped feature paths to Next without an anonymous /login redirect", async () => {
    for (const route of [
      "/features/treatment-memory",
      "/features/treatment-memory/",
      "/features/booking-calendar/",
      "/features/charting-records/",
      "/pricing/",
      "/privacy/",
      "/resources/",
    ]) {
      const { response, request } = await navigate(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get("location"), route).toBeNull();
      // The user-visible request is not rewritten; normalization controls only
      // auth path equality. Next still routes the ORIGINAL browser URL.
      expect(request.nextUrl.pathname, route).toBe(route);
    }
  });

  it("does not accidentally authorize unshipped feature or protected routes", async () => {
    for (const route of [
      "/features/not-real/",
      "/features/waitlist-invitation/",
      "/dashboard/",
      "/settings/",
      "/clients/",
      "/admin/",
    ]) {
      const { response, request } = await navigate(route);
      expect(response.status, route).toBe(307);
      const target = response.headers.get("location");
      expect(target, route).toBeTruthy();
      expect(new URL(target!).pathname, route).toBe("/login");
      expect(request.nextUrl.pathname, route).toBe(route);
    }
  });

  it("continues to allow token-bearing routes to perform their own checks", async () => {
    for (const route of [
      "/invitation/synthetic-token",
      "/portal/verify/synthetic-token",
      "/manage/synthetic-token",
    ]) {
      const { response } = await navigate(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get("location"), route).toBeNull();
    }
  });
});
