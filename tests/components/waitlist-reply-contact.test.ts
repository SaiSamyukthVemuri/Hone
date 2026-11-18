// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({
  default: (p: { href: string; children: unknown; className?: string }) => {
    const { createElement } = require("react");
    return createElement("a", { href: p.href, className: p.className }, p.children);
  },
}));
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ReplyContactDetails } = await import("@/components/waitlist/reply-contact");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ID = "00000000-0000-4000-8000-00000000000a";
const mounts: HTMLElement[] = [];
function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounts.push(host);
  act(() => createRoot(host).render(el));
  return host;
}
afterEach(() => { mounts.splice(0).forEach((m) => m.remove()); vi.restoreAllMocks(); });

it("email and phone present: shows both, with mailto, tel, copy and the entry link", () => {
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: { kind: "entry", email: "a@example.test", phone: "+1 555 0100" } }));
  expect(h.textContent).toContain("a@example.test");
  expect(h.textContent).toContain("+1 555 0100");
  expect(h.querySelector('a[href="mailto:a@example.test"]')).not.toBeNull();
  expect(h.querySelector('a[href="tel:+15550100"]')).not.toBeNull();
  expect(h.querySelector(`a[href="/settings/waitlist#entry-${ID}"]`)).not.toBeNull();
  // Visible label is just "Copy"; the accessible name says which one.
  expect(h.querySelector('button[aria-label="Copy email"]')?.textContent).toBe("Copy");
  expect(h.querySelector('button[aria-label="Copy phone"]')?.textContent).toBe("Copy");
});

it("phone missing says so and offers no call link", () => {
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: { kind: "entry", email: "a@example.test", phone: null } }));
  expect(h.textContent).toContain("No phone number on this entry");
  expect(h.querySelector('a[href^="tel:"]')).toBeNull();
  expect(h.querySelector('a[href^="mailto:"]')).not.toBeNull();
});

it("email missing says so and offers no mail link", () => {
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: { kind: "entry", email: null, phone: "555 0101" } }));
  expect(h.textContent).toContain("No email on this entry");
  expect(h.querySelector('a[href^="mailto:"]')).toBeNull();
});

it("a removed entry says so plainly and shows nothing guessed", () => {
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: { kind: "gone" } }));
  expect(h.textContent).toContain("no longer exists");
  expect(h.querySelector("a")).toBeNull();
});

it("a failed read says so instead of showing empty details", () => {
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: null }));
  expect(h.textContent).toContain("couldn’t load");
});

it("two cards with the same name each show their own entry's contact", () => {
  const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
  const h = render(createElement("div", null,
    createElement(ReplyContactDetails, { entryId: A, contact: { kind: "entry", email: "first@example.test", phone: null } }),
    createElement(ReplyContactDetails, { entryId: B, contact: { kind: "entry", email: "second@example.test", phone: "555 0102" } })));
  const cards = h.querySelectorAll('[data-testid="reply-contact"]');
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain("first@example.test");
  expect(cards[0].textContent).not.toContain("second@example.test");
  expect(cards[1].textContent).toContain("second@example.test");
});

it("copying writes to the clipboard and changes no state: no form, no fetch", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: { kind: "entry", email: "a@example.test", phone: "555 0100" } }));
  expect(h.querySelector("form")).toBeNull();
  const btn = h.querySelector<HTMLButtonElement>('button[aria-label="Copy email"]')!;
  await act(async () => { btn.click(); });
  expect(write).toHaveBeenCalledWith("a@example.test");
  expect(h.textContent).toContain("Copied");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("the phone Copy button writes the STORED value, not the formatted display text", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
  const h = render(createElement(ReplyContactDetails, { entryId: ID, contact: { kind: "entry", email: null, phone: "4165550123" } }));
  // The card SHOWS it formatted for reading...
  expect(h.textContent).toContain("(416) 555-0123");
  // ...but Copy and Call keep the stored dialable digits.
  await act(async () => { h.querySelector<HTMLButtonElement>('button[aria-label="Copy phone"]')!.click(); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith("4165550123");
  expect(write).not.toHaveBeenCalledWith("(416) 555-0123");
  expect(h.querySelector('a[href="tel:4165550123"]')).not.toBeNull();
});
