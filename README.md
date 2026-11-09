# anoDB — Absolutely None DB

**Local-first SQLite database that syncs over Nostr relays — no backend to provision.**

anoDB は端末内の SQLite を正とし、変更を **E2EE された Nostr イベント**として既存の公開リレーに流す Local-first DB の SDK です。
名前の通り、開発者が用意するサーバーは **absolutely none**。API サーバーも DB サーバーもプロジェクト作成も不要で、オフライン読み書き・複数端末同期・他ユーザーの公開プロフィール取得を一つの型付き API で扱えます。

> ステータス: **v0.1 / 実験的**。プロトコル（[PROTOCOL.md](PROTOCOL.md)）は破壊的に変わる可能性があります。設計の詳細と限界は [docs/DESIGN.md](docs/DESIGN.md)。

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

```ts
import { createAnoDB, defineSchema } from 'anodb'
import { nodeSqlite } from 'anodb/node'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json' },
})

const db = createAnoDB({
  appId: 'com.example.todo',
  schema,
  driver: nodeSqlite('todo.sqlite'),
  // secretKey: 'nsec1…',   // 省略時は生成して DB に保存
  // relays: [...],          // 省略時は DEFAULT_RELAYS。[] でローカル専用
})

const todos = db.table('todo')
const id = todos.insert({ title: '買い物', done: false })
todos.update(id, { done: true })

todos.findMany({ where: { done: false }, orderBy: { createdAt: 'desc' }, limit: 20 })
db.sql('SELECT title FROM todo WHERE priority > ?', [1]) // 読み取り専用 SQL

// 変更（ローカル/他端末から）を購読
const stop = todos.subscribe({ where: { done: false } }, (rows) => render(rows))

// 複数の書き込みをまとめて 1 トランザクション（= 1 イベント）に
db.transaction((tx) => {
  const a = tx.insert('todo', { title: 'A' })
  tx.update('todo', a, { priority: 1 })
})
```

### 別の端末で同期する

同じ所有者鍵を渡すだけです。

```ts
const key = db.exportSecretKey() // nsec1…  安全な方法で別端末へ
const other = createAnoDB({ appId: 'com.example.todo', schema, driver: nodeSqlite('b.sqlite'), secretKey: key })
```

### 同期状態

```ts
db.status // { state: 'offline' | 'syncing' | 'synced', connectedRelays, pendingEvents }
db.onStatus((s) => console.log(s.state))
db.onError((e) => console.warn(e.code, e.message))
await db.waitForSync()
```

### 公開データ（他の Nostr クライアントと互換）

```ts
const { value: profile, status } = await db.nostr.getProfile(pubkey)
// status: 'synced' | 'stale'（取得できずキャッシュを返した） | 'unavailable'
db.nostr.cachedProfile(pubkey)           // ネットワークに触れない

db.nostr.publishProfile({ name: 'alice', about: 'hello' })
db.nostr.publishNote('anoDB から投稿', [['t', 'anodb']])
await db.nostr.getNotes(pubkey, { limit: 20 })
```

### ブラウザ（sql.js）

```ts
import initSqlJs from 'sql.js'
import { createAnoDB, sqlJsDriver } from 'anodb'

const SQL = await initSqlJs()
const db = createAnoDB({ appId, schema, driver: sqlJsDriver(new SQL.Database()) })
```

sql.js はメモリ DB です。永続化が必要なら Worker 上で同期 VFS（sqlite-wasm の OPFS SAH Pool など）を `SqliteDriver` として実装してください（OPFS ドライバ同梱は v0.3 予定）。

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
