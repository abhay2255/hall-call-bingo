const socket = io();

const REACTION_EMOJI = ['👍', '😂', '🔥', '😱', '🎉', '😭'];

const state = {
  name: '',
  code: '',
  gridSize: 5,
  maxPlayers: 3,
  winPattern: 'lines',
  speedSeconds: 0,
  isHost: false,
  board: null,
  markedSet: new Set(), // "r-c" of cells marked locally
  calledNumbers: [],
  myId: null,
  myTurn: false,
  powerups: { peek: true, skip: true, swap: true },
  players: [],
  soundOn: true,
  timerInterval: null,
};

// ---------- Sound & voice ----------
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function playDing() {
  if (!state.soundOn) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
}

function speakNumber(number) {
  if (!state.soundOn) return;
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(`Number ${number}!`);
  utter.rate = 1.1;
  utter.pitch = 1.05;
  window.speechSynthesis.speak(utter);
}

document.getElementById('btn-sound-toggle').addEventListener('click', () => {
  state.soundOn = !state.soundOn;
  document.getElementById('btn-sound-toggle').textContent = state.soundOn ? '🔊' : '🔇';
  if (!state.soundOn && window.speechSynthesis) window.speechSynthesis.cancel();
});

// ---------- Screen helpers ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---------- Landing: tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('grid-size-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#grid-size-picker .chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.gridSize = Number(btn.dataset.size);
});

document.getElementById('max-players-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#max-players-picker .chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.maxPlayers = Number(btn.dataset.players);
});

document.getElementById('win-pattern-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#win-pattern-picker .chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.winPattern = btn.dataset.pattern;
});

document.getElementById('speed-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#speed-picker .chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  state.speedSeconds = Number(btn.dataset.speed);
});

// ---------- Create / Join ----------
document.getElementById('btn-create-room').addEventListener('click', () => {
  const name = document.getElementById('create-name').value.trim() || 'Player';
  state.name = name;
  socket.emit('create-room', {
    name,
    gridSize: state.gridSize,
    maxPlayers: state.maxPlayers,
    winPattern: state.winPattern,
    speedSeconds: state.speedSeconds,
  }, (res) => {
    if (!res.ok) {
      document.getElementById('create-error').textContent = res.error || 'Could not create room.';
      return;
    }
    state.code = res.room.code;
    state.isHost = true;
    renderLobby(res.room);
    showScreen('screen-lobby');
  });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  const name = document.getElementById('join-name').value.trim() || 'Player';
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  state.name = name;
  socket.emit('join-room', { name, code }, (res) => {
    if (!res.ok) {
      document.getElementById('join-error').textContent = res.error || 'Could not join room.';
      return;
    }
    state.code = res.room.code;
    state.gridSize = res.room.gridSize;
    state.isHost = res.room.hostId === socket.id;
    renderLobby(res.room);
    showScreen('screen-lobby');
  });
});

// ---------- Lobby ----------
const PATTERN_LABELS = {
  lines: 'Classic — 5 Lines',
  corners: 'Four Corners',
  x: 'X Marks the Spot',
  blackout: 'Blackout',
};

function renderLobby(room) {
  state.gridSize = room.gridSize;
  state.winPattern = room.winPattern || 'lines';
  state.speedSeconds = room.speedSeconds || 0;
  document.getElementById('lobby-code').textContent = room.code;
  document.getElementById('lobby-size').textContent = `${room.gridSize}×${room.gridSize} board · up to ${room.maxPlayers} players`;
  const speedLabel = state.speedSeconds ? `${state.speedSeconds}s per turn` : 'no timer';
  document.getElementById('lobby-settings').textContent =
    `${PATTERN_LABELS[state.winPattern] || 'Classic'} · ${speedLabel}` + (room.round > 1 ? ` · Round ${room.round}` : '');
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    li.appendChild(dot);
    li.appendChild(document.createTextNode(p.name));
    if (p.matchWins) {
      const wins = document.createElement('span');
      wins.className = 'series-tag';
      wins.textContent = `${p.matchWins} win${p.matchWins === 1 ? '' : 's'}`;
      li.appendChild(wins);
    }
    if (p.id === room.hostId) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'HOST';
      li.appendChild(tag);
    }
    list.appendChild(li);
  });
  state.isHost = room.hostId === socket.id;
  const startBtn = document.getElementById('btn-start-game');
  const hint = document.getElementById('lobby-hint');
  if (state.isHost) {
    startBtn.classList.remove('hidden');
    startBtn.textContent = room.round > 1 ? 'Start Next Round' : 'Start Game';
    hint.textContent = room.players.length < 2
      ? 'Share the room code. You can start solo to test, or wait for friends.'
      : 'Everyone in? Start whenever you\'re ready.';
  } else {
    startBtn.classList.add('hidden');
    hint.textContent = 'Waiting for the host to start the game…';
  }
}

