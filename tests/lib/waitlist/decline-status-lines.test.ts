import { describe, expect, it } from "vitest";
import { bellStatusLine, DECLINE_CARD_SAVED, emailStatusLine, emptyOutboxCounts } from "@/lib/waitlist/decline-status-lines";

const c = (over: Partial<ReturnType<typeof emptyOutboxCounts>>) => ({ ...emptyOutboxCounts(), ...over });
const FORBIDDEN_WHEN_OFF = /queued|pending|waiting|scheduled|will be sent|delivered/i;

describe("the follow-up card's status lines", () => {
  it("the card text is Sam's own words", () => {
    expect(DECLINE_CARD_SAVED).toBe("Response saved. Review the follow-up below.");
  });
  it("the bell and the email are separate lines", () => {
    expect(bellStatusLine()).not.toMatch(/email/i);
    expect(emailStatusLine(true, c({ sent: 1 }))).not.toMatch(/bell/i);
  });
  it("with the email off, held rows read 'off, not sent' and never queued or pending", () => {
    for (const counts of [c({ held: 2 }), c({}), null]) {
      const line = emailStatusLine(false, counts);
      expect(line).toBe("Email: off, not sent.");
      expect(line).not.toMatch(FORBIDDEN_WHEN_OFF);
    }
  });
  it("'sent' means accepted by the provider, and no line ever says delivered", () => {
    const lines = [
      emailStatusLine(true, c({ sent: 2 })),
      emailStatusLine(true, c({ sent: 1, failed: 1, cancelled: 1, sending: 1 })),
      emailStatusLine(true, c({ failed: 3 })),
      emailStatusLine(true, c({ held: 1 })),
      emailStatusLine(true, null),
      emailStatusLine(true, c({})),
    ];
    for (const l of lines) expect(l).not.toMatch(/deliver|queued|pending/i);
    expect(emailStatusLine(true, c({ sent: 2 }))).toBe("Email: sent to 2 owners (accepted by the email provider).");
  });
  it("each state is its own phrase, singular and plural", () => {
    expect(emailStatusLine(true, c({ sent: 1 }))).toContain("1 owner ");
    expect(emailStatusLine(true, c({ failed: 1 }))).toBe("Email: could not be sent to 1 owner.");
    expect(emailStatusLine(true, c({ cancelled: 2 }))).toContain("not sent to 2 owners");
    expect(emailStatusLine(true, c({ held: 1, sending: 1 }))).toBe("Email: sending to 2 owners.");
  });
  it("an unreadable outbox is said, not guessed", () => {
    expect(emailStatusLine(true, null)).toBe("Email: status unavailable.");
  });
});
