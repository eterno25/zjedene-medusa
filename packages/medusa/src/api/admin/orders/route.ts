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
import { intersectIds } from "./utils/intersect-ids"

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

    // AND-compose with any caller-supplied `id` filter so delivery_date
    // narrows the result set like every other orders-list filter, instead of
    // overwriting `id`.
    const matchedIds = intersectIds(filters.id, ids)

    if (!matchedIds.length) {
      res.json({
        orders: [],
        count: 0,
        offset: req.queryConfig.pagination.skip ?? 0,
        limit: req.queryConfig.pagination.take ?? 0,
      })
      return
    }

    filters.id = matchedIds
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
