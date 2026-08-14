import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  APPOINTMENT_REMINDER_CRON_SCHEDULE,
  CRON_INTERVAL_MINUTES,
  REMINDER_WINDOW_MINUTES,
  uncoveredOffsets,
} from "@/lib/cron/reminder-schedule";

// ---------------------------------------------------------------------------
// PR OPS-01. Documentation truthfulness guard for the reminder cadence.
//
// The OPS-01 recon found CRON_SETUP.md, deprecated since PR #148 but still
// sitting at the repository root, instructing an operator to configure the
// cron-job.org reminder job "every hour (minute 0)". That is not a stylistic
// drift: an hourly cadence against the 30-minute-wide 2h reminder window
// silently misses 29 of 60 appointment minute offsets. It also claimed the
// SELECT had "NO LIMIT" (actual: PER_RUN_LIMIT = 50) and that vercel.json
// shipped an empty crons array (actual: three registered crons).
//
// The file was DELETED rather than rewritten: every live claim in it is
// already carried by docs/08 + docs/10, and keeping a third source of truth
// for the cadence is precisely how it drifted in the first place.
//
// This guard makes the footgun non-reintroducible.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string =>
  readFileSync(path.join(ROOT, rel), "utf8");

describe("the deleted CRON_SETUP.md footgun cannot come back", () => {
  it("CRON_SETUP.md does not exist", () => {
    expect(existsSync(path.join(ROOT, "CRON_SETUP.md"))).toBe(false);
  });

  it("no doc LINKS to it any more (a tombstone naming it is fine)", () => {
    // "Points readers at it" means a resolvable link, not any mention of the
    // name: docs/15 and docs/08 deliberately name it to record that it was
    // deleted and where its content went, which is the opposite of a footgun.
    // Frozen historical records are exempt: PRE_STRIPE_HARDENING_NOTES.md is a
    // point-in-time review log and docs/audits/** are immutable evidence.
    const exempt = [
      "PRE_STRIPE_HARDENING_NOTES.md",
      path.join("docs", "audits"),
    ];
    // Scoped to the DOCUMENTATION surface, repo-root *.md plus docs/**, not
    // the whole tree. Several other suites already walk the entire repository
    // synchronously; adding one more full-tree scan measurably slowed them and
    // tipped the slowest census tests over their timeouts under a parallel
    // full-suite run. Documentation is where a reader-facing link can live, so
    // this scope loses nothing.
    const offenders: string[] = [];
    const check = (full: string): void => {
      const rel = path.relative(ROOT, full);
      if (exempt.some((e) => rel.startsWith(e))) return;
      // markdown link whose target is the deleted file
      if (/\]\([^)]*CRON_SETUP\.md[^)]*\)/.test(readFileSync(full, "utf8"))) {
        offenders.push(rel);
      }
    };
    const walkDocs = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDocs(full);
        else if (entry.name.endsWith(".md")) check(full);
      }
    };
    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        check(path.join(ROOT, entry.name));
      }
    }
    walkDocs(path.join(ROOT, "docs"));
    expect(offenders).toEqual([]);
  });

  it("the guard would catch a real link (non-vacuity)", () => {
    expect(/\]\([^)]*CRON_SETUP\.md[^)]*\)/.test("see [cron](./CRON_SETUP.md)")).toBe(
      true,
    );
    expect(
      /\]\([^)]*CRON_SETUP\.md[^)]*\)/.test("CRON_SETUP.md was deleted"),
    ).toBe(false);
  });
});

