import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getReportEditorData, ReportNotFoundError } from "@/modules/report-engine/service";
import { getVisitById } from "@/modules/visits/service";
import { ReportEditor } from "./report-editor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Report editor (R5, ADR-034). An unknown id with ?template= starts a new report. */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; visitId: string; reportId: string }>;
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const actor = await requireActor();
  const { id, visitId, reportId } = await params;
  const { template } = await searchParams;
  if (!actor.permissions.has(PERMISSIONS.CLINICAL_READ) || !UUID.test(reportId)) notFound();
  const visit = await getVisitById(getDb(), actor, visitId);
  if (!visit || visit.patientId !== id) notFound();
  let data;
  try {
    data = await getReportEditorData(
      getDb(),
      actor,
      { visitId: visit.id, reportId, templateCode: typeof template === "string" ? template : undefined },
      getEnv().APP_TIME_ZONE,
    );
  } catch (err) {
    if (err instanceof ReportNotFoundError) notFound();
    throw err;
  }
  const open = visit.status === "open";
  return (
    <div>
      <h2>{data.template.name}</h2>
      <ReportEditor
        visitId={visit.id}
        reportId={reportId}
        actorId={actor.userId}
        template={data.template}
        initialVersion={data.version}
        initialStatus={data.status}
        initialContent={data.content}
        listStyle={data.listStyle}
        diagramChoices={data.diagramChoices}
        header={{ patientName: data.patientName, fileNumber: data.fileNumber, date: data.date }}
        canWrite={actor.permissions.has(PERMISSIONS.CLINICAL_WRITE) && open}
        canFinalize={actor.permissions.has(PERMISSIONS.REPORT_FINALIZE) && open}
        diagramsHref={`/patients/${id}/visits/${visit.id}#diagrams`}
      />
      <p>
        <a className="button secondary" href={`/patients/${id}/visits/${visit.id}`}>
          Back to visit
        </a>
      </p>
    </div>
  );
}
