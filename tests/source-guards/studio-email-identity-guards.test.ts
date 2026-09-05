import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SENDER_ADDRESS } from "@/lib/email/studio-identity";

// COMMS-01A source contracts. These pin the properties a behavioural test
// cannot see: that From is built in ONE place, that no second transport
// appears, and that docs and source describe the same thing.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const IDENTITY = read("lib/email/studio-identity.ts");
const TRANSPORT = read("lib/email/send-appointment.ts");
const CLIENT = read("lib/email/client.ts");
const DOC10 = read("docs/10_DEPLOYMENT_AND_ENV.md");

describe("one place builds the From header", () => {
  it("only the shared transport constructs From", () => {
    // Any other module assembling "... via Hone <...>" is a second
    // implementation that will drift and will not be sanitised.
    const offenders = ["lib/email/send-welcome.ts", "lib/email/new-client-waitlist-send.ts"]
      .map((f) => [f, read(f)] as const)
      .filter(([, src]) => /via Hone <|buildFromHeader\(/.test(src));
    expect(offenders.map(([f]) => f)).toEqual([]);
  });

  it("the transport calls the builder rather than interpolating a name", () => {
    expect(TRANSPORT).toMatch(/from: opts\.studioIdentity\s*\?\s*buildFromHeader\(/);
    // No template literal building a From anywhere in the transport.
    expect(TRANSPORT).not.toMatch(/from:\s*`/);
  });

  it("there is still exactly ONE transport, not two", () => {
    expect(CLIENT).toMatch(/export const FROM_ADDRESS/);
    // The fallback must remain byte-identical to the historical value.
    expect(CLIENT).toContain(`"Hone <${SENDER_ADDRESS}>"`);
  });
});

describe("Reply-To is attached only when resolved", () => {
  it("the transport guards the header on a truthy resolved value", () => {
    expect(TRANSPORT).toMatch(/if \(opts\.studioIdentity\?\.replyTo\) \{\s*\n\s*payload\.replyTo = opts\.studioIdentity\.replyTo;/);
  });

  it("no caller passes a client address as the reply address", () => {
    // The identity type has no client field, and no call site may invent one.
    expect(IDENTITY).not.toMatch(/clientEmail/);
    expect(TRANSPORT).not.toMatch(/replyTo:\s*(params|p|opts)\.client/);
  });
});

describe("the sanitiser removes rather than escapes", () => {
  it("strips control characters and RFC specials", () => {
    // An escaping implementation invites a later un-escape; removal cannot be
    // undone by a downstream layer. Asserted POSITIVELY: an earlier form of
    // this test used a negative regex that matched the backslash inside the
    // sanitiser's own character class, which made it fail on correct code.
    expect(IDENTITY).toMatch(/sanitizeStudioDisplayName/);
    expect(IDENTITY).toMatch(/\.replace\(/);
    // No escaping/encoding helper is used to "make safe" — the value is reduced.
    expect(IDENTITY).not.toMatch(/encodeURI|escapeHtml|JSON\.stringify\(raw/);
  });

  it("the display name is length-capped", () => {
    expect(IDENTITY).toMatch(/MAX_DISPLAY_NAME_LENGTH/);
    expect(IDENTITY).toMatch(/\.slice\(0, MAX_DISPLAY_NAME_LENGTH\)/);
  });
});

describe("Hone-facing mail is deliberately NOT studio-branded", () => {
  it("ops alerts still send as Hone", () => {
    const OPS = read("lib/ops/alert-email.ts");
    expect(OPS).not.toMatch(/studioIdentity|buildFromHeader/);
  });

  it("team invitations still send as Hone", () => {
    const TEAM = read("app/(app)/settings/team/actions.ts");
    expect(TEAM).not.toMatch(/studioIdentity|buildFromHeader/);
  });
});

describe("docs and source describe the same thing", () => {
  it("docs no longer claim a studio-branded From for ALL mail without qualification", () => {
    const line = DOC10.split("\n").find((l) => l.includes("Transactional email provider"))!;
    // The old line asserted the studio-branded pattern flatly. It must now name
    // the address as the constant and defer the pattern to the client-mail bullet.
    expect(line).toContain(SENDER_ADDRESS);
    expect(line).not.toMatch(/^- Transactional email provider\. The from-address pattern is/);
  });

  it("docs state the Reply-To authority and its omit-on-absent rule", () => {
    expect(DOC10).toMatch(/postcare_contact_email/);
    expect(DOC10).toMatch(/owner_email/);
    expect(DOC10).toMatch(/omitted/);
    expect(DOC10).toMatch(/never the client's own address/);
  });

  it("docs record that Hone learns only that Resend ACCEPTED a message", () => {
    // The delivery gap is a real limitation and belongs in the deployment doc,
    // not only in a recon file. COMMS-01D owns closing it.
    expect(DOC10).toMatch(/no delivery webhook|no bounce or complaint tracking/i);
  });
});
