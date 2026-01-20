import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface RestaurantBooking {
  has_booking: boolean
  time?: string
  people?: number
  table_name?: string
  opening_hour_name?: string
}

interface HotelStay {
  booking_id: string
  room_number: string
  guest_name: string | null
  check_in: string
  check_out: string
  nights: string[]
  restaurant_bookings: Record<string, RestaurantBooking>
  is_dbb?: boolean
  is_package?: boolean
}

interface ChartData {
  date_range: {
    start_date: string
    end_date: string
    dates: string[]
  }
  bookings: HotelStay[]
  summary: {
    total_bookings: number
    total_room_nights: number
    nights_with_restaurant: number
    coverage_percentage: number
  }
}

export default function ResidentsTableChart() {
  const { token } = useAuth()
  const [startDate, setStartDate] = useState(() => new Date().toISOString().split('T')[0])
  const [selectedBooking, setSelectedBooking] = useState<HotelStay | null>(null)

  const { data, isLoading } = useQuery<ChartData>({
    queryKey: ['residents-table-chart', startDate],
    queryFn: async () => {
      const res = await fetch(`/api/residents-table-chart?start_date=${startDate}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch chart data')
      return res.json()
    },
    staleTime: 2 * 60 * 1000
  })

  const prevWeek = () => {
    const date = new Date(startDate)
    date.setDate(date.getDate() - 7)
    setStartDate(date.toISOString().split('T')[0])
  }

  const nextWeek = () => {
    const date = new Date(startDate)
    date.setDate(date.getDate() + 7)
    setStartDate(date.toISOString().split('T')[0])
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return `${days[date.getDay()]} ${date.getDate()}`
  }

  if (isLoading) {
    return (
      <div style={styles.container}>
        <h1>Residents Table Chart</h1>
        <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={styles.container}>
        <h1>Residents Table Chart</h1>
        <div style={{ padding: '2rem', textAlign: 'center' }}>No data available</div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <h1>Residents Table Chart</h1>

      {/* Date Selector */}
      <div style={styles.header}>
        <button onClick={prevWeek} style={styles.navButton}>◀ Prev Week</button>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          style={styles.dateInput}
        />
        <button onClick={nextWeek} style={styles.navButton}>Next Week ▶</button>
      </div>

      {/* Summary */}
      <div style={styles.summary}>
        <strong>{data.summary.total_bookings}</strong> Hotel Bookings
        <span style={{ margin: '0 1rem', color: '#ddd' }}>|</span>
        <strong>{data.summary.total_room_nights}</strong> Room Nights
        <span style={{ margin: '0 1rem', color: '#ddd' }}>|</span>
        <strong>{data.summary.nights_with_restaurant}</strong> with Restaurant Table
        <span style={{ margin: '0 1rem', color: '#ddd' }}>|</span>
        <strong>{data.summary.coverage_percentage}%</strong> Coverage
      </div>

      {/* Chart */}
      <div style={styles.chartContainer}>
        <div style={styles.grid}>
          {/* Header Row */}
          <div style={{ ...styles.headerCell, borderLeft: 'none' }}>Room</div>
          {data.date_range.dates.map((date) => (
            <div key={date} style={styles.headerCell}>
              {formatDate(date)}
            </div>
          ))}

          {/* Booking Rows */}
          {data.bookings.map((booking) => (
            <div key={booking.booking_id} style={styles.row}>
              {/* Room Cell */}
              <div style={styles.roomCell}>
                <div style={styles.roomNumber}>{booking.room_number}</div>
                {booking.guest_name && (
                  <div style={styles.guestName}>{booking.guest_name}</div>
                )}
                {booking.is_dbb && <span style={styles.badge}>DBB</span>}
                {booking.is_package && <span style={styles.badge}>PKG</span>}
              </div>

              {/* Day Cells */}
              {data.date_range.dates.map((date) => {
                const isStaying = booking.nights.includes(date)
                const isFirstNight = booking.check_in === date
                const isLastNight = booking.nights[booking.nights.length - 1] === date
                const restaurantBooking = booking.restaurant_bookings[date]

                return (
                  <div key={date} style={styles.dayCell}>
                    {/* Hotel Stay Bar */}
                    {isStaying && (
                      <div
                        style={{
                          ...styles.bar,
                          ...(isFirstNight && styles.barStart),
                          ...(isLastNight && styles.barEnd)
                        }}
                        onClick={() => setSelectedBooking(booking)}
                        title={`${booking.room_number} - ${booking.guest_name || 'Guest'}\n${booking.check_in} to ${booking.check_out}`}
                      />
                    )}

                    {/* Restaurant Table Icon */}
                    {isStaying && restaurantBooking?.has_booking && (
                      <div
                        style={styles.tableIcon}
                        title={`${restaurantBooking.opening_hour_name || 'Dining'} - ${restaurantBooking.time || ''}\n${restaurantBooking.people} people${restaurantBooking.table_name ? `\n${restaurantBooking.table_name}` : ''}`}
                      >
                        🪑
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Booking Detail Modal */}
      {selectedBooking && (
        <div style={styles.modalOverlay} onClick={() => setSelectedBooking(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2>Room {selectedBooking.room_number}</h2>
              <button onClick={() => setSelectedBooking(null)} style={styles.closeBtn}>×</button>
            </div>

            <div style={styles.modalContent}>
              <div style={styles.modalRow}>
                <strong>Guest:</strong> {selectedBooking.guest_name || 'Not specified'}
              </div>
              <div style={styles.modalRow}>
                <strong>Booking ID:</strong> {selectedBooking.booking_id}
              </div>
              <div style={styles.modalRow}>
                <strong>Stay:</strong> {selectedBooking.check_in} to {selectedBooking.check_out} ({selectedBooking.nights.length} nights)
              </div>
              {selectedBooking.is_dbb && (
                <div style={styles.modalRow}>
                  <span style={styles.badge}>Dinner, Bed & Breakfast</span>
                </div>
              )}
              {selectedBooking.is_package && (
                <div style={styles.modalRow}>
                  <span style={styles.badge}>Package Deal</span>
                </div>
              )}

              <h3 style={{ marginTop: '1.5rem', marginBottom: '0.75rem' }}>Restaurant Bookings</h3>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Time</th>
                    <th style={styles.th}>Service</th>
                    <th style={styles.th}>Covers</th>
                    <th style={styles.th}>Table</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedBooking.nights.map((night) => {
                    const rb = selectedBooking.restaurant_bookings[night]
                    return (
                      <tr key={night} style={rb?.has_booking ? {} : styles.noBookingRow}>
                        <td style={styles.td}>{night}</td>
                        <td style={styles.td}>{rb?.has_booking ? rb.time : '-'}</td>
                        <td style={styles.td}>{rb?.has_booking ? rb.opening_hour_name : '-'}</td>
                        <td style={styles.td}>{rb?.has_booking ? rb.people : '-'}</td>
                        <td style={styles.td}>{rb?.has_booking ? rb.table_name : '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
    background: '#f5f5f5',
    minHeight: '100vh'
  },
  header: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    marginBottom: '1rem',
    display: 'flex',
    gap: '1rem',
    alignItems: 'center',
    justifyContent: 'center'
  },
  navButton: {
    padding: '0.75rem 1.5rem',
    background: '#667eea',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: '500'
  },
  dateInput: {
    padding: '0.75rem',
    border: '1px solid #ddd',
    borderRadius: '8px',
    fontSize: '1rem'
  },
  summary: {
    background: 'white',
    padding: '1rem 1.5rem',
    borderRadius: '8px',
    marginBottom: '1rem',
    fontSize: '0.95rem',
    color: '#666',
    textAlign: 'center' as const
  },
  chartContainer: {
    background: 'white',
    borderRadius: '12px',
    overflow: 'auto',
    padding: '1rem'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '150px repeat(7, 1fr)',
    gap: '0',
    minWidth: '1000px'
  },
  headerCell: {
    padding: '0.75rem',
    borderBottom: '2px solid #333',
    borderLeft: '1px solid #eee',
    fontWeight: 'bold' as const,
    textAlign: 'center' as const,
    background: '#f8f8f8',
    fontSize: '0.9rem'
  },
  row: {
    display: 'contents'
  },
  roomCell: {
    padding: '0.75rem',
    borderRight: '1px solid #ddd',
    borderBottom: '1px solid #eee',
    fontWeight: '500' as const,
    background: '#fafafa',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.25rem'
  },
  roomNumber: {
    fontSize: '1rem',
    fontWeight: 'bold' as const,
    color: '#333'
  },
  guestName: {
    fontSize: '0.85rem',
    color: '#666'
  },
  badge: {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    background: '#e0e7ff',
    color: '#4338ca',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: '600' as const,
    marginTop: '0.25rem'
  },
  dayCell: {
    position: 'relative' as const,
    padding: '0.5rem',
    borderLeft: '1px solid #eee',
    borderBottom: '1px solid #eee',
    minHeight: '70px',
    background: 'white'
  },
  bar: {
    position: 'absolute' as const,
    top: '12px',
    left: '0',
    right: '0',
    height: '36px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'transform 0.2s, box-shadow 0.2s'
  },
  barStart: {
    borderTopLeftRadius: '8px',
    borderBottomLeftRadius: '8px'
  },
  barEnd: {
    borderTopRightRadius: '8px',
    borderBottomRightRadius: '8px'
  },
  tableIcon: {
    position: 'absolute' as const,
    bottom: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: '1.5rem',
    cursor: 'pointer',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))'
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
    maxWidth: '700px',
    maxHeight: '90vh',
    overflow: 'auto',
    padding: '24px'
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
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
  modalRow: {
    marginBottom: '0.75rem',
    lineHeight: '1.6'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    marginTop: '0.5rem'
  },
  th: {
    padding: '0.75rem',
    textAlign: 'left' as const,
    borderBottom: '2px solid #ddd',
    fontWeight: '600' as const,
    fontSize: '0.9rem'
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee'
  },
  noBookingRow: {
    background: '#f9f9f9',
    color: '#999'
  }
}
