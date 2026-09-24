/**
 * Pure decisions for the unsaved-changes navigation guard (kept DOM-free so
 * they are unit-testable). The React component wires them to document-level
 * capture listeners.
 */

export interface LinkClickInfo {
  /** MouseEvent.button (0 = primary). */
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** Resolved absolute href of the anchor (anchor.href). */
  href: string;
  /** The anchor's target attribute ("" when absent). */
  target: string;
  /** True when the anchor has a download attribute. */
  download: boolean;
  /** window.location.href at click time. */
  currentHref: string;
}

/**
 * True when a click on a link would navigate away from the current page
 * inside this app (and so unmount the clinical form). New-tab/window clicks,
 * downloads, cross-origin links and same-page hash links are not guarded
 * (cross-origin/hard navigations are covered by beforeunload).
 */
export function isGuardedLinkClick(info: LinkClickInfo): boolean {
  if (info.defaultPrevented) return false;
  if (info.button !== 0) return false;
  if (info.metaKey || info.ctrlKey || info.shiftKey || info.altKey) return false;
  if (info.download) return false;
  if (info.target !== "" && info.target !== "_self") return false;
  let target: URL;
  let current: URL;
  try {
    target = new URL(info.href);
    current = new URL(info.currentHref);
  } catch {
    return false;
  }
  if (target.origin !== current.origin) return false;
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  const samePage =
    target.pathname === current.pathname && target.search === current.search;
  if (samePage) return false;
  return true;
}
