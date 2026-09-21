/* Lupus in Tabula - client */

/* Ogni errore non gestito viene mostrato a schermo invece di lasciare la pagina vuota */
window.addEventListener('error', e => {
  document.getElementById('app').innerHTML =
    '<div class="card center" style="border-color:#ff6b6b"><div class="big-emoji">💥</div><h2 class="h-phrase">Errore</h2>' +
    '<p class="muted">' + esc(String(e.message || e.error)) + '</p></div>';
});
const ROLES = {
  wolf:      { name: 'Lupo',       emoji: '🐺', color: '#ff6b6b', cname: 'wolf',      desc: 'Ogni notte, insieme agli altri lupi, scegli una vittima da uccidere. Di giorno fingi di essere un innocente contadino.' },
  seer:      { name: 'Veggente',   emoji: '🔮', color: '#b7a6ff', cname: 'seer',      desc: 'Ogni notte puoi osservare un giocatore e scoprire se è un Lupo o no.' },
  protector: { name: 'Protettore', emoji: '🛡️', color: '#6ee7c9', cname: 'protector', desc: 'Ogni notte scegli un giocatore (non te stesso) da proteggere dal morso dei lupi.' },
  puttana:   { name: 'La Puttana', emoji: '💋', color: '#ff8fd6', cname: 'puttana',   desc: 'Ogni notte vai a casa di un giocatore. Se è un Lupo muori. Se i Lupi uccidono chi stai visitando muori anche tu. Se i Lupi ti scelgono ma sei fuori, non muore nessuno.' },
  villager:  { name: 'Contadino',  emoji: '🌾', color: '#9be89b', cname: 'villager',  desc: 'Non hai poteri. Di giorno osserva, discuti e vota per sospetto.' },
};

let state = null;
let socket = null;
const PARAMS = new URLSearchParams(location.search);
const SOLO = PARAMS.get('solo') !== null;            // modalità prova: minimo 2 giocatori
const MIN_HUMANS = SOLO ? 2 : 4;
const LS = {                                           // identità separate per scheda (?s=1, ?s=2...)
  suf: PARAMS.get('s') || '',
  get(b) { try { return localStorage.getItem(b + this.suf) || null; } catch (e) { return null; } },
  set(b, v) { try { localStorage.setItem(b + this.suf, String(v)); } catch (e) {} },
};
let myName = LS.get('lupus_name') || '';
let myToken = LS.get('lupus_token') || '';
let selTarget = null;      // selezione corrente in un picker
let seerResult = null;     // risultato privato del veggente
let reconnectTries = 0;

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

function $(id) { return document.getElementById(id); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sid(id, name) { return `${id}:${name}`; }

/* ---------- WebSocket ---------- */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  socket = new WebSocket(proto + location.host);
  const container = document.getElementById('conn-status');

  socket.onopen = () => {
    reconnectTries = 0;
    if (myName) {
      socket.send(JSON.stringify({ type: 'join', name: myName, solo: SOLO }));
    }
  };
  socket.onmessage = e => handleMsg(JSON.parse(e.data));
  socket.onclose = () => {
    state = null;
    seerResult = null;
    selTarget = null;
    render();
    const d = setTimeout(() => { clearTimeout(d); connect(); }, 1200);
  };
  socket.onerror = () => {};
}

function send(obj) { if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj)); }

/* ---------- Message handling ---------- */
function handleMsg(m) {
  if (m.type === 'state') {
    state = m;
    myName = m.you ? m.you.name : myName;
    LS.set('lupus_name', myName || '');
    if (m.you) myToken = sid(m.you.id, m.you.name);
    render();
  } else if (m.type === 'seerResult') {
    seerResult = m;
    render();
  } else if (m.type === 'err') {
    toast(m.msg);
  }
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

/* ---------- Render (entrambe le viste) ---------- */
function render() {
  app.innerHTML = '';
  if (!state) { app.innerHTML = `<div class="card center fade-in"><div class="zzz">🕸️</div><h2 class="h-phrase">Connessione...</h2><p class="muted">In attesa del server</p></div>`; updateClaimBtn(); return; }

  const you = state.you;
  if (!you) { renderJoin(); updateClaimBtn(); return; }

  if (you.isGM) renderGM();
  else renderPlayer();
  updateClaimBtn();
}

function updateClaimBtn() {
  const crown = document.getElementById('gm-claim');
  if (crown) crown.classList.toggle('hidden', !(state && state.you && !state.you.isGM && state.you.alive));
  const rn = document.getElementById('gm-rename');
  if (rn) rn.classList.toggle('hidden', !(state && state.you));
}

function askClaim() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `
    <div class="modal fade-in">
      <span class="modal-emoji">👑</span>
      <h2 class="h-phrase">Vuoi essere tu il Game Master?</h2>
      <p class="h-sub">Guiderai la partita: distribuirai i ruoli, condurrai la notte e i giudizi del villaggio.</p>
      <div class="btn-row mt18">
        <button class="btn ghost" id="claim-no">No</button>
        <button class="btn" id="claim-yes">Sì, prendo la corona</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#claim-no').onclick = close;
  ov.querySelector('#claim-yes').onclick = () => { send({ type: 'claim' }); close(); };
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}

function askRename() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `
    <div class="modal fade-in">
      <span class="modal-emoji">✏️</span>
      <h2 class="h-phrase">Cambia il tuo nome</h2>
      <input class="field mt12" id="rename-input" type="text" maxlength="14" placeholder="Nuovo nome..." value="${esc(myName)}">
      <div class="btn-row mt18">
        <button class="btn ghost" id="rename-cancel">Annulla</button>
        <button class="btn" id="rename-ok">Salva</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#rename-cancel').onclick = close;
  const input = ov.querySelector('#rename-input');
  input.focus();
  const save = () => {
    const name = input.value.trim();
    if (!name) return toast('Scrivi un nome.');
    send({ type: 'rename', name });
    LS.set('lupus_name', name);
    close();
  };
  ov.querySelector('#rename-ok').onclick = save;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}

