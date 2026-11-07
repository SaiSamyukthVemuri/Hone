import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/billing/webhook/route";

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/billing/webhook (milestone 1: no store)", () => {
  it("is a 404 while the flag is off", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "");
    expect((await POST()).status).toBe(404);
  });

  it("fails closed with 503 when the flag is on but nothing can persist yet", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    expect((await POST()).status).toBe(503);
  });
});
