"use client";

/**
 * Clinical tab drawn like the SonoSoft form (ADR-029): every control at the
 * position, size, colour and font measured from the reference screenshot
 * (src/modules/clinical/layouts.ts). Controls behave like SonoSoft's:
 * - single choice = editable combo box: pick from the list or type (the typed
 *   text is the visit-only free text);
 * - multiple choice = grey box with the chosen items and room to type; its
 *   list opens from the arrow or from SonoSoft's button ("Current Meds"...);
 * - "+ Add New" lives at the bottom of each list.
 * Saving, conflicts, exclusions and permissions are the same FieldSaver logic
 * as the plain form; save status is announced to screen readers and shown
 * visually only when something needs attention.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  CHOICE_DEBOUNCE_MS,
  postNewOption,
  TYPING_DEBOUNCE_MS,
  type FieldSaver,
  type OptionView,
} from "@/modules/clinical/autosave-client";
import { FIXED_CHOICES, NUMERIC_FIELD_RULES } from "@/modules/clinical/definitions";
import type {
  FieldItem,
  FillerItem,
  LabelItem,
  LayoutItem,
  OpenerItem,
  Rect,
  SectionLayout,
  TextColor,
} from "@/modules/clinical/layouts";
import { comboText, parseComboText } from "@/modules/clinical/combo-text";
import { isoToDayMonthYear, parseDayMonthYear } from "@/lib/day-month-year";
import type { ClinicalFieldView } from "@/modules/clinical/service";
import { describe, hasValue, statusText, useExclusionBlock, useSaver, type Exclusion } from "./clinical-field-helpers";

const PROBLEM_STATUSES = new Set(["conflict", "session-expired", "actor-mismatch", "locked", "error"]);
const COLORS: Record<TextColor, string> = { red: "#b0202e", blue: "#2a4fb6", navy: "#1a2f86" };

export interface SonoFieldContext {
  field: ClinicalFieldView;
  saver: FieldSaver;
  exclusion: Exclusion | null;
  lockedReason: string | null;
  /** Adds a new option to every field that shares this field's list (rows of one concept). */
  shareOption?: (option: OptionView) => void;
}

interface SonoFormProps {
  layout: SectionLayout;
  sectionCode: string;
  fieldFor: (code: string) => SonoFieldContext | null;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
}

function place(rect: Rect, origin: { x: number; y: number }): CSSProperties {
  return { left: rect.x - origin.x, top: rect.y - origin.y, width: rect.w, height: rect.h };
}

const controlId = (code: string) => `field-${code}`;
const MAX_ZOOM = 1.6;
const MIN_ZOOM = 1;

export function SonoForm({ layout, sectionCode, fieldFor, actorId, readOnly, canWrite, canAddOption }: SonoFormProps) {
  // One open list at a time, like a desktop combo box.
  const [openCode, setOpenCode] = useState<string | null>(null);

  function focusField(code: string) {
    const ctx = fieldFor(code);
    if (!ctx) return;
    const t = ctx.field.fieldType;
    if (t === "select" || t === "multiselect") setOpenCode(code);
    document.getElementById(controlId(code))?.focus();
  }

  // Scale the whole form to the available width (never above MAX_ZOOM), so the
  // proportions stay SonoSoft's on any screen; narrow screens scroll sideways.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fit = () => {
      const available = el.clientWidth;
      if (available > 0) setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, available / (layout.width + 2))));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout.width]);

  return (
    <div className="sono-scroll" ref={scrollRef}>
      <div
        className="clinical-form sono-form"
        data-layout={sectionCode}
        style={{ width: layout.width, height: layout.height, background: layout.background, zoom }}
      >
        {layout.items.map((item, i) => (
          <SonoItem
            key={`${item.kind}-${i}`}
            item={item}
            layout={layout}
            fieldFor={fieldFor}
            actorId={actorId}
            readOnly={readOnly}
            canWrite={canWrite}
            canAddOption={canAddOption}
            openCode={openCode}
            setOpenCode={setOpenCode}
            focusField={focusField}
          />
        ))}
      </div>
    </div>
  );
}

