import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { DiagramView } from "@/modules/diagrams/service";
import { DIAGRAM_TYPES } from "@/modules/diagrams/types";

/**
 * "Create Leg Diagram" / "Create Vein Diagram" (FINAL_V1 §7: two independent
 * actions) and the visit's saved diagrams with every version. A new diagram
 * gets a fresh id; nothing is stored until the doctor draws and saves.
 */
export function DiagramsPanel({
  base,
  diagrams,
  canCreate,
}: {
  base: string;
  diagrams: DiagramView[];
  canCreate: boolean;
}) {
  return (
    <section className="card diagrams-panel" aria-label="Diagrams" id="diagrams">
      <h3>Diagrams</h3>
      {canCreate ? (
        <p className="diagram-actions">
          {(["leg", "vein"] as const).map((t) => (
            <Link key={t} className="button secondary" href={`${base}/diagrams/${randomUUID()}?type=${t}`}>
              {DIAGRAM_TYPES[t].button}
            </Link>
          ))}
        </p>
      ) : null}
      {diagrams.length === 0 ? (
        <p className="muted">No diagrams saved for this visit.</p>
      ) : (
        <ul>
          {diagrams.map((d, i) => (
            <li key={d.id}>
              <strong>
                {DIAGRAM_TYPES[d.diagramType].label} {i + 1}
              </strong>{" "}
              <Link href={`${base}/diagrams/${d.id}`}>Open</Link>
              <ul>
                {d.versions.map((v) => (
                  <li key={v.version}>
                    <a href={`/api/files/${v.fileId}`} target="_blank" rel="noopener noreferrer">
                      {v.fileName}
                    </a>{" "}
                    <span className="muted">
                      — {v.createdByName ?? "unknown user"}, {v.createdAt.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
