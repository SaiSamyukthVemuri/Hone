"use client";

import { useEffect, useRef, useState } from "react";

type ScreenMode = "normal" | "expanded" | "fullscreen";

/** The expanded layout also works when a browser or embedding page denies native fullscreen. */
export function useSettingsScreen(drawerOpen: boolean) {
  const screen = useRef<HTMLDivElement>(null);
  const screenButton = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<ScreenMode>("normal");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const onChange = () => {
      const native = document.fullscreenElement === screen.current;
      setMode((current) => native ? "fullscreen" : current === "fullscreen" ? "normal" : current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (mode !== "expanded" || drawerOpen || pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const modal = '[aria-modal="true"], dialog[open]';
      if ((event.target instanceof Element && event.target.closest(modal)) || document.querySelector(modal)) return;
      setMode("normal");
      screenButton.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, drawerOpen, pending]);

  async function toggle() {
    const element = screen.current;
    if (!element || pending) return;
    if (mode === "expanded") {
      setMode("normal");
      return;
    }
    if (mode === "fullscreen") {
      setPending(true);
      try {
        await document.exitFullscreen();
      } catch {
        // If the browser already exited, synchronize even if its event arrived first.
        if (document.fullscreenElement !== element) setMode("normal");
      } finally {
        setPending(false);
      }
      return;
    }

    setMode("expanded");
    if (!document.fullscreenEnabled || !element.requestFullscreen) return;
    setPending(true);
    try {
      await element.requestFullscreen();
    } catch {
      // Permission policy and iOS can reject the native request. The expanded layout is already active.
    } finally {
      setPending(false);
    }
  }

  return { screen, screenButton, mode, pending, toggle };
}
