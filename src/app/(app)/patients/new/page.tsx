import Link from "next/link";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { createPatientAction } from "../actions";

export default async function NewPatientPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const { error } = await searchParams;

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
      <h1>New Patient</h1>
      {error ? <div className="error-banner">{error}</div> : null}
      <form action={createPatientAction} className="card">
        <div className="field">
          <label htmlFor="firstName">First name</label>
          <input id="firstName" name="firstName" required />
        </div>
        <div className="field">
          <label htmlFor="lastName">Last name</label>
          <input id="lastName" name="lastName" required />
        </div>
        <div className="field">
          <label htmlFor="middleName">Middle name</label>
          <input id="middleName" name="middleName" />
        </div>
        <div className="field">
          <label htmlFor="dateOfBirth">Date of birth</label>
          <input id="dateOfBirth" name="dateOfBirth" type="date" />
        </div>
        <div className="field">
          <label htmlFor="sex">Sex</label>
          <input id="sex" name="sex" placeholder="e.g. F, M" />
        </div>
        <div className="field">
          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" />
        </div>
        <div className="field">
          <label htmlFor="icareFileNo">iCare file number (optional)</label>
          <input id="icareFileNo" name="icareFileNo" />
        </div>
        <div className="action-bar">
          <button type="submit">Create patient</button>
          <Link href="/patients" className="button secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
