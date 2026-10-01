import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildWaitlistInvitationEmail,
  waitlistInvitationSubject,
} from "@/lib/email/templates/waitlist-invitation";
import {
  buildWaitlistRecipientProofEmail,
  minutesPhrase,
} from "@/lib/email/templates/waitlist-recipient-proof";

// WAIT DELIVERY-01. These two templates are the visible half of a design whose
// whole point is that the invitation link and the recipient proof are SEPARATE
// authorities. The tests below are mostly about what must NOT appear in each
// message, because that is where the separation is actually enforced: a
// template that helpfully included the other factor would silently collapse
// two channels into one and nothing else in the stack would notice.
//
// Pure templates: no provider, no I/O, no env. Nothing here can send email.

const URL = "https://example.test/waitlist/invitation/RAWTOKEN";
// An ABSOLUTE instant, already formatted by the caller in the studio's zone.
// Not a duration: a duration is only true at one moment, and a delayed send
// makes it false.
const EXPIRY_LABEL = "Thursday, September 10, 2026 at 1:00 PM EDT";

const STUDIO = "Willow Electrolysis";

describe("waitlist invitation email", () => {
  const build = (over: Partial<Parameters<typeof buildWaitlistInvitationEmail>[0]> = {}) =>
    buildWaitlistInvitationEmail({
      studioName: STUDIO,
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
      ...over,
    });

  // =========================================================================
  // P1 CLIENT TRUST — the studio is identifiable BEFORE any click
  // =========================================================================
  //
  // THE DEFECT THIS REPLACES. The subject was the constant "Your invitation to
  // book", the body named no studio, and a line said "Opening the link will
  // show you which studio is offering it." A real prospect could not tell who
  // was writing until after clicking an unfamiliar link. That is the shape of
  // a phishing message.
  //
  // THE RULE THESE ASSERTIONS REPLACE. The previous suite asserted "renders NO
  // studio-derived value anywhere" — and did so by checking the output did not
  // contain "Willow" when no studio name was ever passed in. The template took
  // no studio parameter at all, so that assertion could not fail. It is
  // retired, not weakened: the idempotency argument behind it is answered in
  // the template header and in lib/waitlist/delivery/send.ts, and the
  // byte-stability it was protecting is now proved where it actually lives —
  // across a same-invocation retry, in tests/lib/waitlist/delivery-send.test.ts.

  it("NAMES THE STUDIO IN THE SUBJECT, exactly as resolved", () => {
    expect(waitlistInvitationSubject(STUDIO)).toBe(
      "Your invitation to book an electrolysis consultation with Willow Electrolysis",
    );
    expect(build().subject).toContain(STUDIO);
    // Operator inbox-rule vocabulary stays on the studio-facing notification.
    expect(build().subject).not.toContain("[HONE WAITLIST]");
  });

  it("names the studio in the heading, the lead sentence and the footer", () => {
    const out = build();
    for (const rendered of [out.text, out.html]) {
      expect(rendered).toContain("Willow Electrolysis has invited you to book.");
      expect(rendered).toContain(
        "A consultation opening is available at Willow Electrolysis.",
      );
      expect(rendered).toContain("Choose a time that works for you.");
      expect(rendered).toContain("Willow Electrolysis via Hone");
    }
  });

  it("puts the studio name BEFORE the link and before the CTA, in both bodies", () => {
    // Ordering is the whole point: identity has to be readable in the part of
    // the message a cautious recipient reads before deciding to click.
    const out = build();
    expect(out.text.indexOf(STUDIO)).toBeGreaterThan(-1);
    expect(out.text.indexOf(STUDIO)).toBeLessThan(out.text.indexOf(URL));

    const firstStudio = out.html.indexOf(STUDIO);
    const ctaIdx = out.html.indexOf("Choose a consultation time");
    const firstUrl = out.html.indexOf(URL);
    expect(firstStudio).toBeGreaterThan(-1);
    expect(ctaIdx).toBeGreaterThan(-1);
    expect(firstStudio).toBeLessThan(ctaIdx);
    expect(firstStudio).toBeLessThan(firstUrl);
  });

  it("the CTA never has to be followed to learn who is inviting — and says so no more", () => {
    const out = build();
    expect(out.html).toContain("Choose a consultation time");
    // The sentence that deferred identity to the click is gone from both bodies.
    expect(out.text).not.toContain("which studio is offering");
    expect(out.html).not.toContain("which studio is offering");
    // Stripping every URL still leaves the studio identifiable.
    const withoutLinks = out.text.split(URL).join("");
    expect(withoutLinks).toContain(STUDIO);
  });

  it("ESCAPES a studio name that would otherwise inject markup", () => {
    const out = buildWaitlistInvitationEmail({
      studioName: '<script>alert(1)</script><img src=x onerror=y>',
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("&lt;script&gt;");
    // The subject is not HTML and is not escaped; it must still carry no
    // newline that could split headers.
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it("escapes a studio name containing quotes and ampersands", () => {
    const out = buildWaitlistInvitationEmail({
      studioName: 'Willow & "Co"',
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
    });
    expect(out.html).toContain("Willow &amp; &quot;Co&quot;");
    expect(out.text).toContain('Willow & "Co"');
  });

  it("falls back to the unidentified copy when no studio name is resolved", () => {
    // A studio with no name is a data defect. The degenerate case renders the
    // previous wording rather than an odd half-sentence like "with ".
    const out = build({ studioName: "   " });
    expect(out.subject).toBe("Your invitation to book");
    expect(out.text).toContain("A spot is available.");
    expect(out.text).not.toContain(" at .");
    expect(out.text).not.toMatch(/with\s*$/m);
  });

  // =========================================================================
  // UNCHANGED CONTRACTS — the separation this template exists to protect
  // =========================================================================

  it("carries the invitation URL in both bodies", () => {
    const out = build();
    expect(out.text).toContain(URL);
    expect(out.html).toContain(URL);
  });

  it("carries NO proof code, and the raw token appears ONLY inside the URL", () => {
    // The two factors must not meet in one message. The invitation RESOLVES;
    // only the separately delivered proof authorises a mutation.
    //
    // Checked by SUBTRACTION rather than by a code-shaped regex over the whole
    // body: the invitation token is itself an uppercase run, so a naive
    // "no [A-Z0-9]{6,8}" assertion fires on the one credential that IS
    // authorised here. Remove the authorised URL first; whatever is left must
    // carry no credential at all.
    const out = build();
    const TOKEN = "RAWTOKEN";

    // The token travels only as part of the URL, never loose in the copy.
    const tokenHits = (t: string) => t.split(TOKEN).length - 1;
    const urlHits = (t: string) => t.split(URL).length - 1;
    expect(tokenHits(out.text)).toBe(urlHits(out.text));
    expect(tokenHits(out.html)).toBe(urlHits(out.html));
    expect(out.subject).not.toContain(TOKEN);

    // No mention of a code anywhere, in any body.
    for (const rendered of [out.subject, out.text, out.html]) {
      expect(rendered.split(URL).join(" ")).not.toMatch(/\bcode\b/i);
    }

    // The code-SHAPE check runs on the TEXT body only. The HTML carries inline
    // styling whose hex colours (#0A0A0A, #FAFAF7, #E5E2DA...) are themselves
    // six-character uppercase runs, so the same regex over the HTML fires on
    // the stylesheet and proves nothing.
    expect(out.text.split(URL).join(" ")).not.toMatch(/\b[A-Z0-9]{6,8}\b/);

    // The falsifiable half: a real code, rendered by the sibling template for
    // the same studio, must appear nowhere in the invitation. If the two
    // templates ever converge, this fails for the right reason.
    const proof = buildWaitlistRecipientProofEmail({
      studioName: STUDIO,
      code: "H4K2QF7P",
      windowMinutes: 15,
      action: "book",
    });
    expect(proof.text).toContain("H4K2QF7P");
    for (const rendered of [out.subject, out.text, out.html]) {
      expect(rendered).not.toContain("H4K2QF7P");
    }
  });

  it("tells the recipient the link alone will not complete anything", () => {
    // The link RESOLVES; it does not MUTATE. If this sentence disappears, a
    // recipient reasonably assumes clicking through is the whole transaction
    // and the second factor arrives as an unexplained obstacle.
    const out = build();
    expect(out.text).toContain("opening the link is not enough on its own");
    expect(out.html).toContain("opening the link is not enough on its own");
  });

  it("states the verification step in MECHANISM-NEUTRAL words", () => {
    // The previous copy described "a short confirmation code emailed to this
    // address", pinning prospect-facing text to one implementation of
    // recipient proof. This hotfix must not depend on, or pre-empt, any change
    // to that mechanism — so the copy states that verification happens without
    // describing how. Nothing is removed from the code: the proof requirement
    // itself is untouched.
    const out = build();
    for (const rendered of [out.text, out.html]) {
      expect(rendered).toContain(
        "Hone may ask you to verify this email address",
      );
      expect(rendered).not.toContain("confirmation code");
      expect(rendered).not.toContain("short code");
    }
  });

  it("renders the caller's absolute expiry and hard-codes no TTL", () => {
    // The TTL is owned by issue_new_client_waitlist_invitation (0189:
    // p_ttl_hours, default 72, clamped 1..168) and stored on expires_at. This
    // module must never become a second opinion about it.
    const out = build({ expiresAtLabel: "Tuesday, September 8, 2026 at 9:00 AM EDT" });
    expect(out.text).toContain("expires Tuesday, September 8, 2026 at 9:00 AM EDT");
    expect(out.html).toContain("expires Tuesday, September 8, 2026 at 9:00 AM EDT");
    expect(out.text).not.toContain("72");
    // No relative wording anywhere: that is the shape that went false on a
    // delayed send.
    expect(out.text).not.toMatch(/expires in \d+/);
  });

  it("escapes the URL", () => {
    const out = build({ invitationUrl: 'https://h/w/T"><script>alert(1)</script>' });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("is a pure function — same inputs, byte-identical output", () => {
    // The property the retired "no studio-derived value" rule was really
    // protecting. It holds for ANY input, including a studio name: what the
    // event-only idempotency key needs is that one invocation's payload does
    // not change under it, and a pure builder gives that unconditionally.
    expect(build()).toEqual(build());
  });
});

describe("the templates cannot send, so these tests cannot either", () => {
  it("neither template module imports a provider, a client, or any I/O", () => {
    // Requirement: no real email is sent by tests. The structural half —
    // asserted on the source because that is the only place "this module has
    // no way to reach the network" is visible. The behavioural half is in
    // tests/lib/waitlist/delivery-send.test.ts, where every send injects a
    // recording transport.
    for (const rel of [
      "lib/email/templates/waitlist-invitation.ts",
      "lib/email/templates/waitlist-recipient-proof.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, `${rel} must import nothing`).not.toMatch(/^import\s/m);
      expect(code, `${rel} must not read env`).not.toMatch(/process\.env/);
      expect(code, `${rel} must not reach a provider`).not.toMatch(
        /resend|Resend|fetch\(|sendEmail|transport/,
      );
      expect(code, `${rel} must not touch the filesystem`).not.toMatch(
        /readFileSync|writeFileSync/,
      );
    }
  });
});

describe("waitlist recipient proof email", () => {
  const base = {
    studioName: "Willow",
    code: "H4K2QF7P",
    windowMinutes: 20,
    action: "book" as const,
  };

  it("renders the code the caller supplied, in both bodies", () => {
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("H4K2QF7P");
    expect(out.html).toContain("H4K2QF7P");
  });

  it("NEVER puts the code in the subject", () => {
    // A subject reaches a locked-screen notification and a shared inbox's
    // preview pane. The recipient is already looking at the page that asked
    // for the code, so the usual bank-style trade buys nothing here.
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.subject).toBe("Your Willow confirmation code");
    expect(out.subject).not.toContain(base.code);
  });

  it("NEVER carries the invitation URL — that would rejoin the two factors", () => {
    // The single most important assertion in this file. An email holding both
    // the link and the code is one forward away from handing over the entire
    // authority the split exists to divide.
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).not.toContain(URL);
    expect(out.html).not.toContain(URL);
    expect(out.text).not.toMatch(/https?:\/\//);
    expect(out.html).not.toMatch(/href=/);
  });

  it("states the consequence, and distinguishes decline from book", () => {
    // A proof minted for a decline must not read as a booking confirmation.
    const book = buildWaitlistRecipientProofEmail(base);
    const decline = buildWaitlistRecipientProofEmail({
      ...base,
      action: "decline",
    });
    expect(book.text).toContain("book your consultation with Willow");
    expect(decline.text).toContain("turn down the opening at Willow");
    expect(decline.text).not.toContain("book your consultation");
  });

  it("says an earlier code has stopped working", () => {
    // Mitigation for subject threading: Gmail/Outlook collapse repeated proof
    // emails into one thread and can show a stale one first. The body has to
    // explain the failure the reader is about to hit.
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("any earlier code has already stopped working");
    expect(out.html).toContain("any earlier code has already stopped working");
  });

  it("says the code is single-use and renders the caller's TTL", () => {
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("expires in 20 minutes");
    expect(out.text).toContain("used once");
  });

  it("reassures a recipient who did not request it", () => {
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("nothing will happen without the code");
  });

  it("escapes a studio name that would otherwise inject markup", () => {
    const out = buildWaitlistRecipientProofEmail({
      ...base,
      studioName: '"><img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("&lt;img");
  });
});

describe("minutesPhrase", () => {
  it("renders whole minutes and singularises one", () => {
    expect(minutesPhrase(30)).toBe("30 minutes");
    expect(minutesPhrase(1)).toBe("1 minute");
    expect(minutesPhrase(19.6)).toBe("19 minutes");
  });

  it("never renders a zero or negative window", () => {
    // A proof whose remaining window has already elapsed should read as a
    // vague reassurance, not as "expires in 0 minutes" — which looks broken
    // and invites the recipient to give up rather than request a new code.
    expect(minutesPhrase(0)).toBe("a few minutes");
    expect(minutesPhrase(-5)).toBe("a few minutes");
    expect(minutesPhrase(0.4)).toBe("a few minutes");
    expect(minutesPhrase(Number.NaN)).toBe("a few minutes");
    expect(minutesPhrase(Number.POSITIVE_INFINITY)).toBe("a few minutes");
  });
});
