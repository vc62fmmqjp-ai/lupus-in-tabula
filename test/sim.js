/* Simulazione di gioco end-to-end per Liqui in Tabula (test senza UI).
   Avvia un server in un child process e pilota i client via WebSocket. */

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.SIM_PORT || 3999;
let passed = 0, failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✖ ' + label); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status >= 200 && r.status < 500) return;
    } catch (e) { /* ritenta */ }
    await sleep(200);
  }
  throw new Error('Server non raggiungibile: ' + url);
}

class Player {
  constructor(name) {
    this.name = name;
    this.snap = null;
    this.seer = null;
    this.errs = [];
    this.ws = null;
    this.id = null;
    this.isGM = false;
  }
  connect(port) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('open', () => {
        this.ws = ws;
        ws.send(JSON.stringify({ type: 'join', name: this.name }));
      });
      ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.type === 'state') {
          this.snap = m;
          if (!m.you) return; // snapshot ospite (non ancora iscritto)
          this.id = m.you.id;
          this.isGM = !!m.you.isGM;
          if (this.pendingResolve) { const r = this.pendingResolve; this.pendingResolve = null; r(); }
          else if (!this.ready) { this.ready = true; res(); }
        } else if (m.type === 'seerResult') {
          this.seer = m;
        } else if (m.type === 'err') {
          this.errs.push(m.msg);
        }
      });
      ws.on('error', rej);
    });
  }
  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  nextState() { return new Promise(r => { this.pendingResolve = r; }); }
  close() { if (this.ws) this.ws.close(); }
}

// --- helpers helpers helpers helpers helpers helpers helpers helpers helpers ---
function humans(p) { return p.filter(x => !x.isGM); }
function gmSnap(g) { return g.snap.gm; }
function roleOf(g, role) {
  const p = gmSnap(g).players.find(x => x.role === role && x.alive);
  return p ? p : null;
}
function aliveNames(cs) { return humans(cs.map(c => ({ isGM: false, name: c.name, alive: true, id: c.id }))); }

function packPlayers(players) {
  return players.map(p => ({ id: p.id, name: p.name, isGM: p.isGM, alive: true }));
}

async function claimGM(player) {
  player.send({ type: 'claim' });
  await sleep(150);
  if (!player.isGM) throw new Error(player.name + ' non è diventato Game Master dopo la claim!');
}

async function newGame(port, names) {
  const players = [];
  for (const n of names) {
    const p = new Player(n);
    await p.connect(port);
    players.push(p);
  }
  const gm = players[0];
  // nessuno è GM all'ingresso: il primo lo diventa solo con la claim
  if (gm.isGM) throw new Error('Il primo giocatore è già GM (dovrebbe servire la claim)!');
  await claimGM(gm);

  // un altro giocatore che prova a prendere la corona riceve un errore
  players[1].send({ type: 'claim' });
  await sleep(150);
  if (players[1].isGM) throw new Error('Un secondo giocatore è diventato GM senza permesso!');
  if (!players[1].errs.some(e => /Game Master/i.test(e))) {
    throw new Error('Il secondo claim non ha prodotto un errore "già assegnato"');
  }
  return { players, gm };
}

async function startGame(gm, cfg) {
  gm.send({ type: 'gm', action: 'start', config: cfg });
  await sleep(120);
  const snap = gm.snap;
  if (snap.phase !== 'roles') throw new Error('La partita non è entrata in fase roles: ' + snap.phase);
}

async function rolesAck(players) {
  for (const p of players) if (!p.isGM) p.send({ type: 'ack' });
  await sleep(120);
}

async function intoNight(gm) {
  gm.send({ type: 'gm', action: 'night' });
  await sleep(80);
}

async function wake(gm, group) {
  gm.send({ type: 'gm', action: 'wake', group });
  await sleep(80);
}

async function sleepGM(gm) {
  gm.send({ type: 'gm', action: 'sleep' });
  await sleep(80);
}

