import { useState } from 'react'
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

interface BudgetInvoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  net_stock: number
  document_type: string | null
}

interface SupplierBudgetRow {
  supplier_id: number | null
  supplier_name: string
  historical_pct: number
  allocated_budget: number
  invoices_by_date: Record<string, BudgetInvoice[]>
  actual_spent: number
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

interface WeeklyBudgetResponse {
  week_start: string
  week_end: string
  dates: string[]
  otb_revenue: number
  forecast_revenue: number
  forecast_source: string
  gp_target_pct: number
  min_budget: number
  total_budget: number
  total_spent: number
  total_remaining: number
  suppliers: SupplierBudgetRow[]
  all_supplier_names: string[]
  daily_data: DailyBudgetData[]
  daily_totals: Record<string, number>
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

export default function Budget() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [weekOffset, setWeekOffset] = useState(0)

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

  const goToPreviousWeek = () => setWeekOffset((prev) => prev - 1)
  const goToNextWeek = () => setWeekOffset((prev) => prev + 1)
  const goToCurrentWeek = () => setWeekOffset(0)

  // Check if date is today or in the past
  const isPastOrToday = (dateStr: string): boolean => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const d = new Date(dateStr)
    d.setHours(0, 0, 0, 0)
    return d <= today
  }

  // Prepare chart data
  const chartData = budgetData ? {
    labels: budgetData.daily_data.map((d) => d.day_name),
    datasets: [
      {
        label: 'Cumulative Budget',
        data: budgetData.daily_data.map((d) => d.cumulative_budget),
        borderColor: '#3498db',
        backgroundColor: 'rgba(52, 152, 219, 0.1)',
        tension: 0.1,
        borderDash: [5, 5],
      },
      {
        label: 'Cumulative Spent',
        data: budgetData.daily_data.map((d) => d.cumulative_spent),
        borderColor: '#e74c3c',
        backgroundColor: 'rgba(231, 76, 60, 0.1)',
        tension: 0.1,
      },
      {
        label: 'Historical Budget',
        data: budgetData.daily_data.map((d) => d.historical_budget),
        borderColor: '#2ecc71',
        backgroundColor: 'rgba(46, 204, 113, 0.2)',
        tension: 0.1,
        fill: false,
      },
      {
        label: 'Revenue Budget',
        data: budgetData.daily_data.map((d) => d.revenue_budget),
        borderColor: '#3498db',
        backgroundColor: 'rgba(52, 152, 219, 0.2)',
        tension: 0.1,
        fill: false,
      },
    ],
  } : null

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

      {/* Summary Cards */}
      <div style={styles.summaryCards}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Forecast Revenue</div>
          <div style={styles.cardValue}>£{budgetData.forecast_revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div style={styles.cardSubtext}>
            OTB: £{budgetData.otb_revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
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
                <th style={{ ...styles.th, ...styles.remainingHeader }}>Remaining</th>
                <th style={{ ...styles.th, ...styles.statusHeader }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {budgetData.suppliers.map((supplier) => {
                const hasData = Object.values(supplier.invoices_by_date).some(invs => invs.length > 0) ||
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
                      const isPast = isPastOrToday(d)
                      return (
                        <td key={d} style={{ ...styles.td, ...(isPast ? {} : styles.futureCell) }}>
                          {invoices.length > 0 ? (
                            <div style={styles.invoicesCell}>
                              {invoices.map((inv) => {
                                const isCreditNote = inv.document_type === 'credit_note' || inv.net_stock < 0
                                return (
                                  <button
                                    key={inv.id}
                                    onClick={() => navigate(`/invoice/${inv.id}`)}
                                    style={{
                                      ...styles.invoiceBtn,
                                      ...(isCreditNote ? styles.creditNoteBtn : {}),
                                    }}
                                    title={inv.invoice_number || `Invoice #${inv.id}`}
                                  >
                                    {isCreditNote && '-'}£{Math.abs(inv.net_stock).toFixed(2)}{isCreditNote && ' CR'}
                                  </button>
                                )
                              })}
                            </div>
                          ) : (
                            <span style={styles.emptyCell}>-</span>
                          )}
                        </td>
                      )
                    })}
                    <td style={styles.budgetCell}>
                      £{supplier.allocated_budget.toFixed(2)}
                    </td>
                    <td style={styles.spentCell}>
                      £{supplier.actual_spent.toFixed(2)}
                    </td>
                    <td style={{
                      ...styles.remainingCell,
                      ...(supplier.remaining < 0 ? styles.overBudget : {})
                    }}>
                      {supplier.remaining < 0 ? '-' : ''}£{Math.abs(supplier.remaining).toFixed(2)}
                      {supplier.remaining < 0 && <span style={styles.overLabel}> OVER</span>}
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
              <tr style={styles.footerRow}>
                <td style={styles.footerLabel}>Daily Total</td>
                {budgetData.dates.map((d) => {
                  const total = budgetData.daily_totals[d] ?? 0
                  const isPast = isPastOrToday(d)
                  return (
                    <td key={d} style={{ ...styles.footerTd, ...(isPast ? {} : styles.futureCell) }}>
                      {isPast ? `£${total.toFixed(2)}` : '-'}
                    </td>
                  )
                })}
                <td style={styles.footerTd}>£{budgetData.total_budget.toFixed(2)}</td>
                <td style={styles.footerTd}>£{budgetData.total_spent.toFixed(2)}</td>
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
                <td colSpan={4}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Budget Chart */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Budget vs Actual</h3>
        <div style={styles.chartContainer}>
          {chartData && <Line data={chartData} options={chartOptions} />}
        </div>
      </div>
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
    background: '#e3f2fd',
    border: '1px solid #90caf9',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    whiteSpace: 'nowrap',
  },
  creditNoteBtn: {
    background: '#d4edda',
    borderColor: '#28a745',
    color: '#155724',
  },
  emptyCell: {
    color: '#ccc',
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
}
