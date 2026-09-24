import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHOICE_DEBOUNCE_MS,
  FieldSaver,
  SaverGroup,
  type EntryValue,
} from "@/modules/clinical/autosave-client";
import { isGuardedLinkClick, type LinkClickInfo } from "@/modules/clinical/navigation-guard";

const EMPTY: EntryValue = { optionIds: [], freeText: "" };
const text = (freeText: string): EntryValue => ({ optionIds: [], freeText });

interface Sent {
  url: string;
  init: RequestInit;
  body: { expectedUserId: string; expectedVersion: number; clientMutationId: string; freeText: string };
}

function makeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Sent["body"] });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  });
  return { calls, fetchImpl };
}

const ok = (version: number, value: EntryValue = EMPTY) => () =>
  new Response(JSON.stringify({ ok: true, changed: true, replayed: false, version, value }), {
    status: 200,
  });
const apiError = (status: number, error: string) => () =>
  new Response(JSON.stringify({ ok: false, error, message: error }), { status });
const conflict = (version: number, value: EntryValue) => () =>
  new Response(
    JSON.stringify({ ok: false, error: "conflict", message: "c", current: { version, value, options: [] } }),
    { status: 409 },
  );

function makeSaver(
  fetchImpl: ReturnType<typeof makeFetch>["fetchImpl"],
  opts: { visitId?: string; fieldId?: string; actorId?: string; version?: number } = {},
) {
  let n = 0;
  return new FieldSaver({
    visitId: opts.visitId ?? "visit-1",
    fieldId: opts.fieldId ?? "field-1",
    actorId: opts.actorId ?? "user-A",
    initialVersion: opts.version ?? 0,
    initialValue: EMPTY,
    initialOptions: [],
    fetchImpl,
    newId: () => `mutation-${++n}`,
  });
}

