"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { EntryValue, FieldSaver, FieldSnapshot, OptionView } from "@/modules/clinical/autosave-client";

/** Shared by the plain clinical form and the SonoSoft pixel form. */

export function useSaver(saver: FieldSaver): FieldSnapshot {
  return useSyncExternalStore(saver.subscribe, saver.getSnapshot, saver.getSnapshot);
}

export function statusText(snap: FieldSnapshot): string {
  switch (snap.status) {
    case "dirty":
      return "Unsaved…";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "conflict":
      return "Conflict";
    case "session-expired":
      return "Session expired — not saved";
    case "actor-mismatch":
      return "Signed in as another user — not saved";
    case "locked":
      return "Locked — not saved";
    case "error":
      return "Not saved";
    default:
      return "";
  }
}

export function describe(value: EntryValue, options: OptionView[]): string {
  if (value.checked !== undefined) return value.checked ? "Checked" : "Unchecked";
  const labels = value.optionIds.map((id) => options.find((o) => o.id === id)?.label ?? "(unknown option)");
  const parts = [...labels, value.freeText].filter((p) => p !== "");
  return parts.length > 0 ? parts.join("; ") : "(empty)";
}

/**
 * Mutual exclusion between fields of this tab (ADR-027, FIELD_EXCLUSION_RULES),
 * e.g. "Unknown" vs Past Medical Hx. The UI only disables: it never clears or
 * rewrites the other field. The server enforces the same rule.
 */
export interface Exclusion {
  /** "flag" = this is the checkbox; "excluded" = this is a field the checkbox rules out. */
  role: "flag" | "excluded";
  peers: FieldSaver[];
  peerLabels: string[];
}

export function hasValue(v: EntryValue): boolean {
  return v.optionIds.length > 0 || v.freeText.trim() !== "" || v.checked === true;
}

export function useExclusionBlock(exclusion: Exclusion | null, selfActive: boolean): boolean {
  const peers = exclusion?.peers ?? NO_PEERS;
  const role = exclusion?.role;
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = peers.map((p) => p.subscribe(listener));
      return () => offs.forEach((off) => off());
    },
    [peers],
  );
  const getBlocked = useCallback(() => {
    if (!role || selfActive) return false; // never trap a value the user must be able to clear
    return peers.some((p) => hasValue(p.getSnapshot().value));
  }, [peers, role, selfActive]);
  return useSyncExternalStore(subscribe, getBlocked, getBlocked);
}

export const NO_PEERS: FieldSaver[] = [];