describe("canonical cron docs state the real cadence, never hourly", () => {
  const CANONICAL = [
    "docs/08_EMAIL_SMS_AND_CRON.md",
    "docs/10_DEPLOYMENT_AND_ENV.md",
  ] as const;

  it.each(CANONICAL)("%s names the 15-minute cadence", (rel) => {
    expect(read(rel)).toMatch(/every\s+\*{0,2}15\*{0,2}\s*minutes?/i);
  });

  // The specific regression: an instruction to SET UP the reminder job at an
  // hourly cadence. Historical prose explaining that the OLD hourly assumption
  // was the bug is legitimate and must stay allowed, so this targets the
  // imperative form + the cron expression, not the word "hourly".
  it.each(CANONICAL)("%s never instructs an hourly reminder job", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(
      /schedule\s+(the\s+)?reminders?\s+(job\s+)?(every\s+hour|hourly)/i,
    );
    expect(src).not.toMatch(/reminders?[^.\n]{0,80}"0 \* \* \* \*"/i);
    expect(src).not.toMatch(
      /set\s+(the\s+)?(reminder|cron-job\.org)[^.\n]{0,60}\bevery hour\b/i,
    );
  });

  it("docs/08 carries the retired file's Twilio Console wiring", () => {
    const src = read("docs/08_EMAIL_SMS_AND_CRON.md");
    expect(src).toMatch(/Twilio Console/i);
    expect(src).toMatch(/api\/twilio\/inbound-sms/);
    expect(src).toMatch(/TWILIO_WEBHOOK_BASE_URL/);
  });

  it("docs/08 documents the bounded per-run cap the deleted file denied", () => {
    expect(read("docs/08_EMAIL_SMS_AND_CRON.md")).toMatch(/PER_RUN_LIMIT/);
  });
});

// The reason hourly is forbidden, asserted from the shipped source rather than
// restated as prose, if the window or cadence ever changes, this moves.
describe("the arithmetic behind the forbidden hourly cadence", () => {
  it("the shipped schedule is */15", () => {
    expect(APPOINTMENT_REMINDER_CRON_SCHEDULE).toBe("*/15 * * * *");
    expect(CRON_INTERVAL_MINUTES).toBe(15);
  });

  it("the configured cadence loses no appointment offsets", () => {
    const w = REMINDER_WINDOW_MINUTES["2h"];
    expect(uncoveredOffsets(w.start, w.end, CRON_INTERVAL_MINUTES)).toEqual([]);
  });

  it("an hourly cadence would miss most of them (non-vacuity)", () => {
    const w = REMINDER_WINDOW_MINUTES["2h"];
    const missed = uncoveredOffsets(w.start, w.end, 60);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.length).toBe(29);
  });

  // The degraded threshold is 2x cadence because that is the exact point the
  // window guarantee breaks. Proven, not asserted.
  it("30-minute cadence is the last safe one; 31 is not", () => {
    const w = REMINDER_WINDOW_MINUTES["2h"];
    expect(uncoveredOffsets(w.start, w.end, 30)).toEqual([]);
    expect(uncoveredOffsets(w.start, w.end, 45).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PR OPS-01, Phase 6. The human-ownership register must exist and must stay
// honest. Ticking a box here is an assertion that a person verified something
// no test can see, so the guard's job is to stop the boxes being marked done
// by a code change.
// ---------------------------------------------------------------------------
describe("scheduler ownership register stays explicitly unverified", () => {
  const DOC = "docs/08_EMAIL_SMS_AND_CRON.md";

  it("the register exists and names all five human facts", () => {
    const src = read(DOC);
    expect(src).toMatch(/Scheduler ownership register/i);
    for (const fact of [
      /primary account owner/i,
      /Backup owner/i,
      /exactly one enabled reminder job/i,
      /Alert owner \/ on-call recipient/i,
      /Reminder scheduler.{0,40}Healthy/i,
    ]) {
      expect(src).toMatch(fact);
    }
  });

  it("no ownership box is marked verified", () => {
    const register =
      read(DOC).match(
        /#### Scheduler ownership register[\s\S]*?Never record a credential/,
      )?.[0] ?? "";
    expect(register).not.toBe("");
    expect(register).toMatch(/☐ unverified/);
    // A checked box or a "verified"/"confirmed" status would be a claim no
    // automated evidence in this repository can support.
    expect(register).not.toMatch(/☑|\[x\]/i);
    expect(register).not.toMatch(/✅\s*verified|status.{0,10}\bverified\b/i);
  });

  it("the register forbids recording secrets", () => {
    expect(read(DOC)).toMatch(
      /Never record a credential, token, or the `CRON_SECRET`/,
    );
  });

  it("runtime evidence is dated and separated from the human facts", () => {
    const src = read(DOC);
    expect(src).toMatch(/PROVEN RUNTIME FACTS/);
    expect(src).toMatch(/OPERATOR \/ HUMAN FACTS STILL TO VERIFY/);
    expect(src).toMatch(/2026-08-12/);
    expect(src).toMatch(/773dbc7008b5/);
    // the three observed fires
    for (const t of ["23:00:19Z", "23:15:10Z", "23:30:14Z"]) {
      expect(src).toContain(t);
    }
  });
});
