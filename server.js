const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const LETTERS = ['B', 'I', 'N', 'G', 'O'];
const WIN_PATTERNS = ['lines'];
const SPEED_OPTIONS = [0, 10, 15, 30]; // seconds; 0 = off
const BOARD_MODES = ['random', 'manual'];
const SETUP_SECONDS_OPTIONS = [120, 180]; // 2 or 3 minutes to fill your board manually
const REACTION_EMOJI = ['👍', '😂', '🔥', '😱', '🎉', '😭', '🌴', '💥'];
const POWERUP_TYPES = ['peek', 'skip', 'swap'];

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Record<string, Room>} */
const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffledNumbers(n) {
  const arr = Array.from({ length: n * n }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateBoard(n) {
  const flat = shuffledNumbers(n);
  const grid = [];
  for (let r = 0; r < n; r++) grid.push(flat.slice(r * n, r * n + n));
  return grid;
}

function emptyMarked(n) {
  return Array.from({ length: n }, () => Array(n).fill(false));
}

function freshPowerups() {
  return { peek: true, skip: true, swap: true };
}

function newPlayer(id, name) {
  return {
    id,
    name: (name || 'Player').slice(0, 16),
    board: null,
    marked: null,
    lines: 0,
    letters: [false, false, false, false, false],
    matchWins: 0,
    powerups: freshPowerups(),
    boardSubmitted: false,
    score: 0, // used by Grid Wars
  };
}

function lobbyState(room) {
  if (room.gameType === 'grid-wars') {
    return {
      code: room.code,
      gameType: 'grid-wars',
      boxSize: room.boxSize,
      maxPlayers: room.maxPlayers,
      hostId: room.hostId,
      started: room.started,
      round: room.round,
      players: room.players.map((p) => ({ id: p.id, name: p.name, ready: true, matchWins: p.matchWins })),
    };
  }
  return {
    code: room.code,
    gameType: 'bingo',
    gridSize: room.gridSize,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    started: room.started,
    winPattern: room.winPattern,
    speedSeconds: room.speedSeconds,
    boardMode: room.boardMode,
    setupSeconds: room.setupSeconds,
    round: room.round,
    players: room.players.map((p) => ({ id: p.id, name: p.name, ready: true, matchWins: p.matchWins })),
  };
}

function countLines(marked, n) {
  let lines = 0;
  for (let r = 0; r < n; r++) {
    let full = true;
    for (let c = 0; c < n; c++) if (!marked[r][c]) { full = false; break; }
    if (full) lines++;
  }
  for (let c = 0; c < n; c++) {
    let full = true;
    for (let r = 0; r < n; r++) if (!marked[r][c]) { full = false; break; }
    if (full) lines++;
  }
  let diag1 = true, diag2 = true;
  for (let i = 0; i < n; i++) {
    if (!marked[i][i]) diag1 = false;
    if (!marked[i][n - 1 - i]) diag2 = false;
  }
  if (diag1) lines++;
  if (diag2) lines++;
  return lines;
}

// Position-based cells for non-classic win patterns. These are the same
// coordinates for every player regardless of how their board is arranged.
function patternCells(pattern, n) {
  if (pattern === 'x') {
    const seen = new Set();
    const cells = [];
    for (let i = 0; i < n; i++) {
      for (const [r, c] of [[i, i], [i, n - 1 - i]]) {
        const key = `${r},${c}`;
        if (!seen.has(key)) { seen.add(key); cells.push([r, c]); }
      }
    }
    return cells;
  }
  return [];
}

// Recomputes a player's progress toward the room's win pattern, updates
// their stored fields, and returns a payload describing that progress.
function computeProgress(room, player) {
  const n = room.gridSize;
  if (room.winPattern === 'lines') {
    const lines = countLines(player.marked, n);
    player.lines = lines;
    const lit = Math.min(lines, LETTERS.length);
    player.letters = LETTERS.map((_, i) => i < lit);
    return { letters: player.letters, lines: player.lines, progress: { done: lit, total: LETTERS.length }, complete: lit >= LETTERS.length };
  }
  const cells = patternCells(room.winPattern, n);
  const done = cells.filter(([r, c]) => player.marked[r][c]).length;
  player.lines = done;
  player.letters = null;
  return { letters: null, lines: done, progress: { done, total: cells.length }, complete: done >= cells.length && cells.length > 0 };
}

function turnPayload(room) {
  const p = room.players[room.turnIndex];
  return {
    currentPlayerId: p ? p.id : null,
    currentPlayerName: p ? p.name : null,
    speedSeconds: room.speedSeconds,
    turnDeadline: room.turnDeadline,
  };
}

function clearTurnTimer(room) {
  if (room.turnTimerHandle) {
    clearTimeout(room.turnTimerHandle);
    room.turnTimerHandle = null;
  }
  room.turnDeadline = null;
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.speedSeconds) return;
  room.turnDeadline = Date.now() + room.speedSeconds * 1000;
  room.turnTimerHandle = setTimeout(() => {
    const p = room.players[room.turnIndex];
    if (p) {
      io.to(room.code).emit('turn-timeout', { playerId: p.id, playerName: p.name });
    }
    advanceTurn(room, 1);
  }, room.speedSeconds * 1000);
}

function advanceTurn(room, steps) {
  if (!room.players.length) return;
  room.turnIndex = (room.turnIndex + steps) % room.players.length;
  armTurnTimer(room);
  io.to(room.code).emit('turn-update', turnPayload(room));
}

// Marks `number` on every board that has it (every board contains every
// number 1..n^2, just arranged differently), recomputes everyone's
// progress, and returns the first player who now satisfies the win pattern
// (if any).
function applyCallToAllBoards(room, number) {
  let winner = null;
  const n = room.gridSize;
  room.players.forEach((p) => {
    if (!p.board) return;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (p.board[r][c] === number) p.marked[r][c] = true;
      }
    }
    const result = computeProgress(room, p);
    io.to(p.id).emit('own-progress', { ...result, number });
    if (result.complete && !winner) winner = p;
  });
  return winner;
}

