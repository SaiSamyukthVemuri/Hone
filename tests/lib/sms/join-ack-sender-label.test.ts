import { describe, expect, it } from "vitest";
import { buildWaitlistInvitationSms, buildWaitlistJoinAckSms } from "@/lib/sms/templates";

// SMS-04: the join text's SENDER LABEL (Codex P2 4239889929). The policy is
// recorded in the D3 design review SMS04_JOIN_ACK_SENDER_LABEL_POLICY_D3_REVIEW
// _2026-10-11: the whole text is GSM-7 and fits ONE segment (160 units), the
// approved copy after the label never changes, GSM-7 characters in a name are
// kept as written, unsupported ones are normalized where practical, and a label
// with nothing usable left becomes "Your clinic".
//
// Everything here goes through the public builder only, so these cases ran --
// and failed where the policy was missing -- against the implementation that
// passed the name through with a bare trim().

const SUFFIX =
  ": you've joined our waitlist. We'll contact you when you're invited to book. Reply STOP to opt out.";

// An INDEPENDENT GSM-7 counter (3GPP TS 23.038 default alphabet), written out
// here from the standard's table rather than imported, so the implementation
// is never measured by itself. Basic set: one unit. Extension table: two (ESC
// + the character). Anything else: not GSM-7 at all.
const BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const EXTENSION = "\f^{}\\[~]|€";
function gsm7Units(text: string): number | null {
  let units = 0;
  for (const ch of text) {
    if (BASIC.includes(ch)) units += 1;
    else if (EXTENSION.includes(ch)) units += 2;
    else return null;
  }
  return units;
}

/** The label the builder chose, and the whole body. */
function compose(name: string) {
  const body = buildWaitlistJoinAckSms({ studioName: name });
  expect(body.endsWith(SUFFIX), `the approved copy after the label changed for ${JSON.stringify(name)}`).toBe(true);
  return { body, label: body.slice(0, body.length - SUFFIX.length) };
}

/** I1: GSM-7 throughout, and one segment. */
function expectOneGsm7Segment(name: string) {
  const { body } = compose(name);
  const units = gsm7Units(body);
  expect(units, `not GSM-7 for ${JSON.stringify(name)}: ${JSON.stringify(body)}`).not.toBeNull();
  expect(units!, `more than one segment for ${JSON.stringify(name)}`).toBeLessThanOrEqual(160);
}

describe("the independent GSM-7 counter (the oracle these tests use)", () => {
  it("counts the basic set as 1, the extension table as 2, and refuses everything else", () => {
    expect(gsm7Units(SUFFIX)).toBe(99);
    expect(gsm7Units("Élan")).toBe(4);
    expect(gsm7Units("[a]")).toBe(5);
    expect(gsm7Units("€")).toBe(2);
    expect(gsm7Units("ç")).toBeNull();
    expect(gsm7Units("’")).toBeNull();
    expect(gsm7Units("✨")).toBeNull();
  });
});

