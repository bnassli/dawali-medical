import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { MAX_FREE_TEXT_LENGTH } from "@/modules/clinical/schema";
import { getVisitReasons } from "@/modules/clinical/service";
import { EXTERNAL_ID_SYSTEMS } from "@/modules/patients/constants";
import { externalIdOf } from "@/modules/patients/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { listVisitsForPatient } from "@/modules/visits/service";
import { createVisitAction, setPatientActiveAction } from "../actions";
import { clinicToday, loadDemographicOptions, loadPatient } from "../page-data";
import { PatientForm } from "../patient-form";

export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  const { error, saved } = await searchParams;

  // Validated and loaded (once per request) by the patient layout.
  const patient = await loadPatient(id);
  if (!patient) notFound();

  const visits = await listVisitsForPatient(getDb(), actor, id);
  const canUpdate = actor.permissions.has(PERMISSIONS.PATIENT_UPDATE);
  const canSetActive = actor.permissions.has(PERMISSIONS.PATIENT_SET_ACTIVE);
  const canCreateVisit = actor.permissions.has(PERMISSIONS.VISIT_CREATE);
  // Reason for Visit lives only in clinical_entries (ADR-024); roles without
  // clinical.read (e.g. Reception) do not see it, and only clinical.write
  // roles may enter one when creating a visit.
  const canReadClinical = actor.permissions.has(PERMISSIONS.CLINICAL_READ);
  const canEnterReason = actor.permissions.has(PERMISSIONS.CLINICAL_WRITE);
  const reasons = canReadClinical
    ? await getVisitReasons(
        getDb(),
        actor,
        visits.map((v) => v.id),
      )
    : new Map<string, string>();

  return (
    <div>
      <h1>Patient Chart</h1>

      {error ? <div className="error-banner">{error}</div> : null}
      {saved && !error ? (
        <p className="muted" role="status">
          Patient details saved.
        </p>
      ) : null}

      <section className="card">
        <h2>Patient Details</h2>
        <PatientForm
          // Remount on every saved version so the form shows the stored values.
          key={patient.version}
          mode="edit"
          patientId={patient.id}
          expectedVersion={patient.version}
          initial={{
            icareFileNo: externalIdOf(patient, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO) ?? "",
            firstName: patient.firstName,
            middleName: patient.middleName ?? "",
            lastName: patient.lastName,
            sex: patient.sex ?? "",
            dateOfBirth: patient.dateOfBirth ?? "",
            phone: patient.phone ?? "",
            email: patient.email ?? "",
            nationalityOptionId: patient.nationalityOptionId ?? "",
            preferredLanguageOptionId: patient.preferredLanguageOptionId ?? "",
            nationalId: externalIdOf(patient, EXTERNAL_ID_SYSTEMS.NATIONAL_ID) ?? "",
            insuranceId: patient.insuranceId ?? "",
            emergencyContactName: patient.emergencyContactName ?? "",
            emergencyContactPhone: patient.emergencyContactPhone ?? "",
            emergencyContactRelationship: patient.emergencyContactRelationship ?? "",
          }}
          options={await loadDemographicOptions()}
          today={clinicToday()}
          canAddOption={actor.permissions.has(PERMISSIONS.PATIENT_OPTION_ADD)}
          readOnly={!canUpdate}
        />
      </section>

      {canSetActive ? (
        <section className="card">
          <h2>Inactive Patient</h2>
          <p className="muted">
            {patient.isActive
              ? "Inactive patients are hidden from the default search and cannot get new visits. Their history is kept."
              : "This patient is inactive: hidden from the default search, and no new visits can be created until reactivated."}
          </p>
          <form action={setPatientActiveAction}>
            <input type="hidden" name="id" value={patient.id} />
            <input type="hidden" name="expectedVersion" value={patient.version} />
            <input type="hidden" name="isActive" value={(!patient.isActive).toString()} />
            <button type="submit" className="secondary">
              {patient.isActive ? "Mark patient inactive" : "Reactivate patient"}
            </button>
          </form>
        </section>
      ) : null}

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Visits</h2>
        </div>
        {visits.length === 0 ? (
          <p>No visits yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                {canReadClinical ? <th>Reason</th> : null}
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.visitDate).toLocaleString()}</td>
                  {canReadClinical ? <td>{reasons.get(v.id) ?? "—"}</td> : null}
                  <td>{v.status}</td>
                  <td>
                    <Link href={`/patients/${patient.id}/visits/${v.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canCreateVisit && !patient.isActive ? (
          <p className="muted" style={{ marginTop: "1rem" }}>
            This patient is inactive. An administrator must reactivate the patient before a new
            visit can be created.
          </p>
        ) : canCreateVisit ? (
          <form action={createVisitAction} style={{ marginTop: "1rem" }}>
            <input type="hidden" name="patientId" value={patient.id} />
            {canEnterReason ? (
              <div className="field">
                <label htmlFor="reason">Reason for new visit</label>
                <input id="reason" name="reason" maxLength={MAX_FREE_TEXT_LENGTH} />
              </div>
            ) : null}
            <button type="submit">New visit</button>
          </form>
        ) : null}
      </section>

      <div className="action-bar">
        <Link href="/patients" className="button secondary">
          Back to patients
        </Link>
      </div>
    </div>
  );
}
