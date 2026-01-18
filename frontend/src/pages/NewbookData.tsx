import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface Settings {
  currency_symbol: string
}

interface RevenueByAccount {
  gl_name: string
  amount: number
}

interface CalendarDay {
  date: string
  has_data: boolean
  is_forecast: boolean
  total_rooms: number | null
  occupied_rooms: number | null
  occupancy_percentage: number | null
  total_guests: number | null
  breakfast_allocation_qty: number | null
  breakfast_allocation_netvalue: number | null
  dinner_allocation_qty: number | null
  dinner_allocation_netvalue: number | null
  total_revenue: number | null
  revenue_by_account: RevenueByAccount[] | null
}

interface CalendarData {
  year: number
  month: number
  days: CalendarDay[]
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function NewbookData() {
  const { token } = useAuth()
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null)

  // Fetch display settings for currency
  const { data: settings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    enabled: !!token,
  })

  const currencySymbol = settings?.currency_symbol || '£'

  const { data: calendarData, isLoading } = useQuery<CalendarData>({
    queryKey: ['newbook-calendar', year, month],
    queryFn: async () => {
      const res = await fetch(`/api/newbook/calendar/${year}/${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch calendar data')
      return res.json()
    },
    enabled: !!token,
  })

  const goToPrevMonth = () => {
    if (month === 1) {
      setMonth(12)
      setYear(year - 1)
    } else {
      setMonth(month - 1)
    }
  }

  const goToNextMonth = () => {
    if (month === 12) {
      setMonth(1)
      setYear(year + 1)
    } else {
      setMonth(month + 1)
    }
  }

  const goToToday = () => {
    setYear(today.getFullYear())
    setMonth(today.getMonth() + 1)
  }

  // Calculate calendar grid
  const firstDayOfMonth = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()

  // Create array for calendar grid
  const calendarGrid: (CalendarDay | null)[] = []

  // Add empty cells for days before the first day of the month
  for (let i = 0; i < firstDayOfMonth; i++) {
    calendarGrid.push(null)
  }

  // Add days from the data
  if (calendarData) {
    for (const day of calendarData.days) {
      calendarGrid.push(day)
    }
  } else {
    // Placeholder days when loading
    for (let i = 1; i <= daysInMonth; i++) {
      calendarGrid.push(null)
    }
  }

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return '-'
    // Use currency symbol from settings
    const formatted = new Intl.NumberFormat('en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
    return `${currencySymbol}${formatted}`
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-AU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  }

  return (
    <div style={styles.container}>
      <div style={styles.titleRow}>
        <a href="/settings" style={styles.backLink}>&larr; Back to Settings</a>
        <h1 style={styles.title}>Newbook Data</h1>
      </div>

      {/* Calendar Header */}
      <div style={styles.calendarHeader}>
        <button onClick={goToPrevMonth} style={styles.navBtn}>&lt; Prev</button>
        <div style={styles.monthTitle}>
          <h2 style={styles.monthName}>{MONTH_NAMES[month - 1]} {year}</h2>
          <button onClick={goToToday} style={styles.todayBtn}>Today</button>
        </div>
        <button onClick={goToNextMonth} style={styles.navBtn}>Next &gt;</button>
      </div>

      {/* Legend */}
      <div style={styles.legend}>
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: '#4ade80' }}></span>
          <span>Historical (locked)</span>
        </div>
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: '#fbbf24' }}></span>
          <span>Forecast (updates on sync)</span>
        </div>
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: '#e5e7eb' }}></span>
          <span>No data</span>
        </div>
      </div>

      {isLoading ? (
        <div style={styles.loading}>Loading calendar data...</div>
      ) : (
        <>
          {/* Calendar Grid */}
          <div style={styles.calendar}>
            {/* Day headers */}
            {DAY_NAMES.map((day) => (
              <div key={day} style={styles.dayHeader}>{day}</div>
            ))}

            {/* Calendar cells */}
            {calendarGrid.map((day, index) => {
              if (day === null) {
                return <div key={`empty-${index}`} style={styles.emptyCell}></div>
              }

              const dayNum = new Date(day.date).getDate()
              const isToday = day.date === today.toISOString().split('T')[0]

              let cellStyle: React.CSSProperties = { ...styles.dayCell }
              if (day.has_data) {
                if (day.is_forecast) {
                  cellStyle = { ...cellStyle, ...styles.forecastCell }
                } else {
                  cellStyle = { ...cellStyle, ...styles.historicalCell }
                }
              }
              if (isToday) {
                cellStyle = { ...cellStyle, ...styles.todayCell }
              }

              return (
                <div
                  key={day.date}
                  style={cellStyle}
                  onClick={() => day.has_data && setSelectedDay(day)}
                >
                  <div style={styles.dayNumber}>{dayNum}</div>
                  {day.has_data && (
                    <div style={styles.dayData}>
                      {day.total_revenue !== null && (
                        <div style={styles.revenueTag}>
                          {currencySymbol}{Math.round(day.total_revenue)} net
                        </div>
                      )}
                      {day.occupied_rooms !== null && (
                        <div style={styles.occupancyTag}>
                          {day.occupied_rooms}/{day.total_rooms} ({day.total_guests ?? '-'}) {Math.round(day.occupancy_percentage ?? 0)}%
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Day Detail Modal */}
      {selectedDay && (
        <div style={styles.modalOverlay} onClick={() => setSelectedDay(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={styles.modalTitle}>{formatDate(selectedDay.date)}</h3>
              <span style={{
                ...styles.badge,
                background: selectedDay.is_forecast ? '#fbbf24' : '#4ade80',
                color: selectedDay.is_forecast ? '#78350f' : '#14532d',
              }}>
                {selectedDay.is_forecast ? 'Forecast' : 'Historical'}
              </span>
            </div>

            <div style={styles.modalContent}>
              {/* Occupancy Section */}
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>Occupancy</h4>
                <div style={styles.dataGrid}>
                  <div style={styles.dataItem}>
                    <span style={styles.dataLabel}>Occupancy Rate</span>
                    <span style={styles.dataValue}>
                      {selectedDay.occupancy_percentage !== null
                        ? `${selectedDay.occupancy_percentage}%`
                        : '-'}
                    </span>
                  </div>
                  <div style={styles.dataItem}>
                    <span style={styles.dataLabel}>Rooms</span>
                    <span style={styles.dataValue}>
                      {selectedDay.occupied_rooms !== null && selectedDay.total_rooms !== null
                        ? `${selectedDay.occupied_rooms} / ${selectedDay.total_rooms}`
                        : '-'}
                    </span>
                  </div>
                  <div style={styles.dataItem}>
                    <span style={styles.dataLabel}>Total Guests</span>
                    <span style={styles.dataValue}>
                      {selectedDay.total_guests ?? '-'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Meal Allocations Section */}
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>Meal Allocations</h4>
                <div style={styles.dataGrid}>
                  <div style={styles.dataItem}>
                    <span style={styles.dataLabel}>Breakfast</span>
                    <span style={styles.dataValue}>
                      {selectedDay.breakfast_allocation_qty !== null
                        ? `${selectedDay.breakfast_allocation_qty} pax`
                        : '-'}
                    </span>
                    {/* Only show estimated value for forecast data */}
                    {selectedDay.is_forecast && selectedDay.breakfast_allocation_netvalue !== null && (
                      <span style={styles.dataSubValue}>
                        {formatCurrency(selectedDay.breakfast_allocation_netvalue)} net (est)
                      </span>
                    )}
                  </div>
                  <div style={styles.dataItem}>
                    <span style={styles.dataLabel}>Dinner</span>
                    <span style={styles.dataValue}>
                      {selectedDay.dinner_allocation_qty !== null
                        ? `${selectedDay.dinner_allocation_qty} pax`
                        : '-'}
                    </span>
                    {/* Only show estimated value for forecast data */}
                    {selectedDay.is_forecast && selectedDay.dinner_allocation_netvalue !== null && (
                      <span style={styles.dataSubValue}>
                        {formatCurrency(selectedDay.dinner_allocation_netvalue)} net (est)
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Revenue Section */}
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>Revenue (net)</h4>
                <div style={styles.revenueTotal}>
                  <span>Total</span>
                  <span style={styles.revenueTotalValue}>
                    {formatCurrency(selectedDay.total_revenue)}
                  </span>
                </div>
                {selectedDay.revenue_by_account && selectedDay.revenue_by_account.length > 0 && (
                  <div style={styles.revenueBreakdown}>
                    {selectedDay.revenue_by_account.map((item, idx) => (
                      <div key={idx} style={styles.revenueItem}>
                        <span style={styles.revenueGLName}>{item.gl_name}</span>
                        <span style={styles.revenueAmount}>
                          {formatCurrency(item.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button onClick={() => setSelectedDay(null)} style={styles.closeBtn}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '1rem',
  },
  titleRow: {
    marginBottom: '1rem',
  },
  backLink: {
    display: 'inline-block',
    color: '#6b7280',
    textDecoration: 'none',
    fontSize: '0.875rem',
    marginBottom: '0.5rem',
  },
  title: {
    fontSize: '1.75rem',
    fontWeight: 'bold',
    marginBottom: '0.5rem',
    color: '#1a1a2e',
    margin: 0,
  },
  calendarHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  monthTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  monthName: {
    fontSize: '1.5rem',
    fontWeight: '600',
    color: '#1a1a2e',
    margin: 0,
  },
  navBtn: {
    padding: '0.5rem 1rem',
    background: '#f3f4f6',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  todayBtn: {
    padding: '0.25rem 0.75rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.875rem',
  },
  legend: {
    display: 'flex',
    gap: '1.5rem',
    marginBottom: '1rem',
    padding: '0.75rem 1rem',
    background: '#f9fafb',
    borderRadius: '8px',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
    color: '#4b5563',
  },
  legendDot: {
    width: '16px',
    height: '16px',
    borderRadius: '4px',
  },
  loading: {
    textAlign: 'center',
    padding: '3rem',
    color: '#6b7280',
  },
  calendar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '4px',
    background: '#e5e7eb',
    borderRadius: '12px',
    padding: '4px',
  },
  dayHeader: {
    padding: '0.75rem',
    textAlign: 'center',
    fontWeight: '600',
    color: '#374151',
    background: '#f9fafb',
  },
  emptyCell: {
    background: '#f9fafb',
    minHeight: '100px',
  },
  dayCell: {
    background: 'white',
    minHeight: '100px',
    padding: '0.5rem',
    cursor: 'default',
    position: 'relative',
    borderRadius: '4px',
  },
  historicalCell: {
    background: '#dcfce7',
    cursor: 'pointer',
  },
  forecastCell: {
    background: '#fef3c7',
    cursor: 'pointer',
  },
  todayCell: {
    boxShadow: 'inset 0 0 0 2px #e94560',
  },
  dayNumber: {
    fontWeight: '600',
    fontSize: '0.875rem',
    color: '#374151',
  },
  dayData: {
    marginTop: '0.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  revenueTag: {
    fontSize: '0.75rem',
    color: '#047857',
    fontWeight: '500',
  },
  occupancyTag: {
    fontSize: '0.75rem',
    color: '#6366f1',
    fontWeight: '500',
  },
  // Modal styles
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    width: '90%',
    maxWidth: '500px',
    maxHeight: '80vh',
    overflow: 'auto',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid #e5e7eb',
  },
  modalTitle: {
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: '600',
    color: '#1a1a2e',
  },
  badge: {
    padding: '0.25rem 0.75rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: '600',
  },
  modalContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  section: {
    background: '#f9fafb',
    borderRadius: '8px',
    padding: '1rem',
  },
  sectionTitle: {
    margin: '0 0 0.75rem 0',
    fontSize: '0.875rem',
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  dataGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: '1rem',
  },
  dataItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  dataLabel: {
    fontSize: '0.75rem',
    color: '#6b7280',
  },
  dataValue: {
    fontSize: '1.125rem',
    fontWeight: '600',
    color: '#1a1a2e',
  },
  dataSubValue: {
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  revenueTotal: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem',
    background: 'white',
    borderRadius: '6px',
    marginBottom: '0.75rem',
  },
  revenueTotalValue: {
    fontSize: '1.25rem',
    fontWeight: '700',
    color: '#047857',
  },
  revenueBreakdown: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  revenueItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 0.75rem',
    background: 'white',
    borderRadius: '4px',
    fontSize: '0.875rem',
  },
  revenueGLName: {
    color: '#4b5563',
  },
  revenueAmount: {
    fontWeight: '500',
    color: '#1a1a2e',
  },
  closeBtn: {
    width: '100%',
    padding: '0.75rem',
    marginTop: '1.5rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: '500',
  },
}
