'use client'
/**
 * Ready-made React components for anoDB's sharing and device features. They are plain HTML with
 * `anodb-*` class names and minimal layout styles, so they fit into any design:
 *
 *   <PairDevice />            add a device to your identity (QR code + safety code)
 *   <DeviceList />            your devices, with revoke
 *   <InviteLink space={id} /> one-time invite link + QR, and the join requests to approve
 *   <JoinSpace />             paste / open an invite link, see invitations by npub
 *   <Members space={id} />    members with roles (owners / admins can change them)
 *
 * Links and QR codes are ordinary `https://your-app/#anodb=…` URLs: scanning one with a phone's
 * camera opens your app with the request filled in. Nothing is approved without a click, and
 * pairing always shows a code to compare on both devices.
 */
import qrcode from 'qrcode-generator'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from './membership.js'
import { LINK_CHANNEL } from './links.js'
import { useAnoDB } from './react.js'
import type { Device, Invitation, JoinRequest, Member } from './sharing.js'
import type { SpaceInfo } from './db.js'

/** The parts of AnoDB these components use. */
export interface SharingDB {
  readonly appId: string
  readonly pubkey: string
  onChange(fn: () => void): () => void
  spaces(): SpaceInfo[]
  members(space: string): Member[]
  roleIn(space: string): Role | undefined
  setRole(space: string, who: string, role: Exclude<Role, 'owner'>): Promise<void>
  removeMember(space: string, who: string): Promise<void>
  createInviteLink(space: string, opts?: { role?: Exclude<Role, 'owner'>; expiresInMs?: number }): Promise<string>
  requestJoin(link: string, name?: string): Promise<void>
  joinRequests(): JoinRequest[]
  approveJoinRequest(id: string): Promise<void>
  rejectJoinRequest(id: string): void
  invitations(): Invitation[]
  acceptInvitation(space: string): Promise<void>
  declineInvitation(space: string): void
  devices(): Device[]
  startPairing(): Promise<{ uri: string; code: string; done: Promise<void> }>
  parsePairing(uri: string): { device: string; code: string; approve(name?: string): Promise<void> }
  revokeDevice(device: string): Promise<void>
  close(): Promise<void>
}

export type Lang = 'en' | 'ja'

const en = {
  addDevice: 'Add a device',
  addDeviceHint: 'On the new device, choose “This is a new device”, then scan its QR code with this device or paste its link here.',
  pairingLink: 'Pairing link',
  check: 'Check',
  compare: 'Does the new device show this code?',
  deviceName: 'Name for the new device',
  approve: 'Yes, approve',
  cancel: 'Cancel',
  approved: 'Approved. The new device will finish setting up in a moment.',
  newDevice: 'This is a new device',
  newDeviceHint: 'Shows a QR code for one of your existing devices. This device then switches to that identity (its current local data is replaced).',
  showQr: 'Show pairing QR code',
  scanWithOther: 'Scan with your existing device, or copy the link to it. Then check that it shows this code:',
  waiting: 'Waiting for approval…',
  copy: 'Copy link',
  copied: 'Copied',
  devices: 'Your devices',
  thisDevice: 'this device',
  revoked: 'revoked',
  revoke: 'Revoke',
  confirmRevoke: 'Revoke for good?',
  invite: 'Invite',
  role: 'Role',
  createLink: 'Create invite link',
  linkHint: 'One-time link. It expires in {hours} h, and you approve each request below.',
  requests: 'Join requests',
  none: 'None',
  approveRequest: 'Approve',
  reject: 'Reject',
  cannotInvite: 'Only owners and admins can invite.',
  join: 'Join with a link',
  inviteLink: 'Invite link',
  yourName: 'Your name (shown to the admin)',
  requestJoin: 'Request to join',
  requested: 'Request sent. Waiting for the person who invited you to approve it — they need to have the app open. Keep this page open: you join automatically.',
  invitedTitle: 'You were invited to a shared list',
  awaitingApproval: 'Waiting for approval',
  invitedBody: 'Enter the name the others will see, then send a request. The person who invited you approves it, and the list appears here.',
  joined: 'Joined',
  invitations: 'Invitations',
  accept: 'Accept',
  decline: 'Decline',
  members: 'Members',
  you: 'you',
  remove: 'Remove',
  confirmRemove: 'Remove?',
  invalidLink: 'This is not an anoDB link for this app.',
}
export type Labels = typeof en

