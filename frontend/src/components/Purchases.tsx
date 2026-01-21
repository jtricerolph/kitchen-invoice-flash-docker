import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
)

interface MonthlyPurchaseInvoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  net_total: number | null
  net_stock: number | null
  gross_stock: number | null
  supplier_match_type: string | null
}

interface MonthlySupplierRow {
  supplier_id: number | null
  supplier_name: string
  is_unmatched: boolean
  invoices_by_date: Record<string, MonthlyPurchaseInvoice[]>
  total_net_stock: number
  percentage: number
}

interface WeekData {
  week_start: string
  week_end: string
  dates: string[]
  suppliers: MonthlySupplierRow[]
  daily_totals: Record<string, number>
  week_total: number
}

interface DateRangePurchasesResponse {
  from_date: string
  to_date: string
  period_label: string
  weeks: WeekData[]
  all_suppliers: string[]
  daily_totals: Record<string, number>
  period_total: number
}

interface DailyDataPoint {
  date: string
  net_sales: number
  net_purchases: number
}

interface DailyGPChartResponse {
  from_date: string
  to_date: string
  data: DailyDataPoint[]
}

interface WeeklyAggregate {
  weekLabel: string
  weekStart: string
  weekEnd: string
  totalPurchases: number
  totalSales: number
}

// Helper to format date as YYYY-MM-DD for input fields and API
const formatDateForApi = (d: Date): string => {
  return d.toISOString().split('T')[0]
}

// Session storage keys for persisting dates while tab is open
const STORAGE_KEY_FROM = 'purchases-report-from-date'
const STORAGE_KEY_TO = 'purchases-report-to-date'

// Get initial dates - from sessionStorage if available, otherwise default to last 4 weeks
const getInitialDates = () => {
  const storedFrom = sessionStorage.getItem(STORAGE_KEY_FROM)
  const storedTo = sessionStorage.getItem(STORAGE_KEY_TO)

  if (storedFrom && storedTo) {
    return { from: storedFrom, to: storedTo }
  }

  // Default: End of this week (Sunday) backward 28 days (4 full weeks)
  const today = new Date()
  const daysUntilSunday = (7 - today.getDay()) % 7
  const endOfWeek = new Date(today)
  endOfWeek.setDate(today.getDate() + daysUntilSunday)
  const twentyEightDaysAgo = new Date(endOfWeek)
  twentyEightDaysAgo.setDate(endOfWeek.getDate() - 27)

  return { from: formatDateForApi(twentyEightDaysAgo), to: formatDateForApi(endOfWeek) }
}

// Get the start and end of a given month
const getMonthBounds = (year: number, month: number): { start: string; end: string } => {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0) // Last day of month
  return { start: formatDateForApi(start), end: formatDateForApi(end) }
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

  return options.reverse() // Most recent first
}