describe("the join text's sender label (one GSM-7 segment, the approved copy intact)", () => {
  it("I2: the approved copy, with the full STOP instruction, follows every label unchanged", () => {
    for (const name of ["Willow Electrolysis", "", "✨", "x".repeat(600), "Ava’s Studio", "[a]{b}"]) {
      expect(compose(name).body.endsWith("Reply STOP to opt out.")).toBe(true);
    }
  });

  describe("long names", () => {
    it("a 500-character name is bounded to the 61-unit budget at a word boundary, and the text is one segment", () => {
      const name = Array.from({ length: 100 }, (_, i) => `Word${i}`).join(" ").slice(0, 500);
      const { label } = compose(name);
      expect(gsm7Units(label)!).toBeLessThanOrEqual(61);
      expect(gsm7Units(label)!).toBeGreaterThan(40); // bounded, not discarded
      expect(name.startsWith(label)).toBe(true); // a prefix of the name ...
      expect(name.charAt(label.length)).toBe(" "); // ... cut at a word boundary
      expectOneGsm7Segment(name);
    });

    it("a name of exactly 61 units is kept whole; one unit more is bounded", () => {
      const exact = "A".repeat(61);
      expect(compose(exact).label).toBe(exact);
      expectOneGsm7Segment(exact);
      const over = "Studio " + "B".repeat(55); // 62 units
      expect(gsm7Units(over)).toBe(62);
      expect(compose(over).label).toBe("Studio");
      expectOneGsm7Segment(over);
    });

    it("a single word longer than the budget is cut inside the word rather than lost", () => {
      const word = "C".repeat(80);
      expect(compose(word).label).toBe("C".repeat(61));
      expectOneGsm7Segment(word);
    });
  });

  describe("characters GSM-7 supports are kept exactly as written", () => {
    it("Élan: É is GSM-7, so the name is unchanged", () => {
      expect(compose("Élan Electrolysis").label).toBe("Élan Electrolysis");
      expectOneGsm7Segment("Élan Electrolysis");
    });

    it("Café Crème, Øster Spa, Ñandú is not, but Ñ and ú are judged separately", () => {
      expect(compose("Café Crème").label).toBe("Café Crème");
      expect(compose("Øster Spa").label).toBe("Øster Spa");
      // Ñ is GSM-7 and kept; ú is not, and becomes u.
      expect(compose("Ñandú Skin").label).toBe("Ñandu Skin");
    });
  });

  describe("unsupported characters are normalized where practical", () => {
    it("unsupported accents lose only their accent", () => {
      expect(compose("Hôtel Façade Spa").label).toBe("Hotel Facade Spa");
      expect(compose("Žižek Studio").label).toBe("Zizek Studio");
      expect(compose("Ōtsuka Skin").label).toBe("Otsuka Skin");
      for (const n of ["Hôtel Façade Spa", "Žižek Studio", "Ōtsuka Skin"]) expectOneGsm7Segment(n);
    });

    it("a decomposed accent is composed first, and kept where GSM-7 has it", () => {
      expect(compose("Cafe\u0301").label).toBe("Caf\u00e9"); // e + combining acute -> the composed é
      expectOneGsm7Segment("Cafe\u0301");
    });

    it("typographic punctuation becomes its GSM-7 equivalent", () => {
      expect(compose("Ava’s Studio").label).toBe("Ava's Studio");
      expect(compose("“Glow” Skin – Laser…").label).toBe('"Glow" Skin - Laser...');
      expectOneGsm7Segment("Ava’s Studio");
    });

    it("common Latin letters without an accent form are transliterated", () => {
      expect(compose("Łódź Œuvre Studio").label).toBe("Lodz OEuvre Studio");
    });

    it("emoji are dropped, and the spaces around them collapse", () => {
      expect(compose("Glow ✨ Studio").label).toBe("Glow Studio");
      expect(compose("🌸Bloom🌸").label).toBe("Bloom");
      expectOneGsm7Segment("Glow ✨ Studio");
    });

    it("control characters and odd spaces become single spaces", () => {
      expect(compose("Studio\nName").label).toBe("Studio Name");
      expect(compose("Studio\u00A0\u2009Name\t").label).toBe("Studio Name"); // NBSP, thin space, tab
      expect(compose("Stu\u200Bdio").label).toBe("Studio"); // zero-width space removed
    });
  });

  describe("extension characters are kept, and counted as two units", () => {
    it("[Glow] {Skin} | Laser € keeps every extension character", () => {
      const name = "[Glow] {Skin} | Laser €";
      expect(compose(name).label).toBe(name);
      expectOneGsm7Segment(name);
    });

    it("a name heavy with extension characters is bounded by UNITS, not characters", () => {
      // 51 characters but 77 units: the bare-trim builder sent 150 characters
      // that needed 176 units -- two segments.
      const name = "[a] ".repeat(12) + "{b}";
      expect(name.length).toBeLessThanOrEqual(61);
      expect(gsm7Units(name)).toBeGreaterThan(61);
      const { label } = compose(name);
      expect(gsm7Units(label)!).toBeLessThanOrEqual(61);
      expectOneGsm7Segment(name);
    });
  });

  describe("a blank or unusable label becomes the existing fallback", () => {
    it.each([
      ["empty", ""],
      ["spaces", "   "],
      ["tabs and newlines", "\t\n"],
      ["a zero-width space", "\u200B"],
      ["punctuation only", "---"],
      ["emoji only", "✨🌸"],
      ["another script only", "美容院"],
    ])("%s → Your clinic", (_label, name) => {
      expect(compose(name).label).toBe("Your clinic");
      expectOneGsm7Segment(name);
    });
  });

  it("I1 over a mixed corpus: every input gives GSM-7 in one segment, with the approved copy intact", () => {
    const pieces = ["Élan", "Café", "Façade", "Ōtsuka", "Ava’s", "✨", "美容", "[a]", "{b}", "€", "|", "Spa", " ", "\n", "–", "…"];
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 300; i++) {
      let name = "";
      const parts = next() % 40;
      for (let j = 0; j < parts; j++) name += pieces[next() % pieces.length];
      expectOneGsm7Segment(name);
    }
  });
});

describe("only the join text is governed by this policy", () => {
  it("I6: the invitation text still names the studio exactly as before (unchanged by this repair)", () => {
    const body = buildWaitlistInvitationSms({
      studioName: "Ava’s Studio",
      invitationUrl: "https://hone.care/invitation/t",
      expiresAtLabel: "Mon, Oct 12 at 5:00 PM EDT",
    });
    expect(body.startsWith("Ava’s Studio: you're invited to book a consultation")).toBe(true);
  });
});