const ja: Labels = {
  addDevice: '端末を追加',
  addDeviceHint: '新しい端末で「この端末を追加する」を選び、表示された QR コードをこの端末で読み取るか、リンクをここに貼り付けてください。',
  pairingLink: 'ペアリング用リンク',
  check: '確認',
  compare: '新しい端末に同じコードが表示されていますか？',
  deviceName: '新しい端末の名前',
  approve: 'はい、承認する',
  cancel: 'キャンセル',
  approved: '承認しました。まもなく新しい端末の設定が完了します。',
  newDevice: 'この端末を追加する',
  newDeviceHint: '既存の端末で読み取る QR コードを表示します。承認されると、この端末はそのアカウントに切り替わります（この端末にある今のデータは置き換わります）。',
  showQr: 'ペアリング用 QR コードを表示',
  scanWithOther: '既存の端末で読み取るか、リンクを送ってください。相手の端末に次のコードが出ていることを確認してください:',
  waiting: '承認を待っています…',
  copy: 'リンクをコピー',
  copied: 'コピーしました',
  devices: 'あなたの端末',
  thisDevice: 'この端末',
  revoked: '失効済み',
  revoke: '失効',
  confirmRevoke: '本当に失効させますか？',
  invite: '招待',
  role: '役割',
  createLink: '招待リンクを作成',
  linkHint: '1回限りのリンクです。{hours} 時間で期限が切れ、参加リクエストは下で1件ずつ承認します。',
  requests: '参加リクエスト',
  none: 'なし',
  approveRequest: '承認',
  reject: '拒否',
  cannotInvite: '招待できるのはオーナーと管理者だけです。',
  join: 'リンクで参加',
  inviteLink: '招待リンク',
  yourName: 'あなたの名前（管理者に表示されます）',
  requestJoin: '参加をリクエスト',
  requested: 'リクエストを送りました。招待した人の承認を待っています（相手がアプリを開いている必要があります）。このページを開いたままにしてください。承認されると自動で参加します。',
  invitedTitle: '共有リストに招待されています',
  awaitingApproval: '承認待ち',
  invitedBody: 'ほかのメンバーに表示する名前を入力して、リクエストを送ってください。招待した人が承認すると、ここにリストが表示されます。',
  joined: '参加しました',
  invitations: '招待',
  accept: '参加する',
  decline: '断る',
  members: 'メンバー',
  you: 'あなた',
  remove: '外す',
  confirmRemove: '外しますか？',
  invalidLink: 'このアプリ用の anoDB のリンクではありません。',
}

const LABELS: Record<Lang, Labels> = { en, ja }

function detectLang(): Lang {
  const l = typeof navigator !== 'undefined' ? navigator.language : ''
  return /^ja/i.test(l) ? 'ja' : 'en'
}

interface CommonProps {
  /** UI language; defaults to the browser's language (Japanese or English). */
  lang?: Lang
  /** Override any text. */
  labels?: Partial<Labels>
  className?: string
}

function useLabels(p: CommonProps): Labels {
  return useMemo(() => ({ ...LABELS[p.lang ?? detectLang()], ...p.labels }), [p.lang, p.labels])
}

function useSharingDB(): SharingDB {
  return useAnoDB() as unknown as SharingDB
}

/**
 * Re-read state that has no change event of its own (members, requests, devices…): on every
 * database change and once a second. Re-renders only when the value changes.
 */
export function useLive<T>(read: (db: SharingDB) => T, deps: readonly unknown[] = []): T {
  const db = useSharingDB()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fn = useCallback(() => read(db), [db, ...deps])
  const [value, setValue] = useState(fn)
  const last = useRef(JSON.stringify(value))
  useEffect(() => {
    const update = () => {
      const v = fn()
      const s = JSON.stringify(v)
      if (s !== last.current) {
        last.current = s
        setValue(v)
      }
    }
    update()
    const stop = db.onChange(update)
    const t = setInterval(update, 1000)
    return () => {
      stop()
      clearInterval(t)
    }
  }, [db, fn])
  return value
}

// ---- links -----------------------------------------------------------------------------------

/** Wrap an `anodb://` link into an https URL of this app, so phones open it from a QR code. */
export function toAppLink(uri: string, base?: string): string {
  const b = base ?? (typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '')
  return b ? `${b}#anodb=${encodeURIComponent(uri)}` : uri
}

