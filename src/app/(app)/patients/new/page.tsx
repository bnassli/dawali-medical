import Link from "next/link";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { clinicToday, loadDemographicOptions } from "../page-data";
import { PatientForm } from "../patient-form";

export default async function NewPatientPage() {
  const actor = await requireActor();

  if (!actor.permissions.has(PERMISSIONS.PATIENT_CREATE)) {
    return (
      <div>
        <div className="error-banner">
          You do not have permission to create patients (403).
        </div>
        <Link href="/patients">Back to patients</Link>
      </div>
    );
  }

  return (
    <div>
      <h1>Create New Patient</h1>
      <section className="card">
        <PatientForm
          mode="create"
          initial={{}}
          options={await loadDemographicOptions()}
          today={clinicToday()}
          canAddOption={actor.permissions.has(PERMISSIONS.PATIENT_OPTION_ADD)}
          cancelHref="/patients"
        />
      </section>
    </div>
  );
}
