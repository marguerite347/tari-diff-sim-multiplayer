'use strict';

/**
 * BLOCK RACE — arcade multiplayer client.
 * Lanes, sliders, scores, streaks, victory screen.
 */
const Multiplayer = (function () {
  const ALGO_NAMES = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
  const LANE_BLOCK_LIMIT = 6;
  const SLIDER_MAX = 300;

  let ws = null;
  let playerId = null;
  let roomState = null;
  let statusMessage = '';
  let toastTimer = null;
  const penaltyTimers = [null, null, null, null];

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    setConnStatus('Connecting…');
    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', () => setConnStatus('Connected'));
    ws.addEventListener('close', () => {
      setConnStatus('Disconnected — retrying…');
      ws = null;
      setTimeout(connect, 1200);
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg);
    });
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'hello':
        playerId = msg.playerId;
        maybeAutoJoin();
        break;
      case 'room_state':
        roomState = msg;
        render();
        if (msg.roundOver) showVictory(msg);
        break;
      case 'block_mined':
        if (!roomState) return;
        roomState.recentBlocks = [...(roomState.recentBlocks || []), msg.block].slice(-40);
        roomState.height = msg.block.height;
        roomState.totals = msg.totals;
        if (msg.leaderboard) roomState.players = msg.leaderboard;
        if (msg.goalBlocks) roomState.goalBlocks = msg.goalBlocks;
        document.getElementById('mpHeight').textContent = String(msg.block.height);
        dropLaneBlock(msg.block);
        prependBlock(msg.block);
        renderLeaderboard();
        renderRaceTrack();
        renderLanePower();
        updateLiveStats();
        celebrateBlock(msg.block);
        break;
      case 'round_over':
        if (roomState) {
          roomState.roundOver = true;
          roomState.winnerId = msg.winnerId;
          roomState.running = false;
          if (msg.leaderboard) roomState.players = msg.leaderboard;
        }
        showVictory({
          winnerId: msg.winnerId,
          players: msg.leaderboard,
          you: roomState?.you,
          goalBlocks: msg.goalBlocks,
        }, msg.winnerName);
        render();
        break;
      case 'status':
        statusMessage = msg.message || '';
        if (typeof msg.running === 'boolean' && roomState) roomState.running = msg.running;
        renderStatus();
        renderStatusLamp();
        break;
      case 'error':
        statusMessage = msg.error || 'Error';
        renderStatus();
        showToast(statusMessage, 'warn');
        break;
      case 'left':
        roomState = null;
        hideVictory();
        render();
        break;
      default:
        break;
    }
  }

  function maybeAutoJoin() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room && !roomState) {
      const nameInput = document.getElementById('mpName');
      const roomInput = document.getElementById('mpRoomCode');
      if (roomInput) roomInput.value = room.toUpperCase();
      send({ type: 'join_room', room, name: nameInput?.value || 'Miner' });
    }
  }

  function init() {
    document.getElementById('mpCreate')?.addEventListener('click', () => {
      send({ type: 'create_room', name: document.getElementById('mpName')?.value || 'Host' });
    });
    document.getElementById('mpJoin')?.addEventListener('click', () => {
      send({
        type: 'join_room',
        room: document.getElementById('mpRoomCode')?.value || '',
        name: document.getElementById('mpName')?.value || 'Miner',
      });
    });
    document.getElementById('mpStart')?.addEventListener('click', () => send({ type: 'start' }));
    document.getElementById('mpStop')?.addEventListener('click', () => send({ type: 'stop' }));
    document.getElementById('mpReset')?.addEventListener('click', () => {
      hideVictory();
      clearLanes();
      send({ type: 'reset' });
    });
    document.getElementById('mpLeave')?.addEventListener('click', () => {
      hideVictory();
      send({ type: 'leave' });
      history.replaceState({}, '', location.pathname);
    });
    document.getElementById('mpVictoryDismiss')?.addEventListener('click', hideVictory);

    document.getElementById('mpCopyLink')?.addEventListener('click', async () => {
      if (!roomState) return;
      const url = `${location.origin}/?room=${roomState.room}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast('INVITE LINK COPIED', 'good');
      } catch {
        showToast(url, 'good');
      }
    });

    for (let i = 0; i < 4; i++) {
      const slider = document.getElementById(`mpHr${i}`);
      slider?.addEventListener('input', () => updateSliderVisual(i));
      updateSliderVisual(i);
    }

    document.getElementById('mpApplyHashrate')?.addEventListener('click', () => {
      const hashrates = {};
      for (let i = 0; i < 4; i++) hashrates[i] = Number(document.getElementById(`mpHr${i}`)?.value || 0);
      send({ type: 'set_hashrates', hashrates });
      send({
        type: 'set_settings',
        settings: {
          penalty: document.getElementById('mpPenalty')?.checked ?? true,
          speedup: Number(document.getElementById('mpSpeedup')?.value || 60),
          windowSize: Number(document.getElementById('mpWindow')?.value || 45),
          goalBlocks: Number(document.getElementById('mpGoal')?.value || 20),
        },
      });
      showToast('LOADOUT LOCKED', 'good');
    });

    connect();
    render();
  }

  function updateSliderVisual(i) {
    const slider = document.getElementById(`mpHr${i}`);
    const out = document.getElementById(`mpHrVal${i}`);
    if (!slider) return;
    const value = Number(slider.value || 0);
    if (out) out.value = String(value);
    slider.style.setProperty('--fill', `${(value / SLIDER_MAX) * 100}%`);
  }

  function setConnStatus(text) {
    const el = document.getElementById('mpConnStatus');
    if (el) el.textContent = text;
    const el2 = document.getElementById('mpConnStatus2');
    if (el2) el2.textContent = text;
  }

  function renderStatus() {
    const el = document.getElementById('mpStatus');
    if (el) el.textContent = statusMessage ? `· ${statusMessage}` : '';
  }

  function renderStatusLamp() {
    const el = document.getElementById('mpRunning');
    if (!el || !roomState) return;
    if (roomState.roundOver) {
      el.textContent = 'ROUND OVER';
      el.className = 'mp-hud-value mp-status-lamp over';
    } else if (roomState.running) {
      el.textContent = 'LIVE';
      el.className = 'mp-hud-value mp-status-lamp live';
    } else {
      el.textContent = 'PAUSED';
      el.className = 'mp-hud-value mp-status-lamp';
    }
  }

  function showToast(text, kind = 'good') {
    const el = document.getElementById('mpToast');
    if (!el) return;
    el.hidden = false;
    el.className = `mp-toast ${kind}`;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
  }

  function celebrateBlock(block) {
    const mine = block.minerId && block.minerId === roomState?.you;
    if (mine) {
      const streak = block.minerStreak || 1;
      const pts = block.pointsEarned || 100;
      showToast(streak > 1 ? `BLOCK #${block.height} +${pts} · ${streak}X STREAK` : `BLOCK #${block.height} MINED +${pts}`, 'good');
      document.body.classList.add('mp-flash');
      setTimeout(() => document.body.classList.remove('mp-flash'), 280);
    }
    if (block.penaltyMultiplier > 1) flashLanePenalty(block.algo);
  }

  function flashLanePenalty(algo) {
    const el = document.getElementById(`mpLanePenalty${algo}`);
    if (!el) return;
    el.hidden = false;
    clearTimeout(penaltyTimers[algo]);
    penaltyTimers[algo] = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function dropLaneBlock(block) {
    const lane = document.getElementById(`mpLaneBlocks${block.algo}`);
    if (!lane) return;
    const mine = block.minerId && block.minerId === roomState?.you;
    const div = document.createElement('div');
    div.className = `mp-lane-block${mine ? ' mine' : ''}`;
    div.innerHTML = `<span>#${block.height}</span><span>${escapeHtml(shortName(block.minerName))}</span>`;
    lane.appendChild(div);
    requestAnimationFrame(() => div.classList.add('in'));
    while (lane.children.length > LANE_BLOCK_LIMIT) lane.removeChild(lane.firstChild);
  }

  function clearLanes() {
    for (let i = 0; i < 4; i++) {
      const lane = document.getElementById(`mpLaneBlocks${i}`);
      if (lane) lane.innerHTML = '';
    }
  }

  function rebuildLanes() {
    clearLanes();
    const blocks = (roomState?.recentBlocks || []).slice(-24);
    for (const block of blocks) {
      const lane = document.getElementById(`mpLaneBlocks${block.algo}`);
      if (!lane) continue;
      const mine = block.minerId && block.minerId === roomState?.you;
      const div = document.createElement('div');
      div.className = `mp-lane-block in${mine ? ' mine' : ''}`;
      div.innerHTML = `<span>#${block.height}</span><span>${escapeHtml(shortName(block.minerName))}</span>`;
      lane.appendChild(div);
      while (lane.children.length > LANE_BLOCK_LIMIT) lane.removeChild(lane.firstChild);
    }
  }

  function renderLanePower() {
    if (!roomState) return;
    const totals = roomState.totals || {};
    const max = Math.max(1, ...[0, 1, 2, 3].map((i) => Number(totals[i] || 0)));
    for (let i = 0; i < 4; i++) {
      const bar = document.getElementById(`mpLanePower${i}`);
      if (bar) bar.style.width = `${Math.round((Number(totals[i] || 0) / max) * 100)}%`;
    }
  }

  function showVictory(state, winnerName) {
    const overlay = document.getElementById('mpVictory');
    if (!overlay) return;
    const youWin = state.winnerId && state.winnerId === (state.you || roomState?.you);
    const name = winnerName || state.players?.find((p) => p.id === state.winnerId)?.name || 'Someone';
    document.getElementById('mpVictoryTitle').textContent = youWin ? 'YOU WIN!' : `${name.toUpperCase()} WINS`;
    document.getElementById('mpVictorySub').textContent = `First to ${state.goalBlocks || roomState?.goalBlocks || 20} blocks. Hit New round to rematch.`;
    overlay.hidden = false;
  }

  function hideVictory() {
    const overlay = document.getElementById('mpVictory');
    if (overlay) overlay.hidden = true;
  }

  function render() {
    const lobby = document.getElementById('mpLobby');
    const session = document.getElementById('mpSession');
    if (!lobby || !session) return;

    const inRoom = Boolean(roomState?.room);
    lobby.style.display = inRoom ? 'none' : 'block';
    session.style.display = inRoom ? 'block' : 'none';
    renderStatus();
    if (!inRoom) return;

    const isHost = roomState.hostId === roomState.you;
    document.getElementById('mpRoomLabel').textContent = roomState.room;
    document.getElementById('mpShareLink').textContent = `${location.origin}/?room=${roomState.room}`;
    renderStatusLamp();
    document.getElementById('mpHeight').textContent = String(roomState.height || 0);
    document.getElementById('mpHostControls').style.opacity = isHost ? '1' : '0.45';
    document.getElementById('mpPenalty').checked = !!roomState.penalty;
    document.getElementById('mpSpeedup').value = roomState.speedup;
    document.getElementById('mpWindow').value = roomState.windowSize;
    document.getElementById('mpGoal').value = roomState.goalBlocks || 20;
    document.getElementById('mpGoalLabel').textContent = String(roomState.goalBlocks || 20);

    const me = roomState.players.find((p) => p.id === roomState.you);
    if (me) {
      for (let i = 0; i < 4; i++) {
        const el = document.getElementById(`mpHr${i}`);
        if (el && document.activeElement !== el) {
          el.value = Math.min(SLIDER_MAX, me.hashrates[i] || 0);
          updateSliderVisual(i);
        }
      }
      document.getElementById('mpMyStreak').textContent = String(me.streak || 0);
    }

    renderLeaderboard();
    renderRaceTrack();
    renderLanePower();
    rebuildLanes();

    const feed = document.getElementById('mpBlockFeed');
    feed.innerHTML = (roomState.recentBlocks || []).slice().reverse().map(blockCard).join('') ||
      '<div class="dim mp-feed-empty">Waiting for kickoff — host hits Start.</div>';

    history.replaceState({}, '', `/?room=${roomState.room}`);
    updateLiveStats();
  }

  function renderLeaderboard() {
    const el = document.getElementById('mpLeaderboard');
    if (!el || !roomState) return;
    const players = roomState.players || [];
    const maxScore = Math.max(1, ...players.map((p) => p.score || 0));

    el.innerHTML = players.map((p, index) => {
      const pct = Math.round(((p.score || 0) / maxScore) * 100);
      const you = p.id === roomState.you;
      return `<div class="mp-lb-row ${you ? 'you' : ''} ${p.connected ? '' : 'dim'}">
        <div class="mp-lb-head">
          <span class="mp-rank">${index + 1}${['ST', 'ND', 'RD'][index] || 'TH'}</span>
          <strong>${escapeHtml(p.name)}</strong>
          ${you ? '<span class="mp-pill accent">you</span>' : ''}
          ${p.isHost ? '<span class="mp-pill">host</span>' : ''}
          <span class="mp-lb-score">${p.score || 0}</span>
        </div>
        <div class="mp-lb-bar"><div style="width:${pct}%"></div></div>
        <div class="mp-lb-meta">${p.blocksMined || 0} blocks · best streak ${p.bestStreak || 0}</div>
      </div>`;
    }).join('') || '<div class="dim">No racers yet.</div>';
  }

  function renderRaceTrack() {
    const fill = document.getElementById('mpRaceFill');
    const lead = document.getElementById('mpRaceLead');
    if (!fill || !roomState) return;
    const goal = roomState.goalBlocks || 20;
    const top = (roomState.players || [])[0];
    const topBlocks = top?.blocksMined || 0;
    fill.style.width = `${Math.min(100, Math.round((topBlocks / goal) * 100))}%`;
    lead.textContent = top ? `${top.name} ${topBlocks}/${goal}` : `0/${goal}`;
  }

  function prependBlock(block) {
    const feed = document.getElementById('mpBlockFeed');
    if (!feed) return;
    const placeholder = feed.querySelector('.mp-feed-empty');
    if (placeholder) placeholder.remove();
    feed.insertAdjacentHTML('afterbegin', blockCard(block));
    const first = feed.firstElementChild;
    if (first) {
      first.classList.add('mp-block-enter');
      requestAnimationFrame(() => first.classList.add('mp-block-in'));
    }
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
  }

  function blockCard(block) {
    const laneColors = ['#ff4d5e', '#37b6ff', '#3dffa2', '#ffb640'];
    const color = laneColors[block.algo] || '#999';
    const mine = block.minerId && block.minerId === roomState?.you;
    const pts = block.pointsEarned ? ` +${block.pointsEarned}` : '';
    const streak = block.minerStreak > 1 ? ` ${block.minerStreak}x` : '';
    return `<div class="mp-block ${mine ? 'mine' : ''}" style="border-left-color:${color}">
      <div><strong>#${block.height}</strong> ${block.algoName}
        ${mine ? '<span class="mp-pill accent">you</span>' : ''}
        ${block.penaltyMultiplier > 1 ? `<span class="mp-pill warn">×${block.penaltyMultiplier}</span>` : ''}
      </div>
      <div class="dim">${escapeHtml(block.minerName || 'network')} · ${block.blockTime}s${pts}${streak}</div>
    </div>`;
  }

  function updateLiveStats() {
    const blocks = roomState?.recentBlocks || [];
    const meanEl = document.getElementById('mpStatMean');
    const splitEl = document.getElementById('mpStatSplit');
    if (!meanEl || !splitEl) return;
    if (!blocks.length) {
      meanEl.textContent = '—';
      splitEl.textContent = '—';
      return;
    }
    const mean = blocks.reduce((s, b) => s + b.blockTime, 0) / blocks.length;
    meanEl.textContent = `${mean.toFixed(1)}s`;
    const counts = [0, 0, 0, 0];
    for (const b of blocks) counts[b.algo] += 1;
    splitEl.textContent = counts.join(' / ');
  }

  function shortName(name) {
    if (!name) return 'net';
    return name.length > 8 ? `${name.slice(0, 7)}…` : name;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('mpCreate')) Multiplayer.init();
});