/* ---------- Messaggi (inizializzazione FAB) ---------- */
const claimBtn = document.getElementById('gm-claim');
if (claimBtn) claimBtn.onclick = askClaim;
const renameBtn = document.getElementById('gm-rename');
if (renameBtn) renameBtn.onclick = askRename;

/* ============ VISTA JOIN ============ */
function renderJoin() {
  const started = state.phase !== 'lobby';
  const card = document.createElement('div');
  card.className = 'card center fade-in';
  card.innerHTML = `
    <div class="emoji-big">🐺</div>
    <h1 class="title">LUPUS</h1>
    <div class="subtitle">in tabula · villaggio della taverna</div>
    <input class="field" id="join-name" type="text" maxlength="14" placeholder="Il tuo nome..." value="${esc(myName)}" ${started ? 'disabled' : ''}>
    <div class="btn-row">
      <button class="btn big" id="join-btn" ${started ? 'disabled' : ''}>${started ? 'Partita in corso…' : 'Entra'}</button>
    </div>
    ${started ? `<div class="mt12 caution">La partita è già iniziata (fase <b>${esc(state.phase)}</b>). Aspetta che finisca per entrare.</div>` : ``}
    <hr class="sep">
    <div class="h-sub">Nella taverna (${state.players.length}):</div>
    <ul class="p-list">${state.players.map(p => itemHtml(p)).join('')}</ul>
  `;
  app.appendChild(card);
  const joinBtn = card.querySelector('#join-btn');
  if (joinBtn) joinBtn.onclick = () => {
    const name = card.querySelector('#join-name').value.trim();
    if (!name) return toast('Scrivi un nome.');
    myName = name;
    LS.set('lupus_name', name);
    send({ type: 'join', name, solo: SOLO });
  };
  const nameIn = card.querySelector('#join-name');
  if (nameIn) {
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
    if (!started) nameIn.focus();
  }
}

function itemHtml(p, opts = {}) {
  const me = state.you && p.id === state.you.id;
  const tags = [];
  if (p.isGM) tags.push(`<span class="tag gm">👑 GM</span>`);
  if (!p.alive) tags.push(`<span class="tag dead">💀 morto</span>`);
  if (me) tags.push(`<span class="tag me">tu</span>`);
  const letter = p.name ? p.name[0].toUpperCase() : '?';
  return `<li class="p-item"><span class="avatar">${esc(letter)}</span><span class="name">${esc(p.name)}</span>${tags.join('')}</li>`;
}

/* ============ VISTA GIOCATORE ============ */
function renderPlayer() {
  const s = state;
  const you = s.you;
  const me = s.players.find(p => p.id === you.id);

  let content = '';

  if (s.phase === 'lobby') {
    content = lobbyPlayer();
  } else if (s.phase === 'roles') {
    content = roleReveal();
  } else if (s.phase === 'night') {
    content = nightPlayer();
  } else if (s.phase === 'dawn') {
    content = dawnWait();
  } else if (s.phase === 'discussion') {
    content = discussionPlayer();
  } else if (s.phase === 'voting') {
    content = votingPlayer();
  } else if (s.phase === 'burned') {
    content = burnedPlayer();
  } else if (s.phase === 'gameover') {
    content = gameoverPlayer();
  }

  app.innerHTML = content;
  bind();
}

function lobbyPlayer() {
  const hasGM = state.players.some(p => p.isGM);
  const sub = hasGM
    ? `${esc(gmName())} sta preparando la partita...`
    : 'nessuno ha ancora preso la corona: premi il bottone 👑 in basso per guidare!';
  return `
    <div class="fade-in">
      <h1 class="title">LUPUS</h1>
      <div class="subtitle">in tabula · ${sub}</div>
      <div class="card">
        <div class="phase-pill">Taverna</div>
        <div class="h-phrase">🪵 Adunanza</div>
        <p class="h-sub">${state.players.length} giocatore${state.players.length === 1 ? '' : 'i'} in attesa (incl. GM). Il Game Master distribuirà i ruoli.</p>
        <hr class="sep">
        <div class="h-sub">Presenti:</div>
        <ul class="p-list">${state.players.map(p => itemHtml(p)).join('')}</ul>
      </div>
    </div>`;
}

function s_alive(_x) {
  // alive (non GM) - helper
  return state.players.filter(p => !p.isGM && p.alive);
}

function gmName() { return state.gmName || '(GM)'; }