document.getElementById('btn-start-game').addEventListener('click', () => {
  socket.emit('start-game', { code: state.code });
});

document.getElementById('btn-leave-lobby').addEventListener('click', () => {
  socket.emit('leave-room', { code: state.code });
  showScreen('screen-landing');
});

socket.on('lobby-update', (room) => {
  if (room.code !== state.code) return;
  renderLobby(room);
});

socket.on('returned-to-lobby', () => {
  document.getElementById('overlay-win').classList.add('hidden');
  showScreen('screen-lobby');
});

// ---------- Game ----------
socket.on('game-started', ({ gridSize, board, winPattern, speedSeconds, players, powerups }) => {
  state.gridSize = gridSize;
  state.board = board;
  state.winPattern = winPattern;
  state.speedSeconds = speedSeconds;
  state.markedSet = new Set();
  state.calledNumbers = [];
  state.myTurn = false;
  state.players = players;
  state.powerups = powerups;
  document.getElementById('game-code').textContent = state.code;
  document.getElementById('ball-current').textContent = '—';
  document.getElementById('ball-trail').innerHTML = '';
  document.getElementById('turn-indicator').textContent = '—';
  document.getElementById('turn-indicator').classList.remove('my-turn');
  document.querySelectorAll('#bingo-letters span').forEach((s) => s.classList.remove('lit'));

  const showLetters = winPattern === 'lines';
  document.getElementById('bingo-letters').classList.toggle('hidden', !showLetters);
  document.getElementById('progress-bar-wrap').classList.toggle('hidden', showLetters);
  setProgressBar(0, patternTotal(winPattern, gridSize));

  buildBoard();
  document.getElementById('board').classList.add('board-disabled');
  renderScoreboard(players);
  renderPowerupButtons();
  document.getElementById('timer-bar-wrap').classList.toggle('hidden', !speedSeconds);
  showScreen('screen-game');
});

function patternTotal(pattern, n) {
  if (pattern === 'corners') return 4;
  if (pattern === 'x') return n % 2 === 0 ? 2 * n : 2 * n - 1;
  if (pattern === 'blackout') return n * n;
  return 5; // lines
}

function patternCellsClient(pattern, n) {
  if (pattern === 'corners') return [[0, 0], [0, n - 1], [n - 1, 0], [n - 1, n - 1]];
  if (pattern === 'x') {
    const seen = new Set(); const cells = [];
    for (let i = 0; i < n; i++) {
      for (const [r, c] of [[i, i], [i, n - 1 - i]]) {
        const key = `${r},${c}`;
        if (!seen.has(key)) { seen.add(key); cells.push([r, c]); }
      }
    }
    return cells;
  }
  if (pattern === 'blackout') {
    const cells = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) cells.push([r, c]);
    return cells;
  }
  return [];
}

