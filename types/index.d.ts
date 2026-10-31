/** in: you → db → jev → inject.  out: turn → jev → haiku → db. */
export type Flow = 'in' | 'out'

export type LaneStatus = 'run' | 'done' | 'skip' | 'error'

/** One pipeline's latest run, as the dashboard animates it. */
export type Lane = {
  flow: Flow
  text: string
  /** Index of the node being worked on (run) or where it ended. */
  stage: number
  status: LaneStatus
  /** When the run started / when `stage` was entered. */
  t: number
  stageT: number
  /** Milliseconds each node took, by node index. */
  ms: (number | null)[]
  /** Jev's yes-probabilities: `worth` plus `t:<type>`. */
  nouls?: Record<string, number>
  detail?: string
}

export type InjectedType = { name: string; tokens: number; trimmed: boolean }

export type Injected = {
  t: number
  prompt: string
  types: InjectedType[]
  total: number
  cap: number
}

/** One note type with its latest doc's size; `changedAt` flashes the row. */
export type TypeRow = { name: string; version: number; lines: number; tokens: number; changedAt: number }

export type LogEntry = {
  t: number
  kind: 'inject' | 'save' | 'skip' | 'error' | 'type'
  text: string
}

/** One point per finished run, for the charts. */
export type Point =
  | { kind: 'in'; t: number; tokens: number; jevMs: number }
  | { kind: 'out'; t: number; worth: number; jevMs: number; saved: number }

export type Stats = {
  turns: number
  gatedOut: number
  saves: number
  added: number
  removed: number
  conflicts: number
  failures: number
  injects: number
  injectTokens: number
}

declare module 'claude-code' {
  interface PluginState {
    evolve: {
      laneIn: Lane | null
      laneOut: Lane | null
      injected: Injected | null
      types: TypeRow[]
      log: LogEntry[]
      history: Point[]
      stats: Stats
      frame: number
    }
  }
}
