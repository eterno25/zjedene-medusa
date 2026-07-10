# Orders "Delivery Date" Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Delivery Date" filter to the core admin dashboard orders list that filters orders by their `metadata.delivery_dates` JSON array — four exact-count buckets plus a custom date range.

**Architecture:** Frontend adds a custom filter component (a clone of the existing `DateFilter`) to the deprecated `_DataTable` and passes a `delivery_date` query param to `GET /admin/orders`. Backend pre-resolves matching order IDs with raw JSONB SQL (`jsonb_array_length` / `jsonb_array_elements_text`) and injects `id IN (…)` into the existing list workflow, so pagination and count stay correct.

**Tech Stack:** TypeScript, React, radix-ui, MikroORM/Knex (Postgres), Zod, Jest (@swc/jest), Vite.

## Global Constraints

- Prettier: no semicolons, double quotes, 2-space indent, ES5 trailing commas, parens on arrow args.
- All packages are `@zjedene-medusa/*` (fork of Medusa v2.16).
- Bucket→count map is the single source of truth, defined once on the frontend: `1 delivery → 1`, `1 week → 3`, `1 month → 12`, `2 months → 24`.
- Range compare is **date-only, inclusive** on both bounds.
- The running `:9000` backend loads core from the **npm registry**, not this monorepo. Backend tasks are NOT live-verifiable on `:9000` until core is rebuilt/republished and the eshop bumped. Frontend tasks ARE live on the standalone dashboard dev server (`:5173`).
- Dashboard orders table uses **no query prefix** (params are plain, e.g. `delivery_date`).

---

## File Structure

- Create `packages/medusa/src/api/admin/orders/utils/delivery-date-filter.ts` — pure SQL-fragment builder.
- Create `packages/medusa/src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts` — unit tests.
- Modify `packages/medusa/src/api/admin/orders/validators.ts` — accept the `delivery_date` param.
- Modify `packages/medusa/src/api/admin/orders/route.ts` — id pre-resolution + short-circuit.
- Create `packages/admin/dashboard/src/components/table/data-table/data-table-filter/delivery-date-filter.tsx` — the filter UI.
- Modify `packages/admin/dashboard/src/components/table/data-table/data-table-filter/data-table-filter.tsx` — extend `Filter` union + renderer.
- Modify `packages/admin/dashboard/src/hooks/table/filters/use-order-table-filters.tsx` — register the filter.
- Modify `packages/admin/dashboard/src/hooks/table/query/use-order-table-query.tsx` — whitelist + parse the param.
- Modify `packages/admin/dashboard/src/i18n/translations/en.json` — labels.

---

### Task 1: Backend SQL-fragment builder (pure, unit-tested)

**Files:**
- Create: `packages/medusa/src/api/admin/orders/utils/delivery-date-filter.ts`
- Test: `packages/medusa/src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts`

**Interfaces:**
- Produces: `buildDeliveryDateFilterSql(input: DeliveryDateFilterInput): { clause: string; bindings: (string | number)[] } | null` and the type `DeliveryDateFilterInput = { count: number } | { $gte?: string; $lte?: string; $gt?: string; $lt?: string }`. Returns `null` when the input has no usable constraint (⇒ caller matches nothing).

- [ ] **Step 1: Write the failing test**

Create `packages/medusa/src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/medusa && yarn jest src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts`
Expected: FAIL — cannot find module `../delivery-date-filter`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/medusa/src/api/admin/orders/utils/delivery-date-filter.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/medusa && yarn jest src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/medusa/src/api/admin/orders/utils/delivery-date-filter.ts packages/medusa/src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts
git commit -m "feat(orders-api): add delivery-date SQL filter builder"
```

---

### Task 2: Backend validator + route wiring

**Files:**
- Modify: `packages/medusa/src/api/admin/orders/validators.ts` (add param to `AdminGetOrdersParamsBase`, ~line 53-67)
- Modify: `packages/medusa/src/api/admin/orders/route.ts` (whole `GET`)

**Interfaces:**
- Consumes: `buildDeliveryDateFilterSql`, `DeliveryDateFilterInput` from Task 1.
- Produces: `GET /admin/orders` honors a `delivery_date` query param shaped `{ count: number }` or `{ $gte?, $lte? }`.

- [ ] **Step 1: Add the param to the validator**

In `packages/medusa/src/api/admin/orders/validators.ts`, inside the `AdminGetOrdersParamsBase` `z.object({ … })` (the block that ends with `total: createOperatorMap().optional(),`), add after the `total` line:

```ts
    delivery_date: z
      .union([
        z.object({ count: z.coerce.number().int().positive() }),
        createOperatorMap(),
      ])
      .optional(),
