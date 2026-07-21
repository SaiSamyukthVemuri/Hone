import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 Item 8 — regression guard for the three defects the adversarial
// review confirmed in the booking action: a post-commit dispatch that could
// falsely fail a committed booking, and two raw-DB-message leaks to the browser.

const ACTIONS = readFileSync(
  join(process.cwd(), "app/(app)/calendar/actions.ts"),
  "utf8",
);

describe("booking action — post-commit + safe-error hardening (Item 8)", () => {
  it("the post-commit notification dispatch is fail-open (a throw never fails a committed booking)", () => {
    // dispatchBookingEmails must be wrapped so a throwing helper cannot reject
    // the already-committed booking.
    expect(ACTIONS).toMatch(/try \{\s*\n\s*await dispatchBookingEmails\(/);
    expect(ACTIONS).toMatch(/booking_action_post_commit_error:dispatch:/);
  });

  it("no server action returns a raw Postgres/PostgREST message to the browser", () => {
    // No `error: <x>.message`, no `err.message` returned, no `${...message}` copy.
    expect(ACTIONS.match(/error:\s*[\w?.]*\.message/g) ?? []).toEqual([]);
    expect(ACTIONS.match(/err instanceof Error \? err\.message/g) ?? []).toEqual([]);
    expect(ACTIONS.match(/\$\{[^}]*\.message\}/g) ?? []).toEqual([]);
  });

  it("the new-client + last-service helpers log a bounded SQLSTATE and return fixed copy", () => {
    expect(ACTIONS).toMatch(/logBookingDbError\("create_client", "insert", error\?\.code\)/);
    expect(ACTIONS).toMatch(/Could not create the client\. Please try again\./);
    expect(ACTIONS).toMatch(/logBookingDbError\("last_service", "query", error\.code\)/);
    expect(ACTIONS).toMatch(/Could not load the last service\. Please try again\./);
  });
});
