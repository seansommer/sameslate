import test from "node:test";
import assert from "node:assert/strict";
import { THEMES } from "../src/services/music.js";

test("Same Slate has separate original menu and gameplay arrangements", () => {
  assert.equal(THEMES.home.title, "Same Wavelength");
  assert.equal(THEMES.game.title, "Little Matches");
  assert.notDeepEqual(THEMES.home.melody, THEMES.game.melody);
  for (const theme of Object.values(THEMES)) {
    assert.equal(theme.loopBeats, 32);
    for (const [beat,pitch,duration] of theme.melody) {
      assert.ok(Number.isFinite(pitch) && pitch > 0);
      assert.ok(beat >= 0 && duration > 0 && beat + duration <= theme.loopBeats);
    }
  }
});
