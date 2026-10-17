import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvitationCapacityPanel } from "@/components/waitlist/invitation-capacity-panel";
import type { CapacityActionResult } from "@/app/(app)/settings/waitlist/capacity-actions";
import {
  CAPACITY_PANEL,
  type InvitationCapacity,
} from "@/lib/waitlist/invitation-capacity";

// ===========================================================================
// P2 4020704236 — a refusal the owner caused must be VISIBLE
// ===========================================================================
//
// The wrappers used to return void, so a refused start or close re-rendered the
// page unchanged and said nothing: indistinguishable from a successful no-op.
// The action half is proved in tests/app/settings/waitlist-capacity-actions --
// these prove the other half, that a returned refusal actually reaches
// data-testid="capacity-error".
//
// renderToStaticMarkup cannot press a button, which is why the hook's initial
// state is a prop: it is `useActionState`'s own second argument, and injecting
// it is what lets the two halves meet in one assertion instead of being trusted
// to line up.

const noop = async (): Promise<CapacityActionResult> => ({ ok: true });

const NONE: InvitationCapacity = { state: "none" };
const OPEN: InvitationCapacity = {
  state: "open",
  capacity: { roundId: "r1", allowance: 3, used: 1, openedAt: "2026-09-10T00:00:00.000Z" },
};

function render(props: Parameters<typeof InvitationCapacityPanel>[0]): string {
  return renderToStaticMarkup(createElement(InvitationCapacityPanel, props));
}

describe("a START refusal is rendered", () => {
  it("shows the message in capacity-error", () => {
    const html = render({
      capacity: NONE,
      startAction: noop,
      closeAction: noop,
      initialStartState: { ok: false, message: "You already have an invitation capacity open." },
    });
    expect(html).toContain('data-testid="capacity-error"');
    expect(html).toContain("You already have an invitation capacity open.");
    // Announced, not merely present.
    expect(html).toMatch(/data-testid="capacity-error"[^>]*role="alert"|role="alert"[^>]*data-testid="capacity-error"/);
  });

  it("does NOT pretend the mutation succeeded", () => {
    // The start form is still offered, and the panel still says no capacity is
    // open — a refusal must not leave the surface looking like it worked.
    const html = render({
      capacity: NONE,
      startAction: noop,
      closeAction: noop,
      initialStartState: { ok: false, message: "Enter how many new clients you're ready to invite." },
    });
    expect(html).toContain(CAPACITY_PANEL.startLabel);
    expect(html).toContain('data-testid="capacity-allowance"');
    expect(html).not.toContain("used");
  });
});

describe("a CLOSE refusal is rendered", () => {
  it("shows the message in capacity-error", () => {
    const html = render({
      capacity: OPEN,
      startAction: noop,
      closeAction: noop,
      initialCloseState: { ok: false, message: "You don't have an invitation capacity open." },
    });
    expect(html).toContain('data-testid="capacity-error"');
    expect(html).toContain("You don&#x27;t have an invitation capacity open.");
  });

  it("leaves the capacity showing, since closing did not happen", () => {
    const html = render({
      capacity: OPEN,
      startAction: noop,
      closeAction: noop,
      initialCloseState: { ok: false, message: "We couldn't close your invitation capacity. Please try again." },
    });
    expect(html).toContain("1 of 3 used");
    expect(html).toContain(CAPACITY_PANEL.closeLabel);
  });
});

describe("the quiet paths stay quiet", () => {
  it("renders no error element when nothing has been pressed", () => {
    for (const capacity of [NONE, OPEN]) {
      const html = render({ capacity, startAction: noop, closeAction: noop });
      expect(html).not.toContain('data-testid="capacity-error"');
    }
  });

  it("renders no error element on a SUCCESSFUL action", () => {
    const html = render({
      capacity: OPEN,
      startAction: noop,
      closeAction: noop,
      initialStartState: { ok: true },
      initialCloseState: { ok: true },
    });
    expect(html).not.toContain('data-testid="capacity-error"');
  });

  it("NEGATIVE CONTROL — an ok:false state is what produces the element", () => {
    // Guards against the error block being rendered by something else, which
    // would make every assertion above pass for the wrong reason.
    const quiet = render({ capacity: OPEN, startAction: noop, closeAction: noop });
    const loud = render({
      capacity: OPEN,
      startAction: noop,
      closeAction: noop,
      initialCloseState: { ok: false, message: "A refusal." },
    });
    expect(quiet).not.toContain("capacity-error");
    expect(loud).toContain("capacity-error");
  });

  it("a START refusal and a CLOSE refusal do not overwrite each other", () => {
    // Separate states, because they are different answers. The most recent
    // press is what the owner needs to read.
    const html = render({
      capacity: OPEN,
      startAction: noop,
      closeAction: noop,
      initialStartState: { ok: false, message: "Start refused." },
      initialCloseState: { ok: false, message: "Close refused." },
    });
    expect(html).toContain("Start refused.");
  });

  it("an action refusal takes precedence over a server-render message", () => {
    const html = render({
      capacity: OPEN,
      startAction: noop,
      closeAction: noop,
      error: "A stale server message.",
      initialCloseState: { ok: false, message: "The refusal you just caused." },
    });
    expect(html).toContain("The refusal you just caused.");
    expect(html).not.toContain("A stale server message.");
  });
});
