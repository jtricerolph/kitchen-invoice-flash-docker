import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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
  Legend
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

interface StatsData {
  summary: {
    total_bookings: number
    total_covers: number
    avg_lead_time_days: number
    resident_pct_covers: number
    resident_pct_spend: number
  }
  spend: {
    total_spend: number
    food_spend: number
    beverage_spend: number
    resident_spend: number
    non_resident_spend: number
    matched_tickets: number
    unmatched_tickets: number
  }
  daily_breakdown: Array<{
    date: string
    total_bookings: number
    total_covers: number
    total_spend: number
    food_spend: number
    beverage_spend: number
    resident_spend: number
    non_resident_spend: number
    ticket_count: number
  }>
  service_period_breakdown: Array<{
    service_period: string
    total_spend: number
    food_spend: number
    beverage_spend: number
    covers: number
    resos_covers: number
    samba_covers: number
    ticket_count: number
    avg_spend_per_cover: number
  }>
  daily_service_breakdown: Array<{
    date: string
    periods: Record<string, {
      covers: number
      resos_covers: number
      samba_covers: number
      food: number
      beverage: number
      total_spend: number
      ticket_count: number
    }>
  }>
}

interface Booking {
  id: number
  booking_date: string
  booking_time: string
  people: number
  status: string
  is_hotel_guest: boolean
  allergies: string | null
  notes: string | null
  opening_hour_name: string
  is_flagged: boolean
  flag_reasons: string | null
}

