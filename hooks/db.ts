// SQLite through the sqlite3 CLI: mods have no Node, so no driver.
import { applyEdits, SEED_TYPES } from './lib'
import type { TypeInfo } from './lib'

/** Runs SQL on the db; `json` asks for rows as a JSON array. */
export type Run = (sql: string, json?: boolean) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// Every value goes through q(): single quotes doubled, NULs dropped.
export const q = (s: string) => `'${s.replace(/\u0000/g, '').replace(/'/g, "''")}'`

async function exec(run: Run, sql: string): Promise<void> {
  const r = await run(sql)
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `sqlite3 exit ${r.exitCode}`)
}

async function rows<T>(run: Run, sql: string): Promise<T[]> {
  const r = await run(sql, true)
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `sqlite3 exit ${r.exitCode}`)
  return r.stdout.trim() === '' ? [] : (JSON.parse(r.stdout) as T[])
}

export async function init(run: Run): Promise<void> {
  await exec(
    run,
    `PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS note_types (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES note_types(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE (type_id, version)
);
${SEED_TYPES.map(([n, d]) => `INSERT OR IGNORE INTO note_types (name, description) VALUES (${q(n)}, ${q(d)});`).join('\n')}`,
  )
}

export type TypeDoc = TypeInfo & { version: number; content: string }

/** Every type with its latest doc (version 0 and '' when it has none). */
export function latest(run: Run): Promise<TypeDoc[]> {
  return rows<TypeDoc>(
    run,
    `SELECT t.name, t.description, COALESCE(n.version, 0) AS version, COALESCE(n.content, '') AS content
FROM note_types t
LEFT JOIN notes n ON n.type_id = t.id AND n.version = (SELECT MAX(version) FROM notes WHERE type_id = t.id)
ORDER BY t.id;`,
  )
}

export function addType(run: Run, t: TypeInfo): Promise<void> {
  return exec(run, `INSERT OR IGNORE INTO note_types (name, description) VALUES (${q(t.name)}, ${q(t.description)});`)
}

export type ApplyResult = { version: number; added: number; removed: number; conflicts: number } | undefined

/**
 * Writes one type's edits as a new version. On a version clash with another
 * session, re-reads the latest doc and re-applies the same edits (no new model call).
 */
export async function apply(
  run: Run,
  type: string,
  ops: { add: string[]; remove: string[] },
  cap: number,
): Promise<ApplyResult> {
  for (let conflicts = 0; conflicts < 3; conflicts++) {
    const cur = await rows<{ version: number; content: string }>(
      run,
      `SELECT COALESCE(MAX(n.version), 0) AS version,
  COALESCE((SELECT content FROM notes WHERE type_id = t.id ORDER BY version DESC LIMIT 1), '') AS content
FROM note_types t LEFT JOIN notes n ON n.type_id = t.id WHERE t.name = ${q(type)} GROUP BY t.id;`,
    )
    if (cur.length === 0) return undefined // unknown type
    const { version, content } = cur[0]!
    const next = applyEdits(content, ops, cap)
    if (next.content === content) return undefined // nothing changed
    const r = await run(
      `INSERT INTO notes (type_id, version, content) SELECT id, ${version + 1}, ${q(next.content)} FROM note_types WHERE name = ${q(type)};`,
    )
    if (r.exitCode === 0) return { version: version + 1, added: next.added, removed: next.removed, conflicts }
    if (!r.stderr.includes('UNIQUE')) throw new Error(r.stderr.trim() || `sqlite3 exit ${r.exitCode}`)
  }
  throw new Error(`version conflict x3 on ${type}`)
}
