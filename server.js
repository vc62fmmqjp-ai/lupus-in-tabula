const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.static(PUBLIC_DIR));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// =================== STATO DI GIOCO ===================

const ROLES = {
  wolf:      { name: 'Lupo',      emoji: '🐺', desc: 'Ogni notte, insieme agli altri lupi, scegli un paesano da uccidere. Di giorno fingi di essere un innocente contadino.' },
  seer:      { name: 'Veggente',  emoji: '🔮', desc: 'Ogni notte puoi osservare un giocatore e scoprire se è un Lupo o no.' },
  protector: { name: 'Protettore',emoji: '🛡️', desc: 'Ogni notte proteggi un giocatore (non te stesso) dal morso dei lupi.' },
  puttana:   { name: 'La Puttana',emoji: '💋', desc: 'Ogni notte vai a casa di un giocatore: se è un Lupo muori. Se i Lupi uccidono chi stai visitando muori anche tu. Se i Lupi ti scelgono ma sei fuori, non muore nessuno.' },
  villager:  { name: 'Contadino', emoji: '🌾', desc: 'Non hai poteri. Di giorno osserva, discuti e vota per sospetto.' },
};
const ROLE_ORDER = ['wolf', 'seer', 'protector', 'puttana', 'villager'];

let game = createGame();
let idCounter = 1;

function createGame() {
  return {
    phase: 'lobby',
    round: 0,
    players: [],
    config: null,
    night: freshNight(),
    deaths: [],
    burned: [],
    votingOpen: false,
    votes: {},
    winner: null,
    gmId: null,
  };
}
function freshNight() {
  return {
    step: 'sleep', // sleep | wolves | seer | protector | puttana | dawn
    wolfVotes: {},   // wolfId -> targetId
    wolfTarget: null,
    seerPick: null,        // target inspected
    seerDone: false,
    protectorPick: null,   // who is protected
    protectorDone: false,
    puttanaPick: null,     // who puttana visits (null = stays home)
    puttanaDone: false,
  };
}

// =================== HELPERS ===================

function player(id) { return game.players.find(p => p.id === id); }
function humanPlayers() { return game.players.filter(p => !p.isGM); }
function alivePlayers() { return game.players.filter(p => !p.isGM && p.alive); }
function aliveWolves() { return alivePlayers().filter(p => p.role === 'wolf'); }
function aliveRole(role) { return alivePlayers().filter(p => p.role === role); }
function isGM(ws) { const p = player(ws.pid); return !!p && p.isGM; }
function pname(id) { const p = player(id); return p ? p.name : '?'; }

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function broadcast() {
  for (const p of game.players) {
    if (p.ws) send(p.ws, snapshot(p));
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// =================== RUOLI ===================

function suggestConfig(nPlayers) {
  let wolves = 1;
  if (nPlayers >= 5) wolves = 2;
  if (nPlayers >= 8) wolves = 3;
  if (nPlayers >= 11) wolves = 4;
  const seer = nPlayers >= 4;
  const protector = nPlayers >= 5;
  const puttana = nPlayers >= 7;
  return { wolves, seer, protector, puttana };
}

function buildRoles(config, nPlayers) {
  const roles = [];
  for (let i = 0; i < config.wolves; i++) roles.push('wolf');
  if (config.seer) roles.push('seer');
  if (config.protector) roles.push('protector');
  if (config.puttana) roles.push('puttana');
  while (roles.length < nPlayers) roles.push('villager');
  // Se ci sono più ruoli speciali che giocatori, taglia gli extra
  while (roles.length > nPlayers) roles.pop();
  return shuffle(roles);
}

function startGame(cfg) {
  const ps = humanPlayers();
  const nPlayers = ps.length;
  const minHumans = ps.some(p => p.solo) ? 2 : 4;
  if (nPlayers < minHumans) return { ok: false, err: `Servono almeno ${minHumans} giocatori (oltre al GM).` };
  const wolves = Math.min(Math.max(parseInt(cfg.wolves) || 1, 1), Math.max(1, Math.floor(nPlayers / 2)));
  const seer = !!cfg.seer;
  const protector = !!cfg.protector;
  const puttana = !!cfg.puttana;
  const specials = wolves + (seer ? 1 : 0) + (protector ? 1 : 0) + (puttana ? 1 : 0);
  const tryCfg = { wolves, seer, protector, puttana };
  if (specials > nPlayers) {
    return { ok: false, err: `Troppi ruoli speciali: servono ${specials} giocatori ma ce ne sono ${nPlayers}. Riduci i ruoli.` };
  }
  const roles = buildRoles(tryCfg, nPlayers);
  ps.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.acked = false;
  });
  game.config = tryCfg;
  game.phase = 'roles';
  game.round = 1;
  game.winner = null;
  game.night = freshNight();
  game.deaths = [];
  game.burned = [];
  game.votingOpen = false;
  game.votes = {};
  return { ok: true };
}

