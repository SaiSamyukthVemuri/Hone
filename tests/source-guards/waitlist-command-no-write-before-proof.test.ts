import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vercel Security Review 01M6WR22TXXCQPVTFJB1J98JJM: with WAITLIST_BOOKING_COMMAND=1 the invitation
// capability is proved only INSIDE redeem_and_book_waitlist_invitation. Any write that precedes that
// command can be triggered with a bogus capability and cannot be undone by the later refusal.
// This pins the structure; tests/app/book/waitlist-command-no-write-before-proof.test.ts pins the behaviour.

const FILE = "app/book/[slug]/actions.ts";
const strip = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

/** Reasons the command path writes before proof. Empty = sound. */
export function violations(src: string): string[] {
  const code = strip(src);
  const out: string[] = [];
  const rpc = code.indexOf('invitedCommand\n    ? await admin.rpc("redeem_and_book_waitlist_invitation"');
  const rpcAlt = rpc >= 0 ? rpc : code.search(/invitedCommand\s*\?\s*await admin\.rpc\("redeem_and_book_waitlist_invitation"/);
  if (rpcAlt < 0) return ["command call not found"];

  // 1. The consent stamp has exactly one call site, inside the deferrable closure.
  const calls = [...code.matchAll(/stampPublicBookingConsent\(admin/g)].map((m) => m.index!);
  if (calls.length !== 1) out.push(`stampPublicBookingConsent called ${calls.length} times`);
  const closureStart = code.search(/const stampExistingClientConsent = async \(\)/);
  if (closureStart < 0 || calls.length !== 1 || calls[0] < closureStart) out.push("stamp is not inside the deferrable closure");

  // 2. Pre-command, the closure runs ONLY when the command is not in use.
  if (!/if \(invitedCommand\) deferredConsentStamp = stampExistingClientConsent;\s*else await stampExistingClientConsent\(\);/.test(code)) {
    out.push("the closure can run before the command on the command path");
  }

  // 3. The deferred stamp runs strictly after the command AND after the not-created guard.
  const deferredRun = code.search(/if \(deferredConsentStamp && existingClient && committedClientId === existingClient\.id\) \{\s*await deferredConsentStamp\(\);\s*\}/);
  const createdGuard = code.lastIndexOf("if (rpcErr || !createdId)");
  if (!/if \(deferredConsentStamp && existingClient && committedClientId === existingClient\.id\)/.test(code)) {
    out.push("the deferred stamp is not bound to the committed client (H1)");
  }
  if (deferredRun < 0) out.push("the deferred stamp is never run");
  else if (deferredRun < rpcAlt || deferredRun < createdGuard) out.push("the deferred stamp runs before the booking is known committed");

  // 4. No other write between the action's admin client and the command (the closure body excluded).
  const adminAt = code.search(/const admin = createAdminClient\(\);/);
  let region = code.slice(adminAt, rpcAlt);
  if (closureStart >= adminAt && closureStart < rpcAlt) {
    const end = region.indexOf("deferredConsentStamp = stampExistingClientConsent");
    region = region.slice(0, closureStart - adminAt) + region.slice(end);
  }
  const writes = region.match(/\.(insert|update|upsert|delete)\(|\.rpc\(|stampPublicBookingConsent\(/g) ?? [];
  const allowed = writes.filter((w) => w !== ".rpc(");
  if (allowed.length) out.push(`write(s) before the command: ${allowed.join(",")}`);
  const rpcs = region.match(/\.rpc\(/g) ?? [];
  if (rpcs.length) out.push(`${rpcs.length} rpc call(s) before the command`);
  return out;
}

describe("0313 command path: no write precedes the capability proof", () => {
  const src = readFileSync(FILE, "utf8");

  it("the shipped source is sound", () => {
    expect(violations(src)).toEqual([]);
  });

  // NEGATIVE CONTROLS: the guard must fail on the shape of the original bug.
  it("fails when the stamp is moved back before the command (runs unconditionally)", () => {
    const mutated = src.replace(
      /if \(invitedCommand\) deferredConsentStamp = stampExistingClientConsent;\s*else await stampExistingClientConsent\(\);/,
      "await stampExistingClientConsent();",
    );
    expect(mutated).not.toBe(src);
    expect(violations(mutated).length).toBeGreaterThan(0);
  });

  it("fails when the deferred stamp is run before the not-created guard", () => {
    const runRe = /if \(deferredConsentStamp && existingClient && committedClientId === existingClient\.id\) \{\s*await deferredConsentStamp\(\);\s*\}/;
    const run = src.match(runRe)![0];
    const without = src.replace(runRe, "");
    expect(without).not.toBe(src);
    const early = without.replace("const appointmentToken = generateAppointmentToken();", `${run}\n  const appointmentToken = generateAppointmentToken();`);
    expect(early).not.toBe(without);
    expect(violations(early).length).toBeGreaterThan(0);
  });

  it("fails when the deferred stamp is no longer bound to the committed client (H1)", () => {
    const mutated = src.replace(" && existingClient && committedClientId === existingClient.id", "");
    expect(mutated).not.toBe(src);
    expect(violations(mutated).join(" ")).toContain("committed client");
  });

  it("fails when some other write is added before the command", () => {
    const mutated = src.replace(
      "const appointmentToken = generateAppointmentToken();",
      'await admin.from("clients").update({ x: 1 });\n  const appointmentToken = generateAppointmentToken();',
    );
    expect(mutated).not.toBe(src);
    expect(violations(mutated).join(" ")).toContain("write(s) before the command");
  });
});
