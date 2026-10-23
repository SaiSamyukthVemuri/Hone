import { afterEach, describe, expect, it, vi } from "vitest";

// Codex P2 4355538066 on #1051 (app/book/[slug]/waitlist-actions.ts): on the
// notification-commit bridge there is no durable entry, so the per-join
// subject reference (the email subject sweep) is derived. The provider key on
// that path is a digest of the PAYLOAD, which carries the name, email and
// phone, so two accepted submissions from one address with a different name or
// phone are two emails. They need two subjects. An identical retry is one
// request and keeps one subject. The digest is SALTED (hashFingerprint), so a
// captured subject cannot be confirmed against a guessed submission.

const SUB = { name: "Synthetic Prospect", email: "prospect@synthetic.invalid", phone: "+1-555-0142" };

async function load(salt: string | undefined) {
  vi.resetModules();
  if (salt === undefined) vi.stubEnv("PORTAL_FINGERPRINT_SALT", "");
  else vi.stubEnv("PORTAL_FINGERPRINT_SALT", salt);
  return (await import("@/lib/email/waitlist-reference")).waitlistJoinReference;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("waitlistJoinReference: the notification-commit path (no entry id)", () => {
  it("two distinct submissions from the SAME email get distinct references", async () => {
    const ref = await load("synthetic-salt");
    const base = ref(null, SUB);
    expect(base).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(ref(null, { ...SUB, phone: "+1-555-0143" }), "only the phone differs").not.toBe(base);
    expect(ref(null, { ...SUB, name: "Synthetic Prospect Two" }), "only the name differs").not.toBe(base);
    expect(ref(null, { ...SUB, email: "other@synthetic.invalid" }), "only the email differs").not.toBe(base);
  });

  it("an identical retry keeps the same reference", async () => {
    const ref = await load("synthetic-salt");
    expect(ref(null, { ...SUB })).toBe(ref(null, SUB));
  });

  it("field boundaries cannot be shifted to collide (injective encoding)", async () => {
    const ref = await load("synthetic-salt");
    expect(ref(null, { name: "A B", email: SUB.email, phone: SUB.phone })).not.toBe(
      ref(null, { name: "A", email: SUB.email, phone: ` B${SUB.phone}` }),
    );
  });

  it("is salted: the same submission under another salt gives another reference", async () => {
    const a = (await load("synthetic-salt"))(null, SUB);
    const b = (await load("another-salt"))(null, SUB);
    expect(a).not.toBe(b);
  });

  it("in production with no salt configured it gives NO reference rather than an unsalted digest", async () => {
    // lib/portal/tokens.ts uses a fixed fallback salt outside production; in
    // production a missing salt yields null, and so must the reference.
    vi.stubEnv("NODE_ENV", "production");
    const ref = await load(undefined);
    expect(ref(null, SUB)).toBeNull();
  });
});

describe("waitlistJoinReference: the durable path", () => {
  it("is decided by the entry id alone", async () => {
    const ref = await load("synthetic-salt");
    expect(ref("entry-1", SUB)).toBe(ref("entry-1", { ...SUB, phone: "+1-555-0143" }));
    expect(ref("entry-1", SUB)).not.toBe(ref("entry-2", SUB));
  });
});

describe("the action uses it on every join email", () => {
  it("passes the whole submission, never the email fingerprint", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/book/[slug]/waitlist-actions.ts", "utf8");
    const calls = [...src.matchAll(/waitlistJoinReference\(([^)]*)\)/g)].map((m) => m[1]);
    // client acknowledgement (either path), durable owner notice, bridge owner notice
    expect(calls).toEqual(["eventScope, submission", "entryId, submission", "null, submission"]);
    expect(src).not.toMatch(/waitlistJoinReference\([^)]*emailFingerprint/);
  });
});
