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
  type OrderedRow,
} from "@/modules/clinical/autosave-client";
import { FIELD_EXCLUSION_RULES } from "@/modules/clinical/definitions";
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

function optionLabel(id: string, options: OptionView[]): string {
  return options.find((o) => o.id === id)?.label ?? "(unknown option)";
}

function describe(value: EntryValue, options: OptionView[]): string {
  if (value.checked !== undefined) return value.checked ? "Checked" : "Unchecked";
  if (value.numberValue !== undefined && value.numberValue !== null) return String(value.numberValue);
  if (value.rows) {
    const rows = value.rows
      .map((r, i) => {
        const parts = [r.optionId ? optionLabel(r.optionId, options) : "", r.freeText].filter((p) => p !== "");
        return parts.length > 0 ? `${i + 1}. ${parts.join(" — ")}` : "";
      })
      .filter((r) => r !== "");
    const mode = value.display === "numbers" ? " (Numbers)" : "";
    return rows.length > 0 ? `${rows.join("; ")}${mode}` : `(empty)${mode}`;
  }
  const labels = value.optionIds.map((id) => optionLabel(id, options));
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
  return (
    v.optionIds.length > 0 ||
    v.freeText.trim() !== "" ||
    v.checked === true ||
    (v.rows ?? []).some((r) => r.optionId !== null || r.freeText.trim() !== "") ||
    (v.numberValue !== undefined && v.numberValue !== null)
  );
}

const EMPTY_ROW: OrderedRow = { optionId: null, freeText: "" };

/**
 * Ordered rows 1..N (ADR-029): each row is a reusable option and/or free text.
 * Rows are positional — what the doctor puts in row 3 stays row 3. Impression
 * also has a Bullets / Numbers display mode, stored per visit.
 */
