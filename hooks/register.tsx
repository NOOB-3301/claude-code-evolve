import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flow, Injected, Lane, LogEntry, Point, Stats, TypeRow } from '../types'
import { Dashboard } from './dashboard'
import { addType, apply, init, latest } from './db'
import type { Run, TypeDoc } from './db'
import {
  classifyQuestions,
  DEFAULT_CONFIG,
  estTokens,
  formatInjection,
  gateQuestions,
  haikuPrompt,
  mergeConfig,
  parseHaiku,
  parseJev,
  pickTypes,
  scrub,
  turnText,
} from './lib'
import type { Config, JevAnswer, TurnRecord } from './lib'

const PANE = 'evolve'
const ZERO: Stats = { turns: 0, gatedOut: 0, saves: 0, added: 0, removed: 0, conflicts: 0, failures: 0, injects: 0, injectTokens: 0 }
const laneIn = atom({ plugin: 'evolve', key: 'laneIn' } as const, null)
const laneOut = atom({ plugin: 'evolve', key: 'laneOut' } as const, null)
const injected = atom({ plugin: 'evolve', key: 'injected' } as const, null)
const typesAtom = atom({ plugin: 'evolve', key: 'types' } as const, [])
const logAtom = atom({ plugin: 'evolve', key: 'log' } as const, [])
const history = atom({ plugin: 'evolve', key: 'history' } as const, [])
const stats = atom({ plugin: 'evolve', key: 'stats' } as const, ZERO)
const frame = atom({ plugin: 'evolve', key: 'frame' } as const, 0)

// Per-load working memory; a reload drops it.
let cfgCache: { at: number; cfg: Config } | undefined
let dbReady: Promise<void> | undefined
let turn: TurnRecord = { prompt: '', tools: [], answer: '' }
const pending = new Set<Promise<void>>()
let animTimer: { cancel: () => void } | undefined
let animUntil = 0
let clockTimer: { cancel: () => void } | undefined

const home = async ($: EngineInterface) => (await $.env.get('HOME')) ?? ''
const dataDir = async ($: EngineInterface) => `${await home($)}/.claude/evolve`

async function loadConfig($: EngineInterface, force = false): Promise<Config> {
  const now = await $.clock.now()
  if (!force && cfgCache !== undefined && now - cfgCache.at < 5000) return cfgCache.cfg
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(`${await dataDir($)}/config.json`))
  } catch {
    raw = undefined // missing or broken: defaults
  }
  cfgCache = { at: now, cfg: mergeConfig(raw) }
  return cfgCache.cfg
}

async function apiKey($: EngineInterface, cfg: Config): Promise<string> {
  if (cfg.typesafeApiKey !== '') return cfg.typesafeApiKey
  const env = await $.env.get('TYPESAFE_API_KEY')
  if (env) return env
  try {
    const jr = JSON.parse(await $.fs.read(`${await home($)}/.claude/jev-router/config.json`)) as { typesafeApiKey?: unknown }
    return typeof jr.typesafeApiKey === 'string' ? jr.typesafeApiKey : ''
  } catch {
    return '' // no jev-router config either
  }
}

async function runner($: EngineInterface): Promise<Run> {
  const cfg = await loadConfig($)
  const db = cfg.dbPath !== '' ? cfg.dbPath : `${await dataDir($)}/evolve.db`
  const run: Run = async (sql, json) => {
    const r = await $.process.run(['sqlite3', '-bail', ...(json ? ['-json'] : []), db], {
      stdin: `.timeout 5000\n${sql}\n`,
      timeoutMs: 20000,
    })
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr }
  }
  if (dbReady === undefined) dbReady = init(run).catch(err => { dbReady = undefined; throw err })
  await dbReady
  return run
}