function finishGame(room, winner, draw) {
  clearTurnTimer(room);
  room.started = false;
  if (winner) winner.matchWins += 1;
  io.to(room.code).emit('game-over', {
    winner: winner ? winner.name : null,
    winnerId: winner ? winner.id : null,
    draw: !!draw,
    seriesScores: room.players.map((p) => ({ id: p.id, name: p.name, matchWins: p.matchWins })),
    round: room.round,
  });
}

// ---------- Manual board setup phase ----------

function clearSetupTimer(room) {
  if (room.setupTimerHandle) {
    clearTimeout(room.setupTimerHandle);
    room.setupTimerHandle = null;
  }
  room.setupDeadline = null;
}

// A valid manual board is an n x n grid containing every integer from
// 1..n^2 exactly once.
function isValidBoard(board, n) {
  if (!Array.isArray(board) || board.length !== n) return false;
  const seen = new Set();
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== n) return false;
    for (const val of row) {
      const num = Number(val);
      if (!Number.isInteger(num) || num < 1 || num > n * n) return false;
      if (seen.has(num)) return false;
      seen.add(num);
    }
  }
  return seen.size === n * n;
}

function beginActualGame(room) {
  clearSetupTimer(room);
  room.phase = 'playing';
  room.calledNumbers = [];
  room.turnIndex = 0;
  room.players.forEach((p) => {
    p.marked = emptyMarked(room.gridSize);
    p.lines = 0;
    p.letters = [false, false, false, false, false];
    p.powerups = freshPowerups();
    io.to(p.id).emit('game-ready', {
      gridSize: room.gridSize,
      board: p.board,
      winPattern: room.winPattern,
      speedSeconds: room.speedSeconds,
      round: room.round,
      players: room.players.map((pp) => ({ id: pp.id, name: pp.name, matchWins: pp.matchWins })),
      powerups: p.powerups,
    });
  });
  armTurnTimer(room);
  io.to(room.code).emit('turn-update', turnPayload(room));
}

// Fills in a random valid board for anyone who never submitted (or
// submitted something invalid), then transitions to actual gameplay.
function finalizeSetup(room) {
  clearSetupTimer(room);
  room.players.forEach((p) => {
    if (!p.boardSubmitted || !isValidBoard(p.board, room.gridSize)) {
      p.board = generateBoard(room.gridSize);
    }
  });
  io.to(room.code).emit('setup-complete');
  beginActualGame(room);
}

