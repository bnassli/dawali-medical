/**
 * Client-side autosave engine for clinical fields. Framework-free and free of
 * server imports so it can be unit-tested with fake timers and a fake fetch.
 *
 * Guarantees:
 *  - one request in flight per field; edits made meanwhile are sent next;
 *  - every request carries expectedVersion (optimistic concurrency), a
 *    clientMutationId (idempotency) and expectedUserId (the user the page was
 *    rendered for): if the session now belongs to someone else the server
 *    refuses and the text stays here, unsaved, never attributed to them;
 *  - a request whose outcome is unknown (network failure) is retried with the
 *    SAME id before anything newer is sent, so a request that did reach the
 *    server can never be mistaken for someone else's edit;
 *  - HTTP 409 never overwrites: the field enters a conflict state and the
 *    user chooses Keep mine / Use theirs;
 *  - a saver/group is bound to ONE visit and ONE user for its whole life; a
 *    different visit gets a new group (see ClinicalSectionForm's key);
 *  - unsent text is held in memory only (no localStorage/sessionStorage).
 */

export interface EntryValue {
  optionIds: string[];
  freeText: string;
}

export interface OptionView {
  id: string;
  label: string;
  isActive: boolean;
}

export type SaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error"
  | "conflict"
  | "session-expired"
  | "actor-mismatch"
  | "locked";

/** Why the last save attempt did not reach the server. Stays set while a retry is in flight. */
export type FailureStatus = "error" | "session-expired" | "actor-mismatch" | "locked";

export interface ConflictInfo {
  theirs: EntryValue;
  theirVersion: number;
  options: OptionView[];
}

export interface FieldSnapshot {
  status: SaveStatus;
  message: string | null;
  value: EntryValue;
  baseVersion: number;
  options: OptionView[];
  conflict: ConflictInfo | null;
  /**
   * The current failure, kept through "saving" while a retry is in flight so
   * the controls that resolve it (Retry, Sign in again) stay mounted: a blur
   * caused by clicking them re-sends, and unmounting the control under the
   * pointer would swallow the click.
   */
  failure: FailureStatus | null;
  /** True while anything is pending, in flight, unresolved or in conflict. */
  unsaved: boolean;
}

export const TYPING_DEBOUNCE_MS = 700;
export const CHOICE_DEBOUNCE_MS = 150;

interface Mutation {
  id: string;
  expectedVersion: number;
  value: EntryValue;
}

type SendOutcome =
  | { kind: "ok"; version: number; value: EntryValue }
  | { kind: "conflict"; version: number; value: EntryValue; options: OptionView[] }
  | { kind: "unauthenticated" }
  | { kind: "actor-mismatch"; message: string }
  | { kind: "locked"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "network"; message: string };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function newMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // randomUUID is unavailable on non-secure origins; getRandomValues is not.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseValue(v: unknown): EntryValue | null {
  if (!isObject(v) || !Array.isArray(v.optionIds) || typeof v.freeText !== "string") return null;
  return {
    optionIds: v.optionIds.filter((x): x is string => typeof x === "string"),
    freeText: v.freeText,
  };
}

function parseOptions(v: unknown): OptionView[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) =>
    isObject(o) &&
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.isActive === "boolean"
      ? [{ id: o.id, label: o.label, isActive: o.isActive }]
      : [],
  );
}

export interface FieldSaverConfig {
  visitId: string;
  fieldId: string;
  /** The user the page was rendered for; sent as expectedUserId on every request. */
  actorId: string;
  initialVersion: number;
  initialValue: EntryValue;
  initialOptions: OptionView[];
  fetchImpl?: FetchLike;
  newId?: () => string;
}

export class FieldSaver {
  private listeners = new Set<() => void>();
  private snap: FieldSnapshot;
  private pending: EntryValue | null = null;
  private unresolved: Mutation | null = null;
  private run: Promise<void> | null = null;
  private running = false;
  private keepalive = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly newId: () => string;
  private onGroupChange: (() => void) | null = null;

