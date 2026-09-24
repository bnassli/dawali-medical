import Link from "next/link";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { searchPatientsSchema } from "@/modules/patients/schema";
import { searchPatients, type PatientRecord } from "@/modules/patients/service";

function formatExternalIds(p: PatientRecord): string {
  return p.externalIds.map((e) => `${e.system}: ${e.value}`).join(", ") || "—";
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActor();
  const sp = await searchParams;

  const hasCriteria = Boolean(sp.name || sp.externalId || sp.phone || sp.dateOfBirth);
  let results: PatientRecord[] = [];
  let error: string | null = null;

  if (hasCriteria) {
    const parsed = searchPatientsSchema.safeParse(sp);
    if (!parsed.success) {
      error = parsed.error.issues[0]?.message ?? "Invalid search input";
    } else {
      results = await searchPatients(getDb(), actor, parsed.data);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Patients</h1>
        <Link href="/patients/new" className="button">
          New patient
        </Link>
      </div>

      <form className="card" method="get">
        <div className="field">
          <label htmlFor="name">Name (first or last)</label>
          <input id="name" name="name" defaultValue={sp.name ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="externalId">External file number (e.g. iCare)</label>
          <input id="externalId" name="externalId" defaultValue={sp.externalId ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" defaultValue={sp.phone ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="dateOfBirth">Date of birth</label>
          <input
            id="dateOfBirth"
            name="dateOfBirth"
            type="date"
            defaultValue={sp.dateOfBirth ?? ""}
          />
        </div>
        <button type="submit">Search</button>
      </form>

      {error ? <div className="error-banner">{error}</div> : null}

      {hasCriteria && !error ? (
        results.length === 0 ? (
          <p>No patients matched your search.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>DOB</th>
                <th>Phone</th>
                <th>External IDs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.lastName}, {p.firstName}
                    {p.middleName ? ` ${p.middleName}` : ""}
                  </td>
                  <td>{p.dateOfBirth ?? "—"}</td>
                  <td>{p.phone ?? "—"}</td>
                  <td>{formatExternalIds(p)}</td>
                  <td>
                    <Link href={`/patients/${p.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <p>Enter at least one search criterion above.</p>
      )}
    </div>
  );
}
