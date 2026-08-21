import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Chloe's four Dashboard asks, proved at the level each one actually lives at:
//
//   * the PILLS are RENDERED through react-dom/server and asserted on OUTPUT,
//     so "a failed card read must not say No card" is a fact about markup, not
//     about a regex;
//   * the WIRING (which loader, which href, which gate, how many clock reads)
//     is pinned against the page source, because those are structural
//     invariants a single rendered row cannot show.
//
// The rendered journey itself is proved in the browser:
// e2e/dashboard-current-client-card-status.spec.ts.

const REPO = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PAGE = read("app/(app)/dashboard/page.tsx");
const PAGE_CODE = codeOnly(PAGE);

// The row renderer, sliced to its own body so an assertion about "this function"
// cannot silently run to end-of-file and pick up another one's code.
const ROW = PAGE_CODE.slice(
  PAGE_CODE.indexOf("function AppointmentRow("),
  PAGE_CODE.indexOf("function AppointmentStatusPill("),
);
const PAGE_BODY = PAGE_CODE.slice(
  PAGE_CODE.indexOf("export default async function DashboardPage("),
  PAGE_CODE.indexOf("function DaySummary("),
);

vi.mock("@/app/(app)/clients/[id]/portal-link-actions", () => ({
  sendPortalLinkAction: vi.fn(async () => ({ ok: true })),
}));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CardOnFilePill, CurrentPill } = await import(
  "@/app/(app)/dashboard/today-status-pills"
);
const { TodayPortalLinkButton, PortalSendStatus, hintFromResult } = await import(
  "@/app/(app)/dashboard/TodayPortalLinkButton"
);