// =================== NOTTE / RISOLUZIONE ===================

function resolveNight() {
  const n = game.night;
  const deaths = new Set();
  const protP = aliveRole('protector')[0];
  const puttana = aliveRole('puttana')[0];

  const isProtected = id => protP && n.protectorDone && n.protectorPick === id;

  // Bersaglio dei lupi: quello impostato dal GM, altrimenti la pluralità dei voti dei lupi
  let wolfTargetId = n.wolfTarget;
  if (!wolfTargetId && Object.keys(n.wolfVotes).length) {
    const tally = {};
    for (const tid of Object.values(n.wolfVotes)) tally[tid] = (tally[tid] || 0) + 1;
    let best = null, bestCnt = 0;
    for (const tid in tally) if (tally[tid] > bestCnt) { bestCnt = tally[tid]; best = tid; }
    wolfTargetId = best ? Number(best) : null;
  }
  const wolfTarget = wolfTargetId ? player(wolfTargetId) : null;

  // Flag: la puttana è fuori (ha scelto di andare a casa di qualcuno)
  const puttanaOut = puttana && n.puttanaDone && n.puttanaPick !== null && n.puttanaPick !== puttana.id;

  // 1) Attacco dei lupi
  if (wolfTarget && wolfTarget.alive) {
    const targetIsPuttana = puttana && wolfTarget.id === puttana.id;
    if (targetIsPuttana && puttanaOut) {
      // I lupi vanno a casa della puttana ma lei è da un'altra parte: nessuno muore
    } else if (isProtected(wolfTarget.id)) {
      // il protettore ha protetto la vittima
    } else {
      deaths.add(wolfTarget.id);
    }
  }

  // 2) Conseguenze della puttana
  if (puttana && n.puttanaDone && n.puttanaPick !== null) {
    const visited = player(n.puttanaPick);
    if (visited) {
      if (visited.role === 'wolf') {
        // la puttana va a casa di un lupo: muore
        deaths.add(puttana.id);
      } else if (wolfTarget && visited.id === wolfTarget.id && deaths.has(visited.id)) {
        // la puttana visita la vittima designata dai lupi (che muore davvero): muore con lui
        deaths.add(puttana.id);
      }
    }
  }

  game.deaths = [...deaths];
  return game.deaths;
}

function checkWinner() {
  const alive = alivePlayers();
  if (alive.length === 0) return 'village';
  const wolves = aliveWolves().length;
  const others = alive.length - wolves;
  if (wolves === 0) return 'village';
  if (wolves >= others) return 'wolves';
  return null;
}

function applyDeaths() {
  for (const id of game.deaths) {
    const p = player(id);
    if (p) p.alive = false;
  }
  const w = checkWinner();
  if (w) {
    game.winner = w;
    game.phase = 'gameover';
  }
}

function applyBurn(targetId) {
  const p = player(targetId);
  if (p) {
    p.alive = false;
    game.burned = [p.id];
  }
  const w = checkWinner();
  if (w) {
    game.winner = w;
    game.phase = 'gameover';
  } else {
    game.phase = 'burned';
  }
}

// =================== SNAPSHOT PER CLIENT ===================

function publicPlayerList() {
  return game.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, isGM: p.isGM }));
}

function guestSnapshot() {
  const gmp = player(game.gmId);
  return {
    type: 'state',
    you: null,
    phase: game.phase,
    round: game.round,
    players: publicPlayerList(),
    gmName: gmp ? gmp.name : '',
    config: game.config,
    winner: game.winner,
  };
}

