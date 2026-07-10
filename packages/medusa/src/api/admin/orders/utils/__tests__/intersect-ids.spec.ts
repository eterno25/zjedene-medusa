import { intersectIds } from "../intersect-ids"

describe("intersectIds", () => {
  const resolved = ["a", "b", "c"]

  it("no existing filter → returns resolved unchanged", () => {
    expect(intersectIds(undefined, resolved)).toEqual(resolved)
    expect(intersectIds(null, resolved)).toEqual(resolved)
  })

  it("string existing → intersection", () => {
    expect(intersectIds("b", resolved)).toEqual(["b"])
    expect(intersectIds("z", resolved)).toEqual([])
  })

  it("array existing → intersection preserves resolved order", () => {
    expect(intersectIds(["c", "a", "z"], resolved)).toEqual(["a", "c"])
  })

  it("$in operator map → intersection", () => {
    expect(intersectIds({ $in: ["b", "c"] }, resolved)).toEqual(["b", "c"])
  })

  it("$eq operator map → intersection", () => {
    expect(intersectIds({ $eq: "a" }, resolved)).toEqual(["a"])
  })

  it("unrecognized operator map ($ne) → returns resolved unchanged", () => {
    expect(intersectIds({ $ne: "a" } as any, resolved)).toEqual(resolved)
  })

  it("empty existing array → empty (caller constrained to none)", () => {
    expect(intersectIds([], resolved)).toEqual([])
  })
})
