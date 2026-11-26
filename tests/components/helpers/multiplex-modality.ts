// MultiPlex lives under Thermolysis (practitioner feedback): Thermolysis pill, then the Modality choice. There is no standalone MultiPlex pill any more.
// These helpers give the mounted tests ONE spelling of that path. `multiplexPill` is a read/click adapter over the Modality choice's MultiPlex
// option: it is non-null only while the option is OFFERED as the native xCell Pur load (its label names the machine), pressed while chosen, and
// clicking it chooses MultiPlex, or leaves it again when it is already chosen (the old pill's undo).
import { act } from "react";

export const MULTIPLEX_VALUE = "Multiplex";

export const modalitySelect = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('[data-testid="modality-select"]');

const setSelect = (sel: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

export const modeButton = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === label && !(b.getAttribute("data-testid") ?? "").startsWith("machine-mode-"),
  );

/** Press Thermolysis when the Modality choice is not on screen yet (the only road to it). No-op when it already is. */
export async function ensureThermolysis(host: HTMLElement) {
  const t = modeButton(host, "Thermolysis");
  // a pressed pill carries the dark fill; Thermolysis already pressed means its Modality choice is on screen
  if (!t || t.disabled || t.className.includes("bg-neutral-900")) return;
  if (t && !t.disabled) await act(async () => { t.click(); });
}

export type MultiplexPill = {
  readonly disabled: boolean;
  readonly textContent: string;
  getAttribute(name: string): string | null;
  click(): void;
};

export function multiplexPill(host: HTMLElement): MultiplexPill | null {
  const sel = modalitySelect(host);
  const opt = sel ? Array.from(sel.options).find((o) => o.value === MULTIPLEX_VALUE && (o.textContent ?? "").includes("xCell Pur")) : undefined;
  if (!sel || !opt) return null;
  return {
    get disabled() { return sel.disabled; },
    textContent: opt.textContent ?? "",
    getAttribute: (n) => (n === "aria-pressed" ? (sel.value === MULTIPLEX_VALUE ? "true" : "false") : null),
    click: () => setSelect(sel, sel.value === MULTIPLEX_VALUE ? "" : MULTIPLEX_VALUE),
  };
}

/** Choose MultiPlex through the real path: Thermolysis first, then the Modality choice. */
export async function chooseMultiplex(host: HTMLElement) {
  await ensureThermolysis(host);
  await act(async () => { multiplexPill(host)!.click(); });
}
