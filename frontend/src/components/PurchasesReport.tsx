import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface SupplierBreakdown {
  supplier_id: number | null
  supplier_name: string
  net_purchases: number
  percentage: number
}

interface PurchasesSummaryResponse {
  from_date: string
  to_date: string
  period_label: string
  total_purchases: number
  supplier_breakdown: SupplierBreakdown[]
}

interface DailySupplierDataPoint {
  date: string
  supplier_id: number | null
  supplier_name: string
  net_purchases: number
}

interface DailySupplierChartResponse {
  from_date: string
  to_date: string
  suppliers: string[]
  data: DailySupplierDataPoint[]
}

interface TopLineItem {
  description: string
  product_code: string | null
  total_quantity: number
  total_value: number
  avg_unit_price: number
  occurrence_count: number
}

interface TopItemsResponse {
  from_date: string
  to_date: string
  top_by_quantity: TopLineItem[]
  top_by_value: TopLineItem[]
}

// Helper to format date as YYYY-MM-DD for input fields and API
const formatDate = (d: Date): string => {
  return d.toISOString().split('T')[0]
}

// Get the start and end of a given month
const getMonthBounds = (year: number, month: number): { start: string; end: string } => {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0) // Last day of month
  return { start: formatDate(start), end: formatDate(end) }
}

// Helper to get first line of description (before newline)
const getFirstLineOfDescription = (description: string | null): string => {
  if (!description) return ''
  return description.split('\n')[0].trim()
}

// Generate list of months for the picker (last 12 months + next 2 months)
const getMonthOptions = (): { label: string; year: number; month: number }[] => {
  const options: { label: string; year: number; month: number }[] = []
  const today = new Date()

  for (let i = -12; i <= 2; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1)
    const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    options.push({ label, year: d.getFullYear(), month: d.getMonth() })
  }

  return options.reverse()
}

// Session storage keys
const STORAGE_KEY_FROM = 'purchases-report-from-date'
const STORAGE_KEY_TO = 'purchases-report-to-date'

// Get initial dates
const getInitialDates = () => {
  const storedFrom = sessionStorage.getItem(STORAGE_KEY_FROM)
  const storedTo = sessionStorage.getItem(STORAGE_KEY_TO)

  if (storedFrom && storedTo) {
    return { from: storedFrom, to: storedTo }
  }

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const thirtyDaysAgo = new Date(yesterday)
  thirtyDaysAgo.setDate(yesterday.getDate() - 30)

  return { from: formatDate(thirtyDaysAgo), to: formatDate(yesterday) }
}

// Color palette for suppliers
const SUPPLIER_COLORS = [
  '#e94560', // Red
  '#0ea5e9', // Blue
  '#22c55e', // Green
  '#f59e0b', // Amber
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#f97316', // Orange
  '#6366f1', // Indigo
  '#84cc16', // Lime
]

