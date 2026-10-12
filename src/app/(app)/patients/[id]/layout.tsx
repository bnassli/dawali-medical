import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ageOn } from "@/lib/age";
import { requireActor } from "@/modules/auth/current-actor";
import { EXTERNAL_ID_SYSTEMS, SEX_LABELS, type Sex } from "@/modules/patients/constants";
import { externalIdOf } from "@/modules/patients/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { clinicToday, createPatientProps, loadPatient } from "../page-data";
import { PatientSearchDialog } from "../patient-search";

function sexLabel(sex: string | null): string {
  return sex && sex in SEX_LABELS ? SEX_LABELS[sex as Sex] : "—";
}

/** ISO yyyy-mm-dd -> dd/mm/yyyy, the order SonoSoft shows in its date box. */
function dayMonthYear(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Persistent Patient Header (FINAL_V1_REQUIREMENTS §3) drawn with the geometry
 * of SonoSoft's patient header (docs/reference/sonosoft/). Only the V1 items are
 * shown; SonoSoft's Workup/Check Out block, photo, Time Card/billing controls and
 * the legacy navigation row (Ext Demographics, Insurance tabs, ...) are
 * intentionally NOT reproduced (§3, §14). Saving is automatic on clinical
 * screens (autosave), so "Home / Save" only navigates.
 */
export default async function PatientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const patient = await loadPatient(id);
  if (!patient) notFound();

  const fileId = externalIdOf(patient, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO);
  const today = clinicToday();
  const age = ageOn(patient.dateOfBirth, today);
  const canCreate = actor.permissions.has(PERMISSIONS.PATIENT_CREATE);
  const canManageOptions = actor.permissions.has(PERMISSIONS.CLINICAL_OPTION_MANAGE);

  return (
    <div className="sono-shell">
      <section className="patient-header sono-header" aria-label="Patient">
        <div className="sh-date" aria-label="Today">
          {dayMonthYear(today)}
        </div>
        <div className="sh-name">
          {patient.lastName}, {patient.firstName}
          {patient.middleName ? ` ${patient.middleName}` : ""}
          {patient.isActive ? null : (
            <>
              {" "}
              <span className="badge inactive">Inactive</span>
            </>
          )}
        </div>
        <div className="sh-file" aria-label="File / Medical ID">
          {fileId ?? "—"}
        </div>

        <nav className="sh-top-actions" aria-label="Patient actions">
          {canManageOptions ? (
            <Link href="/admin/options" className="sh-btn sh-btn-small">
              Modify Drop
              <br />
              Down List
            </Link>
          ) : null}
          <Link href="/patients" className="sh-btn sh-home">
            Home / Save
          </Link>
        </nav>

        <div className="sh-left-box">
          {canCreate ? (
            <Link href="/patients/new" className="sh-btn sh-red-text">
              Create New Patient Record
            </Link>
          ) : null}
          <div className="sh-search">
            <PatientSearchDialog create={await createPatientProps()} />
          </div>
        </div>

        <button
          type="button"
          className="sh-btn sh-big sh-report"
          disabled
          title="Open a visit and use its Reports section to create a report."
        >
          Create Report
        </button>
        <Link href={`/patients/${patient.id}`} className="sh-btn sh-big sh-chart">
          View Patient Chart
        </Link>

        <div className="sh-user">
          <span className="sh-user-label">Current User</span>
          <span className="sh-user-box" aria-label="Current user">
            {actor.displayName}
          </span>
        </div>

        <dl className="sh-strip">
          <div className="sh-f sh-f-id">
            <dt>ID#</dt>
            <dd>{fileId ?? "—"}</dd>
          </div>
          <div className="sh-f sh-f-first">
            <dt>First Name</dt>
            <dd>{patient.firstName}</dd>
          </div>
          <div className="sh-f sh-f-mi">
            <dt>MI</dt>
            <dd>{patient.middleName ? patient.middleName.charAt(0) : ""}</dd>
          </div>
          <div className="sh-f sh-f-last">
            <dt>Last Name</dt>
            <dd>{patient.lastName}</dd>
          </div>
          <div className="sh-f sh-f-race">
            <dt>Race</dt>
            <dd>{patient.nationality?.label ?? ""}</dd>
          </div>
          <div className="sh-f sh-f-sex">
            <dt>Sex</dt>
            <dd>{sexLabel(patient.sex)}</dd>
          </div>
          <div className="sh-f sh-f-dob">
            <dt>Birthdate</dt>
            <dd>{patient.dateOfBirth ?? "—"}</dd>
          </div>
          <div className="sh-f sh-f-age">
            <dt>Age</dt>
            <dd>{age ?? "—"}</dd>
          </div>
        </dl>

        <p className="sh-clinic">Dawali Clinic</p>
      </section>
      <div className="sono-shell-body">{children}</div>
    </div>
  );
}