function armSetupTimer(room) {
  clearSetupTimer(room);
  room.setupDeadline = Date.now() + room.setupSeconds * 1000;
  room.setupTimerHandle = setTimeout(() => finalizeSetup(room), room.setupSeconds * 1000);
}

// ---------- Grid Wars (dots and boxes) ----------

const BOX_SIZE_OPTIONS = [3, 4, 5];

function newGridWarsPlayer(id, name) {
  return { id, name: (name || 'Player').slice(0, 16), score: 0, matchWins: 0 };
}

// hEdges is (n+1) rows x n cols — hEdges[i][j] is the horizontal edge
// between dot(i,j) and dot(i,j+1). vEdges is n rows x (n+1) cols —
// vEdges[i][j] is the vertical edge between dot(i,j) and dot(i+1,j).
function emptyEdges(n) {
  const hEdges = Array.from({ length: n + 1 }, () => Array(n).fill(false));
  const vEdges = Array.from({ length: n }, () => Array(n + 1).fill(false));
  return { hEdges, vEdges };
}

function gridWarsTurnPayload(room) {
  const p = room.players[room.turnIndex];
  return { currentPlayerId: p ? p.id : null, currentPlayerName: p ? p.name : null };
}

function startGridWarsGame(room) {
  room.started = true;
  room.phase = 'playing';
  const n = room.boxSize;
  const { hEdges, vEdges } = emptyEdges(n);
  room.hEdges = hEdges;
  room.vEdges = vEdges;
  room.boxOwner = Array.from({ length: n }, () => Array(n).fill(null));
  room.edgesDrawn = 0;
  room.turnIndex = 0;
  room.players.forEach((p) => { p.score = 0; });
  io.to(room.code).emit('gridwars-started', {
    boxSize: n,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: 0, matchWins: p.matchWins })),
  });
  io.to(room.code).emit('gridwars-turn', gridWarsTurnPayload(room));
}

function finishGridWars(room) {
  room.started = false;
  let winner = null;
  let maxScore = -1;
  let tie = false;
  room.players.forEach((p) => {
    if (p.score > maxScore) { maxScore = p.score; winner = p; tie = false; }
    else if (p.score === maxScore) { tie = true; }
  });
  if (tie) winner = null;
  if (winner) winner.matchWins += 1;
  io.to(room.code).emit('gridwars-over', {
    winner: winner ? winner.name : null,
    winnerId: winner ? winner.id : null,
    draw: !winner,
    scores: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, matchWins: p.matchWins })),
    round: room.round,
  });
}

