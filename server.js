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
const COLOR_COUNTS = { red: 9, yellow: 8, green: 7, blue: 6, purple: 6 }; // 合計36枚
const PYRAMID_ROWS = 8; // 行8〜1 = 合計36マス

const rooms = {};

function generateCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += Math.floor(Math.random() * 10);
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
    const rowLen = pyramid[0].length; // 8
    const hasAny = pyramid[0].some(c => c !== null);
    if (!hasAny) {
      // 最初の1枚: 両端のどちらか
      return col === 0 || col === rowLen - 1;
    }
    // 2枚目以降: 隣に既存カードがある場所のみ（隙間なし）
    const leftAdj = col > 0 && pyramid[0][col - 1] !== null;
    const rightAdj = col < rowLen - 1 && pyramid[0][col + 1] !== null;
    return leftAdj || rightAdj;
  }
  const below1 = pyramid[row - 1][col];
  const below2 = pyramid[row - 1][col + 1];
  // 下の2枚が両方埋まっていて、かつ少なくとも1枚が同じ色
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
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < deck.length; i++) {
    hands[i % numPlayers].push(deck[i]);
  }
  return hands;
}

function startRound(room) {
  const deck = shuffle(createDeck());
  const hands = dealCards(deck, room.players.length);
  room.pyramid = createPyramid();
  room.hands = hands;
  room.eliminated = new Array(room.players.length).fill(false);
  room.roundPenalties = new Array(room.players.length).fill(0);
  room.currentPlayerIndex = room.round % room.players.length;
  room.phase = 'playing';
  room.selectedCardIndex = null;
}

function nextActivePlayer(room) {
  const n = room.players.length;
  let idx = (room.currentPlayerIndex + 1) % n;
  for (let i = 0; i < n; i++) {
    if (!room.eliminated[idx]) return idx;
    idx = (idx + 1) % n;
  }
  return -1; // 全員終了
}

function broadcastState(room) {
  const baseState = {
    code: room.code,
    phase: room.phase,
    pyramid: room.pyramid,
    players: room.players.map((p, i) => ({
      name: p.name,
      handCount: (room.hands[i] || []).length,
      score: room.scores[i],
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
    if (room.players.length >= 5) return socket.emit('error', 'ルームが満員です（最大5人）');

    room.players.push({ id: socket.id, name });
    room.scores.push(0);
    socket.join(code);
    socket.roomCode = code;

    io.to(code).emit('playerJoined', { players: room.players.map(p => p.name) });
    socket.emit('roomJoined', { code, players: room.players.map(p => p.name) });
    console.log(`${name} が ${code} に参加`);
  });

  // ゲーム開始
  socket.on('startGame', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error', 'ホストのみ開始できます');
    if (room.players.length < 2) return socket.emit('error', '2人以上必要です');

    room.totalRounds = room.players.length;
    room.round = 0;
    room.scores = new Array(room.players.length).fill(0);
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

    // 手札が0→このプレイヤーはラウンドクリア
    if (hand.length === 0) {
      room.eliminated[myIndex] = true;
    }

    // ピラミッド完成 or 全員終了チェック
    const allDone = room.eliminated.every(e => e) || isPyramidFull(room.pyramid);
    if (allDone) {
      endRound(room);
      return;
    }

    // 次のプレイヤーへ（置けない人はスキップ+ペナルティ）
    advanceTurn(room);
    broadcastState(room);
  });

  // 再接続処理（スリープ復帰時など）
  socket.on('rejoinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'ルームが見つかりません');

    const idx = room.players.findIndex(p => p.name === name);
    if (idx === -1) return socket.emit('error', 'プレイヤーが見つかりません');

    // タイマーキャンセル
    if (room.players[idx].disconnectTimer) {
      clearTimeout(room.players[idx].disconnectTimer);
      room.players[idx].disconnectTimer = null;
    }

    // 古いソケットIDを新しいものに更新
    const oldId = room.players[idx].id;
    if (room.hostId === oldId) room.hostId = socket.id;
    room.players[idx].id = socket.id;
    room.players[idx].disconnected = false;

    socket.join(code);
    socket.roomCode = code;

    console.log(`${name} が再接続（${code}）`);

    // ゲーム状態を再送信して画面を復元
    if (room.phase === 'waiting') {
      socket.emit('roomJoined', { code, players: room.players.map(p => p.name) });
    } else {
      broadcastState(room);
    }
  });

  // 切断
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const name = room.players[idx].name;

    // ゲーム中は30秒待ってから退出（スリープ復帰に対応）
    if (room.phase === 'playing' || room.phase === 'roundEnd') {
      room.players[idx].disconnected = true;
      room.players[idx].disconnectTimer = setTimeout(() => {
        if (!rooms[code]) return;
        const stillIdx = room.players.findIndex(p => p.name === name);
        if (stillIdx === -1 || !room.players[stillIdx].disconnected) return;

        room.players.splice(stillIdx, 1);
        room.scores.splice(stillIdx, 1);
        if (room.hands) room.hands.splice(stillIdx, 1);
        if (room.eliminated) room.eliminated.splice(stillIdx, 1);
        if (room.roundPenalties) room.roundPenalties.splice(stillIdx, 1);

        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          io.to(code).emit('playerLeft', { name, players: room.players.map(p => p.name) });
        }
        console.log(`${name} がタイムアウト退出`);
      }, 30000);
      console.log(`${name} が切断（30秒待機中）`);
      io.to(code).emit('playerDisconnected', { name });
    } else {
      // 待機中は即退出
      room.players.splice(idx, 1);
      room.scores.splice(idx, 1);
      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        io.to(code).emit('playerLeft', { name, players: room.players.map(p => p.name) });
      }
      console.log(`${name} が切断`);
    }
  });
});

function advanceTurn(room) {
  let tries = 0;
  const n = room.players.length;

  while (tries < n) {
    const next = (room.currentPlayerIndex + 1) % n;
    room.currentPlayerIndex = next;
    tries++;

    if (room.eliminated[next]) continue;

    // 置けるカードがあるか確認
    if (hasAnyValidMove(room.pyramid, room.hands[next])) return; // OK

    // 置けない → ペナルティ
    const penalty = room.hands[next].length;
    room.roundPenalties[next] = penalty;
    room.eliminated[next] = true;

    // 全員終了チェック
    if (room.eliminated.every(e => e) || isPyramidFull(room.pyramid)) {
      endRound(room);
      return;
    }
  }

  // 全員終了
  endRound(room);
}

function endRound(room) {
  // ペナルティ集計（手札が残っている人）
  room.players.forEach((_, i) => {
    const remaining = (room.hands[i] || []).length;
    if (remaining > 0) {
      room.roundPenalties[i] = remaining;
    }
    room.scores[i] += room.roundPenalties[i];
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
  console.log(`🐧 ペンギンパーティサーバc��起動中: http://localhost:${PORT}`);

  // Render無料プランのスリープ防止：14分おきに自分にpingを送る
  const https = require('https');
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://penguin-party.onrender.com';
  setInterval(() => {
    https.get(`${SELF_URL}/ping`, (res) => {
      console.log(`💓 Keep-alive ping: ${res.statusCode}`);
    }).on('error', (e) => {
      console.log(`⚠️ Keep-alive error: ${e.message}`);
    });
  }, 14 * 60 * 1000); // 14分
});
