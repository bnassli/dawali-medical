import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHOICE_DEBOUNCE_MS,
  FieldSaver,
  newMutationId,
  postNewOption,
  SaverGroup,
  TYPING_DEBOUNCE_MS,
  type EntryValue,
} from "@/modules/clinical/autosave-client";

const EMPTY: EntryValue = { optionIds: [], freeText: "" };
const text = (freeText: string): EntryValue => ({ optionIds: [], freeText });

interface Call {
  url: string;
  init: RequestInit;
  body: {
    expectedUserId: string;
    expectedVersion: number;
    clientMutationId: string;
    freeText: string;
  };
}

function makeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Call["body"] });
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
const conflict = (version: number, value: EntryValue) => () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: "conflict",
      message: "conflict",
      current: { version, value, options: [{ id: "o1", label: "Theirs opt", isActive: true }] },
    }),
    { status: 409 },
  );
const status = (code: number, message = "nope") => () =>
  new Response(JSON.stringify({ ok: false, error: "x", message }), { status: code });

function makeSaver(fetchImpl: ReturnType<typeof makeFetch>["fetchImpl"], version = 0) {
  let n = 0;
  return new FieldSaver({
    visitId: "visit-1",
    fieldId: "field-1",
    actorId: "user-1",
    initialVersion: version,
    initialValue: EMPTY,
    initialOptions: [],
    fetchImpl,
    newId: () => `mutation-${++n}`,
  });
}

