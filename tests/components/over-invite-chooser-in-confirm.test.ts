// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OverInviteConfirm } from "@/components/waitlist/over-invite-confirm";
import { RecipientChooser } from "@/components/waitlist/recipient-chooser";
import { buildOverInvitePreview } from "@/lib/waitlist/over-invite-preview";

// The chooser MOUNTED INSIDE the confirmation, submitted for real: the form carries every selected id exactly once (including ids chosen on pages that are not
// on screen, and ids the current search hides), and nothing the owner only browsed is posted. The confirmation renders no entryId inputs of its own, so the
// chooser is the single source.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PEOPLE = Array.from({ length: 8 }, (_, i) => ({ entryId: `e${i + 1}`, name: `Person ${i + 1}`, email: `person${i + 1}@example.test` }));

let root: Root | null = null;
let host: HTMLElement | null = null;
let posted: FormData[] = [];
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  posted = [];
});

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(OverInviteConfirm, {
        action: (fd: FormData) => void posted.push(fd),
        preview: buildOverInvitePreview({ fit: 0, active: 0, expiringSoon: 0, extra: 3 }),
        recipientChooser: createElement(RecipientChooser, { candidates: PEOPLE, pageSize: 3 }),
        batchKey: "k1",
      }),
    ),
  );
  return host;
}
const button = (h: HTMLElement, text: string) => Array.from(h.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = (h: HTMLElement) => act(() => void (h.querySelector("form") as HTMLFormElement).requestSubmit());
const confirmBox = (h: HTMLElement) => h.querySelector('input[name="confirmed"]') as HTMLInputElement;
const ids = (fd: FormData) => fd.getAll("entryId").map(String);

describe("the chooser inside the over-invite confirmation", () => {
  it("posts every selected id exactly once, including ids from pages that are not on screen", () => {
    const h = mount();
    click(button(h, "Select this page")); // e1, e2, e3
    click(button(h, "Next"));
    click(button(h, "Select this page")); // e4, e5, e6
    click(button(h, "Next")); // now on page 3 (e7, e8): nothing there selected
    click(confirmBox(h));
    submit(h);
    expect(posted).toHaveLength(1);
    expect(ids(posted[0]).sort()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(new Set(ids(posted[0])).size).toBe(ids(posted[0]).length);
    expect(posted[0].get("confirmed")).toBe("on");
    expect(posted[0].get("batchKey")).toBe("k1");
  });

  it("a search that hides selected people does not drop them from the post", () => {
    const h = mount();
    click(button(h, "Select this page")); // e1, e2, e3
    type(h.querySelector('input[type="search"]') as HTMLInputElement, "Person 7");
    click(button(h, "Select this page")); // e7, the only match
    click(confirmBox(h));
    submit(h);
    expect(ids(posted[0]).sort()).toEqual(["e1", "e2", "e3", "e7"]);
  });

  it("clearing a page removes exactly that page's ids and no others", () => {
    const h = mount();
    click(button(h, "Select all 8 listed"));
    click(button(h, "Clear this page")); // page 1: e1, e2, e3
    click(confirmBox(h));
    submit(h);
    expect(ids(posted[0]).sort()).toEqual(["e4", "e5", "e6", "e7", "e8"]);
  });

  it("browsing alone posts no ids, and the confirmation renders no entryId input of its own", () => {
    const h = mount();
    type(h.querySelector('input[type="search"]') as HTMLInputElement, "Person");
    click(button(h, "Next"));
    expect(h.querySelectorAll('input[name="entryId"]')).toHaveLength(0);
    click(confirmBox(h));
    submit(h);
    expect(ids(posted[0])).toEqual([]);
  });

  it("Enter in the search box does not submit the form", () => {
    const h = mount();
    const search = h.querySelector('input[type="search"]') as HTMLInputElement;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => void search.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(posted).toHaveLength(0);
  });
});