function roleReveal() {
  const r = ROLES[state.you.role];
  if (!r) return '';
  const acked = state.you.acked;
  return `
    <div class="fade-in">
      <div class="card role-card">
        <span class="role-badge" style="background:${r.color}33;color:${r.color}">IL TUO RUOLO</span>
        <span class="role-emoji">${r.emoji}</span>
        <h2 style="color:${r.color}">${r.name}</h2>
        <p>${r.desc}</p>
        <div class="btn-row"><button class="btn" id="ack-btn">${acked ? 'Ho già letto ✓' : 'Ho capito, prendo il mio ruolo'}</button></div>
      </div>
      ${state.you.role === 'wolf' ? packInfo() : ''}
    </div>`;
}

function packInfo() {
  const pack = state.wolfPack || [];
  return `<div class="card center mt12" style="border-color:rgba(255,107,107,0.4)">
    <span class="phase-pill wolf">Il branco</span>
    <p>${pack.length ? 'I tuoi fratelli lupo: <b>' + pack.map(esc).join(', ') + '</b>' : 'Sei il lupo solitario del villaggio.'}</p>
  </div>`;
}

function nightPlayer() {
  const s = state;
  const you = s.you;
  const n = s.night || { step: 'sleep', myTurn: false, targets: [], pickDone: false };
  const r = ROLES[you.role];

  // tattico: non giocatore morto
  if (!you.alive) {
    return `
      <div class="night-screen fade-in">
        <div style="font-size:4rem">👻</div>
        <div class="h-phrase">Sei uno spettro</div>
        <p class="h-sub">Sei morto, ma dall'aldilà puoi osservare la partita.</p>
        <p class="muted">🌙 Occhi chiusi, spirito vigile...</p>
      </div>`;
  }

  if (n.myTurn) {
    return nightAction(n, r);
  }
  // fase notte, non è il suo turno
  return `
    <div class="night-screen fade-in">
      <div class="moon-block"></div>
      <div class="zzz">😴</div>
      <div class="h-phrase">Occhi chiusi</div>
      <p class="h-sub">Non sbirciare! Il Game Master sta guidando la notte...</p>
      ${n.step === 'wolves' ? '<p class="night-hint">I lupi stanno scegliendo la vittima...</p>' : ''}
      ${n.step === 'seer' ? '<p class="night-hint">Il Veggente sta osservando...</p>' : ''}
      ${n.step === 'protector' ? '<p class="night-hint">Il Protettore sta vegliando...</p>' : ''}
      ${n.step === 'puttana' ? '<p class="night-hint">La Puttana sta uscendo...</p>' : ''}
    </div>`;
}

function nightAction(n, r) {
  const you = state.you;
  const wolves = n.step === 'wolves' && r.cname === 'wolf';
  const seer = n.step === 'seer' && r.cname === 'seer';
  const prot = n.step === 'protector' && r.cname === 'protector';
  const putt = n.step === 'puttana' && r.cname === 'puttana';

  let title = '';
  let sub = '';
  let cname = '';

  if (wolves) { title = 'Scegli la vittima'; sub = 'I lupi si riuniscono: chi sbranate stanotte?'; cname = 'wolf'; }
  if (seer) { title = 'Osserva un giocatore'; sub = 'Chi vuoi scrutare? Scoprirai se è un Lupo.'; cname = 'seer'; }
  if (prot) { title = 'Proteggi qualcuno'; sub = 'Chi vuoi proteggere stanotte? (non te stesso)'; cname = 'protector'; }
  if (putt) { title = 'A casa di...'; sub = 'Chi vuoi visitare stanotte? Occhio ai lupi!'; cname = 'puttana'; }

  const targets = (n.targets || []).filter(t => t.id !== you.id);

  let picker;
  if (n.pickDone) {
    picker = `<div class="ok-banner text-center">✓ Scelta registrata: <b>${esc(nameOf(n.pick))}</b>. Chiudi gli occhi e aspetta.</div>`;
  } else {
    picker = `
      <ul class="t-list" id="pick-list">
        ${targets.map(t => `<li class="t-item" data-tid="${t.id}"><span class="avatar">${esc(t.name[0].toUpperCase())}</span><span class="nm">${esc(t.name)}</span><span class="check">${selTarget === t.id ? '✅' : ''}</span></li>`).join('')}
      </ul>`;
  }

  let extra = '';
  if (wolves) extra = `<p class="muted mt12" style="font-size:0.85rem">Ogni lupo vota dal suo telefono. Il GM confermerà la vittima.</p>`;
  if (seer && seerResult) {
    const rres = seerResult.isWolf ? `<div class="alert red">🐺 ${esc(seerResult.name)} è un LUPO!</div>` : `<div class="alert green">🌾 ${esc(seerResult.name)} non è un lupo.</div>`;
    extra = `<div class="mt12">${rres}</div><div class="btn-row"><button class="btn" id="seer-ok">Ho visto. Chiudo gli occhi</button></div>`;
  }
  if (putt) {
    extra = `<div class="btn-row mt12"><button class="btn pink" id="home-btn">🏠 Resto a casa</button></div>`;
  }

  return `
    <div class="fade-in">
      <div class="card">
        <span class="phase-pill ${cname}">${r.emoji} ${r.name}</span>
        <h2 class="h-phrase">${title}</h2>
        <p class="h-sub">${sub}</p>
        ${picker}
        ${extra}
      </div>
    </div>`;
}