function setProgressBar(done, total) {
  const wrap = document.getElementById('progress-bar-wrap');
  if (wrap.classList.contains('hidden')) return;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${done} / ${total}`;
}

function renderScoreboard(players) {
  const list = document.getElementById('scoreboard-list');
  list.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.dataset.playerId = p.id;
    if (p.id === socket.id) li.classList.add('is-you');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    li.appendChild(dot);
    li.appendChild(document.createTextNode(p.name + (p.id === socket.id ? ' (you)' : '')));
    if (p.matchWins) {
      const wins = document.createElement('span');
      wins.className = 'series-tag';
      wins.textContent = `${p.matchWins}`;
      li.appendChild(wins);
    }
    list.appendChild(li);
  });
}

function buildBoard() {
  const boardEl = document.getElementById('board');
  boardEl.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;
  boardEl.innerHTML = '';
  const patternCells = state.winPattern === 'lines' ? [] : patternCellsClient(state.winPattern, state.gridSize);
  const patternSet = new Set(patternCells.map(([r, c]) => `${r}-${c}`));
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (patternSet.has(`${r}-${c}`)) cell.classList.add('pattern-target');
      cell.textContent = state.board[r][c];
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.addEventListener('click', () => onCellClick(r, c));
      boardEl.appendChild(cell);
    }
  }
}

function onCellClick(r, c) {
  if (!state.myTurn) return; // not your turn — wait for it
  const key = `${r}-${c}`;
  if (state.markedSet.has(key)) return; // already daubed
  state.markedSet.add(key);
  const cellEl = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
  if (cellEl) {
    cellEl.classList.add('marked');
    cellEl.classList.remove('called-not-marked');
  }
  // Clicking your own board both calls the number (if it hasn't been
  // called yet) and daubs it for you, in one action.
  socket.emit('select-cell', { code: state.code, row: r, col: c });
}

// ---------- Turn timer ----------
function stopTimerUI() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function startTimerUI(deadline, totalSeconds) {
  stopTimerUI();
  if (!deadline || !totalSeconds) {
    document.getElementById('timer-bar-wrap').classList.add('hidden');
    return;
  }
  document.getElementById('timer-bar-wrap').classList.remove('hidden');
  const bar = document.getElementById('timer-bar');
  const tick = () => {
    const remaining = Math.max(0, deadline - Date.now());
    const pct = Math.max(0, Math.min(100, (remaining / (totalSeconds * 1000)) * 100));
    bar.style.width = `${pct}%`;
    bar.classList.toggle('timer-warning', pct < 30);
    if (remaining <= 0) stopTimerUI();
  };
  tick();
  state.timerInterval = setInterval(tick, 100);
}

socket.on('turn-update', ({ currentPlayerId, currentPlayerName, speedSeconds, turnDeadline }) => {
  state.myTurn = currentPlayerId === socket.id;
  const indicator = document.getElementById('turn-indicator');
  const boardEl = document.getElementById('board');
  if (state.myTurn) {
    indicator.textContent = "Your turn — tap a number on your board.";
    indicator.classList.add('my-turn');
    boardEl.classList.remove('board-disabled');
  } else {
    indicator.textContent = `Waiting for ${currentPlayerName || 'the next player'}'s turn…`;
    indicator.classList.remove('my-turn');
    boardEl.classList.add('board-disabled');
  }
  document.querySelectorAll('#scoreboard-list li').forEach((li) => {
    li.classList.toggle('active-turn', li.dataset.playerId === currentPlayerId);
  });
  startTimerUI(turnDeadline, speedSeconds);
  renderPowerupButtons();
});

socket.on('turn-timeout', ({ playerName }) => {
  showToast(`⏱️ ${playerName} ran out of time — turn skipped!`);
});

socket.on('number-called', ({ number, calledNumbers }) => {
  state.calledNumbers = calledNumbers;
  document.getElementById('ball-current').textContent = number;
  playDing();
  speakNumber(number);

  // restart drop animation
  const ballEl = document.getElementById('ball-current');
  ballEl.classList.remove('ball-current');
  void ballEl.offsetWidth;
  ballEl.classList.add('ball-current');

  const trail = document.getElementById('ball-trail');
  const mini = document.createElement('span');
  mini.className = 'mini';
  mini.textContent = number;
  trail.prepend(mini);
  while (trail.children.length > 8) trail.removeChild(trail.lastChild);

  // Colour in the matching cell on MY board right away — calling a number
  // marks it for everyone who has it, not just whoever called it.
  document.querySelectorAll('.cell').forEach((cellEl) => {
    if (Number(cellEl.textContent) === number && !cellEl.classList.contains('marked')) {
      cellEl.classList.add('marked');
      cellEl.classList.remove('called-not-marked');
      state.markedSet.add(`${cellEl.dataset.row}-${cellEl.dataset.col}`);
    }
  });
});

socket.on('own-progress', ({ letters, lines, progress, powerups }) => {
  if (letters) {
    letters.forEach((on, i) => {
      const el = document.querySelectorAll('#bingo-letters span')[i];
      if (el) el.classList.toggle('lit', on);
    });
  }
  if (progress) setProgressBar(progress.done, progress.total);
  if (powerups) { state.powerups = powerups; renderPowerupButtons(); }
});

socket.on('game-over', ({ winner, winnerId, draw, seriesScores }) => {
  stopTimerUI();
  const overlay = document.getElementById('overlay-win');
  const title = document.getElementById('win-title');
  const msg = document.getElementById('win-message');
  if (draw) {
    title.textContent = 'FULL HOUSE — NO WINNER';
    msg.textContent = 'Every number was called and nobody completed the pattern. Rack \'em up again!';
  } else if (winnerId === socket.id) {
    title.textContent = 'BINGO! YOU WIN 🎉';
    msg.textContent = 'You completed the pattern first.';
  } else {
    title.textContent = 'BINGO!';
    msg.textContent = `${winner} completed the pattern first.`;
  }
  const seriesEl = document.getElementById('win-series-score');
  if (seriesScores && seriesScores.length) {
    seriesEl.textContent = 'Series: ' + seriesScores.map((p) => `${p.name} ${p.matchWins}`).join(' · ');
  } else {
    seriesEl.textContent = '';
  }
  overlay.classList.remove('hidden');
});