function SonoItem({
  item,
  layout,
  fieldFor,
  actorId,
  readOnly,
  canWrite,
  canAddOption,
  openCode,
  setOpenCode,
  focusField,
}: {
  item: LayoutItem;
  layout: SectionLayout;
  fieldFor: (code: string) => SonoFieldContext | null;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  openCode: string | null;
  setOpenCode: React.Dispatch<React.SetStateAction<string | null>>;
  focusField: (code: string) => void;
}) {
  const o = layout.origin;
  switch (item.kind) {
    case "box":
      return (
        <div
          className="sono-box"
          aria-hidden="true"
          style={{ ...place(item.rect, o), borderColor: item.color ?? "#3a3a3a" }}
        />
      );
    case "label":
      if (item.forCode && !fieldFor(item.forCode)) return null;
      return <SonoLabel item={item} origin={o} fieldFor={fieldFor} />;
    case "opener": {
      if (!fieldFor(item.forCode)) return null;
      return <SonoOpener item={item} origin={o} onOpen={() => focusField(item.forCode)} />;
    }
    case "filler":
      return <SonoFiller item={item} origin={o} fieldFor={fieldFor} disabled={readOnly} />;
    case "field": {
      const ctx = fieldFor(item.code);
      if (!ctx) return null;
      return (
        <SonoField
          item={item}
          origin={o}
          ctx={ctx}
          actorId={actorId}
          readOnly={readOnly}
          canWrite={canWrite}
          canAddOption={canAddOption}
          open={openCode === item.code}
          // Functional update: opening another list and closing this one can
          // happen in the same click; closing must not undo the other opening.
          setOpen={(v) => setOpenCode((cur) => (v ? item.code : cur === item.code ? null : cur))}
        />
      );
    }
  }
}

function textStyle(
  item: Pick<LabelItem, "size" | "bold" | "underline" | "color" | "align" | "title">,
): CSSProperties {
  return {
    fontSize: item.title ? 13 : (item.size ?? 9.5),
    fontWeight: item.bold || item.title ? 700 : undefined,
    textDecoration: item.underline || item.title ? "underline" : undefined,
    color: item.title ? COLORS.navy : item.color ? COLORS[item.color] : undefined,
    textAlign: item.align,
  };
}

function SonoLabel({
  item,
  origin,
  fieldFor,
}: {
  item: LabelItem;
  origin: { x: number; y: number };
  fieldFor: (code: string) => SonoFieldContext | null;
}) {
  const style: CSSProperties = {
    left: item.x - origin.x,
    top: item.y - origin.y,
    width: item.w,
    whiteSpace: item.w ? "pre-line" : "pre",
    ...textStyle(item),
  };
  const ctx = item.forCode ? fieldFor(item.forCode) : null;
  const labelable = ctx && ctx.field.fieldType !== "choice";
  return labelable && item.forCode ? (
    <label className="sono-label" htmlFor={controlId(item.forCode)} style={style}>
      {item.text}
    </label>
  ) : (
    <span className="sono-label" style={style}>
      {item.text}
    </span>
  );
}

function SonoOpener({
  item,
  origin,
  onOpen,
}: {
  item: OpenerItem;
  origin: { x: number; y: number };
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="sono-btn"
      style={{ ...place(item.rect, origin), ...textStyle({ ...item, size: item.size ?? 9.5 }) }}
      onClick={onOpen}
    >
      {item.text}
    </button>
  );
}

