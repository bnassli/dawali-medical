import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { DiagramNotFoundError, getDiagramForEditing } from "@/modules/diagrams/service";
import { DIAGRAM_TYPES, isDiagramType } from "@/modules/diagrams/types";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { getVisitById } from "@/modules/visits/service";
import { DiagramEditor } from "./diagram-editor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Leg / Vein diagram editor (R4, ADR-033). An unknown id with ?type= starts a new diagram. */
export default async function DiagramPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; visitId: string; diagramId: string }>;
  searchParams: Promise<{ type?: string | string[] }>;
}) {
  const actor = await requireActor();
  const { id, visitId, diagramId } = await params;
  const { type } = await searchParams;
  if (!actor.permissions.has(PERMISSIONS.CLINICAL_READ) || !UUID.test(diagramId)) notFound();
  const visit = await getVisitById(getDb(), actor, visitId);
  if (!visit || visit.patientId !== id) notFound();

  let existing: Awaited<ReturnType<typeof getDiagramForEditing>> | null = null;
  try {
    existing = await getDiagramForEditing(getDb(), actor, visit.id, diagramId);
  } catch (err) {
    if (!(err instanceof DiagramNotFoundError)) throw err;
  }
  const diagramType = existing?.diagramType ?? (typeof type === "string" && isDiagramType(type) ? type : null);
  if (!diagramType) notFound();
  const canWrite = actor.permissions.has(PERMISSIONS.CLINICAL_WRITE) && visit.status === "open";

  return (
    <div>
      <h2>{DIAGRAM_TYPES[diagramType].label}</h2>
      {!canWrite ? <p className="muted">Read-only: this diagram cannot be changed here.</p> : null}
      <DiagramEditor
        visitId={visit.id}
        actorId={actor.userId}
        diagramId={diagramId}
        diagramType={diagramType}
        initialVersion={existing?.version ?? 0}
        initialStrokes={existing?.strokes ?? []}
        readOnly={!canWrite}
        backHref={`/patients/${id}/visits/${visit.id}`}
      />
    </div>
  );
}
