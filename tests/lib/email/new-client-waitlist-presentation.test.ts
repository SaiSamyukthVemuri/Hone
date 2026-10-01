import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WAITLIST_SUBJECT_PREFIX,
  buildNewClientWaitlistClientEmail,
  buildNewClientWaitlistStudioEmail,
} from "@/lib/email/templates/new-client-waitlist";

// ===========================================================================
// WAIT-EMAIL-BRAND-01 — the acknowledgement's PRESENTATION contract
// ===========================================================================
//
// Idempotency and key derivation are owned next door in
// new-client-waitlist-idempotency.test.ts. This file owns what the recipient
// actually sees, because that is what the production feedback was about: the
// email was functionally correct and looked like an unfinished system email.
//
// The bar for every assertion here is that it fails when the redesign is
// undone, and does NOT fail when an unrelated word is reworded. So it pins
// structure, hierarchy tokens and the facts — not whole paragraphs.

const STUDIO = "Willow Electrolysis";
const NAME = "Avery Chen";
const client = (over: Partial<{ studioName: string; name: string }> = {}) =>
  buildNewClientWaitlistClientEmail({ studioName: STUDIO, name: NAME, ...over });
const studioEmail = (
  over: Partial<{ studioName: string; name: string; email: string; phone: string | null }> = {},
) =>
  buildNewClientWaitlistStudioEmail({
    studioName: STUDIO,
    name: NAME,
    email: "avery@example.test",
    phone: null,
    ...over,
  });

