import { buildDeliveryDateFilterSql } from "../delivery-date-filter"

describe("buildDeliveryDateFilterSql", () => {
  it("count bucket → array_length equality guarded by jsonb_typeof", () => {
    const r = buildDeliveryDateFilterSql({ count: 3 })
    expect(r).not.toBeNull()
    expect(r!.clause).toContain("jsonb_typeof")
    expect(r!.clause).toContain("jsonb_array_length")
    expect(r!.bindings).toEqual([3])
  })

  it("range with both bounds → EXISTS over elements, date-truncated bounds", () => {
    const r = buildDeliveryDateFilterSql({
      $gte: "2026-07-01T00:00:00.000Z",
      $lte: "2026-07-31T23:59:59.999Z",
    })
    expect(r!.clause).toContain("jsonb_array_elements_text")
    expect(r!.clause).toContain("elem.val::date >= ?::date")
    expect(r!.clause).toContain("elem.val::date <= ?::date")
    expect(r!.bindings).toEqual(["2026-07-01", "2026-07-31"])
  })

  it("range with only $gte → single lower-bound condition", () => {
    const r = buildDeliveryDateFilterSql({ $gte: "2026-07-01T00:00:00.000Z" })
    expect(r!.clause).toContain(">= ?::date")
    expect(r!.clause).not.toContain("<= ?::date")
    expect(r!.bindings).toEqual(["2026-07-01"])
  })

  it("empty range → null (match nothing)", () => {
    expect(buildDeliveryDateFilterSql({})).toBeNull()
  })
})
