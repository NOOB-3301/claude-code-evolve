// Pure logic: config, scrubbing, Jev request/response, Haiku prompt/parse, doc edits.

export type Config = {
  enabled: boolean
  /** Empty: TYPESAFE_API_KEY, then jev-router's config key. */
  typesafeApiKey: string
  baseUrl: string
  jevModel: string
  timeoutMs: number
  /** The end-of-turn gate runs in the background, so it can wait longer. */
  gateTimeoutMs: number
  haikuModel: string
  worthThreshold: number
  typeThreshold: number
  maxLines: number
  /** Hard cap on note types, so the user's ontology stays small. */
  maxTypes: number
  maxInjectTokens: number
  maxTurnChars: number
  /** Empty: ~/.claude/evolve/evolve.db */
  dbPath: string
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  typesafeApiKey: '',
  baseUrl: 'https://api.typesafe.ai',
  jevModel: 'jev-latest',
  timeoutMs: 2500,
  gateTimeoutMs: 20000,
  haikuModel: 'claude-haiku-5-5',
  worthThreshold: 0.5,
  typeThreshold: 0.5,
  maxLines: 30,
  maxTypes: 8,
  maxInjectTokens: 1500,
  maxTurnChars: 12000,
  dbPath: '',
}

export function mergeConfig(raw: unknown): Config {
  const cfg: Config = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object' || raw === null) return cfg
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(cfg) as (keyof Config)[]) {
    if (typeof r[k] === typeof cfg[k]) (cfg as Record<string, unknown>)[k] = r[k]
  }
  return cfg
}

