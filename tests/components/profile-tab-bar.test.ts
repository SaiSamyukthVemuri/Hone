import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// UI-01D — what the Client Profile tab bar RENDERS while a tab change is in
// flight.
//
// WHY THIS IS A RENDER TEST AND NOT A SOURCE TEST
// -----------------------------------------------
// The defect this file pins was invisible to every class-string and source
// assertion the repository had. The tab bar always carried `min-h-[44px]`,
// always set `aria-current` correctly, and never suppressed its focus ring —
// it was the COMBINATION of `disabled={pending && !isActive}` with
// `disabled:opacity-60` that painted the tab the practitioner had just tapped,
// and the five they had not, in the disabled vocabulary while the tab they
// were LEAVING stayed lit. Only the rendered output shows that. So these
// assertions run the real component through react-dom/server and read the
// attributes a browser would.
//
// WHY THE TWO HOOKS ARE MOCKED
// ----------------------------
// A pending transition has no server render: `useTransition` reports
// `[false]` during SSR, so the state under test could never appear. The mocks
// below stand in for exactly that one browser-only fact and nothing else — the
// component's own logic, markup and class strings are the real ones. The
// browser half of this proof (a real held navigation, real keyboard
// activation, real focus) lives in e2e/perceived-speed.spec.ts; this file
// pins the state machine, which a browser assertion localises poorly.

let transitionPending = false;
let requestedTab: string | null = null;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    useTransition: () => [transitionPending, (fn: () => void) => fn()],
    // Narrow on purpose: the tab bar holds exactly ONE piece of state and it is
    // initialised to null. Every other useState in the tree keeps React's own
    // implementation, so this cannot silently take over an unrelated component.
    useState: (init: unknown) =>
      init === null ? [requestedTab, () => undefined] : actual.useState(init),
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/clients/CLIENT_ID",
  useRouter: () => ({ push: () => undefined }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: ReactNode }) =>
      react.createElement(
        "a",
        { href: props.href, className: props.className },
        props.children,
      ),
  };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ProfileTabBar } = await import("@/components/profile-tab-bar");

type Tab = {
  label: string;
  disabled: boolean;
  ariaCurrent: string | null;
  ariaBusy: string | null;
  hasMark: boolean;
};

function render(state: {
  pending: boolean;
  active: string;
  requested: string | null;
}) {
  transitionPending = state.pending;
  requestedTab = state.requested;
  return renderToStaticMarkup(
    createElement(ProfileTabBar, {
      active: state.active as Parameters<typeof ProfileTabBar>[0]["active"],
    }),
  );
}

function tabs(html: string): Tab[] {
  const out: Tab[] = [];
  const re = /<button([^>]*)>([\s\S]*?)<\/button>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    out.push({
      label: (body.match(/>([^<>]+)</)?.[1] ?? "").trim(),
      disabled: /\sdisabled(?:=""|\s|$)/.test(attrs),
      ariaCurrent: attrs.match(/aria-current="([^"]*)"/)?.[1] ?? null,
      ariaBusy: attrs.match(/aria-busy="([^"]*)"/)?.[1] ?? null,
      hasMark: /animate-spin/.test(body),
    });
  }
  return out;
}

const liveRegion = (html: string) =>
  html.match(/role="status"[^>]*>([^<]*)</)?.[1] ?? null;
const markCount = (html: string) => (html.match(/animate-spin/g) ?? []).length;
const selectDisabled = (html: string) =>
  /\sdisabled(?:=""|\s|$)/.test(html.match(/<select([^>]*)>/)?.[1] ?? "");
const find = (html: string, label: string) =>
  tabs(html).find((t) => t.label === label);

describe("UI-01D: the current tab stays truthful", () => {
  it("marks exactly one tab current at rest, and busies none", () => {
    const html = render({ pending: false, active: "overview", requested: null });
    const current = tabs(html).filter((t) => t.ariaCurrent === "page");
    expect(current).toHaveLength(1);
    expect(current[0]?.label).toBe("Overview");
    expect(tabs(html).every((t) => t.ariaBusy === null)).toBe(true);
    expect(markCount(html)).toBe(0);
    expect(liveRegion(html)).toBe("");
  });

  it("does NOT move aria-current to the pending target", () => {
    const html = render({
      pending: true,
      active: "overview",
      requested: "sessions",
    });
    // The whole product contract in one assertion: the tab being LEFT is still
    // the current one, and the tab being OPENED is not current yet.
    expect(find(html, "Overview")?.ariaCurrent).toBe("page");
    expect(find(html, "Sessions")?.ariaCurrent).toBeNull();
    expect(tabs(html).filter((t) => t.ariaCurrent === "page")).toHaveLength(1);
  });

  it("promotes the target to current once navigation commits", () => {
    const html = render({
      pending: false,
      active: "sessions",
      requested: "sessions",
    });
    expect(find(html, "Sessions")?.ariaCurrent).toBe("page");
    expect(find(html, "Overview")?.ariaCurrent).toBeNull();
    expect(find(html, "Sessions")?.ariaBusy).toBeNull();
    expect(markCount(html)).toBe(0);
  });
});