// ---------------------------------------------------------------------------
// A — the current client is highlighted
// ---------------------------------------------------------------------------
describe("A — Current", () => {
  it("the pill renders the word the practitioner scans for", () => {
    const html = renderToStaticMarkup(createElement(CurrentPill));
    expect(html).toContain("Current");
    expect(html).toContain('data-testid="today-current-pill"');
    // Calm, not an alarm: the convention reserves red for allergies/cautions.
    expect(html).not.toMatch(/\bbg-red-|\bbg-rose-/);
  });

  it("the row highlight is driven by the page-level `isCurrent` decision, not a row clock", () => {
    expect(ROW).toMatch(/isCurrent: boolean;/);
    expect(ROW).toMatch(/\{isCurrent && <CurrentPill \/>\}/);
    expect(ROW).toMatch(/data-testid=\{isCurrent \? "today-current-row" : undefined\}/);
    // A stronger treatment than an ordinary row, and dark mode preserved.
    expect(ROW).toMatch(/isCurrent[\s\S]{0,200}border-l-4[\s\S]{0,200}dark:bg-blue-950/);
  });

  it("NOW is read ONCE per render and shared by every row", () => {
    expect(PAGE_BODY).toMatch(/const renderNow = new Date\(\);/);
    // Exactly one clock read in the whole page component...
    expect((PAGE_BODY.match(/new Date\(\)/g) ?? []).length).toBe(1);
    // ...and none inside the row renderer, which is where an N-clock-reads
    // regression would land.
    expect(ROW).not.toMatch(/new Date\(\)/);
    // No per-row Date.now(), and no polling/timer introduced by this version.
    expect(PAGE_CODE).not.toMatch(/Date\.now\(\)/);
    expect(PAGE_CODE).not.toMatch(/setInterval|setTimeout|useEffect/);
  });

  it("the page asks the shared predicate, and gets a SET (overlaps survive)", () => {
    expect(PAGE_CODE).toMatch(
      /import \{ currentAppointmentIds \} from "@\/lib\/dashboard\/current-appointment"/,
    );
    expect(PAGE_BODY).toMatch(
      /currentAppointmentIds\(\s*visibleAppointments,\s*renderNow\.getTime\(\),?\s*\)/,
    );
    expect(PAGE_BODY).toMatch(
      /isCurrent=\{currentAppointmentIdSet\.has\(appt\.id\)\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// B — consultation notes in one tap, to the EXISTING writer
// ---------------------------------------------------------------------------
describe("B — Consultation notes", () => {
  it("the row links to the canonical consultation tab", () => {
    expect(ROW).toMatch(
      /href=\{`\/clients\/\$\{appt\.client_id\}\?tab=consultation`\}/,
    );
    expect(ROW).toMatch(/data-testid="today-consultation-notes"/);
    // No invented route and no second composer.
    expect(ROW).not.toMatch(/\/consultation\/new|\/notes\/new/);
  });

  it("the label upgrade is derived from the ALREADY-LOADED service modality", () => {
    expect(ROW).toMatch(
      /const isConsultationVisit = appt\.service\?\.modality === "consultation";/,
    );
    // TRUE branch says "Start …": an inverted ternary fails here.
    expect(ROW).toMatch(
      /isConsultationVisit\s*\?\s*\n?\s*"Start consultation notes"\s*\n?\s*:\s*"Consultation notes"/,
    );
  });

  it("the Dashboard did NOT become a second clinical-note writer", () => {
    // No note-writing action, no note loader, no composer, no dialog.
    expect(PAGE_CODE).not.toMatch(/clinical-note|clinicalNote|ClinicalNote/i);
    expect(PAGE_CODE).not.toMatch(/client_clinical_notes/);
    expect(PAGE_CODE).not.toMatch(/<textarea|<dialog|role="dialog"/);
    expect(PAGE_CODE).not.toMatch(/"use server"/);
    // And the action stays a plain navigation.
    expect(ROW).toMatch(/<Link[\s\S]{0,400}today-consultation-notes/);
  });
});

// ---------------------------------------------------------------------------
// C — card-on-file status, three states, never two
// ---------------------------------------------------------------------------
describe("C — Card status", () => {
  const html = (status: "card_on_file" | "no_card" | "unavailable") =>
    renderToStaticMarkup(createElement(CardOnFilePill, { status }));

  it("an active card says Card on file, in calm green", () => {
    const out = html("card_on_file");
    expect(out).toContain("Card on file");
    expect(out).toMatch(/emerald/);
    expect(out).not.toMatch(/No card/);
  });

  it("a trusted absence says No card, in visible amber", () => {
    const out = html("no_card");
    expect(out).toContain("No card");
    expect(out).toMatch(/amber/);
  });

  it("A FAILED READ SAYS 'Card status unavailable' AND NEVER 'No card'", () => {
    // Load-bearing. A read failure is not a thing the client did or failed to
    // do, and it must not be dressed as one.
    const out = html("unavailable");
    expect(out).toContain("Card status unavailable");
    expect(out).not.toMatch(/No card/);
    expect(out).not.toMatch(/Card on file/);
    // Not amber either: neutral, so it does not read as a task.
    expect(out).not.toMatch(/amber/);
    expect(out).toMatch(/neutral/);
  });

  it("the three states are distinguishable to a test and to a reader", () => {
    for (const s of ["card_on_file", "no_card", "unavailable"] as const) {
      expect(html(s)).toContain(`data-card-status="${s}"`);
    }
  });

  it("the page resolves status per client from ONE batch load", () => {
    expect(PAGE_CODE).toMatch(
      /loadCardOnFileForStudio,\s*\n?\s*resolveCardOnFileStatus,/,
    );
    // ONE call site, inside the existing bulk Promise.all — never in the row map.
    expect((PAGE_BODY.match(/loadCardOnFileForStudio\(/g) ?? []).length).toBe(1);
    expect(PAGE_BODY).toMatch(
      /loadCardOnFileForStudio\(studio\.id, selectedDayClientIds\)/,
    );
    expect(ROW).not.toMatch(/loadCardOnFileForStudio|getCardOnFileStatuses|createClient|from\("/);
    expect(PAGE_BODY).toMatch(
      /cardOnFile=\{resolveCardOnFileStatus\(\s*cardOnFileLoad,\s*appt\.client_id,?\s*\)\}/,
    );
  });

  it("card status is a DIFFERENT fact from the appointment's payment state", () => {
    // AppointmentPaymentState answers "has this visit been charged", which is
    // not "does this person have a card on file". The row carries both, and
    // neither is derived from the other.
    expect(ROW).toMatch(/paymentState: AppointmentPaymentState;/);
    // `| null` = the studio has no card-on-file route, so the row asks no card
    // question at all — distinct from `unavailable`, where it applies and failed.
    expect(ROW).toMatch(/cardOnFile: CardOnFileStatus \| null;/);
    expect(ROW).not.toMatch(/cardOnFile\s*=\s*paymentState|paymentState\s*===\s*"[a-z_]+"\s*\?\s*"(card_on_file|no_card)"/);
  });
});

// ---------------------------------------------------------------------------
// D — one-click portal link, reusing the existing authority
// ---------------------------------------------------------------------------
describe("D — Send portal link", () => {
  it("is offered ONLY for a trusted no_card row", () => {
    expect(ROW).toMatch(
      /const offerPortalLink = shouldOfferPortalLink\(cardOnFile\);/,
    );
    expect(ROW).toMatch(/\{offerPortalLink && \(\s*\n?\s*<TodayPortalLinkButton/);
    // The gate is the shared helper, not a hand-rolled comparison that could
    // drift (e.g. `!== "card_on_file"`, which would expose it on unavailable).
    expect(ROW).not.toMatch(/cardOnFile !== "card_on_file"/);
  });

  it("reuses the existing practitioner action — no second magic-link path", () => {
    const BTN = read("app/(app)/dashboard/TodayPortalLinkButton.tsx");
    expect(BTN).toMatch(
      /import \{[\s\S]{0,120}sendPortalLinkAction[\s\S]{0,120}\} from "@\/app\/\(app\)\/clients\/\[id\]\/portal-link-actions"/,
    );
    // No token issuance, no email provider, no raw link anywhere near the UI.
    expect(codeOnly(BTN)).not.toMatch(
      /issuePortalMagicLink|resend|sendEmail|createAdminClient|token/i,
    );
    expect(PAGE_CODE).not.toMatch(/issuePortalMagicLink|portal_magic_link/);
  });

  it("says what the email IS — a portal link, not a card reminder", () => {
    const out = renderToStaticMarkup(
      createElement(TodayPortalLinkButton, {
        clientId: "c1",
        clientHasEmail: true,
      }),
    );
    expect(out).toContain("Send portal link");
    expect(out).not.toMatch(/card reminder|Remind about card/i);
    expect(out).toContain('data-testid="today-send-portal-link"');
    // The ATTRIBUTE, not the `disabled:` Tailwind variant in the class list.
    expect(out).not.toMatch(/<button[^>]*\sdisabled=/);
    // Real tap target on a phone.
    expect(out).toMatch(/min-h-\[44px\]/);
  });

  it("with NO email on file the send is disabled and says why", () => {
    const out = renderToStaticMarkup(
      createElement(TodayPortalLinkButton, {
        clientId: "c1",
        clientHasEmail: false,
      }),
    );
    expect(out).toMatch(/<button[^>]*\sdisabled=/);
    expect(out).toContain("No email on file");
  });

  it("a SUCCESSFUL send says 'Portal link sent.'", () => {
    // vitest runs without a DOM here (the existing portal-link suite records
    // the same constraint), so the click itself is proved in the browser. What
    // is proved HERE is the outcome copy the action's result produces, by
    // rendering it.
    const out = renderToStaticMarkup(
      createElement(PortalSendStatus, { hint: hintFromResult({ ok: true }) }),
    );
    expect(out).toContain("Portal link sent.");
    expect(out).toContain('data-testid="today-portal-link-sent"');
  });

  it("a rate-limited / failed send shows the action's OWN safe copy, unchanged", () => {
    const safe =
      "Too many portal links sent to this client recently. Please try again later.";
    const out = renderToStaticMarkup(
      createElement(PortalSendStatus, {
        hint: hintFromResult({ ok: false, error: safe }),
      }),
    );
    expect(out).toContain(safe);
    // Nothing is invented, and nothing sensitive is added.
    expect(out).not.toMatch(/portal\/verify|token|http/i);
  });

  it("the button routes BOTH outcomes through that one mapping", () => {
    const BTN = codeOnly(read("app/(app)/dashboard/TodayPortalLinkButton.tsx"));
    expect(BTN).toMatch(
      /setHint\(hintFromResult\(await sendPortalLinkAction\(fd\)\)\)/,
    );
    expect(BTN).toMatch(/<PortalSendStatus hint=\{hint\} \/>/);
    // The pending label is the one Chloe sees mid-flight.
    expect(BTN).toMatch(/pending \? "Sending…" : "Send portal link"/);
  });

  it("the email flag comes from the row's EXISTING client projection", () => {
    // One widened column, not a second client query.
    expect(PAGE_BODY).toMatch(/client:clients\(id, name, allergies, pronouns, email, date_of_birth, phone, address\)/);
    expect(ROW).toMatch(/clientHasEmail=\{!!appt\.client\?\.email\?\.trim\(\)\}/);
  });
});

// ---------------------------------------------------------------------------
// Row hygiene
// ---------------------------------------------------------------------------
describe("row hygiene", () => {
  it("no interactive control is nested inside the row-body link", () => {
    // The row body is an <a>; a <button>/<a> inside it is invalid HTML with
    // undefined activation behaviour (the CHLOE D1 defect). Both new controls
    // live in the sibling actions column.
    const linkStart = ROW.indexOf("<Link\n          href={`/calendar/");
    const linkEnd = ROW.indexOf("</Link>", linkStart);
    const body = ROW.slice(linkStart, linkEnd);
    expect(linkStart).toBeGreaterThan(-1);
    expect(body).not.toMatch(/<button|TodayPortalLinkButton|onClick/);
    expect(body).toMatch(/<CardOnFilePill status=\{cardOnFile\} \/>/);
    expect(body).toMatch(/<CurrentPill \/>/);
  });

  it("the secondary actions wrap instead of forming a wall of buttons", () => {
    expect(ROW).toMatch(/flex flex-wrap items-center justify-end gap-x-3 gap-y-1/);
  });
});


// ===========================================================================
// RC1 — a rejected action must not be able to take the Dashboard down
// ===========================================================================
//
// Found by all three adversarial reviewers. The send awaits inside
// `startTransition`; React re-throws a REJECTED action out of the transition,
// and with no local catch it escapes to the route error boundary — replacing
// the whole Today roster because one secondary per-row control failed, and
// setting no hint, so nothing is announced either.
//
// A rejection is a different class from `{ok:false}`: the action RETURNS its
// refusals, so the safe-copy path was already correct. This covers transport
// failure, a deployment-id mismatch on a tab left open across a deploy, and
// the practitioner/studio resolver throwing.

describe("RC1 — portal send: all three settlement paths", () => {
  const SRC = read("app/(app)/dashboard/TodayPortalLinkButton.tsx");

  it("the transition body is wrapped, so a rejection cannot escape it", () => {
    const body = codeOnly(SRC);
    expect(
      body,
      "the awaited action must sit inside a try/catch",
    ).toMatch(/startTransition\(async \(\) => \{[\s\S]{0,200}try \{[\s\S]{0,200}await sendPortalLinkAction/);
    expect(body).toMatch(/\}\s*catch\s*\{/);
  });

  it("RESOLVED SUCCESS still reports the unchanged success copy", () => {
    expect(hintFromResult({ ok: true })).toEqual({ kind: "sent" });
  });

  it("RESOLVED REFUSAL still passes the action's OWN safe copy through unchanged", () => {
    expect(
      hintFromResult({ ok: false, error: "Too many portal links sent to this client recently." }),
    ).toEqual({
      kind: "error",
      message: "Too many portal links sent to this client recently.",
    });
  });

  it("a REJECTION renders calm generic copy and NEVER the thrown text", () => {
    const body = codeOnly(SRC);
    const generic = "Could not send portal link. Please try again.";
    expect(body, "the catch must render fixed copy").toContain(generic);
    // The caught value must not be interpolated anywhere.
    expect(body).not.toMatch(/catch\s*\(\s*\w+\s*\)[\s\S]{0,200}message:\s*\w+(\.message)?\s*[,}]/);
    expect(body).not.toMatch(/String\(\s*err/);
  });

  it("the catch does not swallow the refusal path into the generic copy", () => {
    // A catch that also handled {ok:false} would erase the action's specific,
    // useful wording (e.g. the rate-limit sentence) — that must stay distinct.
    const hint = hintFromResult({ ok: false, error: "Client not found in your studio." });
    expect(hint.kind).toBe("error");
    expect(hint.kind === "error" && hint.message).toBe(
      "Client not found in your studio.",
    );
  });
});
