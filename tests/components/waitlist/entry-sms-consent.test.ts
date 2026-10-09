import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EntrySmsConsent, type SmsConsentView } from "@/components/waitlist/entry-sms-consent";
import { PRACTITIONER_SMS_CONSENT_SCOPE_TEXT } from "@/lib/waitlist/prospect-sms-consent";

// ===========================================================================
// 0208 — ONE ROW'S SMS STANDING, AND THE OWNER'S RECORDING FORM
// ===========================================================================
//
// Rendered through react-dom/server and asserted on OUTPUT. The page-level
// mapping from a row to a view is proved in
// tests/app/settings/waitlist-queue.test.ts; this file proves each view says
// only what it may, and that the form carries no default answer.

const ENTRY = "33333333-3333-4333-8333-333333333333";
const action = async () => ({ ok: true as const });

function html(view: SmsConsentView, initialState: { ok: false; message: string } | null = null) {
  return renderToStaticMarkup(
    createElement(EntrySmsConsent, { entryId: ENTRY, entryName: "Ada Lovelace", view, action, initialState }),
  );
}

const status = (markup: string) =>
  markup.match(/data-testid="sms-consent-status"[^>]*>([^<]*)</)?.[1] ?? null;

describe("the status line says what is on record, and nothing more", () => {
  it("STOP", () => {
    expect(status(html({ kind: "opted_out" }))).toBe("Texts: opted out (replied STOP)");
  });

  it("the person's own answer, by where they gave it", () => {
    expect(
      status(html({ kind: "consented", source: "public_form", recordedOnLabel: "Aug 20, 2026", agreedOnLabel: null })),
    ).toBe("Texts: agreed on the waitlist form on Aug 20, 2026");
    expect(
      status(html({ kind: "consented", source: "prospect_link", recordedOnLabel: "Aug 20, 2026", agreedOnLabel: null })),
    ).toBe("Texts: agreed through their waitlist link on Aug 20, 2026");
  });

  it("a studio record names the studio, and an unknown day stays unknown", () => {
    expect(
      status(
        html({ kind: "consented", source: "practitioner", recordedOnLabel: "Oct 9, 2026", agreedOnLabel: "Mar 1, 2026" }),
      ),
    ).toBe("Texts: consent recorded by the studio on Oct 9, 2026 · they agreed on Mar 1, 2026");
    const unknown = status(
      html({ kind: "consented", source: "practitioner", recordedOnLabel: "Oct 9, 2026", agreedOnLabel: null }),
    );
    expect(unknown).toBe("Texts: consent recorded by the studio on Oct 9, 2026 · they agreed on a day not known");
    // The recording day is never presented as the day they agreed.
    expect(unknown).not.toMatch(/agreed on Oct 9/);
  });

  it("no consent, with and without a number", () => {
    expect(status(html({ kind: "none", recordable: true }))).toBe("Texts: no consent on record");
    expect(status(html({ kind: "none", recordable: false, reason: "no_phone" }))).toBe(
      "Texts: no consent on record · no mobile number on file",
    );
    expect(status(html({ kind: "none", recordable: false, reason: "not_active" }))).toBe(
      "Texts: no consent on record",
    );
  });
});

describe("the recording form", () => {
  it("is offered ONLY where the command would accept it", () => {
    const offered = html({ kind: "none", recordable: true });
    expect(offered).toContain('data-testid="sms-consent-form"');
    for (const view of [
      { kind: "opted_out" },
      { kind: "consented", source: "practitioner", recordedOnLabel: "Oct 9, 2026", agreedOnLabel: null },
      { kind: "consented", source: "public_form", recordedOnLabel: "Oct 9, 2026", agreedOnLabel: null },
      { kind: "none", recordable: false, reason: "no_phone" },
      { kind: "none", recordable: false, reason: "not_active" },
    ] as SmsConsentView[]) {
      expect(html(view), JSON.stringify(view)).not.toContain('data-testid="sms-consent-form"');
    }
  });

  it("asks for all three answers, and preselects NONE of them", () => {
    const markup = html({ kind: "none", recordable: true });
    const form = markup.slice(markup.indexOf("<form"), markup.indexOf("</form>"));
    // React orders a form control's attributes as it pleases, so each input
    // is found by name and its attributes checked individually.
    const inputs = (name: string) =>
      [...form.matchAll(/<input[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(`name="${name}"`));
    expect(inputs("entry_id")).toEqual([`<input type="hidden" name="entry_id" value="${ENTRY}"/>`]);
    const [attest] = inputs("sms_consent_attest");
    expect(attest).toContain('type="checkbox"');
    expect(attest).toContain('value="yes"');
    const [evidence] = inputs("sms_consent_evidence_ref");
    expect(evidence).toContain('type="text"');
    expect(evidence).toContain('maxLength="200"');
    const dayAnswers = inputs("sms_consent_date_known");
    expect(dayAnswers.map((tag) => tag.match(/value="([^"]+)"/)?.[1])).toEqual(["known", "unknown"]);
    for (const tag of dayAnswers) expect(tag).toContain('type="radio"');
    // No default anywhere: an unticked attestation, no chosen day answer, no
    // prefilled evidence.
    expect(form).not.toMatch(/\bchecked\b/);
    expect(evidence).not.toMatch(/\bvalue=/);
    // The day field exists only once "I know the day" is chosen.
    expect(form).not.toContain('name="sms_consent_given_on"');
  });

  it("the attestation states the exact scope, naming the person", () => {
    const markup = html({ kind: "none", recordable: true });
    expect(markup).toContain(`Ada Lovelace agreed to ${PRACTITIONER_SMS_CONSENT_SCOPE_TEXT}.`);
    expect(markup).toContain("Record SMS consent for Ada Lovelace");
  });

  it("is behind a closed disclosure, so a stray tap records nothing", () => {
    const markup = html({ kind: "none", recordable: true });
    expect(markup).toMatch(/<details[^>]*>/);
    expect(markup).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("a refusal is announced inline", () => {
    const markup = html({ kind: "none", recordable: true }, { ok: false, message: "Nothing was recorded." });
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>Nothing was recorded\.<\/p>/);
  });
});

describe("source discipline", () => {
  const SOURCE = readFileSync(
    path.resolve(__dirname, "../../../components/waitlist/entry-sms-consent.tsx"),
    "utf8",
  );

  it("the day answer starts unchosen", () => {
    expect(SOURCE).toMatch(/useState<"known" \| "unknown" \| null>\(null\)/);
    expect(SOURCE).not.toMatch(/defaultChecked/);
  });

  it("never names a wording version or the public form's acceptance", () => {
    expect(SOURCE).not.toMatch(/waitlist_sms_operational_v1|SMS_OPERATIONAL_CONSENT_LABEL/);
  });
});
