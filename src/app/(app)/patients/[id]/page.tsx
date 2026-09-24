import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getPatientById } from "@/modules/patients/service";
import { listVisitsForPatient } from "@/modules/visits/service";
import { createVisitAction, updatePatientAction } from "../actions";

export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  const { error } = await searchParams;

  const patient = await getPatientById(getDb(), actor, id);
  if (!patient) notFound();

  const visits = await listVisitsForPatient(getDb(), actor, id);
  const canUpdate = actor.permissions.has(PERMISSIONS.PATIENT_UPDATE);
  const canCreateVisit = actor.permissions.has(PERMISSIONS.VISIT_CREATE);

  return (
    <div>
      <h1>
        {patient.lastName}, {patient.firstName}
        {patient.middleName ? ` ${patient.middleName}` : ""}
      </h1>
      <p>
        {patient.externalIds.map((e) => (
          <span key={e.system} className="badge" style={{ marginRight: 6 }}>
            {e.system}: {e.value}
          </span>
        ))}
      </p>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="card">
        <h2>Demographics</h2>
        <form action={updatePatientAction}>
          <input type="hidden" name="id" value={patient.id} />
          <input type="hidden" name="expectedVersion" value={patient.version} />
          <div className="field">
            <label htmlFor="firstName">First name</label>
            <input
              id="firstName"
              name="firstName"
              defaultValue={patient.firstName}
              disabled={!canUpdate}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="lastName">Last name</label>
            <input
              id="lastName"
              name="lastName"
              defaultValue={patient.lastName}
              disabled={!canUpdate}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="middleName">Middle name</label>
            <input
              id="middleName"
              name="middleName"
              defaultValue={patient.middleName ?? ""}
              disabled={!canUpdate}
            />
          </div>
          <div className="field">
            <label htmlFor="dateOfBirth">Date of birth</label>
            <input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              defaultValue={patient.dateOfBirth ?? ""}
              disabled={!canUpdate}
            />
          </div>
          <div className="field">
            <label htmlFor="sex">Sex</label>
            <input
              id="sex"
              name="sex"
              defaultValue={patient.sex ?? ""}
              disabled={!canUpdate}
            />
          </div>
          <div className="field">
            <label htmlFor="phone">Phone</label>
            <input
              id="phone"
              name="phone"
              defaultValue={patient.phone ?? ""}
              disabled={!canUpdate}
            />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={patient.email ?? ""}
              disabled={!canUpdate}
            />
          </div>
          {canUpdate ? <button type="submit">Save changes</button> : null}
        </form>
      </section>

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
                <th>Reason</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.visitDate).toLocaleString()}</td>
                  <td>{v.reason ?? "—"}</td>
                  <td>{v.status}</td>
                  <td>
                    <Link href={`/patients/${patient.id}/visits/${v.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canCreateVisit ? (
          <form action={createVisitAction} style={{ marginTop: "1rem" }}>
            <input type="hidden" name="patientId" value={patient.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <div className="field">
              <label htmlFor="reason">Reason for new visit</label>
              <input id="reason" name="reason" />
            </div>
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
