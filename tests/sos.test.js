const test = require('node:test');
const assert = require('node:assert/strict');
const { countSosSequences, evaluateSosMove } = require('../sos');

test('counts SOS sequences on a 3x3 board', () => {
  const board = [
    ['S', 'O', 'S'],
    [null, null, null],
    [null, null, null],
  ];

  assert.equal(countSosSequences(board), 1);
});

test('awards new SOS sequences only when a move completes one', () => {
  const board = [
    ['S', 'O', null],
    [null, null, null],
    [null, null, null],
  ];

  const gained = evaluateSosMove(board, 0, 2, 'S');
  assert.equal(gained, 1);
  assert.deepEqual(board[0], ['S', 'O', 'S']);
});
