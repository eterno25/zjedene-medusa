export type IdFilter =
  | string
  | string[]
  | { $eq?: string; $in?: string[] }
  | null
  | undefined

/**
 * AND-compose a caller-supplied `id` filter with a pre-resolved id list so the
 * delivery-date filter narrows results like every other orders-list filter
 * (intersection = AND) instead of overwriting the caller's `id`.
 *
 * Handles the id shapes that carry a positive membership constraint (plain
 * string, string[], `{ $eq }`, `{ $in }`). For any other shape (`$ne`,
 * `$like`, …) it can't cheaply intersect, so it returns `resolved` unchanged.
 * ponytail: covers the positive-constraint id shapes; no orders-list UI path
 * produces an exotic operator-map `id` today — extend if one ever needs AND.
 */
export function intersectIds(existing: IdFilter, resolved: string[]): string[] {
  const allowed = allowedIds(existing)
  if (allowed === null) {
    return resolved
  }
  const set = new Set(allowed)
  return resolved.filter((id) => set.has(id))
}

function allowedIds(existing: IdFilter): string[] | null {
  if (existing == null) {
    return null
  }
  if (typeof existing === "string") {
    return [existing]
  }
  if (Array.isArray(existing)) {
    return existing
  }
  if (typeof existing.$eq === "string") {
    return [existing.$eq]
  }
  if (Array.isArray(existing.$in)) {
    return existing.$in
  }
  return null
}