  constructor(private readonly cfg: FieldSaverConfig) {
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
    this.newId = cfg.newId ?? newMutationId;
    this.snap = {
      status: "idle",
      message: null,
      value: cfg.initialValue,
      baseVersion: cfg.initialVersion,
      options: cfg.initialOptions,
      conflict: null,
      failure: null,
      unsaved: false,
    };
  }

  get visitId(): string {
    return this.cfg.visitId;
  }

  get fieldId(): string {
    return this.cfg.fieldId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FieldSnapshot => this.snap;

  /** @internal used by SaverGroup */
  attachGroup(notify: () => void): void {
    this.onGroupChange = notify;
  }

  hasUnsaved(): boolean {
    if (this.disposed) return false;
    return (
      this.pending !== null ||
      this.unresolved !== null ||
      this.running ||
      this.snap.conflict !== null
    );
  }

  private update(patch: Partial<FieldSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.snap.unsaved = this.hasUnsaved();
    for (const l of this.listeners) l();
    this.onGroupChange?.();
  }

  /** Local edit. Schedules a debounced save (not while a conflict awaits a decision). */
  edit(value: EntryValue, delayMs: number): void {
    if (this.disposed) return;
    this.pending = value;
    if (this.snap.conflict) {
      this.update({ value });
      return;
    }
    this.update({ value, status: "dirty", message: this.snap.failure ? this.snap.message : null });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delayMs);
  }

