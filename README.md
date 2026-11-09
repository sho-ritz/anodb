# anoDB — Absolutely None DB

**Local-first SQLite database that syncs over Nostr relays — no backend to provision.**

anoDB は端末内の SQLite を正とし、変更を **E2EE された Nostr イベント**として既存の公開リレーに流す Local-first DB の SDK です。
名前の通り、開発者が用意するサーバーは **absolutely none**。API サーバーも DB サーバーもプロジェクト作成も不要で、オフライン読み書き・複数端末同期・他ユーザーの公開プロフィール取得を一つの型付き API で扱えます。

> ステータス: **v0.2 / 実験的**。プロトコル（[PROTOCOL.md](PROTOCOL.md)）は破壊的に変わる可能性があります。設計の詳細と限界は [docs/DESIGN.md](docs/DESIGN.md)。

## 特徴

- 📴 **オフラインファースト** — 書き込みは常にローカル SQLite へ即時コミット。ネットワークは後から追いつく
- 🔐 **E2EE** — 値・テーブル名・列名・appId はリレーから見えない（NIP-44 v2 で所有者自身宛てに暗号化）
- 🔀 **決定論的マージ** — セル（行×列）単位の Last-Writer-Wins + Hybrid Logical Clock。順不同・重複・再送に強い
- 📮 **Outbox** — `minAcks` 個のリレーが保存を確認するまで再送。オフラインで書いたものも確実に届ける
- 🧬 **使い捨ての射影テーブル** — スキーマを変えてもセルから再構築。古い端末が知らない列も失わない
- 🌐 **Nostr 互換** — kind 0（プロフィール）/ 1（投稿）/ 10002（NIP-65 リレーリスト）を読み書き。取得結果は SQLite にキャッシュ
- 🪶 依存は `nostr-tools` と `@noble/hashes` のみ

## インストール

```sh
npm install anodb
```

Node.js 22.13+（`node:sqlite`）またはブラウザ（`sql.js` などの同期 SQLite）で動きます。

## 使い方

```sh
npx anodb init        # 対話式セットアップ（言語 → 環境 → フレームワーク → 鍵 → リレー → ファイル生成）
```

```ts
import { createAnoDB, defineSchema } from 'anodb'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json' },
  tag: { name: 'text', todoId: 'text' },
})

const db = await createAnoDB({ appId: 'com.example.todo', schema, driver })

// SQL ライクで型安全（Kysely）。JOIN も型が付く
await db.insertInto('todo').values({ title: '買い物', done: false }).execute()
await db.updateTable('todo').set({ done: true }).where('title', 'like', '%買%').execute()
const rows = await db
  .selectFrom('todo')
  .leftJoin('tag', 'tag.todoId', 'todo.id')
  .select(['todo.title', 'tag.name'])
  .execute()

// 生 SQL でも書ける（書き込みはトリガーで捕捉され、暗号化・同期される）
await db.execute(`UPDATE todo SET done = 1 WHERE priority > ?`, [2])

// トランザクション（1回の同期単位）
await db.transaction().execute(async (tx) => {
  await tx.insertInto('todo').values({ title: 'A' }).execute()
})

// 変更を購読（ローカル / 他端末どちらの変更でも再実行）
const stop = db.subscribe(db.selectFrom('todo').selectAll(), (rows) => render(rows))
```

- 各テーブルには `id`, `space`, `createdAt`, `updatedAt` が自動で付きます（`space` の既定は個人スペース）
- SQLite の流儀どおり、`boolean` は `0 | 1`、`json` は JSON テキストとして読めます

### 鍵（既定で最も安全な設定）

| 環境 | 既定の保存先 |
|---|---|
| ブラウザ / Tauri | IndexedDB ＋取り出し不可の WebCrypto 鍵で暗号化 |
| Node | 環境変数（`npx anodb init` が `.env` に端末鍵と委任だけを書く。本人の鍵は書かない） |
| Electron / Expo | `electronKeyStore(safeStorage)` / `secureStorageKeyStore(expo-secure-store)` |

- 書き込みはすべて**端末鍵**で署名され、本人の鍵（identity）は端末の登録時に一度だけ使います
- `identity: 'recovery'` にすると、本人の鍵は `onRecoveryKey` で一度だけ渡され、端末には残りません
- `signer: nip07Signer() / nip46Signer(uri) / nip55Signer(bridge)` で外部署名者を使えます
- リレーに見えるのは「使い捨ての公開鍵・世代ごとに変わるタグ・時刻・サイズ」だけです（`metadataProtection: 'none'` で無効化）

## 列型

| 型 | TS | SQLite |
|---|---|---|
| `text` | `string` | TEXT |
| `integer` | `number`（safe integer） | INTEGER |
| `real` | `number` | REAL |
| `boolean` | `boolean` | INTEGER 0/1 |
| `json` | `unknown` | TEXT |

全列 nullable。各行には `id`, `createdAt`, `updatedAt` が自動で付きます。

## 何ができないか

- 公開リレーは**保存を保証しません**。複数リレー + `minAcks` で確率を上げるだけです。
- 端末間の整合性は**結果整合**です（在庫・残高・一意制約は不可）。
- SQL は**手元にあるデータ**にしか効きません。
- 削除は論理削除（tombstone）で、リレー上の過去イベントは残ります。
- v0.1 は**所有者1人（複数端末）**のみ。他人との共有は v0.2 予定。
- 同一秒にリレー上限を超えるイベントがあると、初回同期でその秒の一部を取りこぼすことがあります（NIP-77 対応で解消予定）。

詳細は [docs/DESIGN.md](docs/DESIGN.md) の「未解決の課題」を参照。

## 開発

```sh
npm test              # unit + ローカル WS リレーでの統合テスト（障害注入あり）
npm run typecheck
npm run smoke:public  # 実際の公開リレーで疎通確認（ネットワーク必須）
```

## ライセンス

MIT
