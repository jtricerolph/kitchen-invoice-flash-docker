import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface AllowancesSummaryResponse {
  from_date: string
  to_date: string
  period_label: string
  wastage_total: number
  wastage_count: number
  transfer_total: number
  transfer_count: number
  staff_food_total: number
  staff_food_count: number
  manual_adjustment_total: number
  manual_adjustment_count: number
  total_allowances: number
}

interface DailyAllowanceDataPoint {
  date: string
  wastage: number
  transfer: number
  staff_food: number
  manual_adjustment: number
}

interface DailyAllowanceChartResponse {
  from_date: string
  to_date: string
  data: DailyAllowanceDataPoint[]
}

interface DisputeTallyRow {
  label: string
  count: number
  difference_value: number
}

interface DisputesSummaryResponse {
  from_date: string
  to_date: string
  period_label: string
  rows: DisputeTallyRow[]
}

// Helper to format date as YYYY-MM-DD for input fields and API
const formatDate = (d: Date): string => {
  return d.toISOString().split('T')[0]
}

// Get the start and end of a given month
const getMonthBounds = (year: number, month: number): { start: string; end: string } => {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0)
  return { start: formatDate(start), end: formatDate(end) }
}

// Generate list of months for the picker
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
const STORAGE_KEY_FROM = 'allowances-report-from-date'
const STORAGE_KEY_TO = 'allowances-report-to-date'

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

// Colors for allowance types
const ALLOWANCE_COLORS = {
  wastage: '#e74c3c',      // Red
  transfer: '#3498db',      // Blue
  staff_food: '#9b59b6',    // Purple
  manual_adjustment: '#34495e', // Dark gray
}

