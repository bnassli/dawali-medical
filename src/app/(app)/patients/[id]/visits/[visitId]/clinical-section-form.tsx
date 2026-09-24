"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClinicalFieldView, ClinicalOptionView } from "@/modules/clinical/service";
import { addOptionAction, saveEntryAction } from "./clinical-actions";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface EntryValue {
  optionIds: string[];
  freeText: string;
}

const TYPING_DEBOUNCE_MS = 700;
const CHOICE_DEBOUNCE_MS = 150;

/**
 * Debounced auto-save for one field. Saves are strictly serialised (one in
 * flight at a time, newest pending value wins) so versions are written in the
 * order the doctor made the changes.
 */
function useAutoSave(visitId: string, fieldId: string) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<EntryValue | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (pending.current) {
        const value = pending.current;
        pending.current = null;
        setState("saving");
        const result = await saveEntryAction({ visitId, fieldId, ...value });
        if (!result.ok) {
          setError(result.error);
          setState("error");
          return;
        }
      }
      setError(null);
      setState("saved");
    } catch {
      setError("Could not reach the server.");
      setState("error");
    } finally {
      inFlight.current = false;
    }
  }, [visitId, fieldId]);

  const schedule = useCallback(
    (value: EntryValue, delayMs: number) => {
      pending.current = value;
      setState("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [flush],
  );

  useEffect(
    () => () => {
      // Navigating away with a queued edit: send it rather than drop it.
      if (pending.current) void flush();
    },
    [flush],
  );

  return { state, error, schedule, flush };
}

function statusText(state: SaveState, error: string | null): string {
  switch (state) {
    case "dirty":
      return "Unsaved…";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return `Not saved: ${error ?? "error"}`;
    default:
      return "";
  }
}

function FieldEditor({
  field,
  visitId,
  readOnly,
  canWrite,
  canAddOption,
}: {
  field: ClinicalFieldView;
  visitId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
}) {
  const isSelect = field.fieldType === "select";
  const isMulti = field.fieldType === "multiselect";
  const isChoice = isSelect || isMulti;

  const [options, setOptions] = useState<ClinicalOptionView[]>(field.options);
  const [optionIds, setOptionIds] = useState<string[]>(field.value.optionIds);
  const [freeText, setFreeText] = useState<string>(field.value.freeText);
  const [newLabel, setNewLabel] = useState("");
  const [addMessage, setAddMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const { state, error, schedule, flush } = useAutoSave(visitId, field.id);

  const inputId = `field-${field.code}`;

  function changeOptions(next: string[]) {
    setOptionIds(next);
    schedule({ optionIds: next, freeText }, CHOICE_DEBOUNCE_MS);
  }

  function changeFreeText(next: string) {
    setFreeText(next);
    schedule({ optionIds, freeText: next }, TYPING_DEBOUNCE_MS);
  }

  function toggleOption(id: string, checked: boolean) {
    changeOptions(checked ? [...optionIds, id] : optionIds.filter((v) => v !== id));
  }

  async function addNew() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    setAddMessage(null);
    try {
      const result = await addOptionAction({ fieldId: field.id, label });
      if (!result.ok) {
        setAddMessage({ ok: false, text: result.error });
        return;
      }
      setOptions((prev) => [...prev, result.option]);
      setNewLabel("");
      if (canWrite && !readOnly) {
        changeOptions(isMulti ? [...optionIds, result.option.id] : [result.option.id]);
      }
      setAddMessage({ ok: true, text: `Added "${result.option.label}" to the list.` });
    } catch {
      setAddMessage({ ok: false, text: "Could not reach the server." });
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="field clinical-field">
      <label htmlFor={inputId}>
        {field.label}{" "}
        <span className={`save-status ${state}`} role="status">
          {statusText(state, error)}
        </span>
      </label>

      {isSelect ? (
        <select
          id={inputId}
          value={optionIds[0] ?? ""}
          disabled={readOnly}
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
        <div className="checks" id={inputId}>
          {options.length === 0 ? <span className="muted">No options yet.</span> : null}
          {options.map((o) => (
            <label key={o.id} className="check">
              <input
                type="checkbox"
                checked={optionIds.includes(o.id)}
                disabled={readOnly || (!o.isActive && !optionIds.includes(o.id))}
                onChange={(e) => toggleOption(o.id, e.target.checked)}
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
          disabled={readOnly}
          onChange={(e) => changeFreeText(e.target.value)}
          onBlur={() => void flush()}
        />
      ) : null}

      {field.fieldType === "text" ? (
        <input
          id={inputId}
          type="text"
          value={freeText}
          disabled={readOnly}
          onChange={(e) => changeFreeText(e.target.value)}
          onBlur={() => void flush()}
        />
      ) : null}

      {field.fieldType === "textarea" ? (
        <textarea
          id={inputId}
          rows={3}
          value={freeText}
          disabled={readOnly}
          onChange={(e) => changeFreeText(e.target.value)}
          onBlur={() => void flush()}
        />
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
        <span className={addMessage.ok ? "muted" : "inline-error"}>{addMessage.text}</span>
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
  return (
    <div className="clinical-form">
      {fields.map((field) => (
        <FieldEditor
          key={field.id}
          field={field}
          visitId={visitId}
          readOnly={readOnly}
          canWrite={canWrite}
          canAddOption={canAddOption}
        />
      ))}
    </div>
  );
}