```

`createOperatorMap` is already imported in this file. The existing `AdminGetOrdersParamsTransform` destructures only `total`, so `delivery_date` passes through into `req.filterableFields` untouched.

- [ ] **Step 2: Rewrite the route GET to pre-resolve ids**

Replace the entire contents of `packages/medusa/src/api/admin/orders/route.ts` with:

```ts
import { getOrdersListWorkflow } from "@zjedene-medusa/core-flows"
import { HttpTypes, OrderDTO } from "@zjedene-medusa/framework/types"
import { ContainerRegistrationKeys } from "@zjedene-medusa/framework/utils"
import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@zjedene-medusa/framework/http"
import {
  buildDeliveryDateFilterSql,
  DeliveryDateFilterInput,
} from "./utils/delivery-date-filter"

export const GET = async (
  req: AuthenticatedMedusaRequest<HttpTypes.AdminOrderFilters>,
  res: MedusaResponse<HttpTypes.AdminOrderListResponse>
) => {
  const filters: Record<string, any> = {
    ...req.filterableFields,
    is_draft_order: false,
  }

  // `delivery_date` is a custom filter over `metadata.delivery_dates` that the
  // order module can't express. Resolve matching order ids via raw JSONB SQL,
  // then narrow the normal query with `id IN (…)` so pagination/count stay
  // correct.
  // ponytail: pre-resolve ids then id IN — fine at admin order volume; revisit
  // (GIN/expression index, or a keyset join) only if order count explodes.
  const deliveryDate = filters.delivery_date as
    | DeliveryDateFilterInput
    | undefined
  delete filters.delivery_date

  if (deliveryDate) {
    const knex = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const sql = buildDeliveryDateFilterSql(deliveryDate)

    let ids: string[] = []
    if (sql) {
      const rows = await knex("order")
        .whereNull("deleted_at")
        .whereRaw(sql.clause, sql.bindings)
        .select("id")
      ids = rows.map((r: { id: string }) => r.id)
    }

    if (!ids.length) {
      res.json({
        orders: [],
        count: 0,
        offset: req.queryConfig.pagination.skip ?? 0,
        limit: req.queryConfig.pagination.take ?? 0,
      })
      return
    }

    filters.id = ids
  }

  const variables = {
    filters,
    ...req.queryConfig.pagination,
  }

  const workflow = getOrdersListWorkflow(req.scope)
  const { result } = await workflow.run({
    input: {
      fields: req.queryConfig.fields,
      variables,
    },
  })

  const { rows, metadata } = result as {
    rows: OrderDTO[]
    metadata: any
  }
  res.json({
    orders: rows as unknown as HttpTypes.AdminOrder[],
    count: metadata.count,
    offset: metadata.skip,
    limit: metadata.take,
  })
}
```

- [ ] **Step 3: Verify the helper tests still pass (regression)**

Run: `cd packages/medusa && yarn jest src/api/admin/orders/utils/__tests__/delivery-date-filter.spec.ts`
Expected: PASS (4 tests). (Route wiring is thin, no DB in unit scope; live behaviour is verified after core republish per Global Constraints.)

- [ ] **Step 4: Optional live DB spot-check (only if a psql client + the medusa DB are reachable)**

Run (adjust connection to the eshop DB; the example order `display_id 1117` has one delivery date `2026-07-10`):

```bash
psql "$DATABASE_URL_MEDUSA" -c "SELECT display_id, jsonb_array_length(metadata->'delivery_dates') AS n FROM \"order\" WHERE jsonb_typeof(metadata->'delivery_dates')='array' AND jsonb_array_length(metadata->'delivery_dates')=1 LIMIT 3;"
```
Expected: rows where `n = 1` (e.g. `1117`). Skip if no psql/DB — the unit test is the required check.

- [ ] **Step 5: Commit**

```bash
git add packages/medusa/src/api/admin/orders/validators.ts packages/medusa/src/api/admin/orders/route.ts
git commit -m "feat(orders-api): filter orders by metadata.delivery_dates"
```

---

### Task 3: Frontend custom filter component + type/renderer wiring

**Files:**
- Create: `packages/admin/dashboard/src/components/table/data-table/data-table-filter/delivery-date-filter.tsx`
- Modify: `packages/admin/dashboard/src/components/table/data-table/data-table-filter/data-table-filter.tsx` (union ~line 18-40, renderer switch ~line 128-174)

**Interfaces:**
- Consumes: `IFilter` (from `./types`), `useSelectedParams` (`../hooks`), `useDataTableFilterContext` (`./context`), `FilterChip` (`./filter-chip`), `useDate` (`../../../../hooks/use-date`).
- Produces: `DeliveryDateFilter` component; new `Filter` union member `{ type: "delivery-date"; options?: never }`. Stores URL param value as JSON: `{ "count": number }` or `{ "$gte"?: string, "$lte"?: string }`.

- [ ] **Step 1: Create the filter component**

Create `packages/admin/dashboard/src/components/table/data-table/data-table-filter/delivery-date-filter.tsx`:

```tsx
import { EllipseMiniSolid } from "@zjedene-medusa/icons"
import { DatePicker, Text, clx } from "@zjedene-medusa/ui"
import { Popover as RadixPopover } from "radix-ui"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { useDate } from "../../../../hooks/use-date"
import { useSelectedParams } from "../hooks"
import { useDataTableFilterContext } from "./context"
import FilterChip from "./filter-chip"
import { IFilter } from "./types"