async function refreshTypes($: EngineInterface, docs?: TypeDoc[]) {
  const all = docs ?? (await latest(await runner($)))
  const now = await $.clock.now()
  await update($, typesAtom, prev => {
    const before = new Map(prev.map(r => [r.name, r]))
    return all.map((d): TypeRow => {
      const old = before.get(d.name)
      return {
        name: d.name,
        version: d.version,
        lines: d.content === '' ? 0 : d.content.split('\n').length,
        tokens: estTokens(d.content),
        // A row that is new or got a new version flashes; first load does not.
        changedAt: old === undefined ? (prev.length === 0 ? 0 : now) : old.version !== d.version ? now : (old.changedAt ?? 0),
      }
    })
  })
  await animate($, 4000)
}

async function log($: EngineInterface, kind: LogEntry['kind'], text: string) {
  const t = await $.clock.now()
  await update($, logAtom, l => [...l, { t, kind, text }].slice(-50))
}

async function point($: EngineInterface, p: Point) {
  await update($, history, h => [...h, p].slice(-120))
}

/** Ticks the frame for `ms` so the pane animates; stops itself when idle. */
async function animate($: EngineInterface, ms: number) {
  animUntil = Math.max(animUntil, (await $.clock.now()) + ms)
  if (animTimer !== undefined) return
  animTimer = $.clock.every(90, () => {
    void (async () => {
      if ((await $.clock.now()) > animUntil) {
        animTimer?.cancel()
        animTimer = undefined
      }
      await update($, frame, n => n + 1)
    })().catch(() => undefined)
  })
}

// Each atom named literally: the validator reads update()'s source statically.
const setLane = ($: EngineInterface, flow: Flow, fn: (l: Lane | null) => Lane | null) =>
  flow === 'in' ? update($, laneIn, fn) : update($, laneOut, fn)

/** Starts a pipeline run at node 0. */
async function laneStart($: EngineInterface, flow: Flow, text: string) {
  const t = await $.clock.now()
  const lane: Lane = { flow, text, stage: 0, status: 'run', t, stageT: t, ms: [null, null, null, null] }
  await setLane($, flow, () => lane)
  await animate($, 3000)
}

/** Moves a run to `stage`, recording how long the previous node took. */
async function laneGo($: EngineInterface, flow: Flow, stage: number, patch: Partial<Lane> = {}) {
  const now = await $.clock.now()
  await setLane($, flow, l => {
    if (l === null) return l
    const ms = [...l.ms]
    if (stage > l.stage && l.stage > 0) ms[l.stage] = ms[l.stage] ?? now - l.stageT
    return { ...l, ...patch, ms, stage, stageT: stage === l.stage ? l.stageT : now }
  })
  await animate($, 3000)
}

/** Ends a run where it is: done, skipped or failed. */
async function laneEnd($: EngineInterface, flow: Flow, status: Lane['status'], patch: Partial<Lane> = {}) {
  const now = await $.clock.now()
  await setLane($, flow, l => {
    if (l === null) return l
    const ms = [...l.ms]
    if (l.stage > 0) ms[l.stage] = ms[l.stage] ?? now - l.stageT
    return { ...l, ...patch, ms, status }
  })
  await animate($, 3000)
}

const bump = ($: EngineInterface, patch: (s: Stats) => Partial<Stats>) => update($, stats, s => ({ ...s, ...patch(s) }))

