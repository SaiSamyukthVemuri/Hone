import { describe, expect, it, vi, beforeEach } from "vitest";

// Multi-studio switcher (PR 2). getCurrentPractitionerWithStudio /
// requirePractitionerWithStudio must handle 0, 1, and 2+ active memberships,
// and for 2+ must honor a VALID selected-studio cookie while NEVER auto-picking
// and NEVER trusting a stale/forged selection. Driven with a mocked Supabase
// client + a mocked selected-studio cookie.

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

let mockRows: Array<Record<string, unknown>> = [];
let mockError: { message: string } | null = null;
let mockUser: { id: string } | null = { id: "user-1" };
let mockSelectedStudioId: string | null = null;

vi.mock("@/lib/supabase/selected-studio", () => ({
  readSelectedStudioId: async () => mockSelectedStudioId,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mockUser } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
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
  mockSelectedStudioId = null;
});

describe("one active membership: unchanged behavior (cookie irrelevant)", () => {
  it("getCurrent returns the practitioner + studio", async () => {
    mockRows = [row("owner", "s1")];
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    expect(practitioner.role).toBe("owner");
    expect(studio.id).toBe("s1");
    expect((practitioner as Record<string, unknown>).studio).toBeUndefined();
  });
  it("resolves the member role correctly too", async () => {
    mockRows = [row("practitioner", "s1")];
    const { practitioner } = await getCurrentPractitionerWithStudio();
    expect(practitioner.role).toBe("practitioner");
  });
  it("require returns without redirecting", async () => {
    mockRows = [row("owner", "s1")];
    const { studio } = await requirePractitionerWithStudio();
    expect(studio.id).toBe("s1");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("zero active memberships: no 500, invite gate", () => {
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
  });
});

describe("2+ memberships, NO selection: chooser (never auto-pick)", () => {
  it("getCurrent throws a CONTROLLED choose error (not the raw 'multiple rows' DB error)", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    await expect(getCurrentPractitionerWithStudio()).rejects.toThrow(
      /choose a studio/i,
    );
    await expect(getCurrentPractitionerWithStudio()).rejects.not.toThrow(
      /multiple \(or no\) rows/i,
    );
  });
  it("require redirects to the chooser", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    await expect(requirePractitionerWithStudio()).rejects.toThrow(
      /REDIRECT:\/no-access\?reason=multiple-studios/,
    );
  });
});

describe("2+ memberships, VALID selection: resolves the selected studio", () => {
  it("getCurrent returns the SELECTED studio (not the first row)", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    mockSelectedStudioId = "s2";
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    expect(studio.id).toBe("s2");
    // role follows the SELECTED membership
    expect(practitioner.role).toBe("practitioner");
  });
  it("require returns the selected studio without redirecting", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    mockSelectedStudioId = "s1";
    const { studio, practitioner } = await requirePractitionerWithStudio();
    expect(studio.id).toBe("s1");
    expect(practitioner.role).toBe("owner");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("2+ memberships, INVALID/stale selection: ignored, chooser", () => {
  it("a cookie that matches no active membership is NOT trusted (getCurrent -> choose)", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    mockSelectedStudioId = "s-other"; // a studio the user is NOT a member of
    await expect(getCurrentPractitionerWithStudio()).rejects.toThrow(
      /choose a studio/i,
    );
  });
  it("require redirects to the chooser for a stale cookie (no cross-studio leak)", async () => {
    mockRows = [row("owner", "s1"), row("practitioner", "s2")];
    mockSelectedStudioId = "s-other";
    await expect(requirePractitionerWithStudio()).rejects.toThrow(
      /REDIRECT:\/no-access\?reason=multiple-studios/,
    );
  });
});
