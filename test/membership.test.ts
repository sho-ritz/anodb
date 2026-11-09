import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from '../src/crypto.js'
import { createRevocation } from '../src/identity.js'
import { type MemberOp, type OpRecord, evaluate, mayWrite, spaceIdFor } from '../src/membership.js'
import { localSigner } from '../src/signer.js'

const pk = () => getPublicKey(generateSecretKey())
const OWNER = pk()
const ADMIN = pk()
const ALICE = pk()
const BOB = pk()
const NONCE = 'n1'
const SPACE = spaceIdFor(OWNER, NONCE)
const devices = new Map<string, string>()
const dev = (identity: string) => {
  const d = pk()
  devices.set(d, identity)
  return d
}
const lookup = (d: string) => devices.get(d)

let n = 0
const rec = (identity: string, op: MemberOp, par: string[] = []): OpRecord => ({ id: `op${String(++n).padStart(4, '0')}`, identity, op, par })
const create = rec(OWNER, { type: 'create', owner: OWNER, nonce: NONCE, name: 's' })

describe('membership', () => {
  it('only the owner committed to by the space id can create it', () => {
    const forged = rec(ALICE, { type: 'create', owner: ALICE, nonce: NONCE, name: 'evil' })
    const st = evaluate(SPACE, [forged, create], lookup)
    expect(st.owner).toBe(OWNER)
    expect(st.valid).toEqual([create.id])
  })

  it('enforces who may add, promote and remove', () => {
    const addAdmin = rec(OWNER, { type: 'add', identity: ADMIN, role: 'admin' }, [create.id])
    const adminAddsAlice = rec(ADMIN, { type: 'add', identity: ALICE, role: 'writer' }, [addAdmin.id])
    const adminPromotes = rec(ADMIN, { type: 'role', identity: ALICE, role: 'admin' }, [adminAddsAlice.id]) // not allowed
    const aliceAddsBob = rec(ALICE, { type: 'add', identity: BOB, role: 'writer' }, [adminAddsAlice.id]) // writers can't invite
    const adminRemovesOwner = rec(ADMIN, { type: 'remove', identity: OWNER, cut: {} }, [addAdmin.id])
    const st = evaluate(SPACE, [create, addAdmin, adminAddsAlice, adminPromotes, aliceAddsBob, adminRemovesOwner], lookup)
    expect(Object.fromEntries(st.roles)).toEqual({ [OWNER]: 'owner', [ADMIN]: 'admin', [ALICE]: 'writer' })
  })

  it('ignores ops whose parents are unknown (and evaluates them once they arrive)', () => {
    const add = rec(OWNER, { type: 'add', identity: ALICE, role: 'writer' }, [create.id])
    expect(evaluate(SPACE, [add], lookup).roles.size).toBe(0)
    expect(evaluate(SPACE, [add, create], lookup).roles.get(ALICE)).toBe('writer')
  })

  it('a removal wins over a concurrent role change; a later re-add works', () => {
    const add = rec(OWNER, { type: 'add', identity: ADMIN, role: 'admin' }, [create.id])
    const addAlice = rec(ADMIN, { type: 'add', identity: ALICE, role: 'reader' }, [add.id])
    const promote = rec(OWNER, { type: 'role', identity: ALICE, role: 'writer' }, [addAlice.id])
    const remove = rec(ADMIN, { type: 'remove', identity: ALICE, cut: {} }, [addAlice.id]) // concurrent with promote
    const st = evaluate(SPACE, [create, add, addAlice, promote, remove], lookup)
    expect(st.roles.has(ALICE)).toBe(false)
    const readd = rec(OWNER, { type: 'add', identity: ALICE, role: 'writer' }, [promote.id, remove.id])
    expect(evaluate(SPACE, [create, add, addAlice, promote, remove, readd], lookup).roles.get(ALICE)).toBe('writer')
  })

  it('applies removal cut-offs to writes (anti back-dating) and takes the stricter of two', () => {
    const d = dev(ALICE)
    const add = rec(OWNER, { type: 'add', identity: ADMIN, role: 'admin' }, [create.id])
    const addAlice = rec(OWNER, { type: 'add', identity: ALICE, role: 'writer' }, [add.id])
    const st0 = evaluate(SPACE, [create, add, addAlice], lookup)
    expect(mayWrite(st0, ALICE, d, 100)).toBe(true)
    const r1 = rec(OWNER, { type: 'remove', identity: ALICE, cut: { [d]: 41 } }, [addAlice.id])
    const r2 = rec(ADMIN, { type: 'remove', identity: ALICE, cut: { [d]: 37 } }, [addAlice.id])
    const st = evaluate(SPACE, [create, add, addAlice, r1, r2], lookup)
    expect(mayWrite(st, ALICE, d, 37)).toBe(true)
    expect(mayWrite(st, ALICE, d, 38)).toBe(false)
    expect(mayWrite(st, ALICE, dev(ALICE), 1)).toBe(false) // a device the remover never saw
    expect(mayWrite(st, BOB, dev(BOB), 1)).toBe(false) // never a member
  })

  it('downgrading to reader cuts off writes; readers never write', () => {
    const d = dev(BOB)
    const add = rec(OWNER, { type: 'add', identity: BOB, role: 'writer' }, [create.id])
    const down = rec(OWNER, { type: 'role', identity: BOB, role: 'reader', cut: { [d]: 5 } }, [add.id])
    const st = evaluate(SPACE, [create, add, down], lookup)
    expect(mayWrite(st, BOB, d, 5)).toBe(true)
    expect(mayWrite(st, BOB, d, 6)).toBe(false)
    const reader = rec(OWNER, { type: 'add', identity: ALICE, role: 'reader' }, [create.id])
    expect(mayWrite(evaluate(SPACE, [create, reader], lookup), ALICE, dev(ALICE), 1)).toBe(false)
  })

  it('device revocation and ownership transfer', async () => {
    const signer = localSigner(generateSecretKey())
    const me = await signer.getPublicKey()
    const d = dev(me)
    const sp = spaceIdFor(me, 'x')
    const c = rec(me, { type: 'create', owner: me, nonce: 'x', name: 's' })
    const rv = rec(me, { type: 'revoke', revocation: await createRevocation(signer, d, Date.now()), cut: { [d]: 3 } }, [c.id])
    const add = rec(me, { type: 'add', identity: ALICE, role: 'writer' }, [rv.id])
    const tr = rec(me, { type: 'transfer', identity: ALICE }, [add.id])
    const st = evaluate(sp, [c, rv, add, tr], lookup)
    expect(mayWrite(st, me, d, 3)).toBe(true)
    expect(mayWrite(st, me, d, 4)).toBe(false)
    expect(st.owner).toBe(ALICE)
    expect(st.roles.get(me)).toBe('admin')
  })
})