function dawnWait() {
  return `
    <div class="night-screen fade-in">
      <div class="day-sun"></div>
      <div class="h-phrase">L'alba sta sorgendo...</div>
      <p class="h-sub">Il Game Master sta rivelando le vittime della notte.</p>
    </div>`;
}

function discussionPlayer() {
  const deaths = state.deaths || [];
  const burned = state.burned || [];
  const live = s_alive();
  return `
    <div class="fade-in">
      <div class="card center">
        <div class="day-sun" style="margin:0 auto 12px"></div>
        <div class="h-phrase">Il giorno incombe</div>
        ${deaths.length ? `<div class="caution" style="text-align:center">💀 <b>Questa notte è morto:</b> ${deaths.map(d => esc(d.name)).join(', ')}</div>` : `<div class="ok-banner" style="text-align:center">🌤️ <b>Nessuno è morto stanotte!</b></div>`}
        ${burned.length ? `<div class="caution" style="text-align:center">🔥 <b>È stato mandato al rogo:</b> ${burned.map(d => esc(d.name)).join(', ')}</div>` : ``}
      </div>
      <div class="card center mt12">
        <div class="h-sub">In discussione... Il GM aprirà le votazioni.</div>
      </div>
      <div class="card center mt12">
        <div class="h-sub">Vivi (${live.length}):</div>
        <ul class="p-list">${live.map(p => itemHtml(p)).join('')}</ul>
      </div>
    </div>`;
}

function votingPlayer() {
  const you = state.you;
  if (!you.alive) {
    return `
      <div class="fade-in">
        <div class="card center"><div style="font-size:3rem">👻</div><h2 class="h-phrase">Spettatore</h2><p class="h-sub">I vivi stanno votando.</p></div>
      </div>`;
  }
  const targets = s_alive().filter(t => t.id !== you.id);
  const myVote = (state.voting && state.voting.myVote) || null;
  const open = state.voting && state.voting.open;

  if (!open) {
    return `
      <div class="fade-in">
        <div class="card center"><div class="big-emoji">🗳️</div><h2 class="h-phrase">Votazione chiusa</h2><p class="h-sub">${myVote ? `Hai votato <b>${esc(nameOf(myVote))}</b>.` : 'In attesa del verdetto...'} Il GM sta contando i voti.</p></div>
      </div>`;
  }

  return `
    <div class="fade-in">
      <div class="card center">
        <div class="phase-pill role">🗳️ VOTAZIONE</div>
        <h2 class="h-phrase">Chi mandate al rogo? 🔥</h2>
        <p class="h-sub">Scegli il sospetto da eliminare.</p>
        <ul class="t-list" id="pick-list">
          ${targets.map(t => `<li class="t-item" data-tid="${t.id}"><span class="avatar">${esc(t.name[0].toUpperCase())}</span><span class="nm">${esc(t.name)}</span><span class="check">${selTarget === t.id ? '✅' : ''}</span></li>`).join('')}
        </ul>
        <div class="btn-row"><button class="btn" id="vote-btn" disabled>Conferma il voto</button></div>
      </div>
    </div>`;
}

function burnedPlayer() {
  const burned = state.burned || [];
  return `
    <div class="fade-in">
      <div class="card center">
        <div class="big-emoji">🔥</div>
        <h2 class="h-phrase">Il rogo</h2>
        <p class="h-sub">Il villaggio ha deciso:</p>
        <p style="font-size:1.5rem;font-weight:800;margin:8px 0">${burned.length ? esc(burned[0].name) : '-'}</p>
        <p class="muted">Viene mandato al rogo.</p>
      </div>
      ${(state.deaths || []).length ? `<div class="card center mt12">💀 Morti della notte: ${state.deaths.map(d => esc(d.name)).join(', ')}</div>` : ''}
    </div>`;
}

function gameoverPlayer() {
  const w = state.winner;
  const winLabel = w === 'wolves' ? 'I LUPI hanno vinto! 🐺' : (w === 'village' ? 'IL VILLAGGIO ha vinto! 🌾' : 'Fine partita');
  const reveal = state.reveal || [];
  return `
    <div class="fade-in">
      <div class="winner-box ${w}">
        <h2>${winLabel}</h2>
        ${(state.deaths || []).length ? `<p class="muted">Morti: ${state.deaths.map(d=>esc(d.name)).join(', ')}</p>` : ''}
        ${(state.burned || []).length ? `<p class="muted">Al rogo: ${state.burned.map(d=>esc(d.name)).join(', ')}</p>` : ''}
      </div>
      <div class="card">
        <div class="h-sub">Ruoli finali:</div>
        <ul class="reveal-list">
          ${reveal.map(x => { const r = ROLES[x.role]; return `<li><span class="r-emoji">${r ? r.emoji : '❓'}</span><span class="r-name">${esc(x.name)}</span><span class="r-role" style="color:${r ? r.color : '#fff'}">${x.alive ? r ? r.name : x.role : '💀 ' + (r ? r.name : x.role)}</span></li>`; }).join('')}
        </ul>
      </div>
      <p class="muted center mt12">In attesa che il ${esc(state.gmName || 'Game Master')} distribuisca la prossima partita...</p>
    </div>`;
}