export default function AllowancesReport() {
  const { token } = useAuth()
  const initialDates = getInitialDates()

  const [fromDate, setFromDate] = useState(initialDates.from)
  const [toDate, setToDate] = useState(initialDates.to)
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [selectionMode, setSelectionMode] = useState<'last30' | 'week' | 'month' | 'custom'>('custom')

  const [submittedFromDate, setSubmittedFromDate] = useState(initialDates.from)
  const [submittedToDate, setSubmittedToDate] = useState(initialDates.to)

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

  // Fetch allowances summary
  const { data: summary, isLoading, error } = useQuery<AllowancesSummaryResponse>({
    queryKey: ['allowances-summary', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/allowances/summary?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch allowances summary')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  // Fetch daily allowances for chart
  const { data: chartData } = useQuery<DailyAllowanceChartResponse>({
    queryKey: ['allowances-daily', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/allowances/daily?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch chart data')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  // Fetch disputes summary
  const { data: disputes } = useQuery<DisputesSummaryResponse>({
    queryKey: ['disputes-period-summary', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/disputes/period-summary?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch disputes summary')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  const formatCurrency = (value: number) => {
    return `£${Number(value).toFixed(2)}`
  }

  // Helper to get Monday of a given week
  const getWeekStart = (dateStr: string): string => {
    const d = new Date(dateStr)
    const day = d.getDay()
    const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Adjust for Monday
    const monday = new Date(d.setDate(diff))
    return monday.toISOString().split('T')[0]
  }

  // Weekly bar chart for allowances
  const renderChart = () => {
    if (!chartData?.data?.length) {
      return <div style={styles.noData}>No chart data available</div>
    }

    const width = 550
    const height = 250
    const padding = { top: 20, right: 20, bottom: 40, left: 60 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    const types = [
      { key: 'wastage', color: ALLOWANCE_COLORS.wastage, label: 'Wastage' },
      { key: 'transfer', color: ALLOWANCE_COLORS.transfer, label: 'Transfers' },
      { key: 'staff_food', color: ALLOWANCE_COLORS.staff_food, label: 'Staff Food' },
      { key: 'manual_adjustment', color: ALLOWANCE_COLORS.manual_adjustment, label: 'Manual Adj.' },
    ]

    // Group data by week (Mon-Sun)
    const weeklyData: Record<string, Record<string, number>> = {}
    chartData.data.forEach(point => {
      const weekStart = getWeekStart(point.date)
      if (!weeklyData[weekStart]) {
        weeklyData[weekStart] = { wastage: 0, transfer: 0, staff_food: 0, manual_adjustment: 0 }
      }
      weeklyData[weekStart].wastage += Number(point.wastage) || 0
      weeklyData[weekStart].transfer += Number(point.transfer) || 0
      weeklyData[weekStart].staff_food += Number(point.staff_food) || 0
      weeklyData[weekStart].manual_adjustment += Number(point.manual_adjustment) || 0
    })

    const weeks = Object.keys(weeklyData).sort()
    if (weeks.length === 0) {
      return <div style={styles.noData}>No chart data available</div>
    }

    // Find max value across all weeks and types
    let maxValue = 1
    weeks.forEach(week => {
      types.forEach(t => {
        const val = weeklyData[week][t.key] || 0
        if (val > maxValue) maxValue = val
      })
    })

    // Scale functions
    const weekWidth = chartWidth / weeks.length
    const barGroupWidth = weekWidth * 0.8
    const barWidth = Math.min(barGroupWidth / types.length, 25)
    const yScale = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight

    // Y-axis labels
    const yLabels = [0, maxValue / 2, maxValue].map(v => ({
      value: v,
      y: yScale(v),
      label: `£${Number(v).toFixed(0)}`
    }))

    return (
      <div style={styles.chartContainer}>
        <h4 style={styles.chartTitle}>Weekly Allowances</h4>
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
            const groupStartX = weekCenterX - (types.length * barWidth) / 2

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

                {/* Bars for each type */}
                {types.map((type, typeIndex) => {
                  const value = weeklyData[week][type.key] || 0
                  if (value <= 0) return null
                  const barHeight = (value / maxValue) * chartHeight
                  const barX = groupStartX + typeIndex * barWidth

                  return (
                    <rect
                      key={`${week}-${type.key}`}
                      x={barX}
                      y={padding.top + chartHeight - barHeight}
                      width={barWidth - 1}
                      height={barHeight}
                      fill={type.color}
                    />
                  )
                })}
              </g>
            )
          })}
        </svg>
        <div style={styles.chartLegend}>
          {types.map(({ key, color, label }) => (
            <span key={key} style={styles.legendItem}>
              <span style={{ ...styles.legendColor, background: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading allowances data...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading allowances data: {(error as Error).message}</div>
  }

  return (
    <div>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>Allowances Report</h2>
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
        {/* Allowances Breakdown */}
        <div style={styles.sectionContainer}>
          <h3 style={styles.sectionTitle}>Allowances Breakdown</h3>
          <table style={styles.breakdownTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Type</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Entries</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={styles.tableCell}>
                  <span style={{ ...styles.typeDot, background: ALLOWANCE_COLORS.wastage }} />
                  Wastage
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                  {summary?.wastage_count || 0}
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: ALLOWANCE_COLORS.wastage }}>
                  {formatCurrency(summary?.wastage_total || 0)}
                </td>
              </tr>
              <tr>
                <td style={styles.tableCell}>
                  <span style={{ ...styles.typeDot, background: ALLOWANCE_COLORS.transfer }} />
                  Transfers
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                  {summary?.transfer_count || 0}
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: ALLOWANCE_COLORS.transfer }}>
                  {formatCurrency(summary?.transfer_total || 0)}
                </td>
              </tr>
              <tr>
                <td style={styles.tableCell}>
                  <span style={{ ...styles.typeDot, background: ALLOWANCE_COLORS.staff_food }} />
                  Staff Food
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                  {summary?.staff_food_count || 0}
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: ALLOWANCE_COLORS.staff_food }}>
                  {formatCurrency(summary?.staff_food_total || 0)}
                </td>
              </tr>
              <tr>
                <td style={styles.tableCell}>
                  <span style={{ ...styles.typeDot, background: ALLOWANCE_COLORS.manual_adjustment }} />
                  Manual Adjustments
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                  {summary?.manual_adjustment_count || 0}
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: ALLOWANCE_COLORS.manual_adjustment }}>
                  {formatCurrency(summary?.manual_adjustment_total || 0)}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #dee2e6' }}>
                <td style={{ ...styles.tableCell, fontWeight: 'bold' }}>Total</td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                  {(summary?.wastage_count || 0) + (summary?.transfer_count || 0) + (summary?.staff_food_count || 0) + (summary?.manual_adjustment_count || 0)}
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold', color: '#27ae60' }}>
                  {formatCurrency(summary?.total_allowances || 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Chart */}
        <div style={styles.sectionContainer}>
          {renderChart()}
        </div>
      </div>

      {/* Disputes Summary */}
      <div style={styles.disputesSection}>
        <h3 style={styles.sectionTitle}>Disputes Summary</h3>
        <p style={styles.disputesSubtitle}>Cases opened in selected period (by invoice date)</p>
        <table style={styles.breakdownTable}>
          <thead>
            <tr>
              <th style={styles.tableHeader}>Status</th>
              <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Count</th>
              <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Difference Value</th>
            </tr>
          </thead>
          <tbody>
            {disputes?.rows?.map((row, index) => (
              <tr key={index} style={row.label === 'Total Cases' ? { background: '#f8f9fa' } : {}}>
                <td style={{ ...styles.tableCell, fontWeight: row.label === 'Total Cases' ? 'bold' : 'normal' }}>
                  {row.label}
                </td>
                <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: row.label === 'Total Cases' ? 'bold' : 'normal' }}>
                  {row.count}
                </td>
                <td style={{
                  ...styles.tableCell,
                  textAlign: 'right',
                  fontFamily: 'monospace',
                  fontWeight: row.label === 'Total Cases' ? 'bold' : 'normal',
                  color: row.label === 'Resolved' ? '#27ae60' : row.label === 'Still Open' ? '#e67e22' : undefined
                }}>
                  {formatCurrency(row.difference_value)}
                </td>
              </tr>
            )) || (
              <tr>
                <td colSpan={3} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                  No disputes data
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
  typeDot: {
    display: 'inline-block',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    marginRight: '8px',
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
    gap: '0.5rem 0.75rem',
    marginTop: '0.5rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
    maxHeight: '60px',
    overflowY: 'auto',
    padding: '0.25rem',
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
  disputesSection: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '2rem',
  },
  disputesSubtitle: {
    color: '#666',
    fontSize: '0.85rem',
    margin: '0 0 1rem 0',
  },
}