io.on('connection', (socket) => {
  socket.on('create-room', (payload, cb) => {
    const { name, gameType } = payload || {};
    if (gameType === 'grid-wars') {
      let boxSize = BOX_SIZE_OPTIONS.includes(Number(payload.boxSize)) ? Number(payload.boxSize) : 4;
      let maxPlayers = Math.min(4, Math.max(2, Number(payload.maxPlayers) || 4));
      const code = makeRoomCode();
      const room = {
        code,
        gameType: 'grid-wars',
        boxSize,
        maxPlayers,
        hostId: socket.id,
        started: false,
        phase: 'lobby',
        players: [],
        turnIndex: 0,
        round: 1,
      };
      rooms[code] = room;
      room.players.push(newGridWarsPlayer(socket.id, name));
      socket.join(code);
      cb && cb({ ok: true, room: lobbyState(room) });
      return;
    }

    let { gridSize, maxPlayers, winPattern, speedSeconds, boardMode, setupSeconds } = payload;
    gridSize = [5, 6, 7].includes(gridSize) ? gridSize : 5;
    maxPlayers = Math.min(4, Math.max(2, Number(maxPlayers) || 4));
    winPattern = WIN_PATTERNS.includes(winPattern) ? winPattern : 'lines';
    speedSeconds = SPEED_OPTIONS.includes(Number(speedSeconds)) ? Number(speedSeconds) : 0;
    boardMode = BOARD_MODES.includes(boardMode) ? boardMode : 'random';
    setupSeconds = SETUP_SECONDS_OPTIONS.includes(Number(setupSeconds)) ? Number(setupSeconds) : 120;
    const code = makeRoomCode();
    const room = {
      code,
      gameType: 'bingo',
      gridSize,
      maxPlayers,
      hostId: socket.id,
      started: false,
      phase: 'lobby',
      players: [],
      calledNumbers: [],
      turnIndex: 0,
      winPattern,
      speedSeconds,
      boardMode,
      setupSeconds,
      turnTimerHandle: null,
      turnDeadline: null,
      setupTimerHandle: null,
      setupDeadline: null,
      round: 1,
    };
    rooms[code] = room;
    room.players.push(newPlayer(socket.id, name));
    socket.join(code);
    cb && cb({ ok: true, room: lobbyState(room) });
  });

  socket.on('update-room-settings', ({ code, boardMode, setupSeconds, speedSeconds }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.gameType === 'grid-wars') return; // nothing adjustable here yet
    if (boardMode !== undefined && BOARD_MODES.includes(boardMode)) room.boardMode = boardMode;
    if (setupSeconds !== undefined && SETUP_SECONDS_OPTIONS.includes(Number(setupSeconds))) {
      room.setupSeconds = Number(setupSeconds);
    }
    if (speedSeconds !== undefined && SPEED_OPTIONS.includes(Number(speedSeconds))) {
      room.speedSeconds = Number(speedSeconds);
    }
    io.to(code).emit('lobby-update', lobbyState(room));
  });

  socket.on('join-room', ({ name, code }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'Room not found. Check the code.' });
    if (room.started) return cb && cb({ ok: false, error: 'This game already started.' });
    if (room.players.length >= room.maxPlayers) return cb && cb({ ok: false, error: 'Room is full.' });
    room.players.push(room.gameType === 'grid-wars' ? newGridWarsPlayer(socket.id, name) : newPlayer(socket.id, name));
    socket.join(code);
    io.to(code).emit('lobby-update', lobbyState(room));
    cb && cb({ ok: true, room: lobbyState(room) });
  });

  socket.on('start-game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;

    if (room.gameType === 'grid-wars') {
      startGridWarsGame(room);
      return;
    }

    room.started = true;

    if (room.boardMode === 'manual') {
      room.phase = 'setup';
      room.players.forEach((p) => {
        p.board = null;
        p.boardSubmitted = false;
      });
      armSetupTimer(room);
      io.to(code).emit('setup-started', {
        gridSize: room.gridSize,
        setupSeconds: room.setupSeconds,
        setupDeadline: room.setupDeadline,
        players: room.players.map((pp) => ({ id: pp.id, name: pp.name })),
      });
      return;
    }

    // Random mode: generate boards immediately and jump straight to play.
    room.players.forEach((p) => { p.board = generateBoard(room.gridSize); p.boardSubmitted = true; });
    beginActualGame(room);
  });

  socket.on('submit-manual-board', ({ code, board }, cb) => {
    const room = rooms[code];
    if (!room || room.phase !== 'setup') return cb && cb({ ok: false, error: 'Setup is not active.' });
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb && cb({ ok: false, error: 'Player not found.' });
    if (!isValidBoard(board, room.gridSize)) {
      return cb && cb({ ok: false, error: `Board must use every number from 1 to ${room.gridSize * room.gridSize} exactly once.` });
    }
    player.board = board;
    player.boardSubmitted = true;
    cb && cb({ ok: true });
    io.to(code).emit('setup-progress', {
      submittedIds: room.players.filter((p) => p.boardSubmitted).map((p) => p.id),
    });
    if (room.players.every((p) => p.boardSubmitted)) finalizeSetup(room);
  });

  socket.on('select-cell', ({ code, row, col }) => {
    const room = rooms[code];
    if (!room || !room.started || room.phase !== 'playing') return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.board) return;
    const currentTurnPlayer = room.players[room.turnIndex];
    if (!currentTurnPlayer || currentTurnPlayer.id !== socket.id) return; // not your turn
    const n = room.gridSize;
    if (row < 0 || row >= n || col < 0 || col >= n) return;
    if (player.marked[row][col]) return; // already marked, nothing to do

    const number = player.board[row][col];
    const total = n * n;

    // A number can only be selected once per game (it's already auto-marked
    // for everyone the moment it's first called), so this is just a safety
    // net against double-clicks/race conditions.
    if (room.calledNumbers.includes(number)) return;
    room.calledNumbers.push(number);
    io.to(code).emit('number-called', { number, calledNumbers: room.calledNumbers });

    const winner = applyCallToAllBoards(room, number);

    if (winner) { finishGame(room, winner, false); return; }
    if (room.calledNumbers.length >= total) { finishGame(room, null, true); return; }

    advanceTurn(room, 1);
  });

  socket.on('select-edge', ({ code, orientation, row, col }) => {
    const room = rooms[code];
    if (!room || !room.started || room.gameType !== 'grid-wars' || room.phase !== 'playing') return;
    const currentTurnPlayer = room.players[room.turnIndex];
    if (!currentTurnPlayer || currentTurnPlayer.id !== socket.id) return; // not your turn

    const n = room.boxSize;
    let edges, maxRow, maxCol;
    if (orientation === 'h') { edges = room.hEdges; maxRow = n; maxCol = n - 1; }
    else if (orientation === 'v') { edges = room.vEdges; maxRow = n - 1; maxCol = n; }
    else return;
    if (row < 0 || row > maxRow || col < 0 || col > maxCol) return;
    if (edges[row][col]) return; // already drawn

    edges[row][col] = true;
    room.edgesDrawn += 1;
    io.to(code).emit('edge-drawn', { orientation, row, col, playerId: socket.id });

    // Figure out which box(es) border this edge, and claim any that are
    // now fully surrounded.
    const boxesToCheck = [];
    if (orientation === 'h') {
      if (row - 1 >= 0) boxesToCheck.push([row - 1, col]); // box above
      if (row < n) boxesToCheck.push([row, col]); // box below
    } else {
      if (col - 1 >= 0) boxesToCheck.push([row, col - 1]); // box to the left
      if (col < n) boxesToCheck.push([row, col]); // box to the right
    }

    let claimedAny = false;
    boxesToCheck.forEach(([br, bc]) => {
      if (room.boxOwner[br][bc]) return; // already claimed
      const top = room.hEdges[br][bc];
      const bottom = room.hEdges[br + 1][bc];
      const left = room.vEdges[br][bc];
      const right = room.vEdges[br][bc + 1];
      if (top && bottom && left && right) {
        room.boxOwner[br][bc] = currentTurnPlayer.id;
        currentTurnPlayer.score += 1;
        claimedAny = true;
        io.to(code).emit('box-claimed', {
          row: br, col: bc, playerId: currentTurnPlayer.id, playerName: currentTurnPlayer.name, score: currentTurnPlayer.score,
        });
      }
    });

    const totalEdges = (n + 1) * n + n * (n + 1);
    if (room.edgesDrawn >= totalEdges) {
      finishGridWars(room);
      return;
    }

    // Completing a box earns another turn — classic dots-and-boxes rule.
    if (!claimedAny) {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    }
    io.to(code).emit('gridwars-turn', gridWarsTurnPayload(room));
  });

  socket.on('use-powerup', ({ code, type, targetId }) => {
    const room = rooms[code];
    if (!room || !room.started || room.phase !== 'playing') return;
    if (!POWERUP_TYPES.includes(type)) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.board) return;
    const currentTurnPlayer = room.players[room.turnIndex];
    if (!currentTurnPlayer || currentTurnPlayer.id !== socket.id) return; // not your turn
    if (!player.powerups[type]) return; // already used

    player.powerups[type] = false;

    if (type === 'peek') {
      const n = room.gridSize;
      const reveals = [];
      room.players.forEach((p) => {
        if (p.id === player.id || !p.board) return;
        const unmarked = [];
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (!p.marked[r][c]) unmarked.push(p.board[r][c]);
          }
        }
        if (unmarked.length) {
          const number = unmarked[Math.floor(Math.random() * unmarked.length)];
          reveals.push({ opponentId: p.id, opponentName: p.name, number });
        }
      });
      socket.emit('peek-result', { reveals, powerups: player.powerups });
      io.to(code).emit('powerup-used', { type, byId: player.id, byName: player.name });
      advanceTurn(room, 1);
      return;
    }

    if (type === 'skip') {
      const skippedIndex = (room.turnIndex + 1) % room.players.length;
      const skipped = room.players[skippedIndex];
      io.to(code).emit('powerup-used', {
        type,
        byId: player.id,
        byName: player.name,
        targetName: skipped ? skipped.name : null,
      });
      socket.emit('own-progress', { ...computeProgress(room, player), number: null, powerups: player.powerups });
      advanceTurn(room, 2);
      return;
    }

    if (type === 'swap') {
      const target = room.players.find((p) => p.id === targetId && p.id !== player.id);
      if (!target || !target.board) { player.powerups[type] = true; return; } // invalid target, refund
      const tmpBoard = player.board, tmpMarked = player.marked;
      player.board = target.board; player.marked = target.marked;
      target.board = tmpBoard; target.marked = tmpMarked;

      const myResult = computeProgress(room, player);
      const targetResult = computeProgress(room, target);
      io.to(player.id).emit('board-swapped', { board: player.board, ...myResult, powerups: player.powerups });
      io.to(target.id).emit('board-swapped', { board: target.board, ...targetResult, powerups: target.powerups });
      io.to(code).emit('powerup-used', { type, byId: player.id, byName: player.name, targetName: target.name });

      const winner = myResult.complete ? player : (targetResult.complete ? target : null);
      if (winner) { finishGame(room, winner, false); return; }

      advanceTurn(room, 1);
      return;
    }
  });

  socket.on('send-reaction', ({ code, emoji }) => {
    const room = rooms[code];
    if (!room || !REACTION_EMOJI.includes(emoji)) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    io.to(code).emit('reaction', { playerId: player.id, playerName: player.name, emoji });
  });

  socket.on('send-voice-line', ({ code, lineId }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    io.to(code).emit('voice-line', { playerId: player.id, playerName: player.name, lineId });
  });

  socket.on('return-to-lobby', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    clearTurnTimer(room);
    clearSetupTimer(room);
    room.started = false;
    room.phase = 'lobby';
    room.round += 1;
    io.to(code).emit('lobby-update', lobbyState(room));
    io.to(code).emit('returned-to-lobby');
  });

  socket.on('leave-room', ({ code }) => handleLeave(socket, code));
  socket.on('disconnect', () => {
    for (const code of Object.keys(rooms)) {
      if (rooms[code].players.some((p) => p.id === socket.id)) handleLeave(socket, code);
    }
  });
});