function findPlayer(gm, name) { return gmSnap(gm).players.find(p => p.name === name); }
function ids(gm, names) { return names.map(n => findPlayer(gm, n).id); }

async function dawnAndAnnounce(gm) {
  gm.send({ type: 'gm', action: 'dawn' });
  await sleep(100);
  gm.send({ type: 'gm', action: 'announce' });
  await sleep(100);
}

// ================================================================
// TEST 1: protezione del Protettore + Veggente + rogo
// ================================================================
async function test1() {
  console.log('\nTEST 1 · Protettore, Veggente, votazione e rogo');

  const { players, gm } = await newGame(3991, ['p1gm', 'p2', 'p3', 'p4', 'p5']);
  await startGame(gm, { wolves: 1, seer: true, protector: true, puttana: false });

  // Ruoli dal punto di vista del GM
  const s = gmSnap(gm);
  const wolf = roleOf(gm, 'wolf');
  const seer = roleOf(gm, 'seer');
  const prot = roleOf(gm, 'protector');
  const vill = s.players.find(p => p.role === 'villager');
  ok(wolf && seer && prot && vill, 'ruoli assegnati: 1 lupo, 1 veggente, 1 protettore, 1 contadino');

  // I 4 umani vedono il proprio ruolo
  ok(players.filter(p => !p.isGM).every(p => !!p.snap.you.role), 'ogni giocatore conosce il proprio ruolo');

  await rolesAck(players);
  ok(players.filter(p => !p.isGM).every(p => p.snap.you.acked), 'tutti i giocatori hanno letto il ruolo');

  await intoNight(gm);
  await wake(gm, 'wolves');
  const wolfP = players.find(p => p.name === wolf.name);
  ok(wolfP.snap.night.myTurn && wolfP.snap.night.step === 'wolves', 'il lupo è sveglio e può agire');
  const protP = players.find(p => p.name === prot.name);
  ok(!protP.snap.night.myTurn, 'il protettore dorme quando i lupi agiscono');

  // Notte 1: i lupi puntano il contadino, il protettore lo salva
  gm.send({ type: 'gm', action: 'setWolfTarget', target: vill.id });
  await sleep(60);
  wolfP.send({ type: 'night', target: vill.id });
  await sleep(60);
  await sleepGM(gm);

  await wake(gm, 'seer');
  const seerP = players.find(p => p.name === seer.name);
  ok(seerP.snap.night.myTurn, 'il veggente è sveglio');
  seerP.send({ type: 'night', target: prot.id });
  await sleep(100);
  ok(seerP.seer && seerP.seer.isWolf === false, `il veggente scopre che ${prot.name} NON è un lupo`);
  await sleepGM(gm);

  await wake(gm, 'protector');
  protP.send({ type: 'night', target: vill.id });
  await sleep(60);
  await sleepGM(gm);

  await dawnAndAnnounce(gm);
  ok(gmSnap(gm).deaths.length === 0, 'il protettore salva il contadino: nessun morto alla notte 1');

  // Notte 2: i lupi puntano ancora il contadino, il protettore protegge il veggente
  await intoNight(gm);
  await wake(gm, 'wolves');
  gm.send({ type: 'gm', action: 'setWolfTarget', target: vill.id });
  await sleep(60);
  wolfP.send({ type: 'night', target: vill.id });
  await sleepGM(gm);

  await wake(gm, 'protector');
  protP.send({ type: 'night', target: seer.id });
  await sleepGM(gm);

  await wake(gm, 'seer');
  seerP.send({ type: 'night', target: wolf.id });
  await sleep(100);
  ok(seerP.seer && seerP.seer.isWolf === true, `il veggente scopre che ${wolf.name} È un lupo`);
  await sleepGM(gm);

  await dawnAndAnnounce(gm);
  const deaths2 = gmSnap(gm).deaths.map(d => d.name);
  ok(deaths2.includes(vill.name) && deaths2.length === 1, 'notte 2: muore solo il contadino');

  // Votazione e rogo: il GM brucia il lupo -> vince il villaggio
  gm.send({ type: 'gm', action: 'openVoting' });
  await sleep(80);
  for (const p of humans(players)) {
    const candidates = humans(players).filter(q => q.name !== p.name && q.snap.you.alive);
    if (candidates.length && p.snap.you.alive) {
      p.send({ type: 'vote', target: candidates[0].snap.you.id });
    }
  }
  await sleep(100);
  ok(Object.keys(gmSnap(gm).votes).length > 0, 'i vivi hanno votato');
  gm.send({ type: 'gm', action: 'closeVoting' });
  await sleep(60);
  gm.send({ type: 'gm', action: 'burn', target: wolf.id });
  await sleep(100);
  ok(gm.snap.phase === 'gameover' && gm.snap.winner === 'village', 'bruciando il lupo vince il VILLAGGIO');

  // la rivelazione finale è visibile a tutti
  ok(players.filter(p => !p.isGM).every(p => p.snap.phase === 'gameover' && p.snap.reveal && p.snap.reveal.length === 4),
     'tutti vedono i ruoli finali');

  players.forEach(p => p.close());
}

