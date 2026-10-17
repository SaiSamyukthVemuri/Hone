import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FALLBACK_DISPLAY_NAME,
  MAX_DISPLAY_NAME_LENGTH,
  SENDER_ADDRESS,
  buildFromHeader,
  isSafeReplyToAddress,
  resolveReplyTo,
  sanitizeStudioDisplayName,
  studioClientContactEmail,
  studioEmailIdentity,
} from "@/lib/email/studio-identity";

// COMMS-01A. Studio-branded sender identity.
//
// A client of External Studio #1 has never heard of "Hone". Mail arriving from
// an unrecognised brand, which replies to Hone rather than the studio, is the
// first impression. These pin the fix AND the ways it must refuse.

describe("From header", () => {
  it("brands the studio while keeping Hone's verified address", () => {
    expect(buildFromHeader("Willow Electrolysis")).toBe(
      "Willow Electrolysis via Hone <hello@hone.care>",
    );
  });

  it("studio A and studio B never share an identity", () => {
    expect(buildFromHeader("Studio A")).toBe("Studio A via Hone <hello@hone.care>");
    expect(buildFromHeader("Studio B")).toBe("Studio B via Hone <hello@hone.care>");
  });

  it("falls back to today's EXACT value when there is no usable name", () => {
    // Not " via Hone", not "undefined via Hone". Indistinguishable from current
    // behaviour, so a nameless studio is never worse off than before.
    const expected = `${FALLBACK_DISPLAY_NAME} <${SENDER_ADDRESS}>`;
    for (const v of [null, undefined, "", "   ", "\n", "<<>>", 42 as unknown as string]) {
      expect(buildFromHeader(v as string | null)).toBe(expected);
    }
  });

  it("the address is never per-studio", () => {
    for (const n of ["A", "evil@attacker.test", "x <a@b.co>"]) {
      const from = buildFromHeader(n);
      expect(from.endsWith(`<${SENDER_ADDRESS}>`)).toBe(true);
      expect(from.match(/</g) ?? []).toHaveLength(1); // exactly one address
    }
  });
});

describe("header injection cannot survive the sanitiser", () => {
  const attacks: Array<[string, string]> = [
    ["newline", "Evil\nBcc: attacker@evil.test"],
    ["CRLF", "Evil\r\nBcc: attacker@evil.test"],
    ["bare CR", "Evil\rBcc: attacker@evil.test"],
    ["angle brackets", "Evil <attacker@evil.test>"],
    ["double quotes", 'Evil" <attacker@evil.test> "'],
    ["comma (multi-address)", "Evil, attacker@evil.test"],
    ["semicolon + colon", "Evil; Bcc: attacker@evil.test"],
    ["NUL", "Evil\u0000Bcc: x@y.test"],
    ["C1 control", "Evil\u0085Bcc: x@y.test"],
    ["backslash", "Evil\\ attacker"],
    ["square brackets", "Evil [attacker@evil.test]"],
  ];

  for (const [name, raw] of attacks) {
    it(`neutralises ${name}`, () => {
      const from = buildFromHeader(raw);
      // ONE line, ONE address, no second header anywhere.
      expect(from).not.toMatch(/[\r\n]/);
      expect(from.toLowerCase()).not.toContain("bcc:");
      expect(from).not.toContain("attacker@evil.test");
      expect(from.match(/</g) ?? []).toHaveLength(1);
      expect(from.endsWith(`<${SENDER_ADDRESS}>`)).toBe(true);
    });
  }

  it("caps a very long name", () => {
    const from = buildFromHeader("W".repeat(500));
    const display = from.slice(0, from.indexOf(" <"));
    expect(display.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME_LENGTH + " via Hone".length);
    expect(from).not.toMatch(/[\r\n]/);
  });

  it("keeps legitimate unicode readable rather than mangling it", () => {
    // A studio called "Beauté Böhm 美容" is a real name, not an attack.
    expect(sanitizeStudioDisplayName("Beauté Böhm 美容")).toBe("Beauté Böhm 美容");
    expect(buildFromHeader("Beauté Böhm 美容")).toBe("Beauté Böhm 美容 via Hone <hello@hone.care>");
  });

  it("collapses whitespace instead of leaving a ragged header", () => {
    expect(sanitizeStudioDisplayName("  Willow   \t Electrolysis  ")).toBe("Willow Electrolysis");
  });
});