type DeliveryDateValue = { count: number } | { $gte?: string; $lte?: string }

const parseValue = (value: string[]): DeliveryDateValue | null =>
  value?.length ? (JSON.parse(value.join(",")) as DeliveryDateValue) : null

const useBuckets = () => {
  const { t } = useTranslation()
  return useMemo(
    () => [
      { count: 1, label: t("orders.filters.deliveryDateBuckets.oneDelivery") },
      { count: 3, label: t("orders.filters.deliveryDateBuckets.oneWeek") },
      { count: 12, label: t("orders.filters.deliveryDateBuckets.oneMonth") },
      { count: 24, label: t("orders.filters.deliveryDateBuckets.twoMonths") },
    ],
    [t]
  )
}

export const DeliveryDateFilter = ({
  filter,
  prefix,
  readonly,
  openOnMount,
}: IFilter) => {
  const { t } = useTranslation()
  const { getFullDate } = useDate()
  const { key, label } = filter
  const { removeFilter } = useDataTableFilterContext()
  const selectedParams = useSelectedParams({ param: key, prefix })
  const buckets = useBuckets()

  const [open, setOpen] = useState(openOnMount)
  const [showCustom, setShowCustom] = useState(() => {
    const p = parseValue(selectedParams.get())
    return !!(p && !("count" in p))
  })

  const currentValue = selectedParams.get()
  const parsed = parseValue(currentValue)
  const range = parsed && !("count" in parsed) ? parsed : null

  const customStart = range?.$gte ? new Date(range.$gte) : undefined
  const customEnd = range?.$lte
    ? (() => {
        const d = new Date(range.$lte)
        d.setHours(0, 0, 0, 0)
        return d
      })()
    : undefined

  const handleSelectBucket = (count: number) => {
    selectedParams.add(JSON.stringify({ count }))
    setShowCustom(false)
  }

  const handleSelectCustom = () => {
    selectedParams.delete()
    setShowCustom((prev) => !prev)
  }

  const handleCustomDateChange = (value: Date | null, pos: "start" | "end") => {
    const k = pos === "start" ? "$gte" : "$lte"
    let dateValue = value
    if (k === "$lte" && value) {
      dateValue = new Date(value.getTime())
      dateValue.setHours(23, 59, 59, 999)
    }
    selectedParams.add(
      JSON.stringify({ ...(range || {}), [k]: dateValue?.toISOString() })
    )
  }

  const displayValue = (() => {
    if (parsed && "count" in parsed) {
      return buckets.find((b) => b.count === parsed.count)?.label
    }
    return [customStart, customEnd]
      .map((d) => (d ? getFullDate({ date: d }) : undefined))
      .filter(Boolean)
      .join(" - ")
  })()

  const [previousValue, setPreviousValue] = useState<string | undefined>(
    displayValue
  )

  const handleRemove = () => {
    selectedParams.delete()
    removeFilter(key)
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    setPreviousValue(displayValue)
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    if (!next && !currentValue.length) {
      timeoutId = setTimeout(() => removeFilter(key), 200)
    }
  }

  const rowClass =
    "bg-ui-bg-base hover:bg-ui-bg-base-hover focus-visible:bg-ui-bg-base-pressed text-ui-fg-base data-[disabled]:text-ui-fg-disabled txt-compact-small relative flex w-full cursor-pointer select-none items-center rounded-md px-2 py-1.5 outline-none transition-colors data-[disabled]:pointer-events-none"

  const markerClass = (active: boolean) =>
    clx("transition-fg flex h-5 w-5 items-center justify-center", {
      "[&_svg]:invisible": !active,
    })

  return (
    <RadixPopover.Root modal open={open} onOpenChange={handleOpenChange}>
      <FilterChip
        hasOperator
        hadPreviousValue={!!previousValue}
        label={label}
        value={displayValue}
        onRemove={handleRemove}
        readonly={readonly}
      />
      {!readonly && (
        <RadixPopover.Portal>
          <RadixPopover.Content
            data-name="delivery_date_filter_content"
            align="start"
            sideOffset={8}
            collisionPadding={24}
            className={clx(
              "bg-ui-bg-base text-ui-fg-base shadow-elevation-flyout h-full max-h-[var(--radix-popper-available-height)] w-[300px] overflow-auto rounded-lg"
            )}
            onInteractOutside={(e) => {
              if (e.target instanceof HTMLElement) {
                if (
                  e.target.attributes.getNamedItem("data-name")?.value ===
                  "filters_menu_content"
                ) {
                  e.preventDefault()
                }
              }
            }}
          >
            <ul className="w-full p-1">
              {buckets.map((bucket) => {
                const isSelected =
                  !!parsed && "count" in parsed && parsed.count === bucket.count
                return (
                  <li key={bucket.count}>
                    <button
                      className={rowClass}
                      type="button"
                      onClick={() => handleSelectBucket(bucket.count)}
                    >
                      <div className={markerClass(isSelected)}>
                        <EllipseMiniSolid />
                      </div>
                      {bucket.label}
                    </button>
                  </li>
                )
              })}
              <li>
                <button
                  className={rowClass}
                  type="button"
                  onClick={handleSelectCustom}
                >
                  <div className={markerClass(showCustom)}>
                    <EllipseMiniSolid />
                  </div>
                  {t("orders.filters.deliveryDateCustomRange")}
                </button>
              </li>
            </ul>
            {showCustom && (
              <div className="border-t px-1 pb-3 pt-1">
                <div>
                  <div className="px-2 py-1">
                    <Text size="xsmall" leading="compact" weight="plus">
                      {t("filters.date.from")}
                    </Text>
                  </div>
                  <div className="px-2 py-1">
                    <DatePicker
                      modal
                      maxValue={customEnd}
                      value={customStart}
                      onChange={(d) => handleCustomDateChange(d, "start")}
                    />
                  </div>
                </div>
                <div>
                  <div className="px-2 py-1">
                    <Text size="xsmall" leading="compact" weight="plus">
                      {t("filters.date.to")}
                    </Text>
                  </div>
                  <div className="px-2 py-1">
                    <DatePicker
                      modal
                      minValue={customStart}
                      value={customEnd || undefined}
                      onChange={(d) => handleCustomDateChange(d, "end")}
                    />
                  </div>
                </div>
              </div>
            )}
          </RadixPopover.Content>
        </RadixPopover.Portal>
      )}
    </RadixPopover.Root>
  )
}
```

- [ ] **Step 2: Extend the `Filter` union**

In `packages/admin/dashboard/src/components/table/data-table/data-table-filter/data-table-filter.tsx`, in the `Filter` union (currently ends with the `number` member), add a new member:

```ts
  | {
      type: "number"
      options?: never
    }
  | {
      type: "delivery-date"
      options?: never
    }
