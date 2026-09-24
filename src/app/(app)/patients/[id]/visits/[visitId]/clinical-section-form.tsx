"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CHOICE_DEBOUNCE_MS,
  FieldSaver,
  postNewOption,
  SaverGroup,
  TYPING_DEBOUNCE_MS,
  type EntryValue,
  type FieldSnapshot,
  type OptionView,
} from "@/modules/clinical/autosave-client";
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
  readOnly,
  canWrite,
  canAddOption,
}: {
  field: ClinicalFieldView;
  saver: FieldSaver;
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

  const [newLabel, setNewLabel] = useState("");
  const [addMessage, setAddMessage] = useState<{ ok: boolean; text: string; expired?: boolean } | null>(
    null,
  );
  const [adding, setAdding] = useState(false);

  const disabled = readOnly || snap.conflict !== null;

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
    const result = await postNewOption(field.id, label);
    setAdding(false);
    if (!result.ok) {
      setAddMessage({ ok: false, text: result.message, expired: result.sessionExpired });
      return;
    }
    saver.addOptionToList(result.option);
    setNewLabel("");
    if (canWrite && !readOnly && !snap.conflict) {
      changeOptions(isMulti ? [...optionIds, result.option.id] : [result.option.id]);
    }
    setAddMessage({ ok: true, text: `Added "${result.option.label}" to the list.` });
  }

  const canRetry = snap.status === "error" || snap.status === "session-expired" || snap.status === "locked";

  return (
    <div className="field clinical-field" data-field={field.code}>
      <div className="field-head">
        <label htmlFor={inputId}>{field.label}</label>
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
      {snap.status === "session-expired" ? (
        <a href="/login" target="_blank" rel="noopener noreferrer">
          Sign in again (opens in a new tab)
        </a>
      ) : null}
      {canRetry ? (
        <button type="button" className="secondary" onClick={() => void saver.retry()}>
          Retry save
        </button>
      ) : null}

      {isChoice && canAddOption ? (
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

export function ClinicalSectionForm({
  visitId,
  fields,
  readOnly,
  canWrite,
  canAddOption,
}: {
  visitId: string;
  fields: ClinicalFieldView[];
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
}) {
  const [group] = useState(() => {
    const g = new SaverGroup();
    for (const f of fields) {
      g.add(
        f.id,
        new FieldSaver({
          visitId,
          fieldId: f.id,
          initialVersion: f.version,
          initialValue: f.value,
          initialOptions: f.options,
        }),
      );
    }
    return g;
  });
  const unsaved = useSyncExternalStore(group.subscribe, group.getUnsavedCount, group.getUnsavedCount);

  useEffect(() => {
    // Send anything still pending when the page is hidden or unloading, via
    // fetch keepalive so the request outlives the page. Nothing is stored
    // in localStorage/sessionStorage.
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
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [group]);

  return (
    <div className="clinical-form-wrap">
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
              readOnly={readOnly}
              canWrite={canWrite}
              canAddOption={canAddOption}
            />
          ) : null;
        })}
      </div>
    </div>
  );
}
