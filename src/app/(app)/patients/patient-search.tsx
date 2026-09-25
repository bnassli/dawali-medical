"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { parseDayMonthYear } from "@/lib/day-month-year";
import { searchPatientsAction } from "./actions";
import { PatientForm } from "./patient-form";
import type {
  DemographicOptionLists,
  PatientFormValues,
  PatientSearchRow,
} from "./patient-form-types";

const RESULT_LIMIT = 100;

interface Criteria {
  externalId: string;
  lastName: string;
  firstName: string;
  insuranceId: string;
  dateOfBirth: string;
  phone: string;
}

const EMPTY_CRITERIA: Criteria = {
  externalId: "",
  lastName: "",
  firstName: "",
  insuranceId: "",
  dateOfBirth: "",
  phone: "",
};

const CRITERIA_LABELS: [keyof Criteria, string, string][] = [
  ["externalId", "Medical / File ID", "text"],
  ["lastName", "Last Name", "text"],
  ["firstName", "First Name", "text"],
  ["insuranceId", "Insurance ID", "text"],
  ["dateOfBirth", "Birthdate", "text"],
  ["phone", "Cell / Mobile", "tel"],
];

/** Wait after the last keystroke before searching (search as you type, PS1). */
const SEARCH_DEBOUNCE_MS = 300;

export interface CreatePatientProps {
  options: DemographicOptionLists;
  today: string;
  canAddOption: boolean;
}

/**
 * SonoSoft-style Patient Search (FINAL_V1_REQUIREMENTS §4): criteria, a compact
 * results table (double-click or Open), and "Create New Patient Record" which
 * opens the create form prefilled with what was typed.
 *
 * Deliberately NOT a <form>: searching does not navigate, and the clinical
 * unsaved-changes guard treats every form submit on a visit page as leaving the
 * page. Enter in any criterion runs the search. Criteria are sent by POST
 * (server action) and never appear in the URL.
 */
