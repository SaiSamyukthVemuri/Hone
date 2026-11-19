import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// B8 / 0177 — the postcare surface is completed-only.
//
// The DATABASE is the authority: claim_postcare_send refuses any status other
// than 'completed', proved behaviourally in
// tests/db/postcare-write-boundary.db.test.ts (T5/T6/T7). These assertions are
// about the SURFACE — offering an enabled Send that the command will refuse is
// a worse experience than not offering it, and a UI that contradicts the
// boundary is how the next reader concludes the boundary is optional.
//
// Asserted at source because PostcareSection is a server component composed of
// other server components; the property under test is which branch renders for
// which status, and the branch structure is what encodes it.

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SECTION = "components/appointment/postcare-section.tsx";
const CALENDAR = "app/(app)/calendar/[id]/page.tsx";
const SESSION = "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx";

describe("B8 — PostcareSection gates the send control on completion", () => {
  const src = read(SECTION);
  // CODE ONLY. The component deliberately DOCUMENTS the old `!= null` bug so
  // the next reader knows why the branch looks the way it does — and a naive
  // grep cannot tell that prose from a live condition. Asserting the absence of
  // a pattern must therefore read code, not comments.
  const code = src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\{?\/\*/.test(l))
    .join("\n");

  it("REQUIRES a server-derived appointmentStatus", () => {
    // Required, not optional. An optional prop makes `undefined` mean "no
    // opinion", so a future mount that simply omits it would silently restore
    // the pre-B8 behaviour — and TypeScript would not complain.
    expect(src).toMatch(/appointmentStatus: string \| null;/);
    expect(src, "the prop must not be optional").not.toMatch(/appointmentStatus\?:/);
  });

  it("renders the completed-only explanation instead of the send control", () => {
    expect(src).toMatch(/data-testid="postcare-not-completed"/);
    expect(src).toMatch(/Available after the appointment is completed\./);
  });

  it("the not-completed branch precedes the send control", () => {
    // Ordering IS the gate here: a branch placed after the send fragment would
    // never be reached for a non-completed appointment.
    const gate = src.indexOf('data-testid="postcare-not-completed"');
    const button = src.indexOf("<PostcareSendButton");
    expect(gate).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(-1);
    expect(gate, "the completed-only branch must come before the send button").toBeLessThan(
      button,
    );
  });

  it("only 'completed' reaches the send control — and NULL does not escape", () => {
    // THE GAP THIS TEST MISSED ONCE. An earlier branch read
    // `appointmentStatus != null && appointmentStatus !== "completed"`, which
    // let a NULL status fall through to an enabled Send. The old assertion
    // still passed, because it merely checked that the substring
    // `!== "completed"` appeared somewhere — it never examined what else
    // guarded the branch. Checking for a fragment is not checking a condition.
    expect(src).toMatch(/props\.appointmentStatus !== "completed"/);
    expect(
      code,
      "a `!= null` guard would let an unresolved status reach the send control",
    ).not.toMatch(/appointmentStatus != null/);
    expect(code).not.toMatch(/appointmentStatus !== null/);
    expect(code).not.toMatch(/appointmentStatus \?\? "completed"/);
    expect(code).not.toMatch(/appointmentStatus === "confirmed"/);
    expect(code).not.toMatch(/appointmentStatus !== "cancelled"/);
  });

  it("a NULL status FAILS CLOSED, and is not inferred from anything else", () => {
    // The session page passes `apptContext?.status ?? null`, so a failed
    // context read yields null. That must mean "no send button", never
    // "assume finished". And the status must not be reconstructed from
    // sent_at or any other proxy.
    const gate = code.match(/aftercareConfigured && props\.appointmentStatus !== "completed"/);
    expect(gate, "the gate must be a bare inequality with no null exemption").not.toBeNull();
    // The status must not be reconstructed from a proxy. Scoped to the gate's
    // own line rather than the whole file, where the props list legitimately
    // mentions both names.
    const gateLine = code.split("\n").find((l) => l.includes('appointmentStatus !== "completed"')) ?? "";
    expect(gateLine).not.toMatch(/postcareEmailSentAt|sent_at/);
  });

  it("configuration and no-email states still take precedence", () => {
    // A studio that has not configured postcare, or a client with no email,
    // should be told THAT — not told to come back after completing the visit
    // and only then discover the real problem.
    const noEmail = src.indexOf('data-testid="postcare-no-client-email"');
    const gate = src.indexOf('data-testid="postcare-not-completed"');
    expect(noEmail).toBeGreaterThan(-1);
    expect(noEmail, "no-email state is reported first").toBeLessThan(gate);
    // The completed-only branch is guarded by aftercareConfigured, so an
    // unconfigured studio falls through to its own explanation.
    expect(src).toMatch(/aftercareConfigured && props\.appointmentStatus !== "completed"/);
  });
});

describe("B8 — both mount points pass the authoritative status", () => {
  it.each([
    [CALENDAR, /appointmentStatus=\{typedStatus\}/],
    [SESSION, /appointmentStatus=\{apptContext\?\.status \?\? null\}/],
  ])("%s forwards a server-derived status", (file, pattern) => {
    const src = read(file);
    expect(src).toMatch(/<PostcareSection/);
    expect(src, `${file} must pass appointmentStatus`).toMatch(pattern);
  });

  it("the calendar page no longer claims status is not a gate", () => {
    // That comment was true before B8 and is false now. Two contradictory
    // architectural stories in one file is how the next reader picks the wrong
    // one.
    const src = read(CALENDAR);
    expect(src).not.toMatch(/Status is NOT a gate/);
    expect(src).toMatch(/postcare is\s*\n?\s*completed-only/);
  });
});
