import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface SupplierBreakdown {
  supplier_id: number | null
  supplier_name: string
  net_purchases: number
  percentage: number
}

interface GLAccountBreakdown {
  gl_account_id: number
  gl_account_name: string
  net_revenue: number
  percentage: number
}

interface DateRangeGPResponse {
  from_date: string
  to_date: string
  period_label: string
  net_food_sales: number
  net_food_purchases: number
  gross_profit: number
  gross_profit_percent: number
  supplier_breakdown: SupplierBreakdown[]
  gl_account_breakdown: GLAccountBreakdown[]
}

interface DailyDataPoint {
  date: string
  net_sales: number
  net_purchases: number
  occupancy: number | null
  lunch_covers: number | null
  dinner_covers: number | null
  total_covers: number | null
}

interface DailyChartData {
  from_date: string
  to_date: string
  data: DailyDataPoint[]
}

interface TopSellerItem {
  item_name: string
  qty: number
  revenue: number
}

interface PackageFavoriteItem {
  item_name: string
  qty: number
}

interface CategoryTopSellers {
  category: string
  top_by_qty: TopSellerItem[]
  top_by_revenue: TopSellerItem[]
}

interface TopSellersResponse {
  from_date: string
  to_date: string
  source: 'sambapos' | 'newbook'
  // SambaPOS category-based format
  categories: CategoryTopSellers[]
  // Legacy Newbook format
  top_by_qty: TopSellerItem[]
  top_by_revenue: TopSellerItem[]
  package_favorites: PackageFavoriteItem[]
  total_charges_processed: number
  total_items_aggregated: number
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

// Generate list of months for the picker (last 12 months + next 2 months)
const getMonthOptions = (): { label: string; year: number; month: number }[] => {
  const options: { label: string; year: number; month: number }[] = []
  const today = new Date()

  // Start from 12 months ago
  for (let i = -12; i <= 2; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1)
    const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    options.push({ label, year: d.getFullYear(), month: d.getMonth() })
  }

  return options.reverse() // Most recent first
}

// Session storage keys for persisting dates while tab is open
const STORAGE_KEY_FROM = 'gp-report-from-date'
const STORAGE_KEY_TO = 'gp-report-to-date'

// Get initial dates - from sessionStorage if available, otherwise default to last 30 days
const getInitialDates = () => {
  const storedFrom = sessionStorage.getItem(STORAGE_KEY_FROM)
  const storedTo = sessionStorage.getItem(STORAGE_KEY_TO)

  if (storedFrom && storedTo) {
    return { from: storedFrom, to: storedTo }
  }

  // Default: rolling past 30 days from yesterday
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const thirtyDaysAgo = new Date(yesterday)
  thirtyDaysAgo.setDate(yesterday.getDate() - 30)

  return { from: formatDate(thirtyDaysAgo), to: formatDate(yesterday) }
}

