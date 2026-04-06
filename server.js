const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ヘルスチェック用エンドポイント
app.get('/ping', (req, res) => res.send('pong'));

// ─── ゲームデータ ───────────────────────────────────────────────
const COLORS = ['red', 'yellow', 'green', 'blue', 'purple'];
// 緑8枚、他は各色7枚 = 合計36枚
const COLOR_COUNTS = { red: 7, yellow: 7, green: 8, blue: 7, purple: 7 };
const PYRAMID_ROWS = 8; // 最下段8マス → 合計36マス

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ2345679';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (let i = 0; i < COLOR_COUNTS[color]; i++) {
      deck.push({ color, id: `${color}-${i}` });
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ピラミッド: pyramid[row][col]  row=0が一番下(8マス)、row=7がトップ(1マス)
function createPyramid() {
  const p = [];
  for (let r = 0; r < PYRAMID_ROWS; r++) {
    p.push(new Array(PYRAMID_ROWS - r).fill(null));
  }
  return p;
}

function canPlace(pyramid, row, col, color) {
  if (pyramid[row][col] !== null) return false;
  if (row === 0) {
    // 最下段: 任意の色OK。ただし最初のカード以外は既存カードの隣のみ
    const hasAnyCard = pyramid[0].some(c => c !== null);
    if (!hasAnyCard) return true; // 最初のカードはどこでもOK
    const left  = col > 0                     ? pyramid[0][col - 1] : null;
    const right = col < pyramid[0].length - 1 ? pyramid[0][col + 1] : null;
    return left !== null || right !== null;
  }
  // 2段目以上: 下の2枚が両方揃い、かつどちらかと同色
  const below1 = pyramid[row - 1][col];
  const below2 = pyramid[row - 1][col + 1];
  if (!below1 || !below2) return false;
  return below1.color === color || below2.color === color;
}

function getValidPlacements(pyramid, color) {
  const placements = [];
  for (let r = 0; r < PYRAMID_ROWS; r++) {
    for (let c = 0; c < PYRAMID_ROWS - r; c++) {
      if (canPlace(pyramid, r, c, color)) placements.push({ row: r, col: c });
    }
  }
  return placements;
}

function hasAnyValidMove(pyramid, hand) {
  for (const card of hand) {
    if (getValidPlacements(pyramid, card.color).length > 0) return true;
  }
  return false;
}

function isPyramidFull(pyramid) {
  for (let r = 0; r < PYRAMID_ROWS; r++) {
    for (let c = 0; c < PYRAMID_ROWS - r; c++) {
      if (pyramid[r][c] === null) return false;
    }
  }
  return true;
}

function dealCards(deck, numPlayers) {
  let revealedCard = null;
  let dealDeck = deck;
  // 5人の場合: 36枚 ÷ 5 = 7枚ずつ、1枚余り → 表向きに場に出す
  if (numPlayers === 5) {
    revealedCard = deck[deck.length - 1];
    dealDeck = deck.slice(0, deck.length - 1);
  }
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < dealDeck.length; i++) {
    hands[i % numPlayers].push(dealDeck[i]);
  }
  return { hands, revealedCard };
}

function startRound(room) {
  const deck = shuffle(createDeck());
  const { hands, revealedCard } = dealCards(deck, room.players.length);
  room.pyramid = createPyramid();
  room.hands = hands;
  room.revealedCard = revealedCard;
  room.eliminated = new Array(room.players.length).fill(false);
  room.roundPenalties = new Array(room.players.length).fill(0);
  room.currentPlayerIndex = room.round % room.players.length;
  room.phase = 'playing';
}

