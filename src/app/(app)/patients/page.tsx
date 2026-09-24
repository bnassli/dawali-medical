import Link from "next/link";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { createPatientProps } from "./page-data";
import { PatientSearchPanel } from "./patient-search";

/**
 * Home / Patient Search. The same search panel as the header's Patient Search
 * dialog (FINAL_V1_REQUIREMENTS §4); criteria are POSTed, never put in the URL.
 */
export default async function PatientsPage() {
  const actor = await requireActor();
  const create = await createPatientProps();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Patient Search</h1>
        {actor.permissions.has(PERMISSIONS.PATIENT_CREATE) ? (
          <Link href="/patients/new" className="button">
            Create New Patient
          </Link>
        ) : null}
      </div>
      <section className="card">
        <PatientSearchPanel create={create} />
      </section>
    </div>
  );
}
