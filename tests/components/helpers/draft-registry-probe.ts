import { createElement, type ReactNode } from "react";

import { DraftRegistryProvider, useDraftRegistryState, type DraftRegistryView } from "@/components/machines/draft-registry";

// A host stand-in for the mounted suites: it owns a draft registry the way block-setup-form does and exposes the derived view, so a
// test reads what the HOST would know ("is anything unsaved", "is a save unresolved") instead of a callback the components no longer call.
export type ViewRef = { current: DraftRegistryView };
export const newViewRef = (): ViewRef => ({ current: { anyDraft: false, anyUnresolved: false } });

function Probe({ viewRef, children }: { viewRef: ViewRef; children?: ReactNode }) {
  const { api, view } = useDraftRegistryState();
  viewRef.current = view;
  return createElement(DraftRegistryProvider, { api, view }, children);
}

/** Wrap `children` in a host registry whose derived view is written into `viewRef` on every render. */
export const withRegistry = (viewRef: ViewRef, children: ReactNode) => createElement(Probe, { viewRef }, children);
