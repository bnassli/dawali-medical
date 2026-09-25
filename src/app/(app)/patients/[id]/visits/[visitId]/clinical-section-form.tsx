"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CHOICE_DEBOUNCE_MS,
  fetchSectionState,
  FieldSaver,
  postNewOption,
  SaverGroup,
  TYPING_DEBOUNCE_MS,
  type EntryValue,
  type FieldSnapshot,
  type OptionView,
} from "@/modules/clinical/autosave-client";
import {
  FEMALE_ONLY_FIELD_CODES,
  FIELD_EXCLUSION_RULES,
  FIXED_CHOICES,
  NUMERIC_FIELD_RULES,
} from "@/modules/clinical/definitions";
import {
  layoutFieldCodes,
  SECTION_LAYOUTS,
  type LayoutBox,
  type LayoutCell,
  type RowFiller,
} from "@/modules/clinical/layouts";
import { isGuardedLinkClick } from "@/modules/clinical/navigation-guard";
import type { ClinicalFieldView } from "@/modules/clinical/service";

function useSaver(saver: FieldSaver): FieldSnapshot {
  return useSyncExternalStore(saver.subscribe, saver.getSnapshot, saver.getSnapshot);
}

function statusText(snap: FieldSnapshot): string {
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

function describe(value: EntryValue, options: OptionView[]): string {
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
interface Exclusion {
  /** "flag" = this is the checkbox; "excluded" = this is a field the checkbox rules out. */
  role: "flag" | "excluded";
  peers: FieldSaver[];
  peerLabels: string[];
}

function hasValue(v: EntryValue): boolean {
  return v.optionIds.length > 0 || v.freeText.trim() !== "" || v.checked === true;
}

function useExclusionBlock(exclusion: Exclusion | null, selfActive: boolean): boolean {
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

const NO_PEERS: FieldSaver[] = [];

function FieldEditor({
  field,
  saver,
  actorId,
  readOnly,
  canWrite,
  canAddOption,
  exclusion,
  cell,
  lockedReason,
}: {
  field: ClinicalFieldView;
  saver: FieldSaver;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  exclusion: Exclusion | null;
  /** Placement in a SonoSoft-style layout (compact rendering); null = plain vertical form. */
  cell?: LayoutCell | null;
  /** Why the field cannot take a new value (e.g. female-only); clearing stays possible. */
  lockedReason?: string | null;
}) {
  const snap = useSaver(saver);
  const compact = Boolean(cell);
  const visibleLabel = cell?.label ?? field.label;
  const isSelect = field.fieldType === "select";
  const isMulti = field.fieldType === "multiselect";
  const isChoice = isSelect || isMulti;
  const isCheckbox = field.fieldType === "checkbox";
  const isNumber = field.fieldType === "number";
  const isFixedChoice = field.fieldType === "choice";
  const inputId = `field-${field.code}`;
  const { optionIds, freeText } = snap.value;
  const options = snap.options;
  const retired = !field.isActive;
  const fieldReadOnly = readOnly || retired;

  const [newLabel, setNewLabel] = useState("");
  const [addMessage, setAddMessage] = useState<{
    ok: boolean;
    text: string;
    expired?: boolean;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  // Compact (SonoSoft) layout keeps "+ Add New" folded behind a small "+" so
  // each field stays one line, like SonoSoft's combo boxes.
  const [showAdd, setShowAdd] = useState(false);

  const blocked = useExclusionBlock(
    exclusion,
    isCheckbox ? snap.value.checked === true : hasValue(snap.value),
  );
  // A locked field (e.g. female-only for a non-female patient) stays editable
  // while it still holds a value, so that value can be cleared.
  const locked = Boolean(lockedReason) && !hasValue(snap.value);
  const disabled = fieldReadOnly || snap.conflict !== null || blocked || locked;
  const blockedText =
    blocked && exclusion
      ? exclusion.role === "flag"
        ? `Clear ${exclusion.peerLabels.join(", ")} to mark this as Unknown.`
        : `Uncheck ${exclusion.peerLabels.join(", ")} to enter values here.`
      : null;

  function changeOptions(next: string[]) {
    saver.edit({ optionIds: next, freeText }, CHOICE_DEBOUNCE_MS);
  }

  function changeChecked(next: boolean) {
    saver.edit({ optionIds: [], freeText: "", checked: next }, CHOICE_DEBOUNCE_MS);
  }

  function changeFreeText(next: string) {
    saver.edit({ optionIds, freeText: next }, TYPING_DEBOUNCE_MS);
  }

  async function addNew() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    setAddMessage(null);
    const result = await postNewOption(field.id, label, actorId);
    setAdding(false);
    if (!result.ok) {
      setAddMessage({
        ok: false,
        text: result.message,
        expired: result.sessionExpired,
      });
      return;
    }
    saver.addOptionToList(result.option);
    setNewLabel("");
    if (canWrite && !fieldReadOnly && !snap.conflict && !blocked) {
      changeOptions(isMulti ? [...optionIds, result.option.id] : [result.option.id]);
    }
    setAddMessage({
      ok: true,
      text: `Added "${result.option.label}" to the list.`,
    });
  }

  // The control's accessible name is always the field's own label, even when
  // the layout shows a shorter one ("1:", "How long?") or none.
  const controlName = field.label;
  const canAddOptionHere = isChoice && canAddOption && !retired && !blocked && !locked;
  const numberRule = isNumber ? NUMERIC_FIELD_RULES[field.code] : undefined;
  const choices = isFixedChoice ? (FIXED_CHOICES[field.code] ?? []) : [];
  const classes = [
    "field",
    "clinical-field",
    compact ? "compact" : "",
    compact && cell?.size ? `size-${cell.size}` : "",
    compact && cell?.tall ? "tall" : "",
    isCheckbox ? "is-checkbox" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-field={field.code} data-field-active={field.isActive ? "true" : "false"}>
      {compact && isCheckbox ? null : (
        <div className="field-head">
          <label htmlFor={inputId} className={cell?.hideLabel ? "visually-hidden" : undefined}>
            {visibleLabel}
            {retired ? <span className="muted"> (retired field, read-only)</span> : null}
          </label>
          <span className={`save-status ${snap.status}`} role="status" aria-live="polite">
            {statusText(snap)}
          </span>
          {compact && canAddOptionHere ? (
            <button
              type="button"
              className="add-toggle secondary"
              aria-expanded={showAdd}
              aria-label={`Add option to ${field.label}`}
              title="Add a new option to this list"
              onClick={() => setShowAdd((v) => !v)}
            >
              +
            </button>
          ) : null}
        </div>
      )}

      <div className="field-body">
        {isCheckbox ? (
          compact ? (
            <div className="check-inline">
              <input
                id={inputId}
                type="checkbox"
                checked={snap.value.checked === true}
                disabled={disabled}
                onChange={(e) => changeChecked(e.target.checked)}
              />
              <label htmlFor={inputId}>
                {visibleLabel}
                {retired ? <span className="muted"> (retired field, read-only)</span> : null}
              </label>
              <span className={`save-status ${snap.status}`} role="status" aria-live="polite">
                {statusText(snap)}
              </span>
            </div>
          ) : (
            <input
              id={inputId}
              type="checkbox"
              checked={snap.value.checked === true}
              disabled={disabled}
              onChange={(e) => changeChecked(e.target.checked)}
            />
          )
        ) : null}

        {blockedText ? <span className="muted">{blockedText}</span> : null}
        {locked && lockedReason ? <span className="muted">{lockedReason}</span> : null}

        {isNumber ? (
          <span className="number-input">
            <input
              id={inputId}
              type="text"
              inputMode="decimal"
              aria-label={controlName}
              value={freeText}
              disabled={disabled}
              onChange={(e) => changeFreeText(e.target.value)}
              onBlur={() => void saver.flush()}
            />
            {numberRule ? <span className="unit">{numberRule.unit}</span> : null}
          </span>
        ) : null}

        {isFixedChoice ? (
          <div className="radios" role="radiogroup" aria-label={field.label} id={inputId}>
            {choices.map((c) => (
              <label key={c.value} className="check">
                <input
                  type="radio"
                  name={`${inputId}-choice`}
                  value={c.value}
                  checked={freeText === c.value}
                  disabled={disabled}
                  onChange={() => saver.edit({ optionIds: [], freeText: c.value }, CHOICE_DEBOUNCE_MS)}
                />{" "}
                {c.label}
              </label>
            ))}
          </div>
        ) : null}

        {isSelect ? (
          <select
            id={inputId}
            value={optionIds[0] ?? ""}
            aria-label={controlName}
            disabled={disabled}
            onChange={(e) => changeOptions(e.target.value ? [e.target.value] : [])}
          >
            <option value="">—</option>
            {options.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.isActive && !optionIds.includes(o.id)}>
                {o.label}
                {o.isActive ? "" : " (retired)"}
              </option>
            ))}
          </select>
        ) : null}

        {isMulti ? (
          <div className="checks" role="group" aria-labelledby={`${inputId}-legend`} id={inputId}>
            <span id={`${inputId}-legend`} hidden>
              {field.label}
            </span>
            {options.length === 0 ? <span className="muted">No options yet.</span> : null}
            {options.map((o) => (
              <label key={o.id} className="check">
                <input
                  type="checkbox"
                  checked={optionIds.includes(o.id)}
                  disabled={disabled || (!o.isActive && !optionIds.includes(o.id))}
                  onChange={(e) =>
                    changeOptions(
                      e.target.checked ? [...optionIds, o.id] : optionIds.filter((v) => v !== o.id),
                    )
                  }
                />{" "}
                {o.label}
                {o.isActive ? "" : " (retired)"}
              </label>
            ))}
          </div>
        ) : null}

        {isChoice && field.allowsFreeText ? (
          <input
            type="text"
            aria-label={`${field.label} — visit-only free text`}
            placeholder="Free text for this visit only"
            value={freeText}
            disabled={disabled}
            onChange={(e) => changeFreeText(e.target.value)}
            onBlur={() => void saver.flush()}
          />
        ) : null}

        {field.fieldType === "text" ? (
          <input
            id={inputId}
            type="text"
            value={freeText}
            aria-label={controlName}
            disabled={disabled}
            onChange={(e) => changeFreeText(e.target.value)}
            onBlur={() => void saver.flush()}
          />
        ) : null}

        {field.fieldType === "textarea" ? (
          <textarea
            id={inputId}
            aria-label={controlName}
            rows={compact && !cell?.tall ? 1 : 3}
            value={freeText}
            disabled={disabled}
            onChange={(e) => changeFreeText(e.target.value)}
            onBlur={() => void saver.flush()}
          />
        ) : null}

        {snap.conflict ? (
          <div className="conflict" role="alert">
            <strong>Conflict</strong> — someone else changed this field after you loaded it.
            <div>
              <span className="muted">Theirs:</span> {describe(snap.conflict.theirs, snap.conflict.options)}
            </div>
            <div>
              <span className="muted">Mine:</span>{" "}
              {describe(snap.value, [...snap.options, ...snap.conflict.options])}
            </div>
            <div className="conflict-actions">
              <button type="button" onClick={() => void saver.keepMine()}>
                Keep mine
              </button>
              <button type="button" className="secondary" onClick={() => saver.useTheirs()}>
                Use theirs
              </button>
            </div>
          </div>
        ) : null}

        {snap.message && !snap.conflict ? <span className="inline-error">{snap.message}</span> : null}
        {snap.failure === "session-expired" ? (
          <a href="/login" target="_blank" rel="noopener noreferrer">
            Sign in again (opens in a new tab)
          </a>
        ) : null}
        {snap.failure !== null ? (
          <button type="button" className="secondary" onClick={() => void saver.retry()}>
            Retry save
          </button>
        ) : null}

        {canAddOptionHere && (!compact || showAdd) ? (
          <div className="add-new">
            <input
              type="text"
              aria-label={`New ${field.label} option`}
              placeholder="New option (saved to the list for all visits)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addNew();
                }
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={adding || newLabel.trim() === ""}
              onClick={() => void addNew()}
            >
              + Add New
            </button>
          </div>
        ) : null}
        {addMessage ? (
          <span className={addMessage.ok ? "muted" : "inline-error"}>
            {addMessage.text}
            {addMessage.expired ? (
              <>
                {" "}
                <a href="/login" target="_blank" rel="noopener noreferrer">
                  Sign in again (opens in a new tab)
                </a>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * SonoSoft's "Select Impressions" / "Select Recomendations": choosing an option
 * puts it into the first empty row (AP1/AP2). Rows keep their own saves.
 */
function RowFillerControl({
  filler,
  rows,
  disabled,
}: {
  filler: RowFiller;
  rows: { field: ClinicalFieldView; saver: FieldSaver }[];
  disabled: boolean;
}) {
  const snaps = rows.map((r) => r.saver.getSnapshot());
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = rows.map((r) => r.saver.subscribe(listener));
      return () => offs.forEach((off) => off());
    },
    [rows],
  );
  const firstEmpty = useSyncExternalStore(
    subscribe,
    () => rows.findIndex((r) => !hasValue(r.saver.getSnapshot().value)),
    () => rows.findIndex((r) => !hasValue(r.saver.getSnapshot().value)),
  );
  const options = (snaps[0]?.options ?? []).filter((o) => o.isActive);
  const target = firstEmpty >= 0 ? rows[firstEmpty] : undefined;

  return (
    <label className="row-filler">
      <span>{filler.label}</span>
      <select
        aria-label={filler.label}
        value=""
        disabled={disabled || !target || options.length === 0}
        onChange={(e) => {
          if (!target || !e.target.value) return;
          target.saver.edit({ optionIds: [e.target.value], freeText: "" }, CHOICE_DEBOUNCE_MS);
        }}
      >
        <option value="">{target ? `→ row ${firstEmpty + 1}` : "All rows are filled"}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface DiscardPrompt {
  items: { label: string; status: string }[];
  proceed: () => void;
  opener: HTMLElement | null;
}

/** Explicit confirmation before unsaved clinical text is thrown away. Keyboard operable, focus-trapped. */
function DiscardDialog({
  items,
  onStay,
  onDiscard,
}: {
  items: DiscardPrompt["items"];
  onStay: () => void;
  onDiscard: () => void;
}) {
  const stayRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stayRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onStay();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-title"
        aria-describedby="discard-desc"
        onKeyDown={onKeyDown}
      >
        <h2 id="discard-title">Leave without saving?</h2>
        <p id="discard-desc">
          These fields have text that could not be saved. If you leave now it will be lost.
        </p>
        <ul>
          {items.map((i) => (
            <li key={i.label}>
              <strong>{i.label}</strong> — {i.status}
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" ref={stayRef} onClick={onStay}>
            Stay on page
          </button>
          <button type="button" className="secondary" onClick={onDiscard}>
            Discard unsaved text and leave
          </button>
        </div>
      </div>
    </div>
  );
}

function ClinicalSectionFormInner({
  visitId,
  actorId,
  sectionCode,
  fields,
  readOnly,
  canWrite,
  canAddOption,
  patientSex,
}: {
  visitId: string;
  actorId: string;
  sectionCode: string;
  fields: ClinicalFieldView[];
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  patientSex: string | null;
}) {
  const [group] = useState(() => {
    const g = new SaverGroup(visitId, actorId);
    for (const f of fields) {
      g.add(
        f.id,
        new FieldSaver({
          visitId,
          fieldId: f.id,
          actorId,
          initialVersion: f.version,
          initialValue: f.value,
          initialOptions: f.options,
        }),
      );
    }
    return g;
  });
  const unsaved = useSyncExternalStore(group.subscribe, group.getUnsavedCount, group.getUnsavedCount);
  const [prompt, setPrompt] = useState<DiscardPrompt | null>(null);

  // Exclusion rules whose fields are all placed in this tab (ADR-027).
  const exclusions = useMemo(() => {
    const byCode = new Map(fields.map((f) => [f.code, f]));
    const result = new Map<string, Exclusion>();
    for (const rule of FIELD_EXCLUSION_RULES) {
      const flag = byCode.get(rule.flag);
      const excluded = rule.excludes.flatMap((code) => {
        const f = byCode.get(code);
        return f ? [f] : [];
      });
      if (!flag || excluded.length === 0) continue;
      const savers = (list: ClinicalFieldView[]) =>
        list.flatMap((f) => {
          const sv = group.get(f.id);
          return sv ? [sv] : [];
        });
      result.set(flag.id, {
        role: "flag",
        peers: savers(excluded),
        peerLabels: excluded.map((f) => f.label),
      });
      for (const f of excluded) {
        result.set(f.id, {
          role: "excluded",
          peers: savers([flag]),
          peerLabels: [flag.label],
        });
      }
    }
    return result;
  }, [fields, group]);

  // Server props changed under a live form (router.refresh / revalidation):
  // adopt newer versions only for fields with nothing unsaved.
  useEffect(() => {
    for (const f of fields) group.get(f.id)?.reconcile(f.version, f.value, f.options);
  }, [fields, group]);

  // A page restored from the browser's back/forward cache (or left open) may
  // carry a stale server render. Pull the current state on mount and whenever
  // the tab becomes visible again; fields with unsaved text are left alone.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const state = await fetchSectionState(visitId, sectionCode);
      if (!cancelled && state && state.visitId === group.visitId) group.reconcileFromServer(state.fields);
    };
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [group, visitId, sectionCode]);

  useEffect(() => {
    let bypass = false;
    let checking = false;

    const fieldLabel = (id: string) => fields.find((f) => f.id === id)?.label ?? "Field";
    const statusFor = (id: string) => {
      const snap = group.get(id)?.getSnapshot();
      return snap ? statusText(snap) || "not saved" : "not saved";
    };

    // Resolve a guarded navigation: try to save everything first (keepalive so
    // it survives if the browser proceeds anyway); only if something still is
    // not safely stored do we ask the user, who must explicitly discard.
    const decide = async (proceed: () => void) => {
      if (checking) return;
      checking = true;
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        await group.flushAll({ keepalive: true });
        if (group.getUnsavedCount() === 0) {
          proceed();
          return;
        }
        setPrompt({
          items: group.unsavedFieldIds().map((id) => ({ label: fieldLabel(id), status: statusFor(id) })),
          proceed,
          opener,
        });
      } finally {
        checking = false;
      }
    };

    const onClick = (e: MouseEvent) => {
      if (bypass || group.getUnsavedCount() === 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const guarded = isGuardedLinkClick({
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        defaultPrevented: e.defaultPrevented,
        href: anchor.href,
        target: anchor.getAttribute("target") ?? "",
        download: anchor.hasAttribute("download"),
        currentHref: window.location.href,
      });
      if (!guarded) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void decide(() => {
        bypass = true;
        try {
          anchor.click();
        } finally {
          bypass = false;
        }
      });
    };

    // Forms on this page (Logout, ...) navigate away too.
    const onSubmit = (e: SubmitEvent) => {
      if (bypass || group.getUnsavedCount() === 0) return;
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const submitter = e.submitter instanceof HTMLElement ? e.submitter : null;
      void decide(() => {
        bypass = true;
        try {
          form.requestSubmit(submitter);
        } finally {
          bypass = false;
        }
      });
    };

    // Hard navigations (reload, close, typed URL): best-effort keepalive flush
    // plus the browser's own leave-page prompt while anything is unsaved.
    const onHide = () => void group.flushAll({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      onHide();
      if (group.getUnsavedCount() > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      // Unmounting (in-app navigation, back button): send what we can. Anything
      // explicitly discarded was already dropped from the savers.
      void group.flushAll({ keepalive: true });
    };
  }, [group, fields]);

  const layout = SECTION_LAYOUTS[sectionCode] ?? null;
  const byCode = new Map(fields.map((f) => [f.code, f]));
  const placedCodes = new Set(layout ? layoutFieldCodes(layout) : []);
  const unplaced = layout ? fields.filter((f) => !placedCodes.has(f.code)) : [];

  function lockedReasonFor(field: ClinicalFieldView): string | null {
    if (FEMALE_ONLY_FIELD_CODES.includes(field.code) && patientSex !== "F") {
      return "For female patients only.";
    }
    return null;
  }

  function renderField(field: ClinicalFieldView, cell: LayoutCell | null) {
    const saver = group.get(field.id);
    return saver ? (
      <FieldEditor
        key={field.id}
        field={field}
        saver={saver}
        actorId={actorId}
        readOnly={readOnly}
        canWrite={canWrite}
        canAddOption={canAddOption}
        exclusion={exclusions.get(field.id) ?? null}
        cell={cell}
        lockedReason={lockedReasonFor(field)}
      />
    ) : null;
  }

  function renderBox(box: LayoutBox) {
    const rows = box.rows
      .map((r) => r.cells.filter((c) => byCode.has(c.code)))
      .filter((cells) => cells.length > 0);
    if (rows.length === 0) return null;
    const fillerRows = box.filler
      ? box.filler.codes.flatMap((code) => {
          const field = byCode.get(code);
          const saver = field ? group.get(field.id) : undefined;
          return field && saver && field.isActive ? [{ field, saver }] : [];
        })
      : [];
    return (
      <section
        key={box.id}
        className={`layout-box tone-${box.tone}`}
        data-box={box.id}
        aria-label={box.title}
      >
        {box.title || box.filler ? (
          <div className="box-head">
            {box.title ? <h3 className="box-title">{box.title}</h3> : null}
            {box.filler && fillerRows.length > 0 ? (
              <RowFillerControl filler={box.filler} rows={fillerRows} disabled={readOnly} />
            ) : null}
          </div>
        ) : null}
        {box.caption ? <p className="box-caption">{box.caption}</p> : null}
        {rows.map((cells) => (
          <div className="layout-row" key={cells.map((c) => c.code).join(":")}>
            {cells.map((c) => {
              const field = byCode.get(c.code);
              return field ? renderField(field, c) : null;
            })}
          </div>
        ))}
      </section>
    );
  }

  function stay() {
    const opener = prompt?.opener ?? null;
    setPrompt(null);
    opener?.focus();
  }

  function discardAndLeave() {
    const proceed = prompt?.proceed;
    group.discardAll();
    setPrompt(null);
    proceed?.();
  }

  return (
    <div className="clinical-form-wrap" data-visit-id={visitId}>
      <div
        className={`unsaved-banner${unsaved > 0 ? " visible" : ""}`}
        role="alert"
        aria-live="assertive"
        data-testid="unsaved-banner"
      >
        {unsaved > 0
          ? `${unsaved} field${unsaved === 1 ? "" : "s"} not saved yet — keep this page open until it says Saved.`
          : ""}
      </div>
      {layout ? (
        <div className="clinical-form clinical-layout" data-layout={sectionCode}>
          {layout.boxes.map((box) => renderBox(box))}
          {unplaced.length > 0 ? (
            <div className="layout-box tone-plain" data-box="other">
              {unplaced.map((field) => (
                <div className="layout-row" key={field.id}>
                  {renderField(field, { code: field.code, size: "full" })}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="clinical-form">{fields.map((field) => renderField(field, null))}</div>
      )}
      {prompt ? <DiscardDialog items={prompt.items} onStay={stay} onDiscard={discardAndLeave} /> : null}
    </div>
  );
}

/**
 * The savers, visit id and field list are created once per (visit, section,
 * user) and must never be reused for another visit, tab or user. Keying the
 * inner component by all three guarantees a full remount — and therefore fresh
 * savers — when the route switches from one visit to another (V1 -> V2 -> V1),
 * from one tab to another, or the session's user changes, even if a parent
 * reuses this component instance.
 */
export function ClinicalSectionForm(props: {
  visitId: string;
  actorId: string;
  sectionCode: string;
  fields: ClinicalFieldView[];
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  patientSex: string | null;
}) {
  return (
    <ClinicalSectionFormInner key={`${props.visitId}:${props.sectionCode}:${props.actorId}`} {...props} />
  );
}
