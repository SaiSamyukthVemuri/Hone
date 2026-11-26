import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 0204 `assert_new_client_admission` refuses an INVITED booking when admission is
// closed or unreadable. Every surface that offers or sends an invitation must ask
// the SAME question and must say why, rather than list times Book can only fail
// ("We couldn't complete that booking. Please try again").
const read = (p: string) => readFileSync(p, "utf8");

describe("invited_book refusal is tied to honest copy", () => {
  it("the database matrix: 0204 refuses closed for invited_book; 0323 allows it and ships the marker with it (the premise)", () => {
    const cell = (sql: string) => {
      const m = sql.match(/when 'invited_book' then\s+case\s+when v_mode in \(([^)]*)\) then 'ok'/);
      expect(m, "invited_book branch not found").not.toBeNull();
      return m![1].replace(/\s/g, "");
    };
    expect(cell(read("supabase/migrations/0204_new_client_admission_mode.sql"))).toBe("'open','waitlist'");
    const m0323 = read("supabase/migrations/0323_waitlist_launch_controls.sql");
    expect(cell(m0323)).toBe("'open','waitlist','closed'");
    expect(m0323).toContain("create or replace function public.waitlist_closed_invited_booking_enabled()");
  });

  it("the shared predicate mirrors that rule and has one definition", () => {
    const src = read("lib/booking/new-client-admission.ts");
    expect(src).toMatch(
      /export function newClientAdmissionRefusesInvitedBooking\([\s\S]*?\{\s*if \(!a\.ok\) return true;\s*return a\.mode === "closed" && rule !== "applied";/,
    );
  });

  it("the invitation funnel asks it and answers with admission_closed, before any booking", () => {
    const src = read("app/invitation/[token]/actions.ts");
    expect(src).toContain("invitedBookingRefusalKind(admission)");
    expect(src).toMatch(/"admission_closed" : "admission_unreadable"/);
    // and a commit-time refusal code maps to the same state, not to bookingRefusalFor's "unavailable"
    expect(src).toMatch(/booked\.code === NEW_CLIENT_ADMISSION_REFUSAL_CODE[\s\S]{0,800}admission_closed/);
  });

  it("the screen has accurate copy for it and never tells the recipient to try again", () => {
    const src = read("app/features/waitlist-invitation/InvitationScreen.tsx");
    const block = src.match(/admission_closed: \{[\s\S]*?\n  \},/);
    expect(block, "admission_closed copy missing").not.toBeNull();
    expect(block![0]).toContain("isn’t taking new-client bookings right now");
    expect(block![0].toLowerCase()).not.toContain("try again");
  });

  it("closed and unreadable have SEPARATE copy; the unreadable copy never claims closed (Privacy C1)", () => {
    const screen = read("app/features/waitlist-invitation/InvitationScreen.tsx");
    const un = screen.match(/admission_unreadable: \{[\s\S]*?\n  \},/);
    expect(un, "admission_unreadable copy missing").not.toBeNull();
    expect(un![0]).toContain("This link can’t be used to book right now. Your invitation hasn’t been used. Please contact the studio.");
    expect(un![0].toLowerCase()).not.toMatch(/closed|isn’t taking|try again/);
    const contract = read("lib/waitlist/invite-to-book-contract.ts");
    const grab = (name: string) => {
      const m = contract.match(new RegExp(`export const ${name} =\\s*"([^"]*)"`));
      expect(m, `${name} missing`).not.toBeNull();
      return m![1];
    };
    expect(grab("INVITE_ADMISSION_UNREADABLE_COPY")).toBe(
      "We couldn’t check new-client admission, so invitations are paused. Check Settings → Booking.",
    );
    expect(grab("INVITE_ADMISSION_UNREADABLE_COPY")).not.toContain("Closed");
    expect(grab("INVITE_ADMISSION_CLOSED_BANNER_COPY")).toContain("set to Closed");
    expect(grab("INVITE_ADMISSION_CLOSED_BANNER_COPY")).toContain("Settings → Booking");
    // R2: the banner owns its text; it is never sliced out of the notice.
    const page = read("app/(app)/settings/waitlist/page.tsx");
    expect(page).not.toMatch(/INVITE_ADMISSION_CLOSED_COPY\.replace/);
    expect(page).toContain("INVITE_ADMISSION_CLOSED_BANNER_COPY");
    expect(page).toContain("INVITE_ADMISSION_UNREADABLE_COPY");
    // the kind is derived from ok, so unreadable can never take the closed branch
    const adm = read("lib/booking/new-client-admission.ts");
    expect(adm).toMatch(/if \(!a\.ok\) return "unreadable";\s*return rule === "absent" \? "closed" : "unreadable";/);
  });

  it("the owner's send is refused server-side and withheld in the composer, with the settings path named", () => {
    const act = read("app/(app)/settings/waitlist/invite-actions.ts");
    expect(act).toMatch(/invitedBookingRefusalKind\(admission\)[\s\S]{0,800}admission_closed/);
    const order = act.indexOf("invitedBookingRefusalKind(admission)");
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(act.indexOf("admissionCommandAdapter.inviteToBook(input)"));
    const page = read("app/(app)/settings/waitlist/page.tsx");
    expect(page).toMatch(/capabilities=\{\s*!invitesBlockedByAdmission/);
    const contract = read("lib/waitlist/invite-to-book-contract.ts");
    expect(contract).toMatch(/INVITE_ADMISSION_CLOSED_COPY =\s*"[^"]*Settings → Booking/);
  });
});
