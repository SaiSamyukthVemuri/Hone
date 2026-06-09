import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #181. Source-grep tests pin the new NextStepCard on the
// calendar appointment detail page. The card replaces the bare
// "Completed" placeholder for completed appointments and gives the
// practitioner a single primary CTA matching the linked-session
// state.

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/calendar/[id]/page.tsx",
);
const PAGE = readFileSync(PAGE_PATH, "utf8");

function blockFor(name: string): string {
  const startIdx = PAGE.indexOf(`function ${name}(`);
  if (startIdx === -1) return "";
  const after = startIdx + 1;
  const rel = PAGE.slice(after).search(/^function \w+\(/m);
  return rel === -1 ? PAGE.slice(startIdx) : PAGE.slice(startIdx, after + rel);
}

describe("PR #181: NextStepCard replaces the bare 'Completed' placeholder", () => {
  it("the completed branch dispatches to <NextStepCard ...>", () => {
    expect(PAGE).toMatch(
      /typedStatus === "completed"[\s\S]{0,200}<NextStepCard/,
    );
  });

  it("the bare placeholder section that read 'Completed' is removed for completed appointments", () => {
    // The previous wording was a literal section containing only the
    // word "Completed". The dispatch now routes via NextStepCard;
    // the standalone placeholder text must not return.
    const completedBlock =
      PAGE.match(
        /typedStatus === "completed"[\s\S]{0,400}\)\}/,
      )?.[0] ?? "";
    expect(completedBlock).not.toMatch(/>\s*Completed\s*</);
  });

  it("the NextStepCard receives appointmentId, clientId, linkedSession", () => {
    expect(PAGE).toMatch(
      /<NextStepCard\s*\n[\s\S]{0,400}clientId=\{data\.client\?\.id \?\? null\}[\s\S]{0,400}appointmentId=\{id\}[\s\S]{0,400}linkedSession=\{linkedSession\}/,
    );
  });
});

describe("PR #181: NextStepCard three-state CTA precedence", () => {
  it("declares the component", () => {
    expect(PAGE).toMatch(/function NextStepCard\(\{/);
  });

  it("renders the 'Appointment completed' heading", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(/Appointment completed/);
  });

  it("renders the 'Next step: chart the session and bill the client.' guidance", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(
      /Next step: chart the session and bill the client\./,
    );
  });

  it("no linked session: CTA label is 'Start session' and href points to sessions/new", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(/ctaLabel = "Start session";/);
    expect(block).toMatch(
      /ctaHref = `\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=\$\{encodeURIComponent\(appointmentId\)\}`/,
    );
  });

  it("linked session but not started: CTA label is 'Open session' and href points to the session page", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(/ctaLabel = "Open session";/);
    expect(block).toMatch(
      /ctaHref = `\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`/,
    );
  });

  it("linked started session: CTA label is 'Go to billing' and href deep-links to #session-payment", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(/ctaLabel = "Go to billing";/);
    expect(block).toMatch(
      /ctaHref = `\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}#session-payment`/,
    );
  });

  it("the discriminator between 'Open session' and 'Go to billing' is sessionStarted (started_at)", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(
      /const sessionStarted = linkedSession\?\.started_at != null;/,
    );
  });
});

describe("PR #181: NextStepCard styling + safety", () => {
  it("uses primary (filled) styling on the CTA so it is the obvious next action", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(/bg-neutral-900/);
    expect(block).toMatch(/text-white/);
  });

  it("renders a fallback header when clientId is null (no CTA)", () => {
    const block = blockFor("NextStepCard");
    expect(block).toMatch(/if \(!clientId\)/);
  });

  it("never says 'Live payment', 'Payment complete', or 'Pay now'", () => {
    const block = blockFor("NextStepCard");
    expect(block).not.toMatch(/Live payment|Payment complete|Pay now/);
  });

  it("does NOT call any Stripe SDK / payment helper", () => {
    const block = blockFor("NextStepCard");
    expect(block).not.toMatch(
      /paymentIntents\.create|refunds\.create|charges\.create|sendPaymentChargeReceipt|refundPaymentChargeAttempt/,
    );
  });
});

describe("PR #181: ChartSessionCard is hidden for completed appointments", () => {
  it("the ChartSessionCard mount is gated on typedStatus !== 'completed'", () => {
    expect(PAGE).toMatch(
      /!isCancelled && typedStatus !== "completed"[\s\S]{0,400}<ChartSessionCard/,
    );
  });
});
