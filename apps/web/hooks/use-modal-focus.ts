"use client";
import { useEffect, type RefObject } from "react";

export function useModalFocus(active: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const root = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0);
    (root.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not(:disabled), textarea:not(:disabled)') ?? focusable()[0] ?? root).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab") return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [active, ref, close]);
}