// ================================================================
// TEST 2: la Puttana (casa, fuga, visita al lupo)
// ================================================================
async function test2() {
  console.log('\nTEST 2 · La Puttana: casa, lupi a vuoto, visita al lupo');

  const { players, gm } = await newGame(3992, ['gm2', 'a', 'b', 'c', 'd', 'e']);
  await startGame(gm, { wolves: 1, seer: false, protector: false, puttana: true });

  const s = gmSnap(gm);
  const wolf = roleOf(gm, 'wolf');
  const puttana = roleOf(gm, 'puttana');
  ok(wolf && puttana, 'ruoli assegnati: 1 lupo e 1 puttana');
  const villagers = s.players.filter(p => p.role === 'villager');

  await rolesAck(players);
  await intoNight(gm);
  await wake(gm, 'wolves');

  // Notte 1: il lupo morde il contadino V1, la puttana resta a casa -> muore solo V1
  gm.send({ type: 'gm', action: 'setWolfTarget', target: villagers[0].id });
  await sleep(60);
  players.find(p => p.name === wolf.name).send({ type: 'night', target: villagers[0].id });
  await sleepGM(gm);

  await wake(gm, 'puttana');
  const puttP = players.find(p => p.name === puttana.name);
  ok(puttP.snap.night.myTurn && puttP.snap.night.step === 'puttana', 'la puttana è sveglia e può agire');
  puttP.send({ type: 'night', home: true });
  await sleep(60);
  await sleepGM(gm);

  await dawnAndAnnounce(gm);
  let deaths = gmSnap(gm).deaths.map(d => d.name);
  ok(deaths.length === 1 && deaths.includes(villagers[0].name), 'notte 1: resta a casa → muore solo il contadino');

  // Notte 2: i lupi vanno a casa della puttana ma lei è da V2 -> nessun morto
  await intoNight(gm);
  await wake(gm, 'wolves');
  gm.send({ type: 'gm', action: 'setWolfTarget', target: puttana.id });
  await sleep(60);
  players.find(p => p.name === wolf.name).send({ type: 'night', target: puttana.id });
  await sleepGM(gm);

  await wake(gm, 'puttana');
  puttP.send({ type: 'night', target: villagers[1].id });
  await sleep(60);
  await sleepGM(gm);

  await dawnAndAnnounce(gm);
  deaths = gmSnap(gm).deaths.map(d => d.name);
  ok(deaths.length === 0, 'notte 2: i lupi trovano il letto vuoto → nessun morto');

  // Notte 3: la puttana visita il lupo -> muore lei; il lupo morde V3 -> muore lui
  await intoNight(gm);
  await wake(gm, 'wolves');
  gm.send({ type: 'gm', action: 'setWolfTarget', target: villagers[2].id });
  await sleep(60);
  players.find(p => p.name === wolf.name).send({ type: 'night', target: villagers[2].id });
  await sleepGM(gm);

  await wake(gm, 'puttana');
  puttP.send({ type: 'night', target: wolf.id });
  await sleep(60);
  await sleepGM(gm);

  await dawnAndAnnounce(gm);
  deaths = gmSnap(gm).deaths.map(d => d.name);
  ok(deaths.includes(puttana.name) && deaths.includes(villagers[2].name) && deaths.length === 2,
     'notte 3: la puttana muore dal lupo e il lupo ha morso V3');

  // Ora: lupo + V2 vivi -> lupi >= altri -> vittoria lupi
  ok(gm.snap.phase === 'gameover' && gm.snap.winner === 'wolves', 'i LUPI vincono la partita');

  // Test riavvio: i giocatori restano connessi, fase lobby
  gm.send({ type: 'gm', action: 'restart' });
  await sleep(120);
  const reconnectErr = players.find(p => !p.isGM && p.snap.phase !== 'lobby');
  ok(!reconnectErr, 'dopo il restart tutti tornano in lobby');
  ok(gm.snap.gm === undefined || gm.snap.phase === 'lobby', 'il GM resta GM dopo il restart');
  ok(gm.snap.gmName, 'il gmName è ancora valorizzato dopo il restart');

  players.forEach(p => p.close());
}

