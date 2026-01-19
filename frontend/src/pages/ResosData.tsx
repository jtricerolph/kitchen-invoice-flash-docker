import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface DailyStats {
  date: string
  total_bookings: number
  total_covers: number
  service_breakdown: Array<{
    period: string
    bookings: number
    covers: number
  }>
  flagged_booking_count: number
  is_forecast: boolean
}

interface Booking {
  id: number
  resos_booking_id: string
  booking_date: string
  booking_time: string
  people: number
  status: string
  seating_area: string | null
  hotel_booking_number: string | null
  is_hotel_guest: boolean | null
  is_dbb: boolean | null
  is_package: boolean | null
  allergies: string | null
  notes: string | null
  opening_hour_name: string | null
  is_flagged: boolean
  flag_reasons: string | null
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function ResosData() {
  const { token } = useAuth()
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  // Fetch daily stats for the month
  const { data: dailyStats, isLoading } = useQuery<DailyStats[]>({
    queryKey: ['resos-daily-stats', year, month],
    queryFn: async () => {
      const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
      const lastDay = new Date(year, month, 0)
      const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`

      const res = await fetch(`/api/resos/daily-stats?from_date=${firstDay}&to_date=${toDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch daily stats')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch bookings for selected date
  const { data: bookings } = useQuery<Booking[]>({
    queryKey: ['resos-bookings', selectedDate],
    queryFn: async () => {
      if (!selectedDate) return []
      const res = await fetch(`/api/resos/bookings/${selectedDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch bookings')
      return res.json()
    },
    enabled: !!token && !!selectedDate,
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

  // Build stats map
  const statsMap = new Map<string, DailyStats>()
  dailyStats?.forEach(stat => {
    statsMap.set(stat.date, stat)
  })

  // Calculate calendar grid
  const firstDayOfMonth = new Date(year, month - 1, 1)
  const lastDayOfMonth = new Date(year, month, 0)
  const startingDayOfWeek = firstDayOfMonth.getDay()
  const daysInMonth = lastDayOfMonth.getDate()

  const calendarDays: (Date | null)[] = []

  // Add empty cells for days before the month starts
  for (let i = 0; i < startingDayOfWeek; i++) {
    calendarDays.push(null)
  }

  // Add all days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(new Date(year, month - 1, day))
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Resos Booking Data</h1>
      <p style={styles.subtitle}>View synced booking data, covers, and flagged reservations from Resos</p>

      {/* Month Navigation */}
      <div style={styles.navBar}>
        <button onClick={goToPrevMonth} style={styles.navButton}>← Previous</button>
        <div style={styles.monthYearDisplay}>
          {MONTH_NAMES[month - 1]} {year}
        </div>
        <button onClick={goToToday} style={styles.todayButton}>Today</button>
        <button onClick={goToNextMonth} style={styles.navButton}>Next →</button>
      </div>

      {isLoading ? (
        <div style={styles.loading}>Loading calendar data...</div>
      ) : (
        <div style={styles.calendar}>
          {/* Day Headers */}
          <div style={styles.calendarHeader}>
            {DAY_NAMES.map(day => (
              <div key={day} style={styles.dayHeader}>{day}</div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div style={styles.calendarGrid}>
            {calendarDays.map((day, idx) => {
              if (!day) {
                return <div key={`empty-${idx}`} style={styles.emptyCell} />
              }

              const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
              const stat = statsMap.get(dateStr)
              const isToday = dateStr === today.toISOString().split('T')[0]
              const hasFlaggedBookings = (stat?.flagged_booking_count || 0) > 0

              return (
                <div
                  key={dateStr}
                  style={{
                    ...styles.dayCell,
                    ...(stat ? styles.dayCellWithData : {}),
                    ...(isToday ? styles.dayCellToday : {}),
                    ...(hasFlaggedBookings ? styles.dayCellFlagged : {}),
                    ...(stat?.is_forecast ? styles.dayCellForecast : {})
                  }}
                  onClick={() => stat && setSelectedDate(dateStr)}
                >
                  <div style={styles.dayNumber}>
                    {day.getDate()}
                    {hasFlaggedBookings && <span style={styles.flagIcon}> 🦀</span>}
                  </div>
                  {stat && (
                    <div style={styles.dayStats}>
                      <div style={styles.statLine}>
                        <strong>{stat.total_bookings}</strong> bookings
                      </div>
                      <div style={styles.statLine}>
                        <strong>{stat.total_covers}</strong> covers
                      </div>
                      {stat.service_breakdown.length > 0 && (
                        <div style={styles.serviceBreakdown}>
                          {stat.service_breakdown.map(service => (
                            <div key={service.period} style={styles.serviceLine}>
                              {service.period}: {service.covers}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Day Detail Modal */}
      {selectedDate && bookings && (
        <div style={styles.modalOverlay} onClick={() => setSelectedDate(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2>Bookings for {selectedDate}</h2>
              <button onClick={() => setSelectedDate(null)} style={styles.closeBtn}>×</button>
            </div>

            <div style={styles.modalContent}>
              {bookings.filter(b => b.is_flagged).length > 0 && (
                <div style={styles.flaggedSection}>
                  <h3 style={styles.flaggedTitle}>🦀 Notable Bookings</h3>
                  {bookings.filter(b => b.is_flagged).map(booking => (
                    <div key={booking.id} style={styles.flaggedBooking}>
                      <div style={styles.bookingHeader}>
                        <strong>{booking.opening_hour_name || 'Unknown'} - {booking.booking_time}</strong>
                        <span style={styles.partySize}>Party of {booking.people}</span>
                      </div>
                      {booking.allergies && (
                        <div style={styles.allergyBadge}>🦀 Allergies: {booking.allergies}</div>
                      )}
                      {booking.notes && (
                        <div style={styles.noteText}>📝 Notes: {booking.notes}</div>
                      )}
                      {booking.flag_reasons && (
                        <div style={styles.flagReasons}>
                          Flags: {booking.flag_reasons.split(',').join(', ')}
                        </div>
                      )}
                      {booking.hotel_booking_number && (
                        <div style={styles.hotelInfo}>
                          🏨 Hotel Booking: {booking.hotel_booking_number}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <h3>All Bookings ({bookings.length})</h3>
              <div style={styles.tableContainer}>
                <table style={styles.bookingsTable}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Time</th>
                      <th style={styles.th}>Service</th>
                      <th style={styles.th}>Covers</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>Area</th>
                      <th style={styles.th}>Hotel Guest</th>
                      <th style={styles.th}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookings.map(booking => (
                      <tr
                        key={booking.id}
                        style={booking.is_flagged ? styles.flaggedRow : {}}
                      >
                        <td style={styles.td}>{booking.booking_time}</td>
                        <td style={styles.td}>{booking.opening_hour_name || '-'}</td>
                        <td style={styles.td}>{booking.people}</td>
                        <td style={styles.td}>{booking.status}</td>
                        <td style={styles.td}>{booking.seating_area || '-'}</td>
                        <td style={styles.td}>{booking.is_hotel_guest ? '✓' : '-'}</td>
                        <td style={styles.td}>{booking.notes || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    maxWidth: '1400px',
    margin: '0 auto',
  },
  title: {
    fontSize: '2rem',
    fontWeight: 'bold',
    marginBottom: '0.5rem',
  },
  subtitle: {
    color: '#666',
    marginBottom: '2rem',
  },
  navBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '2rem',
    padding: '1rem',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  navButton: {
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  todayButton: {
    padding: '0.5rem 1rem',
    background: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  monthYearDisplay: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  loading: {
    padding: '2rem',
    textAlign: 'center',
    background: 'white',
    borderRadius: '8px',
  },
  calendar: {
    background: 'white',
    borderRadius: '8px',
    padding: '1rem',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  calendarHeader: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  dayHeader: {
    padding: '0.5rem',
    textAlign: 'center',
    fontWeight: 'bold',
    color: '#666',
  },
  calendarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0.5rem',
  },
  emptyCell: {
    minHeight: '100px',
  },
  dayCell: {
    minHeight: '100px',
    padding: '0.5rem',
    border: '1px solid #e0e0e0',
    borderRadius: '4px',
    cursor: 'default',
    background: '#fafafa',
  },
  dayCellWithData: {
    background: 'white',
    cursor: 'pointer',
    transition: 'transform 0.2s, box-shadow 0.2s',
  },
  dayCellToday: {
    borderColor: '#0066cc',
    borderWidth: '2px',
  },
  dayCellFlagged: {
    borderLeftColor: '#e94560',
    borderLeftWidth: '4px',
  },
  dayCellForecast: {
    background: '#f0f8ff',
  },
  dayNumber: {
    fontSize: '1.1rem',
    fontWeight: 'bold',
    marginBottom: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
  },
  flagIcon: {
    fontSize: '1rem',
  },
  dayStats: {
    fontSize: '0.85rem',
    color: '#333',
  },
  statLine: {
    marginBottom: '0.25rem',
  },
  serviceBreakdown: {
    marginTop: '0.5rem',
    fontSize: '0.75rem',
    color: '#666',
  },
  serviceLine: {
    marginBottom: '0.2rem',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '1000px',
    maxHeight: '90vh',
    overflow: 'auto',
    padding: '2rem',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    paddingBottom: '1rem',
    borderBottom: '2px solid #e0e0e0',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: '2rem',
    cursor: 'pointer',
    color: '#666',
    lineHeight: 1,
  },
  modalContent: {
    marginTop: '1rem',
  },
  flaggedSection: {
    background: '#fffbcc',
    borderLeft: '4px solid #e94560',
    padding: '1rem',
    marginBottom: '2rem',
    borderRadius: '4px',
  },
  flaggedTitle: {
    marginTop: 0,
    marginBottom: '1rem',
    color: '#c82333',
  },
  flaggedBooking: {
    marginBottom: '1rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid #f0d000',
  },
  bookingHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  partySize: {
    background: '#fff',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    fontWeight: 'bold',
  },
  allergyBadge: {
    background: '#f8d7da',
    color: '#721c24',
    padding: '0.5rem',
    borderRadius: '4px',
    marginTop: '0.5rem',
    fontSize: '0.9rem',
  },
  noteText: {
    fontStyle: 'italic',
    color: '#666',
    marginTop: '0.5rem',
    fontSize: '0.9rem',
  },
  flagReasons: {
    fontSize: '0.85rem',
    color: '#666',
    marginTop: '0.5rem',
  },
  hotelInfo: {
    fontSize: '0.9rem',
    color: '#666',
    marginTop: '0.5rem',
  },
  tableContainer: {
    overflowX: 'auto',
    marginTop: '1rem',
  },
  bookingsTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    padding: '0.75rem',
    textAlign: 'left',
    borderBottom: '2px solid #ddd',
    fontWeight: 'bold',
    background: '#f8f9fa',
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
  },
  flaggedRow: {
    background: '#fffbcc',
  },
}
