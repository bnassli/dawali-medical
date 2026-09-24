import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHOICE_DEBOUNCE_MS,
  fetchSectionState,
  FieldSaver,
  SaverGroup,
  type EntryValue,
} from "@/modules/clinical/autosave-client";

const EMPTY: EntryValue = { optionIds: [], freeText: "" };
const text = (freeText: string): EntryValue => ({ optionIds: [], freeText });

function saver(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, version = 0) {
  return new FieldSaver({
    visitId: "visit-1",
    fieldId: "field-1",
    actorId: "user-A",
    initialVersion: version,
    initialValue: EMPTY,
    initialOptions: [],
    fetchImpl,
    newId: () => "mutation-1",
  });
}

describe("failure controls stay mounted while a retry is in flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("failure stays set (with its message) through 'saving' and clears only on success", async () => {
    let release: (r: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const responses: Array<() => Response | Promise<Response>> = [
      () => new Response(JSON.stringify({ ok: false, error: "unauthenticated" }), { status: 401 }),
      () => held,
    ];
    const s = saver(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    });

    s.edit(text("kept"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(s.getSnapshot()).toMatchObject({ status: "session-expired", failure: "session-expired" });
    const message = s.getSnapshot().message;
    expect(message).toContain("session has expired");

    // A blur / Retry re-sends. While that request is in flight the snapshot must
    // still carry the failure, or the "Sign in again"/"Retry" control under the
    // user's pointer would be unmounted and the click swallowed.
    const retrying = s.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getSnapshot()).toMatchObject({ status: "saving", failure: "session-expired", message });

    release(new Response(JSON.stringify({ ok: true, version: 1, value: text("kept") }), { status: 200 }));
    await retrying;
    expect(s.getSnapshot()).toMatchObject({ status: "saved", failure: null, message: null, unsaved: false });
  });

  it("keeps the failure message while the user keeps typing, and each failure kind maps to its own marker", async () => {
    const kinds: Array<[number, string, string]> = [
      [423, "visit_locked", "locked"],
      [400, "invalid_value", "error"],
      [403, "actor_mismatch", "actor-mismatch"],
    ];
    for (const [status, error, failure] of kinds) {
      const s = saver(async () => new Response(JSON.stringify({ ok: false, error, message: "why" }), { status }));
      s.edit(text("a"), CHOICE_DEBOUNCE_MS);
      await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
      expect(s.getSnapshot().failure, error).toBe(failure);
      const message = s.getSnapshot().message;
      s.edit(text("ab"), 700);
      expect(s.getSnapshot()).toMatchObject({ status: "dirty", failure, message });
    }
  });

  it("discard and Use theirs clear the failure", async () => {
    const s = saver(async () => new Response("{}", { status: 401 }));
    s.edit(text("x"), CHOICE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(CHOICE_DEBOUNCE_MS);
    expect(s.getSnapshot().failure).toBe("session-expired");
    s.discard();
    expect(s.getSnapshot().failure).toBeNull();
  });
});

describe("reconciling with the server's current state (stale back/forward render)", () => {
  it("fetchSectionState parses the API response and refuses a response for another visit", async () => {
    const body = {
      ok: true,
      visitId: "visit-1",
      fields: [
        {
          id: "f1",
          version: 3,
          value: { optionIds: ["o1"], freeText: "fresh" },
          options: [{ id: "o1", label: "One", isActive: true }],
        },
        { id: "bad", version: "x" },
      ],
    };
    const calls: Array<[string, RequestInit]> = [];
    const ok = await fetchSectionState("visit-1", "subj_complaints_habits", async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    expect(calls[0]?.[0]).toBe("/api/visits/visit-1/clinical-sections/subj_complaints_habits");
    expect(calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
    expect(ok?.fields).toEqual([
      {
        id: "f1",
        version: 3,
        value: { optionIds: ["o1"], freeText: "fresh" },
        options: [{ id: "o1", label: "One", isActive: true }],
      },
    ]);

    const wrongVisit = await fetchSectionState(
      "visit-2",
      "s",
      async () => new Response(JSON.stringify(body), { status: 200 }),
    );
    expect(wrongVisit).toBeNull();
    expect(await fetchSectionState("visit-1", "s", async () => new Response("{}", { status: 401 }))).toBeNull();
    expect(await fetchSectionState("visit-1", "s", async () => Promise.reject(new Error("offline")))).toBeNull();
    expect(await fetchSectionState("visit-1", "s", async () => new Response("not json", { status: 200 }))).toBeNull();
  });

  it("adopts newer server versions for clean fields, keeps unsaved text, and picks up options others added", () => {
    const never = async () => {
      throw new Error("no request expected");
    };
    const group = new SaverGroup("visit-1", "user-A");
    const clean = saver(never, 0);
    const dirty = new FieldSaver({
      visitId: "visit-1",
      fieldId: "field-2",
      actorId: "user-A",
      initialVersion: 0,
      initialValue: EMPTY,
      initialOptions: [],
      fetchImpl: never,
    });
    group.add("field-1", clean);
    group.add("field-2", dirty);
    dirty.edit(text("typing right now"), 700);

    group.reconcileFromServer([
      { id: "field-1", version: 4, value: text("from server"), options: [{ id: "o", label: "O", isActive: true }] },
      { id: "field-2", version: 4, value: text("from server too"), options: [] },
      { id: "unknown-field", version: 1, value: EMPTY, options: [] },
    ]);
    expect(clean.getSnapshot()).toMatchObject({ baseVersion: 4, value: text("from server") });
    expect(dirty.getSnapshot()).toMatchObject({ baseVersion: 0, value: text("typing right now") });

    // Same version: nothing changes except new options from other users appear.
    group.reconcileFromServer([
      {
        id: "field-1",
        version: 4,
        value: text("from server"),
        options: [
          { id: "o", label: "O", isActive: true },
          { id: "p", label: "P", isActive: true },
        ],
      },
    ]);
    expect(clean.getSnapshot().options.map((o) => o.id)).toEqual(["o", "p"]);
    expect(clean.getSnapshot().value).toEqual(text("from server"));
  });
});
