import { THEMES } from "./music.js";

const SOUND_PREFERENCE_KEY = "sameslate.soundEnabled.v1";
const EFFECTS_VOLUME_KEY = "sameslate.effectsVolume.v1";
const MUSIC_VOLUME_KEY = "sameslate.musicVolume.v1";
const LEGACY_KEYS = {
  sound: "sameslate.legacy.soundEnabled.v1",
  effects: "sameslate.legacy.effectsVolume.v1",
  music: "sameslate.legacy.musicVolume.v1"
};

const DEFAULT_EFFECTS_VOLUME = 1;
const DEFAULT_MUSIC_VOLUME = 0.34;

let audioContext = null;
let masterBus = null;
let effectsBus = null;
let musicBus = null;
let soundEnabled = true;
let effectsVolume = DEFAULT_EFFECTS_VOLUME;
let musicVolume = DEFAULT_MUSIC_VOLUME;
let backgroundTheme = null;
let musicLoopTimer = null;
let previewResumeTimer = null;
let unlockHandlersInstalled = false;
let pageActive = true;
const activeMusicNodes = new Set();

function clampVolume(value, fallback) {
  // localStorage returns null on a new device; Number(null) would mute it.
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function readPreference(currentKey, legacyKey) {
  const current = localStorage.getItem(currentKey);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    localStorage.setItem(currentKey, legacy);
    localStorage.removeItem(legacyKey);
  }
  return legacy;
}

try {
  soundEnabled = readPreference(SOUND_PREFERENCE_KEY, LEGACY_KEYS.sound) !== "false";
  effectsVolume = clampVolume(
    readPreference(EFFECTS_VOLUME_KEY, LEGACY_KEYS.effects),
    DEFAULT_EFFECTS_VOLUME
  );
  musicVolume = clampVolume(
    readPreference(MUSIC_VOLUME_KEY, LEGACY_KEYS.music),
    DEFAULT_MUSIC_VOLUME
  );
} catch {
  soundEnabled = true;
  effectsVolume = DEFAULT_EFFECTS_VOLUME;
  musicVolume = DEFAULT_MUSIC_VOLUME;
}

function applyMix() {
  if (masterBus) masterBus.gain.value = soundEnabled ? 1 : 0;
  if (effectsBus) effectsBus.gain.value = effectsVolume;
  if (musicBus) musicBus.gain.value = musicVolume;
}

function context() {
  if (!audioContext || audioContext.state === "closed") {
    stopMusicLoop();
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      // Supported iPhones can use media playback instead of the ringer channel.
      // This is optional: older Safari and other browsers still use Web Audio.
      try {
        if (navigator.audioSession) navigator.audioSession.type = "playback";
      } catch {
        // Experimental/unsupported audio-session settings must not block sound.
      }
      audioContext = new AudioContext();
      masterBus = audioContext.createGain();
      effectsBus = audioContext.createGain();
      musicBus = audioContext.createGain();
      effectsBus.connect(masterBus);
      musicBus.connect(masterBus);
      masterBus.connect(audioContext.destination);
      applyMix();
      const ctx = audioContext;
      ctx.addEventListener("statechange", () => {
        if (ctx !== audioContext) return;
        if (ctx.state === "running") ensureMusicLoop();
        else stopMusicLoop();
      });
    }
  }
  return audioContext;
}

function scheduleTone(frequency, delay = 0, duration = 0.12, options = {}) {
  if (!soundEnabled || !isPageActive()) return null;
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") return null;

  const start = options.startAt ?? ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = options.type || "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  if (options.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, start + duration);
  }
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.volume || 0.09, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(options.bus === "music" ? musicBus : effectsBus);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);

  if (options.trackMusic) {
    activeMusicNodes.add(oscillator);
    oscillator.addEventListener("ended", () => activeMusicNodes.delete(oscillator), { once: true });
  }
  return oscillator;
}

function tone(frequency, delay = 0, duration = 0.12, options = {}) {
  return scheduleTone(frequency, delay, duration, { ...options, bus: "effects" });
}

function chord(notes, delay, duration, volume = 0.055) {
  notes.forEach((note) => tone(note, delay, duration, { type: "triangle", volume }));
}

