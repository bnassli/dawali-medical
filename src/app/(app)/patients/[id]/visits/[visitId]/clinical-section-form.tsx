"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  const labels = value.optionIds.map((id) => options.find((o) => o.id === id)?.label ?? "(unknown option)");
  const parts = [...labels, value.freeText].filter((p) => p !== "");
  return parts.length > 0 ? parts.join("; ") : "(empty)";
}

function FieldEditor({
  field,
  saver,
  actorId,
  readOnly,
  canWrite,
  canAddOption,
}: {
  field: ClinicalFieldView;
  saver: FieldSaver;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
}) {
  const snap = useSaver(saver);
  const isSelect = field.fieldType === "select";
  const isMulti = field.fieldType === "multiselect";
  const isChoice = isSelect || isMulti;
  const inputId = `field-${field.code}`;
  const { optionIds, freeText } = snap.value;
  const options = snap.options;
  const retired = !field.isActive;
  const fieldReadOnly = readOnly || retired;

  const [newLabel, setNewLabel] = useState("");
  const [addMessage, setAddMessage] = useState<{ ok: boolean; text: string; expired?: boolean } | null>(
    null,
  );
  const [adding, setAdding] = useState(false);

  const disabled = fieldReadOnly || snap.conflict !== null;

  function changeOptions(next: string[]) {
    saver.edit({ optionIds: next, freeText }, CHOICE_DEBOUNCE_MS);
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
    if (canWrite && !fieldReadOnly && !snap.conflict) {
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
          {retired ? <span className="muted"> (retired field, read-only)</span> : null}
        </label>
        <span className={`save-status ${snap.status}`} role="status" aria-live="polite">
          {statusText(snap)}
        </span>
      </div>

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

      {isChoice && canAddOption && !retired ? (
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
        {fields.map((field) => {
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
            />
          ) : null;
        })}
      </div>
      {prompt ? <DiscardDialog items={prompt.items} onStay={stay} onDiscard={discardAndLeave} /> : null}
    </div>
  );
}

/**
 * The savers, visit id and field list are created once per (visit, user) and
 * must never be reused for another visit or user. Keying the inner component
 * by both guarantees a full remount — and therefore fresh savers — when the
 * route switches from one visit to another (V1 -> V2 -> V1) or the session's
 * user changes, even if a parent reuses this component instance.
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
  return <ClinicalSectionFormInner key={`${props.visitId}:${props.actorId}`} {...props} />;
}
