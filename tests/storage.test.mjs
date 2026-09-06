import test from "node:test";
import assert from "node:assert/strict";
import { sessionStore } from "../src/services/storage.js";

function useStorage(t, initial = []) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map(initial);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key)
    }
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  return values;
}

test("night mode defaults to the stage and remembers both toggle positions", (t) => {
  useStorage(t);
  assert.equal(sessionStore.getNightMode(), false);
  sessionStore.setNightMode(true);
  assert.equal(sessionStore.getNightMode(), true);
  sessionStore.setNightMode(false);
  assert.equal(sessionStore.getNightMode(), false);
});

test("saved night mode survives a new session without touching game or audio state", (t) => {
  const values = useStorage(t, [
    ["sameslate.nightMode.v1", "true"],
    ["sameslate.activeGame", "room-1"],
    ["sameslate.draftAnswer", '{"gameId":"room-1","roundNumber":2,"answer":"tie a tie"}'],
    ["sameslate.soundEnabled.v1", "false"]
  ]);
  assert.equal(sessionStore.getNightMode(), true);
  sessionStore.setNightMode(false);
  assert.equal(sessionStore.getActiveGame(), "room-1");
  assert.equal(sessionStore.readDraft("room-1", 2), "tie a tie");
  assert.equal(values.get("sameslate.soundEnabled.v1"), "false");
});

test("invalid or inaccessible appearance storage never stops the game", (t) => {
  useStorage(t, [["sameslate.nightMode.v1", "invalid"]]);
  assert.equal(sessionStore.getNightMode(), false);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage blocked"); }
  });
  assert.equal(sessionStore.getNightMode(), false);
  assert.doesNotThrow(() => sessionStore.setNightMode(true));
});
