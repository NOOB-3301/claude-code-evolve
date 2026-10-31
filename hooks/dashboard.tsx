import type { EngineInterface, RenderChildren } from 'claude-code'

import type { Injected, Lane, LogEntry, Point, Stats, TypeRow } from '../types'
import { brailleGrid, colorRuns, sparkline } from './charts'

type UI = ReturnType<EngineInterface['ui']['resolve']>

const C = {
  user: '#38bdf8',
  db: '#2dd4bf',
  jev: '#fbbf24',
  haiku: '#a78bfa',
  inject: '#4ade80',
  ok: '#4ade80',
  bad: '#f87171',
  line: '#475569',
  muted: '#94a3b8',
  text: '#e2e8f0',
  ink: '#0f172a',
}
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const NODES = {
  in: [
    { label: 'YOU', color: C.user },
    { label: 'DB', color: C.db },
    { label: 'JEV', color: C.jev },
    { label: 'INJECT', color: C.inject },
  ],
  out: [
    { label: 'TURN', color: C.user },
    { label: 'JEV', color: C.jev },
    { label: 'HAIKU', color: C.haiku },
    { label: 'DB', color: C.db },
  ],
} as const

export type DashboardInput = {
  ui: UI
  width: number
  enabled: boolean
  laneIn: Lane | null
  laneOut: Lane | null
  injected: Injected | null
  types: readonly TypeRow[]
  log: readonly LogEntry[]
  history: readonly Point[]
  stats: Stats
  maxLines: number
  worthThreshold: number
  frame: number
  now: number
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)
const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)
const ease = (x: number) => 1 - (1 - Math.max(0, Math.min(1, x))) ** 3