function stopMusicLoop() {
  clearTimeout(musicLoopTimer);
  clearTimeout(previewResumeTimer);
  musicLoopTimer = null;
  previewResumeTimer = null;
  const ctx = audioContext;
  for (const oscillator of activeMusicNodes) {
    try {
      oscillator.stop(ctx?.currentTime || 0);
    } catch {
      // The oscillator may already have completed naturally.
    }
  }
  activeMusicNodes.clear();
}

function scheduleThemePhrase(themeName = "home", loop = false) {
  const ctx = audioContext;
  const theme = THEMES[themeName] || THEMES.home;
  if (!soundEnabled || !isPageActive() || musicVolume <= 0 || !ctx || ctx.state !== "running") return 0;
  const phraseStart = ctx.currentTime + 0.04;

  theme.bass.forEach(([beat, frequency]) => {
    scheduleTone(frequency, 0, theme.beatSeconds * (themeName === "game" ? 1.45 : 2.65), {
      startAt: phraseStart + beat * theme.beatSeconds,
      type: themeName === "game" ? "triangle" : "sine",
      volume: theme.bassVolume,
      bus: "music",
      trackMusic: true
    });
  });
  theme.melody.forEach(([beat, frequency, beatsLong], index) => {
    const startAt = phraseStart + beat * theme.beatSeconds;
    scheduleTone(frequency, 0, beatsLong * theme.beatSeconds, {
      startAt,
      type: "triangle",
      volume: theme.melodyVolume,
      bus: "music",
      trackMusic: true
    });
    if (index % (themeName === "game" ? 3 : 4) === 1) {
      scheduleTone(frequency * 2, 0, 0.13, {
        startAt: startAt + 0.025,
        type: themeName === "game" ? "square" : "sine",
        volume: themeName === "game" ? 0.011 : 0.018,
        bus: "music",
        trackMusic: true
      });
    }
  });

  const loopSeconds = theme.beatSeconds * theme.loopBeats;
  if (loop) {
    musicLoopTimer = setTimeout(() => {
      musicLoopTimer = null;
      if (backgroundTheme === themeName && soundEnabled && musicVolume > 0) {
        scheduleThemePhrase(themeName, true);
      }
    }, Math.max(100, (loopSeconds - 0.08) * 1000));
  }
  return loopSeconds;
}

function ensureMusicLoop() {
  if (!backgroundTheme || !soundEnabled || !isPageActive() || musicVolume <= 0
      || musicLoopTimer !== null || previewResumeTimer !== null) return;
  scheduleThemePhrase(backgroundTheme, true);
}

function isPageActive() {
  return pageActive && document.visibilityState !== "hidden";
}

function storeVolume(key, legacyKey, value) {
  try {
    localStorage.setItem(key, String(value));
    localStorage.removeItem(legacyKey);
  } catch {
    // The mix remains active for this visit when browser storage is unavailable.
  }
}