```

- [ ] **Step 3: Import the component and add the renderer case**

At the top of the same file, alongside the other filter imports (`DateFilter`, `NumberFilter`, `SelectFilter`, `StringFilter`), add:

```ts
import { DeliveryDateFilter } from "./delivery-date-filter"
```

In the `switch (filter.type)` block, add a case after `case "number":`:

```tsx
            case "delivery-date":
              return (
                <DeliveryDateFilter
                  key={filter.key}
                  filter={filter}
                  prefix={prefix}
                  readonly={readonly}
                  openOnMount={filter.openOnMount}
                />
              )
```

- [ ] **Step 4: Sanity-check the dashboard dev server has no boot error**

Ensure `:5173` is running (`cd packages/admin/dashboard && yarn dev` if not). Then probe for page errors:

Run: `cd /Users/vuminhquan/Downloads/zjedene/eshop-Zjedene/apps/web && node "/private/tmp/claude-502/-Users-vuminhquan-Downloads-zjedene-eshop-Zjedene/1a345c88-c28d-44d3-bbde-3f92443bf4bb/scratchpad/probe-5173.cjs"`
Expected: no `[pageerror]` lines about `delivery-date`/`DeliveryDateFilter`; login page still renders. (This step only checks the component compiles/loads; interaction is verified in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add packages/admin/dashboard/src/components/table/data-table/data-table-filter/delivery-date-filter.tsx packages/admin/dashboard/src/components/table/data-table/data-table-filter/data-table-filter.tsx
git commit -m "feat(dashboard): add delivery-date table filter component"
```

