// Terminal chart helpers (adapted from jev-router's charts.ts).
const SPARKS = '▁▂▃▄▅▆▇█'
// Braille dot bits by [row][column] inside one 2x4 cell.
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

/** Picks `n` evenly spaced values (last one kept) so a series fits the width. */
export function resample(values: readonly number[], n: number): number[] {
  if (values.length === 0 || n <= 0) return []
  if (values.length <= n) return [...values]
  return Array.from({ length: n }, (_, i) => values[Math.round((i * (values.length - 1)) / (n - 1 || 1))] ?? 0)
}

/** Linear interpolation to exactly `n` points, so a short series spans the chart. */
export function stretch(values: readonly number[], n: number): number[] {
  if (values.length === 0 || n <= 0) return []
  if (values.length === 1) return new Array<number>(n).fill(values[0]!)
  if (values.length >= n) return resample(values, n)
  return Array.from({ length: n }, (_, i) => {
    const x = (i * (values.length - 1)) / (n - 1)
    const lo = Math.floor(x)
    const a = values[lo] ?? 0
    const b = values[Math.min(values.length - 1, lo + 1)] ?? a
    return a + (b - a) * (x - lo)
  })
}

/** Sparkline scaled to [0, max] (max defaults to the series' own). */
export function sparkline(values: readonly number[], width: number, max?: number): string {
  const v = resample(values, width)
  const top = max ?? Math.max(...v, 1e-9)
  return v.map(x => SPARKS[Math.max(0, Math.min(7, Math.round((x / top) * 7)))]).join('')
}

/** Braille line chart: per-series bitmasks, `rows` x `cols`, all scaled to one max. */
export function brailleGrid(series: readonly (readonly number[])[], cols: number, rows: number, maxHint = 0) {
  const max = Math.max(1e-9, maxHint, ...series.flat())
  const h = rows * 4
  const masks = series.map(values => {
    const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
    const pts = stretch(values, cols * 2)
    let prev: number | undefined
    pts.forEach((v, x) => {
      const y = h - 1 - Math.round((v / max) * (h - 1))
      // Fill the vertical gap to the previous point so the line stays joined.
      const lo = prev === undefined ? y : Math.min(prev, y)
      const hi = prev === undefined ? y : Math.max(prev, y)
      for (let yy = lo; yy <= hi; yy++) {
        const row = grid[Math.floor(yy / 4)]
        const bit = DOTS[yy % 4]?.[x % 2]
        if (row !== undefined && bit !== undefined) row[Math.floor(x / 2)] = (row[Math.floor(x / 2)] ?? 0) | bit
      }
      prev = y
    })
    return grid
  })
  return { masks, max }
}

/** Splits a row into runs of one color: the first series with a dot in a cell owns it. */
export function colorRuns(masks: number[][][], row: number, colors: readonly string[], empty: string) {
  const runs: { text: string; color: string }[] = []
  const cols = masks[0]?.[row]?.length ?? 0
  for (let c = 0; c < cols; c++) {
    let bits = 0
    let color = empty
    masks.forEach((m, i) => {
      const b = m[row]?.[c] ?? 0
      if (b !== 0 && color === empty) color = colors[i] ?? empty
      bits |= b
    })
    const ch = bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits)
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.text += ch
    else runs.push({ text: ch, color })
  }
  return runs
}
