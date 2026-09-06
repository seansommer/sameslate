import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { FirebaseGameService } from '../src/services/firebase-service.js';
import { CARD_BANK } from '../src/data/question-bank.js';
import { normalizeEmail, normalizeNickname } from '../src/core.js';

// This suite can only connect to the demo database emulator, never production.
const environment = await initializeTestEnvironment({ projectId:'demo-same-slate', database:{ host:'127.0.0.1', port:9000, rules:await readFile(new URL('../firebase-database.rules.json',import.meta.url),'utf8') } });
const profiles={};
const sessions={};
const loginLookup={};
const loginKey=(email,name)=>createHash('sha256').update(`${normalizeEmail(email)}|${normalizeNickname(name)}`).digest('hex');
for(let i=0;i<35;i++) {
  const uid=`p${i}`, email=`p${i}@example.test`, displayName=`Player ${i}`, key=loginKey(email,displayName);
  profiles[uid]={displayName,email,role:i===0?'host':'player',authProvider:'anonymous',ownerAuthUid:`auth-${uid}`,loginKey:key,createdAt:1,updatedAt:1};
  sessions[`auth-${uid}`]={profileId:uid,loginKey:key};
  loginLookup[key]=uid;
}
profiles.master={displayName:'Master',role:'master',email:'master@example.test',authProvider:'anonymous',ownerAuthUid:'auth-master',loginKey:'m'.repeat(64),createdAt:1,updatedAt:1};
sessions['auth-master']={profileId:'master',loginKey:'m'.repeat(64)};loginLookup['m'.repeat(64)]='master';
const service=(uid)=>{
  const db=environment.authenticatedContext(`auth-${uid}`).database();
  const svc=new FirebaseGameService();
  svc.db=db;svc.profile={profileId:uid,...profiles[uid]};svc.auth={currentUser:{uid:`auth-${uid}`,isAnonymous:true}};
  svc.api={ref:(_db,path)=>path?db.ref(path):db.ref(),get:r=>r.get(),onValue:(r,fn,fail)=>{r.on('value',fn,fail);return ()=>r.off('value',fn);},set:(r,v)=>r.set(v),update:(r,v)=>r.update(v),remove:r=>r.remove(),push:r=>r.push(),runTransaction:(r,fn)=>r.transaction(fn,undefined,false),serverTimestamp:()=>({'.sv':'timestamp'})};
  return svc;
};
let checks=0;
const passed=(label)=>{checks++;console.log(`PASS ${label}`);};
try {
  await environment.withSecurityRulesDisabled(async context=>context.database().ref().set({users:profiles,sessions,loginLookup}));
  const host=service('p0'), player=service('p1'), other=service('p2'), master=service('master');
  await assertSucceeds(player.api.get(player.api.ref(player.db,'users/p1')));
  await assertFails(player.api.get(player.api.ref(player.db,'users/p2')));
  await assertFails(player.api.set(player.api.ref(player.db,'users/p1/role'),'host'));
  passed('shared profiles retain private emails and enforce host roles');
  await player.requestHostAccess();
  await master.approveHostRequest('p1');
  assert.equal((await master.getProfile('p1')).role,'host');
  passed('existing host-request approval still works');
  const game=await host.createGame({nickname:'32 Player Test',totalRounds:2,roundTimerEnabled:false,hostPlays:true,questionQueue:CARD_BANK.slice(0,2),suggestionMode:'matching',matchScoring:'matches',directions:['after']});
  await player.joinGame(game.code); await other.joinGame(game.code);
  const joined=await Promise.allSettled(Array.from({length:30},(_,i)=>service(`p${i+3}`).joinGame(game.code)));
  assert.equal(joined.filter(r=>r.status==='fulfilled').length,29);
  const room=await host.getGame(game.gameId);assert.equal(Object.keys(room.players).length,32);
  await assert.rejects(service('p34').joinGame(game.code), /full|32|permission.denied/i);
  passed('simultaneous joins enforce the 32-player limit in database rules');
  const card=CARD_BANK[0];
  await host.startGame(game.gameId,{questionId:card.id,category:card.category,prompt:card.prompt,query:card.query,word:card.word,direction:card.direction});
  const ids=Object.keys(room.players);
  await Promise.all(ids.map(id=>service(id).submitAnswer(game.gameId,1,'pads')));
  const publicRound=(await player.getGame(game.gameId)).rounds[1];
  assert.ok(Object.values(publicRound.answers).every(a=>!('text' in a)));
  await assertFails(other.api.get(other.api.ref(other.db,`sameSlateAnswers/${game.gameId}/1/p1`)));
  await assertFails(player.submitAnswer(game.gameId,1,'changed'));
  await assertFails(player.submitAnswer(game.gameId,2,'future'));
  await assertFails(player.api.set(player.api.ref(player.db,`sameSlateGames/${game.gameId}/players/p1/totalScore`),999));
  passed('locked answers stay hidden from other players and cannot be rewritten');
  await Promise.all([host.revealRound(game.gameId),host.revealRound(game.gameId)]);
  let scored=await host.getGame(game.gameId);
  assert.equal(scored.phase,'recap');
  assert.ok(Object.values(scored.players).every(p=>p.totalScore===31));
  assert.equal(Object.keys(scored.rounds[1].results).length,32);
  assert.ok(Object.values((await player.getGame(game.gameId)).rounds[1].answers).every(a=>a.text==='pads'));
  passed('reveal publishes all answers and scores every match exactly once');
  const next=await Promise.allSettled([host.startNextRound(game.gameId,2,{...card,questionId:card.id}),host.startNextRound(game.gameId,2,{...card,questionId:card.id})]);
  assert.equal(next.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await host.getGame(game.gameId)).currentRound,2);
  passed('host starts next round without player-ready flags and duplicate starts cannot overwrite it');
  await environment.withSecurityRulesDisabled(async context=>context.database().ref(`sameSlateGames/${game.gameId}/rounds/2`).update({timerEnabled:true,deadlineAt:Date.now()-5000}));
  await host.expireAnsweringRound(game.gameId,2);
  scored=await host.getGame(game.gameId);
  assert.ok(Object.values(scored.rounds[2].results).every(r=>r.points===0));
  await host.finishGame(game.gameId);
  const stats=await player.listLifetimeStats();
  assert.equal(stats.find(p=>p.uid==='p1').totalPoints,31);
  await host.updateLifetimeStatsForGame(game.gameId,await host.getGame(game.gameId));
  assert.equal((await player.listLifetimeStats()).find(p=>p.uid==='p1').gamesPlayed,1);
  passed('expired blank answers never match and lifetime stat synchronization is idempotent');
  const messageId=await host.sendMessage({email:profiles.p2.email,displayName:profiles.p2.displayName,body:'Good game!'});
  await assertSucceeds(other.api.get(other.api.ref(other.db,`mailboxes/p2/${messageId}`)));
  await assertFails(player.api.get(player.api.ref(player.db,`mailboxes/p2/${messageId}`)));
  await assertFails(master.api.get(master.api.ref(master.db,`mailboxes/p2/${messageId}`)));
  await other.markMessageRead(messageId);
  await assertFails(other.api.set(other.api.ref(other.db,`mailboxes/p2/${messageId}/body`),'forged'));
  await other.sendMessage({replyTo:{id:messageId,uid:'p0'},body:'You too!'});
  await host.deleteMessage(messageId);
  assert.ok((await other.api.get(other.api.ref(other.db,`mailboxes/p2/${messageId}`))).exists());
  passed('messages support exact-player lookup, private access, replies, read status and independent deletion');
  await master.deleteGame(game.gameId);
  await environment.withSecurityRulesDisabled(async context=>assert.equal((await context.database().ref(`sameSlateGames/${game.gameId}`).get()).exists(),false));
  await environment.withSecurityRulesDisabled(async context=>assert.equal((await context.database().ref(`sameSlateAnswers/${game.gameId}`).get()).exists(),false));
  assert.equal((await player.listLifetimeStats()).length,0);
  passed('master deletion removes game, hidden answers, history and derived records');
  const hostedOnly=await host.createGame({nickname:'Host only',totalRounds:2,roundTimerEnabled:false,hostPlays:false,questionQueue:CARD_BANK.slice(0,2),suggestionMode:'matching',matchScoring:'one',directions:['after']});
  await environment.withSecurityRulesDisabled(async context=>context.database().ref().update({
    'games/feud-host-only':{gameId:'feud-host-only',hostUid:'p0',hostDisplayName:'Player 0',status:'lobby'},
    'userGames/p0/feud-host-only':{role:'host',code:'TEST'}
  }));
  await host.updateDisplayName('Renamed Host');
  const renamed=await host.getGame(hostedOnly.gameId);
  assert.equal(renamed.hostDisplayName,'Renamed Host');
  assert.equal(renamed.players?.p0,undefined);
  await environment.withSecurityRulesDisabled(async context=>{
    const feud=(await context.database().ref('games/feud-host-only').get()).val();
    assert.equal(feud.hostDisplayName,'Renamed Host');assert.equal(feud.players?.p0,undefined);
  });
  passed('shared nickname changes preserve hosts who do not play in either game');
  console.log(`${checks} database integration scenarios passed.`);
} finally { await environment.cleanup(); }