/** One Jev call under the configured timeout; never throws. */
async function askJev($: EngineInterface, cfg: Config, key: string, state: unknown, questions: Record<string, unknown>, timeoutMs = cfg.timeoutMs): Promise<JevAnswer & { ms: number }> {
  const t0 = await $.clock.now()
  const stop = new AbortController()
  const timeout = $.clock
    .sleep(timeoutMs, { signal: stop.signal })
    .then(() => 'timeout' as const, () => 'cancelled' as const)
  const done = async (a: JevAnswer) => ({ ...a, ms: (await $.clock.now()) - t0 })
  try {
    const res = await Promise.race([
      $.http.fetch(`${cfg.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.jevModel, state, questions }),
      }),
      timeout,
    ])
    if (typeof res === 'string') return done({ ok: false, error: `Jev timed out after ${timeoutMs}ms` })
    if (!res.ok) return done({ ok: false, error: `Jev HTTP ${res.status}` })
    return done(parseJev(res.text))
  } catch (err) {
    return done({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    stop.abort()
  }
}

/** Input flow: you → db → Jev → inject. Returns the hidden context block, if any. */
async function notesFor($: EngineInterface, prompt: string): Promise<string | undefined> {
  const cfg = await loadConfig($)
  if (!cfg.enabled || prompt.trim() === '') return undefined
  await laneStart($, 'in', prompt)
  await laneGo($, 'in', 1)
  const docs = (await latest(await runner($))).filter(d => d.content !== '')
  if (docs.length === 0) {
    await laneEnd($, 'in', 'skip', { detail: 'no notes in memory yet' })
    return undefined
  }
  const key = await apiKey($, cfg)
  if (key === '') {
    await laneEnd($, 'in', 'error', { detail: 'no TypeSafe API key' })
    return undefined
  }
  await laneGo($, 'in', 2, { detail: `${docs.length} docs with notes · asking Jev which matter` })
  const jev = await askJev($, cfg, key, { prompt: scrub(prompt).slice(0, 4000) }, classifyQuestions(docs))
  if (!jev.ok) {
    await laneEnd($, 'in', 'error', { detail: jev.error })
    await log($, 'error', `classify: ${jev.error}`)
    return undefined
  }
  const picked = pickTypes(jev.nouls, cfg.typeThreshold)
  const out = formatInjection(docs.filter(d => picked.includes(d.name)), cfg.maxInjectTokens)
  const t = await $.clock.now()
  const inj: Injected = { t, prompt, types: out.types, total: out.total, cap: cfg.maxInjectTokens }
  await update($, injected, () => inj)
  await point($, { kind: 'in', t, tokens: out.total, jevMs: jev.ms })
  if (out.text === '') {
    await laneEnd($, 'in', 'skip', { nouls: jev.nouls, detail: 'no doc relevant to this prompt' })
    return undefined
  }
  await laneGo($, 'in', 3, { nouls: jev.nouls })
  await laneEnd($, 'in', 'done', { detail: undefined })
  await bump($, s => ({ injects: s.injects + 1, injectTokens: s.injectTokens + out.total }))
  await log($, 'inject', `${out.types.map(x => x.name).join(', ')} · ~${out.total} tok`)
  $.ui.status(`evolve: ${out.types.length} type${out.types.length === 1 ? '' : 's'} · ~${out.total} tok injected`)
  return out.text
}

/** Output flow: turn → Jev gate → Haiku edits → versioned db writes. */
async function extract($: EngineInterface, rec: TurnRecord) {
  const cfg = await loadConfig($)
  if (!cfg.enabled) return
  await laneStart($, 'out', rec.prompt)
  const key = await apiKey($, cfg)
  if (key === '') {
    await laneEnd($, 'out', 'error', { detail: 'no TypeSafe API key (config.json typesafeApiKey or TYPESAFE_API_KEY)' })
    return
  }
  const run = await runner($)
  const text = turnText(rec, cfg.maxTurnChars)
  await bump($, s => ({ turns: s.turns + 1 }))
  const all = await latest(run)
  await laneGo($, 'out', 1, { detail: `${rec.tools.length} tool calls · ~${estTokens(text)} tok · worth remembering?` })
  const jev = await askJev($, cfg, key, { turn: text }, gateQuestions(all), cfg.gateTimeoutMs)
  if (!jev.ok) throw new Error(`gate: ${jev.error}`)
  const worth = jev.nouls.worth ?? 0
  const t = await $.clock.now()
  if (worth < cfg.worthThreshold) {
    await point($, { kind: 'out', t, worth, jevMs: jev.ms, saved: 0 })
    await bump($, s => ({ gatedOut: s.gatedOut + 1 }))
    await laneEnd($, 'out', 'skip', { nouls: jev.nouls, detail: `not worth saving (${Math.round(worth * 100)}% < ${Math.round(cfg.worthThreshold * 100)}%)` })
    await log($, 'skip', `gated out ${Math.round(worth * 100)}%: ${rec.prompt.replace(/\s+/g, ' ').slice(0, 60)}`)
    return
  }
  const picked = pickTypes(jev.nouls, cfg.typeThreshold)
  await laneGo($, 'out', 2, { nouls: jev.nouls, detail: `Haiku editing: ${picked.join(', ') || 'any type'}` })
  // Haiku sees the flagged docs, or every doc when Jev flagged none.
  const docs = all.filter(d => picked.length === 0 || picked.includes(d.name))
  const p = haikuPrompt(text, picked, docs, all, cfg.maxLines, cfg.maxTypes)
  const r = await $.model.complete({ model: cfg.haikuModel, system: p.system, prompt: p.prompt, maxTokens: 1500 })
  if (!r.isAnswered) throw new Error(`haiku: ${r.reason}`)
  const ex = parseHaiku(r.text, { existing: all.map(a => a.name), maxTypes: cfg.maxTypes })
  if (ex === undefined) throw new Error(`haiku: unparseable reply: ${r.text.slice(0, 120)}`)
  for (const d of ex.dropped) await log($, 'skip', `new type "${d.name}" dropped: ${d.reason}`)

  await laneGo($, 'out', 3, { detail: 'writing new versions' })
  for (const nt of ex.newTypes) {
    await addType(run, nt)
    await log($, 'type', `new type: ${nt.name}`)
    $.ui.toast(`evolve: new note type "${nt.name}"`)
  }
  const saved: string[] = []
  for (const [type, ops] of Object.entries(ex.edits)) {
    const res = await apply(run, type, ops, cfg.maxLines)
    if (res === undefined) continue
    saved.push(`${type} v${res.version} +${res.added}/−${res.removed}`)
    await bump($, s => ({ saves: s.saves + 1, added: s.added + res.added, removed: s.removed + res.removed, conflicts: s.conflicts + res.conflicts }))
  }
  await refreshTypes($)
  await point($, { kind: 'out', t, worth, jevMs: jev.ms, saved: saved.length })
  if (saved.length === 0) {
    await laneEnd($, 'out', 'skip', { detail: 'Haiku found nothing new' })
    await log($, 'skip', `nothing new: ${rec.prompt.replace(/\s+/g, ' ').slice(0, 60)}`)
    return
  }
  await laneEnd($, 'out', 'done', { detail: `saved ${saved.join(' · ')}` })
  await log($, 'save', saved.join(' · '))
  $.ui.status(`evolve: saved ${saved.join(', ')}`)
}

function track($: EngineInterface, work: Promise<void>) {
  const p = work.catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    await bump($, s => ({ failures: s.failures + 1 })).catch(() => undefined)
    await laneEnd($, 'out', 'error', { detail: msg }).catch(() => undefined)
    await log($, 'error', msg).catch(() => undefined)
  })
  pending.add(p)
  void p.finally(() => pending.delete(p))
}

const META = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'evolve',
      description: 'Evolving memory: dashboard, on/off, status',
      argumentHint: '[on|off|status]',
    })
    try {
      const path = `${await dataDir($)}/config.json`
      if (!(await $.fs.exists(path))) await $.fs.write(path, JSON.stringify(DEFAULT_CONFIG, null, 2))
      const cfg = await loadConfig($, true)
      await refreshTypes($)
      $.ui.status(!cfg.enabled ? 'evolve: off' : (await apiKey($, cfg)) === '' ? 'evolve: no Jev key' : 'evolve: ready')
    } catch (err) {
      $.ui.toast(`evolve: ${err instanceof Error ? err.message : String(err)}`)
    }
    return next(e)
  })

  // Give extractions still running a chance to finish (the engine bounds this).
  on('session.end', async ($, e, next) => {
    clockTimer?.cancel()
    await Promise.allSettled([...pending])
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) return next(e)
    turn.prompt = turn.prompt === '' ? e.text : `${turn.prompt}\n${e.text}`
    let notes: string | undefined
    try {
      notes = await notesFor($, e.text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await laneEnd($, 'in', 'error', { detail: msg }).catch(() => undefined)
      await log($, 'error', `inject: ${msg}`)
    }
    return next(notes === undefined ? e : { ...e, context: [...(e.context ?? []), notes] })
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      const input: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) if (!META.has(k)) input[k] = v
      turn.tools.push({
        tool: String(e.tool),
        input: JSON.stringify(input),
        result: ran.deny !== undefined ? `denied: ${ran.deny}` : (ran.text ?? ''),
        isError: ran.deny !== undefined || ran.isError === true,
      })
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const rec: TurnRecord = { ...turn, answer: e.answer }
      turn = { prompt: '', tools: [], answer: '' }
      if (e.reason === 'answer' && rec.prompt.trim() !== '') {
        track($, extract($, rec))
        // Headless (`claude -p`): the process exits right after, and session.end's budget is short.
        if ((await $.session.surfaces()).length === 0) await Promise.allSettled([...pending])
      }
    }
    return next(e)
  })

  on('command.run', { command: 'evolve' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0] ?? ''
    const path = `${await dataDir($)}/config.json`
    if (sub === 'on' || sub === 'off') {
      let raw: Record<string, unknown> = {}
      try {
        raw = JSON.parse(await $.fs.read(path))
      } catch {
        raw = { ...DEFAULT_CONFIG } // missing or unreadable: start from defaults
      }
      await $.fs.write(path, JSON.stringify({ ...raw, enabled: sub === 'on' }, null, 2))
      await loadConfig($, true)
      $.ui.status(sub === 'on' ? 'evolve: ready' : 'evolve: off')
      return { text: `evolve ${sub}.` }
    }
    if (sub === 'status') {
      const cfg = await loadConfig($, true)
      const docs = await latest(await runner($))
      const s = await read($, stats)
      return {
        text: [
          `${cfg.enabled ? 'ON' : 'OFF'} · Jev key: ${(await apiKey($, cfg)) === '' ? 'MISSING' : 'ok'} · haiku: ${cfg.haikuModel}`,
          `db: ${cfg.dbPath || `${await dataDir($)}/evolve.db`}`,
          ...docs.map(d => `  ${d.name}: v${d.version}, ${d.content === '' ? 0 : d.content.split('\n').length} lines, ~${estTokens(d.content)} tok`),
          `session: ${s.turns} turns, ${s.saves} saves, ${s.gatedOut} gated out, ${s.failures} failures`,
          `config: ${path}`,
        ].join('\n'),
      }
    }
    await refreshTypes($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: 'Evolve' })
    await animate($, 1500)
    // Keeps "Ns ago" labels fresh while the pane is open.
    clockTimer ??= $.clock.every(5000, () => void update($, frame, n => n + 1).catch(() => undefined))
    return { text: 'Evolve dashboard opened. /evolve status prints the docs.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const cfg = await loadConfig($)
    return Dashboard({
      ui: $.ui.resolve(e),
      width: e.props.bodyColumns ?? 60,
      enabled: cfg.enabled,
      laneIn: await read($, laneIn),
      laneOut: await read($, laneOut),
      injected: await read($, injected),
      types: await read($, typesAtom),
      log: await read($, logAtom),
      history: await read($, history),
      stats: await read($, stats),
      maxLines: cfg.maxLines,
      worthThreshold: cfg.worthThreshold,
      frame: await read($, frame),
      now: await $.clock.now(),
    })
  })
}