export const soundEffects = {
  get enabled() {
    return soundEnabled;
  },

  get effectsVolume() {
    return effectsVolume;
  },

  get musicVolume() {
    return musicVolume;
  },

  installUnlockHandlers() {
    if (unlockHandlersInstalled) return;
    unlockHandlersInstalled = true;
    const unlock = () => this.unlock();
    // A touch pointerdown is too early for iOS activation. Keep these listeners
    // for later taps too, since Safari may interrupt audio after switching apps.
    for (const event of ["touchend", "click", "keydown"]) {
      window.addEventListener(event, unlock, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (!isPageActive()) stopMusicLoop();
      else if (audioContext) return this.unlock();
    });
    window.addEventListener("pagehide", () => {
      pageActive = false;
      stopMusicLoop();
    });
    window.addEventListener("pageshow", () => {
      pageActive = true;
      if (audioContext) return this.unlock();
    });
  },

  async unlock() {
    if (!soundEnabled || !isPageActive()) return false;
    try {
      // Only create/resume audio from an interaction, or restore an existing
      // context. A denied or pending attempt must not prevent the next tap.
      const ctx = context();
      if (!ctx) return false;
      if (ctx.state === "suspended" || ctx.state === "interrupted") await ctx.resume();
      if (ctx !== audioContext || ctx.state !== "running") return false;
      ensureMusicLoop();
      return true;
    } catch {
      return false;
    }
  },

  toggle() {
    soundEnabled = !soundEnabled;
    try {
      localStorage.setItem(SOUND_PREFERENCE_KEY, String(soundEnabled));
      localStorage.removeItem(LEGACY_KEYS.sound);
    } catch {
      // Sound still works for this visit when browser storage is unavailable.
    }
    applyMix();
    if (soundEnabled) {
      this.unlock().then((ready) => {
        if (!ready) return;
        tone(660, 0, 0.07, { type: "sine", volume: 0.07 });
        tone(880, 0.07, 0.1, { type: "sine", volume: 0.08 });
        ensureMusicLoop();
      });
    } else {
      stopMusicLoop();
    }
    return soundEnabled;
  },

  setEffectsVolume(value) {
    effectsVolume = clampVolume(value, DEFAULT_EFFECTS_VOLUME);
    storeVolume(EFFECTS_VOLUME_KEY, LEGACY_KEYS.effects, effectsVolume);
    applyMix();
    return effectsVolume;
  },

  setMusicVolume(value) {
    musicVolume = clampVolume(value, DEFAULT_MUSIC_VOLUME);
    storeVolume(MUSIC_VOLUME_KEY, LEGACY_KEYS.music, musicVolume);
    applyMix();
    if (musicVolume <= 0) stopMusicLoop();
    else ensureMusicLoop();
    return musicVolume;
  },

  syncBackgroundMusic(themeName) {
    const requestedTheme = THEMES[themeName] ? themeName : null;
    if (requestedTheme !== backgroundTheme) {
      stopMusicLoop();
      backgroundTheme = requestedTheme;
    }
    if (backgroundTheme) ensureMusicLoop();
    else stopMusicLoop();
  },

  previewTheme(themeName = "home") {
    return this.unlock().then((ready) => {
      if (!ready) return;
      stopMusicLoop();
      const loopSeconds = scheduleThemePhrase(themeName, false);
      if (!loopSeconds) return;
      previewResumeTimer = setTimeout(() => {
        previewResumeTimer = null;
        ensureMusicLoop();
      }, Math.max(300, loopSeconds * 1000 + 80));
    });
  },

  previewEffect() {
    return this.unlock().then((ready) => {
      if (!ready) return;
      tone(523, 0, 0.08, { type: "sine", volume: 0.06 });
      tone(784, 0.08, 0.15, { type: "triangle", volume: 0.08 });
    });
  },

  lockIn() {
    tone(392, 0, 0.08, { type: "square", volume: 0.045 });
    tone(587, 0.08, 0.1, { type: "triangle", volume: 0.075 });
    tone(784, 0.17, 0.16, { type: "triangle", volume: 0.09 });
  },

  reveal() {
    [330, 392, 494, 659].forEach((note, index) =>
      tone(note, index * 0.085, 0.16, { type: "triangle", volume: 0.065 })
    );
  },

  score(points) {
    if (Number(points) <= 0) {
      tone(165, 0, 0.22, { type: "sawtooth", volume: 0.045, endFrequency: 110 });
      tone(116, 0.1, 0.28, { type: "square", volume: 0.035, endFrequency: 82 });
      return;
    }
    [523, 659, 784].forEach((note, index) =>
      tone(note, index * 0.075, 0.18, { type: "sine", volume: 0.075 })
    );
  },

  roundWin() {
    [392, 523, 659, 784].forEach((note, index) =>
      tone(note, index * 0.09, 0.24, { type: "triangle", volume: 0.075 })
    );
    chord([523, 659, 784], 0.42, 0.55, 0.05);
  },

  finale() {
    [262, 330, 392, 523, 659, 784].forEach((note, index) =>
      tone(note, index * 0.09, 0.28, { type: "triangle", volume: 0.068 })
    );
    chord([523, 659, 784, 1047], 0.62, 0.9, 0.045);
  }
};