export default function BookingsStats() {
  const { token } = useAuth()
  const [fromDate, setFromDate] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 30)
    return date.toISOString().split('T')[0]
  })
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0])
  const [showPreviousPeriod, setShowPreviousPeriod] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const { data: stats, isLoading } = useQuery<StatsData>({
    queryKey: ['resos-stats', fromDate, toDate],
    queryFn: async () => {
      const res = await fetch(`/api/resos/stats?from_date=${fromDate}&to_date=${toDate}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json()
    },
    staleTime: 2 * 60 * 1000
  })

  // Calculate previous period dates (matched by day of week)
  const getPreviousPeriodDates = () => {
    const from = new Date(fromDate)
    const to = new Date(toDate)
    const daysDiff = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))

    const prevTo = new Date(from)
    prevTo.setDate(prevTo.getDate() - 1)

    const prevFrom = new Date(prevTo)
    prevFrom.setDate(prevFrom.getDate() - daysDiff)

    return {
      from: prevFrom.toISOString().split('T')[0],
      to: prevTo.toISOString().split('T')[0]
    }
  }

  const { data: previousStats } = useQuery<StatsData>({
    queryKey: ['resos-stats-previous', fromDate, toDate],
    queryFn: async () => {
      const prevDates = getPreviousPeriodDates()
      const res = await fetch(`/api/resos/stats?from_date=${prevDates.from}&to_date=${prevDates.to}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch previous stats')
      return res.json()
    },
    enabled: showPreviousPeriod,
    staleTime: 2 * 60 * 1000
  })

  const { data: selectedDayBookings } = useQuery<Booking[]>({
    queryKey: ['resos-bookings', selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/resos/bookings/${selectedDate}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch bookings')
      return res.json()
    },
    enabled: !!selectedDate
  })

  const setLast30Days = () => {
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - 30)
    setFromDate(from.toISOString().split('T')[0])
    setToDate(to.toISOString().split('T')[0])
  }

  const setLast90Days = () => {
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - 90)
    setFromDate(from.toISOString().split('T')[0])
    setToDate(to.toISOString().split('T')[0])
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value)
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  }

  const renderChart = () => {
    if (!stats || !stats.daily_breakdown || stats.daily_breakdown.length === 0) {
      return <div style={{ padding: '2rem', textAlign: 'center' }}>No data available</div>
    }

    const labels = stats.daily_breakdown.map(d => formatDate(d.date))

    const datasets = [
      {
        label: 'Bookings',
        data: stats.daily_breakdown.map(d => d.total_bookings),
        borderColor: 'rgb(102, 126, 234)',
        backgroundColor: 'rgba(102, 126, 234, 0.1)',
        yAxisID: 'y',
      },
      {
        label: 'Covers',
        data: stats.daily_breakdown.map(d => d.total_covers),
        borderColor: 'rgb(118, 75, 162)',
        backgroundColor: 'rgba(118, 75, 162, 0.1)',
        yAxisID: 'y',
      },
      {
        label: 'Spend (£)',
        data: stats.daily_breakdown.map(d => d.total_spend),
        borderColor: 'rgb(237, 100, 166)',
        backgroundColor: 'rgba(237, 100, 166, 0.1)',
        yAxisID: 'y1',
      }
    ]

    // Add previous period data if enabled
    if (showPreviousPeriod && previousStats?.daily_breakdown) {
      datasets.push(
        {
          label: 'Prev Bookings',
          data: previousStats.daily_breakdown.map(d => d.total_bookings),
          borderColor: 'rgba(102, 126, 234, 0.4)',
          backgroundColor: 'transparent',
          borderDash: [5, 5] as any,
          yAxisID: 'y',
        } as any,
        {
          label: 'Prev Covers',
          data: previousStats.daily_breakdown.map(d => d.total_covers),
          borderColor: 'rgba(118, 75, 162, 0.4)',
          backgroundColor: 'transparent',
          borderDash: [5, 5] as any,
          yAxisID: 'y',
        } as any,
        {
          label: 'Prev Spend (£)',
          data: previousStats.daily_breakdown.map(d => d.total_spend),
          borderColor: 'rgba(237, 100, 166, 0.4)',
          backgroundColor: 'transparent',
          borderDash: [5, 5] as any,
          yAxisID: 'y1',
        } as any
      )
    }

    return (
      <Line
        data={{ labels, datasets }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            legend: {
              position: 'top',
            },
            tooltip: {
              callbacks: {
                label: (context) => {
                  let label = context.dataset.label || ''
                  if (label) {
                    label += ': '
                  }
                  const value = context.parsed.y
                  if (value !== null) {
                    if (label.includes('Spend')) {
                      label += formatCurrency(value)
                    } else {
                      label += value
                    }
                  }
                  return label
                }
              }
            }
          },
          scales: {
            y: {
              type: 'linear',
              display: true,
              position: 'left',
              title: {
                display: true,
                text: 'Bookings / Covers'
              }
            },
            y1: {
              type: 'linear',
              display: true,
              position: 'right',
              title: {
                display: true,
                text: 'Spend (£)'
              },
              grid: {
                drawOnChartArea: false,
              },
            },
          },
          onClick: (_event, elements) => {
            if (elements.length > 0) {
              const index = elements[0].index
              const clickedDate = stats.daily_breakdown[index].date
              setSelectedDate(clickedDate)
            }
          }
        }}
      />
    )
  }

  const renderDayModal = () => {
    if (!selectedDate || !selectedDayBookings) return null

    const flaggedBookings = selectedDayBookings.filter(b => b.is_flagged)
    const dayStats = stats?.daily_breakdown.find(d => d.date === selectedDate)

    return (
      <div style={styles.modalOverlay} onClick={() => setSelectedDate(null)}>
        <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div style={styles.modalHeader}>
            <h2>Bookings for {formatDate(selectedDate)}</h2>
            <button onClick={() => setSelectedDate(null)} style={styles.closeBtn}>×</button>
          </div>

          <div style={styles.modalContent}>
            {/* Day Summary */}
            {dayStats && (
              <div style={styles.daySummary}>
                <div style={styles.summaryRow}>
                  <span><strong>{dayStats.total_bookings}</strong> Bookings</span>
                  <span><strong>{dayStats.total_covers}</strong> Covers</span>
                  <span><strong>{formatCurrency(dayStats.total_spend)}</strong> Total Spend</span>
                </div>
                <div style={styles.summaryRow}>
                  <span>Food: {formatCurrency(dayStats.food_spend)}</span>
                  <span>Beverage: {formatCurrency(dayStats.beverage_spend)}</span>
                  <span>{dayStats.ticket_count} SambaPOS Tickets Matched</span>
                </div>
              </div>
            )}

            {/* Flagged Bookings */}
            {flaggedBookings.length > 0 && (
              <div style={styles.flaggedSection}>
                <h3>Notable Bookings 🦀</h3>
                {flaggedBookings.map((booking) => (
                  <div key={booking.id} style={styles.flaggedBooking}>
                    <div><strong>{booking.opening_hour_name} - {booking.booking_time}</strong></div>
                    <div>Party of {booking.people}</div>
                    {booking.allergies && <div style={styles.allergyBadge}>Allergies: {booking.allergies}</div>}
                    {booking.notes && <div style={styles.noteText}>Notes: {booking.notes}</div>}
                    {booking.flag_reasons && (
                      <div style={styles.flagReasons}>
                        Flags: {booking.flag_reasons.split(',').join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* All Bookings */}
            <h3>All Bookings ({selectedDayBookings.length})</h3>
            <table style={styles.bookingsTable}>
              <thead>
                <tr>
                  <th style={styles.th}>Time</th>
                  <th style={styles.th}>Service</th>
                  <th style={styles.th}>Covers</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Hotel Guest</th>
                  <th style={styles.th}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {selectedDayBookings.map((booking) => (
                  <tr key={booking.id} style={booking.is_flagged ? styles.flaggedRow : {}}>
                    <td style={styles.td}>{booking.booking_time}</td>
                    <td style={styles.td}>{booking.opening_hour_name}</td>
                    <td style={styles.td}>{booking.people}</td>
                    <td style={styles.td}>{booking.status}</td>
                    <td style={styles.td}>{booking.is_hotel_guest ? 'Yes' : 'No'}</td>
                    <td style={styles.td}>{booking.notes || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={styles.container}>
        <h1>Bookings Stats Report</h1>
        <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div style={styles.container}>
        <h1>Bookings Stats Report</h1>
        <div style={{ padding: '2rem', textAlign: 'center' }}>No data available</div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <h1>Bookings Stats Report</h1>

      {/* Date Range Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarRow}>
          <div>
            <label>From: </label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={styles.dateInput}
            />
          </div>
          <div>
            <label>To: </label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={styles.dateInput}
            />
          </div>
          <button onClick={setLast30Days} style={styles.button}>Last 30 Days</button>
          <button onClick={setLast90Days} style={styles.button}>Last 90 Days</button>
        </div>
        <div style={styles.toolbarRow}>
          <label style={styles.checkbox}>
            <input
              type="checkbox"
              checked={showPreviousPeriod}
              onChange={(e) => setShowPreviousPeriod(e.target.checked)}
            />
            Show Previous Period Comparison
          </label>
        </div>
      </div>

      {/* Summary Cards */}
      <div style={styles.summaryGrid}>
        <div style={styles.summaryCard}>
          <div style={styles.summaryLabel}>Total Bookings</div>
          <div style={styles.summaryValue}>{stats.summary.total_bookings}</div>
        </div>
        <div style={styles.summaryCard}>
          <div style={styles.summaryLabel}>Total Covers</div>
          <div style={styles.summaryValue}>{stats.summary.total_covers}</div>
        </div>
        <div style={styles.summaryCard}>
          <div style={styles.summaryLabel}>Avg Lead Time</div>
          <div style={styles.summaryValue}>{stats.summary.avg_lead_time_days} days</div>
        </div>
        <div style={styles.summaryCard}>
          <div style={styles.summaryLabel}>Resident %</div>
          <div style={styles.summaryValue}>{stats.summary.resident_pct_covers}%</div>
          <div style={styles.summarySub}>by covers</div>
        </div>
        <div style={styles.summaryCard}>
          <div style={styles.summaryLabel}>Resident Spend</div>
          <div style={styles.summaryValue}>{stats.summary.resident_pct_spend}%</div>
          <div style={styles.summarySub}>by value</div>
        </div>
      </div>

      {/* Spend Summary */}
      <div style={styles.section}>
        <h2>Spend Analysis</h2>
        <div style={styles.spendGrid}>
          <div style={styles.spendCard}>
            <div style={styles.spendLabel}>Total Spend</div>
            <div style={styles.spendValue}>{formatCurrency(stats.spend.total_spend)}</div>
          </div>
          <div style={styles.spendCard}>
            <div style={styles.spendLabel}>Food</div>
            <div style={styles.spendValue}>{formatCurrency(stats.spend.food_spend)}</div>
          </div>
          <div style={styles.spendCard}>
            <div style={styles.spendLabel}>Beverage</div>
            <div style={styles.spendValue}>{formatCurrency(stats.spend.beverage_spend)}</div>
          </div>
          <div style={styles.spendCard}>
            <div style={styles.spendLabel}>Resident Spend</div>
            <div style={styles.spendValue}>{formatCurrency(stats.spend.resident_spend)}</div>
          </div>
          <div style={styles.spendCard}>
            <div style={styles.spendLabel}>Non-Resident Spend</div>
            <div style={styles.spendValue}>{formatCurrency(stats.spend.non_resident_spend)}</div>
          </div>
        </div>
        <div style={styles.matchingInfo}>
          <span>✅ {stats.spend.matched_tickets} tickets matched to bookings</span>
          {stats.spend.unmatched_tickets > 0 && (
            <span style={{ marginLeft: '1rem', color: '#e94560' }}>
              ⚠️ {stats.spend.unmatched_tickets} tickets unmatched
            </span>
          )}
        </div>
      </div>

      {/* Trend Graph */}
      <div style={styles.section}>
        <h2>Trends</h2>
        <div style={styles.chartContainer}>
          {renderChart()}
        </div>
        <div style={styles.chartHint}>
          💡 Click any point on the graph to see detailed breakdown for that day
        </div>
      </div>

      {/* Service Period Breakdown */}
      <div style={styles.section}>
        <h2>Average Spend by Service Period</h2>
        {stats.service_period_breakdown && stats.service_period_breakdown.length > 0 ? (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Service Period</th>
                <th style={styles.th}>Total Spend</th>
                <th style={styles.th}>Food</th>
                <th style={styles.th}>Beverage</th>
                <th style={styles.th}>Covers</th>
                <th style={styles.th}>Tickets</th>
                <th style={styles.th}>Avg per Cover</th>
              </tr>
            </thead>
            <tbody>
              {stats.service_period_breakdown.map((period) => {
                const hasMismatch = period.resos_covers > 0 && period.samba_covers > 0 && period.resos_covers !== period.samba_covers

                return (
                  <tr key={period.service_period}>
                    <td style={styles.td}><strong>{period.service_period}</strong></td>
                    <td style={styles.td}>{formatCurrency(period.total_spend)}</td>
                    <td style={styles.td}>{formatCurrency(period.food_spend)}</td>
                    <td style={styles.td}>{formatCurrency(period.beverage_spend)}</td>
                    <td style={styles.td}>
                      <span style={hasMismatch ? { fontStyle: 'italic' } : {}}>
                        {period.covers}{hasMismatch ? ' *' : ''}
                      </span>
                      {hasMismatch && (
                        <div style={{ color: '#d9534f', fontSize: '0.75rem', fontStyle: 'italic' }}>
                          Resos: {period.resos_covers} / SambaPOS: {period.samba_covers}
                        </div>
                      )}
                    </td>
                    <td style={styles.td}>{period.ticket_count}</td>
                    <td style={styles.td}><strong>{formatCurrency(period.avg_spend_per_cover)}</strong></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: '1rem', color: '#666' }}>
            No spend data available. Ensure SambaPOS integration is configured with GL codes in Settings.
          </div>
        )}
      </div>

      {/* Daily Service Period Breakdown */}
      <div style={styles.section}>
        <h2>Daily Breakdown by Service Period</h2>
        {stats.daily_service_breakdown && stats.daily_service_breakdown.length > 0 ? (() => {
          // Get all unique service periods
          const allPeriods = new Set<string>()
          stats.daily_service_breakdown.forEach(day => {
            Object.keys(day.periods).forEach(period => allPeriods.add(period))
          })

          // Filter to only main service types (exclude special events, unknown, etc.)
          const mainServiceTypes = ['Breakfast', 'Lunch', 'Afternoon', 'Dinner']
          const periodList = mainServiceTypes.filter(period => allPeriods.has(period))

          return (
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    {periodList.map(period => (
                      <th key={period} style={{ ...styles.th, textAlign: 'center' as const }}>
                        {period}
                      </th>
                    ))}
                  </tr>
                  <tr style={{ background: '#f8f9fa' }}>
                    <th style={{ ...styles.th, fontSize: '0.75rem', padding: '0.5rem' }}></th>
                    {periodList.map(period => (
                      <th key={period} style={{ ...styles.th, fontSize: '0.75rem', padding: '0.5rem', textAlign: 'center' as const }}>
                        Covers | Food | Bev
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.daily_service_breakdown.map((day) => (
                    <tr key={day.date}>
                      <td style={{ ...styles.td, fontWeight: 'bold' as const }}>
                        {formatDate(day.date)}
                      </td>
                      {periodList.map(period => {
                        const data = day.periods[period]
                        if (!data) {
                          return (
                            <td key={period} style={{ ...styles.td, textAlign: 'center' as const, color: '#ccc' }}>
                              -
                            </td>
                          )
                        }
                        // Check if covers mismatch between Resos and SambaPOS
                        const hasMismatch = data.resos_covers > 0 && data.samba_covers > 0 && data.resos_covers !== data.samba_covers

                        return (
                          <td key={period} style={{ ...styles.td, textAlign: 'center' as const, fontSize: '0.85rem' }}>
                            {data.covers > 0 ? (
                              <>
                                <div style={hasMismatch ? { fontStyle: 'italic' } : {}}>
                                  {data.covers} covers{hasMismatch ? ' *' : ''}
                                </div>
                                {hasMismatch && (
                                  <div style={{ color: '#d9534f', fontSize: '0.7rem', fontStyle: 'italic' }}>
                                    Resos: {data.resos_covers} / SambaPOS: {data.samba_covers}
                                  </div>
                                )}
                                <div style={{ color: '#666', fontSize: '0.75rem' }}>
                                  {formatCurrency(data.food)} | {formatCurrency(data.beverage)}
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ color: '#999', fontSize: '0.75rem' }}>
                                  {data.ticket_count} ticket{data.ticket_count !== 1 ? 's' : ''} (unmatched)
                                </div>
                                <div style={{ color: '#666', fontSize: '0.75rem' }}>
                                  {formatCurrency(data.food)} | {formatCurrency(data.beverage)}
                                </div>
                              </>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })() : (
          <div style={{ padding: '1rem', color: '#666' }}>
            No daily breakdown data available.
          </div>
        )}
      </div>

      {/* Day Detail Modal */}
      {renderDayModal()}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    background: '#f5f5f5',
    minHeight: '100vh'
  },
  toolbar: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    marginBottom: '1rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
  },
  toolbarRow: {
    display: 'flex',
    gap: '1rem',
    marginBottom: '0.5rem',
    alignItems: 'center'
  },
  dateInput: {
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '1rem'
  },
  button: {
    padding: '0.5rem 1rem',
    background: '#667eea',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem'
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.95rem',
    cursor: 'pointer'
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '1rem',
    marginBottom: '1.5rem'
  },
  summaryCard: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    textAlign: 'center' as const
  },
  summaryLabel: {
    fontSize: '0.85rem',
    color: '#666',
    marginBottom: '0.5rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px'
  },
  summaryValue: {
    fontSize: '2rem',
    fontWeight: 'bold' as const,
    color: '#333'
  },
  summarySub: {
    fontSize: '0.75rem',
    color: '#999',
    marginTop: '0.25rem'
  },
  section: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    marginBottom: '1.5rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
  },
  spendGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '1rem',
    marginBottom: '1rem'
  },
  spendCard: {
    background: '#f8f9fa',
    padding: '1rem',
    borderRadius: '8px',
    textAlign: 'center' as const
  },
  spendLabel: {
    fontSize: '0.85rem',
    color: '#666',
    marginBottom: '0.5rem'
  },
  spendValue: {
    fontSize: '1.5rem',
    fontWeight: 'bold' as const,
    color: '#333'
  },
  matchingInfo: {
    fontSize: '0.9rem',
    color: '#666',
    padding: '0.5rem 0'
  },
  chartContainer: {
    height: '400px',
    position: 'relative' as const,
    marginTop: '1rem'
  },
  chartHint: {
    fontSize: '0.85rem',
    color: '#666',
    textAlign: 'center' as const,
    marginTop: '1rem',
    fontStyle: 'italic' as const
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    marginTop: '1rem'
  },
  th: {
    padding: '0.75rem',
    textAlign: 'left' as const,
    borderBottom: '2px solid #ddd',
    fontWeight: '600' as const,
    fontSize: '0.9rem',
    background: '#f8f9fa'
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee'
  },
  modalOverlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '900px',
    maxHeight: '90vh',
    overflow: 'auto',
    padding: '24px'
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid #eee'
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: '2rem',
    cursor: 'pointer',
    color: '#999'
  },
  modalContent: {
    fontSize: '0.95rem'
  },
  daySummary: {
    background: '#f8f9fa',
    padding: '1rem',
    borderRadius: '8px',
    marginBottom: '1.5rem'
  },
  summaryRow: {
    display: 'flex',
    justifyContent: 'space-around',
    gap: '1rem',
    marginBottom: '0.5rem',
    fontSize: '0.9rem'
  },
  flaggedSection: {
    background: '#fffbcc',
    borderLeft: '4px solid #ffcc00',
    padding: '1rem',
    marginBottom: '1.5rem',
    borderRadius: '4px'
  },
  flaggedBooking: {
    marginBottom: '1rem',
    paddingBottom: '0.5rem',
    borderBottom: '1px solid #ddd'
  },
  allergyBadge: {
    background: '#f8d7da',
    color: '#721c24',
    padding: '0.2rem 0.5rem',
    borderRadius: '4px',
    display: 'inline-block',
    marginTop: '0.3rem',
    fontSize: '0.85rem'
  },
  noteText: {
    fontStyle: 'italic' as const,
    color: '#666',
    marginTop: '0.3rem',
    fontSize: '0.85rem'
  },
  flagReasons: {
    fontSize: '0.75rem',
    color: '#666',
    marginTop: '0.3rem'
  },
  bookingsTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    marginTop: '0.5rem'
  },
  flaggedRow: {
    background: '#fffbcc'
  }
}