function nameOf(id) {
  const p = state.players.find(p => p.id === id);
  return p ? p.name : '...';
}

function s_player(id) { return state.players.find(p => p.id === id); }

/* ============ VISTA GAME MASTER ============ */
function renderGM() {
  const s = state;
  const g = s.gm || {};
  const you = s.you;
  const ps = s.players;

  let content = '';
  if (s.phase === 'lobby') content = gmLobby();
  else if (s.phase === 'roles') content = gmRoles();
  else if (s.phase === 'night') content = gmNight();
  else if (s.phase === 'dawn') content = gmDawn();
  else if (s.phase === 'discussion') content = gmDiscussion();
  else if (s.phase === 'voting') content = gmVoting();
  else if (s.phase === 'burned') content = gmBurned();
  else if (s.phase === 'gameover') content = gmGameover();

  app.innerHTML = content + gmLogPanel();
  bind();
}

function gmLogPanel() {
  const log = state.log || [];
  if (!log.length) return '';
  return `
    <div class="card gm-wrap mt12">
      <div class="gm-label">Eventi</div>
      <ul class="log-list">${log.slice(-12).map(l => `<li class="log-item"><span class="log-time">${esc(l.time)}</span><span>${esc(l.msg)}</span></li>`).join('')}</ul>
    </div>`;
}

function gmHeader(sub) {
  return `
    <div class="center fade-in">
      <h1 class="title">LUPUS · GM</h1>
      <div class="subtitle">${sub}</div>
    </div>`;
}