---

### Task 4: Register the filter on the orders list + i18n + live verification

**Files:**
- Modify: `packages/admin/dashboard/src/hooks/table/filters/use-order-table-filters.tsx` (~line 141-156)
- Modify: `packages/admin/dashboard/src/hooks/table/query/use-order-table-query.tsx`
- Modify: `packages/admin/dashboard/src/i18n/translations/en.json` (inside the `"orders": {` object at line 1057)

**Interfaces:**
- Consumes: the `"delivery-date"` `Filter` type from Task 3; the `delivery_date` param honored by the backend from Task 2.
- Produces: a "Delivery Date" entry in the orders "Add filter" menu that drives `GET /admin/orders?delivery_date=…`.

- [ ] **Step 1: Register the filter in the orders filter hook**

In `packages/admin/dashboard/src/hooks/table/filters/use-order-table-filters.tsx`, immediately after `filters.push(...dateFilters)` (line ~150), add:

```ts
    filters.push({
      key: "delivery_date",
      label: t("orders.filters.deliveryDate"),
      type: "delivery-date",
    })
```

- [ ] **Step 2: Whitelist and parse the query param**

In `packages/admin/dashboard/src/hooks/table/query/use-order-table-query.tsx`:

(a) Add `"delivery_date"` to the array passed to `useQueryParams` (after `"total",`):

```ts
      "order",
      "total",
      "delivery_date",
```

(b) Add `delivery_date` to the destructured `queryObject` (after `order,`):

```ts
    order,
    delivery_date,
    // total,
```

(c) After the `searchParams` object literal and before `return`, attach the parsed value (cast — `AdminOrderFilters` has no such key in this fork):

```ts
  if (delivery_date) {
    ;(searchParams as Record<string, unknown>).delivery_date =
      JSON.parse(delivery_date)
  }
```