function broadcastState(room) {
  const baseState = {
    code: room.code,
    phase: room.phase,
    pyramid: room.pyramid,
    revealedCard: room.revealedCard || null,
    players: room.players.map((p, i) => ({
      name: p.name,
      handCount: (room.hands[i] || []).length,
      score: room.scores[i],          // シャチカウンター合計
      roundPenalty: room.roundPenalties ? room.roundPenalties[i] : 0,
      eliminated: room.eliminated ? room.eliminated[i] : false,
      isCurrentPlayer: i === room.currentPlayerIndex,
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    round: room.round,
    totalRounds: room.totalRounds,
    hostId: room.hostId,
  };

  // 各プレイヤーに自分の手札だけ送る
  room.players.forEach((p, i) => {
    io.to(p.id).emit('gameState', {
      ...baseState,
      myHand: room.hands ? room.hands[i] : [],
      myIndex: i,
    });
  });
}

// ─── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  // ルーム作成
  socket.on('createRoom', ({ name }) => {
    let code;
    do { code = generateCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name }],
      scores: [0],
      hands: [],
      pyramid: createPyramid(),
      revealedCard: null,
      eliminated: [],
      roundPenalties: [],
      currentPlayerIndex: 0,
      phase: 'waiting',
      round: 0,
      totalRounds: 1,
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code, players: rooms[code].players.map(p => p.name) });
    console.log(`ルーム作成: ${code} by ${name}`);
  });

  // ルーム参加
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'ルームが見つかりません');
    if (room.phase !== 'waiting') return socket.emit('error', 'ゲームはすでに始まっています');
    if (room.players.length >= 6) return socket.emit('error', 'ルームが満員です（最大6人）');

    room.players.push({ id: socket.id, name });
    room.scores.push(0);
    socket.join(code);
    socket.roomCode = code;

    io.to(code).emit('playerJoined', { players: room.players.map(p => p.name) });
    socket.emit('roomJoined', { code, players: room.players.map(p => p.name) });
    console.log(`${name} が ${code} に参加`);
  });

  // ゲーム開始 / 次のラウンド
  socket.on('startGame', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error', 'ホストのみ開始できます');

    if (room.phase === 'waiting') {
      // 初回ゲーム開始
      if (room.players.length < 2) return socket.emit('error', '2人以上必要です');
      room.totalRounds = room.players.length;
      room.round = 0;
      room.scores = new Array(room.players.length).fill(0);
    } else if (room.phase === 'roundEnd') {
      // 次のラウンドへ（スコアはリセットしない）
    } else {
      return; // playing / gameEnd 中は無視
    }

    startRound(room);
    broadcastState(room);
  });

  // カードを出す
  socket.on('playCard', ({ cardIndex, row, col }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;

    const myIndex = room.players.findIndex(p => p.id === socket.id);
    if (myIndex !== room.currentPlayerIndex) return socket.emit('error', 'あなたのターンではありません');

    const hand = room.hands[myIndex];
    const card = hand[cardIndex];
    if (!card) return socket.emit('error', '無効なカードです');

    if (!canPlace(room.pyramid, row, col, card.color)) {
      return socket.emit('error', 'そこには置けません');
    }

    // カードを置く
    room.pyramid[row][col] = card;
    hand.splice(cardIndex, 1);

    // 手札が0 → このプレイヤーはラウンド終了
    if (hand.length === 0) {
      room.eliminated[myIndex] = true;
    }

    // 全員終了 or ピラミッド完成チェック
    if (room.eliminated.every(e => e) || isPyramidFull(room.pyramid)) {
      endRound(room);
      return;
    }

    advanceTurn(room);
    broadcastState(room);
  });

  // 切断
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const name = room.players[idx].name;
    room.players.splice(idx, 1);
    room.scores.splice(idx, 1);

    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      io.to(code).emit('playerLeft', { name, players: room.players.map(p => p.name) });
    }
    console.log(`${name} が切断`);
  });
});

function advanceTurn(room) {
  const n = room.players.length;
  let tries = 0;

  while (tries < n) {
    const next = (room.currentPlayerIndex + 1) % n;
    room.currentPlayerIndex = next;
    tries++;

    if (room.eliminated[next]) continue;

    // 置けるカードがあればそのプレイヤーのターン
    if (hasAnyValidMove(room.pyramid, room.hands[next])) return;

    // 置けない → このプレイヤーは終了（手札が余った分はendRoundで集計）
    room.eliminated[next] = true;

    if (room.eliminated.every(e => e) || isPyramidFull(room.pyramid)) {
      endRound(room);
      return;
    }
  }

  endRound(room);
}

function endRound(room) {
  // シャチカウンター集計
  room.players.forEach((_, i) => {
    const remaining = (room.hands[i] || []).length;
    if (remaining === 0) {
      // 全出し成功 → 既存のシャチカウンターを最大2枚返却
      const returnAmt = Math.min(2, room.scores[i]);
      room.scores[i] -= returnAmt;
      room.roundPenalties[i] = -returnAmt; // 表示用（マイナスは返却）
    } else {
      // 残り枚数分シャチカウンターを取る
      room.roundPenalties[i] = remaining;
      room.scores[i] += remaining;
    }
  });

  room.round++;
  if (room.round >= room.totalRounds) {
    room.phase = 'gameEnd';
  } else {
    room.phase = 'roundEnd';
  }

  broadcastState(room);
}

// ─── サーバー起動 ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐧 ペンギンパーティサーバー起動中: http://localhost:${PORT}`);

  // Render無料プランのスリープ防止：14分おきに自分にpingを送る
  const https = require('https');
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://penguin-party.onrender.com';
  setInterval(() => {
    https.get(`${SELF_URL}/ping`, (res) => {
      console.log(`💓 Keep-alive ping: ${res.statusCode}`);
    }).on('error', (e) => {
      console.log(`⚠️ Keep-alive error: ${e.message}`);
    });
  }, 14 * 60 * 1000);
});
