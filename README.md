# 白石ちな プレビューBot（LINE）

最小構成のLINE Bot。Glitch/Vercel/Render等で動きます。

## セットアップ（Glitch想定）
1. Glitchで新規プロジェクト（hello-express）を作成
2. `package.json` と `server.js` を貼り替え
3. `.env` に以下を保存：
   - `CHANNEL_SECRET`（LINEチャネルシークレット）
   - `CHANNEL_ACCESS_TOKEN`（チャネルアクセストークン）
   - `OWNER_USER_ID`（任意：しょうたさんLINE ID）
4. 「Show」→ Live App → 表示URLをコピー
5. LINE Developers → Messaging API → Webhook URL に `https://＜表示URL＞/webhook` を設定
6. 「Webhookの利用」を有効化 → 「接続確認」で 200 OK になれば完了

## テスト語彙
- 初回：「同意」
- 雑談：「おはよう／おやすみ／寂しい」
- あだ名：「あだ名つけて」
- スタンプ：「スタンプ送って」
- 楽曲：「イマドンの新曲どう？」 など

## 注意
- プレビュー後はアクセストークンの再発行を推奨
- LINEの利用規約・ポリシーに従って運用してください