describe("FieldSaver (client autosave engine)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces typing into one save carrying expectedVersion and a clientMutationId", async () => {
    const { calls, fetchImpl } = makeFetch([ok(1, text("abc"))]);
    const saver = makeSaver(fetchImpl);

    saver.edit(text("a"), TYPING_DEBOUNCE_MS);
    saver.edit(text("ab"), TYPING_DEBOUNCE_MS);
    saver.edit(text("abc"), TYPING_DEBOUNCE_MS);
    expect(saver.getSnapshot().status).toBe("dirty");
    expect(saver.hasUnsaved()).toBe(true);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/visits/visit-1/clinical-entries/field-1");
    expect(calls[0]?.body).toMatchObject({
      expectedVersion: 0,
      clientMutationId: "mutation-1",
      freeText: "abc",
    });
    expect(saver.getSnapshot()).toMatchObject({ status: "saved", baseVersion: 1, unsaved: false });
  });

  it("sends edits made during an in-flight save afterwards, using the returned version", async () => {
    let release: (r: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = makeFetch([() => held, ok(2, text("second"))]);
    const saver = makeSaver(fetchImpl);

    saver.edit(text("first"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);

    saver.edit(text("second"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1); // still serialised

    release(new Response(JSON.stringify({ ok: true, version: 1, value: text("first") }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ expectedVersion: 1, freeText: "second" });
    expect(calls[1]?.body.clientMutationId).not.toBe(calls[0]?.body.clientMutationId);
    expect(saver.getSnapshot().baseVersion).toBe(2);
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("after a network failure retries the SAME mutation id first, so an applied request is never mistaken for a conflict", async () => {
    const { calls, fetchImpl } = makeFetch([
      () => Promise.reject(new TypeError("offline")),
      ok(1, text("one")),
      ok(2, text("two")),
    ]);
    const saver = makeSaver(fetchImpl);

    saver.edit(text("one"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(saver.getSnapshot().status).toBe("error");
    expect(saver.hasUnsaved()).toBe(true);

    saver.edit(text("two"), CHOICE_DEBOUNCE_MS); // user keeps typing while offline
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);

    expect(calls).toHaveLength(3);
    expect(calls[1]?.body).toMatchObject({ clientMutationId: "mutation-1", expectedVersion: 0, freeText: "one" });
    expect(calls[2]?.body).toMatchObject({ clientMutationId: "mutation-2", expectedVersion: 1, freeText: "two" });
    expect(saver.getSnapshot()).toMatchObject({ status: "saved", baseVersion: 2 });
  });

  it("409 never overwrites: enters conflict, keeps my text, and stops sending", async () => {
    const { calls, fetchImpl } = makeFetch([conflict(3, text("theirs"))]);
    const saver = makeSaver(fetchImpl);

    saver.edit(text("mine"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);

    const snap = saver.getSnapshot();
    expect(snap.status).toBe("conflict");
    expect(snap.conflict).toMatchObject({ theirVersion: 3, theirs: text("theirs") });
    expect(snap.value).toEqual(text("mine"));
    expect(saver.hasUnsaved()).toBe(true);

    saver.edit(text("mine, edited more"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });

  it("Keep mine re-sends my value on top of theirs with expectedVersion = their version and a new id", async () => {
    const { calls, fetchImpl } = makeFetch([conflict(3, text("theirs")), ok(4, text("mine"))]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("mine"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);

    await saver.keepMine();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ expectedVersion: 3, freeText: "mine", clientMutationId: "mutation-2" });
    expect(saver.getSnapshot()).toMatchObject({ status: "saved", baseVersion: 4, conflict: null });
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("Use theirs adopts their value, version and options without sending anything", async () => {
    const { calls, fetchImpl } = makeFetch([conflict(3, text("theirs"))]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("mine"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);

    saver.useTheirs();
    expect(calls).toHaveLength(1);
    expect(saver.getSnapshot()).toMatchObject({
      status: "saved",
      value: text("theirs"),
      baseVersion: 3,
      conflict: null,
      unsaved: false,
    });
    expect(saver.getSnapshot().options.map((o) => o.id)).toEqual(["o1"]);
  });

  it("401 keeps the text as unsaved and offers a retry with the same id after sign-in", async () => {
    const { calls, fetchImpl } = makeFetch([status(401), ok(1, text("kept"))]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("kept"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);

    expect(saver.getSnapshot().status).toBe("session-expired");
    expect(saver.getSnapshot().value).toEqual(text("kept"));
    expect(saver.hasUnsaved()).toBe(true);

    await saver.retry();
    expect(calls[1]?.body).toMatchObject({ clientMutationId: "mutation-1", freeText: "kept" });
    expect(saver.getSnapshot()).toMatchObject({ status: "saved", unsaved: false });
  });

  it("423 marks the field locked but keeps the text unsaved", async () => {
    const { fetchImpl } = makeFetch([status(423, "visit closed")]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("late"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(saver.getSnapshot()).toMatchObject({ status: "locked", message: "visit closed" });
    expect(saver.hasUnsaved()).toBe(true);
  });

  it("flush({ keepalive: true }) sends immediately, without waiting for the debounce, using fetch keepalive", async () => {
    const { calls, fetchImpl } = makeFetch([ok(1, text("bye"))]);
    const saver = makeSaver(fetchImpl);
    saver.edit(text("bye"), TYPING_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);

    await saver.flush({ keepalive: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.keepalive).toBe(true);
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(saver.hasUnsaved()).toBe(false);

    // A later ordinary save is not keepalive.
    const later = makeFetch([ok(2, text("x"))]);
    const saver2 = makeSaver(later.fetchImpl);
    saver2.edit(text("x"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(later.calls[0]?.init.keepalive).toBe(false);
  });

  it("SaverGroup counts unsaved fields and flushAll sends every pending field", async () => {
    const a = makeFetch([ok(1, text("a"))]);
    const b = makeFetch([ok(1, text("b"))]);
    const group = new SaverGroup("visit-1", "user-1");
    const sa = makeSaver(a.fetchImpl);
    const sb = makeSaver(b.fetchImpl);
    group.add("a", sa);
    group.add("b", sb);
    const seen: number[] = [];
    group.subscribe(() => seen.push(group.getUnsavedCount()));

    expect(group.getUnsavedCount()).toBe(0);
    sa.edit(text("a"), TYPING_DEBOUNCE_MS);
    sb.edit(text("b"), TYPING_DEBOUNCE_MS);
    expect(group.getUnsavedCount()).toBe(2);

    await group.flushAll({ keepalive: true });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(group.getUnsavedCount()).toBe(0);
    expect(seen).toContain(2);
    expect(seen.at(-1)).toBe(0);
  });

  it("newMutationId falls back to getRandomValues when randomUUID is unavailable (non-secure origins)", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const id = newMutationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("postNewOption maps 401 to a session-expired outcome", async () => {
    const expired = await postNewOption("f", "x", "user-1", async () => new Response("{}", { status: 401 }));
    expect(expired).toMatchObject({ ok: false, sessionExpired: true });
    const good = await postNewOption(
      "f",
      "x",
      "user-1",
      async () =>
        new Response(JSON.stringify({ ok: true, option: { id: "o", label: "x", isActive: true } }), {
          status: 200,
        }),
    );
    expect(good).toMatchObject({ ok: true, option: { id: "o" } });
  });

  it("nothing in src persists clinical text to localStorage/sessionStorage", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const code = readFileSync(full, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "");
          if (/\b(localStorage|sessionStorage|indexedDB)\b/.test(code)) offenders.push(full);
        }
      }
    };
    walk(path.resolve(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
