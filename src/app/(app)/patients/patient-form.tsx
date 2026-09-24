"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { ageOn } from "@/lib/age";
import { SEX_LABELS, SEX_VALUES, type DemographicListCode } from "@/modules/patients/constants";
import { addDemographicOptionAction, createPatientAction, updatePatientAction } from "./actions";
import {
  INITIAL_PATIENT_FORM_STATE,
  type DemographicOptionLists,
  type PatientFormField,
  type PatientFormValues,
} from "./patient-form-types";

type Option = DemographicOptionLists["nationality"][number];

function DemographicSelect({
  id,
  name,
  label,
  listCode,
  value,
  onChange,
  options,
  onOptionAdded,
  canAddOption,
  disabled,
}: {
  id: string;
  name: PatientFormField;
  label: string;
  listCode: DemographicListCode;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  onOptionAdded: (option: Option) => void;
  canAddOption: boolean;
  disabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active options, plus the current value if it has since been retired.
  const visible = options.filter((o) => o.isActive || o.id === value);

  async function add() {
    if (newLabel.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await addDemographicOptionAction({ listCode, label: newLabel });
      if (result.ok) {
        onOptionAdded(result.option);
        onChange(result.option.id);
        setNewLabel("");
        setAdding(false);
      } else {
        setError(result.error);
      }
    } catch {
      setError("Could not add the option. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="inline-controls">
        <select
          id={id}
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">—</option>
          {visible.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.isActive ? "" : " (retired)"}
            </option>
          ))}
        </select>
        {canAddOption && !disabled && !adding ? (
          <button type="button" className="secondary" onClick={() => setAdding(true)}>
            + Add New
          </button>
        ) : null}
      </div>
      {adding ? (
        <div className="inline-controls" style={{ marginTop: "0.35rem" }}>
          <input
            aria-label={`New ${label} option`}
            value={newLabel}
            maxLength={200}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              // Enter must add the option, not submit the patient form.
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button type="button" onClick={() => void add()} disabled={busy}>
            Add
          </button>
          <button type="button" className="secondary" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? <p className="inline-error">{error}</p> : null}
    </div>
  );
}

/**
 * V1 Create / Edit Patient form (FINAL_V1_REQUIREMENTS §5). Intentionally
 * short. Inputs are controlled so that nothing typed is lost when the server
 * rejects a submission. Age is derived from the date of birth, never entered.
 * The Inactive flag is NOT part of this form (Admin-only separate control).
 */
export function PatientForm({
  mode,
  patientId,
  expectedVersion,
  initial,
  options,
  today,
  canAddOption,
  readOnly = false,
  onCancel,
  cancelHref,
}: {
  mode: "create" | "edit";
  patientId?: string;
  expectedVersion?: number;
  initial: PatientFormValues;
  options: DemographicOptionLists;
  /** Today's date (YYYY-MM-DD) in the clinic time zone, for the derived age. */
  today: string;
  canAddOption: boolean;
  readOnly?: boolean;
  onCancel?: () => void;
  cancelHref?: string;
}) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createPatientAction : updatePatientAction,
    INITIAL_PATIENT_FORM_STATE,
  );
  const [values, setValues] = useState<PatientFormValues>(initial);
  const [lists, setLists] = useState<DemographicOptionLists>(options);
  const uid = useId();
  const idOf = (field: string) => `${uid}-${field}`;

  const set = (field: PatientFormField) => (value: string) =>
    setValues((prev) => ({ ...prev, [field]: value }));
  const val = (field: PatientFormField) => values[field] ?? "";
  const age = ageOn(val("dateOfBirth"), today);

  function text(field: PatientFormField, label: string, extra?: { type?: string; required?: boolean }) {
    return (
      <div className="field">
        <label htmlFor={idOf(field)}>{label}</label>
        <input
          id={idOf(field)}
          name={field}
          type={extra?.type ?? "text"}
          value={val(field)}
          onChange={(e) => set(field)(e.target.value)}
          required={extra?.required}
          disabled={readOnly}
          maxLength={200}
        />
      </div>
    );
  }

  const addedTo = (listCode: DemographicListCode) => (option: Option) =>
    setLists((prev) => ({ ...prev, [listCode]: [...prev[listCode], option] }));

  return (
    <form action={formAction} className="patient-form">
      {mode === "edit" ? (
        <>
          <input type="hidden" name="id" value={patientId} />
          <input type="hidden" name="expectedVersion" value={expectedVersion} />
        </>
      ) : null}
      {state.error ? (
        <div className="error-banner" role="alert">
          {state.error}
        </div>
      ) : null}

      <fieldset>
        <legend>Patient</legend>
        <div className="form-grid">
          {text("icareFileNo", "File / Medical ID (iCare)")}
          {text("firstName", "First Name", { required: true })}
          {text("middleName", "Middle Name")}
          {text("lastName", "Last Name", { required: true })}
          <div className="field">
            <label htmlFor={idOf("sex")}>Sex</label>
            <select
              id={idOf("sex")}
              name="sex"
              value={val("sex")}
              onChange={(e) => set("sex")(e.target.value)}
              disabled={readOnly}
            >
              <option value="">—</option>
              {SEX_VALUES.map((s) => (
                <option key={s} value={s}>
                  {SEX_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          {text("dateOfBirth", "Date of Birth", { type: "date" })}
          <div className="field">
            <label htmlFor={idOf("age")}>Age</label>
            <output id={idOf("age")} className="derived">
              {age === null ? "—" : age}
            </output>
          </div>
          {text("phone", "Mobile / Cell Phone", { type: "tel" })}
          {text("email", "Email", { type: "email" })}
          <DemographicSelect
            id={idOf("nationalityOptionId")}
            name="nationalityOptionId"
            label="Nationality / Race"
            listCode="nationality"
            value={val("nationalityOptionId")}
            onChange={set("nationalityOptionId")}
            options={lists.nationality}
            onOptionAdded={addedTo("nationality")}
            canAddOption={canAddOption}
            disabled={readOnly}
          />
          <DemographicSelect
            id={idOf("preferredLanguageOptionId")}
            name="preferredLanguageOptionId"
            label="Preferred Language"
            listCode="preferred_language"
            value={val("preferredLanguageOptionId")}
            onChange={set("preferredLanguageOptionId")}
            options={lists.preferred_language}
            onOptionAdded={addedTo("preferred_language")}
            canAddOption={canAddOption}
            disabled={readOnly}
          />
          {text("nationalId", "National ID / Iqama")}
          {text("insuranceId", "Insurance ID")}
        </div>
      </fieldset>

      <fieldset>
        <legend>Emergency Contact (optional)</legend>
        <div className="form-grid">
          {text("emergencyContactName", "Name")}
          {text("emergencyContactPhone", "Phone", { type: "tel" })}
          {text("emergencyContactRelationship", "Relationship")}
        </div>
      </fieldset>

      {!readOnly ? (
        <div className="action-bar">
          <button type="submit" disabled={pending}>
            {mode === "create" ? "Create patient" : "Save changes"}
          </button>
          {onCancel ? (
            <button type="button" className="secondary" onClick={onCancel}>
              Cancel
            </button>
          ) : cancelHref ? (
            <Link href={cancelHref} className="button secondary">
              Cancel
            </Link>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
