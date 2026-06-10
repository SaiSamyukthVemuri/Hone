import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #189 (OAuth bypass closure). Migration 0081 removes
// handle_new_user()'s no-invite fallback so an uninvited new auth
// user (reachable via Google OAuth, which cannot pass
// shouldCreateUser) gets NO studio and NO practitioner row. The
// invited path must remain byte-equivalent to the 0027 behavior,
// including the terms/privacy acceptance stamping.

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/0081_invite_only_handle_new_user.sql",
  ),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}
const SQL = codeOnly(MIGRATION);

describe("0081: uninvited users get nothing", () => {
  it("the function no longer inserts into studios at all", () => {
    expect(SQL).not.toMatch(/insert into public\.studios/);
  });

  it("no fallback studio names remain", () => {
    expect(SQL).not.toMatch(/'My Studio'/);
  });

  it("there is no else branch creating an owner practitioner", () => {
    expect(SQL).not.toMatch(/'owner'/);
    expect(SQL).not.toMatch(/new_studio_id/);
  });

  it("exactly one practitioners insert exists: the invited arm", () => {
    const inserts = SQL.match(/insert into public\.practitioners/g) ?? [];
    expect(inserts.length).toBe(1);
    expect(SQL).toMatch(/if found then[\s\S]*insert into public\.practitioners/);
  });
});

describe("0081: invited path preserved exactly", () => {
  it("matches the pending invitation case-insensitively", () => {
    expect(SQL).toMatch(
      /where lower\(email\) = lower\(new\.email\) and status = 'pending'/,
    );
  });

  it("places the practitioner in the INVITING studio with the invited role", () => {
    expect(SQL).toMatch(/invitation\.studio_id, new\.id,/);
    expect(SQL).toMatch(/new\.email, invitation\.role, true,/);
  });

  it("keeps the 0027 terms/privacy acceptance stamping", () => {
    expect(SQL).toMatch(/terms_accepted_at, terms_version,/);
    expect(SQL).toMatch(/privacy_accepted_at, privacy_version/);
    expect(SQL).toMatch(/acceptance_version text := '2026-05-22';/);
  });

  it("still marks the invitation accepted", () => {
    expect(SQL).toMatch(
      /set status = 'accepted', accepted_at = now\(\)\s*\n?\s*where id = invitation\.id;/,
    );
  });
});

describe("0081: function posture", () => {
  it("remains SECURITY DEFINER with a locked search_path and no dynamic SQL", () => {
    expect(SQL).toMatch(/security definer\s*\nset search_path = public/);
    expect(SQL).not.toMatch(/execute\s+format|execute\s+'/i);
  });

  it("still returns new so auth user creation itself is not blocked", () => {
    expect(SQL).toMatch(/return new;/);
  });

  it("does not drop or recreate the trigger (binding from 0007 stays)", () => {
    expect(SQL).not.toMatch(/create trigger|drop trigger/);
  });

  it("no payment / Stripe surface", () => {
    expect(SQL).not.toMatch(/stripe|payment_charge|manual_fee/i);
  });
});