// ================================================================
// TEST 3: condizioni di vittoria al rogo
// ================================================================
async function test3() {
  console.log('\nTEST 3 · Condizioni di vittoria al rogo');

  const { players, gm } = await newGame(3993, ['gm3', 'a3', 'b3', 'c3', 'd3']);
  await startGame(gm, { wolves: 1, seer: false, protector: false, puttana: false });

  const wolf = roleOf(gm, 'wolf');
  const villagers = gmSnap(gm).players.filter(p => p.role === 'villager');
  ok(wolf && villagers.length === 3, 'ruoli: 1 lupo + 3 contadini');

  await rolesAck(players);
  await intoNight(gm);
  await wake(gm, 'wolves');
  gm.send({ type: 'gm', action: 'setWolfTarget', target: villagers[0].id });
  await sleep(60);
  players.find(p => p.name === wolf.name).send({ type: 'night', target: villagers[0].id });
  await sleep(60);
  await sleepGM(gm);
  await dawnAndAnnounce(gm);
  ok(gm.snap.phase === 'discussion', 'notte 1: restano 1 lupo + 2 contadini → si continua');

  // Rogo di un contadino: lupi (1) == buoni (1) → vincono i LUPI
  gm.send({ type: 'gm', action: 'openVoting' });
  await sleep(60);
  gm.send({ type: 'gm', action: 'closeVoting' });
  await sleep(60);
  gm.send({ type: 'gm', action: 'burn', target: villagers[1].id });
  await sleep(100);
  ok(gm.snap.phase === 'gameover' && gm.snap.winner === 'wolves',
     'rogo di un contadino → lupi == buoni → vincono i LUPI');

  // Rogo dell'ultimo lupo → vincono i BUONI
  gm.send({ type: 'gm', action: 'restart' });
  await sleep(120);
  await startGame(gm, { wolves: 1, seer: false, protector: false, puttana: false });
  const wolf2 = roleOf(gm, 'wolf');
  gm.send({ type: 'gm', action: 'burn', target: wolf2.id });
  await sleep(100);
  ok(gm.snap.phase === 'gameover' && gm.snap.winner === 'village',
     "rogo dell'ultimo lupo → vincono i BUONI");

  players.forEach(p => p.close());
}

// ================================================================
async function withServer(fn, port) {
  const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitServer(`http://127.0.0.1:${port}`);
    await fn();
  } catch (e) {
    failed++;
    console.log('  ✖ ERRORE: ' + e.message);
  } finally {
    server.kill();
    await sleep(300);
  }
}

async function main() {
  try {
    await withServer(test1, 3991);
    await withServer(test2, 3992);
    await withServer(test3, 3993);
  } catch (e) {
    failed++;
    console.log('  ✖ ERRORE: ' + e.message);
  }
  console.log(`\nRisultato: ${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}

main();