'use strict';

/**
 * BLOCK RACE — arcade multiplayer client.
 * Lanes, sliders, scores, streaks, victory screen.
 */
const Multiplayer = (function () {
  const ALGO_NAMES = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
  const SLIDER_MAX = 300;

  let ws = null;
  let playerId = null;
  let roomState = null;
  let statusMessage = '';
  let toastTimer = null;

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
        if (msg.height === 0 && labHistory.heights.length) resetTelemetry();
        render();
        if (msg.roundOver) showVictory(msg);
        else hideVictory();
        break;
      case 'block_mined':
        if (!roomState) return;
        roomState.recentBlocks = [...(roomState.recentBlocks || []), msg.block].slice(-40);
        roomState.height = msg.block.height;
        roomState.totals = msg.totals;
        if (msg.leaderboard) roomState.players = msg.leaderboard;
        if (msg.goalBlocks) roomState.goalBlocks = msg.goalBlocks;
        document.getElementById('mpHeight').textContent = String(msg.block.height);
        updateBattlefield(msg.block);
        recordTelemetry(msg.block);
        prependBlock(msg.block);
        renderLeaderboard();
        renderRaceTrack();
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
      if (window.Battlefield) Battlefield.reset();
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

    const sendHashrates = () => {
      const hashrates = {};
      for (let i = 0; i < 4; i++) hashrates[i] = Number(document.getElementById(`mpHr${i}`)?.value || 0);
      send({ type: 'set_hashrates', hashrates });
    };

    for (let i = 0; i < 4; i++) {
      const slider = document.getElementById(`mpHr${i}`);
      slider?.addEventListener('input', () => updateSliderVisual(i));
      slider?.addEventListener('change', sendHashrates);
      updateSliderVisual(i);
    }

    document.getElementById('mpApplyHashrate')?.addEventListener('click', () => {
      sendHashrates();
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
    if (block.penaltyMultiplier > 1) {
      showToast(`TIP-004 PENALTY ON ${ALGO_NAMES[block.algo].toUpperCase()}`, 'bad');
    }
  }

  function ensureBattlefield() {
    const container = document.getElementById('mpBattlefield');
    if (!container || !window.Battlefield) return;
    Battlefield.init(container);
    Battlefield.onResize();
  }

  function updateBattlefield(block) {
    if (!window.Battlefield) return;
    if (roomState?.totals) Battlefield.setPowers(roomState.totals);
    if (block) Battlefield.blockMined(block);
    if (block?.telemetry) Battlefield.setTelemetry(block.telemetry);
    const heightEl = document.getElementById('mpBfHeight');
    if (heightEl) heightEl.textContent = `BLOCK ${roomState?.height || 0}`;
    const statusEl = document.getElementById('mpBfStatus');
    if (statusEl && roomState) {
      const top = (roomState.players || [])[0];
      if (roomState.roundOver) statusEl.textContent = 'ROUND OVER';
      else if (!roomState.running) statusEl.textContent = 'ARMIES ARE ASSEMBLING';
      else if (top) statusEl.textContent = `${top.name.toUpperCase()} IS WINNING — ${top.blocksMined}/${roomState.goalBlocks}`;
    }
  }

  // --- LWMA telemetry lab (difficulty + block time charts) ---
  const LAB_MAX_POINTS = 150;
  const LANE_HEX = ['#ff4d5e', '#37b6ff', '#3dffa2', '#ffb640'];
  const labHistory = { heights: [], diffs: [[], [], [], []], blockTimes: [], rollingBt: [], target: [] };
  let chartDiff = null;
  let chartBt = null;

  function resetTelemetry() {
    labHistory.heights.length = 0;
    labHistory.blockTimes.length = 0;
    labHistory.rollingBt.length = 0;
    labHistory.target.length = 0;
    for (const series of labHistory.diffs) series.length = 0;
    if (chartDiff) chartDiff.update('none');
    if (chartBt) chartBt.update('none');
  }

  function recordTelemetry(block) {
    if (!block?.telemetry) return;
    labHistory.heights.push(block.height);
    for (const entry of block.telemetry) {
      labHistory.diffs[entry.algo]?.push(Number(entry.difficulty));
    }
    labHistory.blockTimes.push(block.blockTime);
    labHistory.target.push(120);
    const window = labHistory.blockTimes.slice(-15);
    labHistory.rollingBt.push(window.reduce((a, b) => a + b, 0) / window.length);

    if (labHistory.heights.length > LAB_MAX_POINTS) {
      labHistory.heights.shift();
      labHistory.blockTimes.shift();
      labHistory.rollingBt.shift();
      labHistory.target.shift();
      for (const series of labHistory.diffs) series.shift();
    }

    ensureLabCharts();
    if (chartDiff) chartDiff.update('none');
    if (chartBt) chartBt.update('none');
    const windowLabel = document.getElementById('mpLabWindow');
    if (windowLabel && roomState) windowLabel.textContent = String(roomState.windowSize);
  }

  function ensureLabCharts() {
    if (chartDiff || typeof Chart === 'undefined') return;
    const diffCanvas = document.getElementById('mpChartDiff');
    const btCanvas = document.getElementById('mpChartBt');
    if (!diffCanvas || !btCanvas) return;

    const axisStyle = {
      ticks: { color: '#8ea0c0', font: { size: 10 } },
      grid: { color: 'rgba(120, 140, 190, 0.12)' },
    };
    const baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { labels: { color: '#c8d4ec', boxWidth: 10, font: { size: 10 } } },
      },
      scales: {
        x: { ...axisStyle, title: { display: true, text: 'height', color: '#8ea0c0', font: { size: 10 } } },
      },
    };

    chartDiff = new Chart(diffCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labHistory.heights,
        datasets: ALGO_NAMES.map((name, i) => ({
          label: name,
          data: labHistory.diffs[i],
          borderColor: LANE_HEX[i],
          backgroundColor: LANE_HEX[i],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.25,
        })),
      },
      options: {
        ...baseOpts,
        scales: {
          ...baseOpts.scales,
          y: { ...axisStyle, type: 'logarithmic', title: { display: true, text: 'target difficulty (log)', color: '#8ea0c0', font: { size: 10 } } },
        },
      },
    });

    chartBt = new Chart(btCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labHistory.heights,
        datasets: [
          {
            label: 'solve time',
            data: labHistory.blockTimes,
            borderColor: 'rgba(200, 212, 236, 0)',
            backgroundColor: 'rgba(200, 212, 236, 0.7)',
            pointRadius: 2,
            showLine: false,
          },
          {
            label: 'rolling mean (15)',
            data: labHistory.rollingBt,
            borderColor: '#3dffa2',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          },
          {
            label: 'target 120s',
            data: labHistory.target,
            borderColor: 'rgba(255, 182, 64, 0.9)',
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
          },
        ],
      },
      options: {
        ...baseOpts,
        scales: {
          ...baseOpts.scales,
          y: { ...axisStyle, title: { display: true, text: 'seconds (sim)', color: '#8ea0c0', font: { size: 10 } } },
        },
      },
    });
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
    ensureBattlefield();
    updateBattlefield(null);

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