describe("FieldSaver: actor binding, discard, reconcile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the rendered user as expectedUserId on every request", async () => {
    const { calls, fetchImpl } = makeFetch([ok(1, text("a")), ok(2, text("b"))]);
    const saver = makeSaver(fetchImpl, { actorId: "user-A" });
    saver.edit(text("a"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    saver.edit(text("b"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(calls.map((c) => c.body.expectedUserId)).toEqual(["user-A", "user-A"]);
  });

  it("a different signed-in user (403 actor_mismatch) keeps the text unsaved and never marks it saved", async () => {
    const { calls, fetchImpl } = makeFetch([apiError(403, "actor_mismatch"), ok(1, text("mine"))]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("mine"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);

    const snap = saver.getSnapshot();
    expect(snap.status).toBe("actor-mismatch");
    expect(snap.message).toContain("different user");
    expect(snap.value).toEqual(text("mine"));
    expect(saver.hasUnsaved()).toBe(true);

    // Retrying (e.g. after signing back in as the original user) reuses the same mutation id.
    await saver.retry();
    expect(calls[1]?.body).toMatchObject({ clientMutationId: "mutation-1", expectedUserId: "user-A" });
    expect(saver.getSnapshot()).toMatchObject({ status: "saved", unsaved: false });
  });

  it("every failure state counts as unsaved (this is what triggers the navigation guard)", async () => {
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["error", () => Promise.reject(new TypeError("offline"))],
      ["session-expired", apiError(401, "unauthenticated")],
      ["actor-mismatch", apiError(403, "actor_mismatch")],
      ["locked", apiError(423, "visit_locked")],
      ["conflict", conflict(4, text("theirs"))],
    ];
    for (const [status, response] of cases) {
      const { fetchImpl } = makeFetch([response]);
      const saver = makeSaver(fetchImpl);
      saver.edit(text("x"), CHOICE_DEBOUNCE_MS);
      await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
      expect(saver.getSnapshot().status, status).toBe(status);
      expect(saver.hasUnsaved(), status).toBe(true);
    }
  });

  it("flush() waits for an in-flight save instead of returning early", async () => {
    let release: (r: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = makeFetch([() => held]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("slow"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(saver.hasUnsaved()).toBe(true);

    let resolved = false;
    const waiting = saver.flush().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    release(new Response(JSON.stringify({ ok: true, version: 1, value: text("slow") }), { status: 200 }));
    await waiting;
    expect(resolved).toBe(true);
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("a keepalive flush requested during an in-flight save applies to the follow-up request", async () => {
    let release: (r: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = makeFetch([() => held, ok(2, text("second"))]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("first"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    saver.edit(text("second"), TYPING);
    const done = saver.flush({ keepalive: true });
    release(new Response(JSON.stringify({ ok: true, version: 1, value: text("first") }), { status: 200 }));
    await done;
    expect(calls[0]?.init.keepalive).toBe(false);
    expect(calls[1]?.init.keepalive).toBe(true);
  });

  it("discard() drops unsaved text for good: nothing is sent, later edits and timers are ignored", async () => {
    const { calls, fetchImpl } = makeFetch([]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("throw me away"), 700);
    expect(saver.hasUnsaved()).toBe(true);

    saver.discard();
    expect(saver.hasUnsaved()).toBe(false);
    saver.edit(text("late edit"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(5000);
    await saver.flush({ keepalive: true });
    expect(calls).toHaveLength(0);
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("discard() also drops a failed (unresolved) mutation so an unmount flush cannot resurrect it", async () => {
    const { calls, fetchImpl } = makeFetch([apiError(401, "unauthenticated")]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("expired"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(saver.getSnapshot().status).toBe("session-expired");

    saver.discard();
    await saver.flush({ keepalive: true });
    expect(calls).toHaveLength(1);
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("reconcile adopts a newer server version only when nothing is unsaved", async () => {
    const { fetchImpl } = makeFetch([]);
    const saver = makeSaver(fetchImpl, { version: 2 });

    saver.reconcile(1, text("older"), []); // older than what we have: ignored
    expect(saver.getSnapshot().baseVersion).toBe(2);

    saver.reconcile(5, text("newer"), [{ id: "o", label: "O", isActive: true }]);
    expect(saver.getSnapshot()).toMatchObject({ baseVersion: 5, value: text("newer") });
    expect(saver.getSnapshot().options).toHaveLength(1);

    saver.edit(text("my unsaved text"), 700);
    saver.reconcile(9, text("even newer"), []);
    expect(saver.getSnapshot()).toMatchObject({ baseVersion: 5, value: text("my unsaved text") });
  });
});

const TYPING = 700;

describe("SaverGroup: bound to one visit and one user", () => {
  it("refuses a saver that belongs to another visit", () => {
    const { fetchImpl } = makeFetch([]);
    const group = new SaverGroup("visit-1", "user-A");
    expect(() => group.add("f", makeSaver(fetchImpl, { visitId: "visit-2" }))).toThrow(/own visit/);
    expect(() => group.add("f", makeSaver(fetchImpl, { visitId: "visit-1" }))).not.toThrow();
  });

  it("requests from a group only ever target its own visit (V1 -> V2 -> V1 never crosses)", async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const record = () => {
        const f = vi.fn(async (url: string, init: RequestInit) => {
          urls.push(url);
          void init;
          return new Response(JSON.stringify({ ok: true, version: 1, value: text("x") }), { status: 200 });
        });
        return f;
      };
      const groups = ["v1", "v2", "v1"].map((visitId) => {
        const g = new SaverGroup(visitId, "user-A");
        g.add(
          "f",
          new FieldSaver({
            visitId,
            fieldId: "f",
            actorId: "user-A",
            initialVersion: 0,
            initialValue: EMPTY,
            initialOptions: [],
            fetchImpl: record(),
          }),
        );
        return g;
      });
      for (const g of groups) g.get("f")?.edit(text("x"), CHOICE_DEBOUNCE_MS);
      await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
      expect(urls).toEqual([
        "/api/visits/v1/clinical-entries/f",
        "/api/visits/v2/clinical-entries/f",
        "/api/visits/v1/clinical-entries/f",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discardAll drops every field's unsaved text and the unsaved count returns to zero", () => {
    const { fetchImpl } = makeFetch([]);
    const group = new SaverGroup("visit-1", "user-A");
    const a = makeSaver(fetchImpl, { fieldId: "a" });
    const b = makeSaver(fetchImpl, { fieldId: "b" });
    group.add("a", a);
    group.add("b", b);
    a.edit(text("1"), 700);
    b.edit(text("2"), 700);
    expect(group.getUnsavedCount()).toBe(2);
    expect(group.unsavedFieldIds().sort()).toEqual(["a", "b"]);

    group.discardAll();
    expect(group.getUnsavedCount()).toBe(0);
    expect(group.unsavedFieldIds()).toEqual([]);
  });
});

describe("navigation guard: which link clicks are guarded", () => {
  const base: LinkClickInfo = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    href: "http://localhost:3000/patients/p1",
    target: "",
    download: false,
    currentHref: "http://localhost:3000/patients/p1/visits/v1",
  };

  it("guards ordinary same-origin in-app navigation, including target=_self", () => {
    expect(isGuardedLinkClick(base)).toBe(true);
    expect(isGuardedLinkClick({ ...base, target: "_self" })).toBe(true);
    expect(isGuardedLinkClick({ ...base, href: "http://localhost:3000/patients?x=1" })).toBe(true);
  });

  it("does not guard clicks that cannot unmount the form", () => {
    expect(isGuardedLinkClick({ ...base, target: "_blank" })).toBe(false);
    expect(isGuardedLinkClick({ ...base, metaKey: true })).toBe(false);
    expect(isGuardedLinkClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isGuardedLinkClick({ ...base, shiftKey: true })).toBe(false);
    expect(isGuardedLinkClick({ ...base, altKey: true })).toBe(false);
    expect(isGuardedLinkClick({ ...base, button: 1 })).toBe(false);
    expect(isGuardedLinkClick({ ...base, download: true })).toBe(false);
    expect(isGuardedLinkClick({ ...base, defaultPrevented: true })).toBe(false);
    expect(isGuardedLinkClick({ ...base, href: base.currentHref + "#section" })).toBe(false);
    expect(isGuardedLinkClick({ ...base, href: base.currentHref })).toBe(false);
  });

  it("leaves cross-origin and non-http links to the browser's beforeunload prompt", () => {
    expect(isGuardedLinkClick({ ...base, href: "https://example.org/x" })).toBe(false);
    expect(isGuardedLinkClick({ ...base, href: "mailto:a@b.c" })).toBe(false);
    expect(isGuardedLinkClick({ ...base, href: "not a url" })).toBe(false);
  });
});
