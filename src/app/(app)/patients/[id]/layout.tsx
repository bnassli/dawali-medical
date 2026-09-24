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

/**
 * Persistent Patient Header (FINAL_V1_REQUIREMENTS §3) shown on the Patient
 * Chart and on every visit/clinical screen of this patient. Compact patient
 * context + actions only: the legacy SonoSoft navigation row (Ext Demographics,
 * Insurance tabs, Today's Charges, ...) is intentionally NOT reproduced.
 * Saving is automatic on clinical screens (autosave), so there is no Save button.
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
  const age = ageOn(patient.dateOfBirth, clinicToday());
  const canCreate = actor.permissions.has(PERMISSIONS.PATIENT_CREATE);

  return (
    <>
      <section className="patient-header" aria-label="Patient">
        <dl className="patient-facts">
          <div>
            <dt>File / Medical ID</dt>
            <dd>{fileId ?? "—"}</dd>
          </div>
          <div className="patient-name">
            <dt>Patient</dt>
            <dd>
              {patient.lastName}, {patient.firstName}
              {patient.middleName ? ` ${patient.middleName}` : ""}
              {patient.isActive ? null : (
                <>
                  {" "}
                  <span className="badge inactive">Inactive</span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Sex</dt>
            <dd>{sexLabel(patient.sex)}</dd>
          </div>
          <div>
            <dt>Birthdate</dt>
            <dd>{patient.dateOfBirth ?? "—"}</dd>
          </div>
          <div>
            <dt>Age</dt>
            <dd>{age ?? "—"}</dd>
          </div>
          {patient.nationality ? (
            <div>
              <dt>Nationality</dt>
              <dd>{patient.nationality.label}</dd>
            </div>
          ) : null}
        </dl>
        <nav className="patient-actions" aria-label="Patient actions">
          <Link href="/patients" className="button secondary">
            Home
          </Link>
          {canCreate ? (
            <Link href="/patients/new" className="button secondary">
              Create New Patient
            </Link>
          ) : null}
          <PatientSearchDialog create={await createPatientProps()} />
          <Link href={`/patients/${patient.id}`} className="button secondary">
            View Patient Chart
          </Link>
          <button
            type="button"
            className="secondary"
            disabled
            title="Reports are not available yet (planned for R5)."
          >
            Create Report
          </button>
          <span className="current-user" aria-label="Current user">
            {actor.displayName}
          </span>
        </nav>
      </section>
      {children}
    </>
  );
}