function gmRoster(players) {
  return `<ul class="p-list">${players.map(p => {
    const r = ROLES[p.role];
    const alive = p.alive;
    return `<li class="p-item">
      <span class="avatar" style="background:${r && alive ? r.color : '#555'}">${esc(p.name[0].toUpperCase())}</span>
      <span class="name">${esc(p.name)}</span>
      <span class="tag" style="${r ? '' : ''}">${r && alive ? r.emoji + ' ' + r.name : (!alive ? '💀' : '?')}</span>
      ${p.acked ? `<span class="checkmark">OK✓</span>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

function gmLobby() {
  const players = s_players(false);
  const nPlayers = players.length;
  const maxWolves = Math.max(1, Math.floor(nPlayers / 2));
  const cfg = localCfg();
  // tieni il numero di lupi dentro il range valido (evita valori "stantii")
  if (cfg.wolves > maxWolves) cfg.wolves = maxWolves;
  if (cfg.wolves < 1) cfg.wolves = 1;

  return `
    <div class="fade-in">
      ${gmHeader('sei il Game Master 👑')}
      <div class="card">
        <div class="phase-pill role">Configurazione partita</div>
        <p class="h-sub">Clienti in taverna (${nPlayers} giocatori + te come GM).</p>
        <hr class="sep">
        <div class="cfg-row">
          <span class="lbl">🐺 Lupi<small>Numero di lupi in gioco (max ${maxWolves})</small></span>
          <div class="stepper"><button data-cfg="wolves" data-d="-1" ${cfg.wolves <= 1 ? 'disabled' : ''}>−</button><span class="val" id="cfg-wolves">${cfg.wolves}</span><button data-cfg="wolves" data-d="1" ${cfg.wolves >= maxWolves ? 'disabled' : ''}>+</button></div>
        </div>
        <div class="cfg-row">
          <span class="lbl">🔮 Veggente</span>
          <button class="toggle ${cfg.seer ? 'on' : ''}" id="cfg-seer" data-toggle="seer"></button>
        </div>
        <div class="cfg-row">
          <span class="lbl">🛡️ Protettore</span>
          <button class="toggle ${cfg.protector ? 'on' : ''}" id="cfg-protector" data-toggle="protector"></button>
        </div>
        <div class="cfg-row">
          <span class="lbl">💋 La Puttana</span>
          <button class="toggle ${cfg.puttana ? 'on' : ''}" id="cfg-puttana" data-toggle="puttana"></button>
        </div>
        <hr class="sep">
        ${nPlayers < MIN_HUMANS ? `<div class="caution">Servono <b>almeno ${MIN_HUMANS} giocatori</b> (oltre te) per iniziare. In attesa che si uniscano...</div>` : ''}
        <button class="btn big" id="start-btn" ${nPlayers < MIN_HUMANS ? 'disabled' : ''}>🎴 Distribuisci i ruoli</button>
      </div>
      <div class="card">
        <div class="h-sub">Giocatori in taverna (${state.players.length}):</div>
        <ul class="p-list">${state.players.map(p => itemHtml(p)).join('')}</ul>
      </div>
    </div>`;
}

function s_players(_x) { return state.players.filter(p => !p.isGM); }

function gmRoles() {
  const g = state.gm || {};
  const players = g.players || [];
  const allAck = players.length > 0 && players.every(p => p.acked);
  return `
    <div class="fade-in">
      ${gmHeader('ruoli distribuiti 🎴')}
      <div class="card gm-wrap">
        <div class="gm-label">Il tuo mazzo</div>
        ${gmRoster(players)}
        <hr class="sep">
        <div class="${allAck ? 'ok-banner' : 'caution'}">${allAck ? 'Tutti hanno letto il ruolo ✓' : 'In attesa che i giocatori dicano "ho capito"...'}</div>
        <button class="btn big mt12" id="night-btn" ${allAck ? '' : 'disabled'}>🌙 Inizia la notte</button>
      </div>
    </div>`;
}

function gmNight() {
  const g = state.gm || {};
  const n = g.night || {};
  const players = g.players || [];
  const alivePlayers = players.filter(p => p.alive);
  const wolves = alivePlayers.filter(p => p.role === 'wolf');
  const seer = alivePlayers.filter(p => p.role === 'seer');
  const prot = alivePlayers.filter(p => p.role === 'protector');
  const putt = alivePlayers.filter(p => p.role === 'puttana');

  const wakable = [];
  if (wolves.length) wakable.push({ id: 'wolves', label: '🐺 Lupi', cls: 'red', on: true });
  if (seer.length) wakable.push({ id: 'seer', label: '🔮 Veggente', cls: 'purple', on: true });
  if (prot.length) wakable.push({ id: 'protector', label: '🛡️ Protettore', cls: 'teal', on: true });
  if (putt.length) wakable.push({ id: 'puttana', label: '💋 Puttana', cls: 'pink', on: true });

  const cur = n.step;

  let status = '';
  if (cur === 'wolves') {
    const votes = n.wolfVotes || [];
    status = `
      <div class="ok-banner">🐺 I lupi sono svegli. Voti: ${votes.length ? votes.map(v => `${esc(v.voter)} → ${esc(v.target)}`).join(' · ') : 'nessun voto'}</div>
      <div class="h-sub mt12">Scegli il bersaglio dei lupi (o lo impone il GM):</div>
      <ul class="p-list" id="wolf-list">${s_alive().filter(t => t.role !== 'wolf').map(t => `
        <li class="p-item" data-wolf-target="${t.id}">
          <span class="avatar">${esc(t.name[0].toUpperCase())}</span>
          <span class="name">${esc(t.name)}</span>
          <span class="check">${(state.gm.night.wolfTarget === t.name) ? '✅' : ''}</span>
      </li>`).join('')}</ul>
      <button class="btn red mt12" id="confirm-wolf">✋ Metto a dormire i lupi</button>
    `;
  } else if (cur === 'seer') {
    status = `<div class="ok-banner">${n.seerDone ? '🔮 Il veggente ha osservato un giocatore.' : 'Attendo che il veggente osservi...'}</div>`;
  } else if (cur === 'protector') {
    status = `<div class="ok-banner">${n.protectorDone ? `🛡️ Protettore protegge: <b>${n.protectorPick ? esc(n.protectorPick) : '?'}</b>` : 'Attendo che il protettore scelga...'}</div>`;
  } else if (cur === 'puttana') {
    status = `<div class="ok-banner">${n.puttanaDone ? (n.puttanaPick ? `💋 La Puttana va a casa di <b>${esc(n.puttanaPick)}</b>` : '💋 La Puttana resta a casa') : 'Attendo che la puttana scelga...'}</div>`;
  } else {
    status = `<div class="caution">🌙 Tutti dormono. Sveglia un gruppo per far agire i giocatori, oppure vai all'alba.</div>`;
  }

  return `
    <div class="fade-in">
      ${gmHeader(`notte ${state.round} · luna piena`)}
      <div class="card gm-wrap">
        <div class="gm-label">Steward della notte</div>
        ${status}
        <div class="btn-row mt12">${wakable.map(b => `<button class="btn ${b.cls}" data-wake="${b.id}">${b.label}</button>`).join('')}</div>
        <div class="btn-row mt12"><button class="btn ghost" id="sleep-btn">😴 Tutti a dormire</button></div>
        <hr class="sep">
        <button class="btn big" id="dawn-btn">🌅 È l'alba</button>
      </div>
      <div class="card mt12">
        <div class="h-sub">Roster vivo (${alivePlayers.length}):</div>
        ${gmRoster(alivePlayers)}
      </div>
    </div>`;
}

function s_nightWolfTarget() { return (state.gm && state.gm.night) ? state.gm.night.wolfTarget : null; }

function gmDawn() {
  const deaths = (state.gm ? state.gm.deaths : []) || [];
  const none = deaths.length === 0;
  return `
    <div class="fade-in">
      ${gmHeader('l\'alba 🌅')}
      <div class="card gm-wrap">
        <div class="gm-label">Vittime della notte</div>
        ${none ? `<div class="ok-banner">🌤️ Nessuno è morto stanotte.</div>` : `<div class="caution">💀 Morti: ${deaths.map(d => esc(d.name)).join(', ')}</div>`}
        <button class="btn big mt12" id="announce-btn">${none ? 'Proclama la mattina 🗣️' : 'Annuncia i morti 📣'}</button>
      </div>
    </div>`;
}

function gmDiscussion() {
  const deaths = state.deaths || [];
  const burned = state.burned || [];
  return `
    <div class="fade-in">
      ${gmHeader('il giorno · discussione 🗣️')}
      <div class="card gm-wrap">
        <div class="gm-label">Stato del villaggio</div>
        ${deaths.length ? `<div class="caution">💀 Morti della notte: ${deaths.map(d=>esc(d.name)).join(', ')}</div>` : `<div class="ok-banner">🌤️ Nessun morto stanotte.</div>`}
        ${burned.length ? `<div class="caution">🔥 Al rogo: ${burned.map(d=>esc(d.name)).join(', ')}</div>` : ''}
        <p class="h-sub mt12">Lascia discutere i giocatori (di persona!). Quando sono pronti, apri la votazione.</p>
        <button class="btn big mt12" id="voting-btn">🗳️ Apri la votazione</button>
      </div>
      <div class="card mt12"><div class="h-sub">Vivi (${s_alive().length}):</div><ul class="p-list">${s_alive().map(p=>itemHtml(p)).join('')}</ul></div>
    </div>`;
}

