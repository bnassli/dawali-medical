import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { getPatientById } from "@/modules/patients/service";
import { getVisitById } from "@/modules/visits/service";

export default async function VisitChartPage({
  params,
}: {
  params: Promise<{ id: string; visitId: string }>;
}) {
  const actor = await requireActor();
  const { id, visitId } = await params;

  const patient = await getPatientById(getDb(), actor, id);
  if (!patient) notFound();

  const visit = await getVisitById(getDb(), actor, patient.id, visitId);
  if (!visit) notFound();

  return (
    <div>
      {/* Header / demographics area */}
      <div className="card">
        <h1 style={{ margin: 0 }}>
          {patient.lastName}, {patient.firstName}
          {patient.middleName ? ` ${patient.middleName}` : ""}
        </h1>
        <p style={{ margin: "0.35rem 0 0" }}>
          DOB: {patient.dateOfBirth ?? "—"} &nbsp;|&nbsp; Sex: {patient.sex ?? "—"}
          &nbsp;|&nbsp; Phone: {patient.phone ?? "—"}
        </p>
        <p style={{ margin: "0.35rem 0 0" }}>
          Visit date: {new Date(visit.visitDate).toLocaleString()} &nbsp;|&nbsp; Status:{" "}
          {visit.status}
          {visit.reason ? ` | Reason: ${visit.reason}` : ""}
        </p>
      </div>

      {/* Tab area placeholder — clinical tab names/content are explicitly
          out of scope for Sprint 1 (SonoSoft-style tabs arrive later). */}
      <div className="tab-placeholder">Clinical tabs arrive in later sprints.</div>

      {/* Content area */}
      <div className="card" style={{ minHeight: 160 }}>
        <p style={{ color: "gray" }}>
          Clinical documentation for this visit will appear here in a future sprint.
        </p>
      </div>

      {/* Action area */}
      <div className="action-bar">
        <Link href={`/patients/${patient.id}`} className="button secondary">
          Back to patient
        </Link>
      </div>
    </div>
  );
}