describe("Reply-To is derived, never invented", () => {
  it("accepts a plausible studio address", () => {
    expect(resolveReplyTo("hello@willowelectrolysis.ca")).toBe("hello@willowelectrolysis.ca");
    expect(resolveReplyTo("  hello@studio.co.uk  ")).toBe("hello@studio.co.uk");
  });

  it("returns null rather than a fabricated address", () => {
    for (const v of [null, undefined, "", "   ", "not-an-email", "@nodomain.test", "a@b", "a@b.c"]) {
      expect(resolveReplyTo(v as string | null), String(v)).toBeNull();
    }
  });

  it("rejects every header-injection shape", () => {
    for (const v of [
      "a@b.test\nBcc: evil@x.test",
      "a@b.test\r\nBcc: evil@x.test",
      "a@b.test, evil@x.test",
      "a@b.test; evil@x.test",
      "<a@b.test>",
      'a@b.test" ',
      "a b@c.test",
      "a@b.test\u0000",
    ]) {
      expect(isSafeReplyToAddress(v), v).toBe(false);
      expect(resolveReplyTo(v)).toBeNull();
    }
  });

  it("rejects an absurdly long address", () => {
    expect(isSafeReplyToAddress(`${"a".repeat(250)}@b.test`)).toBe(false);
  });
});

describe("the studio contact authority", () => {
  it("prefers the explicit contact over the owner address", () => {
    expect(
      studioClientContactEmail({
        postcare_contact_email: "front-desk@studio.test",
        owner_email: "owner@studio.test",
      }),
    ).toBe("front-desk@studio.test");
  });

  it("falls back to the owner address", () => {
    expect(
      studioClientContactEmail({ postcare_contact_email: null, owner_email: "owner@studio.test" }),
    ).toBe("owner@studio.test");
  });

  it("returns null when neither is set — the caller must omit the header", () => {
    expect(studioClientContactEmail({ postcare_contact_email: "  ", owner_email: null })).toBeNull();
  });

  it("NEVER uses the client's address", () => {
    // There is no parameter for it, and that is the point: a client's reply
    // must never be routed back to the client.
    const id = studioEmailIdentity({ name: "S", postcare_contact_email: null, owner_email: null });
    expect(id.replyTo).toBeNull();
  });
});