function gmVoting() {
  const g = state.gm || {};
  const open = g.votingOpen;
  const votes = g.votes || {};
  const tally = g.voteTally || {};
  const alive = s_alive();
  const doneVoters = Object.keys(votes).length;

  let body = '';
  if (open) {
    body = `
      <div class="ok-banner">🗳️ Votazione APERTA — hanno votato <b>${doneVoters}/${alive.length}</b></div>
      <div class="h-sub mt12">Voti finora:</div>
      <div class="tally-list" id="tally-list">${tallyItems(tally)}</div>
      <button class="btn big mt12" id="close-voting">🔒 Chiudi la votazione</button>
    `;
  } else {
    body = `
      <div class="h-sub">Conteggio finale — tocca il condannato:</div>
      <ul class="p-list" id="burn-list">${alive.map(t => `
        <li class="p-item" data-burn="${t.id}">
          <span class="avatar">${esc(t.name[0].toUpperCase())}</span>
          <span class="name">${esc(t.name)} <span class="muted">(${tally[t.id] || 0} voti)</span></span>
          <span class="check">${selBurn === t.id ? '🔥' : ''}</span>
        </li>`).join('')}</ul>
      <button class="btn red big mt12" id="burn-btn" disabled>🔥 Al rogo!</button>
    `;
  }

  return `
    <div class="fade-in">
      ${gmHeader('il giorno · votazione 🗳️')}
      <div class="card gm-wrap">
        <div class="gm-label">Verdetto del villaggio</div>
        ${body}
      </div>
      <div class="card mt12"><div class="h-sub">Vivi (${alive.length}):</div><ul class="p-list">${alive.map(p=>itemHtml(p)).join('')}</ul></div>
    </div>`;
}

let selBurn = null;

function tallyItems(tally) {
  const rows = Object.entries(tally).map(([id, cnt]) => `<div class="tally-row"><span>${esc(nameOf(Number(id)))}</span><span class="nb">${cnt} 🗳️</span></div>`).join('');
  return rows || '<div class="muted">Ancora nessun voto.</div>';
}

function gmBurned() {
  const burned = state.burned || [];
  const gmDeaths = (state.gm && state.gm.deaths) || [];
  return `
    <div class="fade-in">
      ${gmHeader('il rogo 🔥')}
      <div class="card gm-wrap">
        <div class="gm-label">Il villaggio ha condannato</div>
        <p style="font-size:1.6rem;font-weight:800">${burned.length ? esc(burned[0].name) : '-'}</p>
        <p class="muted">${state.burned.map(d=>`${esc(d.name)} 🔥`)}</p>
        ${gmDeaths.length ? `<div class="caution">💀 Morti della notte: ${gmDeaths.map(d=>esc(d.name)).join(', ')}</div>` : ''}
        <button class="btn big mt12" id="next-night-btn">🌙 Notte ${state.round + 1}</button>
      </div>
    </div>`;
}

function gmGameover() {
  const w = state.winner;
  const winLabel = w === 'wolves' ? 'I LUPI hanno vinto! 🐺' : 'IL VILLAGGIO ha vinto! 🌾';
  const g = state.gm || {};
  return `
    <div class="fade-in">
      <div class="winner-box ${w}"><h2>${winLabel}</h2></div>
      <div class="card"><div class="h-sub">Ruoli finali:</div><ul class="reveal-list">${(g.players||[]).map(x => { const r = ROLES[x.role]; return `<li><span class="r-emoji">${r?r.emoji:'❓'}</span><span class="r-name">${esc(x.name)}</span><span class="r-role" style="color:${r?r.color:'#fff'}">${x.alive ? (r?r.name:'?') : '💀 '+ (r?r.name:'?')}</span></li>`; }).join('')}</ul></div>
      <button class="btn big mt12" id="restart-btn">🔄 Ricomincia</button>
    </div>`;
}

