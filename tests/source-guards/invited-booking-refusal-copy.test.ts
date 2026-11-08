import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 0204 `assert_new_client_admission` refuses an INVITED booking when admission is
// closed or unreadable. Every surface that offers or sends an invitation must ask
// the SAME question and must say why, rather than list times Book can only fail
// ("We couldn't complete that booking. Please try again").
const read = (p: string) => readFileSync(p, "utf8");

describe("invited_book refusal is tied to honest copy", () => {
  it("the database matrix still refuses closed/unknown for invited_book (the premise)", () => {
    const sql = read("supabase/migrations/0204_new_client_admission_mode.sql");
    const m = sql.match(/when 'invited_book' then\s+case\s+when v_mode in \(([^)]*)\) then 'ok'/);
    expect(m, "invited_book branch not found in 0204").not.toBeNull();
    const ok = m![1].replace(/\s/g, "");
    expect(ok).toBe("'open','waitlist'");
  });

  it("the shared predicate mirrors that refusal and has one definition", () => {
    const src = read("lib/booking/new-client-admission.ts");
    expect(src).toMatch(
      /export function newClientAdmissionRefusesInvitedBooking\([\s\S]*?\{\s*return newClientAdmissionRefusesOutright\(a\);/,
    );
  });

  it("the invitation funnel asks it and answers with admission_closed, before any booking", () => {
    const src = read("app/invitation/[token]/actions.ts");
    expect(src).toContain("newClientAdmissionRefusesInvitedBooking(admission)");
    expect(src).toMatch(/reason: "admission_closed"/);
    // and a commit-time refusal code maps to the same state, not to bookingRefusalFor's "unavailable"
    expect(src).toMatch(/booked\.code === NEW_CLIENT_ADMISSION_REFUSAL_CODE[\s\S]{0,200}admission_closed/);
  });

  it("the screen has accurate copy for it and never tells the recipient to try again", () => {
    const src = read("app/features/waitlist-invitation/InvitationScreen.tsx");
    const block = src.match(/admission_closed: \{[\s\S]*?\n  \},/);
    expect(block, "admission_closed copy missing").not.toBeNull();
    expect(block![0]).toContain("isn’t taking new-client bookings right now");
    expect(block![0].toLowerCase()).not.toContain("try again");
  });

  it("the owner's send is refused server-side and withheld in the composer, with the settings path named", () => {
    const act = read("app/(app)/settings/waitlist/invite-actions.ts");
    expect(act).toMatch(/newClientAdmissionRefusesInvitedBooking\(admission\)[\s\S]{0,120}admission_closed/);
    const order = act.indexOf("newClientAdmissionRefusesInvitedBooking(admission)");
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(act.indexOf("admissionCommandAdapter.inviteToBook(input)"));
    const page = read("app/(app)/settings/waitlist/page.tsx");
    expect(page).toMatch(/canOfferInvite\(capacity\) && !invitesBlockedByAdmission/);
    const contract = read("lib/waitlist/invite-to-book-contract.ts");
    expect(contract).toMatch(/INVITE_ADMISSION_CLOSED_COPY =\s*"[^"]*Settings → Booking/);
  });
});