describe("the subject and sender identity are UNCHANGED", () => {
  it("the client subject is exactly what production already sends", () => {
    // The feedback named the subject and the sender identity as the good
    // parts. This redesign is presentation-only; if it moved the subject it
    // would also move the idempotency key for a reason nobody asked for.
    expect(client().subject).toBe("You're on the waitlist · Willow Electrolysis");
  });

  it("the studio notice keeps its filterable prefix", () => {
    // Operators build inbox rules on this string.
    expect(studioEmail().subject).toBe(
      "[HONE WAITLIST] New client · Willow Electrolysis",
    );
    expect(studioEmail().subject.startsWith(WAITLIST_SUBJECT_PREFIX)).toBe(true);
  });

  it("neither template decides From or Reply-To", () => {
    // Sender identity is the caller's; a template that emitted a From header
    // would be a second owner for it.
    const src = readFileSync(
      join(process.cwd(), "lib/email/templates/new-client-waitlist.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bfrom\s*:/i);
    expect(src).not.toMatch(/replyTo|reply-to/i);
  });
});

describe("the client email adopts the Hone client-email shell", () => {
  // Token-for-token against the contract already shipped by
  // appointment.ts / reminders.ts / portal-magic-link.ts. Asserted as tokens
  // rather than as a golden file so a copy edit does not red the suite.
  const SHELL_TOKENS: ReadonlyArray<[string, string]> = [
    ["page background", "background:#FAFAF7"],
    ["centered 560px shell", "max-width:560px"],
    ["40px/20px page padding", "padding:40px 20px"],
    ["Georgia wordmark size", "font-size:18px"],
    ["Georgia headline size", "font-size:28px"],
    ["primary ink", "color:#0A0A0A"],
    ["secondary copy", "color:#6B6B6B"],
    ["separator rule", "1px solid #E5E2DA"],
    ["table layout, not divs", '<table role="presentation"'],
  ];

  it.each(SHELL_TOKENS)("carries the %s (%s)", (_label, token) => {
    expect(client().html).toContain(token);
  });

  it("opens with the Hone wordmark in Georgia", () => {
    const html = client().html;
    const wordmark = html.indexOf("Georgia, serif; font-weight:700; font-size:18px");
    expect(wordmark).toBeGreaterThan(-1);
    expect(html.slice(wordmark, wordmark + 160)).toContain("Hone");
    // And the wordmark precedes the headline.
    expect(wordmark).toBeLessThan(html.indexOf("font-size:28px"));
  });

  it("is no longer the old bare-div template", () => {
    const html = client().html;
    expect(html).not.toContain('<div style="max-width:560px; margin:0 auto;');
    expect(html).not.toContain("padding:24px; background-color:#FAFAF7");
  });

  it("renders the headline, then greeting, then statement, in that order", () => {
    const html = client().html;
    const headline = html.indexOf("on the waitlist.");
    const greeting = html.indexOf("Hi Avery Chen,");
    const statement = html.indexOf("new-client waitlist for");
    expect(headline).toBeGreaterThan(-1);
    expect(greeting).toBeGreaterThan(headline);
    expect(statement).toBeGreaterThan(greeting);
  });
});

describe("the studio is identified prominently, not buried in a paragraph", () => {
  it("the studio name carries SEMANTIC strong emphasis", () => {
    // The feedback: "Willow identity is buried in paragraph copy." Bold is
    // <strong>, not a font-weight on the whole sentence, so it survives a
    // plain-text or screen-reader rendering as emphasis.
    expect(client().html).toContain(`<strong>${STUDIO}</strong>`);
  });

  it("the footer states the studio, uppercase, above the Hone attribution", () => {
    const html = client().html;
    expect(html).toContain(`${STUDIO} via Hone`);
    const footerIdx = html.lastIndexOf(`${STUDIO} via Hone`);
    expect(html.slice(footerIdx - 300, footerIdx)).toContain("text-transform:uppercase");
  });

  it("the studio appears in BOTH renderings", () => {
    const out = client();
    expect(out.text).toContain(STUDIO);
    expect(out.html).toContain(STUDIO);
  });
});

describe("the structured WHAT HAPPENS NEXT section", () => {
  it("carries the uppercase label in the shared label style", () => {
    const html = client().html;
    const idx = html.indexOf("What happens next");
    expect(idx).toBeGreaterThan(-1);
    const style = html.slice(Math.max(0, idx - 260), idx);
    expect(style).toContain("text-transform:uppercase");
    expect(style).toContain("letter-spacing:0.15em");
    expect(style).toContain("font-size:11px");
  });

  it("states the SAME promise the email has always made, and no more", () => {
    // Truthfulness is the point: no queue position, no response time, no
    // estimated availability, no priority.
    const out = client();
    for (const rendered of [out.text, out.html]) {
      expect(rendered).toContain(
        "contact you when consultation and treatment availability can be offered",
      );
    }
  });

  it.each([
    ["queue position", /\bposition\b|\byou are number\b|\b#\d+\b|\bin line\b/i],
    ["response-time promise", /within \d+|\b\d+ (hours|days|weeks)\b|shortly|soon/i],
    ["priority", /\bpriorit/i],
    ["estimated availability", /\bestimate|\bexpected\b|\blikely\b/i],
    ["marketing", /\bfollow us\b|\bnewsletter\b|\bsocial\b|\bInstagram\b/i],
    ["treatment advice", /\bshave\b|\bavoid\b|\bprepare\b|\bpre-?care\b|\baftercare\b/i],
  ])("makes no %s claim", (_label, forbidden) => {
    const out = client();
    expect(out.text).not.toMatch(forbidden);
    // Strip the inline styles before scanning the HTML, or CSS tokens get
    // read as copy.
    expect(out.html.replace(/style="[^"]*"/g, "")).not.toMatch(forbidden);
  });
});

describe("it still says no appointment exists", () => {
  it("states both facts, as separate lines, in both renderings", () => {
    // Previously one folded sentence. The redesign separates them; the facts
    // are unchanged and both must survive.
    const out = client();
    for (const rendered of [out.text, out.html]) {
      expect(rendered).toContain("No appointment has been booked.");
      expect(rendered).toContain("No appointment time has been reserved.");
    }
  });

  it("implies no booking, reservation or confirmation anywhere", () => {
    const out = client();
    const prose = out.html.replace(/style="[^"]*"/g, "");
    for (const rendered of [out.text, prose]) {
      expect(rendered).not.toMatch(/\bconfirmed\b/i);
      expect(rendered).not.toMatch(/\byour appointment is\b/i);
      expect(rendered).not.toMatch(/\bsee you\b/i);
      // "No appointment has been booked" legitimately contains "booked", so
      // the check is for a POSITIVE booking claim.
      expect(rendered).not.toMatch(/\byou(?:'re| are| have been) booked\b/i);
    }
  });

  it("keeps the no-resubmission reassurance", () => {
    const out = client();
    expect(out.text).toContain("You don't need to submit the waitlist form again.");
    expect(out.html).toContain("need to submit the waitlist form again.");
  });
});

describe("NO call to action is introduced", () => {
  it("contains no link, button or href at all", () => {
    // Deliberate: there is nothing for the recipient to do yet. Every sibling
    // template ends in a button, so the absence has to be pinned or it will be
    // "fixed" by someone matching the pattern.
    const out = client();
    expect(out.html).not.toContain("<a ");
    expect(out.html).not.toContain("href");
    expect(out.html).not.toMatch(/https?:\/\//);
    expect(out.text).not.toMatch(/https?:\/\//);
  });

  it("offers no portal, booking or scheduling affordance", () => {
    const prose = client().html.replace(/style="[^"]*"/g, "");
    for (const rendered of [client().text, prose]) {
      expect(rendered).not.toMatch(/\bbook now\b|\bschedule\b|\bchoose a time\b/i);
      expect(rendered).not.toMatch(/\bportal\b|\bsign in\b|\blog in\b/i);
    }
  });
});

describe("untrusted input is escaped in HTML and left bare in text", () => {
  it("escapes a CLIENT NAME carrying markup", () => {
    const out = client({ name: '<script>alert(1)</script>' });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    // The text branch is not markup; it carries the raw value.
    expect(out.text).toContain("<script>alert(1)</script>");
  });

  it("escapes a STUDIO NAME carrying markup, including inside <strong>", () => {
    const out = client({ studioName: '<img src=x onerror=y>' });
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("<strong>&lt;img src=x onerror=y&gt;</strong>");
  });

  it("escapes quotes and ampersands in both fields", () => {
    const out = client({ name: 'A & B "C"', studioName: "Willow & Co" });
    expect(out.html).toContain("A &amp; B &quot;C&quot;");
    expect(out.html).toContain("<strong>Willow &amp; Co</strong>");
  });

  it("escapes every interpolated field of the STUDIO notice too", () => {
    const out = studioEmail({
      name: "<b>N</b>",
      email: '"e"@x.test',
      phone: "<i>555</i>",
      studioName: "<u>S</u>",
    });
    expect(out.html).not.toMatch(/<(b|i|u)>/);
    expect(out.html).toContain("&lt;b&gt;N&lt;/b&gt;");
    expect(out.html).toContain("&lt;i&gt;555&lt;/i&gt;");
    expect(out.html).toContain("&quot;e&quot;@x.test");
  });

  it("an unescaped field cannot reach the document: the title is escaped too", () => {
    const out = client({ studioName: '"><script>x</script>' });
    const title = out.html.slice(out.html.indexOf("<title>"), out.html.indexOf("</title>"));
    expect(title).not.toContain("<script");
    expect(title).toContain("&quot;&gt;");
  });
});

describe("DETERMINISM — the idempotency key is a digest of these bytes", () => {
  it("the same input renders byte-identical output, every time", () => {
    const a = client();
    const b = client();
    expect(b.subject).toBe(a.subject);
    expect(b.html).toBe(a.html);
    expect(b.text).toBe(a.text);
  });

  it("the studio notice is byte-identical too", () => {
    expect(studioEmail()).toEqual(studioEmail());
  });

  it("neither builder reads a clock, a random source or the environment", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/email/templates/new-client-waitlist.ts"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/Date\.now|new Date|Math\.random|crypto\.|process\.env/);
    expect(code).not.toMatch(/^import\s/m);
  });

  it("different inputs still render different bytes", () => {
    // The control for the determinism assertions: if the builder ignored its
    // input entirely, every test above would still pass.
    expect(client({ name: "Other Person" }).html).not.toBe(client().html);
    expect(client({ studioName: "Other Studio" }).html).not.toBe(client().html);
  });
});

describe("the STUDIO notice conversion is styling-only", () => {
  it("its plain text is unchanged, line for line", () => {
    // The brief allows the studio notice onto the shell ONLY as an exact
    // styling conversion. The text branch is the proof: it carries no styling,
    // so if the copy had widened, it would show here.
    expect(studioEmail({ phone: "555-0100" }).text).toBe(
      [
        "New-client waitlist request",
        "",
        "Name: Avery Chen",
        "Email: avery@example.test",
        "Phone: 555-0100",
        "",
        "This is a waitlist request only.",
        "No appointment has been created.",
      ].join("\n"),
    );
  });

  it("still renders the absent-phone fallback", () => {
    expect(studioEmail({ phone: null }).text).toContain("Phone: Not provided");
    expect(studioEmail({ phone: null }).html).toContain("Not provided");
  });

  it("carries the same shell as the client email", () => {
    const html = studioEmail().html;
    expect(html).toContain("background:#FAFAF7");
    expect(html).toContain("max-width:560px");
    expect(html).toContain('<table role="presentation"');
    expect(html).toContain("font-size:28px");
  });

  it("stays operator-facing: it is attributed to Hone, not to the studio", () => {
    // The studio is the RECIPIENT here, so "<Studio> via Hone" would be
    // addressing them as if they were the client.
    const html = studioEmail().html;
    expect(html).not.toContain(`${STUDIO} via Hone`);
  });
});