/* ============ BINDING ============ */
function bind() {
  const btn = id => $(id);
  // join
  let jb = btn('join-btn');
  // config both
  document.querySelectorAll('[data-cfg]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.cfg;
      const cfg = localCfg();
      const n = state.players.filter(p => !p.isGM).length;
      const maxWolves = Math.max(1, Math.floor(n / 2));
      let v = (cfg[k] || 0) + (parseInt(b.dataset.d) || 0);
      if (k === 'wolves') v = Math.min(Math.max(v, 1), maxWolves);
      else v = Math.min(Math.max(v, 0), n);
      cfg[k] = v;
      saveCfg(cfg);
      // re-render
      render();
    };
  });
  document.querySelectorAll('[data-toggle]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.toggle;
      const cfg = localCfg();
      cfg[k] = !cfg[k];
      saveCfg(cfg);
      render();
    };
  });
  let st = btn('start-btn');
  if (st) st.onclick = () => {
    const cfg = localCfg();
    const wolves = cfg.wolves || 1;
    send({ type: 'gm', action: 'start', config: { wolves, seer: !!cfg.seer, protector: !!cfg.protector, puttana: !!cfg.puttana } });
  };

  let nt = btn('night-btn');
  if (nt) nt.onclick = () => send({ type: 'gm', action: 'night' });

  document.querySelectorAll('[data-wake]').forEach(b => {
    b.onclick = () => send({ type: 'gm', action: 'wake', group: b.dataset.wake });
  });
  let sl = btn('sleep-btn');
  if (sl) sl.onclick = () => send({ type: 'gm', action: 'sleep' });
  let db = btn('dawn-btn');
  if (db) db.onclick = () => send({ type: 'gm', action: 'dawn' });

  let ab = btn('announce-btn');
  if (ab) ab.onclick = () => send({ type: 'gm', action: 'announce' });

  let vb = btn('voting-btn');
  if (vb) vb.onclick = () => send({ type: 'gm', action: 'openVoting' });

  let cv = btn('close-voting');
  if (cv) cv.onclick = () => send({ type: 'gm', action: 'closeVoting' });

  // pick lists (target selection)
  let pl = btn('pick-list');
  if (pl) pl.querySelectorAll('[data-tid]').forEach(li => {
    li.onclick = () => {
      selTarget = Number(li.dataset.tid);
      maybeEnableVote();
      pl.querySelectorAll('[data-tid]').forEach(x => { x.classList.remove('sel'); x.querySelector('.check').textContent = ''; });
      li.classList.add('sel');
      li.querySelector('.check').textContent = '✅';
    };
  });

  let vbtn = btn('vote-btn');
  if (vbtn) vbtn.onclick = () => { if (selTarget) send({ type: 'vote', target: selTarget }); };

  function maybeEnableVote() {
    const vb2 = btn('vote-btn');
    if (vb2) vb2.disabled = !selTarget;
  }

  // night action confirm
  let ackb = btn('ack-btn');
  if (ackb) ackb.onclick = () => send({ type: 'ack' });

  let seerok = btn('seer-ok');
  if (seerok) seerok.onclick = () => { seerResult = null; selTarget = null; render(); };

  let homb = btn('home-btn');
  if (homb) homb.onclick = () => { send({ type: 'night', home: true }); render(); };

  // night: seleziona bersaglio dell'azione quando myTurn
  // usa pick-list ma con azione 'night'
  if (pl && state.phase === 'night' && state.night && state.night.myTurn) {
    pl.querySelectorAll('[data-tid]').forEach(li => {
      li.onclick = () => {
        const tid = Number(li.dataset.tid);
        const step = state.night.step;
        // invia l'azione corretta
        if (step === 'wolves' && state.you.role === 'wolf') send({ type: 'night', target: tid });
        else if (step === 'seer' && state.you.role === 'seer') send({ type: 'night', target: tid });
        else if (step === 'protector' && state.you.role === 'protector') send({ type: 'night', target: tid });
        else if (step === 'puttana' && state.you.role === 'puttana') send({ type: 'night', target: tid });
        selTarget = tid;
        // ristampiamo con il pick selezionato
        render();
      };
    });
  }

  // wolf target picker (GM)
  document.querySelectorAll('[data-wolf-target]').forEach(li => {
    li.onclick = () => {
      const tid = Number(li.dataset.wolfTarget);
      send({ type: 'gm', action: 'setWolfTarget', target: tid });
    };
  });
  let cw = btn('confirm-wolf');
  if (cw) cw.onclick = () => { send({ type: 'gm', action: 'sleep' }); };

  // burn pick (GM)
  document.querySelectorAll('[data-burn]').forEach(li => {
    li.onclick = () => {
      selBurn = Number(li.dataset.burn);
      document.querySelectorAll('[data-burn]').forEach(x => x.querySelector('.check').textContent = '');
      li.querySelector('.check').textContent = '🔥';
      const bbtn = btn('burn-btn');
      if (bbtn) bbtn.disabled = false;
    };
  });
  let bb = btn('burn-btn');
  if (bb) bb.onclick = () => { if (selBurn) send({ type: 'gm', action: 'burn', target: selBurn }); };

  let nn = btn('next-night-btn');
  if (nn) nn.onclick = () => send({ type: 'gm', action: 'nextNight' });

  let rb = btn('restart-btn');
  if (rb) rb.onclick = () => send({ type: 'gm', action: 'restart' });
}

function localCfg() {
  if (!cfg) cfg = defaultCfg();
  return cfg;
}
let cfg = null;
try { const raw = LS.get('lupus_cfg'); cfg = raw ? JSON.parse(raw) : null; } catch (e) { cfg = null; }
function defaultCfg() {
  const n = state.players.filter(p => !p.isGM).length;
  let wolves = 1; if (n >= 5) wolves = 2; if (n >= 8) wolves = 3; if (n >= 11) wolves = 4;
  wolves = Math.min(wolves, Math.max(1, Math.floor(n / 2)));
  return { wolves, seer: n >= 4, protector: n >= 5, puttana: n >= 7 };
}
function saveCfg(c) { cfg = c; LS.set('lupus_cfg', JSON.stringify(c)); }

connect();
render();