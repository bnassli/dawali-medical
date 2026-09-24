/**
 * Client-side autosave engine for clinical fields. Framework-free and free of
 * server imports so it can be unit-tested with fake timers and a fake fetch.
 *
 * Guarantees:
 *  - one request in flight per field; edits made meanwhile are sent next;
 *  - every request carries expectedVersion (optimistic concurrency) and a
 *    clientMutationId; a request whose outcome is unknown (network failure)
 *    is retried with the SAME id before anything newer is sent, so a request
 *    that did reach the server can never be mistaken for someone else's edit;
 *  - HTTP 409 never overwrites: the field enters a conflict state and the
 *    user chooses Keep mine / Use theirs;
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
  | "locked";

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
  private inFlight = false;
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
      unsaved: false,
    };
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
    return (
      this.pending !== null ||
      this.unresolved !== null ||
      this.inFlight ||
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
    this.pending = value;
    if (this.snap.conflict) {
      this.update({ value });
      return;
    }
    this.update({ value, status: "dirty", message: null });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delayMs);
  }

  /** Sends pending edits now (blur, unload). keepalive lets the request outlive the page. */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight || this.snap.conflict) return;
    this.inFlight = true;
    try {
      for (;;) {
        let mutation = this.unresolved;
        if (!mutation) {
          if (!this.pending) break;
          mutation = {
            id: this.newId(),
            expectedVersion: this.snap.baseVersion,
            value: this.pending,
          };
          this.pending = null;
        }
        this.update({ status: "saving", message: null });
        const outcome = await this.send(mutation, opts.keepalive === true);

        if (outcome.kind === "ok") {
          this.unresolved = null;
          this.update({ baseVersion: outcome.version, status: this.pending ? "dirty" : "saved" });
          continue;
        }
        if (outcome.kind === "conflict") {
          this.unresolved = null;
          const mine = this.pending ?? mutation.value;
          this.pending = mine;
          this.update({
            status: "conflict",
            message: null,
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
        if (outcome.kind === "network" || outcome.kind === "unauthenticated") {
          // Outcome unknown / not applied: keep the SAME mutation id for the retry.
          this.unresolved = mutation;
          this.update(
            outcome.kind === "network"
              ? { status: "error", message: outcome.message }
              : {
                  status: "session-expired",
                  message: "Your session has expired. Sign in again, then retry — your text is kept.",
                },
          );
          return;
        }
        // Definitive rejection (locked / invalid / forbidden): nothing was written.
        this.pending = this.pending ?? mutation.value;
        this.update({
          status: outcome.kind === "locked" ? "locked" : "error",
          message: outcome.message,
        });
        return;
      }
    } finally {
      this.inFlight = false;
      this.update({});
    }
  }

  /** Manual retry after an error / session expiry / lock. */
  retry(): Promise<void> {
    return this.flush();
  }

  /** Conflict resolution: overwrite the other user's version deliberately (creates a new revision on top). */
  keepMine(): Promise<void> {
    const conflict = this.snap.conflict;
    if (!conflict) return Promise.resolve();
    this.pending = this.pending ?? this.snap.value;
    this.update({ conflict: null, baseVersion: conflict.theirVersion, status: "dirty", message: null });
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
    });
  }

  addOptionToList(option: OptionView): void {
    if (this.snap.options.some((o) => o.id === option.id)) return;
    this.update({ options: [...this.snap.options, option] });
  }

  private async send(m: Mutation, keepalive: boolean): Promise<SendOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `/api/visits/${this.cfg.visitId}/clinical-entries/${this.cfg.fieldId}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          keepalive,
          body: JSON.stringify({
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

/** All savers of a section: aggregate unsaved state and flush everything on unload. */
export class SaverGroup {
  private readonly savers = new Map<string, FieldSaver>();
  private listeners = new Set<() => void>();
  private count = 0;

  add(fieldId: string, saver: FieldSaver): void {
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

  private recompute(): void {
    let n = 0;
    for (const s of this.savers.values()) if (s.hasUnsaved()) n += 1;
    if (n !== this.count) {
      this.count = n;
      for (const l of this.listeners) l();
    }
  }

  /** Flush every field. Used on blur/hide/unload. */
  flushAll(opts: { keepalive?: boolean } = {}): Promise<void[]> {
    return Promise.all([...this.savers.values()].map((s) => s.flush(opts)));
  }
}

export type AddOptionOutcome =
  | { ok: true; option: OptionView }
  | { ok: false; sessionExpired: boolean; message: string };

/** "+ Add New" through the same authenticated Route Handler family. */
export async function postNewOption(
  fieldId: string,
  label: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<AddOptionOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/clinical/fields/${fieldId}/options`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
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