function snapshot(p) {
  const players = publicPlayerList();
  const gmp = player(game.gmId);
  const base = {
    type: 'state',
    you: { id: p.id, name: p.name, isGM: p.isGM, role: p.role || null, alive: p.alive, acked: !!p.acked },
    phase: game.phase,
    round: game.round,
    players,
    gmName: gmp ? gmp.name : '',
    config: game.config,
    winner: game.winner,
  };

  if (game.phase === 'lobby') {
    // tutti vedono la lobby
  }

  if (game.phase === 'roles' || game.phase === 'lobby') {
    base.acked = p.acked;
  }

  if (game.phase !== 'lobby' && p.role === 'wolf') {
    base.wolfPack = aliveWolves().filter(w => w.id !== p.id).map(w => w.name);
  }

  if (game.phase === 'night' || game.phase === 'dawn') {
    base.night = {
      step: game.night.step,
      myTurn: nightMyTurn(p),
      targets: nightMyTurn(p) ? aliveTargetsFor(p).map(q => ({ id: q.id, name: q.name })) : [],
      wolfVotes: p.role === 'wolf' ? game.night.wolfVotes : {},
      pickDone: false,
    };
  }

  if (game.phase === 'night') {
    const n = game.night;
    base.night.pickDone =
      (p.role === 'seer' && n.seerDone) ||
      (p.role === 'protector' && n.protectorDone) ||
      (p.role === 'puttana' && n.puttanaDone) ||
      (p.role === 'wolf' && n.wolfVotes[p.id] !== undefined);
    if (p.role === 'protector' && n.protectorDone) base.night.pick = n.protectorPick;
    if (p.role === 'puttana' && n.puttanaDone) base.night.pick = n.puttanaPick;
    if (p.role === 'seer' && n.seerDone) base.night.pick = n.seerPick;
    if (p.role === 'wolf' && n.wolfVotes[p.id] !== undefined) base.night.pick = n.wolfVotes[p.id];
  }

  if (game.phase === 'dawn' && p.isGM) {
    base.deaths = game.deaths.map(id => ({ id, name: pname(id) }));
  }

  if (game.phase === 'discussion' || game.phase === 'burned' || game.phase === 'gameover') {
    base.deaths = game.deaths.map(id => ({ id, name: pname(id) }));
    base.burned = game.burned.map(id => ({ id, name: pname(id) }));
  }

  if (game.phase === 'voting') {
    base.voting = { myVote: game.votes[p.id] || null, open: game.votingOpen };
  }

  if (p.isGM) {
    base.gm = gmSnapshot();
    // Il GM vede una coda di log degli eventi
    base.log = game.log || [];
  }

  if (game.phase === 'gameover') {
    const reveal = game.players.filter(x => !x.isGM).map(x => ({ name: x.name, role: x.role, alive: x.alive }));
    base.reveal = reveal;
  }
  return base;
}

function aliveTargetsFor(p) {
  // bersagli validi per l'azione notturna di p
  const alive = alivePlayers().filter(q => q.id !== p.id);
  if (p.role === 'wolf') return alive.filter(q => q.role !== 'wolf');
  return alive;
}

function nightMyTurn(p) {
  if (p.isGM || !p.alive) return false;
  const step = game.night.step;
  if (step === 'wolves' && p.role === 'wolf') return true;
  if (step === 'seer' && p.role === 'seer') return true;
  if (step === 'protector' && p.role === 'protector') return true;
  if (step === 'puttana' && p.role === 'puttana') return true;
  return false;
}

function gmSnapshot() {
  const players = game.players.filter(x => !x.isGM).map(p => ({
    id: p.id, name: p.name, role: p.role, alive: p.alive, acked: !!p.acked,
  }));
  const voteTally = {};
  for (const vid in game.votes) {
    const t = game.votes[vid];
    voteTally[t] = (voteTally[t] || 0) + 1;
  }
  const wolfVotes = Object.entries(game.night.wolfVotes).map(([wid, tid]) => ({ voter: pname(wid), target: pname(tid) }));
  return {
    players,
    config: game.config,
    night: {
      step: game.night.step,
      wolfVotes,
      wolfTarget: game.night.wolfTarget ? pname(game.night.wolfTarget) : null,
      seerDone: game.night.seerDone,
      protectorDone: game.night.protectorDone,
      protectorPick: game.night.protectorPick ? pname(game.night.protectorPick) : null,
      puttanaDone: game.night.puttanaDone,
      puttanaPick: game.night.puttanaPick ? pname(game.night.puttanaPick) : null,
    },
    deaths: game.deaths.map(id => ({ id, name: pname(id) })),
    burned: game.burned.map(id => ({ id, name: pname(id) })),
    votes: game.votes,
    voteTally,
    votingOpen: game.votingOpen,
    winner: game.winner,
  };
}

// =================== LOG ===================

game.log = [];
function addLog(msg) {
  game.log.push({ time: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }), msg });
  if (game.log.length > 50) game.log.shift();
}

