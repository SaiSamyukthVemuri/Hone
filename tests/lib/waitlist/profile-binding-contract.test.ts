import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COMPLETION_REFUSALS,
  NO_PROFILE_ADAPTER,
  WAIT_04B_PREREQUISITES,
} from "@/lib/waitlist/profile-binding-contract";

const SOURCE = readFileSync(
  path.join(process.cwd(), "lib/waitlist/profile-binding-contract.ts"),
  "utf8",
);

/** Comments stripped, so a rule NAMED in prose cannot satisfy a scan for it. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("the binding contract describes a binding — it is not one", () => {
  const body = code(SOURCE);

  it("NON-VACUITY — stripping comments leaves real code", () => {
    // This file is comment-heavy; a stripper that ate everything would make
    // every assertion below pass trivially.
    expect(body).toContain("export interface WaitlistProfileAdapter");
    expect(body).toContain("joinWithProfile");
    expect(body.length).toBeGreaterThan(600);
  });

  it("imports no database client of any kind", () => {
    for (const forbidden of [
      "@/lib/supabase",
      "supabase-js",
      "createAdminClient",
      "createClient",
      "server-only",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("names no RPC, table or SQL", () => {
    expect(body).not.toMatch(/\.rpc\(|\.from\(|insert\s+into|update\s+public\./i);
    expect(body).not.toMatch(/new_client_waitlist_entries/);
  });

  it("declares no executable command — every member is a TYPE", () => {
    // An interface method is a signature; a function body would be an
    // implementation. There is no `async function` and no `await` here.
    expect(body).not.toMatch(/\basync\s+function\b/);
    expect(body).not.toMatch(/\bawait\b/);
  });

  it("ships UNBOUND", () => {
    expect(NO_PROFILE_ADAPTER).toBeNull();
  });
});

describe("the refusal vocabulary cannot become an oracle", () => {
  it("has ONE code for every unusable token", () => {
    // Invalid, revoked, expired and already-completed must be
    // indistinguishable: "this token was valid but already used" is itself a
    // disclosure about a named person.
    expect(COMPLETION_REFUSALS).toContain("not_authorized");
    for (const leaky of [
      "token_expired",
      "token_revoked",
      "already_completed",
      "entry_not_found",
      "unknown_entry",
    ]) {
      expect(COMPLETION_REFUSALS as ReadonlyArray<string>).not.toContain(leaky);
    }
  });

  it("never names which field was invalid", () => {
    expect(COMPLETION_REFUSALS).toContain("invalid_submission");
    for (const leaky of ["invalid_email", "invalid_mobile", "invalid_area"]) {
      expect(COMPLETION_REFUSALS as ReadonlyArray<string>).not.toContain(leaky);
    }
  });

  it("marks exactly one refusal as worth retrying", () => {
    expect(COMPLETION_REFUSALS).toContain("unavailable");
  });
});

describe("the WAIT-04B checklist is complete", () => {
  it("names the four things WAIT-04A could not do", () => {
    expect(WAIT_04B_PREREQUISITES).toContain("profile_columns");
    expect(WAIT_04B_PREREQUISITES).toContain("availability_authority_0193");
    expect(WAIT_04B_PREREQUISITES).toContain("completion_capability_0193");
    // The one that gates sending at all.
    expect(WAIT_04B_PREREQUISITES).toContain("inbound_stop_reaches_entries");
  });
});
