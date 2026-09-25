import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import {
  getClinicalSectionForVisit,
  getVisitReasons,
  listClinicalSections,
} from "@/modules/clinical/service";
import { TREATMENT_PLAN_SECTION_CODE } from "@/modules/clinical/definitions";
import { getTreatmentPlanForVisit } from "@/modules/clinical/treatment-plan";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getVisitById } from "@/modules/visits/service";
import { loadPatient } from "../../../page-data";
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

  // Loaded once per request, shared with the patient layout (header).
  const patient = await loadPatient(id);
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

  // The Treatment Plan tab shows the patient's plan: its "fields" are the plan's
  // cells (ADR-030). Every other tab shows the visit's clinical entries.
  const section = !activeTab
    ? null
    : activeTab.code === TREATMENT_PLAN_SECTION_CODE
      ? {
          code: activeTab.code,
          fields: (await getTreatmentPlanForVisit(getDb(), actor, visit.id)).fields,
          patientSex: patient.sex ?? null,
        }
      : await getClinicalSectionForVisit(getDb(), actor, visit.id, activeTab.code).then((v) => ({
          code: v.section.code,
          fields: v.fields,
          patientSex: v.visit.patientSex,
        }));

  const reason = canRead
    ? ((await getVisitReasons(getDb(), actor, [visit.id])).get(visit.id) ?? null)
    : null;

  return (
    <div>
      {/* Visit context. Patient context is the persistent Patient Header
          rendered by the patient layout (FINAL_V1_REQUIREMENTS §3). */}
      <p className="visit-context">
        Visit date: {new Date(visit.visitDate).toLocaleString()} &nbsp;|&nbsp; Status:{" "}
        {visit.status}
        {reason ? ` | Reason: ${reason}` : ""}
      </p>

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
              key={`${visit.id}:${section.code}`}
              visitId={visit.id}
              actorId={actor.userId}
              sectionCode={section.code}
              fields={section.fields}
              readOnly={!canWrite || !visitOpen}
              canWrite={canWrite}
              canAddOption={canAddOption}
              patientSex={section.patientSex}
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
