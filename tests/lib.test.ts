import { describe, expect, test } from 'claude-code/testing'

import { apply, q } from '../hooks/db'
import type { Run } from '../hooks/db'
import { applyEdits, formatInjection, parseHaiku, parseJev, pickTypes, scrub } from '../hooks/lib'

describe('applyEdits', () => {
  test('removes exact lines, adds new, skips duplicates', () => {
    const r = applyEdits('- uses npm\n- hates emojis', { add: ['- uses pnpm', '- hates emojis'], remove: ['- uses npm'] }, 30)
    expect(r.content).toBe('- hates emojis\n- uses pnpm')
    expect(r.added).toBe(1)
    expect(r.removed).toBe(1)
  })
  test('a remove that does not match exactly drops nothing', () => {
    expect(applyEdits('- a', { add: [], remove: ['- A'] }, 30).content).toBe('- a')
  })
  test('cap keeps the newest lines', () => {
    expect(applyEdits('- 1\n- 2\n- 3', { add: ['- 4'], remove: [] }, 3).content).toBe('- 2\n- 3\n- 4')
  })
})

describe('parsing', () => {
  test('parseHaiku tolerates prose around JSON and normalizes', () => {
    const ex = parseHaiku('Sure:\n{"new_types":[{"name":"Deploy","description":"how they deploy"},{"name":"bad name!","description":"x"}],"edits":{"preference":{"add":["uses pnpm"],"remove":[]},"Deploy":{"add":["- fly.io"],"remove":[]},"empty":{"add":[],"remove":[]}}}')
    expect(ex?.newTypes).toEqual([{ name: 'deploy', description: 'how they deploy' }])
    expect(ex?.edits).toEqual({ preference: { add: ['- uses pnpm'], remove: [] }, deploy: { add: ['- fly.io'], remove: [] } })
  })
  test('parseHaiku drops a new type with no notes', () => {
    const ex = parseHaiku('{"new_types":[{"name":"deploy","description":"d"},{"name":"infra","description":"i"}],"edits":{"deploy":{"add":["- fly.io"],"remove":[]}}}')
    expect(ex?.newTypes.map(t => t.name)).toEqual(['deploy'])
  })
  test('parseHaiku caps new types per turn and reports the rest', () => {
    const ex = parseHaiku(
      '{"new_types":[{"name":"deploy","description":"d"},{"name":"testing","description":"t"}],"edits":{"deploy":{"add":["- fly.io"],"remove":[]},"testing":{"add":["- uses vitest"],"remove":[]}}}',
      { existing: ['preference'], maxTypes: 8 },
    )
    expect(ex?.newTypes.map(t => t.name)).toEqual(['deploy'])
    expect(ex?.dropped).toEqual([{ name: 'testing', reason: 'type cap reached' }])
  })
  test('parseHaiku drops a new type that already exists or would exceed maxTypes', () => {
    const dup = parseHaiku(
      '{"new_types":[{"name":"preference","description":"d"}],"edits":{"preference":{"add":["- x"],"remove":[]}}}',
      { existing: ['preference'], maxTypes: 8 },
    )
    expect(dup?.newTypes).toEqual([])
    expect(dup?.dropped).toEqual([{ name: 'preference', reason: 'already exists' }])
    const full = parseHaiku(
      '{"new_types":[{"name":"deploy","description":"d"}],"edits":{"deploy":{"add":["- fly.io"],"remove":[]}}}',
      { existing: ['a', 'b'], maxTypes: 2 },
    )
    expect(full?.newTypes).toEqual([])
    expect(full?.dropped).toEqual([{ name: 'deploy', reason: 'type cap reached' }])
  })
  test('parseHaiku rejects garbage', () => {
    expect(parseHaiku('no json here')).toBe(undefined)
  })
  test('parseJev + pickTypes', () => {
    const j = parseJev('{"answers":{"worth":{"type":"noul","noul":0.8},"t:preference":{"type":"noul","noul":0.9},"t:mistake":{"type":"noul","noul":0.2}},"usage":{"input_tokens":10}}')
    expect(j.ok).toBe(true)
    if (j.ok) expect(pickTypes(j.nouls, 0.5)).toEqual(['preference'])
  })
})

describe('safety', () => {
  test('scrub redacts keys', () => {
    const out = scrub('ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz123 Bearer abcdefghijklmnopqrstu')
    expect(out.includes('abcdefghijklmnop')).toBe(false)
  })
  test('q escapes quotes', () => {
    expect(q("it's")).toBe("'it''s'")
  })
})

describe('formatInjection', () => {
  test('trims the biggest doc to fit the cap', () => {
    const big = Array.from({ length: 40 }, (_, i) => `- point number ${i} with some words`).join('\n')
    const out = formatInjection([{ name: 'a', description: '', content: big }, { name: 'b', description: '', content: '- small' }], 150)
    expect(out.total <= 200).toBe(true)
    expect(out.types.find(t => t.name === 'a')?.trimmed).toBe(true)
  })
})

describe('apply', () => {
  test('retries on a version clash and re-applies the same edits', async () => {
    let docVersion = 1
    let doc = '- old'
    let inserts = 0
    const run: Run = async sql => {
      if (sql.startsWith('SELECT')) return { exitCode: 0, stdout: JSON.stringify([{ version: docVersion, content: doc }]), stderr: '' }
      inserts++
      if (inserts === 1) {
        // another session wrote v2 first
        docVersion = 2
        doc = '- old\n- from other session'
        return { exitCode: 1, stdout: '', stderr: 'Runtime error: UNIQUE constraint failed: notes.type_id, notes.version' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const r = await apply(run, 'preference', { add: ['- new'], remove: [] }, 30)
    expect(r).toEqual({ version: 3, added: 1, removed: 0, conflicts: 1 })
  })
})