export default function GPReport() {
  const { token } = useAuth()

  // Get initial dates (from session or defaults)
  const initialDates = getInitialDates()

  // Input state (for typing without triggering queries)
  const [fromDate, setFromDate] = useState(initialDates.from)
  const [toDate, setToDate] = useState(initialDates.to)
  const [selectedMonth, setSelectedMonth] = useState<string>('') // Empty means custom range
  const [selectionMode, setSelectionMode] = useState<'last30' | 'week' | 'month' | 'custom'>('custom')

  // Submitted state (actually used for queries - only changes on Generate click)
  const [submittedFromDate, setSubmittedFromDate] = useState(initialDates.from)
  const [submittedToDate, setSubmittedToDate] = useState(initialDates.to)

  // Persist submitted dates to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY_FROM, submittedFromDate)
    sessionStorage.setItem(STORAGE_KEY_TO, submittedToDate)
  }, [submittedFromDate, submittedToDate])

  const monthOptions = getMonthOptions()

  // Track if dates have changed since last generation
  const hasUnsavedChanges = fromDate !== submittedFromDate || toDate !== submittedToDate

  // Generate report with current date selection
  const handleGenerate = () => {
    setSubmittedFromDate(fromDate)
    setSubmittedToDate(toDate)
  }

  // When month selection changes, update the date fields and submit
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

  // When date fields are manually changed, clear the month selection
  // Auto-adjust the other date if the range becomes invalid
  const handleFromDateChange = (value: string) => {
    setFromDate(value)
    // If from date is after to date, set to date to match from date
    if (value > toDate) {
      setToDate(value)
    }
    setSelectedMonth('')
    setSelectionMode('custom')
  }

  const handleToDateChange = (value: string) => {
    setToDate(value)
    // If to date is before from date, set from date to match to date
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

  // Quick preset buttons - these also immediately submit the dates
  const setLast30Days = () => {
    const end = new Date()
    end.setDate(end.getDate() - 1) // Yesterday (today won't have confirmed sales)
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
    // Calculate Monday of current week (0 = Sunday, 1 = Monday, etc.)
    const monday = new Date(today)
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
    // End date is yesterday (today won't have confirmed sales)
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
    // Calculate Monday of last week
    const lastMonday = new Date(today)
    lastMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) - 7)
    // Sunday of last week
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

  // Get the period prefix based on selection mode
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

  const { data, isLoading, error } = useQuery<DateRangeGPResponse>({
    queryKey: ['gp-range', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/gp/range?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch GP data')
      return res.json()
    },
    staleTime: 5 * 60 * 1000, // Keep data fresh for 5 minutes
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
  })

  // Fetch daily chart data
  const { data: chartData } = useQuery<DailyChartData>({
    queryKey: ['gp-daily', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/gp/daily?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch chart data')
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  // Fetch top sellers data
  const { data: topSellers, isLoading: topSellersLoading } = useQuery<TopSellersResponse>({
    queryKey: ['gp-top-sellers', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/gp/top-sellers?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        // Don't throw for top sellers - just return empty data
        return { from_date: submittedFromDate, to_date: submittedToDate, source: 'newbook' as const, categories: [], top_by_qty: [], top_by_revenue: [], package_favorites: [], total_charges_processed: 0, total_items_aggregated: 0 }
      }
      return res.json()
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  const formatCurrency = (value: number) => {
    return `£${Number(value).toFixed(2)}`
  }

  // Simple SVG line chart component
  const renderChart = () => {
    if (!chartData?.data?.length) return null

    const width = 500
    const height = 200
    const padding = { top: 20, right: 20, bottom: 30, left: 50 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    const dataPoints = chartData.data
    const maxValue = Math.max(
      ...dataPoints.map(d => Math.max(d.net_sales, d.net_purchases)),
      1 // Avoid division by zero
    )

    // Scale functions
    const xScale = (index: number) => padding.left + (index / (dataPoints.length - 1 || 1)) * chartWidth
    const yScale = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight

    // Create path for sales line
    const salesPath = dataPoints.map((d, i) =>
      `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.net_sales)}`
    ).join(' ')

    // Create path for purchases line
    const purchasesPath = dataPoints.map((d, i) =>
      `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.net_purchases)}`
    ).join(' ')

    // Y-axis labels
    const yLabels = [0, maxValue / 2, maxValue].map(v => ({
      value: v,
      y: yScale(v),
      label: `£${(v / 1000).toFixed(v >= 1000 ? 0 : 1)}k`
    }))

    // X-axis labels (show first, middle, last dates)
    const xLabels = [
      { index: 0, label: new Date(dataPoints[0].date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) },
      { index: Math.floor(dataPoints.length / 2), label: new Date(dataPoints[Math.floor(dataPoints.length / 2)]?.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) },
      { index: dataPoints.length - 1, label: new Date(dataPoints[dataPoints.length - 1].date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) },
    ]

    // Find week boundaries (Mondays) for vertical lines
    const weekLines: number[] = []
    dataPoints.forEach((d, i) => {
      const date = new Date(d.date)
      if (date.getDay() === 1 && i > 0) { // Monday and not first point
        weekLines.push(i)
      }
    })

    return (
      <div style={styles.chartContainer}>
        <h4 style={styles.chartTitle}>Daily Sales & Purchases</h4>
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

          {/* Vertical week boundary lines */}
          {weekLines.map((index, i) => (
            <line
              key={`week-${i}`}
              x1={xScale(index)}
              y1={padding.top}
              x2={xScale(index)}
              y2={height - padding.bottom}
              stroke="#ccc"
              strokeDasharray="4,4"
            />
          ))}

          {/* X-axis labels */}
          {xLabels.map((l, i) => (
            <text
              key={i}
              x={xScale(l.index)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#666"
            >
              {l.label}
            </text>
          ))}

          {/* Sales line (green) */}
          <path d={salesPath} fill="none" stroke="#28a745" strokeWidth="2" />

          {/* Purchases line (red) */}
          <path d={purchasesPath} fill="none" stroke="#dc3545" strokeWidth="2" />
        </svg>
        <div style={styles.chartLegend}>
          <span style={styles.legendItem}>
            <span style={{ ...styles.legendColor, background: '#28a745' }} /> Net Sales
          </span>
          <span style={styles.legendItem}>
            <span style={{ ...styles.legendColor, background: '#dc3545' }} /> Net Purchases
          </span>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading GP data...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading GP data: {(error as Error).message}</div>
  }

  const { period_label = '', net_food_sales = 0, net_food_purchases = 0, gross_profit = 0, gross_profit_percent = 0 } = data || {}

  const isNegativeGP = gross_profit < 0

  return (
    <div>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>Kitchen Flash Report</h2>
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
      <div style={styles.periodLabel}>{getPeriodPrefix()}{period_label}</div>

      {/* Main Content - GP Estimate and Chart side by side */}
      <div style={styles.mainContent}>
        {/* Gross Profit Estimate Section */}
        <div style={styles.sectionContainer}>
          <h3 style={styles.sectionTitle}>Gross Profit Estimate</h3>

          <div style={styles.calculationContainer}>
            <div style={styles.calcRow}>
              <span style={styles.calcLabel}>Net Food Sales</span>
              <span style={styles.calcValue}>{formatCurrency(net_food_sales)}</span>
            </div>

            <div style={styles.calcRow}>
              <span style={styles.calcLabel}>Net Food Purchases</span>
              <span style={styles.calcValue}>{formatCurrency(net_food_purchases)}</span>
            </div>

            <div style={styles.divider} />

            <div style={styles.calcRow}>
              <span style={styles.calcLabelBold}>Gross Profit</span>
              <span style={{ ...styles.calcValueBold, ...(isNegativeGP ? styles.negativeValue : styles.positiveValue) }}>
                {formatCurrency(gross_profit)}
              </span>
            </div>

            <div style={styles.calcRow}>
              <span style={styles.calcLabelBold}>Gross Profit %</span>
              <span style={{ ...styles.calcValueBold, ...(isNegativeGP ? styles.negativeValue : styles.positiveValue) }}>
                {Number(gross_profit_percent).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>

        {/* Chart Section */}
        <div style={styles.sectionContainer}>
          {renderChart()}
        </div>
      </div>

      {/* Breakdown Tables Row */}
      <div style={styles.breakdownRow}>
        {/* Supplier Breakdown Table */}
        <div style={styles.breakdownContainer}>
          <h3 style={styles.sectionTitle}>Supplier Breakdown</h3>
          <table style={styles.breakdownTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Supplier</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Net Purchases</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>%</th>
              </tr>
            </thead>
            <tbody>
              {data?.supplier_breakdown?.length ? (
                data.supplier_breakdown.map((supplier, index) => (
                  <tr key={supplier.supplier_id || `unknown-${index}`}>
                    <td style={styles.tableCell}>{supplier.supplier_name}</td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                      {formatCurrency(supplier.net_purchases)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                      {Number(supplier.percentage).toFixed(1)}%
                    </td>
                  </tr>
                ))
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

        {/* GL Account Revenue Breakdown Table */}
        <div style={styles.breakdownContainer}>
          <h3 style={styles.sectionTitle}>Revenue Breakdown</h3>
          <table style={styles.breakdownTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>GL Account</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Net Revenue</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>%</th>
              </tr>
            </thead>
            <tbody>
              {data?.gl_account_breakdown?.length ? (
                data.gl_account_breakdown.map((account) => (
                  <tr key={account.gl_account_id}>
                    <td style={styles.tableCell}>{account.gl_account_name}</td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                      {formatCurrency(account.net_revenue)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                      {Number(account.percentage).toFixed(1)}%
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                    No revenue data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top Sellers Section */}
      {topSellersLoading ? (
        <div style={{ ...styles.breakdownContainer, textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ color: '#666', padding: '2rem' }}>Loading top sellers...</div>
        </div>
      ) : topSellers?.source === 'sambapos' && topSellers?.categories?.length > 0 ? (
        /* SambaPOS Category-based Top Sellers */
        <>
          {/* Top Sellers by Quantity - One column per category */}
          <div style={styles.topSellersSection}>
            <h3 style={styles.sectionTitle}>Top Sellers by Quantity</h3>
            <div style={styles.categoryGrid}>
              {topSellers.categories.map((cat) => (
                <div key={cat.category} style={styles.categoryColumn}>
                  <h4 style={styles.categoryHeader}>{cat.category}</h4>
                  <table style={styles.breakdownTable}>
                    <thead>
                      <tr>
                        <th style={styles.tableHeader}>Item</th>
                        <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cat.top_by_qty.length > 0 ? (
                        cat.top_by_qty.map((item) => (
                          <tr key={item.item_name}>
                            <td style={styles.tableCell}>{item.item_name}</td>
                            <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                              {item.qty}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={2} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                            No data
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>

          {/* Top Sellers by Revenue - One column per category */}
          <div style={styles.topSellersSection}>
            <h3 style={styles.sectionTitle}>Top Sellers by Gross Revenue</h3>
            <div style={styles.categoryGrid}>
              {topSellers.categories.map((cat) => (
                <div key={cat.category} style={styles.categoryColumn}>
                  <h4 style={styles.categoryHeader}>{cat.category}</h4>
                  <table style={styles.breakdownTable}>
                    <thead>
                      <tr>
                        <th style={styles.tableHeader}>Item</th>
                        <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cat.top_by_revenue.length > 0 ? (
                        cat.top_by_revenue.map((item) => (
                          <tr key={item.item_name}>
                            <td style={styles.tableCell}>{item.item_name}</td>
                            <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                              {formatCurrency(item.revenue)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={2} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                            No data
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : topSellers?.source === 'sambapos' && (!topSellers?.categories || topSellers.categories.length === 0) ? (
        /* SambaPOS with no categories configured */
        <div style={{ ...styles.breakdownContainer, textAlign: 'center', marginBottom: '1.5rem' }}>
          <h3 style={styles.sectionTitle}>Top Sellers</h3>
          <p style={{ color: '#666', margin: '2rem 0' }}>
            No categories configured. <a href="/sambapos" style={{ color: '#e94560' }}>Configure SambaPOS categories</a> to see top sellers by category.
          </p>
        </div>
      ) : (
        /* Legacy Newbook format - flat lists */
        <div style={styles.breakdownRow}>
          {/* Top Sellers by Quantity */}
          <div style={styles.breakdownContainer}>
            <h3 style={styles.sectionTitle}>Top Sellers by Quantity</h3>
            <table style={styles.breakdownTable}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>#</th>
                  <th style={styles.tableHeader}>Item</th>
                  <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topSellers?.top_by_qty?.length ? (
                  topSellers.top_by_qty.map((item, index) => (
                    <tr key={item.item_name}>
                      <td style={{ ...styles.tableCell, color: '#999', width: '30px' }}>{index + 1}</td>
                      <td style={styles.tableCell}>{item.item_name}</td>
                      <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                        {item.qty}
                      </td>
                      <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#666' }}>
                        {formatCurrency(item.revenue)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                      No top sellers data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Top Sellers by Revenue */}
          <div style={styles.breakdownContainer}>
            <h3 style={styles.sectionTitle}>Top Sellers by Gross Revenue</h3>
            <table style={styles.breakdownTable}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>#</th>
                  <th style={styles.tableHeader}>Item</th>
                  <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Gross</th>
                  <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Qty</th>
                </tr>
              </thead>
              <tbody>
                {topSellers?.top_by_revenue?.length ? (
                  topSellers.top_by_revenue.map((item, index) => (
                    <tr key={item.item_name}>
                      <td style={{ ...styles.tableCell, color: '#999', width: '30px' }}>{index + 1}</td>
                      <td style={styles.tableCell}>{item.item_name}</td>
                      <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                        {formatCurrency(item.revenue)}
                      </td>
                      <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#666' }}>
                        {item.qty}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                      No top sellers data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Package Guest Favorites */}
          <div style={styles.breakdownContainer}>
            <h3 style={styles.sectionTitle}>Package Guest Favorites</h3>
            <table style={styles.breakdownTable}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>#</th>
                  <th style={styles.tableHeader}>Item</th>
                  <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Qty</th>
                </tr>
              </thead>
              <tbody>
                {topSellers?.package_favorites?.length ? (
                  topSellers.package_favorites.map((item, index) => (
                    <tr key={item.item_name}>
                      <td style={{ ...styles.tableCell, color: '#999', width: '30px' }}>{index + 1}</td>
                      <td style={styles.tableCell}>{item.item_name}</td>
                      <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', fontWeight: 'bold' }}>
                        {item.qty}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                      No package data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daily Data Table */}
      <div style={styles.dailyTableContainer}>
        <h3 style={styles.sectionTitle}>Daily Breakdown</h3>
        <div style={styles.tableWrapper}>
          <table style={styles.dailyTable}>
            <thead>
              <tr>
                <th style={styles.tableHeader}>Date</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Net Sales</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Net Purchases</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Occupancy</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Lunch Covers</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Dinner Covers</th>
                <th style={{ ...styles.tableHeader, textAlign: 'right' }}>Total Covers</th>
              </tr>
            </thead>
            <tbody>
              {chartData?.data?.length ? (
                [...chartData.data].reverse().map((day) => (
                  <tr key={day.date}>
                    <td style={styles.tableCell}>
                      {new Date(day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                      {formatCurrency(day.net_sales)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace' }}>
                      {formatCurrency(day.net_purchases)}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#999' }}>
                      {day.occupancy ?? '—'}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#999' }}>
                      {day.lunch_covers ?? '—'}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#999' }}>
                      {day.dinner_covers ?? '—'}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: 'right', fontFamily: 'monospace', color: '#999' }}>
                      {day.total_covers ?? '—'}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} style={{ ...styles.tableCell, textAlign: 'center', color: '#999' }}>
                    No daily data
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
    alignItems: 'flex-start',
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
    margin: '0 0 1.5rem 0',
    color: '#1a1a2e',
  },
  calculationContainer: {
    maxWidth: '400px',
  },
  calcRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 0',
  },
  calcLabel: {
    color: '#555',
    fontSize: '1rem',
  },
  calcValue: {
    fontSize: '1rem',
    fontFamily: 'monospace',
  },
  calcLabelBold: {
    color: '#1a1a2e',
    fontSize: '1.1rem',
    fontWeight: 'bold',
  },
  calcValueBold: {
    fontSize: '1.2rem',
    fontWeight: 'bold',
    fontFamily: 'monospace',
  },
  divider: {
    borderTop: '2px solid #dee2e6',
    margin: '0.5rem 0',
  },
  positiveValue: {
    color: '#155724',
  },
  negativeValue: {
    color: '#dc3545',
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
    gap: '1.5rem',
    marginTop: '0.75rem',
    justifyContent: 'center',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    fontSize: '0.85rem',
    color: '#555',
  },
  legendColor: {
    width: '12px',
    height: '12px',
    borderRadius: '2px',
    display: 'inline-block',
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
  dailyTableContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '2rem',
  },
  tableWrapper: {
    overflowX: 'auto',
  },
  dailyTable: {
    width: '100%',
    borderCollapse: 'collapse',
    minWidth: '700px',
  },
  // SambaPOS category-based top sellers styles
  topSellersSection: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '1.5rem',
  },
  categoryGrid: {
    display: 'flex',
    gap: '1rem',
    flexWrap: 'wrap',
  },
  categoryColumn: {
    flex: '1 1 180px',
    minWidth: '160px',
    maxWidth: '250px',
  },
  categoryHeader: {
    margin: '0 0 0.75rem 0',
    padding: '0.5rem 0.75rem',
    background: '#f8f9fa',
    borderRadius: '6px',
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#1a1a2e',
    borderLeft: '3px solid #e94560',
  },
}
