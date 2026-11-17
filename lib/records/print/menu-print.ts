// Ctrl/Cmd+P (the browser's own print) prints the record, and the print is recorded through the same audited action as
// the page's Print button. ONE named constant decides the order, because the product owner may require "recorded
// BEFORE paper":
//   "record_after": the record is armed for this one print at once and the print is recorded as the dialog opens. If
//                   the save fails, the person is told "This print wasn't recorded. Press Print on the page to record it."
//                   (paper may already exist: that is the stated trade-off of this setting).
//   "notice_only":  the previous behaviour: the browser's own print shows only the notice; only the page's Print button
//                   prints.
// Recording is idempotent per OPEN of the packet: the page's Print button path is already recorded before its dialog
// opens, so the beforeprint that its window.print() raises records nothing; and one menu print records once per open
// (a later menu print in the same open prints but adds no second row; the page button always records).
export type MenuPrintPolicy = "record_after" | "notice_only";
export const MENU_PRINT_POLICY: MenuPrintPolicy = "record_after";
export const MENU_PRINT_UNRECORDED_MESSAGE = "This print wasn't recorded. Press Print on the page to record it.";

export type MenuPrintDeps = {
  policy: MenuPrintPolicy;
  /** true when the page's own Print button already armed (and recorded) this print. */
  isArmed: () => boolean;
  arm: () => void;
  disarm: () => void;
  record: () => Promise<{ ok: boolean }>;
  onAfterPrint: (cb: () => void) => () => void;
  /** Called with false when a menu print was not recorded; with true when it was. */
  report: (recorded: boolean) => void;
};

export type MenuPrintState = { recorded: boolean; inFlight: boolean };
export const newMenuPrintState = (): MenuPrintState => ({ recorded: false, inFlight: false });

/** The `beforeprint` handler. Synchronous up to the arm (the browser does not wait for anything async). */
export function onBeforePrint(deps: MenuPrintDeps, state: MenuPrintState): void {
  if (deps.isArmed()) return; // the page's button: already recorded, already armed
  if (deps.policy === "notice_only") return; // the document stays hidden; only the notice prints
  deps.arm();
  const unsubscribe = deps.onAfterPrint(() => {
    deps.disarm();
    unsubscribe();
  });
  if (state.recorded || state.inFlight) return;
  state.inFlight = true;
  void deps
    .record()
    .catch(() => ({ ok: false }))
    .then((res) => {
      state.inFlight = false;
      if (res.ok) state.recorded = true;
      deps.report(res.ok);
    });
}
