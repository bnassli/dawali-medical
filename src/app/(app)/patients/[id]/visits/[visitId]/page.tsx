import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import {
  getClinicalSectionForVisit,
  getVisitReasons,
  listClinicalSections,
} from "@/modules/clinical/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getPatientById } from "@/modules/patients/service";
import { getVisitById } from "@/modules/visits/service";
import { ClinicalSectionForm } from "./clinical-section-form";

export default async function VisitChartPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; visitId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const actor = await requireActor();
  const { id, visitId } = await params;
  const { tab } = await searchParams;

  const patient = await getPatientById(getDb(), actor, id);
  if (!patient) notFound();

  const visit = await getVisitById(getDb(), actor, visitId);
  if (!visit || visit.patientId !== patient.id) notFound();

  const canRead = actor.permissions.has(PERMISSIONS.CLINICAL_READ);
  const canWrite = actor.permissions.has(PERMISSIONS.CLINICAL_WRITE);
  const canAddOption = actor.permissions.has(PERMISSIONS.CLINICAL_OPTION_ADD);
  const visitOpen = visit.status === "open";

  // Tabs are data (clinical_sections, in sort order); exactly ONE section form
  // is rendered — the requested tab, else the first (ADR-027).
  const tabs = canRead ? await listClinicalSections(getDb(), actor) : [];
  const requestedTab = typeof tab === "string" ? tab : undefined;
  const activeTab = requestedTab ? tabs.find((t) => t.code === requestedTab) : tabs[0];
  if (canRead && requestedTab && !activeTab) notFound();

  const section = activeTab
    ? await getClinicalSectionForVisit(getDb(), actor, visit.id, activeTab.code)
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

      {/* Tab area — data-driven from clinical_sections (docs/CLINICAL_TABS.md
          order). The active tab is plain text; the others are links, which the
          unsaved-changes guard in the form intercepts like any navigation. */}
      {tabs.length > 0 ? (
        <nav className="tabs" aria-label="Clinical tabs">
          {tabs.map((t) =>
            t.code === activeTab?.code ? (
              <span key={t.code} className="tab active" aria-current="page">
                {t.name}
              </span>
            ) : (
              <Link
                key={t.code}
                className="tab"
                href={`/patients/${patient.id}/visits/${visit.id}?tab=${t.code}`}
              >
                {t.name}
              </Link>
            ),
          )}
        </nav>
      ) : null}

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
              key={`${visit.id}:${section.section.code}`}
              visitId={visit.id}
              actorId={actor.userId}
              sectionCode={section.section.code}
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