document.getElementById('btn-rematch').addEventListener('click', () => {
  document.getElementById('overlay-win').classList.add('hidden');
  socket.emit('return-to-lobby', { code: state.code });
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  document.getElementById('overlay-win').classList.add('hidden');
  socket.emit('leave-room', { code: state.code });
  showScreen('screen-landing');
});

// ---------- Power-ups ----------
function renderPowerupButtons() {
  ['peek', 'skip', 'swap'].forEach((type) => {
    const btn = document.getElementById(`btn-powerup-${type}`);
    const available = state.powerups && state.powerups[type];
    btn.disabled = !available || !state.myTurn;
    btn.classList.toggle('used', !available);
  });
}

document.getElementById('btn-powerup-peek').addEventListener('click', () => {
  if (!state.myTurn || !state.powerups.peek) return;
  socket.emit('use-powerup', { code: state.code, type: 'peek' });
});

document.getElementById('btn-powerup-skip').addEventListener('click', () => {
  if (!state.myTurn || !state.powerups.skip) return;
  socket.emit('use-powerup', { code: state.code, type: 'skip' });
});

document.getElementById('btn-powerup-swap').addEventListener('click', () => {
  if (!state.myTurn || !state.powerups.swap) return;
  const others = state.players.filter((p) => p.id !== socket.id);
  if (!others.length) return;
  const list = document.getElementById('swap-target-list');
  list.innerHTML = '';
  others.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'swap-target';
    li.textContent = p.name;
    li.addEventListener('click', () => {
      document.getElementById('overlay-swap-picker').classList.add('hidden');
      socket.emit('use-powerup', { code: state.code, type: 'swap', targetId: p.id });
    });
    list.appendChild(li);
  });
  document.getElementById('overlay-swap-picker').classList.remove('hidden');
});

document.getElementById('btn-cancel-swap').addEventListener('click', () => {
  document.getElementById('overlay-swap-picker').classList.add('hidden');
});

socket.on('peek-result', ({ reveals, powerups }) => {
  state.powerups = powerups;
  renderPowerupButtons();
  if (!reveals.length) {
    showToast('👀 No unmarked numbers left to peek at!');
    return;
  }
  const text = reveals.map((r) => `${r.opponentName} has ${r.number}`).join(' · ');
  showToast(`👀 Peek: ${text}`);
});

socket.on('board-swapped', ({ board, letters, lines, progress, powerups }) => {
  state.board = board;
  state.powerups = powerups;
  // Rebuild marked set from board: a cell is marked if its number has
  // already been called this game.
  state.markedSet = new Set();
  buildBoard();
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      if (state.calledNumbers.includes(board[r][c])) {
        state.markedSet.add(`${r}-${c}`);
        const cellEl = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
        if (cellEl) cellEl.classList.add('marked');
      }
    }
  }
  if (letters) {
    letters.forEach((on, i) => {
      const el = document.querySelectorAll('#bingo-letters span')[i];
      if (el) el.classList.toggle('lit', on);
    });
  }
  if (progress) setProgressBar(progress.done, progress.total);
  document.getElementById('board').classList.toggle('board-disabled', !state.myTurn);
  renderPowerupButtons();
  showToast('🔀 Your board was swapped!');
});

socket.on('powerup-used', ({ type, byName, targetName }) => {
  if (type === 'peek') showToast(`👀 ${byName} used Peek.`);
  else if (type === 'skip') showToast(`⏭️ ${byName} skipped ${targetName || 'the next player'}'s turn!`);
  else if (type === 'swap') showToast(`🔀 ${byName} swapped boards with ${targetName}!`);
});

// ---------- Reactions ----------
document.getElementById('reaction-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn) return;
  socket.emit('send-reaction', { code: state.code, emoji: btn.dataset.emoji });
});

socket.on('reaction', ({ playerName, emoji }) => {
  showFloatingReaction(playerName, emoji);
});

function showFloatingReaction(playerName, emoji) {
  const container = document.getElementById('reaction-toasts');
  const bubble = document.createElement('div');
  bubble.className = 'reaction-bubble';
  bubble.innerHTML = `<span class="reaction-emoji">${emoji}</span><span class="reaction-name">${playerName}</span>`;
  bubble.style.left = `${10 + Math.random() * 70}%`;
  container.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2200);
}

function showToast(text) {
  const container = document.getElementById('reaction-toasts');
  const toast = document.createElement('div');
  toast.className = 'info-toast';
  toast.textContent = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
