# penguin-party 引き継ぎメモ

## プロジェクト概要
Node.js + Express + Socket.io のマルチプレイヤーカードゲーム（ペンギンパーティ）
- リポジトリ: https://github.com/maru89314/penguin-party
- 本番URL: https://penguin-party.onrender.com
- ホスティング: Render.com（free tier、無操作時スリープあり）

## 完了済みの修正（スリープ復帰時の再接続対応）

### server.js
- `rejoinRoom` イベントハンドラーを追加
  - 再接続時にプレイヤー名とルームコードでゲーム状態を復元
  - ホストだった場合は hostId も引き継ぐ
- `disconnect` ハンドラーを修正
  - ロビー待機中 → 即退出（従来通り）
  - ゲームプレイ中 → 30秒の猶予を設けてから退出（スリープ対応）
  - 他プレイヤーに `playerDisconnected` イベントを通知

### public/index.html
- Socket.io の接続オプションに再接続設定を追加
  ```js
  const socket = io({ reconnectionDelay: 1000, reconnectionAttempts: Infinity });
  ```
- `myName` / `myRoomCode` 変数を追加（再接続用に名前とコードを保持）
- `disconnect` イベント → 再接続中オーバーレイを表示（スピナー付き）
- `connect` イベント → オーバーレイを非表示にして `rejoinRoom` を自動送信
- `playerDisconnected` イベント → 他プレイヤーの切断をゲーム画面に表示
- `isHost = false` のバグ修正（ゲーム参加者がホスト扱いになっていた問題）
- `#reconnect-overlay` のHTML/CSSを追加（画面全体を覆うモーダル）

## 次にやりたいこと
（ここに続きの作業を書いてください）