function handleLeave(socket, code) {
  const room = rooms[code];
  if (!room) return;
  const leavingIndex = room.players.findIndex((p) => p.id === socket.id);
  room.players = room.players.filter((p) => p.id !== socket.id);
  socket.leave(code);
  if (room.players.length === 0) {
    clearTurnTimer(room);
    clearSetupTimer(room);
    delete rooms[code];
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  io.to(code).emit('lobby-update', lobbyState(room));

  if (room.gameType === 'grid-wars') {
    if (room.started && room.phase === 'playing') {
      if (leavingIndex !== -1 && leavingIndex <= room.turnIndex) {
        room.turnIndex = Math.max(0, room.turnIndex - 1);
      }
      if (room.turnIndex >= room.players.length) room.turnIndex = 0;
      if (room.players.length < 2) {
        finishGridWars(room);
      } else {
        io.to(code).emit('gridwars-turn', gridWarsTurnPayload(room));
      }
    }
    return;
  }

  if (room.phase === 'setup') {
    if (room.players.every((p) => p.boardSubmitted)) finalizeSetup(room);
    return;
  }

  if (room.started && room.phase === 'playing') {
    // Keep the turn pointer valid; if the player who just left was ahead of
    // or at the current turn, the index needs to shift back to stay on track.
    if (leavingIndex !== -1 && leavingIndex <= room.turnIndex) {
      room.turnIndex = Math.max(0, room.turnIndex - 1);
    }
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.players.length < 2) {
      finishGame(room, null, true);
    } else {
      armTurnTimer(room);
      io.to(code).emit('turn-update', turnPayload(room));
    }
  }
}

server.listen(PORT, () => {
  console.log(`Hall Call BINGO listening on port ${PORT}`);
});