export const SEED_TYPES: [string, string][] = [
  ['preference', 'User tooling, workflow and style preferences (package manager, formatting, tone, what they dislike)'],
  ['project_convention', 'Lasting facts and conventions about a codebase: layout, commands, frameworks, rules'],
  ['mistake', 'Errors the agent made or hit, and the fix that worked, so they are not repeated'],
  ['tool_quirk', 'Surprising behaviour of tools, CLIs, APIs or the environment and how to work around it'],
]

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[KEY]'],
  [/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '[KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT]'],
  [/(bearer|token|authorization)(["'\s:=]+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1$2[REDACTED]'],
  [/\b([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']+/g, '$1=[REDACTED]'],
]

/** Removes likely secrets before anything leaves the machine. */
export function scrub(text: string): string {
  let out = text
  for (const [re, rep] of SECRETS) out = out.replace(re, rep)
  return out
}

export const estTokens = (s: string) => Math.ceil(s.length / 4)

export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return `${s.slice(0, half)}\n…[${s.length - max} chars cut]…\n${s.slice(-half)}`
}

export type TurnRecord = {
  prompt: string
  tools: { tool: string; input: string; result: string; isError: boolean }[]
  answer: string
}

export function turnText(t: TurnRecord, max: number): string {
  const lines = [`USER: ${clip(t.prompt, 3000)}`]
  for (const c of t.tools)
    lines.push(`TOOL ${c.tool} ${clip(c.input, 400)}\n  → ${c.isError ? '[ERROR] ' : ''}${clip(c.result, 1200)}`)
  lines.push(`ASSISTANT: ${clip(t.answer, 3000)}`)
  return scrub(clip(lines.join('\n'), max))
}

export type TypeInfo = { name: string; description: string }

const typeQ = (t: TypeInfo, why: string) => ({
  type: 'noul',
  instructions: `${why} Category "${t.name}": ${t.description}`,
})

/** End of turn: one question for "worth saving" plus one per type. */
export function gateQuestions(types: readonly TypeInfo[]): Record<string, unknown> {
  const q: Record<string, unknown> = {
    worth: {
      type: 'noul',
      instructions:
        'This coding-agent turn contains a durable lesson worth remembering in future sessions: a user correction or stated preference, an error and the fix that worked, a surprising tool behaviour, or a lasting fact about the project. Routine task details, one-off questions and chit-chat do not count.',
    },
  }
  for (const t of types) q[`t:${t.name}`] = typeQ(t, 'This turn holds a lesson that belongs in this note category.')
  return q
}

/** New prompt: one question per type that has notes. */
export function classifyQuestions(types: readonly TypeInfo[]): Record<string, unknown> {
  const q: Record<string, unknown> = {}
  for (const t of types)
    q[`t:${t.name}`] = typeQ(t, 'Notes in this category would help the agent handle this user request.')
  return q
}

export type JevAnswer =
  | { ok: true; nouls: Record<string, number>; inputTokens: number }
  | { ok: false; error: string }

export function parseJev(body: string): JevAnswer {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'response is not JSON' }
  }
  const j = json as { answers?: Record<string, { noul?: unknown }>; usage?: { input_tokens?: unknown } }
  if (typeof j?.answers !== 'object' || j.answers === null) return { ok: false, error: 'no answers' }
  const nouls: Record<string, number> = {}
  for (const [k, v] of Object.entries(j.answers)) if (typeof v?.noul === 'number') nouls[k] = v.noul
  return { ok: true, nouls, inputTokens: typeof j.usage?.input_tokens === 'number' ? j.usage.input_tokens : 0 }
}

export const pickTypes = (nouls: Record<string, number>, threshold: number) =>
  Object.entries(nouls)
    .filter(([k, v]) => k.startsWith('t:') && v >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k.slice(2))

export type Doc = { name: string; description: string; content: string }

export function haikuPrompt(
  turn: string,
  picked: readonly string[],
  docs: readonly Doc[],
  allTypes: readonly TypeInfo[],
  maxLines: number,
  maxTypes: number,
): { system: string; prompt: string } {
  const slots = Math.max(0, Math.min(MAX_NEW_TYPES_PER_TURN, maxTypes - allTypes.length))
  const system = [
    'You maintain a coding agent\'s long-term memory: one short doc of bullet points per note type.',
    'Read the turn and update the docs with durable lessons only (corrections, preferences, error→fix, tool quirks, lasting project facts). Skip one-off task details.',
    'Rules:',
    '- Reply with JSON only, no prose, no code fence: {"new_types":[{"name":"snake_case","description":"..."}],"edits":{"<type>":{"add":["- point"],"remove":["- exact existing line"]}}}',
    '- Never write notes about this memory system, the <evolved-memory> block, or notes being stale; when the user corrects a preference, just update that preference.',
    '- The note types are a fixed, small ontology. Put a lesson into an existing type whenever it reasonably fits, even if the fit is loose. The default is no new type.',
    `- A new type is allowed only if (a) no existing type can hold the lesson, and (b) it is a broad, lasting category of the user's work (for example "deployment" or "testing"), not a topic, a single tool or a single fact. Do not create a type for one lesson; the lesson goes into the closest existing type.`,
    `- You may add at most ${slots} new type${slots === 1 ? '' : 's'} in this reply${slots === 0 ? ', so put every lesson into an existing type' : ''}.`,
    '- Type names: lowercase snake_case noun, one or two words. Never reuse a name that already exists.',
    '- Each point is one line starting with "- ", short and specific, written so it helps a future session.',
    '- To change a point: remove the old line (copied EXACTLY) and add the new one. Never repeat an existing point.',
    `- A doc holds at most ${maxLines} lines; near the limit, merge or remove stale points.`,
    '- Nothing worth saving: {"new_types":[],"edits":{}}',
  ].join('\n')
  const docText = docs
    .map(d => `## ${d.name} (${d.content === '' ? 0 : d.content.split('\n').length}/${maxLines} lines) — ${d.description}\n${d.content || '(empty)'}`)
    .join('\n\n')
  const prompt = [
    `All note types: ${allTypes.map(t => t.name).join(', ')}`,
    `Types a classifier flagged for this turn: ${picked.join(', ') || '(none)'}`,
    '',
    'Current docs:',
    docText || '(none)',
    '',
    '<turn>',
    turn,
    '</turn>',
  ].join('\n')
  return { system, prompt }
}

export type Edits = Record<string, { add: string[]; remove: string[] }>
export type Extraction = { newTypes: TypeInfo[]; edits: Edits; dropped: { name: string; reason: string }[] }

const TYPE_NAME = /^[a-z][a-z0-9_]{1,39}$/
const strs = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []

/** Most new types one turn may add; growth stays slow and reviewable. */
export const MAX_NEW_TYPES_PER_TURN = 1

export type TypeLimits = { existing: readonly string[]; maxTypes: number }

export function parseHaiku(text: string, limits?: TypeLimits): Extraction | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  const j = json as { new_types?: unknown; edits?: unknown }
  const newTypes: TypeInfo[] = []
  if (Array.isArray(j.new_types))
    for (const t of j.new_types) {
      const name = typeof t?.name === 'string' ? t.name.trim().toLowerCase() : ''
      const description = typeof t?.description === 'string' ? t.description.trim() : ''
      if (TYPE_NAME.test(name) && description !== '') newTypes.push({ name, description })
    }
  const edits: Edits = {}
  if (typeof j.edits === 'object' && j.edits !== null)
    for (const [k, v] of Object.entries(j.edits as Record<string, unknown>)) {
      const name = k.trim().toLowerCase()
      const e = v as { add?: unknown; remove?: unknown }
      const add = strs(e?.add).map(l => (l.startsWith('- ') ? l : `- ${l.replace(/^-\s*/, '')}`))
      const remove = strs(e?.remove)
      if (TYPE_NAME.test(name) && (add.length > 0 || remove.length > 0)) edits[name] = { add, remove }
    }
  // Keep a new type only if it has notes, is not a duplicate, and fits the caps. Everything else is reported.
  const existing = new Set((limits?.existing ?? []).map(n => n.toLowerCase()))
  const room = limits ? Math.min(MAX_NEW_TYPES_PER_TURN, Math.max(0, limits.maxTypes - existing.size)) : Infinity
  const newTypesKept: TypeInfo[] = []
  const dropped: { name: string; reason: string }[] = []
  for (const t of newTypes) {
    if (existing.has(t.name)) dropped.push({ name: t.name, reason: 'already exists' })
    else if ((edits[t.name]?.add.length ?? 0) === 0) dropped.push({ name: t.name, reason: 'no notes written into it' })
    else if (newTypesKept.length >= room) dropped.push({ name: t.name, reason: 'type cap reached' })
    else newTypesKept.push(t)
  }
  return { newTypes: newTypesKept, edits, dropped }
}

/** Applies explicit removes (exact line match) then adds; keeps the newest `cap` lines. */
export function applyEdits(content: string, ops: { add: string[]; remove: string[] }, cap: number) {
  const before = content === '' ? [] : content.split('\n')
  const kept = before.filter(l => !ops.remove.includes(l))
  const added = ops.add.filter(l => !kept.includes(l))
  // shortcut: FIFO drops the oldest lines past the cap; upgrade to a Haiku compaction call if good notes get lost
  const lines = [...kept, ...added].slice(-cap)
  return { content: lines.join('\n'), added: added.length, removed: before.length - kept.length }
}

/** Builds the injected block, cutting the biggest doc first when over the token cap. */
export function formatInjection(docs: readonly Doc[], maxTokens: number) {
  const parts = docs.filter(d => d.content !== '').map(d => ({ name: d.name, lines: d.content.split('\n'), trimmed: false }))
  const size = () => parts.reduce((n, p) => n + estTokens(`## ${p.name}\n${p.lines.join('\n')}\n`), 0)
  while (size() > maxTokens) {
    const big = parts.reduce((a, b) => (b.lines.length > a.lines.length ? b : a), parts[0]!)
    if (big.lines.length <= 1) break
    big.lines = big.lines.slice(1) // oldest point goes first
    big.trimmed = true
  }
  const body = parts.map(p => `## ${p.name}\n${p.lines.join('\n')}`).join('\n')
  const text = parts.length === 0 ? '' :
    `<evolved-memory>\nNotes learned from earlier sessions with this user. Follow them unless the user says otherwise.\n${body}\n</evolved-memory>`
  return {
    text,
    types: parts.map(p => ({ name: p.name, tokens: estTokens(`## ${p.name}\n${p.lines.join('\n')}\n`), trimmed: p.trimmed })),
    total: estTokens(text),
  }
}