export default function Purchases() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const printRef = useRef<HTMLDivElement>(null)

  // Get initial dates (from session or defaults)
  const initialDates = getInitialDates()

  // Input state (for typing without triggering queries)
  const [fromDate, setFromDate] = useState(initialDates.from)
  const [toDate, setToDate] = useState(initialDates.to)
  const [selectedMonth, setSelectedMonth] = useState<string>('') // Empty means custom range
  const [selectionMode, setSelectionMode] = useState<'last28' | 'month' | 'custom'>('custom')

  // Submitted state (actually used for queries - only changes on Generate click or preset buttons)
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
  const handleFromDateChange = (value: string) => {
    setFromDate(value)
    setSelectedMonth('')
    setSelectionMode('custom')
  }

  const handleToDateChange = (value: string) => {
    setToDate(value)
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

  // Quick preset buttons - these immediately submit the dates
  const setLast4Weeks = () => {
    const now = new Date()
    const daysUntilSun = (7 - now.getDay()) % 7
    const end = new Date(now)
    end.setDate(now.getDate() + daysUntilSun) // End of this week (Sunday)
    const start = new Date(end)
    start.setDate(end.getDate() - 27) // 28 days total
    const startStr = formatDateForApi(start)
    const endStr = formatDateForApi(end)
    setFromDate(startStr)
    setToDate(endStr)
    setSubmittedFromDate(startStr)
    setSubmittedToDate(endStr)
    setSelectedMonth('')
    setSelectionMode('last28')
  }

  const setThisMonth = () => {
    const now = new Date()
    setSelectedMonth(`${now.getFullYear()}-${now.getMonth()}`)
    setSelectionMode('month')
  }

  const setLastMonth = () => {
    const now = new Date()
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    setSelectedMonth(`${lastMonth.getFullYear()}-${lastMonth.getMonth()}`)
    setSelectionMode('month')
  }

  // Get the period prefix based on selection mode
  const getPeriodPrefix = (): string => {
    if (selectionMode === 'last28') {
      return 'Last 4 Weeks: '
    } else if (selectionMode === 'month' && selectedMonth) {
      const [year, month] = selectedMonth.split('-').map(Number)
      const monthName = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      return `Month of ${monthName}: `
    } else {
      return 'Custom Dates: '
    }
  }

  const [showPrintView, setShowPrintView] = useState(false)

  const { data, isLoading, error } = useQuery<DateRangePurchasesResponse>({
    queryKey: ['purchases-range', submittedFromDate, submittedToDate],
    queryFn: async () => {
      const res = await fetch(`/api/reports/purchases/range?from_date=${submittedFromDate}&to_date=${submittedToDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch purchases')
      return res.json()
    },
  })

  // Calculate date range for last 24 weeks (for weekly comparison chart)
  const weeklyChartDateRange = useMemo(() => {
    const now = new Date()
    // Find the most recent Sunday
    const daysUntilSun = (7 - now.getDay()) % 7
    const endDate = new Date(now)
    endDate.setDate(now.getDate() + daysUntilSun)
    // Go back 24 weeks (168 days) from the end date
    const startDate = new Date(endDate)
    startDate.setDate(endDate.getDate() - (24 * 7 - 1))
    return {
      from: formatDateForApi(startDate),
      to: formatDateForApi(endDate)
    }
  }, [])

  // Fetch daily GP data for the last 24 weeks
  const { data: weeklyChartData, isLoading: weeklyChartLoading, error: weeklyChartError } = useQuery<DailyGPChartResponse>({
    queryKey: ['weekly-chart-data', weeklyChartDateRange.from, weeklyChartDateRange.to],
    queryFn: async () => {
      const res = await fetch(`/api/reports/gp/daily?from_date=${weeklyChartDateRange.from}&to_date=${weeklyChartDateRange.to}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch weekly chart data')
      return res.json()
    },
  })

  // Aggregate daily data into weekly totals
  const weeklyAggregates = useMemo<WeeklyAggregate[]>(() => {
    if (!weeklyChartData?.data) return []

    console.log('=== WEEKLY CHART DEBUG ===')
    console.log('Date range:', weeklyChartDateRange)
    console.log('Total data points:', weeklyChartData.data.length)
    console.log('Sample data points (first 5):', weeklyChartData.data.slice(0, 5))
    console.log('Sample data points (last 5):', weeklyChartData.data.slice(-5))

    const weeks: WeeklyAggregate[] = []
    const startDate = new Date(weeklyChartDateRange.from)

    // Process each week
    for (let weekIdx = 0; weekIdx < 24; weekIdx++) {
      const weekStart = new Date(startDate)
      weekStart.setDate(startDate.getDate() + (weekIdx * 7))
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekStart.getDate() + 6)

      const weekStartStr = formatDateForApi(weekStart)
      const weekEndStr = formatDateForApi(weekEnd)

      // Sum up daily values for this week
      let totalPurchases = 0
      let totalSales = 0
      let matchedDays = 0

      for (const point of weeklyChartData.data) {
        if (point.date >= weekStartStr && point.date <= weekEndStr) {
          totalPurchases += Number(point.net_purchases) || 0
          totalSales += Number(point.net_sales) || 0
          matchedDays++
          if (weekIdx === 0 || weekIdx === 23) {
            console.log(`Week ${weekIdx} matched day:`, point.date, 'purchases:', point.net_purchases, 'sales:', point.net_sales)
          }
        }
      }

      // Format week label
      const weekStartDate = new Date(weekStartStr)
      const weekEndDate = new Date(weekEndStr)
      const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
      const weekLabel = `${weekStartDate.toLocaleDateString('en-GB', opts)} - ${weekEndDate.toLocaleDateString('en-GB', opts)}`

      if (weekIdx === 0 || weekIdx === 23) {
        console.log(`Week ${weekIdx} (${weekLabel}):`, {
          weekStart: weekStartStr,
          weekEnd: weekEndStr,
          matchedDays,
          totalPurchases,
          totalSales
        })
      }

      weeks.push({
        weekLabel,
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        totalPurchases,
        totalSales
      })
    }

    console.log('Total weeks aggregated:', weeks.length)
    console.log('First week aggregate:', weeks[0])
    console.log('Last week aggregate:', weeks[23])
    console.log('=== END DEBUG ===')

    return weeks
  }, [weeklyChartData, weeklyChartDateRange])

  // Split into last 12 weeks and previous 12 weeks
  const last12Weeks = weeklyAggregates.slice(12, 24)
  const previous12Weeks = weeklyAggregates.slice(0, 12)

  // Debug split
  console.log('=== SPLIT DEBUG ===')
  console.log('Last 12 weeks (indices 12-23):', last12Weeks.map(w => ({ label: w.weekLabel, purchases: w.totalPurchases, sales: w.totalSales })))
  console.log('Previous 12 weeks (indices 0-11):', previous12Weeks.map(w => ({ label: w.weekLabel, purchases: w.totalPurchases, sales: w.totalSales })))
  console.log('=== END SPLIT DEBUG ===')

  // Prepare chart data
  const weeklyComparisonChartData = useMemo(() => {
    return {
      labels: last12Weeks.map(w => w.weekLabel),
      datasets: [
        {
          label: 'Purchases (Last 12 Weeks)',
          data: last12Weeks.map(w => w.totalPurchases),
          borderColor: '#e94560',
          backgroundColor: 'rgba(233, 69, 96, 0.1)',
          borderWidth: 2,
          tension: 0.1,
          pointRadius: 4,
          pointBackgroundColor: '#e94560',
          yAxisID: 'y',
        },
        {
          label: 'Net Food Sales (Last 12 Weeks)',
          data: last12Weeks.map(w => w.totalSales),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          tension: 0.1,
          pointRadius: 4,
          pointBackgroundColor: '#3b82f6',
          yAxisID: 'y',
        },
        {
          label: 'Purchases (Previous 12 Weeks)',
          data: previous12Weeks.map(w => w.totalPurchases),
          borderColor: 'rgba(233, 69, 96, 0.4)',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 5],
          tension: 0.1,
          pointRadius: 3,
          pointBackgroundColor: 'rgba(233, 69, 96, 0.4)',
          yAxisID: 'y',
        },
        {
          label: 'Net Food Sales (Previous 12 Weeks)',
          data: previous12Weeks.map(w => w.totalSales),
          borderColor: 'rgba(59, 130, 246, 0.4)',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 5],
          tension: 0.1,
          pointRadius: 3,
          pointBackgroundColor: 'rgba(59, 130, 246, 0.4)',
          yAxisID: 'y',
        },
        {
          label: 'GP % (Last 12 Weeks)',
          data: last12Weeks.map(w => {
            const gp = w.totalSales > 0 ? ((w.totalSales - w.totalPurchases) / w.totalSales) * 100 : 0
            return gp
          }),
          borderColor: '#10b981',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [8, 4],
          tension: 0.1,
          pointRadius: 4,
          pointBackgroundColor: '#10b981',
          yAxisID: 'y1',
        },
        {
          label: 'GP % (Previous 12 Weeks)',
          data: previous12Weeks.map(w => {
            const gp = w.totalSales > 0 ? ((w.totalSales - w.totalPurchases) / w.totalSales) * 100 : 0
            return gp
          }),
          borderColor: 'rgba(16, 185, 129, 0.4)',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [8, 4],
          tension: 0.1,
          pointRadius: 3,
          pointBackgroundColor: 'rgba(16, 185, 129, 0.4)',
          yAxisID: 'y1',
        },
      ],
    }
  }, [last12Weeks, previous12Weeks])

  const weeklyComparisonChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
        labels: {
          usePointStyle: true,
          padding: 15,
        },
      },
      title: {
        display: true,
        text: 'Weekly Purchases vs Net Food Sales (Last 12 Weeks with Previous 12 Weeks Comparison)',
        font: {
          size: 16,
          weight: 'bold' as const,
        },
        padding: {
          bottom: 20,
        },
      },
      tooltip: {
        callbacks: {
          label: function(context: any) {
            if (context.dataset.yAxisID === 'y1') {
              return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}%`
            }
            return `${context.dataset.label}: £${context.parsed.y.toFixed(2)}`
          }
        }
      }
    },
    scales: {
      y: {
        type: 'linear' as const,
        position: 'left' as const,
        beginAtZero: true,
        ticks: {
          callback: function(value: any) {
            return '£' + value.toLocaleString()
          }
        },
        title: {
          display: true,
          text: 'Amount (£)',
        },
      },
      y1: {
        type: 'linear' as const,
        position: 'right' as const,
        beginAtZero: true,
        grid: {
          drawOnChartArea: false,
        },
        ticks: {
          callback: function(value: any) {
            return value.toFixed(0) + '%'
          }
        },
        title: {
          display: true,
          text: 'GP %',
        },
      },
      x: {
        title: {
          display: true,
          text: 'Week',
        },
      },
    },
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
  }

  const formatWeekRange = (start: string, end: string) => {
    const startDate = new Date(start)
    const endDate = new Date(end)
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
    return `${startDate.toLocaleDateString('en-GB', opts)} - ${endDate.toLocaleDateString('en-GB', opts)}`
  }

  // Check if a date is in the selected range
  const isInRange = (dateStr: string) => {
    return dateStr >= fromDate && dateStr <= toDate
  }

  // Get all invoices flat for printable view
  const getAllInvoices = (): { invoice: MonthlyPurchaseInvoice; supplierName: string }[] => {
    if (!data) return []
    const all: { invoice: MonthlyPurchaseInvoice; supplierName: string }[] = []
    for (const week of data.weeks) {
      for (const supplier of week.suppliers) {
        for (const dateStr of Object.keys(supplier.invoices_by_date)) {
          for (const inv of supplier.invoices_by_date[dateStr]) {
            // Avoid duplicates (invoice might appear in multiple week iterations if on boundary)
            if (!all.find(x => x.invoice.id === inv.id)) {
              all.push({ invoice: inv, supplierName: supplier.supplier_name })
            }
          }
        }
      }
    }
    // Sort by date
    all.sort((a, b) => {
      const dateA = a.invoice.invoice_date || ''
      const dateB = b.invoice.invoice_date || ''
      return dateA.localeCompare(dateB)
    })
    return all
  }

  const handlePrint = () => {
    setShowPrintView(true)
    setTimeout(() => {
      window.print()
      setShowPrintView(false)
    }, 100)
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading purchases...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading purchases: {(error as Error).message}</div>
  }

  const { weeks = [], period_total = 0, period_label = '' } = data || {}

  // Printable view
  if (showPrintView) {
    const allInvoices = getAllInvoices()
    return (
      <>
        {/* Hide header/nav when printing */}
        <style>{`
          @media print {
            header, nav, .no-print { display: none !important; }
            body { margin: 0; padding: 0; }
          }
        `}</style>
        <div style={styles.printContainer} ref={printRef}>
          <h1 style={styles.printTitle}>Purchases Report - {getPeriodPrefix()}{period_label}</h1>
          <table style={styles.printTable}>
            <thead>
              <tr>
                <th style={styles.printThDate}>Date</th>
                <th style={styles.printTh}>Supplier</th>
                <th style={styles.printTh}>Invoice #</th>
                <th style={styles.printThRight}>Net Stock</th>
                <th style={styles.printThRight}>Gross Stock</th>
                <th style={styles.printThRight}>Net Total</th>
                <th style={styles.printThRight}>Gross Total</th>
              </tr>
            </thead>
            <tbody>
              {allInvoices.map(({ invoice, supplierName }) => {
                // Hide stock values if same as totals (no non-stock items)
                const netStockSame = Number(invoice.net_stock ?? 0).toFixed(2) === Number(invoice.net_total ?? 0).toFixed(2)
                const grossStockSame = Number(invoice.gross_stock ?? 0).toFixed(2) === Number(invoice.total ?? 0).toFixed(2)
                return (
                  <tr key={invoice.id}>
                    <td style={styles.printTdDate}>{invoice.invoice_date || '-'}</td>
                    <td style={styles.printTd}>{supplierName}</td>
                    <td style={styles.printTd}>{invoice.invoice_number || '-'}</td>
                    <td style={styles.printTdRight}>{netStockSame ? '-' : `£${Number(invoice.net_stock ?? 0).toFixed(2)}`}</td>
                    <td style={styles.printTdRight}>{grossStockSame ? '-' : `£${Number(invoice.gross_stock ?? 0).toFixed(2)}`}</td>
                    <td style={styles.printTdRight}>£{Number(invoice.net_total ?? 0).toFixed(2)}</td>
                    <td style={styles.printTdRight}>£{Number(invoice.total ?? 0).toFixed(2)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={styles.printFooter}>
                <td colSpan={3} style={styles.printTd}><strong>Period Total</strong></td>
                <td style={styles.printTdRight}><strong>£{Number(period_total).toFixed(2)}</strong></td>
                <td style={styles.printTdRight}>-</td>
                <td style={styles.printTdRight}>-</td>
                <td style={styles.printTdRight}>-</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </>
    )
  }

  return (
    <div>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>Purchases Report</h2>
        <button onClick={handlePrint} style={styles.printBtn}>Print</button>
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
          <button onClick={setLast4Weeks} style={styles.presetBtn}>Last 4 Weeks</button>
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

      {weeks.length === 0 ? (
        <div style={styles.empty}>
          <p>No purchases in this period.</p>
        </div>
      ) : (
        <>
          {/* Daily Spending by Supplier section */}
          <div style={styles.sectionContainer}>
            <h3 style={styles.sectionTitle}>Daily Spending by Supplier</h3>
            {[...weeks].reverse().map((week, reversedIdx) => {
            const weekIdx = weeks.length - 1 - reversedIdx // Original index for week number
            // Check if week has any data in the selected range
            const hasDataInRange = week.dates.some(d => {
              const dateStr = d
              if (!isInRange(dateStr)) return false
              return week.suppliers.some(s => s.invoices_by_date[dateStr]?.length > 0)
            })
            if (!hasDataInRange && week.week_total === 0) return null

            return (
              <div key={weekIdx} style={styles.weekContainer}>
                <div style={styles.weekHeader}>
                  <span style={styles.weekTitle}>Week {weekIdx + 1}</span>
                  <span style={styles.weekRange}>{formatWeekRange(week.week_start, week.week_end)}</span>
                  <span style={styles.weekTotal}>Week Total: £{Number(week.week_total).toFixed(2)}</span>
                </div>
                <div style={styles.tableContainer}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={{ ...styles.th, ...styles.supplierHeader }}>Supplier</th>
                        {week.dates.map((d) => {
                          const dateStr = d
                          const inRange = isInRange(dateStr)
                          return (
                            <th key={dateStr} style={{ ...styles.th, ...(inRange ? {} : styles.outOfMonth) }}>
                              {formatDate(dateStr)}
                            </th>
                          )
                        })}
                        <th style={{ ...styles.th, ...styles.totalHeader }}>Total</th>
                        <th style={{ ...styles.th, ...styles.percentHeader }}>%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {week.suppliers.map((supplier) => {
                        // Only show suppliers with data in this week
                        const hasWeekData = supplier.total_net_stock > 0
                        if (!hasWeekData) return null

                        return (
                          <tr key={supplier.supplier_id ?? supplier.supplier_name} style={styles.tr}>
                            <td style={{
                              ...styles.td,
                              ...styles.supplierCell,
                              ...(supplier.is_unmatched ? styles.unmatchedSupplier : {})
                            }}>
                              {supplier.supplier_name}
                              {supplier.is_unmatched && <span style={styles.unmatchedBadge}>!</span>}
                            </td>
                            {week.dates.map((d) => {
                              const dateStr = d
                              const invoices = supplier.invoices_by_date[dateStr] || []
                              const inRange = isInRange(dateStr)
                              return (
                                <td key={dateStr} style={{ ...styles.td, ...(inRange ? {} : styles.outOfMonthCell) }}>
                                  {invoices.length > 0 ? (
                                    <div style={styles.invoicesCell}>
                                      {invoices.map((inv) => (
                                        <button
                                          key={inv.id}
                                          onClick={() => navigate(`/invoice/${inv.id}`)}
                                          style={{
                                            ...styles.invoiceBtn,
                                            ...(inv.supplier_match_type === 'fuzzy' ? styles.fuzzyInvoice : {}),
                                            ...(inv.supplier_match_type === null && supplier.is_unmatched ? styles.unmatchedInvoice : {})
                                          }}
                                          title={inv.invoice_number || `Invoice #${inv.id}`}
                                        >
                                          £{Number(inv.net_stock ?? 0).toFixed(2)}
                                        </button>
                                      ))}
                                    </div>
                                  ) : (
                                    <span style={styles.emptyCell}>-</span>
                                  )}
                                </td>
                              )
                            })}
                            <td style={{ ...styles.td, ...styles.totalCell }}>
                              £{Number(supplier.total_net_stock).toFixed(2)}
                            </td>
                            <td style={{ ...styles.td, ...styles.percentCell }}>
                              {Number(supplier.percentage).toFixed(1)}%
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={styles.footerRow}>
                        <td style={{ ...styles.td, ...styles.footerLabel }}>Daily Total</td>
                        {week.dates.map((d) => {
                          const dateStr = d
                          const inRange = isInRange(dateStr)
                          return (
                            <td key={dateStr} style={{ ...styles.td, ...styles.footerCell, ...(inRange ? {} : styles.outOfMonthCell) }}>
                              £{Number(week.daily_totals[dateStr] ?? 0).toFixed(2)}
                            </td>
                          )
                        })}
                        <td style={{ ...styles.td, ...styles.grandTotal }}>
                          £{Number(week.week_total).toFixed(2)}
                        </td>
                        <td style={{ ...styles.td, ...styles.footerCell }}>100%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )
          })}
          </div>

          {/* Period Total */}
          <div style={styles.periodTotalContainer}>
            <strong>Period Total: £{Number(period_total).toFixed(2)}</strong>
          </div>
        </>
      )}

      {/* Weekly Comparison Chart - Always show at bottom */}
      <div style={styles.chartContainer}>
        {weeklyChartLoading ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>
            Loading weekly comparison chart...
          </div>
        ) : weeklyChartError ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#c00' }}>
            Error loading chart: {(weeklyChartError as Error).message}
          </div>
        ) : weeklyAggregates.length > 0 ? (
          <div style={{ height: '400px' }}>
            <Line data={weeklyComparisonChartData} options={weeklyComparisonChartOptions} />
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>
            <div>No data available for weekly comparison chart</div>
            {weeklyChartData && (
              <div style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
                Debug: Date range {weeklyChartDateRange.from} to {weeklyChartDateRange.to}<br />
                Data points received: {weeklyChartData.data?.length || 0}
              </div>
            )}
          </div>
        )}
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
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
    gap: '1rem',
  },
  title: {
    color: '#1a1a2e',
    margin: 0,
  },
  printBtn: {
    padding: '0.5rem 1rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
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
  periodTotalContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1rem 1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    textAlign: 'right',
    fontSize: '1.1rem',
    color: '#e94560',
  },
  empty: {
    background: 'white',
    padding: '3rem',
    borderRadius: '12px',
    textAlign: 'center',
    color: '#666',
  },
  sectionContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginBottom: '2rem',
  },
  chartContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginTop: '2rem',
  },
  sectionTitle: {
    margin: '0 0 1rem 0',
    color: '#1a1a2e',
  },
  weekContainer: {
    marginBottom: '2rem',
  },
  weekHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '0.5rem',
    flexWrap: 'wrap',
  },
  weekTitle: {
    fontWeight: 'bold',
    fontSize: '1rem',
    color: '#1a1a2e',
  },
  weekRange: {
    color: '#666',
    fontSize: '0.9rem',
  },
  weekTotal: {
    marginLeft: 'auto',
    fontWeight: 'bold',
    color: '#e94560',
  },
  tableContainer: {
    background: 'white',
    borderRadius: '12px',
    overflow: 'auto',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    padding: '0.75rem 0.5rem',
    background: '#1a1a2e',
    color: 'white',
    fontWeight: '600',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  supplierHeader: {
    textAlign: 'left',
    paddingLeft: '1rem',
    minWidth: '150px',
  },
  totalHeader: {
    background: '#2d2d44',
  },
  percentHeader: {
    background: '#2d2d44',
    minWidth: '60px',
  },
  outOfMonth: {
    background: '#3d3d54',
    opacity: 0.7,
  },
  outOfMonthCell: {
    background: '#f8f9fa',
    opacity: 0.6,
  },
  tr: {
    borderBottom: '1px solid #eee',
  },
  td: {
    padding: '0.5rem',
    textAlign: 'center',
    verticalAlign: 'top',
  },
  supplierCell: {
    textAlign: 'left',
    paddingLeft: '1rem',
    fontWeight: '500',
    whiteSpace: 'nowrap',
  },
  unmatchedSupplier: {
    color: '#721c24',
    background: '#f8d7da',
  },
  unmatchedBadge: {
    display: 'inline-block',
    marginLeft: '0.3rem',
    width: '14px',
    height: '14px',
    lineHeight: '14px',
    textAlign: 'center',
    background: '#dc3545',
    color: 'white',
    borderRadius: '50%',
    fontSize: '0.7rem',
    fontWeight: 'bold',
  },
  invoicesCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    alignItems: 'center',
  },
  invoiceBtn: {
    display: 'inline-block',
    padding: '0.2rem 0.5rem',
    background: '#e8f4e8',
    color: '#155724',
    borderRadius: '4px',
    textDecoration: 'none',
    fontSize: '0.85rem',
    fontWeight: '500',
    border: '1px solid #c3e6cb',
    cursor: 'pointer',
  },
  fuzzyInvoice: {
    background: '#fff3cd',
    color: '#856404',
    border: '1px solid #ffc107',
  },
  unmatchedInvoice: {
    background: '#f8d7da',
    color: '#721c24',
    border: '1px solid #f5c6cb',
  },
  emptyCell: {
    color: '#ccc',
  },
  totalCell: {
    fontWeight: 'bold',
    background: '#f8f9fa',
  },
  percentCell: {
    fontWeight: '500',
    background: '#f8f9fa',
    color: '#666',
  },
  footerRow: {
    background: '#f8f9fa',
    borderTop: '2px solid #dee2e6',
  },
  footerLabel: {
    textAlign: 'left',
    paddingLeft: '1rem',
    fontWeight: 'bold',
  },
  footerCell: {
    fontWeight: 'bold',
  },
  grandTotal: {
    fontWeight: 'bold',
    background: '#1a1a2e',
    color: 'white',
  },

  // Monthly spending calendar
  calendarContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    marginTop: '2rem',
  },
  calendarTitle: {
    margin: '0 0 1rem 0',
    color: '#1a1a2e',
  },
  calendarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '4px',
  },
  calendarDayHeader: {
    textAlign: 'center',
    fontWeight: 'bold',
    padding: '0.5rem',
    background: '#1a1a2e',
    color: 'white',
    fontSize: '0.8rem',
  },
  calendarCellEmpty: {
    background: '#f8f9fa',
    minHeight: '60px',
  },
  calendarCell: {
    background: '#f8f9fa',
    minHeight: '60px',
    padding: '0.5rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.25rem',
  },
  calendarCellWithData: {
    background: '#e8f4e8',
    border: '1px solid #c3e6cb',
  },
  calendarDay: {
    fontSize: '0.85rem',
    fontWeight: '500',
    color: '#333',
  },
  calendarAmount: {
    fontSize: '0.75rem',
    fontWeight: 'bold',
    color: '#155724',
  },
  calendarFooter: {
    textAlign: 'right',
    marginTop: '1rem',
    fontSize: '1.1rem',
    color: '#e94560',
  },

  // Print styles
  printContainer: {
    padding: '1rem',
    background: 'white',
  },
  printTitle: {
    marginBottom: '1rem',
    color: '#1a1a2e',
    fontSize: '1.2rem',
  },
  printTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.8rem',
  },
  printTh: {
    padding: '0.3rem 0.4rem',
    background: '#f8f9fa',
    border: '1px solid #dee2e6',
    textAlign: 'left',
    fontWeight: 'bold',
  },
  printThDate: {
    padding: '0.3rem 0.4rem',
    background: '#f8f9fa',
    border: '1px solid #dee2e6',
    textAlign: 'left',
    fontWeight: 'bold',
    whiteSpace: 'nowrap',
    minWidth: '80px',
  },
  printThRight: {
    padding: '0.3rem 0.4rem',
    background: '#f8f9fa',
    border: '1px solid #dee2e6',
    textAlign: 'right',
    fontWeight: 'bold',
  },
  printTd: {
    padding: '0.2rem 0.4rem',
    border: '1px solid #dee2e6',
  },
  printTdDate: {
    padding: '0.2rem 0.4rem',
    border: '1px solid #dee2e6',
    whiteSpace: 'nowrap',
  },
  printTdRight: {
    padding: '0.2rem 0.4rem',
    border: '1px solid #dee2e6',
    textAlign: 'right',
  },
  printFooter: {
    background: '#f8f9fa',
  },
}
