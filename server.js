const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const LETTERS = ['B', 'I', 'N', 'G', 'O'];
const WIN_PATTERNS = ['lines', 'corners', 'x', 'blackout'];
const SPEED_OPTIONS = [0, 10, 15, 30]; // seconds; 0 = off
const REACTION_EMOJI = ['👍', '😂', '🔥', '😱', '🎉', '😭'];
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
  };
}

function lobbyState(room) {
  return {
    code: room.code,
    gridSize: room.gridSize,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    started: room.started,
    winPattern: room.winPattern,
    speedSeconds: room.speedSeconds,
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
// coordinates for every player regardless of how their board was shuffled.
function patternCells(pattern, n) {
  if (pattern === 'corners') {
    return [[0, 0], [0, n - 1], [n - 1, 0], [n - 1, n - 1]];
  }
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
  if (pattern === 'blackout') {
    const cells = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) cells.push([r, c]);
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
// number 1..n^2, just shuffled to different cells), recomputes everyone's
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

io.on('connection', (socket) => {
  socket.on('create-room', ({ name, gridSize, maxPlayers, winPattern, speedSeconds }, cb) => {
    gridSize = [5, 6, 7].includes(gridSize) ? gridSize : 5;
    maxPlayers = Math.min(4, Math.max(2, Number(maxPlayers) || 4));
    winPattern = WIN_PATTERNS.includes(winPattern) ? winPattern : 'lines';
    speedSeconds = SPEED_OPTIONS.includes(Number(speedSeconds)) ? Number(speedSeconds) : 0;
    const code = makeRoomCode();
    const room = {
      code,
      gridSize,
      maxPlayers,
      hostId: socket.id,
      started: false,
      players: [],
      calledNumbers: [],
      turnIndex: 0,
      winPattern,
      speedSeconds,
      turnTimerHandle: null,
      turnDeadline: null,
      round: 1,
    };
    rooms[code] = room;
    room.players.push(newPlayer(socket.id, name));
    socket.join(code);
    cb && cb({ ok: true, room: lobbyState(room) });
  });

  socket.on('join-room', ({ name, code }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'Room not found. Check the code.' });
    if (room.started) return cb && cb({ ok: false, error: 'This game already started.' });
    if (room.players.length >= room.maxPlayers) return cb && cb({ ok: false, error: 'Room is full.' });
    room.players.push(newPlayer(socket.id, name));
    socket.join(code);
    io.to(code).emit('lobby-update', lobbyState(room));
    cb && cb({ ok: true, room: lobbyState(room) });
  });

  socket.on('start-game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;
    room.started = true;
    room.calledNumbers = [];
    room.turnIndex = 0;
    room.players.forEach((p) => {
      p.board = generateBoard(room.gridSize);
      p.marked = emptyMarked(room.gridSize);
      p.lines = 0;
      p.letters = [false, false, false, false, false];
      p.powerups = freshPowerups();
      io.to(p.id).emit('game-started', {
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
    io.to(code).emit('turn-update', turnPayload(room));
  });

  socket.on('select-cell', ({ code, row, col }) => {
    const room = rooms[code];
    if (!room || !room.started) return;
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

  socket.on('use-powerup', ({ code, type, targetId }) => {
    const room = rooms[code];
    if (!room || !room.started) return;
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

  socket.on('return-to-lobby', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    clearTurnTimer(room);
    room.started = false;
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
    delete rooms[code];
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  io.to(code).emit('lobby-update', lobbyState(room));
  if (room.started) {
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
