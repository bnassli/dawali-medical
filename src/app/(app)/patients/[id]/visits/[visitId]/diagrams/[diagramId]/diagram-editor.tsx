"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newMutationId } from "@/modules/clinical/autosave-client";
import { DIAGRAM_TYPES, type DiagramType } from "@/modules/diagrams/types";

/**
 * In-app drawing editor (R4, ADR-033): pen, colour, thickness, eraser, undo,
 * redo, clear, save. The base template is only ever drawn underneath; strokes
 * live on their own layer (the eraser removes ink, never the template). Save
 * sends the strokes (to reopen and keep editing) and the rendered PNG (for
 * reports) as a NEW version. Nothing is kept in browser storage.
 */

interface Stroke {
  color: string;
  width: number;
  erase: boolean;
  points: number[];
}

const COLORS = [
  { value: "#000000", label: "Black" },
  { value: "#d11a2a", label: "Red" },
  { value: "#1f4fd1", label: "Blue" },
  { value: "#1a8f3a", label: "Green" },
];
const WIDTHS = [
  { value: 2, label: "Thin" },
  { value: 4, label: "Medium" },
  { value: 8, label: "Thick" },
];

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.erase ? s.width * 3 : s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0] ?? 0, s.points[1] ?? 0);
    for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i] ?? 0, s.points[i + 1] ?? 0);
    if (s.points.length === 2) ctx.lineTo((s.points[0] ?? 0) + 0.1, s.points[1] ?? 0);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

export function DiagramEditor(props: {
  visitId: string;
  actorId: string;
  diagramId: string;
  diagramType: DiagramType;
  initialVersion: number;
  initialStrokes: Stroke[];
  readOnly: boolean;
  backHref: string;
}) {
  const spec = DIAGRAM_TYPES[props.diagramType];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const templateRef = useRef<HTMLImageElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(props.initialStrokes);
  const [redo, setRedo] = useState<Stroke[][]>([]);
  const [undo, setUndo] = useState<Stroke[][]>([]);
  const [color, setColor] = useState(COLORS[1]?.value ?? "#d11a2a");
  const [width, setWidth] = useState(4);
  const [erase, setErase] = useState(false);
  const [version, setVersion] = useState(props.initialVersion);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const drawing = useRef<Stroke | null>(null);
  const [templateReady, setTemplateReady] = useState(false);

  const render = useCallback(
    (extra?: Stroke) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const ink = document.createElement("canvas");
      ink.width = canvas.width;
      ink.height = canvas.height;
      const inkCtx = ink.getContext("2d");
      if (!inkCtx) return;
      drawStrokes(inkCtx, extra ? [...strokes, extra] : strokes);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (templateRef.current) ctx.drawImage(templateRef.current, 0, 0, canvas.width, canvas.height);
      ctx.drawImage(ink, 0, 0);
    },
    [strokes],
  );

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      templateRef.current = img;
      setTemplateReady(true);
    };
    img.src = spec.template;
  }, [spec.template]);

  useEffect(() => {
    render();
  }, [render, templateReady]);

  // Leaving with an unsaved drawing asks first (browser prompt).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function point(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - rect.left) / rect.width) * canvas.width * 10) / 10,
      Math.round(((e.clientY - rect.top) / rect.height) * canvas.height * 10) / 10,
    ];
  }

  function commit(next: Stroke[]) {
    setUndo((u) => [...u, strokes]);
    setRedo([]);
    setStrokes(next);
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || strokes.length === 0) return;
    setSaving(true);
    setMessage(null);
    render();
    const pngBase64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
    let res: Response;
    try {
      res = await fetch(`/api/visits/${props.visitId}/diagrams/${props.diagramId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedUserId: props.actorId,
          diagramType: props.diagramType,
          expectedVersion: version,
          clientMutationId: newMutationId(),
          strokes,
          pngBase64,
        }),
      });
    } catch {
      setSaving(false);
      setMessage({ ok: false, text: "Could not reach the server. The drawing is kept here; try Save again." });
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      version?: number;
      fileName?: string;
      message?: string;
      currentVersion?: number;
    } | null;
    setSaving(false);
    if (res.status === 200 && typeof body?.version === "number") {
      setVersion(body.version);
      setDirty(false);
      setMessage({ ok: true, text: `Saved version ${body.version} (${body.fileName ?? ""}).` });
      return;
    }
    setMessage({
      ok: false,
      text:
        res.status === 401
          ? "Your session has expired. Sign in again in another tab, then Save again — the drawing is kept."
          : res.status === 409
            ? `Someone else saved version ${body?.currentVersion ?? "?"} of this diagram meanwhile. Nothing was overwritten; reopen the diagram to continue from the latest version.`
            : (body?.message ?? `Not saved (${res.status}).`),
    });
  }

  const disabled = props.readOnly || saving;

  return (
    <div className="diagram-editor">
      <div className="diagram-toolbar" role="toolbar" aria-label="Drawing tools">
        <div role="group" aria-label="Tool">
          <button type="button" aria-pressed={!erase} disabled={disabled} onClick={() => setErase(false)}>
            Pen
          </button>
          <button type="button" aria-pressed={erase} disabled={disabled} onClick={() => setErase(true)}>
            Eraser
          </button>
        </div>
        <div role="group" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={c.label}
              aria-pressed={!erase && color === c.value}
              className="swatch"
              style={{ background: c.value }}
              disabled={disabled}
              onClick={() => {
                setColor(c.value);
                setErase(false);
              }}
            />
          ))}
        </div>
        <label>
          Thickness{" "}
          <select value={width} disabled={disabled} onChange={(e) => setWidth(Number(e.target.value))}>
            {WIDTHS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || undo.length === 0}
          onClick={() => {
            setRedo((r) => [...r, strokes]);
            setStrokes(undo[undo.length - 1] ?? []);
            setUndo((u) => u.slice(0, -1));
            setDirty(true);
          }}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={disabled || redo.length === 0}
          onClick={() => {
            setUndo((u) => [...u, strokes]);
            setStrokes(redo[redo.length - 1] ?? []);
            setRedo((r) => r.slice(0, -1));
            setDirty(true);
          }}
        >
          Redo
        </button>
        <button type="button" disabled={disabled || strokes.length === 0} onClick={() => commit([])}>
          Clear
        </button>
        <button type="button" className="primary" disabled={disabled || strokes.length === 0 || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        <span className="muted" data-testid="diagram-version">
          {version === 0 ? "Not saved yet" : `Version ${version}`}
          {dirty ? " — unsaved changes" : ""}
        </span>
      </div>
      {message ? (
        <p className={message.ok ? "muted" : "inline-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      <canvas
        ref={canvasRef}
        width={spec.width}
        height={spec.height}
        className="diagram-canvas"
        aria-label={`${spec.label} drawing area`}
        style={{ touchAction: "none", cursor: props.readOnly ? "default" : "crosshair" }}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = { color, width, erase, points: point(e) };
          render(drawing.current);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          drawing.current.points.push(...point(e));
          render(drawing.current);
        }}
        onPointerUp={() => {
          const s = drawing.current;
          drawing.current = null;
          if (s) commit([...strokes, s]);
        }}
      />
      <p>
        <a href={props.backHref} className="button secondary">
          Back to visit
        </a>
      </p>
    </div>
  );
}
