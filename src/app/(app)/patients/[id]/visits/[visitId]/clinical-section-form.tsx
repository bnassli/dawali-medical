"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CHOICE_DEBOUNCE_MS,
  fetchSectionState,
  FieldSaver,
  postNewOption,
  SaverGroup,
  TYPING_DEBOUNCE_MS,
} from "@/modules/clinical/autosave-client";
import {
  FEMALE_ONLY_FIELD_CODES,
  FIELD_EXCLUSION_RULES,
  FIXED_CHOICES,
  NUMERIC_FIELD_RULES,
} from "@/modules/clinical/definitions";
import { layoutFieldCodes, SECTION_LAYOUTS } from "@/modules/clinical/layouts";
import { isGuardedLinkClick } from "@/modules/clinical/navigation-guard";
import {
  describe,
  hasValue,
  statusText,
  useExclusionBlock,
  useSaver,
  type Exclusion,
} from "./clinical-field-helpers";
import { SonoForm, type SonoFieldContext } from "./sono-form";
import type { ClinicalFieldView } from "@/modules/clinical/service";

function FieldEditor({
  field,
  saver,
  actorId,
  readOnly,
  canWrite,
  canAddOption,
  exclusion,
  lockedReason,
}: {
  field: ClinicalFieldView;
  saver: FieldSaver;
  actorId: string;
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  exclusion: Exclusion | null;
  /** Why the field cannot take a new value (e.g. female-only); clearing stays possible. */
  lockedReason?: string | null;
}) {
  const snap = useSaver(saver);
  const isSelect = field.fieldType === "select";
  const isMulti = field.fieldType === "multiselect";
  const isChoice = isSelect || isMulti;
  const isCheckbox = field.fieldType === "checkbox";
  const isNumber = field.fieldType === "number";
  const isFixedChoice = field.fieldType === "choice";
  const inputId = `field-${field.code}`;
  const { optionIds, freeText } = snap.value;
  const options = snap.options;
  const retired = !field.isActive;
  const fieldReadOnly = readOnly || retired;

  const [newLabel, setNewLabel] = useState("");
  const [addMessage, setAddMessage] = useState<{
    ok: boolean;
    text: string;
    expired?: boolean;
  } | null>(null);
  const [adding, setAdding] = useState(false);

  const blocked = useExclusionBlock(
    exclusion,
    isCheckbox ? snap.value.checked === true : hasValue(snap.value),
  );
  // A locked field (e.g. female-only for a non-female patient) stays editable
  // while it still holds a value, so that value can be cleared.
  const locked = Boolean(lockedReason) && !hasValue(snap.value);
  const disabled = fieldReadOnly || snap.conflict !== null || blocked || locked;
  const blockedText =
    blocked && exclusion
      ? exclusion.role === "flag"
        ? `Clear ${exclusion.peerLabels.join(", ")} to mark this as Unknown.`
        : `Uncheck ${exclusion.peerLabels.join(", ")} to enter values here.`
      : null;

  function changeOptions(next: string[]) {
    saver.edit({ optionIds: next, freeText }, CHOICE_DEBOUNCE_MS);
  }

  function changeChecked(next: boolean) {
    saver.edit({ optionIds: [], freeText: "", checked: next }, CHOICE_DEBOUNCE_MS);
  }

  function changeFreeText(next: string) {
    saver.edit({ optionIds, freeText: next }, TYPING_DEBOUNCE_MS);
  }

  async function addNew() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    setAddMessage(null);
    const result = await postNewOption(field.id, label, actorId);
    setAdding(false);
    if (!result.ok) {
      setAddMessage({
        ok: false,
        text: result.message,
        expired: result.sessionExpired,
      });
      return;
    }
    saver.addOptionToList(result.option);
    setNewLabel("");
    if (canWrite && !fieldReadOnly && !snap.conflict && !blocked) {
      changeOptions(isMulti ? [...optionIds, result.option.id] : [result.option.id]);
    }
    setAddMessage({
      ok: true,
      text: `Added "${result.option.label}" to the list.`,
    });
  }

  const controlName = field.label;
  const canAddOptionHere = isChoice && canAddOption && !retired && !blocked && !locked;
  const numberRule = isNumber ? NUMERIC_FIELD_RULES[field.code] : undefined;
  const choices = isFixedChoice ? (FIXED_CHOICES[field.code] ?? []) : [];
  const classes = ["field", "clinical-field", isCheckbox ? "is-checkbox" : ""].filter(Boolean).join(" ");

  return (
    <div className={classes} data-field={field.code} data-field-active={field.isActive ? "true" : "false"}>
      <div className="field-head">
        <label htmlFor={inputId}>
          {field.label}
          {retired ? <span className="muted"> (retired field, read-only)</span> : null}
        </label>
        <span className={`save-status ${snap.status}`} role="status" aria-live="polite">
          {statusText(snap)}
        </span>
      </div>

      <div className="field-body">
        {isCheckbox ? (
          <input
            id={inputId}
            type="checkbox"
            checked={snap.value.checked === true}
            disabled={disabled}
            onChange={(e) => changeChecked(e.target.checked)}
          />
        ) : null}

        {blockedText ? <span className="muted">{blockedText}</span> : null}
        {locked && lockedReason ? <span className="muted">{lockedReason}</span> : null}

        {isNumber ? (
          <span className="number-input">
            <input
              id={inputId}
              type="text"
              inputMode="decimal"
              aria-label={controlName}
              value={freeText}
              disabled={disabled}
              onChange={(e) => changeFreeText(e.target.value)}
              onBlur={() => void saver.flush()}
            />
            {numberRule ? <span className="unit">{numberRule.unit}</span> : null}
          </span>
        ) : null}

        {isFixedChoice ? (
          <div className="radios" role="radiogroup" aria-label={field.label} id={inputId}>
            {choices.map((c) => (
              <label key={c.value} className="check">
                <input
                  type="radio"
                  name={`${inputId}-choice`}
                  value={c.value}
                  checked={freeText === c.value}
                  disabled={disabled}
                  onChange={() => saver.edit({ optionIds: [], freeText: c.value }, CHOICE_DEBOUNCE_MS)}
                />{" "}
                {c.label}
              </label>
            ))}
          </div>
        ) : null}

        {isSelect ? (
          <select
            id={inputId}
            value={optionIds[0] ?? ""}
            aria-label={controlName}
            disabled={disabled}
            onChange={(e) => changeOptions(e.target.value ? [e.target.value] : [])}
          >
            <option value="">—</option>
            {options.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.isActive && !optionIds.includes(o.id)}>
                {o.label}
                {o.isActive ? "" : " (retired)"}
              </option>
            ))}
          </select>
        ) : null}

        {isMulti ? (
          <div className="checks" role="group" aria-labelledby={`${inputId}-legend`} id={inputId}>
            <span id={`${inputId}-legend`} hidden>
              {field.label}
            </span>
            {options.length === 0 ? <span className="muted">No options yet.</span> : null}
            {options.map((o) => (
              <label key={o.id} className="check">
                <input
                  type="checkbox"
                  checked={optionIds.includes(o.id)}
                  disabled={disabled || (!o.isActive && !optionIds.includes(o.id))}
                  onChange={(e) =>
                    changeOptions(
                      e.target.checked ? [...optionIds, o.id] : optionIds.filter((v) => v !== o.id),
                    )
                  }
                />{" "}
                {o.label}
                {o.isActive ? "" : " (retired)"}
              </label>
            ))}
          </div>
        ) : null}

        {isChoice && field.allowsFreeText ? (
          <input
            type="text"
            aria-label={`${field.label} — visit-only free text`}
            placeholder="Free text for this visit only"
            value={freeText}
            disabled={disabled}
            onChange={(e) => changeFreeText(e.target.value)}
            onBlur={() => void saver.flush()}
          />
        ) : null}

        {field.fieldType === "text" ? (
          <input
            id={inputId}
            type="text"
            value={freeText}
            aria-label={controlName}
            disabled={disabled}
            onChange={(e) => changeFreeText(e.target.value)}
            onBlur={() => void saver.flush()}
          />
        ) : null}

        {field.fieldType === "textarea" ? (
          <textarea
            id={inputId}
            aria-label={controlName}
            rows={3}
            value={freeText}
            disabled={disabled}
            onChange={(e) => changeFreeText(e.target.value)}
            onBlur={() => void saver.flush()}
          />
        ) : null}

        {snap.conflict ? (
          <div className="conflict" role="alert">
            <strong>Conflict</strong> — someone else changed this field after you loaded it.
            <div>
              <span className="muted">Theirs:</span> {describe(snap.conflict.theirs, snap.conflict.options)}
            </div>
            <div>
              <span className="muted">Mine:</span>{" "}
              {describe(snap.value, [...snap.options, ...snap.conflict.options])}
            </div>
            <div className="conflict-actions">
              <button type="button" onClick={() => void saver.keepMine()}>
                Keep mine
              </button>
              <button type="button" className="secondary" onClick={() => saver.useTheirs()}>
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

        {canAddOptionHere ? (
          <div className="add-new">
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
            <button
              type="button"
              className="secondary"
              disabled={adding || newLabel.trim() === ""}
              onClick={() => void addNew()}
            >
              + Add New
            </button>
          </div>
        ) : null}
        {addMessage ? (
          <span className={addMessage.ok ? "muted" : "inline-error"}>
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
    </div>
  );
}

interface DiscardPrompt {
  items: { label: string; status: string }[];
  proceed: () => void;
  opener: HTMLElement | null;
}

/** Explicit confirmation before unsaved clinical text is thrown away. Keyboard operable, focus-trapped. */
function DiscardDialog({
  items,
  onStay,
  onDiscard,
}: {
  items: DiscardPrompt["items"];
  onStay: () => void;
  onDiscard: () => void;
}) {
  const stayRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stayRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onStay();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-title"
        aria-describedby="discard-desc"
        onKeyDown={onKeyDown}
      >
        <h2 id="discard-title">Leave without saving?</h2>
        <p id="discard-desc">
          These fields have text that could not be saved. If you leave now it will be lost.
        </p>
        <ul>
          {items.map((i) => (
            <li key={i.label}>
              <strong>{i.label}</strong> — {i.status}
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" ref={stayRef} onClick={onStay}>
            Stay on page
          </button>
          <button type="button" className="secondary" onClick={onDiscard}>
            Discard unsaved text and leave
          </button>
        </div>
      </div>
    </div>
  );
}

function ClinicalSectionFormInner({
  visitId,
  actorId,
  sectionCode,
  fields,
  readOnly,
  canWrite,
  canAddOption,
  patientSex,
}: {
  visitId: string;
  actorId: string;
  sectionCode: string;
  fields: ClinicalFieldView[];
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  patientSex: string | null;
}) {
  const [group] = useState(() => {
    const g = new SaverGroup(visitId, actorId);
    for (const f of fields) {
      g.add(
        f.id,
        new FieldSaver({
          visitId,
          fieldId: f.id,
          actorId,
          initialVersion: f.version,
          initialValue: f.value,
          initialOptions: f.options,
        }),
      );
    }
    return g;
  });
  const unsaved = useSyncExternalStore(group.subscribe, group.getUnsavedCount, group.getUnsavedCount);
  const [prompt, setPrompt] = useState<DiscardPrompt | null>(null);

  // Exclusion rules whose fields are all placed in this tab (ADR-027).
  const exclusions = useMemo(() => {
    const byCode = new Map(fields.map((f) => [f.code, f]));
    const result = new Map<string, Exclusion>();
    for (const rule of FIELD_EXCLUSION_RULES) {
      const flag = byCode.get(rule.flag);
      const excluded = rule.excludes.flatMap((code) => {
        const f = byCode.get(code);
        return f ? [f] : [];
      });
      if (!flag || excluded.length === 0) continue;
      const savers = (list: ClinicalFieldView[]) =>
        list.flatMap((f) => {
          const sv = group.get(f.id);
          return sv ? [sv] : [];
        });
      result.set(flag.id, {
        role: "flag",
        peers: savers(excluded),
        peerLabels: excluded.map((f) => f.label),
      });
      for (const f of excluded) {
        result.set(f.id, {
          role: "excluded",
          peers: savers([flag]),
          peerLabels: [flag.label],
        });
      }
    }
    return result;
  }, [fields, group]);

  // Server props changed under a live form (router.refresh / revalidation):
  // adopt newer versions only for fields with nothing unsaved.
  useEffect(() => {
    for (const f of fields) group.get(f.id)?.reconcile(f.version, f.value, f.options);
  }, [fields, group]);

  // A page restored from the browser's back/forward cache (or left open) may
  // carry a stale server render. Pull the current state on mount and whenever
  // the tab becomes visible again; fields with unsaved text are left alone.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const state = await fetchSectionState(visitId, sectionCode);
      if (!cancelled && state && state.visitId === group.visitId) group.reconcileFromServer(state.fields);
    };
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [group, visitId, sectionCode]);

  useEffect(() => {
    let bypass = false;
    let checking = false;

    const fieldLabel = (id: string) => fields.find((f) => f.id === id)?.label ?? "Field";
    const statusFor = (id: string) => {
      const snap = group.get(id)?.getSnapshot();
      return snap ? statusText(snap) || "not saved" : "not saved";
    };

    // Resolve a guarded navigation: try to save everything first (keepalive so
    // it survives if the browser proceeds anyway); only if something still is
    // not safely stored do we ask the user, who must explicitly discard.
    const decide = async (proceed: () => void) => {
      if (checking) return;
      checking = true;
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        await group.flushAll({ keepalive: true });
        if (group.getUnsavedCount() === 0) {
          proceed();
          return;
        }
        setPrompt({
          items: group.unsavedFieldIds().map((id) => ({ label: fieldLabel(id), status: statusFor(id) })),
          proceed,
          opener,
        });
      } finally {
        checking = false;
      }
    };

    const onClick = (e: MouseEvent) => {
      if (bypass || group.getUnsavedCount() === 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const guarded = isGuardedLinkClick({
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        defaultPrevented: e.defaultPrevented,
        href: anchor.href,
        target: anchor.getAttribute("target") ?? "",
        download: anchor.hasAttribute("download"),
        currentHref: window.location.href,
      });
      if (!guarded) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void decide(() => {
        bypass = true;
        try {
          anchor.click();
        } finally {
          bypass = false;
        }
      });
    };

    // Forms on this page (Logout, ...) navigate away too.
    const onSubmit = (e: SubmitEvent) => {
      if (bypass || group.getUnsavedCount() === 0) return;
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const submitter = e.submitter instanceof HTMLElement ? e.submitter : null;
      void decide(() => {
        bypass = true;
        try {
          form.requestSubmit(submitter);
        } finally {
          bypass = false;
        }
      });
    };

    // Hard navigations (reload, close, typed URL): best-effort keepalive flush
    // plus the browser's own leave-page prompt while anything is unsaved.
    const onHide = () => void group.flushAll({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      onHide();
      if (group.getUnsavedCount() > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      // Unmounting (in-app navigation, back button): send what we can. Anything
      // explicitly discarded was already dropped from the savers.
      void group.flushAll({ keepalive: true });
    };
  }, [group, fields]);

  const layout = SECTION_LAYOUTS[sectionCode] ?? null;
  const byCode = new Map(fields.map((f) => [f.code, f]));
  const placedCodes = new Set(layout ? layoutFieldCodes(layout) : []);
  const unplaced = layout ? fields.filter((f) => !placedCodes.has(f.code)) : [];

  function lockedReasonFor(field: ClinicalFieldView): string | null {
    if (FEMALE_ONLY_FIELD_CODES.includes(field.code) && patientSex !== "F") {
      return "For female patients only.";
    }
    return null;
  }

  function renderField(field: ClinicalFieldView) {
    const saver = group.get(field.id);
    return saver ? (
      <FieldEditor
        key={field.id}
        field={field}
        saver={saver}
        actorId={actorId}
        readOnly={readOnly}
        canWrite={canWrite}
        canAddOption={canAddOption}
        exclusion={exclusions.get(field.id) ?? null}
        lockedReason={lockedReasonFor(field)}
      />
    ) : null;
  }

  function fieldFor(code: string): SonoFieldContext | null {
    const field = byCode.get(code);
    const saver = field ? group.get(field.id) : undefined;
    if (!field || !saver) return null;
    return { field, saver, exclusion: exclusions.get(field.id) ?? null, lockedReason: lockedReasonFor(field) };
  }

  function stay() {
    const opener = prompt?.opener ?? null;
    setPrompt(null);
    opener?.focus();
  }

  function discardAndLeave() {
    const proceed = prompt?.proceed;
    group.discardAll();
    setPrompt(null);
    proceed?.();
  }

  return (
    <div className="clinical-form-wrap" data-visit-id={visitId}>
      <div
        className={`unsaved-banner${unsaved > 0 ? " visible" : ""}`}
        role="alert"
        aria-live="assertive"
        data-testid="unsaved-banner"
      >
        {unsaved > 0
          ? `${unsaved} field${unsaved === 1 ? "" : "s"} not saved yet — keep this page open until it says Saved.`
          : ""}
      </div>
      {layout ? (
        <>
          <SonoForm
            layout={layout}
            sectionCode={sectionCode}
            fieldFor={fieldFor}
            actorId={actorId}
            readOnly={readOnly}
            canWrite={canWrite}
            canAddOption={canAddOption}
          />
          {unplaced.length > 0 ? (
            <div className="sono-extra" data-box="other">
              {unplaced.map((field) => renderField(field))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="clinical-form">{fields.map((field) => renderField(field))}</div>
      )}
      {prompt ? <DiscardDialog items={prompt.items} onStay={stay} onDiscard={discardAndLeave} /> : null}
    </div>
  );
}

/**
 * The savers, visit id and field list are created once per (visit, section,
 * user) and must never be reused for another visit, tab or user. Keying the
 * inner component by all three guarantees a full remount — and therefore fresh
 * savers — when the route switches from one visit to another (V1 -> V2 -> V1),
 * from one tab to another, or the session's user changes, even if a parent
 * reuses this component instance.
 */
export function ClinicalSectionForm(props: {
  visitId: string;
  actorId: string;
  sectionCode: string;
  fields: ClinicalFieldView[];
  readOnly: boolean;
  canWrite: boolean;
  canAddOption: boolean;
  patientSex: string | null;
}) {
  return (
    <ClinicalSectionFormInner key={`${props.visitId}:${props.sectionCode}:${props.actorId}`} {...props} />
  );
}
