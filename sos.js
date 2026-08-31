function countSosSequences(board) {
  const size = board.length;
  let total = 0;
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      for (const [dr, dc] of dirs) {
        const cells = [];
        for (let i = 0; i < 3; i++) {
          const rr = r + dr * i;
          const cc = c + dc * i;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) {
            cells.length = 0;
            break;
          }
          cells.push(board[rr][cc]);
        }
        if (cells.length === 3 && cells[0] === 'S' && cells[1] === 'O' && cells[2] === 'S') {
          total += 1;
        }
      }
    }
  }

  return total;
}

function evaluateSosMove(board, row, col, letter) {
  const size = board.length;
  if (row < 0 || row >= size || col < 0 || col >= size) return 0;
  if (!['S', 'O'].includes(letter)) return 0;

  const before = countSosSequences(board);
  board[row][col] = letter;
  const after = countSosSequences(board);
  return after - before;
}

module.exports = { countSosSequences, evaluateSosMove };