describe("end-to-end identity, per studio", () => {
  it("builds a complete branded identity", () => {
    const id = studioEmailIdentity({
      name: "Willow Electrolysis",
      postcare_contact_email: null,
      owner_email: "willow@studio.test",
    });
    expect(buildFromHeader(id.displayName)).toBe("Willow Electrolysis via Hone <hello@hone.care>");
    expect(id.replyTo).toBe("willow@studio.test");
  });

  it("cross-studio values never mix", () => {
    const a = studioEmailIdentity({ name: "Studio A", owner_email: "a@a.test" });
    const b = studioEmailIdentity({ name: "Studio B", owner_email: "b@b.test" });
    expect(buildFromHeader(a.displayName)).toContain("Studio A");
    expect(buildFromHeader(a.displayName)).not.toContain("Studio B");
    expect(a.replyTo).toBe("a@a.test");
    expect(b.replyTo).toBe("b@b.test");
  });

  it("a studio with an unusable contact gets branding but NO Reply-To", () => {
    const id = studioEmailIdentity({ name: "Studio C", owner_email: "not-an-email" });
    expect(buildFromHeader(id.displayName)).toBe("Studio C via Hone <hello@hone.care>");
    expect(id.replyTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COMMS-01A round 2. Two same-family defects, both about WHO reads the mail.
// ---------------------------------------------------------------------------

describe("one helper, two recipients — identity follows the reader", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/email/send-appointment.ts"),
    "utf8",
  );

  it("cancellation branding is gated on isClient, not applied unconditionally", () => {
    // sendCancellationEmail serves BOTH the client and the studio owner. The
    // public cancel flow calls it with isClient:false for the owner; branding
    // that made the owner receive mail apparently from their own studio, with
    // replies routed to their own postcare inbox.
    expect(SRC).toMatch(/studioIdentity: params\.isClient\s*\n?\s*\?\s*identityFor\(params\.studio\)\s*\n?\s*:\s*undefined/);
    // The unconditional form must not come back.
    expect(SRC).not.toMatch(/studioIdentity: identityFor\(params\.studio\),\s*\n\s*to: params\.to,/);
  });
});

describe("the waitlist client acknowledgement is client-facing", () => {
  const TRANSPORT = readFileSync(
    join(process.cwd(), "lib/email/new-client-waitlist-send.ts"),
    "utf8",
  );
  const CALLER = readFileSync(
    join(process.cwd(), "app/book/[slug]/waitlist-actions.ts"),
    "utf8",
  );

  it("the second transport accepts and applies studio identity", () => {
    expect(TRANSPORT).toMatch(/studioIdentity\?: StudioEmailIdentity/);
    expect(TRANSPORT).toMatch(/from: args\.studioIdentity\s*\n?\s*\?\s*buildFromHeader\(/);
  });

  it("IDEMPOTENCY IS PRESERVED: a payload without Reply-To serializes as before", () => {
    // The key is derived from the payload. Appending replyTo unconditionally
    // would have re-keyed every studio-notification send ever minted.
    expect(TRANSPORT).toMatch(/if \(p\.replyTo\) fields\.push\(p\.replyTo\);/);
    const canon = TRANSPORT.slice(TRANSPORT.indexOf("function canonicalPayload"));
    expect(canon).toMatch(/\[p\.from, p\.to, p\.subject, p\.html, p\.text\]/);
  });

  it("the client acknowledgement passes identity; the studio notification does not", () => {
    const clientCall = CALLER.slice(CALLER.indexOf('namespace: "client"') - 400, CALLER.indexOf('namespace: "client"'));
    expect(clientCall).toMatch(/studioIdentity/);
    // Both studio-notification sends stay unbranded.
    for (const idx of [CALLER.indexOf('namespace: "studio"'), CALLER.lastIndexOf('namespace: "studio"')]) {
      const studioCall = CALLER.slice(idx - 220, idx);
      expect(studioCall).not.toMatch(/studioIdentity/);
    }
  });
});

// ---------------------------------------------------------------------------
// COMMS-01A repair round. Two defects, both in the CLIENT-MAIL class:
//
//   1. a syntactically unusable Reply-To could reach the transport, where the
//      provider may reject the WHOLE transactional email rather than drop one
//      header. A bad reply address must cost the reply path, never the message.
//   2. precedence read "first NON-BLANK", so an unusable postcare address
//      masked a perfectly good owner address and the studio's replies went to
//      Hone -- the exact outcome this module exists to prevent.
// ---------------------------------------------------------------------------

describe("P2-1 an unusable Reply-To costs the header, never the email", () => {
  it("accepts an ordinary address", () => {
    expect(isSafeReplyToAddress("front.desk@studio.test")).toBe(true);
    expect(resolveReplyTo("front.desk@studio.test")).toBe("front.desk@studio.test");
  });

  it("trims surrounding whitespace rather than rejecting", () => {
    expect(resolveReplyTo("  front.desk@studio.test  ")).toBe("front.desk@studio.test");
    expect(resolveReplyTo("\r\nfront.desk@studio.test")).toBe("front.desk@studio.test");
  });

  it.each([
    ["colon in local part", "front:desk@studio.test"],
    ["leading dot", ".frontdesk@studio.test"],
    ["doubled dot", "front..desk@studio.test"],
    ["trailing dot in local", "frontdesk.@studio.test"],
    ["no local part", "@studio.test"],
    ["no domain", "frontdesk@"],
    ["no dot in domain", "frontdesk@studio"],
    ["numeric TLD", "frontdesk@studio.1"],
    ["hyphen-led label", "frontdesk@-studio.test"],
    ["hyphen-tail label", "frontdesk@studio-.test"],
    ["non-ASCII domain", "frontdesk@st\u00fcdio.test"],
    ["two addresses, comma", "a@x.test, b@y.test"],
    ["two addresses, semicolon", "a@x.test; b@y.test"],
    ["angle-addr display name", "Front Desk <front@studio.test>"],
    ["bare display name", "Front Desk"],
    ["CR injection", "a@x.test\rBcc: evil@y.test"],
    ["LF injection", "a@x.test\nBcc: evil@y.test"],
    ["NUL injection", "a@x.test\u0000"],
    ["two at-signs", "a@b@x.test"],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects %s and omits the header", (_label, value) => {
    expect(isSafeReplyToAddress(value)).toBe(false);
    expect(resolveReplyTo(value)).toBeNull();
  });

  it("treats null and undefined as absent, not as an error", () => {
    expect(resolveReplyTo(null)).toBeNull();
    expect(resolveReplyTo(undefined)).toBeNull();
  });

  it("omitting Reply-To leaves the message itself sendable", () => {
    // The From header is what makes a message sendable; it is derived
    // independently of the reply address, so a refused Reply-To cannot
    // invalidate the send.
    const identity = studioEmailIdentity({
      name: "Studio One",
      postcare_contact_email: "front:desk@studio.test",
      owner_email: null,
    });
    expect(identity.replyTo).toBeNull();
    expect(buildFromHeader(identity.displayName)).toBe(
      `Studio One via Hone <${SENDER_ADDRESS}>`,
    );
  });
});

describe("P2-2 precedence is over VALID authorities, not non-blank strings", () => {
  const V_POST = "care@studio.test";
  const V_OWNER = "owner@studio.test";
  const BAD = "front:desk@studio.test";

  it("valid postcare + valid owner => postcare", () => {
    expect(studioClientContactEmail({ postcare_contact_email: V_POST, owner_email: V_OWNER })).toBe(V_POST);
  });

  it("INVALID postcare + valid owner => owner", () => {
    expect(studioClientContactEmail({ postcare_contact_email: BAD, owner_email: V_OWNER })).toBe(V_OWNER);
  });

  it("blank postcare + valid owner => owner", () => {
    expect(studioClientContactEmail({ postcare_contact_email: "   ", owner_email: V_OWNER })).toBe(V_OWNER);
    expect(studioClientContactEmail({ postcare_contact_email: null, owner_email: V_OWNER })).toBe(V_OWNER);
  });

  it("valid postcare + invalid owner => postcare", () => {
    expect(studioClientContactEmail({ postcare_contact_email: V_POST, owner_email: BAD })).toBe(V_POST);
  });

  it("both invalid or absent => no Reply-To", () => {
    expect(studioClientContactEmail({ postcare_contact_email: BAD, owner_email: BAD })).toBeNull();
    expect(studioClientContactEmail({ postcare_contact_email: null, owner_email: null })).toBeNull();
    expect(studioEmailIdentity({ name: "S", postcare_contact_email: BAD, owner_email: BAD }).replyTo).toBeNull();
  });

  it("resolves only from the row it is given, so no cross-studio address is reachable", () => {
    // The helper takes a studio row and reads two of ITS OWN columns. There is
    // no id, no lookup and no ambient context, so another studio's contact
    // address is not expressible through this API.
    const a = studioEmailIdentity({ name: "A", postcare_contact_email: "a@a.test", owner_email: "owner@a.test" });
    const b = studioEmailIdentity({ name: "B", postcare_contact_email: null, owner_email: "owner@b.test" });
    expect(a.replyTo).toBe("a@a.test");
    expect(b.replyTo).toBe("owner@b.test");
    expect(studioClientContactEmail.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round two. Both defects were CLIENT-MAIL TRUTH defects:
//   * an over-long DNS label passed validation, so a Reply-To that cannot
//     resolve could still reach the transport -- the same "provider may reject
//     the whole message" failure the first round set out to close;
//   * the postcare preview re-implemented "first non-blank" while send-time
//     resolved "first VALID", so the owner saw a Contact address the client
//     never received.
// ---------------------------------------------------------------------------

describe("DNS label bounds — an accepted Reply-To must be resolvable", () => {
  const label = (n: number) => "x".repeat(n);

  it("accepts a 63-octet label", () => {
    expect(isSafeReplyToAddress(`a@${label(63)}.test`)).toBe(true);
  });

  it("rejects a 64-octet label", () => {
    expect(isSafeReplyToAddress(`a@${label(64)}.test`)).toBe(false);
    expect(resolveReplyTo(`a@${label(64)}.test`)).toBeNull();
  });

  it("accepts several ordinary labels", () => {
    expect(isSafeReplyToAddress("front.desk@mail.studio.co.uk")).toBe(true);
  });

  it("rejects an empty label from consecutive dots", () => {
    expect(isSafeReplyToAddress("a@studio..test")).toBe(false);
    expect(isSafeReplyToAddress("a@.studio.test")).toBe(false);
  });

  it("keeps the existing leading/trailing hyphen rule", () => {
    expect(isSafeReplyToAddress("a@-studio.test")).toBe(false);
    expect(isSafeReplyToAddress("a@studio-.test")).toBe(false);
    expect(isSafeReplyToAddress("a@stu-dio.test")).toBe(true);
  });

  it("rejects an over-long domain and an over-long local part", () => {
    const many = Array.from({ length: 5 }, () => label(60)).join(".");
    expect(many.length).toBeGreaterThan(253);
    expect(isSafeReplyToAddress(`a@${many}.test`)).toBe(false);
    expect(isSafeReplyToAddress(`${label(65)}@studio.test`)).toBe(false);
  });

  it("bounds the TLD too", () => {
    expect(isSafeReplyToAddress(`a@studio.${"t".repeat(64)}`)).toBe(false);
  });
});

describe("ONE authority — the preview cannot drift from send-time", () => {
  const PREVIEW = readFileSync(
    join(process.cwd(), "app/(app)/settings/studio/PostcareEditingHelpers.tsx"),
    "utf8",
  );

  it("the preview calls the shared resolver", () => {
    expect(PREVIEW).toContain(
      'import { studioClientContactEmail } from "@/lib/email/studio-identity"',
    );
    expect(PREVIEW).toContain("studioClientContactEmail({");
  });

  it("the preview keeps NO hand-rolled precedence of its own", () => {
    // The defect was a local ternary chain re-deriving postcare -> owner.
    expect(PREVIEW).not.toMatch(/contactEmail\s*&&\s*contactEmail\.trim\(\)\.length\s*>\s*0/);
    expect(PREVIEW).not.toMatch(/ownerFallbackEmail\.trim\(\)\.length\s*>\s*0/);
  });

  it("preview and send-time agree on every precedence case", () => {
    // The preview passes its two props straight through, so agreement is
    // established by the helper being the only decider on both paths.
    const cases: Array<[string | null, string | null, string | null]> = [
      ["care@studio.test", "owner@studio.test", "care@studio.test"],
      ["front:desk@studio.test", "owner@studio.test", "owner@studio.test"],
      ["   ", "owner@studio.test", "owner@studio.test"],
      ["care@studio.test", "front:desk@studio.test", "care@studio.test"],
      ["front:desk@studio.test", "front:desk@studio.test", null],
      [null, null, null],
    ];
    for (const [postcare, owner, expected] of cases) {
      expect(
        studioClientContactEmail({ postcare_contact_email: postcare, owner_email: owner }),
      ).toBe(expected);
    }
  });

  it("exactly one Reply-To validator exists in lib/", () => {
    const SRC = readFileSync(join(process.cwd(), "lib/email/studio-identity.ts"), "utf8");
    expect(SRC.match(/export function isSafeReplyToAddress/g)?.length).toBe(1);
    expect(SRC.match(/const DOMAIN_DOT_ATOM/g)?.length).toBe(1);
  });
});