/** "Select Impressions": fills the first empty row with the chosen option (AP1/AP2). */
function SonoFiller({
  item,
  origin,
  fieldFor,
  disabled,
}: {
  item: FillerItem;
  origin: { x: number; y: number };
  fieldFor: (code: string) => SonoFieldContext | null;
  disabled: boolean;
}) {
  const rows = item.codes.flatMap((code) => {
    const ctx = fieldFor(code);
    return ctx && ctx.field.isActive ? [ctx] : [];
  });
  // Re-subscribing on each render is cheap (a handful of rows) and keeps the
  // subscription in step with the rows on screen.
  const subscribe = (listener: () => void) => {
    const offs = rows.map((r) => r.saver.subscribe(listener));
    return () => offs.forEach((off) => off());
  };
  const firstEmpty = useSyncExternalStore(
    subscribe,
    () => rows.findIndex((r) => !hasValue(r.saver.getSnapshot().value)),
    () => rows.findIndex((r) => !hasValue(r.saver.getSnapshot().value)),
  );
  const [open, setOpen] = useState(false);
  const wrapRef = useOutsideClose(open, () => setOpen(false));
  const listId = useId();
  if (rows.length === 0) return null;
  const options = (rows[0]?.saver.getSnapshot().options ?? []).filter((opt) => opt.isActive);
  const target = firstEmpty >= 0 ? rows[firstEmpty] : undefined;
  const name = item.label.replace(/\n/g, " ");

  return (
    <div className="sono-filler" ref={wrapRef} style={place(item.rect, origin)}>
      <button
        type="button"
        className="sono-btn"
        aria-label={name}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled || !target || options.length === 0}
        style={{ inset: 0, width: "100%", height: "100%", fontSize: 10.5, whiteSpace: "pre-line" }}
        onClick={() => setOpen((v) => !v)}
      >
        {item.label}
      </button>
      {open && target ? (
        <div className="sono-pop" style={{ top: item.rect.h + 2, left: 0 }}>
          <div className="sono-pop-head">{`→ row ${firstEmpty + 1}`}</div>
          <ul role="listbox" id={listId} aria-label={name} className="sono-list">
            {options.map((opt) => (
              <li
                key={opt.id}
                role="option"
                aria-selected={false}
                tabIndex={0}
                onClick={() => {
                  target.saver.edit({ optionIds: [opt.id], freeText: "" }, CHOICE_DEBOUNCE_MS);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    target.saver.edit({ optionIds: [opt.id], freeText: "" }, CHOICE_DEBOUNCE_MS);
                    setOpen(false);
                  } else if (e.key === "Escape") setOpen(false);
                }}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Closes a popover on a click outside `ref` or on Escape. "click", not
 * "mousedown": closing a list can shorten the page and scroll it, and doing
 * that between mouse-down and mouse-up would make the click land on another
 * control.
 */
function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) closeRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current();
    }
    document.addEventListener("click", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

function SonoField({
  item,
  origin,
  ctx,
  actorId,
  readOnly,
  canWrite,
  canAddOption,
  open,
  setOpen,
}: {
  item: FieldItem;
  origin: { x: number; y: number };
  ctx: SonoFieldContext;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const { field, saver, exclusion, lockedReason } = ctx;
  const snap = useSaver(saver);
  const { optionIds, freeText } = snap.value;
  const options = snap.options;
  const type = field.fieldType;
  const isCheckbox = type === "checkbox";
  const isSelect = type === "select";
  const isMulti = type === "multiselect";
  const retired = !field.isActive;
  const blocked = useExclusionBlock(exclusion, isCheckbox ? snap.value.checked === true : hasValue(snap.value));
  const locked = Boolean(lockedReason) && !hasValue(snap.value);
  const disabled = readOnly || retired || snap.conflict !== null || blocked || locked;
  const canAddHere = (isSelect || isMulti) && canAddOption && !retired && !blocked && !locked;
  const listEnabled = !disabled || canAddHere;
  const blockedText =
    blocked && exclusion
      ? exclusion.role === "flag"
        ? `Clear ${exclusion.peerLabels.join(", ")} to mark this as ${field.label}.`
        : `Uncheck ${exclusion.peerLabels.join(", ")} to enter values here.`
      : null;
  const hint = [blockedText, locked ? lockedReason : null, retired ? "(retired field, read-only)" : null]
    .filter(Boolean)
    .join(" ");

  const [draft, setDraft] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<{ ok: boolean; text: string; expired?: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const wrapRef = useOutsideClose(open, () => setOpen(false));
  const listId = useId();
  const id = controlId(field.code);

  const problem = PROBLEM_STATUSES.has(snap.status) || snap.failure !== null;
  const style: CSSProperties = { ...place(item.rect, origin), fontSize: item.size ?? 10 };
  const className = [
    "sono-field",
    `sono-${type}`,
    item.bold ? "bold" : "",
    item.white ? "white" : "",
    problem ? "problem" : "",
    disabled ? "is-disabled" : "",
    open ? "is-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const selectable = options.filter((o) => o.isActive || optionIds.includes(o.id));

  function pick(opt: OptionView) {
    if (isMulti) {
      const next = optionIds.includes(opt.id) ? optionIds.filter((v) => v !== opt.id) : [...optionIds, opt.id];
      saver.edit({ optionIds: next, freeText }, CHOICE_DEBOUNCE_MS);
    } else {
      setDraft(null);
      saver.edit({ optionIds: [opt.id], freeText: "" }, CHOICE_DEBOUNCE_MS);
      setOpen(false);
    }
  }

  async function addNew() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    setAddMessage(null);
    const result = await postNewOption(field.optionFieldId ?? field.id, label, actorId);
    setAdding(false);
    if (!result.ok) {
      setAddMessage({ ok: false, text: result.message, expired: result.sessionExpired });
      return;
    }
    if (ctx.shareOption) ctx.shareOption(result.option);
    else saver.addOptionToList(result.option);
    setNewLabel("");
    if (canWrite && !disabled) {
      if (isMulti) saver.edit({ optionIds: [...optionIds, result.option.id], freeText }, CHOICE_DEBOUNCE_MS);
      else {
        setDraft(null);
        saver.edit({ optionIds: [result.option.id], freeText }, CHOICE_DEBOUNCE_MS);
        // A combo box closes once its value is chosen, so its list cannot cover
        // the fields below it. Focus goes back to the combo box (keyboard use).
        setOpen(false);
        document.getElementById(id)?.focus();
      }
    }
    setAddMessage({ ok: true, text: `Added "${result.option.label}" to the list.` });
  }

  const listButton =
    (isSelect || isMulti) && item.arrow !== false ? (
      <button
        type="button"
        className="sono-arrow"
        tabIndex={-1}
        aria-label={`Open ${field.label} list`}
        aria-expanded={open}
        aria-controls={listId}
        disabled={!listEnabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      />
    ) : null;

  const addNewRow = canAddHere ? (
    <div className="sono-add">
      <input
        type="text"
        aria-label={`New ${field.label} option`}
        placeholder="New option (saved to the list for all visits)"
        value={newLabel}
        onChange={(e) => setNewLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void addNew();
          }
        }}
      />
      <button type="button" disabled={adding || newLabel.trim() === ""} onClick={() => void addNew()}>
        + Add New
      </button>
    </div>
  ) : null;

  const listPopover =
    open && (isSelect || isMulti) ? (
      <div className="sono-pop" style={{ top: item.rect.h + 1, left: 0, minWidth: Math.max(item.rect.w, 230) }}>
        {isSelect ? (
          <ul role="listbox" id={listId} aria-label={field.label} className="sono-list">
            {selectable.length === 0 ? <li className="sono-empty">No options yet.</li> : null}
            {selectable.map((opt, i) => (
              <li
                key={opt.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={optionIds.includes(opt.id)}
                aria-disabled={disabled || (!opt.isActive && !optionIds.includes(opt.id)) || undefined}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!disabled && opt.isActive) pick(opt);
                }}
              >
                {opt.label}
                {opt.isActive ? "" : " (retired)"}
              </li>
            ))}
          </ul>
        ) : (
          <div role="group" id={listId} aria-label={field.label} className="sono-checks">
            {selectable.length === 0 ? <span className="sono-empty">No options yet.</span> : null}
            {selectable.map((opt) => (
              <label key={opt.id} className="sono-check">
                <input
                  type="checkbox"
                  checked={optionIds.includes(opt.id)}
                  disabled={disabled || (!opt.isActive && !optionIds.includes(opt.id))}
                  onChange={() => pick(opt)}
                />
                {opt.label}
                {opt.isActive ? "" : " (retired)"}
              </label>
            ))}
            {item.buttonOnly ? (
              <textarea
                id={id}
                className="sono-pop-text"
                aria-label={`${field.label} — visit-only free text`}
                placeholder="Free text for this visit"
                value={freeText}
                disabled={disabled}
                onChange={(e) => saver.edit({ optionIds, freeText: e.target.value }, TYPING_DEBOUNCE_MS)}
                onBlur={() => void saver.flush()}
              />
            ) : null}
          </div>
        )}
        {addNewRow}
        {addMessage ? (
          <span className={addMessage.ok ? "sono-note" : "sono-note error"}>
            {addMessage.text}
            {addMessage.expired ? (
              <>
                {" "}
                <a href="/login" target="_blank" rel="noopener noreferrer">
                  Sign in again (opens in a new tab)
                </a>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    ) : null;

  let control: React.ReactNode = null;
  if (item.buttonOnly && isMulti) {
    const count = optionIds.length + (freeText.trim() ? 1 : 0);
    control = (
      <button
        type="button"
        className="sono-btn sono-opener-field"
        aria-label={field.label}
        aria-expanded={open}
        aria-controls={listId}
        disabled={!listEnabled && !hasValue(snap.value)}
        style={{ ...textStyle({ bold: true, size: 11, color: item.buttonOnly.color }) }}
        onClick={() => setOpen(!open)}
        title={describe(snap.value, options)}
      >
        {item.buttonOnly.text}
        {count > 0 ? ` (${count})` : ""}
      </button>
    );
  } else if (isSelect) {
    const text = draft ?? comboText(snap.value, options);
    control = (
      <>
        <input
          id={id}
          type="text"
          role="combobox"
          aria-label={field.label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && selectable[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={text}
          disabled={disabled}
          placeholder={item.placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            saver.edit(parseComboText(e.target.value, snap.value, options), TYPING_DEBOUNCE_MS);
          }}
          onBlur={() => {
            setDraft(null);
            void saver.flush();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!open) {
                setOpen(true);
                setActive(Math.max(0, selectable.findIndex((o) => o.id === optionIds[0])));
                return;
              }
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((a) => Math.min(Math.max(a + step, 0), Math.max(selectable.length - 1, 0)));
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              const opt = selectable[active];
              if (opt && opt.isActive) pick(opt);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        {listButton}
      </>
    );
  } else if (isMulti) {
    // List order, not click order: the saved value does not keep the order the
    // options were ticked in, so the box always reads the same after a reload.
    const labels = [
      ...options.filter((o) => optionIds.includes(o.id)).map((o) => o.label),
      ...optionIds.filter((oid) => !options.some((o) => o.id === oid)).map(() => "(unknown option)"),
    ];
    control = (
      <>
        <div className="sono-multi-box">
          {labels.length > 0 ? <span className="sono-chosen">{labels.join(", ")}</span> : null}
          <textarea
            id={id}
            aria-label={`${field.label} — visit-only free text`}
            placeholder={labels.length === 0 ? item.placeholder : undefined}
            value={freeText}
            disabled={disabled}
            rows={1}
            onChange={(e) => saver.edit({ optionIds, freeText: e.target.value }, TYPING_DEBOUNCE_MS)}
            onBlur={() => void saver.flush()}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && e.altKey) {
                e.preventDefault();
                setOpen(true);
              }
            }}
          />
        </div>
        {listButton}
      </>
    );
  } else if (type === "textarea") {
    control = (
      <textarea
        id={id}
        aria-label={field.label}
        value={freeText}
        disabled={disabled}
        onChange={(e) => saver.edit({ optionIds, freeText: e.target.value }, TYPING_DEBOUNCE_MS)}
        onBlur={() => void saver.flush()}
      />
    );
  } else if (type === "date") {
    // SonoSoft dates are typed day/month/year; stored as ISO (ADR-030). An
    // impossible date is kept on screen, marked, and sent as typed so the
    // server refuses it: the field shows "Not saved" and leaving the page asks
    // first, exactly like any other text that could not be saved.
    const shown = dateDraft ?? isoToDayMonthYear(freeText);
    const invalid = dateDraft !== null && parseDayMonthYear(dateDraft) === null;
    control = (
      <input
        id={id}
        type="text"
        inputMode="numeric"
        aria-label={field.label}
        aria-invalid={invalid || undefined}
        className={invalid ? "invalid" : undefined}
        title="Type the date as day/month/year, e.g. 17/08/2022."
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const text = e.target.value;
          setDateDraft(text);
          const iso = parseDayMonthYear(text);
          saver.edit({ optionIds: [], freeText: iso ?? text }, TYPING_DEBOUNCE_MS);
        }}
        onBlur={() => {
          if (dateDraft !== null && parseDayMonthYear(dateDraft) !== null) setDateDraft(null);
          void saver.flush();
        }}
      />
    );
  } else if (type === "text" || type === "number") {
    const unit = type === "number" ? NUMERIC_FIELD_RULES[field.code]?.unit : undefined;
    control = (
      <>
        <input
          id={id}
          type="text"
          inputMode={type === "number" ? "decimal" : undefined}
          aria-label={field.label}
          value={freeText}
          disabled={disabled}
          onChange={(e) => saver.edit({ optionIds, freeText: e.target.value }, TYPING_DEBOUNCE_MS)}
          onBlur={() => void saver.flush()}
        />
        {unit ? <span className="visually-hidden"> ({unit})</span> : null}
      </>
    );
  } else if (isCheckbox) {
    control = (
      <input
        id={id}
        type="checkbox"
        aria-label={field.label}
        checked={snap.value.checked === true}
        disabled={disabled}
        onChange={(e) => saver.edit({ optionIds: [], freeText: "", checked: e.target.checked }, CHOICE_DEBOUNCE_MS)}
      />
    );
  } else if (type === "choice") {
    control = (
      <div className="sono-radios" role="radiogroup" aria-label={field.label} id={id}>
        {(FIXED_CHOICES[field.code] ?? []).map((c) => (
          <label key={c.value}>
            <input
              type="radio"
              name={`${id}-choice`}
              value={c.value}
              checked={freeText === c.value}
              disabled={disabled}
              onChange={() => saver.edit({ optionIds: [], freeText: c.value }, CHOICE_DEBOUNCE_MS)}
            />
            {c.label}
          </label>
        ))}
      </div>
    );
  }

  const showMessage = snap.conflict !== null || snap.message !== null || snap.failure !== null;

  return (
    <div
      ref={wrapRef}
      className={className}
      style={style}
      data-field={field.code}
      data-field-active={field.isActive ? "true" : "false"}
      title={hint || undefined}
    >
      {control}
      <span className="visually-hidden" role="status" aria-live="polite">
        {statusText(snap)}
      </span>
      {hint ? <span className="visually-hidden">{hint}</span> : null}
      {listPopover}
      {showMessage ? (
        <div className="sono-pop sono-msg" style={{ top: item.rect.h + 1, left: 0 }}>
          {snap.conflict ? (
            <div className="conflict" role="alert">
              <strong>Conflict</strong> — someone else changed this field after you loaded it.
              <div>
                <span className="muted">Theirs:</span> {describe(snap.conflict.theirs, snap.conflict.options)}
              </div>
              <div>
                <span className="muted">Mine:</span> {describe(snap.value, [...snap.options, ...snap.conflict.options])}
              </div>
              <div className="conflict-actions">
                <button type="button" onClick={() => void saver.keepMine()}>
                  Keep mine
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setDraft(null);
                    saver.useTheirs();
                  }}
                >
                  Use theirs
                </button>
              </div>
            </div>
          ) : null}
          {snap.message && !snap.conflict ? <span className="inline-error">{snap.message}</span> : null}
          {snap.failure === "session-expired" ? (
            <a href="/login" target="_blank" rel="noopener noreferrer">
              Sign in again (opens in a new tab)
            </a>
          ) : null}
          {snap.failure !== null ? (
            <button type="button" className="secondary" onClick={() => void saver.retry()}>
              Retry save
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
