import { describe, expect, it, vi, beforeEach } from "vitest";

// Multi-studio-user robustness. getCurrentPractitionerWithStudio /
// requirePractitionerWithStudio must handle 0, 1, and 2+ active memberships
// without a raw 500 (the old .maybeSingle() errored on 2+). These tests drive
// the real resolvers with a mocked Supabase client returning 0/1/2 active rows.

// redirect() halts by throwing in Next; the mock throws a recognizable marker.
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

let mockRows: Array<Record<string, unknown>> = [];
let mockError: { message: string } | null = null;
let mockUser: { id: string } | null = { id: "user-1" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mockUser } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          // .eq("active", true) is the terminal, awaited call.
          eq: async () => ({ data: mockError ? null : mockRows, error: mockError }),
        }),
      }),
    }),
  }),
}));

import {
  getCurrentPractitionerWithStudio,
  requirePractitionerWithStudio,
} from "@/lib/supabase/queries";

function row(role: "owner" | "practitioner", studioId: string) {
  return {
    id: `p-${studioId}`,
    user_id: "user-1",
    studio_id: studioId,
    role,
    active: true,
    studio: { id: studioId, name: `Studio ${studioId}` },
  };
}

beforeEach(() => {
  redirectMock.mockClear();
  mockRows = [];
  mockError = null;
  mockUser = { id: "user-1" };
});

describe("one active membership — unchanged behavior", () => {
  it("getCurrentPractitionerWithStudio returns the practitioner + studio", async () => {
    mockRows = [row("owner", "s1")];
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    expect(practitioner.role).toBe("owner");
    expect(studio.id).toBe("s1");
    // studio is stripped off the practitioner object
    expect((practitioner as Record<string, unknown>).studio).toBeUndefined();
  });
  it("resolves the member role correctly too", async () => {
    mockRows = [row("practitioner", "s1")];
    const { practitioner } = await getCurrentPractitionerWithStudio();
    expect(practitioner.role).toBe("practitioner");
  });
  it("requirePractitionerWithStudio returns without redirecting", async () => {
    mockRows = [row("owner", "s1")];
    const { studio } = await requirePractitionerWithStudio();
    expect(studio.id).toBe("s1");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("zero active memberships — no 500, invite gate", () => {
  it("getCurrent throws a CLEAR message (not a raw DB error)", async () => {
    mockRows = [];
    await expect(getCurrentPractitionerWithStudio()).rejects.toThrow(
      /No active practitioner/,
    );
  });
  it("require redirects to /no-access", async () => {
    mockRows = [];
    await expect(requirePractitionerWithStudio()).rejects.toThrow(
      /REDIRECT:\/no-access$/,
    );
    expect(redirectMock).toHaveBeenCalledWith("/no-access");
  });
});

describe("2+ active memberships — never a raw 500; never auto-picks", () => {
  it("getCurrent throws a CONTROLLED multi-membership error (not the maybeSingle 'multiple rows' DB error)", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    await expect(getCurrentPractitionerWithStudio()).rejects.toThrow(
      /Multiple active studio memberships \(2\)/,
    );
    // it must NOT surface the raw supabase multiple-rows error
    await expect(getCurrentPractitionerWithStudio()).rejects.not.toThrow(
      /multiple \(or no\) rows/i,
    );
  });
  it("require redirects to the clean multiple-studios state (no auto-pick)", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    await expect(requirePractitionerWithStudio()).rejects.toThrow(
      /REDIRECT:\/no-access\?reason=multiple-studios/,
    );
    expect(redirectMock).toHaveBeenCalledWith(
      "/no-access?reason=multiple-studios",
    );
  });
});
