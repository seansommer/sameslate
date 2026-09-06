import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/services/effects.js", import.meta.url), "utf8")
  .replace("export const soundEffects", "const soundEffects");
const keys = {
  sound: "sameslate.soundEnabled.v1",
  effects: "sameslate.effectsVolume.v1",
  music: "sameslate.musicVolume.v1"
};

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler, options) {
      const entries = listeners.get(type) || [];
      entries.push({ handler, options });
      listeners.set(type, entries);
    },
    fire(type) {
      return Promise.all((listeners.get(type) || []).map(({ handler }) => handler({ type })));
    }
  };
}

function createAudio({ preferences = {}, storageBlocked = false, supported = true, audioSession = { type: "auto" }, resumeResults = [] } = {}) {
  const stored = new Map(Object.entries(preferences));
  const timers = new Map();
  const contexts = [];
  let nextTimer = 0;
  const document = { ...eventTarget(), visibilityState: "visible" };
  class FakeContext {
    constructor() {
      Object.assign(this, eventTarget());
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
      this.gains = [];
      this.oscillators = [];
      this.resumeCalls = 0;
      this.pendingResumes = [];
      contexts.push(this);
    }
    changeState(state) { this.state = state; return this.fire("statechange"); }
    resume() {
      this.resumeCalls++;
      const result = resumeResults.shift();
      if (result === "reject") return Promise.reject(new Error("Activation required"));
      if (result === "pending") return new Promise((resolve) => this.pendingResumes.push(resolve));
      if (result === "interrupted") return this.changeState("interrupted");
      return this.changeState("running");
    }
    createGain() {
      const node = {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(target) { return target; }
      };
      this.gains.push(node);
      return node;
    }
    createOscillator() {
      const node = {
        ...eventTarget(),
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        stops: [],
        connect(target) { return target; },
        start(time) { this.startedAt = time; },
        stop(time) { this.stops.push(time); }
      };
      this.oscillators.push(node);
      return node;
    }
  }
  const window = { ...eventTarget(), AudioContext: supported ? FakeContext : undefined };
  const navigator = { audioSession };
  const sandbox = {
    window, document, navigator,
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error("Storage blocked"); return stored.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error("Storage blocked"); stored.set(key, value); },
      removeItem(key) { stored.delete(key); }
    },
    setTimeout(handler, delay) { const id = ++nextTimer; timers.set(id, { handler, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source + "\nthis.soundEffects = soundEffects;", sandbox);
  return { sound: sandbox.soundEffects, contexts, timers, document, window, navigator, stored };
}

test("a new device uses audible default volumes, not Number(null)'s zero", () => {
  const { sound, stored } = createAudio();
  assert.equal(sound.enabled, true);
  assert.equal(sound.musicVolume, 0.34);
  assert.equal(sound.effectsVolume, 1);
  assert.equal(stored.size, 0, "defaults do not overwrite a user's stored choices");
});

test("missing or invalid volume preferences use defaults while explicit zero stays muted", () => {
  for (const value of [null, undefined, "", "  ", "invalid"]) {
    const { sound } = createAudio({ preferences: { [keys.music]: value, [keys.effects]: value } });
    assert.equal(sound.musicVolume, 0.34);
    assert.equal(sound.effectsVolume, 1);
  }
  const { sound } = createAudio({ preferences: { [keys.music]: "0", [keys.effects]: "0", [keys.sound]: "false" } });
  assert.equal(sound.musicVolume, 0);
  assert.equal(sound.effectsVolume, 0);
  assert.equal(sound.enabled, false);
});

test("saved and legacy volumes survive the update; blocked storage is harmless", () => {
  const saved = createAudio({ preferences: { [keys.music]: "0.61", [keys.effects]: "0.22" } });
  assert.equal(saved.sound.musicVolume, 0.61);
  assert.equal(saved.sound.effectsVolume, 0.22);
  const legacy = createAudio({ preferences: { "sameslate.legacy.musicVolume.v1": "0" } });
  assert.equal(legacy.sound.musicVolume, 0);
  assert.equal(legacy.stored.get(keys.music), "0");
  assert.equal(legacy.stored.has("sameslate.legacy.musicVolume.v1"), false);
  const blocked = createAudio({ storageBlocked: true });
  assert.equal(blocked.sound.musicVolume, 0.34);
  assert.equal(blocked.sound.setMusicVolume(0.7), 0.7);
});

test("touch-end starts the home music without creating audio before an interaction", async () => {
  const ui = createAudio();
  ui.sound.installUnlockHandlers();
  ui.sound.installUnlockHandlers();
  ui.sound.syncBackgroundMusic("home");
  assert.equal(ui.contexts.length, 0);
  assert.equal(ui.window.listeners.get("touchend").length, 1);
  assert.equal(ui.window.listeners.get("touchend")[0].options.once, undefined);
  assert.equal(ui.window.listeners.get("touchend")[0].options.passive, true);
  await ui.window.fire("touchend");
  const ctx = ui.contexts[0];
  assert.equal(ctx.state, "running");
  assert.equal(ctx.gains[2].gain.value, 0.34);
  assert.ok(ctx.oscillators.length > 0);
  assert.equal(ui.timers.size, 1);
  assert.equal(ui.navigator.audioSession.type, "playback");
  const count = ctx.oscillators.length;
  await ui.window.fire("click");
  ui.sound.syncBackgroundMusic("home");
  assert.equal(ctx.oscillators.length, count, "repeat taps/renders must not layer music loops");
  assert.equal(ui.timers.size, 1);
});

test("a rejected unlock retries on the next tap and a pending unlock does not block retries", async () => {
  const ui = createAudio({ resumeResults: ["reject", "pending"] });
  ui.sound.installUnlockHandlers();
  ui.sound.syncBackgroundMusic("home");
  await ui.window.fire("touchend");
  const ctx = ui.contexts[0];
  assert.equal(ctx.oscillators.length, 0);
  const pending = ui.window.fire("touchend");
  await ui.window.fire("click");
  assert.equal(ctx.resumeCalls, 3);
  assert.equal(ui.timers.size, 1);
  const count = ctx.oscillators.length;
  ctx.pendingResumes[0]();
  await pending;
  assert.equal(ctx.oscillators.length, count);
});

test("iOS interrupted audio clears old notes and resumes a single fresh loop", async () => {
  const ui = createAudio();
  ui.sound.installUnlockHandlers();
  ui.sound.syncBackgroundMusic("game");
  await ui.window.fire("touchend");
  const ctx = ui.contexts[0];
  const firstNotes = [...ctx.oscillators];
  await ctx.changeState("interrupted");
  assert.equal(ui.timers.size, 0);
  assert.ok(firstNotes.every((note) => note.stops.includes(0)));
  await ui.window.fire("touchend");
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(ctx.state, "running");
  assert.equal(ui.timers.size, 1);
  assert.ok(ctx.oscillators.length > firstNotes.length);
});

test("music pauses offscreen and resumes after visibility or page-cache restoration", async () => {
  const ui = createAudio();
  ui.sound.installUnlockHandlers();
  ui.sound.syncBackgroundMusic("home");
  await ui.window.fire("click");
  const ctx = ui.contexts[0];
  ui.document.visibilityState = "hidden";
  await ui.document.fire("visibilitychange");
  assert.equal(ui.timers.size, 0);
  await ctx.changeState("interrupted");
  await ctx.changeState("running");
  assert.equal(ui.timers.size, 0, "state changes cannot start music behind another app");
  ui.document.visibilityState = "visible";
  await ui.document.fire("visibilitychange");
  assert.equal(ui.timers.size, 1);
  await ui.window.fire("pagehide");
  ui.sound.syncBackgroundMusic("home");
  assert.equal(ui.timers.size, 0);
  await ui.window.fire("pageshow");
  assert.equal(ui.timers.size, 1);
});

test("returning while muted stays silent, and leaving a music route prevents restart", async () => {
  const ui = createAudio();
  ui.sound.installUnlockHandlers();
  ui.sound.syncBackgroundMusic("home");
  await ui.window.fire("click");
  assert.equal(ui.sound.toggle(), false);
  await ui.window.fire("touchend");
  await ui.window.fire("pageshow");
  assert.equal(ui.timers.size, 0);
  ui.sound.toggle();
  await ui.sound.unlock();
  assert.equal(ui.timers.size, 1);
  ui.sound.syncBackgroundMusic(null);
  await ui.contexts[0].changeState("interrupted");
  await ui.window.fire("click");
  assert.equal(ui.timers.size, 0);
});

test("music slider zero and effect slider remain independent", async () => {
  const ui = createAudio({ preferences: { [keys.music]: "0" } });
  ui.sound.syncBackgroundMusic("home");
  await ui.sound.unlock();
  assert.equal(ui.timers.size, 0);
  ui.sound.lockIn();
  assert.equal(ui.contexts[0].oscillators.length, 3);
  ui.sound.setMusicVolume(0.5);
  assert.equal(ui.timers.size, 1);
  ui.sound.setEffectsVolume(0.2);
  assert.equal(ui.sound.musicVolume, 0.5);
  ui.sound.setMusicVolume(0);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.stored.get(keys.music), "0");
});

