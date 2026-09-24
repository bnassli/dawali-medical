import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { SUBJ_COMPLAINTS_HABITS_SECTION_CODE } from "@/modules/clinical/definitions";
import { getClinicalSectionForVisit, getVisitReasons } from "@/modules/clinical/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getPatientById } from "@/modules/patients/service";
import { getVisitById } from "@/modules/visits/service";
import { ClinicalSectionForm } from "./clinical-section-form";

export default async function VisitChartPage({
  params,
}: {
  params: Promise<{ id: string; visitId: string }>;
}) {
  const actor = await requireActor();
  const { id, visitId } = await params;

  const patient = await getPatientById(getDb(), actor, id);
  if (!patient) notFound();

  const visit = await getVisitById(getDb(), actor, visitId);
  if (!visit || visit.patientId !== patient.id) notFound();

  const canRead = actor.permissions.has(PERMISSIONS.CLINICAL_READ);
  const canWrite = actor.permissions.has(PERMISSIONS.CLINICAL_WRITE);
  const canAddOption = actor.permissions.has(PERMISSIONS.CLINICAL_OPTION_ADD);
  const visitOpen = visit.status === "open";

  const section = canRead
    ? await getClinicalSectionForVisit(
        getDb(),
        actor,
        visit.id,
        SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
      )
    : null;

  const reason = canRead
    ? ((await getVisitReasons(getDb(), actor, [visit.id])).get(visit.id) ?? null)
    : null;

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
          {reason ? ` | Reason: ${reason}` : ""}
        </p>
      </div>

      {/* Tab area — only the Sprint 2 tab exists; later tabs are added in
          their own sprints in docs/CLINICAL_TABS.md order. */}
      <nav className="tabs" aria-label="Clinical tabs">
        <span className="tab active" aria-current="page">
          {section?.section.name ?? "Subj Complaints Habits"}
        </span>
      </nav>

      {/* Content area */}
      <div className="card">
        {section ? (
          <>
            {!canWrite ? (
              <p className="muted">You have read-only access to clinical entries.</p>
            ) : !visitOpen ? (
              <p className="muted">
                This visit is {visit.status}; clinical entries are read-only.
              </p>
            ) : null}
            <ClinicalSectionForm
              visitId={visit.id}
              fields={section.fields}
              readOnly={!canWrite || !visitOpen}
              canWrite={canWrite}
              canAddOption={canAddOption}
            />
          </>
        ) : (
          <p className="muted">You do not have access to clinical entries.</p>
        )}
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
