import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_BANK, buildQuestionQueue, cleanQuestionStarter } from '../src/data/question-bank.js';
import { normalizeSlateAnswer, calculateSlateResults, applySlateResults } from '../src/slate-core.js';
import { viewForPhase, canPatchRound } from '../src/services/live-ui.js';

function room(answers, matchScoring = 'one') {
  return { gameId:'test', gameKind:'sameSlate', currentRound:1, matchScoring, phase:'answering',
    players:Object.fromEntries(answers.map((_,i) => [`p${i}`, {displayName:`Player ${i}`, locked:true, totalScore:0, highRoundCount:0}])),
    rounds:{1:{answers:Object.fromEntries(answers.map((text,i) => [`p${i}`, {text:text || 'No answer', empty:!text, locked:true}]))}} };
}

test('1,000 original cards contain exactly 500 unique prompts in each orientation', () => {
  assert.equal(CARD_BANK.length, 1000);
  assert.equal(new Set(CARD_BANK.map(c=>c.id)).size, 1000);
  assert.equal(new Set(CARD_BANK.map(c=>c.prompt)).size, 1000);
  for (const direction of ['before','after']) {
    const cards = CARD_BANK.filter(c=>c.direction===direction);
    assert.equal(cards.length, 500);
    assert.equal(new Set(cards.map(c=>c.word.toLowerCase())).size, 500);
    for (const card of cards) assert.match(card.prompt, direction==='before' ? /^____ [^_]+$/ : /^[^_]+ ____$/);
  }
});
test('host card filters, recent-card avoidance and custom-only rooms work together', () => {
  const queue = buildQuestionQueue(20, { directions:['before'], excludedIds:CARD_BANK.slice(500,520).map(c=>c.id) });
  assert.equal(queue.length,20);
  assert.ok(queue.every(c=>c.direction==='before' && !CARD_BANK.slice(500,520).some(r=>r.id===c.id)));
  assert.equal(new Set(queue.map(c=>c.id)).size,20);
  const custom = buildQuestionQueue(1,{includeOriginal:false,includeCustom:true,customQuestions:[{id:'custom1',query:'____ Field'}],directions:['before']});
  assert.equal(custom[0].prompt,'____ Field');
  assert.throws(()=>buildQuestionQueue(1,{directions:[]}));
  assert.throws(()=>buildQuestionQueue(1,{includeOriginal:false,includeCustom:false}));
  assert.equal(cleanQuestionStarter(' Elbow ___ '),'Elbow ____');
  assert.equal(cleanQuestionStarter('___ Field'),'____ Field');
  assert.throws(()=>cleanQuestionStarter('Word ___ Word'));
});
test('matching ignores case and punctuation without inventing spelling or plural matches', () => {
  assert.equal(normalizeSlateAnswer('  ICE--CREAM!  '), 'ice cream');
  assert.equal(normalizeSlateAnswer("don't"), normalizeSlateAnswer('dont'));
  const results=calculateSlateResults(room(['Pads!', ' PADS ', 'pad', 'pain', '', '']));
  assert.deepEqual(results.map(r=>r.points),[1,1,0,0,0,0]);
});
test('groups of four earn one point or three points per player; nobody matches themself', () => {
  assert.deepEqual(calculateSlateResults(room(['corn','corn','corn','corn','grass'])).map(r=>r.points),[1,1,1,1,0]);
  assert.deepEqual(calculateSlateResults(room(['corn','corn','corn','corn','grass'],'matches')).map(r=>r.points),[3,3,3,3,0]);
  assert.equal(calculateSlateResults(room(['corn']))[0].points,0);
  assert.ok(calculateSlateResults(room(['corn','corn'])).every(r=>!r.match.partnerUids.includes(r.uid)));
});
test('32 matching players earn 31 each and replaying finalization never doubles totals', () => {
  const game=room(Array(32).fill('grease'),'matches');
  applySlateResults(game,100);
  assert.ok(Object.values(game.players).every(p=>p.totalScore===31 && p.highRoundCount===1));
  assert.equal(game.phase,'recap');
  applySlateResults(game,200);
  assert.ok(Object.values(game.players).every(p=>p.totalScore===31 && p.highRoundCount===1));
  assert.equal(game.rounds[1].finalizedAt,100);
});
test('another player submitting preserves the active input; host transitions leave recap automatically', () => {
  const before=room(['','']);
  const after=structuredClone(before); after.rounds[1].answers.p1={text:'corn',locked:true};
  assert.equal(canPatchRound(before,after,'play','p0'),true);
  after.currentRound=2;
  assert.equal(canPatchRound(before,after,'play','p0'),false);
  assert.equal(viewForPhase('recap','answering'),'play');
  assert.equal(viewForPhase('recap','finished'),'finale');
  assert.equal(viewForPhase('settings','answering'),'settings');
});
