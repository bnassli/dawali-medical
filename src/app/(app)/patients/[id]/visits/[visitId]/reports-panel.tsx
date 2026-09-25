import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { ReportListItem } from "@/modules/report-engine/service";
import { REPORT_TEMPLATES } from "@/modules/report-engine/templates";

/** New report from a template, and the visit's reports with every version (R5, ADR-034). */
export function ReportsPanel({ base, reports, canCreate }: { base: string; reports: ReportListItem[]; canCreate: boolean }) {
  return (
    <section className="card diagrams-panel" aria-label="Reports" id="reports">
      <h3>Reports</h3>
      {canCreate ? (
        <p className="diagram-actions">
          {REPORT_TEMPLATES.map((t) => (
            <Link key={t.code} className="button secondary" href={`${base}/report/${randomUUID()}?template=${t.code}`}>
              {t.name}
            </Link>
          ))}
        </p>
      ) : null}
      {reports.length === 0 ? (
        <p className="muted">No reports for this visit.</p>
      ) : (
        <ul>
          {reports.map((r) => (
            <li key={r.id}>
              <strong>{r.templateName}</strong> <Link href={`${base}/report/${r.id}`}>Open</Link>
              <ul>
                {r.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version} — {v.status}{" "}
                    {v.fileId ? <a href={`/api/files/${v.fileId}`}>{v.fileName}</a> : null}{" "}
                    <span className="muted">
                      {v.createdByName ?? "unknown user"}, {v.createdAt.toLocaleString()}
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
