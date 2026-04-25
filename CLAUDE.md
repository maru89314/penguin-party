# penguin-party 引き継ぎメモ

## プロジェクト概要
Node.js + Express + Socket.io のマルチプレイヤーカードゲーム（ペンギンパーティ）
- リポジトリ: https://github.com/maru89314/penguin-party
- 本番URL: https://penguin-party.onrender.com
- ホスティング: Render.com（free tier、無操作時スリープあり）

## 現在の状態
- バグはすべて修正済み
- スリープ復帰時の再接続対応済み
- ペンギン画像カード表示対応済み
- 配置ルール（隣接・下2枚・同色）正常動作
- ルームコードは数字4桁
- 2ゲーム目以降のスタートプレイヤーがラウンドごとに自動で順番に変わるよう対応済み

## 主な構成

### server.js
- `createRoom` / `joinRoom` でロビー管理
- `startGame` でゲーム開始（ラウンド数=参加人数、スコアリセット）
- `nextRound` で次ラウンド開始（スコアを引き継ぎ、スタートプレイヤーをローテーション）
- `playCard` でカードを置く
- `rejoinRoom` で再接続復帰
- `disconnect` でゲーム中は30秒猶予付き退出

### public/index.html
- 単一HTMLファイルにUI・ロジックすべて記述
- Socket.io クライアントで通信
- ラウンド終了画面に「次のラウンドの最初のプレイヤー」を表示
- 再接続オーバーレイ対応

## スタートプレイヤーのルール
`room.currentPlayerIndex = room.round % room.players.length` で自動ローテーション。
ラウンド終了画面にも次のスタートプレイヤー名を表示している。