/** Called as a function, not mounted: the engine's `h` draws its own elements only. */
export function Dashboard(d: DashboardInput) {
  const { Box, Text } = d.ui
  const W = Math.max(44, d.width)
  const s = d.stats
  const busy = (d.laneIn?.status === 'run') || (d.laneOut?.status === 'run')

  // ── Pipeline: nodes joined by tracks; a packet travels into the active node ──
  const pipeline = (title: string, flow: 'in' | 'out', lane: Lane | null, idle: string) => {
    const nodes = NODES[flow]
    const cellW = nodes.map(n => n.label.length + 3) // glyph + space + label + space
    const seg = Math.max(3, Math.floor((W - 6 - cellW.reduce((a, b) => a + b, 0)) / (nodes.length - 1)))
    const stage = lane?.stage ?? -1
    const status = lane?.status
    const stageAge = lane === null ? 1e9 : d.now - lane.stageT
    const runAge = lane === null ? 1e9 : d.now - lane.t

    const parts: RenderChildren[] = []
    nodes.forEach((n, i) => {
      if (i > 0) {
        const reached = i <= stage
        const travelling = reached && i === stage && status === 'run' && stageAge < 450
        const color = nodes[i - 1]!.color
        if (travelling) {
          const pos = Math.min(seg - 1, Math.floor((stageAge / 450) * seg))
          parts.push(<Text color={color}>{'━'.repeat(pos)}</Text>)
          parts.push(<Text color={C.text} bold>●</Text>)
          parts.push(<Text color={C.line}>{'┄'.repeat(Math.max(0, seg - pos - 1))}</Text>)
        } else if (reached) {
          parts.push(<Text color={color}>{'━'.repeat(seg - 1)}▸</Text>)
        } else {
          parts.push(<Text color={C.line}>{'┄'.repeat(seg)}</Text>)
        }
      }
      const done = i < stage || (i === stage && status === 'done')
      if (i === stage && status === 'run')
        parts.push(<Text color={C.ink} backgroundColor={n.color} bold>{`${SPIN[d.frame % SPIN.length]} ${n.label} `}</Text>)
      else if (i === stage && status === 'error') parts.push(<Text color={C.bad} bold>{`✕ ${n.label} `}</Text>)
      else if (i === stage && status === 'skip') parts.push(<Text color={C.muted}>{`◌ ${n.label} `}</Text>)
      else if (done) parts.push(<Text color={n.color} bold>{`● ${n.label} `}</Text>)
      else parts.push(<Text color={C.line}>{`○ ${n.label} `}</Text>)
    })

    // Latency under each node, aligned to its cell.
    let msRow = ''
    nodes.forEach((n, i) => {
      if (i > 0) msRow += ' '.repeat(seg)
      const ms = lane?.ms[i]
      msRow += (ms === null || ms === undefined || i === 0 ? '' : fmtMs(ms)).padEnd(cellW[i]!)
    })

    const typed = lane === null ? '' : lane.text.replace(/\s+/g, ' ').slice(0, Math.max(1, Math.floor(runAge / 8)))
    const isTyping = lane !== null && runAge < lane.text.length * 8

    return (
      <Box borderStyle="round" borderColor={status === 'run' ? nodes[Math.max(0, stage)]!.color : C.line} flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{title}</Text>
          <Text color={C.muted}>{lane === null ? '' : `${ago(d.now, lane.t)} ago`}</Text>
        </Box>
        {lane === null ? (
          <Text color={C.muted}>{idle}</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text color={C.user}>› </Text>
              <Text color={C.text}>{cut(typed, W - 8)}</Text>
              {isTyping && <Text color={C.user}>▌</Text>}
            </Text>
            <Text>{parts}</Text>
            <Text color={C.line}>{msRow}</Text>
            {lane.nouls !== undefined && nouls(lane, d.worthThreshold, stageAge, W)}
            {flow === 'in' && lane.status === 'done' && d.injected !== null && d.injected.types.length > 0 && (
              <Text>
                <Text color={C.muted}>injected </Text>
                {d.injected.types.map(t => (
                  <Text>
                    <Text color={C.ink} backgroundColor={C.inject}>{` ${t.name} `}</Text>
                    <Text color={C.muted}>{` ~${t.tokens}${t.trimmed ? '✂' : ''}  `}</Text>
                  </Text>
                ))}
                <Text color={C.inject} bold>{`= ~${d.injected.total} tok`}</Text>
              </Text>
            )}
            {lane.detail !== undefined && (
              <Text color={lane.status === 'error' ? C.bad : lane.status === 'done' ? C.ok : C.muted}>
                {cut(lane.detail, W * 2)}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  }

  // Jev's probabilities as bars that grow in.
  const nouls = (lane: Lane, threshold: number, age: number, w: number) => {
    const entries = Object.entries(lane.nouls ?? {})
      .sort((a, b) => (a[0] === 'worth' ? -1 : b[0] === 'worth' ? 1 : b[1] - a[1]))
      .slice(0, 5)
    const bw = Math.max(6, Math.min(24, w - 34))
    const grow = ease(age / 700)
    return (
      <Box flexDirection="column">
        {entries.map(([k, v]) => {
          const n = Math.round(v * bw * grow)
          const pass = v >= threshold
          const color = k === 'worth' ? C.jev : C.haiku
          return (
            <Text>
              <Text color={k === 'worth' ? C.text : C.muted} bold={k === 'worth'}>{cut(k.replace(/^t:/, ''), 18).padEnd(19)}</Text>
              <Text color={pass ? color : C.line}>{'█'.repeat(n)}</Text>
              <Text color={C.line}>{'░'.repeat(bw - n)}</Text>
              <Text color={pass ? color : C.muted}>{` ${Math.round(v * 100)}%`.padStart(5)}</Text>
              <Text color={pass ? C.ok : C.line}>{pass ? ' ✓' : ''}</Text>
            </Text>
          )
        })}
      </Box>
    )
  }

  // ── Header ──
  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text color={C.haiku} bold>◆ EVOLVE</Text>
        <Text color={C.muted}>  memory that learns every turn</Text>
      </Text>
      {d.enabled ? (
        <Text color={C.ok} bold>{busy && d.frame % 2 === 0 ? '◉' : '●'} ON</Text>
      ) : (
        <Text color={C.muted}>○ OFF · /evolve on</Text>
      )}
    </Box>
  )

  // ── KPI tiles ──
  const totalLines = d.types.reduce((n, t) => n + t.lines, 0)
  const gates = s.turns
  const passRate = gates === 0 ? 0 : Math.round(((gates - s.gatedOut) / gates) * 100)
  const tileW = Math.max(9, Math.floor((W - 3) / 4))
  const tile = (label: string, value: string, sub: string, color: string) => (
    <Box borderStyle="round" borderColor={C.line} flexDirection="column" width={tileW} paddingX={1}>
      <Text color={C.muted}>{label}</Text>
      <Text color={color} bold>{value}</Text>
      <Text color={C.line}>{cut(sub, tileW - 4)}</Text>
    </Box>
  )
  const kpis = (
    <Box flexDirection="row" columnGap={1}>
      {tile('NOTES', String(totalLines), `${d.types.length} types`, C.text)}
      {tile('SAVES', String(s.saves), `+${s.added} −${s.removed}`, C.ok)}
      {tile('GATE PASS', gates === 0 ? '—' : `${passRate}%`, `${gates - s.gatedOut}/${gates} turns`, C.jev)}
      {tile('AVG INJECT', s.injects === 0 ? '—' : `~${Math.round(s.injectTokens / s.injects)}`, 'tokens / prompt', C.inject)}
    </Box>
  )

  // ── Charts ──
  const ins = d.history.filter((p): p is Extract<Point, { kind: 'in' }> => p.kind === 'in')
  const outs = d.history.filter((p): p is Extract<Point, { kind: 'out' }> => p.kind === 'out')
  const chartCols = W - 12
  const tokSeries = [0, ...ins.map(p => p.tokens)]
  const { masks, max } = brailleGrid([tokSeries], chartCols, 4)
  const lastTok = ins[ins.length - 1]?.tokens
  const sparkW = Math.max(8, W - 34)
  const jevMs = d.history.map(p => p.jevMs)
  const worth = outs.map(p => p.worth)
  const charts = (
    <Box borderStyle="round" borderColor={C.line} flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Injected tokens per prompt</Text>
        <Text color={C.inject}>{lastTok === undefined ? 'no prompts yet' : `last ~${lastTok} · peak ~${Math.round(max)}`}</Text>
      </Box>
      {[0, 1, 2, 3].map(r => (
        <Text>
          <Text color={C.line}>{(r === 0 ? `${Math.round(max)}` : r === 3 ? '0' : '').padStart(6)} ┤</Text>
          {colorRuns(masks, r, [C.inject], C.line).map(run => <Text color={run.color}>{run.text}</Text>)}
        </Text>
      ))}
      <Text> </Text>
      <Text>
        <Text color={C.muted}>{'Jev latency'.padEnd(14)}</Text>
        <Text color={C.jev}>{jevMs.length === 0 ? '·'.repeat(sparkW) : sparkline(jevMs, sparkW)}</Text>
        <Text color={C.muted}>{jevMs.length === 0 ? '' : `  ${fmtMs(jevMs[jevMs.length - 1]!)}`}</Text>
      </Text>
      <Text>
        <Text color={C.muted}>{'Worth saving'.padEnd(14)}</Text>
        {worth.length === 0 ? (
          <Text color={C.line}>{'·'.repeat(sparkW)}</Text>
        ) : (
          sparkline(worth, sparkW, 1).split('').map((ch, i, arr) => {
            const v = worth[Math.round((i * (worth.length - 1)) / Math.max(1, arr.length - 1))] ?? 0
            return <Text color={v >= d.worthThreshold ? C.haiku : C.line}>{ch}</Text>
          })
        )}
        <Text color={C.muted}>{worth.length === 0 ? '' : `  ${Math.round(worth[worth.length - 1]! * 100)}%`}</Text>
      </Text>
    </Box>
  )

  // ── Note types: fill bars; a doc that just changed flashes and grows ──
  const nameW = Math.min(20, Math.max(10, ...d.types.map(t => t.name.length)))
  const barW = Math.max(6, W - nameW - 26)
  const typesBox = (
    <Box borderStyle="round" borderColor={C.line} flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Memory docs</Text>
        <Text color={C.muted}>{`lines / ${d.maxLines}`}</Text>
      </Box>
      {d.types.map(t => {
        const fresh = d.now - t.changedAt < 4000
        const fill = Math.round((t.lines / d.maxLines) * barW * (fresh ? ease((d.now - t.changedAt) / 900) : 1))
        const full = t.lines >= d.maxLines * 0.9
        const color = fresh ? C.ok : full ? C.jev : C.haiku
        return (
          <Text>
            <Text color={fresh ? C.ok : t.lines === 0 ? C.line : C.text} bold={fresh}>{cut(t.name, nameW).padEnd(nameW + 1)}</Text>
            <Text color={color}>{'▰'.repeat(fill)}</Text>
            <Text color={C.line}>{'▱'.repeat(Math.max(0, barW - fill))}</Text>
            <Text color={C.muted}>{` ${String(t.lines).padStart(2)} v${t.version}`.padEnd(8)}</Text>
            <Text color={C.line}>{`~${t.tokens}t`.padStart(6)}</Text>
            <Text color={C.ok} bold>{fresh ? (d.frame % 4 < 2 ? ' ✦' : ' ✧') : ''}</Text>
          </Text>
        )
      })}
    </Box>
  )

  // ── Activity ──
  const ICON: Record<LogEntry['kind'], { icon: string; color: string }> = {
    inject: { icon: '↓', color: C.inject },
    save: { icon: '✚', color: C.ok },
    skip: { icon: '·', color: C.line },
    error: { icon: '✕', color: C.bad },
    type: { icon: '★', color: C.haiku },
  }
  const activity = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Activity</Text>
        <Text color={s.failures > 0 ? C.bad : C.line}>{`conflicts ${s.conflicts} · failures ${s.failures}`}</Text>
      </Box>
      {d.log.length === 0 && <Text color={C.muted}>Nothing yet. Tell Claude a preference or correct it.</Text>}
      {d.log
        .slice(-6)
        .reverse()
        .map(l => (
          <Text>
            <Text color={C.line}>{ago(d.now, l.t).padStart(4)} </Text>
            <Text color={ICON[l.kind].color} bold>{ICON[l.kind].icon} </Text>
            <Text color={l.kind === 'skip' ? C.muted : C.text}>{cut(l.text, W - 9)}</Text>
          </Text>
        ))}
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      {header}
      {pipeline('Input  ·  prompt → notes', 'in', d.laneIn, 'Send a message: it flows through the db and Jev here.')}
      {pipeline('Output  ·  turn → memory', 'out', d.laneOut, 'When a turn ends, Jev decides if it is worth remembering.')}
      {kpis}
      {charts}
      {typesBox}
      {activity}
    </Box>
  )
}