test("music previews do not overlap the background when another tap occurs", async () => {
  const ui = createAudio();
  ui.sound.installUnlockHandlers();
  ui.sound.syncBackgroundMusic("home");
  await ui.window.fire("click");
  await ui.sound.previewTheme("game");
  const count = ui.contexts[0].oscillators.length;
  await ui.window.fire("touchend");
  assert.equal(ui.contexts[0].oscillators.length, count);
  assert.equal(ui.timers.size, 1);
  const [id, timer] = [...ui.timers][0];
  ui.timers.delete(id);
  timer.handler();
  assert.ok(ui.contexts[0].oscillators.length > count);
  assert.equal(ui.timers.size, 1);
});

test("unsupported or restricted audio-session APIs cannot break audio or the page", async () => {
  for (const audioSession of [null, Object.defineProperty({}, "type", { set() { throw new Error("Unsupported"); } })]) {
    const ui = createAudio({ audioSession });
    ui.sound.syncBackgroundMusic("home");
    assert.equal(await ui.sound.unlock(), true);
    assert.equal(ui.timers.size, 1);
  }
  const unsupported = createAudio({ supported: false });
  unsupported.sound.syncBackgroundMusic("home");
  assert.equal(await unsupported.sound.unlock(), false);
  assert.equal(unsupported.timers.size, 0);
});