- [ ] **Step 3: Add i18n labels**

In `packages/admin/dashboard/src/i18n/translations/en.json`, inside the `"orders": {` object (opens at line 1057), add a `"filters"` block (merge if one already exists):

```json
    "filters": {
      "deliveryDate": "Delivery Date",
      "deliveryDateCustomRange": "Custom range",
      "deliveryDateBuckets": {
        "oneDelivery": "1 delivery",
        "oneWeek": "1 week",
        "oneMonth": "1 month",
        "twoMonths": "2 months"
      }
    },
```

Verify the file is still valid JSON:

Run: `node -e "require('./packages/admin/dashboard/src/i18n/translations/en.json'); console.log('en.json ok')"`
Expected: `en.json ok`.

- [ ] **Step 4: Live-verify on :5173**

With `:5173` and `:9000` up and logged in (`admin@zjedene.sk` / `supersecret`), drive the browser headlessly. Create `/private/tmp/claude-502/-Users-vuminhquan-Downloads-zjedene-eshop-Zjedene/1a345c88-c28d-44d3-bbde-3f92443bf4bb/scratchpad/probe-delivery-filter.cjs`:

```js
const pwPath = require.resolve("@playwright/test", { paths: [process.cwd()] })
const { chromium } = require(pwPath)
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const reqs = []
  page.on("request", (r) => {
    if (r.url().includes("/admin/orders")) reqs.push(r.url())
  })
  // login
  await page.goto("http://localhost:5173/login", { waitUntil: "networkidle" })
  await page.fill('input[name="email"]', "admin@zjedene.sk")
  await page.fill('input[name="password"]', "supersecret")
  await page.click('button[type="submit"]')
  await page.waitForURL("**/orders**", { timeout: 30000 }).catch(() => {})
  await page.goto("http://localhost:5173/orders", { waitUntil: "networkidle" })
  // open Add filter
  await page.getByText("Add filter", { exact: false }).click()
  const hasEntry = await page
    .getByText("Delivery Date", { exact: true })
    .count()
  console.log("Delivery Date menu entry present:", hasEntry > 0)
  if (hasEntry) {
    await page.getByText("Delivery Date", { exact: true }).click()
    const bucket = await page.getByText("1 week", { exact: true }).count()
    console.log("bucket '1 week' present:", bucket > 0)
    if (bucket) {
      await page.getByText("1 week", { exact: true }).click()
      await page.waitForTimeout(1500)
    }
  }
  console.log(
    "last /admin/orders request:",
    reqs[reqs.length - 1] || "(none)"
  )
  await browser.close()
})()
```

Run: `cd /Users/vuminhquan/Downloads/zjedene/eshop-Zjedene/apps/web && node "/private/tmp/claude-502/-Users-vuminhquan-Downloads-zjedene-eshop-Zjedene/1a345c88-c28d-44d3-bbde-3f92443bf4bb/scratchpad/probe-delivery-filter.cjs"`
Expected: `Delivery Date menu entry present: true`, `bucket '1 week' present: true`, and the last `/admin/orders` request URL contains `delivery_date=` with an encoded `{"count":3}`. (Result rows won't change on `:9000` yet — registry core ignores the param; that's expected per Global Constraints.)

- [ ] **Step 5: Commit**

```bash
git add packages/admin/dashboard/src/hooks/table/filters/use-order-table-filters.tsx packages/admin/dashboard/src/hooks/table/query/use-order-table-query.tsx packages/admin/dashboard/src/i18n/translations/en.json
git commit -m "feat(dashboard): wire delivery-date filter into orders list"
```

---

## Notes on verification limits

- Frontend (Tasks 3-4) is fully live on `:5173`.
- Backend (Tasks 1-2): the SQL builder is unit-tested; the route wiring and real JSONB filtering only take effect once core is rebuilt/republished and the eshop bumped off the registry. End-to-end row filtering is confirmed at that point (open the filter, pick "1 week", confirm the list narrows to orders with exactly 3 delivery dates; pick a custom range, confirm orders with a delivery date inside it).
