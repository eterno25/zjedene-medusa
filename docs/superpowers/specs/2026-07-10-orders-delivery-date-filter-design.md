# Orders "Delivery Date" filter — design

**Date:** 2026-07-10
**Scope:** Add a "Delivery Date" filter to the core admin dashboard orders list, backed by each order's `metadata.delivery_dates` array.

## Goal

On `/orders`, the "Add filter" menu gets one new entry **Delivery Date**. Opening it shows a popover with:

| Option        | Meaning (server-side)                                  |
|---------------|--------------------------------------------------------|
| 1 delivery    | `delivery_dates` array length **= 1**                  |
| 1 week        | length **= 3**                                         |
| 1 month       | length **= 12**                                        |
| 2 months      | length **= 24**                                        |
| Custom range… | order has **any** `delivery_dates` element in `[from, to]` |

Behaves like the existing filters: server-side, paginated, count correct.

## Data source

Order `metadata.delivery_dates`: JSON array of ISO date strings, e.g. `["2026-07-10"]`. Bucket = exact array length. Range = any element within an inclusive date window.

Bucket→count map (single source of truth, frontend const):
`{ "1_delivery": 1, "1_week": 3, "1_month": 12, "2_months": 24 }`.

## Architecture

Two locations, by decision:

- **Frontend → core monorepo** (`packages/admin/dashboard`). Live-verifiable on the standalone dashboard dev server (`:5173`).
- **Backend → core monorepo** (`packages/medusa`). **Not** live on the running `:9000` backend, which loads `@zjedene-medusa/medusa@2.16.2` from the npm registry. Backend filtering is verified only after core is rebuilt/republished and the eshop is bumped. Locally, correctness is proven by a DB check script (below).

### Request flow (unchanged pipeline)

`DeliveryDateFilter` writes URL param `delivery_date` (the legacy orders table uses no query prefix) → `use-order-table-query` whitelists + parses it → `useOrders` → `sdk.admin.order.list` → `GET /admin/orders?delivery_date=…`.

Param payload (JSON object, serialized by js-sdk like `created_at` already is):
- bucket mode: `{ "count": 3 }`
- range mode: `{ "$gte": "2026-07-01T00:00:00.000Z", "$lte": "2026-07-31T23:59:59.999Z" }`

## Frontend components

1. **`Filter` type + renderer** (`components/table/data-table/data-table-filter/data-table-filter.tsx`)
   Add a `"delivery-date"` variant to the `Filter` union and a `case "delivery-date"` to the render switch → renders `<DeliveryDateFilter>`. No extra fields on the filter object (buckets are hardcoded in the component).

2. **`delivery-date-filter.tsx`** (new, same dir)
   Clone of `date-filter.tsx`. Popover lists 4 bucket buttons (each `selectedParams.add(JSON.stringify({count}))`) + a "Custom range" toggle revealing two `DatePicker`s that store `{$gte,$lte}` (reuse DateFilter's `$lte` end-of-day offset). Single-select semantics: selecting a bucket replaces any range and vice-versa (`useSelectedParams` non-multiple `.add` already overwrites). Chip shows the bucket label or the formatted range.

3. **`use-order-table-filters.tsx`**
   Push `{ key: "delivery_date", label: t("orders.filters.deliveryDate"), type: "delivery-date" }`.

4. **`use-order-table-query.tsx`**
   Whitelist `"delivery_date"`; `delivery_date: delivery_date ? JSON.parse(delivery_date) : undefined`. Attach to `searchParams` with a cast (`AdminOrderFilters` has no such key — fork-local).

5. **i18n:** add `orders.filters.deliveryDate` + bucket labels to `en.json` (English only; app is otherwise Slovak-labelled via existing keys — match existing pattern, add SK if trivially available).

## Backend (`packages/medusa/src/api/admin/orders`)

6. **`validators.ts`** — add to `AdminGetOrdersParamsBase`:
   ```ts
   delivery_date: z
     .union([z.object({ count: z.coerce.number().int().positive() }), createOperatorMap()])
     .optional()
   ```
   Transform passes it through into `req.filterableFields`.

7. **`route.ts` `GET`** — before building `variables`:
   - Pull `delivery_date` out of `req.filterableFields` (delete the key so it isn't forwarded to the order module, which can't interpret it).
   - If present, resolve knex via `req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)` and select matching order ids from the `"order"` table (`deleted_at IS NULL`):
     - **count mode:** `jsonb_array_length(metadata->'delivery_dates') = :count`
     - **range mode:** `EXISTS (SELECT 1 FROM jsonb_array_elements_text(metadata->'delivery_dates') e WHERE e::date BETWEEN :from::date AND :to::date)` where `from = $gte.slice(0,10)`, `to = $lte.slice(0,10)` (compare on `::date` to avoid ISO-datetime-vs-date lexical bugs). If only one bound is set, use `>=` / `<=` alone.
   - Merge `id: matchedIds` into `filters`. If `matchedIds` is empty, short-circuit and return an empty page (`orders: [], count: 0`) rather than passing `id: []` to the module.
   `// ponytail: pre-resolve ids then id IN — fine at admin order volume; revisit if order count explodes.`

Pagination/count stay correct because the normal workflow runs unchanged over the `id`-narrowed set.

## Error handling

- Missing/empty `metadata.delivery_dates` → `jsonb_array_length(NULL)` is NULL, never equals a bucket; `EXISTS` over NULL yields no rows. Both correctly exclude such orders. No extra guarding.
- Invalid param shape → Zod rejects at the middleware (400), consistent with other filters.

## Verification

- **UI (now, `:5173`):** filter appears, popover works, URL param set, request fired to `:9000`. Confirmed via the headless Playwright probe + manual click-through.
- **Backend logic (now, no republish):** a node check script runs both SQL variants against the eshop Postgres and asserts, for a known order (`display_id 1117`, 1 delivery date), that it appears under `count=1` and under a range covering `2026-07-10`, and is excluded otherwise. This is the one runnable check for the non-trivial SQL.
- **End-to-end (after release):** rebuild/publish core, bump eshop, filter narrows the list live.

## Out of scope / YAGNI

- Migrating off the deprecated `_DataTable` (tracked separately as SUP-2651).
- Combining delivery-date with other exotic filters; buckets beyond the four given.
- Indexing `metadata->'delivery_dates'` — add a GIN/expression index only if the id pre-resolve query measurably slows.