/** Accepts an `anodb://…` link or an app link (`…#anodb=…`) and returns the `anodb://` link. */
export function parseAppLink(text: string): string | null {
  const t = text.trim()
  if (t.startsWith('anodb://')) return t
  try {
    const hash = new URL(t).hash.replace(/^#/, '')
    const v = new URLSearchParams(hash).get('anodb')
    return v?.startsWith('anodb://') ? v : null
  } catch {
    return null
  }
}

/** An `anodb://<kind>` link this page was opened with (`#anodb=…`), and a way to clear it. */
export function useIncomingLink(kind: 'pair' | 'join'): [string | null, () => void] {
  const [link, setLink] = useState<string | null>(null)
  useEffect(() => {
    const read = () => {
      const l = typeof location !== 'undefined' ? parseAppLink(location.href) : null
      setLink(l?.startsWith(`anodb://${kind}`) ? l : null)
    }
    read()
    window.addEventListener('hashchange', read)
    // A link opened in another tab while this one holds the database (see browserDriver).
    const ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(LINK_CHANNEL) : null
    if (ch)
      ch.onmessage = (e: MessageEvent<{ href?: unknown }>) => {
        const l = typeof e.data?.href === 'string' ? parseAppLink(e.data.href) : null
        if (!l || parseAppLink(location.href) === l) return
        // Put it in this page's URL so every useIncomingLink (including ones mounted later) sees it.
        history.replaceState(null, '', `${location.pathname}${location.search}#anodb=${encodeURIComponent(l)}`)
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      }
    return () => {
      window.removeEventListener('hashchange', read)
      ch?.close()
    }
  }, [kind])
  const clear = useCallback(() => {
    setLink(null)
    if (typeof location !== 'undefined' && location.hash.includes('anodb=')) history.replaceState(null, '', `${location.pathname}${location.search}`)
  }, [])
  return [link, clear]
}

// ---- building blocks -------------------------------------------------------------------------

const col: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const list: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }
const mono: CSSProperties = { fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', fontSize: '0.85em' }
const codeStyle: CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: '1.6em', letterSpacing: '0.15em', fontWeight: 700 }

/** QR code as SVG (dark modules use `currentColor`). */
export function QRCode(props: { value: string; size?: number; className?: string; title?: string }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(props.value)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
    return { path: d, n: n + 8 }
  }, [props.value])
  const size = props.size ?? 200
  return (
    <svg className={props.className ?? 'anodb-qr'} width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={props.title ?? 'QR code'} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

function CopyButton({ text, l }: { text: string; l: Labels }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="anodb-button anodb-secondary"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
    >
      {done ? l.copied : l.copy}
    </button>
  )
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="anodb-error" role="alert" style={{ color: '#c0392b', margin: 0 }}>
      {error}
    </p>
  ) : null
}

/** A button that asks for a second click before doing something destructive. */
function ConfirmButton(props: { label: string; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button type="button" className={`anodb-button ${armed ? 'anodb-danger' : 'anodb-secondary'}`} onClick={() => (armed ? (setArmed(false), props.onConfirm()) : setArmed(true))}>
      {armed ? props.confirm : props.label}
    </button>
  )
}

const useErr = () => {
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(<T,>(p: Promise<T>) => p.then((v) => (setError(null), v)).catch((e: Error) => (setError(e.message), undefined)), [])
  return { error, setError, run }
}

// ---- devices ---------------------------------------------------------------------------------

export interface PairDeviceProps extends CommonProps {
  /** Which parts to show. Default both. */
  mode?: 'both' | 'approve' | 'new-device'
  /** After this device was added to another identity. Default: close the database and reload the page. */
  onPaired?: () => void
  /** Base URL for links and QR codes (default: this page). */
  linkBase?: string
}

/**
 * Add a device to your identity. On the existing device: scan or paste the new device's link,
 * compare the code, approve. On the new device: show the QR code and wait.
 */
export function PairDevice(props: PairDeviceProps) {
  const l = useLabels(props)
  const mode = props.mode ?? 'both'
  return (
    <div className={props.className ?? 'anodb-pair'} style={col}>
      {mode !== 'new-device' && <ApprovePairing l={l} />}
      {mode !== 'approve' && <NewDevicePairing l={l} {...(props.onPaired ? { onPaired: props.onPaired } : {})} {...(props.linkBase ? { linkBase: props.linkBase } : {})} />}
    </div>
  )
}

