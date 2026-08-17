/**
 * Inclusive calendar-day windows used after topic searches (local crop)
 * and as Crossref from-pub-date bounds when an ORCID is present.
 * @module @amphilagus/dsh-literature/engine/dates
 */

/** Inclusive UTC window covering the last `days` calendar days, ending today. */
export function recentWindow(days: number): { start: string; end: string } {
  const span = Math.max(1, Math.trunc(days))
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - (span - 1) * 86_400_000).toISOString().slice(0, 10)
  return { start, end }
}

function lastDayOfMonth(yearMonth: string): string {
  const year = Number(yearMonth.slice(0, 4))
  const month = Number(yearMonth.slice(5, 7))
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${yearMonth}-${String(last).padStart(2, '0')}`
}

/**
 * True when the publication date overlaps [start, end].
 * Year-only (`2026`) and year-month (`2026-08`) Crossref dates are compared
 * at the precision they carry; missing dates are out.
 */
export function isInDateWindow(publicationDate: string | null, start: string, end: string): boolean {
  if (publicationDate === null) return false
  const raw = publicationDate.length >= 10 ? publicationDate.slice(0, 10) : publicationDate
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw >= start && raw <= end
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const monthStart = `${raw}-01`
    const monthEnd = lastDayOfMonth(raw)
    return monthStart <= end && monthEnd >= start
  }
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01` <= end && `${raw}-12-31` >= start
  return false
}