export function PatientSearchPanel({
  create,
}: {
  /** Present only when the user may create patients. */
  create: CreatePatientProps | null;
}) {
  const [criteria, setCriteria] = useState<Criteria>(EMPTY_CRITERIA);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [rows, setRows] = useState<PatientSearchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<PatientFormValues | null>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const requestSeq = useRef(0);
  const uid = useId();

  const birthIso = parseDayMonthYear(criteria.dateOfBirth);
  const birthError =
    birthIso === null ? "Birthdate must be day/month/year, e.g. 01/01/1925." : null;

  async function runSearch() {
    if (birthIso === null) return; // an unfinished or impossible date is not searched
    const seq = ++requestSeq.current;
    const hasCriteria =
      Object.entries(criteria).some(([k, v]) => k !== "dateOfBirth" && v.trim() !== "") ||
      birthIso !== "";
    setSearching(true);
    setError(null);
    try {
      const result = await searchPatientsAction(
        hasCriteria
          ? { ...criteria, dateOfBirth: birthIso, includeInactive }
          : { recent: true, includeInactive },
      );
      if (seq !== requestSeq.current) return; // a newer search already started
      if (result.ok) {
        setRows(result.rows);
        setSelected(result.rows[0]?.id ?? null);
      } else {
        setRows(null);
        setError(result.error);
      }
    } catch {
      if (seq === requestSeq.current) setError("Search failed. Please try again.");
    } finally {
      if (seq === requestSeq.current) setSearching(false);
    }
  }

  // Search as you type (PS1). Also runs once on open: the recent patients list.
  const runSearchRef = useRef(runSearch);
  useEffect(() => {
    runSearchRef.current = runSearch;
  });
  useEffect(() => {
    const t = setTimeout(() => void runSearchRef.current(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [criteria, includeInactive]);

  /** Opens a patient through its real link, so in-app navigation guards apply. */
  function open(id: string) {
    linkRefs.current.get(id)?.click();
  }

  function startCreate() {
    setCreating({
      icareFileNo: criteria.externalId.trim(),
      lastName: criteria.lastName.trim(),
      firstName: criteria.firstName.trim(),
      insuranceId: criteria.insuranceId.trim(),
      dateOfBirth: birthIso ?? "",
      phone: criteria.phone.trim(),
    });
  }

  if (creating && create) {
    return (
      <div>
        <h2 style={{ marginTop: 0 }}>Create New Patient Record</h2>
        <PatientForm
          mode="create"
          initial={creating}
          options={create.options}
          today={create.today}
          canAddOption={create.canAddOption}
          onCancel={() => setCreating(null)}
        />
      </div>
    );
  }

  const table =
    rows === null ? null : rows.length === 0 ? (
      <p role="status">No patients matched your search.</p>
    ) : (
      <>
        <table className="search-results">
          <thead>
            <tr>
              <th>MedicalID</th>
              <th>Last Name</th>
              <th>First Name</th>
              <th>Birthdate</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                aria-selected={selected === r.id}
                className={selected === r.id ? "selected" : undefined}
                onClick={() => setSelected(r.id)}
                onDoubleClick={() => open(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) {
                    e.preventDefault();
                    open(r.id);
                  }
                }}
              >
                <td>{r.fileId ?? "—"}</td>
                <td>{r.lastName}</td>
                <td>
                  {r.firstName}
                  {r.middleName ? ` ${r.middleName}` : ""}
                  {r.isActive ? null : (
                    <>
                      {" "}
                      <span className="badge">Inactive</span>
                    </>
                  )}
                </td>
                <td>{r.dateOfBirth ?? "—"}</td>
                <td>
                  <Link
                    href={`/patients/${r.id}`}
                    ref={(el) => {
                      if (el) linkRefs.current.set(r.id, el);
                      else linkRefs.current.delete(r.id);
                    }}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length >= RESULT_LIMIT ? (
          <p className="muted">Showing the first {RESULT_LIMIT} matches — refine the search.</p>
        ) : null}
      </>
    );

  // SonoSoft order (PS2): the instruction and results on top, criteria below.
  return (
    <div className="patient-search">
      <p className="search-hint">Double click on the patient you would like to select.</p>
      <div className="search-results-wrap" aria-busy={searching}>
        {table}
      </div>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <div className="search-bottom">
        <div
          role="search"
          aria-label="Patient search"
          className="form-grid search-criteria"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              void runSearch();
            }
          }}
        >
          {CRITERIA_LABELS.map(([key, label, type]) => (
            <div className="field" key={key}>
              <label htmlFor={`${uid}-${key}`}>{label}</label>
              <input
                id={`${uid}-${key}`}
                type={type}
                value={criteria[key]}
                maxLength={200}
                autoComplete="off"
                placeholder={key === "dateOfBirth" ? "dd/mm/yyyy" : undefined}
                aria-describedby={key === "dateOfBirth" ? `${uid}-dob-hint` : undefined}
                onChange={(e) => setCriteria((prev) => ({ ...prev, [key]: e.target.value }))}
              />
              {key === "dateOfBirth" ? (
                <span id={`${uid}-dob-hint`} className={birthError ? "inline-error" : "muted"}>
                  {birthError ?? "E.G. 01/01/1925"}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="search-actions">
          <label className="check">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />{" "}
            Include inactive
          </label>
          {create ? (
            <>
              <p className="muted search-create-hint">
                If the patient does not exist, then you can create a new patient here. The data will be
                transferred to the Patient Demographic form.
              </p>
              <button type="button" className="secondary" onClick={startCreate}>
                Create a New Patient Record
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The header's "Patient Search" button + modal dialog. */
export function PatientSearchDialog({ create }: { create: CreatePatientProps | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const titleId = useId();

  // Opening a patient (or creating one) navigates: close the dialog then.
  useEffect(() => {
    dialogRef.current?.close();
  }, [pathname]);

  function openDialog() {
    setSession((n) => n + 1); // fresh, empty search each time
    setIsOpen(true);
    dialogRef.current?.showModal();
  }

  return (
    <>
      <button type="button" className="secondary" onClick={openDialog}>
        Patient Search
      </button>
      <dialog
        ref={dialogRef}
        className="search-dialog"
        aria-labelledby={titleId}
        onClose={() => setIsOpen(false)}
      >
        <div className="dialog-head">
          <h2 id={titleId} style={{ margin: 0 }}>
            Patient Search
          </h2>
          <button type="button" className="secondary" onClick={() => dialogRef.current?.close()}>
            Close
          </button>
        </div>
        {isOpen ? (
          <PatientSearchPanel key={session} create={create} />
        ) : null}
      </dialog>
    </>
  );
}