export default function PurchasesReport() {
  const { token } = useAuth()
  const initialDates = getInitialDates()

  const [fromDate, setFromDate] = useState(initialDates.from)
  const [toDate, setToDate] = useState(initialDates.to)
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [selectionMode, setSelectionMode] = useState<'last30' | 'week' | 'month' | 'custom'>('custom')

  const [submittedFromDate, setSubmittedFromDate] = useState(initialDates.from)
  const [submittedToDate, setSubmittedToDate] = useState(initialDates.to)
  const [topItemsSupplierFilter, setTopItemsSupplierFilter] = useState<number | null>(null)

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY_FROM, submittedFromDate)
    sessionStorage.setItem(STORAGE_KEY_TO, submittedToDate)
  }, [submittedFromDate, submittedToDate])

  const monthOptions = getMonthOptions()
  const hasUnsavedChanges = fromDate !== submittedFromDate || toDate !== submittedToDate

  const handleGenerate = () => {
    setSubmittedFromDate(fromDate)
    setSubmittedToDate(toDate)
  }

  useEffect(() => {
    if (selectedMonth) {
      const [year, month] = selectedMonth.split('-').map(Number)
      const bounds = getMonthBounds(year, month)
      setFromDate(bounds.start)
      setToDate(bounds.end)
      setSubmittedFromDate(bounds.start)
      setSubmittedToDate(bounds.end)
    }
  }, [selectedMonth])

  const handleFromDateChange = (value: string) => {
    setFromDate(value)
    if (value > toDate) {
      setToDate(value)
    }
    setSelectedMonth('')
    setSelectionMode('custom')
  }

  const handleToDateChange = (value: string) => {
    setToDate(value)
    if (value < fromDate) {
      setFromDate(value)
    }
    setSelectedMonth('')
    setSelectionMode('custom')
  }

  const handleMonthChange = (value: string) => {
    setSelectedMonth(value)
    if (value) {
      setSelectionMode('month')
    } else {
      setSelectionMode('custom')
    }
  }

  const setLast30Days = () => {
    const end = new Date()
    end.setDate(end.getDate() - 1)
    const start = new Date(end)
    start.setDate(end.getDate() - 30)
    const startStr = formatDate(start)
    const endStr = formatDate(end)
    setFromDate(startStr)
    setToDate(endStr)
    setSubmittedFromDate(startStr)
    setSubmittedToDate(endStr)
    setSelectedMonth('')
    setSelectionMode('last30')
  }

  const setThisMonth = () => {
    const now = new Date()
    const monthKey = `${now.getFullYear()}-${now.getMonth()}`
    const bounds = getMonthBounds(now.getFullYear(), now.getMonth())
    setFromDate(bounds.start)
    setToDate(bounds.end)
    setSubmittedFromDate(bounds.start)
    setSubmittedToDate(bounds.end)
    setSelectedMonth(monthKey)
    setSelectionMode('month')
  }

  const setLastMonth = () => {
    const now = new Date()
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const monthKey = `${lastMonth.getFullYear()}-${lastMonth.getMonth()}`
    const bounds = getMonthBounds(lastMonth.getFullYear(), lastMonth.getMonth())
    setFromDate(bounds.start)
    setToDate(bounds.end)
    setSubmittedFromDate(bounds.start)
    setSubmittedToDate(bounds.end)
    setSelectedMonth(monthKey)
    setSelectionMode('month')
  }

  const setThisWeek = () => {
    const today = new Date()
    const dayOfWeek = today.getDay()
    const monday = new Date(today)
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
    const end = new Date()
    end.setDate(end.getDate() - 1)
    const startStr = formatDate(monday)
    const endStr = formatDate(end)
    setFromDate(startStr)
    setToDate(endStr)
    setSubmittedFromDate(startStr)
    setSubmittedToDate(endStr)
    setSelectedMonth('')
    setSelectionMode('week')
  }

  const setLastWeek = () => {
    const today = new Date()
    const dayOfWeek = today.getDay()
    const lastMonday = new Date(today)
    lastMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) - 7)
    const lastSunday = new Date(lastMonday)
    lastSunday.setDate(lastMonday.getDate() + 6)
    const startStr = formatDate(lastMonday)
    const endStr = formatDate(lastSunday)
    setFromDate(startStr)
    setToDate(endStr)
    setSubmittedFromDate(startStr)
    setSubmittedToDate(endStr)
    setSelectedMonth('')
    setSelectionMode('week')
  }

  const getPeriodPrefix = (): string => {
    if (selectionMode === 'last30') {
      return 'Last 30 Days: '
    } else if (selectionMode === 'week') {
      return 'Week: '
    } else if (selectionMode === 'month' && selectedMonth) {
      const [year, month] = selectedMonth.split('-').map(Number)
      const monthName = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      return `Month of ${monthName}: `
    } else {
      return 'Custom Dates: '
    }
  }

  // Fetch purchases summary
  const { data: summary, isLoading, error } = useQuery<PurchasesSummaryResponse>({
    queryKey: ['purchases-summary', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/purchases/summary?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch purchases summary')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  // Fetch daily supplier data for chart
  const { data: chartData } = useQuery<DailySupplierChartResponse>({
    queryKey: ['purchases-daily-supplier', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/purchases/daily-by-supplier?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch chart data')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  // Fetch top items (with optional supplier filter)
  const { data: topItems } = useQuery<TopItemsResponse>({
    queryKey: ['purchases-top-items', submittedFromDate, submittedToDate, topItemsSupplierFilter],
    queryFn: async () => {
      let url = `/api/reports/purchases/top-items?from_date=${submittedFromDate}&to_date=${submittedToDate}`
      if (topItemsSupplierFilter !== null) {
        url += `&supplier_id=${topItemsSupplierFilter}`
      }
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch top items')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  const formatCurrency = (value: number, showCR = false) => {
    const num = Number(value)
    if (num < 0 && showCR) {
      return `-£${Math.abs(num).toFixed(2)} CR`
    }
    return `£${num.toFixed(2)}`
  }

  // Helper to get Monday of a given week
  const getWeekStart = (dateStr: string): string => {
    const d = new Date(dateStr)
    const day = d.getDay()
    const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Adjust for Monday
    const monday = new Date(d.setDate(diff))
    return monday.toISOString().split('T')[0]
  }

  // Weekly bar chart for suppliers
  const renderChart = () => {
    if (!chartData?.data?.length || !chartData?.suppliers?.length) {
      return <div style={styles.noData}>No chart data available</div>
    }

    const width = 650
    const height = 280
    const padding = { top: 20, right: 20, bottom: 40, left: 60 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    const suppliers = chartData.suppliers
    const supplierColorMap: Record<string, string> = {}
    suppliers.forEach((s, i) => {
      supplierColorMap[s] = SUPPLIER_COLORS[i % SUPPLIER_COLORS.length]
    })

    // Group data by week (Mon-Sun)
    const weeklyData: Record<string, Record<string, number>> = {}
    chartData.data.forEach(point => {
      const weekStart = getWeekStart(point.date)
      if (!weeklyData[weekStart]) {
        weeklyData[weekStart] = {}
        suppliers.forEach(s => { weeklyData[weekStart][s] = 0 })
      }
      weeklyData[weekStart][point.supplier_name] =
        (weeklyData[weekStart][point.supplier_name] || 0) + (Number(point.net_purchases) || 0)
    })

    const weeks = Object.keys(weeklyData).sort()
    if (weeks.length === 0) {
      return <div style={styles.noData}>No chart data available</div>
    }

    // Find max value across all weeks and suppliers
    let maxValue = 1
    weeks.forEach(week => {
      suppliers.forEach(s => {
        const val = weeklyData[week][s] || 0
        if (val > maxValue) maxValue = val
      })
    })

    // Scale functions
    const weekWidth = chartWidth / weeks.length
    const barGroupWidth = weekWidth * 0.8
    const barWidth = Math.min(barGroupWidth / suppliers.length, 25)
    const yScale = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight

    // Y-axis labels
    const yLabels = [0, maxValue / 2, maxValue].map(v => ({
      value: v,
      y: yScale(v),
      label: `£${(Number(v) / 1000).toFixed(Number(v) >= 1000 ? 0 : 1)}k`
    }))

    return (
      <div style={styles.chartContainer}>
        <h4 style={styles.chartTitle}>Weekly Purchases by Supplier</h4>
        <svg width={width} height={height} style={styles.chartSvg}>
          {/* Horizontal grid lines */}
          {yLabels.map((l, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                y1={l.y}
                x2={width - padding.right}
                y2={l.y}
                stroke="#eee"
                strokeDasharray="4,4"
              />
              <text x={padding.left - 5} y={l.y + 4} textAnchor="end" fontSize="10" fill="#666">
                {l.label}
              </text>
            </g>
          ))}

          {/* Bars for each week */}
          {weeks.map((week, weekIndex) => {
            const weekCenterX = padding.left + (weekIndex + 0.5) * weekWidth
            const groupStartX = weekCenterX - (suppliers.length * barWidth) / 2

            return (
              <g key={week}>
                {/* X-axis label for week */}
                <text
                  x={weekCenterX}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#666"
                >
                  {new Date(week).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </text>

                {/* Bars for each supplier */}
                {suppliers.map((supplier, supplierIndex) => {
                  const value = weeklyData[week][supplier] || 0
                  if (value <= 0) return null
                  const barHeight = (value / maxValue) * chartHeight
                  const barX = groupStartX + supplierIndex * barWidth

                  return (
                    <rect
                      key={`${week}-${supplier}`}
                      x={barX}
                      y={padding.top + chartHeight - barHeight}
                      width={barWidth - 1}
                      height={barHeight}
                      fill={supplierColorMap[supplier]}
                    />
                  )
                })}
              </g>
            )
          })}
        </svg>
        <div style={styles.chartLegend}>
          {suppliers.map((supplier) => (
            <span key={supplier} style={styles.legendItem}>
              <span style={{ ...styles.legendColor, background: supplierColorMap[supplier] }} />
              {supplier}
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading purchases data...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading purchases data: {(error as Error).message}</div>
  }

  return (
    <div>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>Purchases Report</h2>
      </div>

      {/* Date Selection Controls */}
      <div style={styles.dateControls}>
        <div style={styles.dateRow}>
          <div style={styles.dateField}>
            <label style={styles.dateLabel}>From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => handleFromDateChange(e.target.value)}
              style={styles.dateInput}
            />
          </div>
          <div style={styles.dateField}>
            <label style={styles.dateLabel}>To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => handleToDateChange(e.target.value)}
              style={styles.dateInput}
            />
          </div>
          <div style={styles.dateField}>
            <label style={styles.dateLabel}>Month</label>
            <select
              value={selectedMonth}
              onChange={(e) => handleMonthChange(e.target.value)}
              style={styles.monthSelect}
            >
              <option value="">Custom Range</option>
              {monthOptions.map((opt) => (
                <option key={`${opt.year}-${opt.month}`} value={`${opt.year}-${opt.month}`}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={styles.presetRow}>
          <button onClick={setLast30Days} style={styles.presetBtn}>Last 30 Days</button>
          <button onClick={setThisWeek} style={styles.presetBtn}>This Week</button>
          <button onClick={setLastWeek} style={styles.presetBtn}>Last Week</button>
          <button onClick={setThisMonth} style={styles.presetBtn}>This Month</button>
          <button onClick={setLastMonth} style={styles.presetBtn}>Last Month</button>
          <button
            onClick={handleGenerate}
            disabled={!hasUnsavedChanges}
            style={{
              ...styles.generateBtn,
              ...(hasUnsavedChanges ? {} : styles.generateBtnDisabled),
            }}
          >
            {hasUnsavedChanges ? 'Generate Report' : 'Report Generated'}
          </button>
        </div>
      </div>

      {/* Period Label */}
      <div style={styles.periodLabel}>{getPeriodPrefix()}{summary?.period_label}</div>

      {/* Main Content */}
      <div style={styles.mainContent}>
        {/* Supplier Breakdown */}
        <div style={styles.sectionContainer}>
          <h3 style={styles.sectionTitle}>Supplier Breakdown</h3>
          <div style={styles.totalRow}>
            <span>Total Purchases:</span>
            <span style={{
              ...styles.totalValue,
              ...((summary?.total_purchases || 0) < 0 ? { color: '#28a745' } : {})
            }}>
              {formatCurrency(summary?.total_purchases || 0, true)}
            </span>
          </div>
          <table style={styles.breakdownTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Supplier</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Net Purchases</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>%</th>
              </tr>
            </thead>
            <tbody>
              {summary?.supplier_breakdown?.length ? (
                summary.supplier_breakdown.map((supplier, index) => {
                  const isCredit = supplier.net_purchases < 0
                  return (
                    <tr key={supplier.supplier_id || `unknown-${index}`} style={isCredit ? { background: '#d4edda' } : {}}>
                      <td style={styles.tableCell}>
                        {supplier.supplier_name}
                        {isCredit && <span style={{ color: '#28a745', fontWeight: 'bold', marginLeft: '0.5rem' }}>(CR)</span>}
                      </td>
                      <td style={{
                        ...styles.tableCell,
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        ...(isCredit ? { color: '#28a745', fontWeight: 'bold' } : {})
                      }}>
                        {formatCurrency(supplier.net_purchases, true)}
                      </td>
                      <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                        {Number(supplier.percentage).toFixed(1)}%
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={3} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                    No supplier data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Chart */}
        <div style={styles.sectionContainer}>
          {renderChart()}
        </div>
      </div>

      {/* Top Items Section with Supplier Filter */}
      <div style={styles.topItemsFilterRow}>
        <span style={styles.filterLabel}>Filter by Supplier:</span>
        <select
          value={topItemsSupplierFilter === null ? '' : topItemsSupplierFilter}
          onChange={(e) => setTopItemsSupplierFilter(e.target.value === '' ? null : Number(e.target.value))}
          style={styles.supplierSelect}
        >
          <option value="">All Suppliers</option>
          {summary?.supplier_breakdown?.map((s: SupplierBreakdown) => (
            <option key={s.supplier_id ?? 'unknown'} value={s.supplier_id ?? ''}>
              {s.supplier_name}
            </option>
          ))}
        </select>
      </div>

      {/* Top Items Tables */}
      <div style={styles.breakdownRow}>
        {/* Top by Quantity */}
        <div style={styles.breakdownContainer}>
          <h3 style={styles.sectionTitle}>Top 10 Line Items by Quantity</h3>
          <table style={styles.breakdownTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>#</th>
                <th style={styles.tableHeader}>Item</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Qty</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {topItems?.top_by_quantity?.length ? (
                topItems.top_by_quantity.map((item, index) => (
                  <tr key={`qty-${index}`}>
                    <td style={{ ...styles.tableCell, color: '#999', width: '30px' }}>{index + 1}</td>
                    <td style={styles.tableCell}>{getFirstLineOfDescription(item.description)}</td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                      {Number(item.total_quantity).toFixed(1)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#666' }}>
                      {formatCurrency(item.total_value)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                    No data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Top by Value */}
        <div style={styles.breakdownContainer}>
          <h3 style={styles.sectionTitle}>Top 10 Line Items by Value</h3>
          <table style={styles.breakdownTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>#</th>
                <th style={styles.tableHeader}>Item</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Value</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Qty</th>
              </tr>
            </thead>
            <tbody>
              {topItems?.top_by_value?.length ? (
                topItems.top_by_value.map((item, index) => (
                  <tr key={`val-${index}`}>
                    <td style={{ ...styles.tableCell, color: '#999', width: '30px' }}>{index + 1}</td>
                    <td style={styles.tableCell}>{getFirstLineOfDescription(item.description)}</td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                      {formatCurrency(item.total_value)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#666' }}>
                      {Number(item.total_quantity).toFixed(1)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                    No data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  error: {
    padding: '2rem',
    textAlign: 'center',
    color: '#c00',
    background: '#fee',
    borderRadius: '8px',
  },
  noData: {
    padding: '2rem',
    textAlign: 'center',
    color: '#999',
  },
  header: {
    marginBottom: '1.5rem',
  },
  title: {
    color: '#1a1a2e',
    margin: 0,
  },
  dateControls: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '1rem',
  },
  dateRow: {
    display: 'flex',
    gap: '1.5rem',
    flexWrap: 'wrap',
    marginBottom: '1rem',
  },
  dateField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  dateLabel: {
    fontSize: '0.85rem',
    color: '#666',
    fontWeight: 500,
  },
  dateInput: {
    padding: '0.5rem 0.75rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '1rem',
    minWidth: '150px',
  },
  monthSelect: {
    padding: '0.5rem 0.75rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '1rem',
    minWidth: '180px',
    background: 'white',
  },
  presetRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  presetBtn: {
    padding: '0.4rem 0.75rem',
    background: '#f0f0f0',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  generateBtn: {
    padding: '0.4rem 1rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 'bold',
    marginLeft: 'auto',
  },
  generateBtnDisabled: {
    background: '#ccc',
    cursor: 'default',
  },
  periodLabel: {
    fontSize: '1.1rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: '1rem',
    textAlign: 'center',
  },
  mainContent: {
    display: 'flex',
    gap: '1.5rem',
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  sectionContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '2rem',
    flex: '1 1 auto',
    minWidth: '300px',
  },
  sectionTitle: {
    margin: '0 0 1rem 0',
    color: '#1a1a2e',
  },
  totalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.75rem',
    background: '#f8f9fa',
    borderRadius: '6px',
    marginBottom: '1rem',
    fontWeight: 600,
  },
  totalValue: {
    fontFamily: 'monospace',
    color: '#e94560',
  },
  breakdownTable: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  tableHeader: {
    textAlign: 'left',
    padding: '0.75rem 0.5rem',
    borderBottom: '2px solid #dee2e6',
    color: '#1a1a2e',
    fontWeight: 600,
    fontSize: '0.85rem',
  },
  tableCell: {
    padding: '0.5rem',
    borderBottom: '1px solid #f0f0f0',
    fontSize: '0.9rem',
  },
  chartContainer: {
    width: '100%',
  },
  chartTitle: {
    margin: '0 0 1rem 0',
    color: '#1a1a2e',
    fontSize: '1rem',
    fontWeight: 600,
  },
  chartSvg: {
    display: 'block',
    maxWidth: '100%',
  },
  chartLegend: {
    display: 'flex',
    gap: '0.5rem 1rem',
    marginTop: '0.75rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
    padding: '0.25rem',
    maxWidth: '450px',
    margin: '0.75rem auto 0',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    fontSize: '0.7rem',
    color: '#555',
    whiteSpace: 'nowrap',
  },
  legendColor: {
    width: '10px',
    height: '10px',
    borderRadius: '2px',
    display: 'inline-block',
    flexShrink: 0,
  },
  breakdownRow: {
    display: 'flex',
    gap: '1.5rem',
    flexWrap: 'wrap',
    marginBottom: '1.5rem',
  },
  breakdownContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    flex: '1 1 300px',
    minWidth: '280px',
  },
  topItemsFilterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1rem',
    padding: '0.75rem 1rem',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
  filterLabel: {
    fontSize: '0.9rem',
    color: '#555',
    fontWeight: 500,
  },
  supplierSelect: {
    padding: '0.5rem 0.75rem',
    borderRadius: '6px',
    border: '1px solid #ddd',
    fontSize: '0.9rem',
    minWidth: '200px',
    cursor: 'pointer',
  },
}
