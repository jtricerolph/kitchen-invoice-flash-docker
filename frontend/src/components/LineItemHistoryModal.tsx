/**
 * Line Item History Modal
 * Shows price history chart and quantity stats for a product.
 * Reusable component for search pages and invoice review.
 */
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { formatCurrency, formatDateForDisplay, formatPercent, formatQuantity } from '../utils/searchHelpers'

interface PriceHistoryPoint {
  date: string
  price: number
  invoice_id: number
  invoice_number: string | null
  quantity: number | null
}

interface HistoryResponse {
  product_code: string | null
  description: string | null
  supplier_id: number
  supplier_name: string | null
  price_history: PriceHistoryPoint[]
  total_occurrences: number
  total_quantity: number
  avg_qty_per_invoice: number
  avg_qty_per_week: number
  avg_qty_per_month: number
  current_price: number | null
  price_change_status: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  productCode: string | null
  description: string | null
  supplierId: number
  supplierName: string
  currentPrice?: number
  sourceInvoiceId?: number
  sourceLineItemId?: number
  onAcknowledge?: () => void
}

export default function LineItemHistoryModal({
  isOpen,
  onClose,
  productCode,
  description,
  supplierId,
  supplierName,
  currentPrice,
  sourceInvoiceId,
  sourceLineItemId,
  onAcknowledge,
}: Props) {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  // Date range state (default: 12 months)
  const defaultDateRange = useMemo(() => {
    const today = new Date()
    const yearAgo = new Date(today)
    yearAgo.setFullYear(yearAgo.getFullYear() - 1)
    return {
      from: yearAgo.toISOString().split('T')[0],
      to: today.toISOString().split('T')[0],
    }
  }, [])

  const [dateFrom, setDateFrom] = useState(defaultDateRange.from)
  const [dateTo, setDateTo] = useState(defaultDateRange.to)

  // Fetch history
  const { data, isLoading, error } = useQuery<HistoryResponse>({
    queryKey: ['line-item-history', supplierId, productCode, description, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('supplier_id', supplierId.toString())
      if (productCode) params.set('product_code', productCode)
      if (description) params.set('description', description)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)

      const res = await fetch(`/api/search/line-items/history?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch history')
      return res.json()
    },
    enabled: isOpen && !!token,
  })

  // Acknowledge price mutation
  const acknowledgeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/search/line-items/acknowledge-price', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product_code: productCode,
          description: description,
          supplier_id: supplierId,
          new_price: currentPrice || data?.current_price,
          source_invoice_id: sourceInvoiceId,
          source_line_item_id: sourceLineItemId,
        }),
      })
      if (!res.ok) throw new Error('Failed to acknowledge price')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['line-item-history'] })
      queryClient.invalidateQueries({ queryKey: ['search-line-items'] })
      if (onAcknowledge) onAcknowledge()
    },
  })

  // Calculate price range for chart (must be before early return to satisfy hooks rules)
  // Uses a minimum meaningful range to avoid misleading charts when prices are very similar
  const priceRange = useMemo(() => {
    if (!data?.price_history.length) return { min: 0, max: 100 }
    const prices = data.price_history.map((p) => typeof p.price === 'string' ? parseFloat(p.price) : p.price)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const actualRange = max - min
    const avgPrice = (min + max) / 2

    // Minimum range should be at least 20% of average price to give proper context
    // This prevents tiny variations from filling the whole chart
    const minMeaningfulRange = avgPrice * 0.2 || 1
    const effectiveRange = Math.max(actualRange, minMeaningfulRange)

    // Center the range around the actual data
    const centerPrice = (min + max) / 2
    const rangeMin = centerPrice - effectiveRange / 2
    const rangeMax = centerPrice + effectiveRange / 2

    // Add small padding
    const padding = effectiveRange * 0.1
    return {
      min: Math.max(0, rangeMin - padding),
      max: rangeMax + padding
    }
  }, [data])

  if (!isOpen) return null

  // Calculate chart height percentage for a price
  const getPriceHeight = (price: number) => {
    const range = priceRange.max - priceRange.min
    if (range === 0) return 50
    return ((price - priceRange.min) / range) * 100
  }

  const displayPrice = currentPrice ?? data?.current_price
  const showAcknowledge =
    data?.price_change_status === 'amber' || data?.price_change_status === 'red'

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          width: '90%',
          maxWidth: '800px',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: '24px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: '20px',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '18px' }}>
              Price History: {description || productCode || 'Unknown'}
              {productCode && description && (
                <span style={{ color: '#6b7280', fontWeight: 'normal' }}> ({productCode})</span>
              )}
            </h2>
            <p style={{ margin: '4px 0 0', color: '#6b7280' }}>Supplier: {supplierName}</p>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '4px 12px',
              border: 'none',
              backgroundColor: '#f1f5f9',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '16px',
            }}
          >
            ✕
          </button>
        </div>

        {/* Date Range */}
        <div
          style={{
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
            marginBottom: '20px',
            padding: '12px',
            backgroundColor: '#f8fafc',
            borderRadius: '8px',
          }}
        >
          <label style={{ fontSize: '14px' }}>Date Range:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
          <span>to</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
        </div>

        {isLoading && <p>Loading...</p>}
        {error && <p style={{ color: 'red' }}>Error: {(error as Error).message}</p>}

        {data && (
          <>
            {/* Price Chart (Simple bar visualization) */}
            <div
              style={{
                marginBottom: '24px',
                padding: '16px',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
              }}
            >
              <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>
                Price History
              </h3>

              {data.price_history.length === 0 ? (
                <p style={{ color: '#6b7280', textAlign: 'center' }}>
                  No price history available for this period
                </p>
              ) : (
                <div>
                  {/* Chart */}
                  <div
                    style={{
                      height: '150px',
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: '2px',
                      padding: '0 0 20px',
                      borderBottom: '1px solid #e5e7eb',
                      position: 'relative',
                    }}
                  >
                    {/* Y-axis labels */}
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 20,
                        width: '50px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        fontSize: '10px',
                        color: '#9ca3af',
                      }}
                    >
                      <span>{formatCurrency(priceRange.max)}</span>
                      <span>{formatCurrency(priceRange.min)}</span>
                    </div>

                    {/* Bars */}
                    <div
                      style={{
                        flex: 1,
                        marginLeft: '55px',
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: '2px',
                        height: '100%',
                      }}
                    >
                      {data.price_history.map((point, idx) => (
                        <div
                          key={idx}
                          style={{
                            flex: 1,
                            maxWidth: '40px',
                            height: `${getPriceHeight(point.price)}%`,
                            backgroundColor: '#3b82f6',
                            borderRadius: '2px 2px 0 0',
                            cursor: 'pointer',
                            position: 'relative',
                          }}
                          title={`${formatDateForDisplay(point.date)}: ${formatCurrency(point.price)} (${point.invoice_number || 'Invoice'})`}
                        />
                      ))}
                    </div>
                  </div>

                  {/* X-axis (dates) */}
                  <div
                    style={{
                      marginLeft: '55px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '10px',
                      color: '#9ca3af',
                      marginTop: '4px',
                    }}
                  >
                    {data.price_history.length > 0 && (
                      <>
                        <span>{formatDateForDisplay(data.price_history[0].date)}</span>
                        <span>
                          {formatDateForDisplay(
                            data.price_history[data.price_history.length - 1].date
                          )}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Price history table */}
                  <div style={{ marginTop: '16px', maxHeight: '150px', overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f8fafc' }}>
                          <th style={{ padding: '8px', textAlign: 'left' }}>Date</th>
                          <th style={{ padding: '8px', textAlign: 'right' }}>Price</th>
                          <th style={{ padding: '8px', textAlign: 'right' }}>Qty</th>
                          <th style={{ padding: '8px', textAlign: 'left' }}>Invoice</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.price_history
                          .slice()
                          .reverse()
                          .map((point, idx) => (
                            <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '8px' }}>
                                {formatDateForDisplay(point.date)}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>
                                {formatCurrency(point.price)}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right' }}>
                                {formatQuantity(point.quantity)}
                              </td>
                              <td style={{ padding: '8px' }}>
                                <a
                                  href={`/invoice/${point.invoice_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: '#2563eb', textDecoration: 'none' }}
                                >
                                  {point.invoice_number || '-'} ↗
                                </a>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Stats */}
            <div
              style={{
                marginBottom: '24px',
                padding: '16px',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
              }}
            >
              <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>
                Stats for Period
              </h3>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: '12px',
                }}
              >
                <StatItem label="Total Occurrences" value={String(data.total_occurrences)} />
                <StatItem label="Total Quantity" value={formatQuantity(data.total_quantity)} />
                <StatItem
                  label="Avg Qty per Invoice"
                  value={formatQuantity(data.avg_qty_per_invoice, 2)}
                />
                <StatItem label="Avg Qty per Week" value={formatQuantity(data.avg_qty_per_week, 2)} />
                <StatItem label="Avg Qty per Month" value={formatQuantity(data.avg_qty_per_month, 2)} />
              </div>
            </div>

            {/* Current Price & Acknowledge */}
            {displayPrice && (
              <div
                style={{
                  padding: '16px',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  backgroundColor:
                    data.price_change_status === 'red'
                      ? '#fef2f2'
                      : data.price_change_status === 'amber'
                        ? '#fffbeb'
                        : '#f0fdf4',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600 }}>Current Price: </span>
                    <span style={{ fontSize: '18px' }}>{formatCurrency(displayPrice)}</span>
                    {data.price_history.length > 1 && (
                      <span
                        style={{
                          marginLeft: '8px',
                          color:
                            data.price_change_status === 'red'
                              ? '#dc2626'
                              : data.price_change_status === 'amber'
                                ? '#d97706'
                                : '#16a34a',
                        }}
                      >
                        {(() => {
                          const prev = data.price_history[data.price_history.length - 2]?.price
                          if (!prev) return ''
                          const change = ((displayPrice - prev) / prev) * 100
                          return `(${formatPercent(change)} from previous ${formatCurrency(prev)})`
                        })()}
                      </span>
                    )}
                  </div>

                  {showAcknowledge && (
                    <button
                      onClick={() => acknowledgeMutation.mutate()}
                      disabled={acknowledgeMutation.isPending}
                      style={{
                        padding: '8px 16px',
                        backgroundColor: '#3b82f6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: acknowledgeMutation.isPending ? 'not-allowed' : 'pointer',
                        opacity: acknowledgeMutation.isPending ? 0.7 : 1,
                      }}
                    >
                      {acknowledgeMutation.isPending
                        ? 'Acknowledging...'
                        : 'Acknowledge Price Change'}
                    </button>
                  )}
                </div>
                {acknowledgeMutation.isSuccess && (
                  <p style={{ marginTop: '8px', color: '#16a34a', fontSize: '14px' }}>
                    ✓ Price change acknowledged
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: '16px', fontWeight: 600 }}>{value}</div>
    </div>
  )
}