describe("UI-01D: the pending target is represented separately", () => {
  it("busies the tapped tab, and only that one", () => {
    const html = render({
      pending: true,
      active: "overview",
      requested: "sessions",
    });
    const busy = tabs(html).filter((t) => t.ariaBusy === "true");
    expect(busy).toHaveLength(1);
    expect(busy[0]?.label).toBe("Sessions");
    expect(liveRegion(html)).toBe("Opening Sessions…");
  });

  it("disables NO tab while a navigation is in flight", () => {
    // The regression this replaces: `disabled={pending && !isActive}` greyed
    // out the tapped tab and every other destination. A disabled control is
    // also blurred by the browser, which dropped keyboard focus to <body>.
    const html = render({
      pending: true,
      active: "overview",
      requested: "sessions",
    });
    expect(tabs(html).some((t) => t.disabled)).toBe(false);
    expect(html).not.toContain("disabled:opacity-60");
  });

  it("says the REQUEST, never the outcome", () => {
    const html = render({
      pending: true,
      active: "overview",
      requested: "personal",
    });
    expect(liveRegion(html)).toBe("Opening Personal Notes…");
    expect(liveRegion(html)).not.toMatch(/opened|loaded|done/i);
  });

  it("mounts the live region at all times, empty at rest", () => {
    // A polite live region inserted already holding its message is not
    // reliably announced; it has to exist before its content changes.
    const idle = render({ pending: false, active: "overview", requested: null });
    expect(liveRegion(idle)).toBe("");
    expect(idle).toContain('role="status"');
  });
});

describe("UI-01D: pending state cannot go stale", () => {
  it("clears when an aborted or failed navigation settles", () => {
    // `requested` still holds the tab that was asked for, but the transition
    // has settled. Because the target is DERIVED through `pending`, there is
    // nothing to clean up and nothing left on screen.
    const html = render({
      pending: false,
      active: "overview",
      requested: "sessions",
    });
    expect(tabs(html).every((t) => t.ariaBusy === null)).toBe(true);
    expect(markCount(html)).toBe(0);
    expect(liveRegion(html)).toBe("");
    expect(find(html, "Overview")?.ariaCurrent).toBe("page");
  });

  it("moves the acknowledgement to the newest target, never duplicating it", () => {
    const first = render({
      pending: true,
      active: "overview",
      requested: "sessions",
    });
    const second = render({
      pending: true,
      active: "overview",
      requested: "personal",
    });
    expect(find(first, "Sessions")?.ariaBusy).toBe("true");
    expect(find(second, "Sessions")?.ariaBusy).toBeNull();
    expect(find(second, "Personal Notes")?.ariaBusy).toBe("true");
    expect(markCount(second)).toBe(1);
    expect(tabs(second).filter((t) => t.ariaBusy === "true")).toHaveLength(1);
  });
});

describe("UI-01D: a spinner is not the proof, and the mobile control is untouched", () => {
  it("would fail a spinner-only implementation", () => {
    // Guard against a future 'fix' that paints a mark but leaves the state
    // machine wrong: a mark on the target is necessary and NOT sufficient.
    const html = render({
      pending: true,
      active: "overview",
      requested: "sessions",
    });
    const target = find(html, "Sessions");
    expect(target?.hasMark).toBe(true);
    // ...and every one of these must hold alongside it.
    expect(target?.ariaBusy).toBe("true");
    expect(target?.ariaCurrent).toBeNull();
    expect(target?.disabled).toBe(false);
    expect(find(html, "Overview")?.ariaCurrent).toBe("page");
  });

  it("keeps the mark reduced-motion safe and out of the flow", () => {
    const html = render({
      pending: true,
      active: "overview",
      requested: "sessions",
    });
    expect(html).toContain("motion-reduce:animate-none");
    // The still frame closes the ring, so the state survives without rotation.
    expect(html).toContain("motion-reduce:border-t-current");
    // Absolutely positioned: the tab cannot change width mid-navigation.
    expect(html).toMatch(/pointer-events-none absolute inset-0 m-auto/);
  });

  it("leaves the mobile select's own pending behaviour exactly as it was", () => {
    // PR #238 made the phone control a native <select>; it is outside the
    // repaired mechanism and its lock is unchanged.
    expect(
      selectDisabled(
        render({ pending: true, active: "overview", requested: "sessions" }),
      ),
    ).toBe(true);
    expect(
      selectDisabled(
        render({ pending: false, active: "overview", requested: null }),
      ),
    ).toBe(false);
  });
});
