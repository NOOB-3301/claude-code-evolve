import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'evolve',
  component: 'Pane',
  requestId: 'evolve',
  props: {
    title: 'Evolve',
    isFocused: false,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const T = 1_000_000

const SEED: Record<string, unknown> = {
  laneIn: {
    flow: 'in', text: 'add lodash to this project', stage: 3, status: 'done', t: T - 4000, stageT: T - 3000,
    ms: [null, 4, 466, 1], nouls: { 't:preference': 0.91, 't:mistake': 0.2 },
  },
  laneOut: {
    flow: 'out', text: 'I switched from pnpm to bun', stage: 2, status: 'run', t: T - 2000, stageT: T - 200,
    ms: [null, 533, null, null], nouls: { worth: 0.77, 't:preference': 0.94, 't:mistake': 0.56 }, detail: 'Haiku editing: preference',
  },
  injected: { t: T - 3000, prompt: 'add lodash', types: [{ name: 'preference', tokens: 43, trimmed: false }], total: 54, cap: 1500 },
  types: [
    { name: 'preference', version: 3, lines: 3, tokens: 43, changedAt: T - 300 },
    { name: 'project_convention', version: 0, lines: 0, tokens: 0, changedAt: 0 },
    { name: 'mistake', version: 1, lines: 27, tokens: 400, changedAt: 0 },
  ],
  log: [
    { t: T - 9000, kind: 'skip', text: 'gated out 12%: hi' },
    { t: T - 3000, kind: 'inject', text: 'preference · ~54 tok' },
    { t: T - 100, kind: 'save', text: 'preference v3 +1/−1' },
  ],
  history: [
    { kind: 'in', t: 1, tokens: 0, jevMs: 300 },
    { kind: 'out', t: 2, worth: 0.12, jevMs: 500, saved: 0 },
    { kind: 'in', t: 3, tokens: 54, jevMs: 466 },
    { kind: 'out', t: 4, worth: 0.77, jevMs: 533, saved: 1 },
    { kind: 'in', t: 5, tokens: 120, jevMs: 410 },
  ],
  stats: { turns: 4, gatedOut: 1, saves: 2, added: 3, removed: 1, conflicts: 1, failures: 0, injects: 2, injectTokens: 174 },
  frame: 3,
}

test('the dashboard draws both pipelines, tiles, charts and docs', async ($, on) => {
  on('state.get', (_, e) => {
    const key = (e as { key?: string }).key ?? ''
    return { value: { value: SEED[key], version: key in SEED ? 1 : 0 } }
  })
  on('clock.now', () => ({ value: T }))
  on('fs.read', () => ({ value: '{}' }))
  on('env.get', () => ({ value: '/home/test' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /EVOLVE/.test(t))).toBe(true)
  expect(texts.some(t => /JEV/.test(t) && /HAIKU/.test(t))).toBe(true)
  expect(texts.some(t => /= ~54 tok/.test(t))).toBe(true)
  expect(texts.some(t => /GATE PASS/.test(t))).toBe(true)
  expect(texts.some(t => /preference/.test(t) && /v3/.test(t))).toBe(true)
  await ui.unmount()
})