function ApprovePairing({ l }: { l: Labels }) {
  const db = useSharingDB()
  const [incoming, clearIncoming] = useIncomingLink('pair')
  const [text, setText] = useState('')
  const [pending, setPending] = useState<ReturnType<SharingDB['parsePairing']> | null>(null)
  const [name, setName] = useState('')
  const [done, setDone] = useState(false)
  const { error, setError, run } = useErr()

  const check = useCallback(
    (value: string) => {
      setDone(false)
      const uri = parseAppLink(value)
      if (!uri) return setError(l.invalidLink)
      try {
        setPending(db.parsePairing(uri))
        setError(null)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [db, l, setError],
  )
  useEffect(() => {
    if (incoming) {
      setText(incoming)
      check(incoming)
    }
  }, [incoming, check])

  return (
    <section className="anodb-section" style={col}>
      <h3 style={{ margin: 0 }}>{l.addDevice}</h3>
      <p className="anodb-hint" style={{ margin: 0 }}>
        {l.addDeviceHint}
      </p>
      {!pending && (
        <form
          style={row}
          onSubmit={(e) => {
            e.preventDefault()
            check(text)
          }}
        >
          <input className="anodb-input" aria-label={l.pairingLink} placeholder={l.pairingLink} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button className="anodb-button">{l.check}</button>
        </form>
      )}
      {pending && (
        <div className="anodb-confirm" style={col}>
          <span>{l.compare}</span>
          <span className="anodb-code" style={codeStyle}>
            {pending.code}
          </span>
          <input className="anodb-input" aria-label={l.deviceName} placeholder={l.deviceName} value={name} onChange={(e) => setName(e.target.value)} />
          <div style={row}>
            <button
              className="anodb-button"
              onClick={() =>
                void run(pending.approve(name.trim() || 'device')).then((ok) => {
                  if (ok === undefined) return
                  setPending(null)
                  setText('')
                  setDone(true)
                  clearIncoming()
                })
              }
            >
              {l.approve}
            </button>
            <button
              className="anodb-button anodb-secondary"
              onClick={() => {
                setPending(null)
                clearIncoming()
              }}
            >
              {l.cancel}
            </button>
          </div>
        </div>
      )}
      {done && <p style={{ margin: 0 }}>{l.approved}</p>}
      <ErrorText error={error} />
    </section>
  )
}

function NewDevicePairing({ l, onPaired, linkBase }: { l: Labels; onPaired?: () => void; linkBase?: string }) {
  const db = useSharingDB()
  const [offer, setOffer] = useState<{ uri: string; code: string } | null>(null)
  const { error, run } = useErr()
  const link = offer ? toAppLink(offer.uri, linkBase) : ''
  return (
    <section className="anodb-section" style={col}>
      <h3 style={{ margin: 0 }}>{l.newDevice}</h3>
      <p className="anodb-hint" style={{ margin: 0 }}>
        {l.newDeviceHint}
      </p>
      {!offer && (
        <div>
          <button
            className="anodb-button anodb-secondary"
            onClick={() =>
              void run(db.startPairing()).then((o) => {
                if (!o) return
                setOffer(o)
                void o.done.then(async () => {
                  if (onPaired) return onPaired()
                  await db.close()
                  location.reload()
                })
              })
            }
          >
            {l.showQr}
          </button>
        </div>
      )}
      {offer && (
        <div style={col}>
          <QRCode value={link} title={l.pairingLink} />
          <span style={mono}>{link}</span>
          <span>{l.scanWithOther}</span>
          <span className="anodb-code" style={codeStyle}>
            {offer.code}
          </span>
          <div style={row}>
            <CopyButton text={link} l={l} />
          </div>
          <span className="anodb-hint">{l.waiting}</span>
        </div>
      )}
      <ErrorText error={error} />
    </section>
  )
}

/** Your devices, with a revoke button for each other device. */
export function DeviceList(props: CommonProps) {
  const l = useLabels(props)
  const db = useSharingDB()
  const devices = useLive((d) => d.devices())
  const { error, run } = useErr()
  return (
    <section className={props.className ?? 'anodb-devices'} style={col}>
      <h3 style={{ margin: 0 }}>{l.devices}</h3>
      <ul style={list}>
        {devices.map((d) => (
          <li key={d.device} style={{ ...row, justifyContent: 'space-between', opacity: d.revoked ? 0.5 : 1 }}>
            <span>
              {d.name}
              {d.current && ` (${l.thisDevice})`}
              {d.revoked && ` — ${l.revoked}`}
            </span>
            {!d.current && !d.revoked && <ConfirmButton label={l.revoke} confirm={l.confirmRevoke} onConfirm={() => void run(db.revokeDevice(d.device))} />}
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  )
}

// ---- sharing ---------------------------------------------------------------------------------

const MANAGER: Partial<Record<Role, true>> = { owner: true, admin: true }

export interface InviteLinkProps extends CommonProps {
  space: string
  /** Link lifetime. Default 24 h. */
  expiresInMs?: number
  /** Show join requests below the link. Default true. */
  showRequests?: boolean
  linkBase?: string
}

/** One-time invite link (with QR code) for a space, and the join requests waiting for approval. */
export function InviteLink(props: InviteLinkProps) {
  const l = useLabels(props)
  const db = useSharingDB()
  const me = useLive((d) => d.roleIn(props.space), [props.space])
  const roles: Array<Exclude<Role, 'owner'>> = me === 'owner' ? ['writer', 'reader', 'admin'] : ['writer', 'reader']
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('writer')
  const [link, setLink] = useState<string | null>(null)
  const { error, run } = useErr()
  const expires = props.expiresInMs ?? 24 * 3600_000
  useEffect(() => setLink(null), [props.space])
  if (!me || !MANAGER[me]) {
    return (
      <p className={props.className ?? 'anodb-invite'} style={{ margin: 0 }}>
        {l.cannotInvite}
      </p>
    )
  }
  return (
    <section className={props.className ?? 'anodb-invite'} style={col}>
      <h3 style={{ margin: 0 }}>{l.invite}</h3>
      <div style={row}>
        <select className="anodb-select" aria-label={l.role} value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="anodb-button" onClick={() => void run(db.createInviteLink(props.space, { role, expiresInMs: expires })).then((u) => u && setLink(toAppLink(u, props.linkBase)))}>
          {l.createLink}
        </button>
      </div>
      {link && (
        <div style={col}>
          <QRCode value={link} title={l.inviteLink} />
          <span style={mono}>{link}</span>
          <div style={row}>
            <CopyButton text={link} l={l} />
          </div>
          <span className="anodb-hint">{l.linkHint.replace('{hours}', String(Math.round(expires / 3600_000)))}</span>
        </div>
      )}
      <ErrorText error={error} />
      {props.showRequests !== false && <JoinRequests space={props.space} {...(props.lang ? { lang: props.lang } : {})} {...(props.labels ? { labels: props.labels } : {})} />}
    </section>
  )
}

/** Join requests for one space (or all spaces) with approve / reject. */
export function JoinRequests(props: CommonProps & { space?: string }) {
  const l = useLabels(props)
  const db = useSharingDB()
  const requests = useLive((d) => d.joinRequests().filter((r) => !props.space || r.space === props.space), [props.space])
  const { error, run } = useErr()
  return (
    <section className={props.className ?? 'anodb-requests'} style={col}>
      <h4 style={{ margin: 0 }}>{l.requests}</h4>
      {requests.length === 0 && <span className="anodb-hint">{l.none}</span>}
      <ul style={list}>
        {requests.map((r) => (
          <li key={r.id} style={{ ...row, justifyContent: 'space-between' }}>
            <span>
              {r.name || `${r.npub.slice(0, 12)}…`} <span className="anodb-badge">{r.role}</span>
            </span>
            <span style={row}>
              <button className="anodb-button" onClick={() => void run(db.approveJoinRequest(r.id))}>
                {l.approveRequest}
              </button>
              <button className="anodb-button anodb-secondary" onClick={() => db.rejectJoinRequest(r.id)}>
                {l.reject}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  )
}

export interface JoinSpaceProps extends CommonProps {
  /** Called with the space id once you are a member. */
  onJoined?: (space: string) => void
  /** Pre-filled name shown to the admin. */
  defaultName?: string
}

/** Join with an invite link (pasted or opened via QR), and accept invitations sent to your npub. */
export function JoinSpace(props: JoinSpaceProps) {
  const l = useLabels(props)
  const db = useSharingDB()
  const [incoming, clearIncoming] = useIncomingLink('join')
  const [text, setText] = useState('')
  const [name, setName] = useState(props.defaultName ?? '')
  const [sent, setSent] = useState(false)
  const { error, setError, run } = useErr()
  const spaces = useLive((d) => d.spaces().filter((s) => s.status === 'active').map((s) => s.id))
  const before = useRef<Set<string> | null>(null)
  const onJoined = props.onJoined

  useEffect(() => {
    if (incoming) setText(incoming)
  }, [incoming])
  useEffect(() => {
    if (!before.current) return
    const added = spaces.find((s) => !before.current!.has(s))
    if (added) {
      before.current = null
      setSent(false)
      onJoined?.(added)
    }
  }, [spaces, onJoined])

  return (
    <section className={props.className ?? 'anodb-join'} style={col}>
      <h3 style={{ margin: 0 }}>{sent ? l.awaitingApproval : incoming ? l.invitedTitle : l.join}</h3>
      {incoming && !sent && <p className="anodb-hint" style={{ margin: 0 }}>{l.invitedBody}</p>}
      <form
        style={sent ? { display: 'none' } : col}
        onSubmit={(e) => {
          e.preventDefault()
          const uri = parseAppLink(text)
          if (!uri?.startsWith('anodb://join')) return setError(l.invalidLink)
          before.current = new Set(spaces)
          void run(db.requestJoin(uri, name.trim()).then(() => true)).then((ok) => {
            if (!ok) return
            setSent(true)
            setText('')
            clearIncoming()
          })
        }}
      >
        <input className="anodb-input" aria-label={l.inviteLink} placeholder={l.inviteLink} value={text} onChange={(e) => setText(e.target.value)} />
        <div style={row}>
          <input className="anodb-input" aria-label={l.yourName} placeholder={l.yourName} value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button className="anodb-button">{l.requestJoin}</button>
        </div>
      </form>
      {sent && (
        <span className="anodb-hint" role="status">
          {l.requested}
        </span>
      )}
      <ErrorText error={error} />
      <Invitations {...props} />
    </section>
  )
}

/** Invitations sent to your npub (`db.invite(space, npub, role)`), with accept / decline. */
export function Invitations(props: CommonProps & { onJoined?: (space: string) => void }) {
  const l = useLabels(props)
  const db = useSharingDB()
  const invitations = useLive((d) => d.invitations())
  const { error, run } = useErr()
  if (invitations.length === 0) return null
  return (
    <section className="anodb-invitations" style={col}>
      <h4 style={{ margin: 0 }}>{l.invitations}</h4>
      <ul style={list}>
        {invitations.map((i) => (
          <li key={i.space} style={{ ...row, justifyContent: 'space-between' }}>
            <span>
              {i.name} <span className="anodb-badge">{i.role}</span>
            </span>
            <span style={row}>
              <button className="anodb-button" onClick={() => void run(db.acceptInvitation(i.space)).then(() => props.onJoined?.(i.space))}>
                {l.accept}
              </button>
              <button className="anodb-button anodb-secondary" onClick={() => db.declineInvitation(i.space)}>
                {l.decline}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  )
}

export interface MembersProps extends CommonProps {
  space: string
  /** Display name for a member (default: shortened npub, or "you"). */
  nameOf?: (member: Member) => ReactNode
}

/** Members of a space. Owners and admins can change roles and remove members. */
export function Members(props: MembersProps) {
  const l = useLabels(props)
  const db = useSharingDB()
  const members = useLive((d) => d.members(props.space), [props.space])
  const me = useLive((d) => d.roleIn(props.space), [props.space])
  const { error, run } = useErr()
  const assignable: Array<Exclude<Role, 'owner'>> = me === 'owner' ? ['admin', 'writer', 'reader'] : ['writer', 'reader']
  const canManage = (m: Member) => m.identity !== db.pubkey && m.role !== 'owner' && (me === 'owner' || (me === 'admin' && m.role !== 'admin'))
  return (
    <section className={props.className ?? 'anodb-members'} style={col}>
      <h3 style={{ margin: 0 }}>{l.members}</h3>
      <ul style={list}>
        {members.map((m) => (
          <li key={m.identity} style={{ ...row, justifyContent: 'space-between' }}>
            <span>{props.nameOf ? props.nameOf(m) : m.identity === db.pubkey ? l.you : `${m.npub.slice(0, 12)}…`}</span>
            {canManage(m) ? (
              <span style={row}>
                <select className="anodb-select" aria-label={l.role} value={m.role} onChange={(e) => void run(db.setRole(props.space, m.identity, e.target.value as Exclude<Role, 'owner'>))}>
                  {assignable.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <ConfirmButton label={l.remove} confirm={l.confirmRemove} onConfirm={() => void run(db.removeMember(props.space, m.identity))} />
              </span>
            ) : (
              <span className="anodb-badge">{m.role}</span>
            )}
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  )
}
