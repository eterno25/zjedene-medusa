export type DeliveryDateFilterInput =
  | { count: number }
  | { $gte?: string; $lte?: string; $gt?: string; $lt?: string }

export type DeliveryDateSql = {
  clause: string
  bindings: (string | number)[]
}

const COL = "metadata->'delivery_dates'"

/**
 * Build a raw SQL WHERE fragment matching orders by their
 * `metadata.delivery_dates` JSON array. Guarded by `jsonb_typeof = 'array'`
 * so malformed metadata never errors. Returns null when the input carries no
 * usable constraint (e.g. an empty range) — the caller should then match
 * nothing.
 */
export function buildDeliveryDateFilterSql(
  input: DeliveryDateFilterInput
): DeliveryDateSql | null {
  if ("count" in input && input.count != null) {
    return {
      clause: `jsonb_typeof(${COL}) = 'array' AND jsonb_array_length(${COL}) = ?`,
      bindings: [input.count],
    }
  }

  const from = input.$gte?.slice(0, 10)
  const to = input.$lte?.slice(0, 10)

  const conds: string[] = []
  const bindings: string[] = []
  if (from) {
    conds.push("elem.val::date >= ?::date")
    bindings.push(from)
  }
  if (to) {
    conds.push("elem.val::date <= ?::date")
    bindings.push(to)
  }
  if (!conds.length) {
    return null
  }

  return {
    clause:
      `jsonb_typeof(${COL}) = 'array' AND EXISTS (` +
      `SELECT 1 FROM jsonb_array_elements_text(${COL}) AS elem(val) ` +
      `WHERE ${conds.join(" AND ")})`,
    bindings,
  }
}