// =================== WEBSOCKET ===================

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  // Join / rejoin
  if (msg.type === 'join') {
    const name = String(msg.name || '').trim().slice(0, 14);
    if (!name) return send(ws, { type: 'err', msg: 'Inserisci un nome valido.' });

    const existing = game.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      // riconnessione dello stesso giocatore (o GM)
      existing.ws = ws; ws.pid = existing.id;
      if (msg.solo) existing.solo = true;
      broadcast();
      return;
    }
    if (game.phase !== 'lobby') {
      return send(ws, { type: 'err', msg: 'La partita è già iniziata.' });
    }
    const id = idCounter++;
    const p = { id, name, role: null, alive: true, isGM: false, acked: false, ws, solo: !!msg.solo };
    game.players.push(p);
    ws.pid = id;
    addLog(`${name} è entrato.`);
    broadcast();
    return;
  }

  const p = player(ws.pid);
  if (!p) return;

  if (msg.type === 'claim') {
    if (p.isGM) return;
    const current = game.gmId ? player(game.gmId) : null;
    const occupied = current && current.ws && current.ws.readyState === 1 && current.id !== p.id;
    if (occupied) {
      return send(ws, { type: 'err', msg: 'Il Game Master è già stato assegnato a ' + current.name + '.' });
    }
    if (current && current.id !== p.id) current.isGM = false;
    p.isGM = true;
    game.gmId = p.id;
    addLog(`${p.name} ha preso la corona 👑 e diventa Game Master.`);
    broadcast();
    return;
  }

  if (msg.type === 'rename') {
    const name = String(msg.name || '').trim().slice(0, 14);
    if (!name) return send(ws, { type: 'err', msg: 'Inserisci un nome valido.' });
    const clash = game.players.find(q => q.id !== p.id && q.name.toLowerCase() === name.toLowerCase());
    if (clash) return send(ws, { type: 'err', msg: `Il nome "${name}" è già usato da ${clash.name}.` });
    addLog(`${p.name} ora si chiama ${name}.`);
    p.name = name;
    broadcast();
    return;
  }

  if (msg.type === 'ack') {
    p.acked = true;
    broadcast();
    return;
  }

  if (msg.type === 'night') {
    if (game.phase !== 'night') return;
    const n = game.night;
    if (p.isGM || !p.alive) return;

    if (p.role === 'wolf' && msg.target) {
      const t = player(msg.target);
      if (t && t.alive && !t.isGM && t.role !== 'wolf') {
        n.wolfVotes[p.id] = t.id;
        // se tutti i lupi hanno votato, mostra il risultato
        broadcast();
      }
    }
    if (p.role === 'seer' && n.step === 'seer' && msg.target) {
      const t = player(msg.target);
      if (t && t.alive && !t.isGM) {
        n.seerPick = t.id;
        n.seerDone = true;
        const isWolf = t.role === 'wolf';
        send(p.ws, { type: 'seerResult', name: t.name, isWolf });
        broadcast();
      }
    }
    if (p.role === 'protector' && n.step === 'protector' && msg.target) {
      const t = player(msg.target);
      if (t && t.alive && !t.isGM && t.id !== p.id) {
        n.protectorPick = t.id;
        n.protectorDone = true;
        broadcast();
      }
    }
    if (p.role === 'puttana' && n.step === 'puttana') {
      if (msg.target) {
        const t = player(msg.target);
        if (t && t.alive && !t.isGM && t.id !== p.id) {
          n.puttanaPick = t.id;
          n.puttanaDone = true;
          broadcast();
        }
      } else if (msg.home) {
        n.puttanaPick = null;
        n.puttanaDone = true;
        broadcast();
      }
    }
    return;
  }

  if (msg.type === 'vote') {
    if (game.phase !== 'voting' || !game.votingOpen) return;
    if (p.isGM || !p.alive) return;
    const t = player(msg.target);
    if (t && t.alive && !t.isGM && t.id !== p.id) {
      game.votes[p.id] = t.id;
      broadcast();
    }
    return;
  }

  // =================== AZIONI DEL GAME MASTER ===================
  if (msg.type === 'gm') {
    if (!isGM(ws)) return;
    const action = msg.action;

    if (action === 'start') {
      const r = startGame(msg.config || {});
      if (!r.ok) return send(ws, { type: 'err', msg: r.err });
      addLog('Ruoli distribuiti! Inizia il gioco.');
      broadcast();
      return;
    }

    if (action === 'night') {
      game.burned = [];
      game.deaths = [];
      game.night = freshNight();
      game.phase = 'night';
      addLog(`Notte ${game.round} — tutti dormono.`);
      broadcast();
      return;
    }

    if (action === 'wake') {
      const g = msg.group;
      const hasRole = aliveRole(g === 'wolves' ? 'wolf' : g).length > 0;
      if (!hasRole) return send(ws, { type: 'err', msg: `Nessun ${g} vivo in gioco.` });
      game.night.step = g;
      broadcast();
      return;
    }

    if (action === 'sleep') {
      game.night.step = 'sleep';
      broadcast();
      return;
    }

    if (action === 'setWolfTarget') {
      if (msg.target) {
        const t = player(msg.target);
        if (t && t.alive && !t.isGM && t.role !== 'wolf') {
          game.night.wolfTarget = t.id;
          addLog(`Il GM fissa il bersaglio dei lupi: ${t.name}.`);
          broadcast();
        }
      } else {
        game.night.wolfTarget = null;
        broadcast();
      }
      return;
    }

    if (action === 'dawn') {
      // risolvi la notte
      resolveNight();
      game.phase = 'dawn';
      addLog('È l\'alba.');
      broadcast();
      return;
    }

    if (action === 'announce') {
      // applica i morti e passa alla discussione
      applyDeaths();
      game.night.step = 'sleep';
      if (game.phase === 'gameover') {
        addLog('Partita conclusa: ' + (game.winner === 'wolves' ? 'vittoria dei LUPI 🐺' : 'vittoria del VILLAGGIO 🌾') + '.');
        broadcast();
        return;
      }
      if (game.deaths.length) addLog(`I morti di questa notte: ${game.deaths.map(id => pname(id)).join(', ')}.`);
      game.phase = 'discussion';
      addLog('I morti sono stati annunciati.');
      broadcast();
      return;
    }

    if (action === 'discussion') {
      game.phase = 'discussion';
      broadcast();
      return;
    }

    if (action === 'openVoting') {
      game.phase = 'voting';
      game.votingOpen = true;
      game.votes = {};
      addLog('Votazioni aperte.');
      broadcast();
      return;
    }

    if (action === 'closeVoting') {
      game.votingOpen = false;
      // calcola l'eliminato: chi ha più voti, a parità il GM decide
      broadcast();
      return;
    }

    if (action === 'burn') {
      if (msg.target) {
        game.votingOpen = false;
        resolveNight(); // in caso serva, ma già risolto
        applyBurn(msg.target);
        addLog(`${pname(msg.target)} è stato mandato al rogo.`);
        broadcast();
      }
      return;
    }

    if (action === 'nextNight') {
      game.deaths = [];
      game.burned = [];
      game.round++;
      game.night = freshNight();
      game.phase = 'night';
      addLog(`Notte ${game.round} — tutti dormono.`);
      broadcast();
      return;
    }

    if (action === 'restart') {
      const keepPlayers = game.players.map(p => ({ id: p.id, name: p.name, role: null, alive: true, isGM: p.isGM, acked: false, ws: p.ws, solo: p.solo }));
      game = createGame();
      game.players = keepPlayers;
      game.gmId = (keepPlayers.find(p => p.isGM) || {}).id || null;
      game.log = [];
      addLog('Nuova partita: i giocatori restano, i ruoli verranno rimischiati.');
      broadcast();
      return;
    }
  }
}

wss.on('connection', ws => {
  ws.pid = null;
  ws.isAlive = true;
  send(ws, guestSnapshot());
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => handleMessage(ws, raw));
  ws.on('close', () => {
    const p = player(ws.pid);
    if (p && p.ws === ws) {
      p.ws = null;
      if (p.isGM && game.phase !== 'gameover') {
        addLog(`Il Game Master ${p.name} ha lasciato la partita.`);
        game.recipientGM = p.name;
      } else if (!p.isGM) {
        addLog(`${p.name} ha lasciato la partita.`);
      }
      broadcast();
    }
  });
});

// heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function lanIP() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  🐺 Lupus in Tabula - server avviato');
  console.log('==============================================');
  console.log('  Sul SERVER (questo PC):  http://localhost:' + PORT);
  const ips = lanIP();
  if (ips.length) {
    console.log('  Dal TELEFONO (stessa rete WiFi):');
    for (const ip of ips) console.log('    http://' + ip + ':' + PORT);
  } else {
    console.log('  (nessuna interfaccia di rete trovata)');
  }
  console.log('  Toccando la corona 👑 (in basso a destra) un giocatore');
  console.log('  può prendere il ruolo di Game Master.');
  console.log('==============================================');
});