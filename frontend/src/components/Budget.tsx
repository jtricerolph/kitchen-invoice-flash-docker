import { useState, useEffect, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import PurchaseOrderModal from './PurchaseOrderModal'
import CostDistributionModal from './CostDistributionModal'
import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
)

interface BudgetInvoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  net_stock: number
  document_type: string | null
}

interface BudgetPO {
  id: number
  order_type: string
  status: string
  total_amount: number | null
  order_reference: string | null
}

interface SupplierBudgetRow {
  supplier_id: number | null
  supplier_name: string
  historical_pct: number
  allocated_budget: number
  invoices_by_date: Record<string, BudgetInvoice[]>
  purchase_orders_by_date: Record<string, BudgetPO[]>
  actual_spent: number
  cd_adjustments_by_date: Record<string, number>
  cd_total: number
  po_ordered: number
  remaining: number
  status: 'under' | 'on_track' | 'over'
}

interface DailyBudgetData {
  date: string
  day_name: string
  forecast_revenue: number
  budget_split_pct: number
  historical_budget: number
  revenue_budget: number
  actual_spent: number | null
  cumulative_budget: number
  cumulative_spent: number | null
}

interface CoversSummary {
  otb: number
  pickup: number
  forecast: number
}

interface DailyCoverData {
  date: string
  day_name: string
  otb_rooms: number
  pickup_rooms: number
  otb_guests: number
  pickup_guests: number
  breakfast: CoversSummary
  lunch: CoversSummary
  dinner: CoversSummary
}

interface ForecastSummary {
  otb_rooms: number
  pickup_rooms: number
  forecast_rooms: number
  otb_guests: number
  pickup_guests: number
  forecast_guests: number
  breakfast: CoversSummary
  lunch: CoversSummary
  dinner: CoversSummary
  daily_covers: DailyCoverData[]
}

interface WeeklyBudgetResponse {
  week_start: string
  week_end: string
  dates: string[]
  otb_revenue: number
  forecast_revenue: number
  forecast_source: string
  forecast_summary: ForecastSummary | null
  has_overrides: boolean
  snapshot_revenue: number | null
  adjusted_revenue: number | null
  gp_target_pct: number
  min_budget: number
  total_budget: number
  total_spent: number
  total_po_ordered: number
  total_remaining: number
  cd_budget_reservation: number
  suppliers: SupplierBudgetRow[]
  all_supplier_names: string[]
  daily_data: DailyBudgetData[]
  daily_totals: Record<string, number>
}

interface RecalcPeriod {
  actual: number | null
  otb: number
  pickup: number
  effective: number
  override: number | null
  snapshot: number | null
  variance: number | null
  is_overridden: boolean
}

interface RecalcDay {
  date: string
  day_name: string
  is_past: boolean
  periods: Record<string, RecalcPeriod>
  day_revenue: number
}

interface SpendRateData {
  period: string
  food_spend_api: number | null
  drinks_spend_api: number | null
  food_spend_snapshot: number | null
  drinks_spend_snapshot: number | null
  food_spend_override: number | null
  drinks_spend_override: number | null
  food_spend_effective: number
  drinks_spend_effective: number
}

interface OverrideInfo {
  id: number
  override_date: string
  period: string
  override_covers: number
  original_forecast: number | null
  original_otb: number | null
}

interface WeeklyOverrideResponse {
  week_start: string
  week_end: string
  has_snapshot: boolean
  vat_rate: number
  snapshot_revenue: number | null
  adjusted_revenue: number | null
  snapshots: Array<{
    date: string
    period: string
    forecast_covers: number
    otb_covers: number
    food_spend: number | null
    drinks_spend: number | null
    forecast_dry_revenue: number | null
  }>
  overrides: OverrideInfo[]
  spend_rates: SpendRateData[]
  recalc_days: RecalcDay[]
}