  /**
   * Sends pending edits now (blur, unload, before navigation). Resolves when
   * the field is idle again (also when a save is already in flight: the caller
   * then waits for it). keepalive lets the request outlive the page.
   */
  flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (opts.keepalive) this.keepalive = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed || this.snap.conflict) return Promise.resolve();
    if (this.run) return this.run;
    if (!this.pending && !this.unresolved) return Promise.resolve();
    this.running = true;
    this.run = this.execute().finally(() => {
      this.running = false;
      this.run = null;
      this.keepalive = false;
      this.update({});
    });
    return this.run;
  }

  private async execute(): Promise<void> {
    for (;;) {
      let mutation = this.unresolved;
      if (!mutation) {
        if (!this.pending) return;
        mutation = {
          id: this.newId(),
          expectedVersion: this.snap.baseVersion,
          value: this.pending,
        };
        this.pending = null;
      }
      this.update({ status: "saving", message: this.snap.failure ? this.snap.message : null });
      const outcome = await this.send(mutation);
      if (this.disposed) return;

      if (outcome.kind === "ok") {
        this.unresolved = null;
        this.update({
          baseVersion: outcome.version,
          status: this.pending ? "dirty" : "saved",
          message: null,
          failure: null,
        });
        continue;
      }
      if (outcome.kind === "conflict") {
        this.unresolved = null;
        const mine = this.pending ?? mutation.value;
        this.pending = mine;
        this.update({
          status: "conflict",
          message: null,
          failure: null,
          value: mine,
          baseVersion: outcome.version,
          conflict: {
            theirs: outcome.value,
            theirVersion: outcome.version,
            options: outcome.options,
          },
        });
        return;
      }
      if (
        outcome.kind === "network" ||
        outcome.kind === "unauthenticated" ||
        outcome.kind === "actor-mismatch"
      ) {
        // Not applied / outcome unknown: keep the SAME mutation id for the retry.
        this.unresolved = mutation;
        if (outcome.kind === "network") {
          this.update({ status: "error", failure: "error", message: outcome.message });
        } else if (outcome.kind === "unauthenticated") {
          this.update({
            status: "session-expired",
            failure: "session-expired",
            message: "Your session has expired. Sign in again, then retry — your text is kept.",
          });
        } else {
          this.update({ status: "actor-mismatch", failure: "actor-mismatch", message: outcome.message });
        }
        return;
      }
      // Definitive rejection (locked / invalid / forbidden): nothing was written.
      this.pending = this.pending ?? mutation.value;
      const failure: FailureStatus = outcome.kind === "locked" ? "locked" : "error";
      this.update({ status: failure, failure, message: outcome.message });
      return;
    }
  }

  /** Manual retry after an error / session expiry / lock / user change. */
  retry(): Promise<void> {
    return this.flush();
  }

  /** Conflict resolution: overwrite the other user's version deliberately (creates a new revision on top). */
  keepMine(): Promise<void> {
    const conflict = this.snap.conflict;
    if (!conflict) return Promise.resolve();
    this.pending = this.pending ?? this.snap.value;
    this.update({
      conflict: null,
      baseVersion: conflict.theirVersion,
      status: "dirty",
      message: null,
      failure: null,
    });
    return this.flush();
  }

  /** Conflict resolution: discard my edit and adopt the other user's value. */
  useTheirs(): void {
    const conflict = this.snap.conflict;
    if (!conflict) return;
    this.pending = null;
    this.unresolved = null;
    this.update({
      conflict: null,
      value: conflict.theirs,
      baseVersion: conflict.theirVersion,
      options: conflict.options,
      status: "saved",
      message: null,
      failure: null,
    });
  }

  /**
   * The user explicitly chose to throw away whatever is unsaved (navigation
   * discard). Nothing is sent afterwards and later edits are ignored.
   */
  discard(): void {
    this.disposed = true;
    this.pending = null;
    this.unresolved = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.update({ conflict: null, status: "idle", message: null, failure: null });
  }

  /**
   * The server-rendered props changed (router.refresh, revalidation). Adopt a
   * newer server version ONLY when nothing here is unsaved; otherwise keep the
   * user's text — a later save then surfaces a normal conflict.
   */
  reconcile(serverVersion: number, serverValue: EntryValue, serverOptions: OptionView[]): void {
    if (this.disposed || this.hasUnsaved()) return;
    if (serverVersion > this.snap.baseVersion) {
      this.update({
        baseVersion: serverVersion,
        value: serverValue,
        options: serverOptions,
        status: "idle",
        message: null,
      });
      return;
    }
    // Same version: values are identical; only pick up options others added.
    const known = new Set(this.snap.options.map((o) => o.id));
    if (serverOptions.some((o) => !known.has(o.id))) {
      const extra = serverOptions.filter((o) => !known.has(o.id));
      this.update({ options: [...this.snap.options, ...extra] });
    }
  }

  addOptionToList(option: OptionView): void {
    if (this.snap.options.some((o) => o.id === option.id)) return;
    this.update({ options: [...this.snap.options, option] });
  }

  private async send(m: Mutation): Promise<SendOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `/api/visits/${this.cfg.visitId}/clinical-entries/${this.cfg.fieldId}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          keepalive: this.keepalive,
          body: JSON.stringify({
            expectedUserId: this.cfg.actorId,
            expectedVersion: m.expectedVersion,
            clientMutationId: m.id,
            optionIds: m.value.optionIds,
            freeText: m.value.freeText,
          }),
        },
      );
    } catch {
      return { kind: "network", message: "Could not reach the server. Your text is kept; retry to save." };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const message =
      isObject(body) && typeof body.message === "string" ? body.message : `Request failed (${res.status}).`;

    if (res.status === 200 && isObject(body) && typeof body.version === "number") {
      const value = parseValue(body.value);
      if (value) return { kind: "ok", version: body.version, value };
    }
    if (res.status === 401) return { kind: "unauthenticated" };
    if (res.status === 403 && isObject(body) && body.error === "actor_mismatch") {
      return {
        kind: "actor-mismatch",
        message:
          "You are now signed in as a different user than the one this page was opened for. Your text was NOT saved and is kept here. Sign back in as the original user to retry, or discard it.",
      };
    }
    if (res.status === 409 && isObject(body) && isObject(body.current) && body.error === "conflict") {
      const value = parseValue(body.current.value);
      if (typeof body.current.version === "number" && value) {
        return {
          kind: "conflict",
          version: body.current.version,
          value,
          options: parseOptions(body.current.options),
        };
      }
    }
    if (res.status === 423) return { kind: "locked", message };
    if (res.status >= 500 || res.status === 200) {
      return { kind: "network", message: "The server had a problem. Your text is kept; retry to save." };
    }
    return { kind: "rejected", message };
  }
}

/**
 * All savers of ONE section on ONE visit for ONE user: aggregate unsaved state
 * and flush/discard everything together. Never reused for another visit.
 */
export class SaverGroup {
  private readonly savers = new Map<string, FieldSaver>();
  private listeners = new Set<() => void>();
  private count = 0;

  constructor(
    readonly visitId: string,
    readonly actorId: string,
  ) {}

  add(fieldId: string, saver: FieldSaver): void {
    if (saver.visitId !== this.visitId) {
      throw new Error("A field saver may only join the group of its own visit.");
    }
    this.savers.set(fieldId, saver);
    saver.attachGroup(() => this.recompute());
  }

  get(fieldId: string): FieldSaver | undefined {
    return this.savers.get(fieldId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Number of fields with anything not yet safely stored on the server. */
  getUnsavedCount = (): number => this.count;

  unsavedFieldIds(): string[] {
    return [...this.savers.entries()].filter(([, s]) => s.hasUnsaved()).map(([id]) => id);
  }

  private recompute(): void {
    let n = 0;
    for (const s of this.savers.values()) if (s.hasUnsaved()) n += 1;
    if (n !== this.count) {
      this.count = n;
      for (const l of this.listeners) l();
    }
  }

  /** Flush every field. Used on blur/hide/unload and before a guarded navigation. */
  flushAll(opts: { keepalive?: boolean } = {}): Promise<void[]> {
    return Promise.all([...this.savers.values()].map((s) => s.flush(opts)));
  }

  /** The user chose to discard everything unsaved (explicit confirmation). */
  discardAll(): void {
    for (const s of this.savers.values()) s.discard();
  }

  /** Apply a fresh server snapshot; fields with unsaved edits keep the user's text. */
  reconcileFromServer(fields: ServerFieldState[]): void {
    for (const f of fields) this.savers.get(f.id)?.reconcile(f.version, f.value, f.options);
  }
}

export interface ServerFieldState {
  id: string;
  version: number;
  value: EntryValue;
  options: OptionView[];
}

/**
 * Fetches the current state of a section (never cached). Returns null on any
 * failure — the page keeps working from what it has, and a later save simply
 * conflicts if that was stale.
 */
export async function fetchSectionState(
  visitId: string,
  sectionCode: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<{ visitId: string; fields: ServerFieldState[] } | null> {
  try {
    const res = await fetchImpl(`/api/visits/${visitId}/clinical-sections/${sectionCode}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.status !== 200) return null;
    const body: unknown = await res.json();
    if (!isObject(body) || body.visitId !== visitId || !Array.isArray(body.fields)) return null;
    const fields: ServerFieldState[] = [];
    for (const f of body.fields) {
      if (!isObject(f) || typeof f.id !== "string" || typeof f.version !== "number") continue;
      const value = parseValue(f.value);
      if (!value) continue;
      fields.push({ id: f.id, version: f.version, value, options: parseOptions(f.options) });
    }
    return { visitId, fields };
  } catch {
    return null;
  }
}

export type AddOptionOutcome =
  | { ok: true; option: OptionView }
  | { ok: false; sessionExpired: boolean; message: string };

/** "+ Add New" through the same authenticated Route Handler family, bound to the rendered user. */
export async function postNewOption(
  fieldId: string,
  label: string,
  actorId: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<AddOptionOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/clinical/fields/${fieldId}/options`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedUserId: actorId, label }),
    });
  } catch {
    return { ok: false, sessionExpired: false, message: "Could not reach the server." };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 200 && isObject(body) && isObject(body.option)) {
    const [option] = parseOptions([body.option]);
    if (option) return { ok: true, option };
  }
  const message =
    res.status === 401
      ? "Your session has expired. Sign in again, then retry."
      : isObject(body) && typeof body.message === "string"
        ? body.message
        : `Request failed (${res.status}).`;
  return { ok: false, sessionExpired: res.status === 401, message };
}
