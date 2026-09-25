"use client";

import { useEffect, useState } from "react";
import type { ReportContent } from "@/db/schema/files";
import { newMutationId } from "@/modules/clinical/autosave-client";
import type { DiagramType } from "@/modules/diagrams/types";
import type { ReportTemplate } from "@/modules/report-engine/templates";

/**
 * Report editor (R5, ADR-034): each section prefilled from the chart and
 * editable, the diagram versions to print, a live preview laid out like the
 * .docx, then Save draft / Finalize (a new .docx; later changes become an
 * amended version — a finalized report is never replaced).
 */
export function ReportEditor(props: {
  visitId: string;
  reportId: string;
  actorId: string;
  template: ReportTemplate;
  initialVersion: number;
  initialStatus: "draft" | "final" | "amended" | null;
  initialContent: ReportContent;
  listStyle: "bullets" | "numbers";
  diagramChoices: Record<DiagramType, { fileId: string; fileName: string }[]>;
  header: { patientName: string; fileNumber: string | null; date: string };
  canWrite: boolean;
  canFinalize: boolean;
  diagramsHref: string;
}) {
  const [content, setContent] = useState<ReportContent>(props.initialContent);
  const [version, setVersion] = useState(props.initialVersion);
  const [status, setStatus] = useState(props.initialStatus);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; fileId?: string | null } | null>(null);
  const finalized = status === "final" || status === "amended";

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const needed = props.template.sections.flatMap((s) => (s.diagramAfter ? [s.diagramAfter] : []));
  const missing = needed.filter((t) => !content.diagramFileIds[t]);

  async function save(action: "draft" | "finalize") {
    setBusy(true);
    setMessage(null);
    let res: Response;
    try {
      res = await fetch(`/api/visits/${props.visitId}/report/${props.reportId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedUserId: props.actorId,
          templateCode: props.template.code,
          expectedVersion: version,
          clientMutationId: newMutationId(),
          action,
          content,
        }),
      });
    } catch {
      setBusy(false);
      setMessage({ ok: false, text: "Could not reach the server. Your text is kept; try again." });
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      version?: number;
      status?: "draft" | "final" | "amended";
      fileId?: string | null;
      fileName?: string | null;
      message?: string;
    } | null;
    setBusy(false);
    if (res.status === 200 && body?.version) {
      setVersion(body.version);
      setStatus(body.status ?? null);
      setDirty(false);
      setMessage({
        ok: true,
        text:
          body.status === "draft"
            ? `Draft saved (version ${body.version}).`
            : `${body.status === "amended" ? "Amended" : "Finalized"}: ${body.fileName ?? ""} (version ${body.version}).`,
        fileId: body.fileId,
      });
      return;
    }
    setMessage({ ok: false, text: body?.message ?? `Not saved (${res.status}).` });
  }

  const set = (key: string, value: string) => {
    setContent((c) => ({ ...c, sections: { ...c.sections, [key]: value } }));
    setDirty(true);
  };

  const readOnly = !props.canWrite || busy;

  return (
    <div className="report-editor">
      <p className="muted" data-testid="report-status">
        {status === null ? "Not saved yet" : `Version ${version} — ${status}`}
        {dirty ? " — unsaved changes" : ""}
      </p>
      <div className="report-columns">
        <div className="report-form">
          {props.template.sections.map((s) => (
            <div key={s.key} className="field">
              <label htmlFor={`sec-${s.key}`}>
                {s.heading ?? "Report text"}
                {s.kind === "list" ? <span className="muted"> (one item per line)</span> : null}
              </label>
              <textarea
                id={`sec-${s.key}`}
                rows={s.kind === "list" ? 4 : 6}
                value={content.sections[s.key] ?? ""}
                disabled={readOnly}
                onChange={(e) => set(s.key, e.target.value)}
              />
              {s.diagramAfter ? (
                <DiagramPicker
                  type={s.diagramAfter}
                  choices={props.diagramChoices[s.diagramAfter]}
                  value={content.diagramFileIds[s.diagramAfter] ?? null}
                  disabled={readOnly}
                  diagramsHref={props.diagramsHref}
                  onChange={(fileId) => {
                    setContent((c) => ({ ...c, diagramFileIds: { ...c.diagramFileIds, [s.diagramAfter as string]: fileId } }));
                    setDirty(true);
                  }}
                />
              ) : null}
            </div>
          ))}
          <div className="action-bar">
            {!finalized ? (
              <button type="button" className="secondary" disabled={readOnly} onClick={() => void save("draft")}>
                Save draft
              </button>
            ) : null}
            {props.canFinalize ? (
              <button
                type="button"
                disabled={busy || !props.canWrite || missing.length > 0}
                onClick={() => void save("finalize")}
              >
                {finalized ? "Save amended version" : "Finalize"}
              </button>
            ) : (
              <span className="muted">Only a doctor can finalize a report.</span>
            )}
          </div>
          {message ? (
            <p className={message.ok ? "muted" : "inline-error"} role={message.ok ? "status" : "alert"}>
              {message.text}{" "}
              {message.fileId ? <a href={`/api/files/${message.fileId}`}>Download .docx</a> : null}
            </p>
          ) : null}
        </div>
        <ReportPreview
          template={props.template}
          content={content}
          header={props.header}
          listStyle={props.listStyle}
        />
      </div>
    </div>
  );
}

function DiagramPicker(props: {
  type: DiagramType;
  choices: { fileId: string; fileName: string }[];
  value: string | null;
  disabled: boolean;
  diagramsHref: string;
  onChange: (fileId: string | null) => void;
}) {
  const label = props.type === "leg" ? "Leg Diagram" : "Vein Diagram";
  if (props.choices.length === 0) {
    return (
      <p className="inline-error" role="alert">
        No saved {label} for this visit — the report cannot be finalized without it.{" "}
        <a href={props.diagramsHref}>Create {label}</a>
      </p>
    );
  }
  return (
    <label className="report-diagram">
      {label}{" "}
      <select value={props.value ?? ""} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value || null)}>
        {props.choices.map((c) => (
          <option key={c.fileId} value={c.fileId}>
            {c.fileName}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Preview laid out like the .docx (same rules: empty sections are left out). */
function ReportPreview(props: {
  template: ReportTemplate;
  content: ReportContent;
  header: { patientName: string; fileNumber: string | null; date: string };
  listStyle: "bullets" | "numbers";
}) {
  return (
    <section className="report-preview" aria-label="Report preview">
      <p className="report-clinic">Dawali Clinic</p>
      <p>
        <strong>Patient:</strong> {props.header.patientName}
      </p>
      {props.header.fileNumber ? (
        <p>
          <strong>File Number:</strong> {props.header.fileNumber}
        </p>
      ) : null}
      <p>
        <strong>Date:</strong> {props.header.date}
      </p>
      {props.template.sections.map((s) => {
        const text = (props.content.sections[s.key] ?? "").trim();
        const diagram = s.diagramAfter ? props.content.diagramFileIds[s.diagramAfter] : null;
        const items = text.split("\n").map((l) => l.trim()).filter(Boolean);
        const List = props.listStyle === "numbers" ? "ol" : "ul";
        return (
          <div key={s.key} className={s.pageBreakBefore ? "report-page-break" : undefined}>
            {text && s.kind === "list" ? (
              <>
                {s.heading ? <p><strong>{s.heading}</strong></p> : null}
                <List>{items.map((l, i) => <li key={i}>{l}</li>)}</List>
              </>
            ) : text ? (
              <p>
                {s.heading ? <strong>{s.heading} </strong> : null}
                {text}
              </p>
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated image */}
            {diagram ? <img className="report-diagram-img" src={`/api/files/${diagram}`} alt={`${s.diagramAfter} diagram`} /> : null}
          </div>
        );
      })}
    </section>
  );
}