// Helper to format date as "Mon 20"
const formatDate = (dateStr: string): string => {
  const d = new Date(dateStr)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${days[d.getDay()]} ${d.getDate()}`
}

// Helper to format week range
const formatWeekRange = (start: string, end: string): string => {
  const startDate = new Date(start)
  const endDate = new Date(end)
  const startMonth = startDate.toLocaleDateString('en-GB', { month: 'short' })
  const endMonth = endDate.toLocaleDateString('en-GB', { month: 'short' })

  if (startMonth === endMonth) {
    return `${startDate.getDate()} - ${endDate.getDate()} ${startMonth}`
  }
  return `${startDate.getDate()} ${startMonth} - ${endDate.getDate()} ${endMonth}`
}

interface WeeklyDistributionRow {
  distribution_id: number
  title: string
  supplier_name?: string
  invoice_number?: string
  source_date_str?: string
  summary?: string
  notes?: string
  invoice_id: number
  entries_by_date: Record<string, number>
  total_distributed_value: number
  remaining_balance: number
  bf_balance: number
  cf_balance: number
  status: string
}

interface WeeklyDistributionsResponse {
  week_start: string
  week_end: string
  distributions: WeeklyDistributionRow[]
  daily_totals: Record<string, number>
  bf_balance: number
  cf_balance: number
  week_total: number
}

export default function Budget() {
  const { token, user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [weekOffset, setWeekOffset] = useState(0)
  const [showForecastBreakdown, setShowForecastBreakdown] = useState(false)
  const [showSpendRates, setShowSpendRates] = useState(false)
  const [poModalOpen, setPoModalOpen] = useState(false)
  const [editPoId, setEditPoId] = useState<number | null>(null)
  const [poDefaultSupplierId, setPoDefaultSupplierId] = useState<number | null>(null)
  const [poDefaultDate, setPoDefaultDate] = useState<string | null>(null)

  // Cost distribution state
  const [selectInvoiceMode, setSelectInvoiceMode] = useState(false)
  const [distModalOpen, setDistModalOpen] = useState(false)
  const [distModalInvoiceId, setDistModalInvoiceId] = useState<number | null>(null)
  const [distModalDistId, setDistModalDistId] = useState<number | null>(null)
  const [showDistributions, setShowDistributions] = useState(false)
  const [expandedDists, setExpandedDists] = useState<Set<number>>(new Set())

  // Fetch weekly budget data
  const { data: budgetData, isLoading, error, refetch } = useQuery<WeeklyBudgetResponse>({
    queryKey: ['budget', 'weekly', weekOffset],
    queryFn: async () => {
      const res = await fetch(`/api/budget/weekly?week_offset=${weekOffset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch budget data')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch prior 2 weeks for chart comparison
  const { data: prevWeek1 } = useQuery<WeeklyBudgetResponse>({
    queryKey: ['budget', 'weekly', weekOffset - 1],
    queryFn: async () => {
      const res = await fetch(`/api/budget/weekly?week_offset=${weekOffset - 1}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      return res.json()
    },
    enabled: !!token,
  })
  const { data: prevWeek2 } = useQuery<WeeklyBudgetResponse>({
    queryKey: ['budget', 'weekly', weekOffset - 2],
    queryFn: async () => {
      const res = await fetch(`/api/budget/weekly?week_offset=${weekOffset - 2}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      return res.json()
    },
    enabled: !!token,
  })

  const goToPreviousWeek = () => setWeekOffset((prev) => prev - 1)
  const goToNextWeek = () => setWeekOffset((prev) => prev + 1)
  const goToCurrentWeek = () => setWeekOffset(0)

  // --- Cover Override State & Queries ---
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, number>>({})
  const [isSavingOverrides, setIsSavingOverrides] = useState(false)

  const { data: overrideData, refetch: refetchOverrides, isLoading: isOverrideLoading } = useQuery<WeeklyOverrideResponse>({
    queryKey: ['cover-overrides', 'weekly', weekOffset],
    queryFn: async () => {
      const res = await fetch(`/api/cover-overrides/weekly?week_offset=${weekOffset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch override data')
      return res.json()
    },
    enabled: !!token && showForecastBreakdown,
  })

  // Fetch cost distribution data for this week
  const { data: distData } = useQuery<WeeklyDistributionsResponse>({
    queryKey: ['cost-distributions', 'weekly', weekOffset, budgetData?.week_start, budgetData?.week_end],
    queryFn: async () => {
      const res = await fetch(
        `/api/cost-distributions/weekly?week_start=${budgetData!.week_start}&week_end=${budgetData!.week_end}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) throw new Error('Failed to fetch distribution data')
      return res.json()
    },
    enabled: !!token && !!budgetData,
  })

  // Auto-expand distributions when active distributions have a balance in this period
  useEffect(() => {
    if (distData && distData.distributions.some(d =>
      d.status === 'ACTIVE' && (d.bf_balance !== 0 || d.cf_balance !== 0)
    )) {
      setShowDistributions(true)
    }
  }, [distData])

  // Fetch resident (hotel guest) covers for the forecast table
  const { data: residentCovers } = useQuery<Record<string, Record<string, { covers: number; bookings: number }>>>({
    queryKey: ['resos', 'resident-covers', budgetData?.week_start, budgetData?.week_end],
    queryFn: async () => {
      const res = await fetch(
        `/api/resos/resident-covers?start_date=${budgetData!.week_start}&end_date=${budgetData!.week_end}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) return {}
      const data = await res.json()
      return data.dates ?? {}
    },
    enabled: !!token && !!budgetData && showForecastBreakdown,
  })

  const snapshotMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/cover-overrides/snapshot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ week_offset: weekOffset }),
      })
      if (!res.ok) throw new Error('Failed to create snapshot')
      return res.json()
    },
    onSuccess: () => { refetchOverrides(); refetch() },
  })

  const hasPendingChanges = Object.keys(pendingOverrides).length > 0

  const getOverrideDisplayValue = (dateStr: string, period: string, effective: number): number => {
    const key = `${dateStr}|${period}`
    if (key in pendingOverrides) return pendingOverrides[key]
    return effective
  }

  const isCellOverridden = (dateStr: string, period: string): boolean => {
    const key = `${dateStr}|${period}`
    if (key in pendingOverrides) return true
    return !!overrideData?.overrides.find(o => o.override_date === dateStr && o.period === period)
  }

  const adjustCover = (dateStr: string, period: string, effective: number, delta: number) => {
    const key = `${dateStr}|${period}`
    const current = key in pendingOverrides ? pendingOverrides[key] : effective
    setPendingOverrides(prev => ({ ...prev, [key]: Math.max(0, current + delta) }))
  }

  const saveAllOverrides = async () => {
    setIsSavingOverrides(true)
    try {
      await Promise.all(Object.entries(pendingOverrides).map(([key, value]) => {
        const [overrideDate, period] = key.split('|')
        return fetch('/api/cover-overrides', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ override_date: overrideDate, period, override_covers: value }),
        })
      }))
      setPendingOverrides({})
      refetchOverrides()
      refetch()
    } finally {
      setIsSavingOverrides(false)
    }
  }

  const deleteOverride = async (id: number) => {
    await fetch(`/api/cover-overrides/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    refetchOverrides()
    refetch()
  }

  const saveSpendRate = async (period: string, food: number | null, drinks: number | null) => {
    await fetch('/api/cover-overrides/spend-rates', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_offset: weekOffset, period, food_spend: food, drinks_spend: drinks }),
    })
    refetchOverrides()
    refetch()
  }

  // Check if date is today or in the past (for spend table)
  const isPastOrToday = (dateStr: string): boolean => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const d = new Date(dateStr)
    d.setHours(0, 0, 0, 0)
    return d <= today
  }

  // Check if date is strictly in the past (before today) - for forecast coloring
  const isPast = (dateStr: string): boolean => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const d = new Date(dateStr)
    d.setHours(0, 0, 0, 0)
    return d < today
  }

  // Helper: compute daily spend totals (invoices + POs) from a week's budget data
  const getDailySpend = (data: WeeklyBudgetResponse): number[] => {
    return data.dates.map(d => {
      const invoiceSpend = data.daily_totals[d] ?? 0
      let poSpend = 0
      data.suppliers.forEach(s => {
        const pos = (s.purchase_orders_by_date || {})[d] || []
        pos.forEach(po => { poSpend += po.total_amount || 0 })
      })
      return invoiceSpend + poSpend
    })
  }

  // Prepare chart data — daily spend comparison across 3 weeks
  const chartData = budgetData ? (() => {
    const thisWeekSpend = getDailySpend(budgetData)
    const prev1Spend = prevWeek1 ? getDailySpend(prevWeek1) : Array(7).fill(0)
    const prev2Spend = prevWeek2 ? getDailySpend(prevWeek2) : Array(7).fill(0)
    const prev1Label = prevWeek1 ? formatWeekRange(prevWeek1.week_start, prevWeek1.week_end) : 'Week -2'
    const prev2Label = prevWeek2 ? formatWeekRange(prevWeek2.week_start, prevWeek2.week_end) : 'Week -3'

    return {
      labels: budgetData.daily_data.map((d) => d.day_name),
      datasets: [
        {
          label: prev2Label,
          data: prev2Spend,
          backgroundColor: 'rgba(189, 195, 199, 0.4)',
          borderColor: 'rgba(189, 195, 199, 0.6)',
          borderWidth: 1,
          borderRadius: 3,
          order: 3,
        },
        {
          label: prev1Label,
          data: prev1Spend,
          backgroundColor: 'rgba(52, 152, 219, 0.35)',
          borderColor: 'rgba(52, 152, 219, 0.5)',
          borderWidth: 1,
          borderRadius: 3,
          order: 2,
        },
        {
          label: 'This Week',
          data: thisWeekSpend,
          backgroundColor: 'rgba(46, 204, 113, 0.7)',
          borderColor: 'rgba(39, 174, 96, 0.9)',
          borderWidth: 1,
          borderRadius: 3,
          order: 1,
        },
      ],
    }
  })() : null

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      title: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label: (ctx: any) => `${ctx.dataset.label}: £${ctx.parsed.y?.toFixed(2) ?? '0.00'}`,
        },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          callback: (value: number | string) => `£${Number(value).toLocaleString()}`,
        },
      },
    },
  }

  if (isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading budget data...</div>
      </div>
    )
  }

  if (error || !budgetData) {
    return (
      <div style={styles.container}>
        <div style={styles.error}>
          <p>Failed to load budget data.</p>
          <p style={{ fontSize: '0.9rem', color: '#666' }}>
            Make sure the Forecast API is configured in Settings.
          </p>
          <button onClick={() => refetch()} style={styles.retryBtn}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  const usedPercentage = budgetData.total_budget > 0
    ? Math.round((budgetData.total_spent / budgetData.total_budget) * 100)
    : 0

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>Spend Budget</h2>
        <div style={styles.weekNav}>
          <button onClick={goToPreviousWeek} style={styles.navBtn}>&lt;</button>
          <button onClick={goToCurrentWeek} style={styles.currentBtn}>
            {weekOffset === 0 ? 'This Week' : 'Current'}
          </button>
          <button onClick={goToNextWeek} style={styles.navBtn}>&gt;</button>
        </div>
      </div>

      {/* Week Info */}
      <div style={styles.weekInfo}>
        {formatWeekRange(budgetData.week_start, budgetData.week_end)}
        {budgetData.forecast_source !== 'forecast_api' && (
          <span style={styles.warningBadge}>No forecast data</span>
        )}
      </div>

      {/* Forecast Breakdown Toggle */}
      {budgetData.forecast_summary && (() => {
        const summary = budgetData.forecast_summary!
        const dailyCovers = summary.daily_covers
        const hasDailyData = dailyCovers.length > 0
        // Period is fully past if all dates are before today
        const allPast = hasDailyData
          ? dailyCovers.every((d) => isPast(d.date))
          : budgetData.dates.every((d) => isPast(d))

        return (
          <div style={{ marginBottom: '1rem' }}>
            <button
              onClick={() => setShowForecastBreakdown(!showForecastBreakdown)}
              style={styles.forecastToggle}
            >
              {showForecastBreakdown ? '▾ Hide' : '▸ Show'} Forecast Breakdown
            </button>
            {showForecastBreakdown && (
              <div style={styles.forecastTableContainer}>
                <table style={styles.forecastTable}>
                  <thead>
                    <tr>
                      <th style={styles.forecastTh}>Service</th>
                      {(hasDailyData
                        ? dailyCovers
                        : budgetData.dates.map((d) => ({ date: d, day_name: formatDate(d) }))
                      ).map((day) => (
                        <th key={day.date} style={styles.forecastTh}>
                          {'day_name' in day && day.day_name ? day.day_name : formatDate(day.date)}
                        </th>
                      ))}
                      <th style={{ ...styles.forecastTh, ...styles.forecastTotalCol }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Hotel (Rooms) Row */}
                    <tr style={styles.forecastTr}>
                      <td style={styles.forecastServiceCell}>Hotel</td>
                      {hasDailyData ? dailyCovers.map((day) => {
                        const past = isPast(day.date)
                        const otbStyle = past ? styles.fcActual : styles.fcOtb
                        const pickupStyle = past ? styles.fcActual : styles.fcPickup
                        return (
                          <td key={day.date} style={styles.forecastTd}>
                            <span style={otbStyle}>{day.otb_rooms}</span>
                            <span style={{ ...otbStyle, fontSize: '0.75rem' }}> ({day.otb_guests})</span>
                            {day.pickup_rooms > 0 && (
                              <>
                                <span style={pickupStyle}> +{day.pickup_rooms}</span>
                                <span style={{ ...pickupStyle, fontSize: '0.75rem' }}> ({day.pickup_guests})</span>
                              </>
                            )}
                          </td>
                        )
                      }) : budgetData.dates.map((d) => (
                        <td key={d} style={styles.forecastTd}>-</td>
                      ))}
                      <td style={{ ...styles.forecastTd, ...styles.forecastTotalCol }}>
                        {allPast ? (
                          <span style={styles.fcActual}>
                            {summary.forecast_rooms} ({summary.forecast_guests})
                          </span>
                        ) : (
                          <>
                            <span style={styles.fcOtb}>{summary.otb_rooms} ({summary.otb_guests})</span>
                            {summary.pickup_rooms > 0 && (
                              <span style={styles.fcPickup}> +{summary.pickup_rooms} ({summary.pickup_guests})</span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                    {/* Covers Rows */}
                    {(['breakfast', 'lunch', 'dinner'] as const).map((period) => {
                      const totalCovers = summary[period]

                      return (
                        <tr key={period} style={styles.forecastTr}>
                          <td style={styles.forecastServiceCell}>
                            {period.charAt(0).toUpperCase() + period.slice(1)}
                          </td>
                          {hasDailyData ? dailyCovers.map((day) => {
                            const covers = day[period]
                            const past = isPast(day.date)
                            const otbStyle = past ? styles.fcActual : styles.fcOtb
                            const pickupStyle = past ? styles.fcActual : styles.fcPickup
                            return (
                              <td key={day.date} style={styles.forecastTd}>
                                {past ? (
                                  <span style={otbStyle}>{covers.forecast}</span>
                                ) : (
                                  <>
                                    <span style={otbStyle}>{covers.otb}</span>
                                    {covers.pickup > 0 && (
                                      <span style={pickupStyle}> +{covers.pickup}</span>
                                    )}
                                  </>
                                )}
                              </td>
                            )
                          }) : budgetData.dates.map((d) => (
                            <td key={d} style={styles.forecastTd}>-</td>
                          ))}
                          <td style={{ ...styles.forecastTd, ...styles.forecastTotalCol }}>
                            {allPast ? (
                              <span style={styles.fcActual}>{totalCovers.forecast}</span>
                            ) : (
                              <>
                                <span style={styles.fcOtb}>{totalCovers.otb}</span>
                                {totalCovers.pickup > 0 && (
                                  <span style={styles.fcPickup}> +{totalCovers.pickup}</span>
                                )}
                                <span style={styles.fcTotal}> = {totalCovers.forecast}</span>
                              </>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {/* inc Residents Row - hotel guest bookings from Resos */}
                    {residentCovers && (
                      <tr style={styles.forecastTr}>
                        <td style={{ ...styles.forecastServiceCell, fontSize: '0.8rem', color: '#888', fontStyle: 'italic' }}>
                          inc Residents
                        </td>
                        {hasDailyData ? dailyCovers.map((day) => {
                          const dayResidents = residentCovers[day.date] || {}
                          const lunch = dayResidents['lunch'] || { covers: 0, bookings: 0 }
                          const dinner = dayResidents['dinner'] || { covers: 0, bookings: 0 }
                          const totalBookings = lunch.bookings + dinner.bookings
                          const totalCoversRes = lunch.covers + dinner.covers
                          return (
                            <td key={day.date} style={{ ...styles.forecastTd, fontSize: '0.8rem', color: '#888', fontStyle: 'italic' }}>
                              {totalCoversRes > 0 ? `${totalBookings}/${totalCoversRes}` : '-'}
                            </td>
                          )
                        }) : budgetData.dates.map((d) => (
                          <td key={d} style={{ ...styles.forecastTd, fontSize: '0.8rem', color: '#888' }}>-</td>
                        ))}
                        <td style={{ ...styles.forecastTd, ...styles.forecastTotalCol, fontSize: '0.8rem', color: '#888', fontStyle: 'italic' }}>
                          {(() => {
                            let weekBookings = 0, weekCovers = 0
                            Object.values(residentCovers).forEach(day => {
                              const l = day['lunch'] || { covers: 0, bookings: 0 }
                              const d = day['dinner'] || { covers: 0, bookings: 0 }
                              weekBookings += l.bookings + d.bookings
                              weekCovers += l.covers + d.covers
                            })
                            return weekCovers > 0 ? `${weekBookings}/${weekCovers}` : '-'
                          })()}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {/* Override Section */}
            {showForecastBreakdown && isOverrideLoading && (
              <div style={{ textAlign: 'center', padding: '1rem', color: '#888', fontSize: '0.85rem' }}>
                Loading override data...
              </div>
            )}
            {showForecastBreakdown && overrideData && !overrideData.has_snapshot && (
              <div style={{ textAlign: 'center', padding: '1rem' }}>
                <button
                  onClick={() => snapshotMutation.mutate()}
                  disabled={snapshotMutation.isPending}
                  style={styles.snapshotBtn}
                >
                  {snapshotMutation.isPending ? 'Creating Snapshot...' : 'Snapshot Forecast & Override'}
                </button>
                <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.5rem' }}>
                  Takes a snapshot of the current forecast as a baseline for overrides
                </div>
              </div>
            )}
            {showForecastBreakdown && overrideData?.has_snapshot && (
              <>
                {/* Snapshot info bar */}
                <div style={styles.snapshotInfoBar}>
                  <span>
                    Snapshot: £{overrideData.snapshot_revenue?.toLocaleString(undefined, { minimumFractionDigits: 2 }) ?? '-'}
                    {overrideData.adjusted_revenue != null && Math.abs(overrideData.adjusted_revenue - (overrideData.snapshot_revenue ?? 0)) > 1 && (
                      <span style={{
                        marginLeft: '0.5rem',
                        fontWeight: 'bold',
                        color: overrideData.adjusted_revenue > (overrideData.snapshot_revenue ?? 0) ? '#27ae60' : '#e74c3c'
                      }}>
                        → £{overrideData.adjusted_revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => { if (window.confirm('Re-snapshot will update the baseline forecast. Continue?')) snapshotMutation.mutate() }}
                    style={styles.resnapshotBtn}
                    disabled={snapshotMutation.isPending}
                  >
                    {snapshotMutation.isPending ? '...' : 'Re-snapshot'}
                  </button>
                </div>

                {/* Spend Rates Display - collapsible, shown as gross inc VAT, stored as net */}
                <div style={styles.overrideTableContainer}>
                  <div
                    style={{ ...styles.overrideSectionHeader, cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setShowSpendRates(!showSpendRates)}
                  >
                    {showSpendRates ? '▾' : '▸'} Food Spend Per Cover (Gross inc VAT)
                  </div>
                  {showSpendRates && (
                    <table style={styles.forecastTable}>
                      <thead>
                        <tr>
                          <th style={styles.forecastTh}></th>
                          {overrideData.spend_rates.map(sr => (
                            <th key={sr.period} style={styles.forecastTh}>
                              {sr.period.charAt(0).toUpperCase() + sr.period.slice(1)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr style={styles.forecastTr}>
                          <td style={styles.forecastServiceCell}>Food £/hd</td>
                          {overrideData.spend_rates.map(sr => {
                            const grossVal = sr.food_spend_effective * overrideData.vat_rate
                            return (
                              <td key={sr.period} style={styles.forecastTd}>
                                <input
                                  type="number"
                                  step="0.50"
                                  defaultValue={grossVal.toFixed(2)}
                                  key={`food-${sr.period}-${grossVal.toFixed(2)}`}
                                  style={{
                                    ...styles.spendInput,
                                    ...(sr.food_spend_override !== null ? styles.spendInputOverridden : {}),
                                  }}
                                  onBlur={(e) => {
                                    const inputGross = parseFloat(e.target.value)
                                    if (!isNaN(inputGross) && Math.abs(inputGross - grossVal) > 0.001) {
                                      const netVal = Math.round((inputGross / overrideData.vat_rate) * 100) / 100
                                      saveSpendRate(sr.period, netVal, null)
                                    }
                                  }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                />
                              </td>
                            )
                          })}
                        </tr>
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Cover Override Input Table */}
                <div style={styles.overrideTableContainer}>
                  <div style={{
                    ...styles.overrideSectionHeader,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <span>Cover Overrides (Lunch & Dinner)</span>
                    {hasPendingChanges && (
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button onClick={() => setPendingOverrides({})} style={styles.discardBtn}>
                          Discard
                        </button>
                        <button
                          onClick={saveAllOverrides}
                          disabled={isSavingOverrides}
                          style={styles.saveOverrideBtn}
                        >
                          {isSavingOverrides ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    )}
                  </div>
                  <table style={styles.forecastTable}>
                    <thead>
                      <tr>
                        <th style={styles.forecastTh}>Service</th>
                        {overrideData.recalc_days.map(d => (
                          <th key={d.date} style={styles.forecastTh}>{d.day_name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(['lunch', 'dinner'] as const).map(period => (
                        <tr key={period} style={styles.forecastTr}>
                          <td style={styles.forecastServiceCell}>
                            {period.charAt(0).toUpperCase() + period.slice(1)}
                          </td>
                          {overrideData.recalc_days.map(d => {
                            const p = d.periods[period]
                            if (!p) return <td key={d.date} style={styles.forecastTd}>-</td>

                            const serverOverride = overrideData.overrides.find(
                              o => o.override_date === d.date && o.period === period
                            )
                            const displayVal = getOverrideDisplayValue(d.date, period, serverOverride?.override_covers ?? p.effective)
                            const hasOverride = isCellOverridden(d.date, period)
                            const pendingKey = `${d.date}|${period}`
                            const hasPending = pendingKey in pendingOverrides

                            if (d.is_past) {
                              return (
                                <td key={d.date} style={{ ...styles.forecastTd, color: '#999' }}>
                                  {p.effective}
                                </td>
                              )
                            }

                            return (
                              <td key={d.date} style={styles.forecastTd}>
                                <div style={styles.stepperCell}>
                                  <button
                                    onClick={() => adjustCover(d.date, period, serverOverride?.override_covers ?? p.effective, -1)}
                                    style={styles.stepperBtn}
                                  >−</button>
                                  <span style={hasOverride ? styles.overriddenValue : undefined}>
                                    {displayVal}
                                  </span>
                                  <button
                                    onClick={() => adjustCover(d.date, period, serverOverride?.override_covers ?? p.effective, 1)}
                                    style={styles.stepperBtn}
                                  >+</button>
                                  {serverOverride && !hasPending && (
                                    <button
                                      onClick={() => deleteOverride(serverOverride.id)}
                                      style={styles.deleteOverrideBtn}
                                      title="Remove override"
                                    >×</button>
                                  )}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Recalculated Breakdown Table */}
                <div style={styles.overrideTableContainer}>
                  <div style={styles.overrideSectionHeader}>Recalculated Forecast</div>
                  <table style={styles.forecastTable}>
                    <thead>
                      <tr>
                        <th style={styles.forecastTh}>Service</th>
                        {overrideData.recalc_days.map(d => (
                          <th key={d.date} style={styles.forecastTh}>{d.day_name}</th>
                        ))}
                        <th style={{ ...styles.forecastTh, ...styles.forecastTotalCol }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(['breakfast', 'lunch', 'dinner'] as const).map(period => {
                        let totalEffective = 0
                        return (
                          <tr key={period} style={styles.forecastTr}>
                            <td style={styles.forecastServiceCell}>
                              {period.charAt(0).toUpperCase() + period.slice(1)}
                            </td>
                            {overrideData.recalc_days.map(d => {
                              const p = d.periods[period]
                              if (!p) return <td key={d.date} style={styles.forecastTd}>-</td>
                              totalEffective += p.effective

                              if (d.is_past) {
                                return (
                                  <td key={d.date} style={styles.forecastTd}>
                                    <span style={styles.fcActual}>{p.actual ?? p.effective}</span>
                                    {p.variance != null && p.variance !== 0 && (
                                      <span style={{
                                        fontSize: '0.7rem',
                                        marginLeft: '2px',
                                        color: p.variance > 0 ? '#27ae60' : '#e74c3c',
                                      }}>
                                        {p.variance > 0 ? '▲' : '▼'}{Math.abs(p.variance)}
                                      </span>
                                    )}
                                  </td>
                                )
                              }

                              return (
                                <td key={d.date} style={styles.forecastTd}>
                                  <span style={styles.fcOtb}>{p.otb}</span>
                                  {p.pickup > 0 && (
                                    <span style={{
                                      ...styles.fcPickup,
                                      ...(p.is_overridden ? styles.overriddenValue : {}),
                                    }}>
                                      {' +' + p.pickup}
                                    </span>
                                  )}
                                </td>
                              )
                            })}
                            <td style={{ ...styles.forecastTd, ...styles.forecastTotalCol }}>
                              {totalEffective}
                            </td>
                          </tr>
                        )
                      })}
                      {/* Revenue row */}
                      <tr style={{ ...styles.forecastTr, borderTop: '2px solid #ddd' }}>
                        <td style={{ ...styles.forecastServiceCell, fontStyle: 'italic', color: '#666' }}>Revenue</td>
                        {overrideData.recalc_days.map(d => (
                          <td key={d.date} style={{ ...styles.forecastTd, fontSize: '0.8rem', color: '#666' }}>
                            £{d.day_revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                        ))}
                        <td style={{ ...styles.forecastTd, ...styles.forecastTotalCol, fontSize: '0.8rem' }}>
                          £{overrideData.adjusted_revenue?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '-'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )
      })()}

      {/* Summary Cards */}
      <div style={styles.summaryCards}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>
            {budgetData.has_overrides ? 'Adjusted Revenue' : 'Forecast Revenue'}
          </div>
          <div style={styles.cardValue}>£{budgetData.forecast_revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div style={styles.cardSubtext}>
            {budgetData.has_overrides && budgetData.snapshot_revenue != null
              ? `Snapshot: £${budgetData.snapshot_revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
              : `OTB: £${budgetData.otb_revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
            }
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Budget</div>
          <div style={styles.cardValue}>£{budgetData.total_budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div style={styles.cardSubtext}>
            OTB: £{budgetData.min_budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Spent</div>
          <div style={{ ...styles.cardValue, color: budgetData.total_remaining < 0 ? '#e74c3c' : '#333' }}>
            £{budgetData.total_spent.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>
          <div style={styles.cardSubtext}>{usedPercentage}% used</div>
        </div>
        <div style={{
          ...styles.card,
          ...(budgetData.total_remaining < 0 ? styles.cardOver : styles.cardUnder)
        }}>
          <div style={styles.cardLabel}>Remaining</div>
          <div style={styles.cardValue}>
            {budgetData.total_remaining < 0 ? '-' : ''}£{Math.abs(budgetData.total_remaining).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>
          <div style={styles.cardSubtext}>
            {budgetData.total_remaining < 0 ? 'OVER BUDGET' : `${100 - usedPercentage}% remaining`}
          </div>
        </div>
      </div>

      {/* Weekly Budget Table */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Weekly Budget by Supplier</h3>
        <div style={styles.tableContainer}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, ...styles.supplierHeader }}>Supplier</th>
                {budgetData.dates.map((d) => (
                  <th key={d} style={{ ...styles.th, ...(isPastOrToday(d) ? {} : styles.futureDate) }}>
                    {formatDate(d)}
                  </th>
                ))}
                <th style={{ ...styles.th, ...styles.budgetHeader }}>Budget</th>
                <th style={{ ...styles.th, ...styles.spentHeader }}>Spent</th>
                <th style={{ ...styles.th, ...styles.orderedHeader }}>Ordered</th>
                <th style={{ ...styles.th, ...styles.remainingHeader }}>Remaining</th>
                <th style={{ ...styles.th, ...styles.statusHeader }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {budgetData.suppliers.map((supplier) => {
                const hasData = Object.values(supplier.invoices_by_date).some(invs => invs.length > 0) ||
                  Object.values(supplier.purchase_orders_by_date || {}).some(pos => pos.length > 0) ||
                  supplier.allocated_budget > 0

                if (!hasData) return null

                return (
                  <tr key={supplier.supplier_id ?? supplier.supplier_name} style={styles.tr}>
                    <td style={styles.supplierCell}>
                      <div>{supplier.supplier_name}</div>
                      {supplier.historical_pct > 0 && (
                        <div style={styles.supplierPct}>({supplier.historical_pct.toFixed(1)}%)</div>
                      )}
                    </td>
                    {budgetData.dates.map((d) => {
                      const invoices = supplier.invoices_by_date[d] || []
                      const pos = (supplier.purchase_orders_by_date || {})[d] || []
                      const hasContent = invoices.length > 0 || pos.length > 0
                      return (
                        <td
                          key={d}
                          style={{
                            ...styles.td,
                            ...(!hasContent && supplier.supplier_id ? styles.clickableCell : {}),
                          }}
                          onClick={() => {
                            if (!hasContent && supplier.supplier_id) {
                              setPoDefaultSupplierId(supplier.supplier_id)
                              setPoDefaultDate(d)
                              setEditPoId(null)
                              setPoModalOpen(true)
                            }
                          }}
                        >
                          {hasContent ? (
                            <div style={styles.invoicesCell}>
                              {invoices.map((inv) => {
                                const isCreditNote = inv.document_type === 'credit_note' || inv.net_stock < 0
                                return (
                                  <button
                                    key={inv.id}
                                    onClick={() => {
                                      if (selectInvoiceMode && !isCreditNote) {
                                        setDistModalInvoiceId(inv.id)
                                        setDistModalDistId(null)
                                        setDistModalOpen(true)
                                        setSelectInvoiceMode(false)
                                      } else {
                                        navigate(`/invoice/${inv.id}`)
                                      }
                                    }}
                                    style={{
                                      ...styles.invoiceBtn,
                                      ...(isCreditNote ? styles.creditNoteBtn : {}),
                                      ...(selectInvoiceMode && !isCreditNote ? styles.invoiceBtnSelectMode : {}),
                                    }}
                                    title={selectInvoiceMode && !isCreditNote ? 'Click to distribute this invoice' : (inv.invoice_number || `Invoice #${inv.id}`)}
                                  >
                                    {isCreditNote && '-'}£{Math.abs(inv.net_stock).toFixed(2)}{isCreditNote && ' CR'}
                                  </button>
                                )
                              })}
                              {pos.map((po) => (
                                <button
                                  key={`po-${po.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setEditPoId(po.id)
                                    setPoDefaultSupplierId(null)
                                    setPoDefaultDate(null)
                                    setPoModalOpen(true)
                                  }}
                                  style={styles.poBtn}
                                  title={po.order_reference ? `PO: ${po.order_reference}` : `PO #${po.id}`}
                                >
                                  £{(po.total_amount || 0).toFixed(2)}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <span style={styles.emptyCell}>{supplier.supplier_id ? '+' : '-'}</span>
                          )}
                        </td>
                      )
                    })}
                    <td style={styles.budgetCell}>
                      £{supplier.allocated_budget.toFixed(2)}
                    </td>
                    <td style={styles.spentCell}>
                      £{supplier.actual_spent.toFixed(2)}
                      {supplier.cd_total !== 0 && (
                        <div style={{ fontSize: '0.65rem', color: supplier.cd_total > 0 ? '#e65100' : '#2e7d32' }}>
                          ({supplier.cd_total > 0 ? '+' : '-'}£{Math.abs(supplier.cd_total).toFixed(2)} dist)
                        </div>
                      )}
                    </td>
                    <td style={styles.orderedCell}>
                      {supplier.po_ordered > 0 ? `£${supplier.po_ordered.toFixed(2)}` : '-'}
                    </td>
                    <td style={{
                      ...styles.remainingCell,
                      ...(supplier.remaining < 0 ? styles.overBudget : {})
                    }}>
                      {supplier.remaining < 0 ? '-' : ''}£{Math.abs(supplier.remaining).toFixed(2)}
                    </td>
                    <td style={styles.statusCell}>
                      <span style={{
                        ...styles.statusBadge,
                        ...(supplier.status === 'over' ? styles.statusOver :
                          supplier.status === 'on_track' ? styles.statusOnTrack : styles.statusUnder)
                      }}>
                        {supplier.status === 'over' ? '!' :
                          supplier.status === 'on_track' ? '~' : ''}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              {distData && distData.week_total !== 0 && (
                <tr style={{ ...styles.footerRow, background: '#fff8e1' }}>
                  <td style={{ ...styles.footerLabel, color: '#e65100', fontWeight: 600 }}>Distributed</td>
                  {budgetData.dates.map((d) => {
                    const adj = distData.daily_totals[d] ?? 0
                    return (
                      <td key={d} style={{ ...styles.footerTd, color: adj < 0 ? '#c62828' : adj > 0 ? '#2e7d32' : '#999', fontWeight: 500 }}>
                        {adj !== 0 ? (
                          <>{adj < 0 ? '-' : '+'}£{Math.abs(adj).toFixed(2)}</>
                        ) : '-'}
                      </td>
                    )
                  })}
                  <td style={styles.footerTd}></td>
                  <td style={{ ...styles.footerTd, color: '#e65100', fontWeight: 600 }}>
                    {distData.week_total < 0 ? '-' : '+'}£{Math.abs(distData.week_total).toFixed(2)}
                  </td>
                  <td style={styles.footerTd}></td>
                  <td style={styles.footerTd}></td>
                  <td style={styles.footerTd}></td>
                </tr>
              )}
              <tr style={styles.footerRow}>
                <td style={styles.footerLabel}>Daily Total</td>
                {budgetData.dates.map((d) => {
                  const total = budgetData.daily_totals[d] ?? 0
                  const isPast = isPastOrToday(d)
                  return (
                    <td key={d} style={styles.footerTd}>
                      {isPast ? `£${total.toFixed(2)}` : '-'}
                    </td>
                  )
                })}
                <td style={styles.footerTd}>£{budgetData.total_budget.toFixed(2)}</td>
                <td style={styles.footerTd}>£{budgetData.total_spent.toFixed(2)}</td>
                <td style={styles.footerTd}>
                  {budgetData.total_po_ordered > 0 ? `£${budgetData.total_po_ordered.toFixed(2)}` : '-'}
                </td>
                <td style={{
                  ...styles.footerTd,
                  ...(budgetData.total_remaining < 0 ? styles.overBudget : {})
                }}>
                  {budgetData.total_remaining < 0 ? '-' : ''}£{Math.abs(budgetData.total_remaining).toFixed(2)}
                </td>
                <td style={styles.footerTd}></td>
              </tr>
              <tr style={styles.footerRow}>
                <td style={styles.footerLabel}>% of Budget</td>
                {budgetData.daily_data.map((d) => {
                  if (d.actual_spent === null || budgetData.total_budget === 0) {
                    return <td key={d.date} style={styles.footerTd}>-</td>
                  }

                  const pct = (d.actual_spent / budgetData.total_budget * 100)

                  return (
                    <td key={d.date} style={styles.footerTd}>
                      {d.actual_spent === 0 ? '0%' : `${pct.toFixed(0)}%`}
                    </td>
                  )
                })}
                <td colSpan={5}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Distributed Costs Section */}
      <div style={styles.section}>
        <div
          style={styles.distributionHeader}
          onClick={() => setShowDistributions(!showDistributions)}
        >
          <span style={{ cursor: 'pointer' }}>
            {showDistributions ? '\u25BE' : '\u25B8'} Distributed Costs
          </span>
          {distData && distData.distributions.length > 0 && (
            <span style={styles.distributionSummary}>
              BF: {distData.bf_balance < 0 ? '-' : ''}£{Math.abs(distData.bf_balance).toFixed(2)}
              {' | '}Movement: {distData.week_total < 0 ? '-' : distData.week_total > 0 ? '+' : ''}£{Math.abs(distData.week_total).toFixed(2)}
              {' | '}CF: {distData.cf_balance < 0 ? '-' : ''}£{Math.abs(distData.cf_balance).toFixed(2)}
            </span>
          )}
        </div>

        {showDistributions && budgetData && (
              <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, ...styles.supplierHeader, minWidth: '180px' }}>Distribution</th>
                      <th style={{ ...styles.th, minWidth: '70px' }}>BF</th>
                      {budgetData.dates.map((d: string) => (
                        <th key={d} style={{ ...styles.th, minWidth: '70px' }}>
                          {new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}
                        </th>
                      ))}
                      <th style={{ ...styles.th, minWidth: '70px' }}>CF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distData?.distributions.map((dist) => {
                      const isExpanded = expandedDists.has(dist.distribution_id)
                      return (
                        <Fragment key={dist.distribution_id}>
                          <tr>
                            <td style={{ ...styles.supplierCell, fontSize: '0.8rem', padding: '0.3rem 0.5rem' }}>
                              <span
                                style={{ cursor: 'pointer', color: '#555', marginRight: '0.3rem', fontSize: '0.7rem' }}
                                onClick={() => setExpandedDists(prev => {
                                  const next = new Set(prev)
                                  next.has(dist.distribution_id) ? next.delete(dist.distribution_id) : next.add(dist.distribution_id)
                                  return next
                                })}
                              >
                                {isExpanded ? '\u25BE' : '\u25B8'}
                              </span>
                              <span
                                style={{ cursor: 'pointer', color: '#1565c0' }}
                                onClick={() => {
                                  setDistModalDistId(dist.distribution_id)
                                  setDistModalInvoiceId(dist.invoice_id)
                                  setDistModalOpen(true)
                                }}
                                title="Click to view/edit distribution"
                              >
                                {dist.title}
                              </span>
                            </td>
                            <td style={{ ...styles.dayCell, fontWeight: 600, fontSize: '0.8rem', color: '#555' }}>
                              {dist.bf_balance !== 0 ? (
                                <>{dist.bf_balance < 0 ? '-' : ''}£{Math.abs(dist.bf_balance).toFixed(2)}</>
                              ) : '-'}
                            </td>
                            {budgetData.dates.map((d: string) => {
                              const val = dist.entries_by_date[d]
                              return (
                                <td key={d} style={{ ...styles.dayCell, fontSize: '0.8rem' }}>
                                  {val != null ? (
                                    <span style={{ color: val < 0 ? '#c62828' : '#2e7d32', fontWeight: 500 }}>
                                      {val < 0 ? '-' : ''}£{Math.abs(val).toFixed(2)}
                                    </span>
                                  ) : '-'}
                                </td>
                              )
                            })}
                            <td style={{ ...styles.dayCell, fontWeight: 600, fontSize: '0.8rem', color: dist.cf_balance < 0 ? '#c62828' : dist.cf_balance === 0 ? '#2e7d32' : '#555' }}>
                              {dist.cf_balance !== 0 ? (
                                <>{dist.cf_balance < 0 ? '-' : ''}£{Math.abs(dist.cf_balance).toFixed(2)}</>
                              ) : '£0.00'}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td
                                colSpan={budgetData.dates.length + 3}
                                style={{ padding: '0.3rem 0.5rem 0.5rem 1.5rem', background: '#fafafa', fontSize: '0.75rem', color: '#555', borderTop: 'none' }}
                              >
                                <div style={{ fontWeight: 600 }}>{dist.supplier_name || 'Unknown'} {dist.invoice_number || ''}</div>
                                <div>{dist.summary}</div>
                                {dist.notes && <div style={{ fontStyle: 'italic', marginTop: '0.2rem', color: '#888' }}>{dist.notes}</div>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  {/* Totals row */}
                  {distData && distData.distributions.length > 0 && (
                    <tr style={{ background: '#f8f9fa' }}>
                      <td style={{ ...styles.supplierCell, fontWeight: 700 }}>Distribution Total</td>
                      <td style={{ ...styles.dayCell, fontWeight: 600, fontSize: '0.8rem' }}>
                        {distData.bf_balance !== 0 ? (
                          <>{distData.bf_balance < 0 ? '-' : ''}£{Math.abs(distData.bf_balance).toFixed(2)}</>
                        ) : '-'}
                      </td>
                      {budgetData.dates.map((d: string) => {
                        const adj = distData.daily_totals[d] ?? 0
                        return (
                          <td key={d} style={{ ...styles.dayCell, fontWeight: 600, fontSize: '0.8rem' }}>
                            {adj !== 0 ? (
                              <span style={{ color: adj < 0 ? '#c62828' : '#2e7d32' }}>
                                {adj < 0 ? '-' : ''}£{Math.abs(adj).toFixed(2)}
                              </span>
                            ) : '-'}
                          </td>
                        )
                      })}
                      <td style={{ ...styles.dayCell, fontWeight: 600, fontSize: '0.8rem' }}>
                        {distData.cf_balance !== 0 ? (
                          <>{distData.cf_balance < 0 ? '-' : ''}£{Math.abs(distData.cf_balance).toFixed(2)}</>
                        ) : '£0.00'}
                      </td>
                    </tr>
                  )}
                  {/* Add Distribution row */}
                  <tr>
                    <td
                      colSpan={budgetData.dates.length + 3}
                      style={{ padding: '0.5rem', textAlign: 'left', borderTop: '1px solid #e0e0e0' }}
                    >
                      {selectInvoiceMode ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <button
                            onClick={() => setSelectInvoiceMode(false)}
                            style={styles.spreadCostBtnActive}
                          >
                            Cancel
                          </button>
                          <span style={styles.selectModeHint}>
                            Click an invoice in the table above to spread its cost
                          </span>
                        </div>
                      ) : (
                        <button
                          onClick={() => setSelectInvoiceMode(true)}
                          style={styles.addDistributionBtn}
                        >
                          + Add Distribution
                        </button>
                      )}
                    </td>
                  </tr>
                  </tbody>
                </table>
              </div>
            )}
      </div>

      {/* Budget Chart */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Daily Spend Comparison</h3>
        <div style={styles.chartContainer}>
          {chartData && <Bar data={chartData} options={chartOptions} />}
        </div>
      </div>

      {/* PO Modal */}
      <PurchaseOrderModal
        isOpen={poModalOpen}
        onClose={() => {
          setPoModalOpen(false)
          setEditPoId(null)
          setPoDefaultSupplierId(null)
          setPoDefaultDate(null)
        }}
        onSaved={() => {
          refetch()
        }}
        poId={editPoId}
        defaultSupplierId={poDefaultSupplierId}
        defaultDate={poDefaultDate}
      />

      {/* Cost Distribution Modal */}
      <CostDistributionModal
        isOpen={distModalOpen}
        onClose={() => {
          setDistModalOpen(false)
          setDistModalInvoiceId(null)
          setDistModalDistId(null)
        }}
        onSaved={() => {
          refetch()
          queryClient.invalidateQueries({ queryKey: ['cost-distributions'] })
        }}
        invoiceId={distModalInvoiceId}
        distributionId={distModalDistId}
        isAdmin={user?.is_admin}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '1rem',
  },
  loading: {
    textAlign: 'center',
    padding: '3rem',
    color: '#666',
  },
  error: {
    textAlign: 'center',
    padding: '3rem',
    background: '#fff3f3',
    borderRadius: '8px',
  },
  retryBtn: {
    marginTop: '1rem',
    padding: '0.5rem 1rem',
    background: '#3498db',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 'bold',
  },
  weekNav: {
    display: 'flex',
    gap: '0.5rem',
  },
  navBtn: {
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  currentBtn: {
    padding: '0.5rem 1rem',
    background: '#3498db',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  weekInfo: {
    fontSize: '1.1rem',
    color: '#666',
    marginBottom: '1rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  warningBadge: {
    background: '#f39c12',
    color: 'white',
    padding: '0.2rem 0.5rem',
    borderRadius: '4px',
    fontSize: '0.8rem',
  },
  forecastToggle: {
    background: 'none',
    border: '1px solid #ddd',
    borderRadius: '4px',
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    fontSize: '0.9rem',
    color: '#555',
    fontWeight: '500',
  },
  forecastTableContainer: {
    overflowX: 'auto',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    marginTop: '0.5rem',
  },
  forecastTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  forecastTh: {
    padding: '0.6rem 0.5rem',
    borderBottom: '2px solid #e0e0e0',
    textAlign: 'center',
    fontWeight: 'bold',
    background: '#f5f5f5',
    whiteSpace: 'nowrap',
    fontSize: '0.8rem',
  },
  forecastTr: {
    borderBottom: '1px solid #e0e0e0',
  },
  forecastServiceCell: {
    padding: '0.5rem 0.75rem',
    fontWeight: '600',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    color: '#333',
  },
  forecastTd: {
    padding: '0.5rem',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  forecastTotalCol: {
    background: '#f0f7ff',
    fontWeight: '600',
  },
  fcActual: {
    color: '#27ae60',
    fontWeight: '500',
  },
  fcOtb: {
    color: '#2980b9',
    fontWeight: '500',
  },
  fcPickup: {
    color: '#e67e22',
    fontSize: '0.85rem',
  },
  fcTotal: {
    color: '#555',
    fontWeight: '600',
  },
  summaryCards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '1rem',
    marginBottom: '2rem',
  },
  card: {
    background: 'white',
    padding: '1rem',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    textAlign: 'center',
  },
  cardLabel: {
    fontSize: '0.9rem',
    color: '#666',
    marginBottom: '0.5rem',
  },
  cardValue: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#333',
  },
  cardSubtext: {
    fontSize: '0.8rem',
    color: '#999',
    marginTop: '0.25rem',
  },
  cardOver: {
    background: '#ffebee',
    borderLeft: '4px solid #e74c3c',
  },
  cardUnder: {
    background: '#e8f5e9',
    borderLeft: '4px solid #27ae60',
  },
  section: {
    marginBottom: '2rem',
  },
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: 'bold',
    marginBottom: '1rem',
    color: '#333',
  },
  tableContainer: {
    overflowX: 'auto',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  th: {
    padding: '0.75rem 0.5rem',
    borderBottom: '2px solid #e0e0e0',
    textAlign: 'center',
    fontWeight: 'bold',
    background: '#f5f5f5',
    whiteSpace: 'nowrap',
  },
  supplierHeader: {
    textAlign: 'left',
    minWidth: '150px',
  },
  budgetHeader: {
    background: '#e3f2fd',
  },
  spentHeader: {
    background: '#fff3e0',
  },
  remainingHeader: {
    background: '#e8f5e9',
  },
  statusHeader: {
    width: '50px',
  },
  tr: {
    borderBottom: '1px solid #e0e0e0',
  },
  td: {
    padding: '0.5rem',
    textAlign: 'center',
    verticalAlign: 'top',
  },
  supplierCell: {
    padding: '0.5rem',
    textAlign: 'left',
    fontWeight: '500',
  },
  supplierPct: {
    fontSize: '0.75rem',
    color: '#888',
  },
  futureDate: {
    opacity: 0.6,
  },
  futureCell: {
    opacity: 0.5,
    background: '#fafafa',
  },
  invoicesCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    alignItems: 'center',
  },
  invoiceBtn: {
    padding: '0.25rem 0.5rem',
    background: '#d4edda',
    border: '1px solid #28a745',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    whiteSpace: 'nowrap',
    color: '#155724',
  },
  creditNoteBtn: {
    background: '#ffebee',
    borderColor: '#c62828',
    color: '#c62828',
  },
  poBtn: {
    padding: '0.25rem 0.5rem',
    background: '#e3f2fd',
    border: '1px dashed #42a5f5',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontStyle: 'italic',
    color: '#1565c0',
    whiteSpace: 'nowrap',
  },
  emptyCell: {
    color: '#ccc',
  },
  clickableCell: {
    cursor: 'pointer',
  },
  budgetCell: {
    padding: '0.5rem',
    background: '#e3f2fd',
    fontWeight: '500',
  },
  spentCell: {
    padding: '0.5rem',
    background: '#fff3e0',
  },
  orderedHeader: {
    textAlign: 'center',
  },
  orderedCell: {
    padding: '0.5rem',
    background: '#e3f2fd',
    textAlign: 'center',
    color: '#1565c0',
    fontStyle: 'italic',
    fontSize: '0.85rem',
  },
  remainingCell: {
    padding: '0.5rem',
    background: '#e8f5e9',
    fontWeight: '500',
  },
  overBudget: {
    background: '#ffebee',
    color: '#c62828',
  },
  overLabel: {
    fontSize: '0.7rem',
    fontWeight: 'bold',
    display: 'none',
  },
  statusCell: {
    padding: '0.5rem',
    textAlign: 'center',
  },
  statusBadge: {
    display: 'inline-block',
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    lineHeight: '24px',
    textAlign: 'center',
    fontWeight: 'bold',
  },
  statusUnder: {
    background: '#c8e6c9',
    color: '#2e7d32',
  },
  statusOnTrack: {
    background: '#fff9c4',
    color: '#f57f17',
  },
  statusOver: {
    background: '#ffcdd2',
    color: '#c62828',
  },
  footerRow: {
    background: '#f5f5f5',
    fontWeight: '500',
  },
  footerLabel: {
    padding: '0.5rem',
    textAlign: 'left',
    fontWeight: 'bold',
    fontSize: '0.85rem',
  },
  footerTd: {
    padding: '0.5rem',
    textAlign: 'center',
    fontSize: '0.85rem',
  },
  chartContainer: {
    height: '300px',
    background: 'white',
    padding: '1rem',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  snapshotBtn: {
    padding: '0.75rem 1.5rem',
    background: '#3498db',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.95rem',
    fontWeight: '600',
  },
  snapshotInfoBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 0.75rem',
    background: '#f0f7ff',
    borderRadius: '6px',
    fontSize: '0.85rem',
    color: '#555',
    marginBottom: '0.75rem',
    marginTop: '0.75rem',
  },
  resnapshotBtn: {
    background: 'none',
    border: '1px solid #aaa',
    borderRadius: '4px',
    padding: '0.25rem 0.5rem',
    cursor: 'pointer',
    fontSize: '0.8rem',
    color: '#666',
  },
  overrideTableContainer: {
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    marginBottom: '0.75rem',
    overflow: 'hidden',
  },
  overrideSectionHeader: {
    padding: '0.5rem 0.75rem',
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#555',
    borderBottom: '1px solid #e0e0e0',
    background: '#fafafa',
  },
  spendInput: {
    width: '65px',
    textAlign: 'center' as const,
    border: '1px solid #ddd',
    borderRadius: '3px',
    padding: '3px 4px',
    fontSize: '0.8rem',
  },
  spendInputOverridden: {
    fontWeight: 'bold',
    borderColor: '#3498db',
    background: '#f0f7ff',
  },
  stepperCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
  },
  stepperBtn: {
    width: '22px',
    height: '22px',
    border: '1px solid #ccc',
    borderRadius: '3px',
    background: '#f5f5f5',
    cursor: 'pointer',
    fontSize: '0.85rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    lineHeight: '1',
  },
  overriddenValue: {
    fontWeight: 'bold' as const,
    textDecoration: 'underline' as const,
  },
  deleteOverrideBtn: {
    background: 'none',
    border: 'none',
    color: '#e74c3c',
    cursor: 'pointer',
    fontSize: '0.85rem',
    padding: '0 2px',
    lineHeight: '1',
  },
  saveOverrideBtn: {
    padding: '0.25rem 0.75rem',
    background: '#27ae60',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: '600',
  },
  discardBtn: {
    padding: '0.25rem 0.75rem',
    background: '#f0f0f0',
    color: '#666',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  spreadCostBtn: {
    padding: '0.5rem 1rem',
    background: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
    color: '#555',
  },
  spreadCostBtnActive: {
    padding: '0.5rem 1rem',
    background: '#e3f2fd',
    border: '1px solid #42a5f5',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
    color: '#1565c0',
    boxShadow: '0 0 0 2px rgba(66,165,245,0.3)',
  },
  selectModeHint: {
    padding: '0.4rem 0.75rem',
    background: '#e3f2fd',
    borderRadius: '4px',
    color: '#1565c0',
    fontSize: '0.8rem',
  },
  invoiceBtnSelectMode: {
    cursor: 'crosshair',
    boxShadow: '0 0 0 2px rgba(66,165,245,0.5)',
    border: '2px solid #42a5f5',
  },
  addDistributionBtn: {
    padding: '0.4rem 0.75rem',
    background: 'none',
    border: '1px dashed #aaa',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 500,
    color: '#666',
  },
  distributionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.6rem 0.75rem',
    background: '#f5f5f5',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.9rem',
  },
  distributionSummary: {
    fontSize: '0.8rem',
    color: '#666',
    fontWeight: 400,
  },
}
