import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  command: vi.fn(),
  role: "owner" as string,
  userId: "u-1" as string | null,
  redirected: null as string | null,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    h.redirected = to;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: h.role, user_id: h.userId }, studio: { id: "studio-1" } }),
}));
vi.mock("@/lib/waitlist/booked-manually", () => ({ markEntryBookedManually: (...a: unknown[]) => h.command(...a) }));
import { bookedManuallyAction } from "@/app/(app)/settings/waitlist/booked-manually-actions";

const E = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const run = async (f: FormData) => {
  h.redirected = null;
  try {
    await bookedManuallyAction(f);
  } catch {
    /* the redirect */
  }
  return h.redirected;
};
beforeEach(() => {
  h.command.mockReset();
  h.command.mockResolvedValue("booked");
  h.role = "owner";
  h.userId = "u-1";
  process.env.WAITLIST_BOOKED_MANUALLY = "1";
});

describe("bookedManuallyAction", () => {
  it("an owner books: the studio and actor come from the session, and the result is the redirect code", async () => {
    expect(await run(form({ entryId: E, appointmentId: A }))).toBe("/settings/waitlist?bm=booked");
    expect(h.command).toHaveBeenCalledWith("studio-1", "u-1", E, A, false);
  });
  it("the mismatch confirmation is passed only when the box is ticked", async () => {
    await run(form({ entryId: E, appointmentId: A, confirmEmailMismatch: "on" }));
    await run(form({ entryId: E, appointmentId: A, confirmEmailMismatch: "true" }));
    expect(h.command.mock.calls.map((c) => c[4])).toEqual([true, false]);
  });
  it("a refusal from the database is shown, not hidden", async () => {
    h.command.mockResolvedValue("email_mismatch");
    expect(await run(form({ entryId: E, appointmentId: A }))).toBe("/settings/waitlist?bm=email_mismatch");
  });
  it.each(["practitioner", "receptionist", ""])("a %s session is refused and the command is never called", async (role) => {
    h.role = role;
    expect(await run(form({ entryId: E, appointmentId: A }))).toBe("/settings/waitlist?bm=not_owner");
    expect(h.command).not.toHaveBeenCalled();
  });
  it.each(["practitioner", "receptionist", ""])("a %s session with a malformed id still gets not_owner: the role is checked before the ids", async (role) => {
    h.role = role;
    expect(await run(form({ entryId: "nope", appointmentId: "nope" }))).toBe("/settings/waitlist?bm=not_owner");
    expect(await run(form({}))).toBe("/settings/waitlist?bm=not_owner");
    expect(h.command).not.toHaveBeenCalled();
  });
  it("an owner with no user id is refused", async () => {
    h.userId = null;
    expect(await run(form({ entryId: E, appointmentId: A }))).toBe("/settings/waitlist?bm=not_owner");
    expect(h.command).not.toHaveBeenCalled();
  });
  it.each([
    ["no entry", { appointmentId: A }],
    ["no appointment", { entryId: E }],
    ["a malformed entry", { entryId: "x' or 1=1", appointmentId: A }],
    ["a malformed appointment", { entryId: E, appointmentId: "nope" }],
  ])("%s never reaches the command and gets the neutral answer, not a claim about roles", async (_n, o) => {
    expect(await run(form(o as Record<string, string>))).toBe("/settings/waitlist?bm=invalid_request");
    expect(h.command).not.toHaveBeenCalled();
  });
  it("with the flag off nothing is called and the owner is told it is unavailable", async () => {
    delete process.env.WAITLIST_BOOKED_MANUALLY;
    expect(await run(form({ entryId: E, appointmentId: A }))).toBe("/settings/waitlist?bm=unavailable");
    expect(h.command).not.toHaveBeenCalled();
  });
});