function OrderedListEditor({
  field,
  value,
  options,
  disabled,
  onChange,
  onFlush,
}: {
  field: ClinicalFieldView;
  value: EntryValue;
  options: OptionView[];
  disabled: boolean;
  onChange: (next: EntryValue, delayMs: number) => void;
  onFlush: () => void;
}) {
  const config = field.orderedList;
  if (!config) return null;
  const rows = Array.from({ length: config.rows }, (_, i) => value.rows?.[i] ?? EMPTY_ROW);
  const display = config.displayMode ? (value.display ?? "bullets") : undefined;
  const numbered = !config.displayMode || display === "numbers";

  const emit = (nextRows: OrderedRow[], nextDisplay: typeof display, delayMs: number) =>
    onChange(
      {
        optionIds: [],
        freeText: "",
        rows: nextRows,
        ...(nextDisplay ? { display: nextDisplay } : {}),
      },
      delayMs,
    );
  const setRow = (index: number, row: OrderedRow, delayMs: number) =>
    emit(
      rows.map((r, i) => (i === index ? row : r)),
      display,
      delayMs,
    );

  return (
    <div className="ordered-list" id={`field-${field.code}`}>
      {config.displayMode ? (
        <div className="display-mode" role="radiogroup" aria-label={`${field.label} display`}>
          {(["bullets", "numbers"] as const).map((mode) => (
            <label key={mode} className="check">
              <input
                type="radio"
                name={`${field.code}-display`}
                checked={display === mode}
                disabled={disabled}
                onChange={() => emit(rows, mode, CHOICE_DEBOUNCE_MS)}
              />{" "}
              {mode === "bullets" ? "Bullets" : "Numbers"}
            </label>
          ))}
        </div>
      ) : null}
      <ol className="ordered-rows">
        {rows.map((row, i) => {
          const selectable = options.filter((o) => o.isActive || o.id === row.optionId);
          return (
            <li key={i} className="ordered-row">
              <span className="row-marker" aria-hidden="true">
                {numbered ? `${i + 1}.` : "•"}
              </span>
              <select
                aria-label={`${field.label} row ${i + 1}`}
                value={row.optionId ?? ""}
                disabled={disabled}
                onChange={(e) =>
                  setRow(i, { ...row, optionId: e.target.value || null }, CHOICE_DEBOUNCE_MS)
                }
              >
                <option value="">—</option>
                {selectable.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                    {o.isActive ? "" : " (retired)"}
                  </option>
                ))}
              </select>
              <input
                type="text"
                aria-label={`${field.label} row ${i + 1} — free text`}
                placeholder="Free text for this visit only"
                value={row.freeText}
                maxLength={1000}
                disabled={disabled}
                onChange={(e) => setRow(i, { ...row, freeText: e.target.value }, TYPING_DEBOUNCE_MS)}
                onBlur={onFlush}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A structured number in the field's unit (ADR-029). Invalid input is never sent. */
function NumberEditor({
  field,
  value,
  disabled,
  onChange,
  onFlush,
}: {
  field: ClinicalFieldView;
  value: EntryValue;
  disabled: boolean;
  onChange: (next: EntryValue, delayMs: number) => void;
  onFlush: () => void;
}) {
  const config = field.number;
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  if (!config) return null;
  const stored = value.numberValue === undefined || value.numberValue === null ? "" : String(value.numberValue);
  const step = config.decimals > 0 ? String(10 ** -config.decimals) : "1";

  function change(text: string) {
    setDraft(text);
    if (text.trim() === "") {
      setInvalid(false);
      onChange({ optionIds: [], freeText: "", numberValue: null }, TYPING_DEBOUNCE_MS);
      return;
    }
    const n = Number(text);
    const ok = config !== null && Number.isFinite(n) && n >= config.min && n <= config.max;
    setInvalid(!ok);
    if (ok) onChange({ optionIds: [], freeText: "", numberValue: n }, TYPING_DEBOUNCE_MS);
  }

  return (
    <div className="inline-controls number-field">
      <input
        id={`field-${field.code}`}
        type="number"
        inputMode="decimal"
        min={config.min}
        max={config.max}
        step={step}
        value={draft ?? stored}
        disabled={disabled}
        aria-invalid={invalid}
        onFocus={() => setDraft(stored)}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
          onFlush();
        }}
      />
      <span className="unit">{config.unit}</span>
      {invalid ? (
        <span className="inline-error">
          Enter a number from {config.min} to {config.max} {config.unit}.
        </span>
      ) : null}
    </div>
  );
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
}: {
  field: ClinicalFieldView;
  saver: FieldSaver;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  exclusion: Exclusion | null;
}) {
  const snap = useSaver(saver);
  const isSelect = field.fieldType === "select";
  const isMulti = field.fieldType === "multiselect";
  const isChoice = isSelect || isMulti;
  const isCheckbox = field.fieldType === "checkbox";
  const isOrdered = field.fieldType === "ordered_list";
  const isNumber = field.fieldType === "number";
  const inputId = `field-${field.code}`;
  const { optionIds, freeText } = snap.value;
  const options = snap.options;
  const retired = !field.isActive;
  const fieldReadOnly = readOnly || retired || field.readOnlyReason !== null;

  const [newLabel, setNewLabel] = useState("");
  const [addMessage, setAddMessage] = useState<{ ok: boolean; text: string; expired?: boolean } | null>(
    null,
  );
  const [adding, setAdding] = useState(false);

  const blocked = useExclusionBlock(exclusion, isCheckbox ? snap.value.checked === true : hasValue(snap.value));
  const disabled = fieldReadOnly || snap.conflict !== null || blocked;
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
      setAddMessage({ ok: false, text: result.message, expired: result.sessionExpired });
      return;
    }
    saver.addOptionToList(result.option);
    setNewLabel("");
    // Ordered rows: the new option is offered in every row; the doctor picks the row.
    if (canWrite && !fieldReadOnly && !snap.conflict && !blocked && !isOrdered) {
      changeOptions(isMulti ? [...optionIds, result.option.id] : [result.option.id]);
    }
    setAddMessage({ ok: true, text: `Added "${result.option.label}" to the list.` });
  }

  return (
    <div
      className="field clinical-field"
      data-field={field.code}
      data-field-active={field.isActive ? "true" : "false"}
    >
      <div className="field-head">
        <label htmlFor={inputId}>
          {field.label}
          {isNumber && field.number ? ` (${field.number.unit})` : null}
          {retired ? <span className="muted"> (retired field, read-only)</span> : null}
        </label>
        <span className={`save-status ${snap.status}`} role="status" aria-live="polite">
          {statusText(snap)}
        </span>
      </div>

      {isCheckbox ? (
        <input
          id={inputId}
          type="checkbox"
          checked={snap.value.checked === true}
          disabled={disabled}
          onChange={(e) => changeChecked(e.target.checked)}
        />
      ) : null}

      {blockedText ? <span className="muted">{blockedText}</span> : null}
      {field.readOnlyReason ? <span className="muted">{field.readOnlyReason}</span> : null}

      {isOrdered ? (
        <OrderedListEditor
          field={field}
          value={snap.value}
          options={options}
          disabled={disabled}
          onChange={(next, delay) => saver.edit(next, delay)}
          onFlush={() => void saver.flush()}
        />
      ) : null}

      {isNumber ? (
        <NumberEditor
          field={field}
          value={snap.value}
          disabled={disabled}
          onChange={(next, delay) => saver.edit(next, delay)}
          onFlush={() => void saver.flush()}
        />
      ) : null}

      {isSelect ? (
        <select
          id={inputId}
          value={optionIds[0] ?? ""}
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
          disabled={disabled}
          onChange={(e) => changeFreeText(e.target.value)}
          onBlur={() => void saver.flush()}
        />
      ) : null}

      {field.fieldType === "textarea" ? (
        <textarea
          id={inputId}
          rows={3}
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
            <span className="muted">Theirs:</span>{" "}
            {describe(snap.conflict.theirs, snap.conflict.options)}
          </div>
          <div>
            <span className="muted">Mine:</span> {describe(snap.value, [...snap.options, ...snap.conflict.options])}
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

      {(isChoice || isOrdered) && canAddOption && !retired && field.readOnlyReason === null && !blocked ? (
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
  );
}

/**
 * Consecutive fields with the same group label form one visual block (ADR-029);
 * fields without a group are rendered as they were.
 */
function groupFields(fields: ClinicalFieldView[]) {
  const blocks: { key: string; label: string | null; fields: ClinicalFieldView[] }[] = [];
  for (const f of fields) {
    const last = blocks[blocks.length - 1];
    if (last && last.label === f.groupLabel) last.fields.push(f);
    else blocks.push({ key: `${blocks.length}:${f.groupLabel ?? ""}`, label: f.groupLabel, fields: [f] });
  }
  return blocks;
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
}: {
  visitId: string;
  actorId: string;
  sectionCode: string;
  fields: ClinicalFieldView[];
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
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
        result.set(f.id, { role: "excluded", peers: savers([flag]), peerLabels: [flag.label] });
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
      <div className="clinical-form">
        {groupFields(fields).map((block) => {
          const editors = block.fields.map((field) => {
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
              />
            ) : null;
          });
          return block.label ? (
            <fieldset key={block.key} className="clinical-group">
              <legend>{block.label}</legend>
              {editors}
            </fieldset>
          ) : (
            <div key={block.key} className="clinical-ungrouped">
              {editors}
            </div>
          );
        })}
      </div>
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
}) {
  return (
    <ClinicalSectionFormInner
      key={`${props.visitId}:${props.sectionCode}:${props.actorId}`}
      {...props}
    />
  );
}
