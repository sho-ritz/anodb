import type { ColumnType, EventTemplate, NostrEvent, SqlValue, TableDefinition } from './types.js'

/** Marker stored on public table definitions (symbol, so it is not a column). */
export const PUBLIC = Symbol.for('anodb.public')

export type PresetName = 'note' | 'profile' | 'follows' | 'reaction' | 'longForm'

export type PublicRow = Record<string, SqlValue> & { id: string; author: string }

export interface Preset {
  readonly kind: number
  readonly columns: Readonly<Record<string, ColumnType>>
  /** How a newer event of the same author (and address) replaces older rows. */
  readonly replace: 'none' | 'author' | 'address'
  /** Rows represented by an event. */
  rows(e: NostrEvent): PublicRow[]
  /**
   * Event(s) to publish for a change of `row` (after the change), given all current rows of this
   * author in the table (`mine`, already reflecting the change). `deleted` = the row was deleted.
   */
  build(row: PublicRow, mine: PublicRow[], deleted: boolean): EventTemplate[]
  /** Address (for replace = 'address') of an event. */
  address?(e: NostrEvent): string
}

const now = () => Math.floor(Date.now() / 1000)
const tagValue = (e: NostrEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1] ?? null
const str = (v: SqlValue | undefined) => (typeof v === 'string' ? v : null)
const parseTags = (v: SqlValue | undefined): string[][] => {
  if (typeof v !== 'string') return []
  try {
    const t = JSON.parse(v) as unknown
    return Array.isArray(t) ? t.filter((x): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string')) : []
  } catch {
    return []
  }
}
const deletion = (ids: string[], addresses: string[] = [], kind?: number): EventTemplate => ({
  kind: 5,
  created_at: now(),
  content: '',
  tags: [...ids.map((id) => ['e', id]), ...addresses.map((a) => ['a', a]), ...(kind !== undefined ? [['k', String(kind)]] : [])],
})

export const presets: Record<PresetName, Preset> = {
  /** kind 1 short text note. */
  note: {
    kind: 1,
    columns: { author: 'text', content: 'text', tags: 'json', replyTo: 'text' },
    replace: 'none',
    rows: (e) => [
      {
        id: e.id,
        author: e.pubkey,
        content: e.content,
        tags: JSON.stringify(e.tags),
        replyTo: e.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] ?? null,
      },
    ],
    build(row, _mine, deleted) {
      if (deleted) return [deletion([row.id], [], 1)]
      const tags = parseTags(row.tags).filter((t) => !(t[0] === 'e' && t[3] === 'reply'))
      const reply = str(row.replyTo)
      if (reply) tags.push(['e', reply, '', 'reply'])
      return [{ kind: 1, created_at: now(), content: str(row.content) ?? '', tags }]
    },
  },

  /** kind 0 profile (replaceable). One row per author; `id` = author pubkey. */
  profile: {
    kind: 0,
    columns: {
      author: 'text',
      name: 'text',
      displayName: 'text',
      about: 'text',
      picture: 'text',
      banner: 'text',
      website: 'text',
      nip05: 'text',
      lud16: 'text',
    },
    replace: 'author',
    rows(e) {
      let p: Record<string, unknown> = {}
      try {
        const x = JSON.parse(e.content) as unknown
        if (typeof x === 'object' && x !== null && !Array.isArray(x)) p = x as Record<string, unknown>
      } catch {
        /* invalid profile JSON: keep empty fields */
      }
      const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null)
      return [
        {
          id: e.pubkey,
          author: e.pubkey,
          name: s('name'),
          displayName: s('display_name') ?? s('displayName'),
          about: s('about'),
          picture: s('picture'),
          banner: s('banner'),
          website: s('website'),
          nip05: s('nip05'),
          lud16: s('lud16'),
        },
      ]
    },
    build(row, _mine, deleted) {
      if (deleted) throw new Error('anoDB: a profile cannot be deleted; update its fields instead')
      const content: Record<string, string> = {}
      const map: Record<string, string> = { displayName: 'display_name' }
      for (const k of ['name', 'displayName', 'about', 'picture', 'banner', 'website', 'nip05', 'lud16']) {
        const v = str(row[k])
        if (v !== null) content[map[k] ?? k] = v
      }
      return [{ kind: 0, created_at: now(), content: JSON.stringify(content), tags: [] }]
    },
  },

  /** kind 3 follow list (replaceable). One row per followed pubkey; `id` = `${author}:${target}`. */
  follows: {
    kind: 3,
    columns: { author: 'text', target: 'text', relay: 'text', petname: 'text' },
    replace: 'author',
    rows: (e) =>
      e.tags
        .filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1] ?? ''))
        .map((t) => ({ id: `${e.pubkey}:${t[1]}`, author: e.pubkey, target: t[1]!, relay: t[2] || null, petname: t[3] || null })),
    build(_row, mine) {
      const tags = mine.map((r) => {
        const t = ['p', String(r.target)]
        if (r.relay || r.petname) t.push(str(r.relay) ?? '')
        if (r.petname) t.push(String(r.petname))
        return t
      })
      return [{ kind: 3, created_at: now(), content: '', tags }]
    },
  },

  /** kind 7 reaction. */
  reaction: {
    kind: 7,
    columns: { author: 'text', content: 'text', eventId: 'text', eventAuthor: 'text' },
    replace: 'none',
    rows: (e) => [{ id: e.id, author: e.pubkey, content: e.content, eventId: tagValue(e, 'e'), eventAuthor: tagValue(e, 'p') }],
    build(row, _mine, deleted) {
      if (deleted) return [deletion([row.id], [], 7)]
      const tags: string[][] = []
      if (str(row.eventId)) tags.push(['e', String(row.eventId)])
      if (str(row.eventAuthor)) tags.push(['p', String(row.eventAuthor)])
      return [{ kind: 7, created_at: now(), content: str(row.content) ?? '+', tags }]
    },
  },

  /** kind 30023 long-form article (addressable by `d`); `id` = `${author}:${d}`. */
  longForm: {
    kind: 30023,
    columns: { author: 'text', d: 'text', title: 'text', summary: 'text', image: 'text', content: 'text', publishedAt: 'integer', tags: 'json' },
    replace: 'address',
    address: (e) => `30023:${e.pubkey}:${tagValue(e, 'd') ?? ''}`,
    rows(e) {
      const d = tagValue(e, 'd') ?? ''
      const published = Number(tagValue(e, 'published_at'))
      return [
        {
          id: `${e.pubkey}:${d}`,
          author: e.pubkey,
          d,
          title: tagValue(e, 'title'),
          summary: tagValue(e, 'summary'),
          image: tagValue(e, 'image'),
          content: e.content,
          publishedAt: Number.isSafeInteger(published) ? published : null,
          tags: JSON.stringify(e.tags.filter((t) => !['d', 'title', 'summary', 'image', 'published_at'].includes(t[0]!))),
        },
      ]
    },
    build(row, _mine, deleted) {
      const d = str(row.d) ?? ''
      if (deleted) return [deletion([], [`30023:${row.author}:${d}`], 30023)]
      const tags: string[][] = [['d', d]]
      for (const k of ['title', 'summary', 'image'] as const) if (str(row[k])) tags.push([k, String(row[k])])
      tags.push(['published_at', String(typeof row.publishedAt === 'number' ? row.publishedAt : now())])
      tags.push(...parseTags(row.tags))
      return [{ kind: 30023, created_at: now(), content: str(row.content) ?? '', tags }]
    },
  },
}

/** Declare a table that mirrors standard Nostr events (readable/writable by any Nostr client). */
export function publicTable<P extends PresetName>(preset: P): (typeof presets)[P]['columns'] & { readonly [PUBLIC]: P } {
  return Object.assign({ ...presets[preset].columns }, { [PUBLIC]: preset }) as never
}

export function presetOf(def: TableDefinition | undefined): Preset | null {
  const name = def ? (def as { [PUBLIC]?: PresetName })[PUBLIC] : undefined
  return name ? presets[name] : null
}

/** The value of `space` for rows of public tables. */
export const PUBLIC_SPACE = 'public'
