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

const parseValue = (value: string[]): DeliveryDateValue | null => {
  return value?.length
    ? (JSON.parse(value.join(",")) as DeliveryDateValue)
    : null
}

const pad = (n: number): string => {
  return String(n).padStart(2, "0")
}

const toLocalDateString = (d: Date): string => {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const parseLocalDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d)
}

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

  const customStart = range?.$gte ? parseLocalDate(range.$gte) : undefined
  const customEnd = range?.$lte ? parseLocalDate(range.$lte) : undefined

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
    selectedParams.add(
      JSON.stringify({
        ...(range || {}),
        [k]: value ? toLocalDateString(value) : undefined,
      })
    )
  }

  const displayValue = (() => {
    if (parsed && "count" in parsed) {
      return buckets.find((b) => b.count === parsed.count)?.label
    }
    return [customStart, customEnd]
      .map((d) => {
        return d ? getFullDate({ date: d }) : undefined
      })
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
