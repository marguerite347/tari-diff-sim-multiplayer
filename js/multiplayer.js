'use strict';

/**
 * Multiplayer room client — join/create shared LWMA mining sims.
 */
const Multiplayer = (function () {
  const ALGO_NAMES = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
  const ALGO_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#e67e22'];

  let ws = null;
  let playerId = null;
  let roomState = null;
  let statusMessage = '';

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
        break;
      case 'block_mined':
        if (!roomState) return;
        roomState.recentBlocks = [...(roomState.recentBlocks || []), msg.block].slice(-40);
        roomState.height = msg.block.height;
        roomState.totals = msg.totals;
        prependBlock(msg.block);
        updateLiveStats();
        break;
      case 'status':
        statusMessage = msg.message || '';
        if (typeof msg.running === 'boolean' && roomState) roomState.running = msg.running;
        renderStatus();
        break;
      case 'error':
        statusMessage = msg.error || 'Error';
        renderStatus();
        break;
      case 'left':
        roomState = null;
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
    const createBtn = document.getElementById('mpCreate');
    const joinBtn = document.getElementById('mpJoin');
    const startBtn = document.getElementById('mpStart');
    const stopBtn = document.getElementById('mpStop');
    const resetBtn = document.getElementById('mpReset');
    const leaveBtn = document.getElementById('mpLeave');
    const copyBtn = document.getElementById('mpCopyLink');
    const applyHrBtn = document.getElementById('mpApplyHashrate');

    createBtn?.addEventListener('click', () => {
      const name = document.getElementById('mpName')?.value || 'Host';
      send({ type: 'create_room', name });
    });

    joinBtn?.addEventListener('click', () => {
      const name = document.getElementById('mpName')?.value || 'Miner';
      const room = document.getElementById('mpRoomCode')?.value || '';
      send({ type: 'join_room', room, name });
    });

    startBtn?.addEventListener('click', () => send({ type: 'start' }));
    stopBtn?.addEventListener('click', () => send({ type: 'stop' }));
    resetBtn?.addEventListener('click', () => send({ type: 'reset' }));
    leaveBtn?.addEventListener('click', () => {
      send({ type: 'leave' });
      history.replaceState({}, '', location.pathname);
    });

    copyBtn?.addEventListener('click', async () => {
      if (!roomState) return;
      const url = `${location.origin}/?room=${roomState.room}`;
      try {
        await navigator.clipboard.writeText(url);
        statusMessage = 'Share link copied';
      } catch {
        statusMessage = url;
      }
      renderStatus();
    });

    applyHrBtn?.addEventListener('click', () => {
      const hashrates = {};
      for (let i = 0; i < 4; i++) {
        const el = document.getElementById(`mpHr${i}`);
        hashrates[i] = Number(el?.value || 0);
      }
      send({ type: 'set_hashrates', hashrates });
      send({
        type: 'set_settings',
        settings: {
          penalty: document.getElementById('mpPenalty')?.checked ?? true,
          speedup: Number(document.getElementById('mpSpeedup')?.value || 60),
          windowSize: Number(document.getElementById('mpWindow')?.value || 45),
        },
      });
    });

    connect();
    render();
  }

  function setConnStatus(text) {
    const el = document.getElementById('mpConnStatus');
    if (el) el.textContent = text;
  }

  function renderStatus() {
    const el = document.getElementById('mpStatus');
    if (el) el.textContent = statusMessage || '';
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
    document.getElementById('mpRunning').textContent = roomState.running ? 'RUNNING' : 'PAUSED';
    document.getElementById('mpRunning').className = roomState.running ? 'mp-pill good' : 'mp-pill';
    document.getElementById('mpHeight').textContent = String(roomState.height || 0);
    document.getElementById('mpHostControls').style.opacity = isHost ? '1' : '0.45';
    document.getElementById('mpPenalty').checked = !!roomState.penalty;
    document.getElementById('mpSpeedup').value = roomState.speedup;
    document.getElementById('mpWindow').value = roomState.windowSize;

    const me = roomState.players.find((p) => p.id === roomState.you);
    if (me) {
      for (let i = 0; i < 4; i++) {
        const el = document.getElementById(`mpHr${i}`);
        if (el && document.activeElement !== el) el.value = me.hashrates[i] || 0;
      }
    }

    const playersEl = document.getElementById('mpPlayers');
    playersEl.innerHTML = roomState.players.map((p) => {
      const hr = ALGO_NAMES.map((name, i) => {
        const v = p.hashrates[i] || 0;
        if (!v) return null;
        return `<span class="mp-hr-chip" style="border-color:${ALGO_COLORS[i]}">${name}: ${formatHr(v)}</span>`;
      }).filter(Boolean).join(' ');
      return `<div class="mp-player ${p.connected ? '' : 'dim'}">
        <strong>${escapeHtml(p.name)}</strong>
        ${p.isHost ? '<span class="mp-pill">host</span>' : ''}
        ${p.id === roomState.you ? '<span class="mp-pill accent">you</span>' : ''}
        <div class="mp-hr-row">${hr || '<span class="dim">no hashrate</span>'}</div>
      </div>`;
    }).join('');

    const totalsEl = document.getElementById('mpTotals');
    totalsEl.innerHTML = ALGO_NAMES.map((name, i) =>
      `<div><span class="color-dot" style="background:${ALGO_COLORS[i]}"></span> ${name}: <strong>${formatHr(roomState.totals?.[i] || 0)}</strong></div>`
    ).join('');

    const feed = document.getElementById('mpBlockFeed');
    feed.innerHTML = (roomState.recentBlocks || []).slice().reverse().map(blockCard).join('') ||
      '<div class="dim">No blocks yet — host should press Start.</div>';

    history.replaceState({}, '', `/?room=${roomState.room}`);
    updateLiveStats();
  }

  function prependBlock(block) {
    const feed = document.getElementById('mpBlockFeed');
    if (!feed) return;
    const empty = feed.querySelector('.dim');
    if (empty) feed.innerHTML = '';
    feed.insertAdjacentHTML('afterbegin', blockCard(block));
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
  }

  function blockCard(block) {
    const color = ALGO_COLORS[block.algo] || '#999';
    return `<div class="mp-block" style="border-left-color:${color}">
      <div><strong>#${block.height}</strong> ${block.algoName}
        ${block.penaltyMultiplier > 1 ? `<span class="mp-pill warn">×${block.penaltyMultiplier} penalty</span>` : ''}
      </div>
      <div class="dim">BT ${block.blockTime}s · mined by ${escapeHtml(block.minerName || 'network')} · diff ${formatHr(block.difficulty)}</div>
    </div>`;
  }

  function updateLiveStats() {
    const blocks = roomState?.recentBlocks || [];
    if (!blocks.length) {
      document.getElementById('mpStatMean').textContent = '—';
      document.getElementById('mpStatSplit').textContent = '—';
      return;
    }
    const mean = blocks.reduce((s, b) => s + b.blockTime, 0) / blocks.length;
    document.getElementById('mpStatMean').textContent = `${mean.toFixed(1)}s`;
    const counts = [0, 0, 0, 0];
    for (const b of blocks) counts[b.algo] += 1;
    document.getElementById('mpStatSplit').textContent = counts.map((c, i) => `${ALGO_NAMES[i][0]}:${c}`).join(' ');
  }

  function formatHr(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
    return String(Math.round(n));
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
  // Defer until DOM from multiplayer tab exists.
  if (document.getElementById('mpCreate')) Multiplayer.init();
});
