import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

interface KDSOrder {
  id: number
  uid: string | null
  name: string
  portion: string | null
  quantity: number
  price: number | null
  kitchen_course: string | null
  status: string
  kitchen_print: string | null
  is_voided?: boolean
  voided_at?: string | null  // ISO timestamp
}

interface KDSTicket {
  id: number
  sambapos_ticket_id: number
  ticket_number: string
  table_name: string | null
  covers: number | null
  received_at: string
  time_elapsed_seconds: number
  orders: KDSOrder[]
  orders_by_course: Record<string, KDSOrder[]>
  course_states: Record<string, { bumped: boolean; bumped_at: string; bumped_by: string }>
  is_bumped: boolean
}

interface KDSSettings {
  kds_enabled: boolean
  kds_graphql_url: string | null
  kds_graphql_username: string | null
  kds_graphql_client_id: string | null
  kds_poll_interval_seconds: number
  kds_timer_green_seconds: number
  kds_timer_amber_seconds: number
  kds_timer_red_seconds: number
  kds_course_order: string[]
  kds_show_completed_for_seconds: number
}

const defaultSettings: KDSSettings = {
  kds_enabled: false,
  kds_graphql_url: null,
  kds_graphql_username: null,
  kds_graphql_client_id: null,
  kds_poll_interval_seconds: 5,
  kds_timer_green_seconds: 300,
  kds_timer_amber_seconds: 600,
  kds_timer_red_seconds: 900,
  kds_course_order: ['Starters', 'Mains', 'Desserts'],
  kds_show_completed_for_seconds: 30,
}

export default function KDS() {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [localTimers, setLocalTimers] = useState<Record<number, number>>({})

  // Fetch settings
  const { data: settings = defaultSettings } = useQuery<KDSSettings>({
    queryKey: ['kds-settings'],
    queryFn: async () => {
      const res = await fetch('/api/kds/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch tickets
  const { data: tickets = [], isLoading, error, refetch } = useQuery<KDSTicket[]>({
    queryKey: ['kds-tickets'],
    queryFn: async () => {
      const res = await fetch('/api/kds/tickets', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch tickets')
      return res.json()
    },
    enabled: !!token,
    refetchInterval: settings.kds_poll_interval_seconds * 1000,
  })

  // Update local timers every second
  useEffect(() => {
    const interval = setInterval(() => {
      setLocalTimers((prev) => {
        const newTimers: Record<number, number> = {}
        tickets.forEach((ticket) => {
          const baseTime = ticket.time_elapsed_seconds
          const lastUpdate = prev[ticket.id] !== undefined ? prev[ticket.id] : baseTime
          newTimers[ticket.id] = lastUpdate + 1
        })
        return newTimers
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [tickets])

  // Reset timers when tickets change
  useEffect(() => {
    const newTimers: Record<number, number> = {}
    tickets.forEach((ticket) => {
      newTimers[ticket.id] = ticket.time_elapsed_seconds
    })
    setLocalTimers(newTimers)
  }, [tickets])

  // Bump course mutation
  const bumpCourseMutation = useMutation({
    mutationFn: async ({ ticketId, courseName }: { ticketId: number; courseName: string }) => {
      const res = await fetch('/api/kds/bump-course', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ticket_id: ticketId, course_name: courseName }),
      })
      if (!res.ok) throw new Error('Failed to bump course')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kds-tickets'] })
    },
  })

  // Bump full ticket mutation
  const bumpTicketMutation = useMutation({
    mutationFn: async (ticketId: number) => {
      const res = await fetch(`/api/kds/bump-ticket/${ticketId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to bump ticket')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kds-tickets'] })
    },
  })

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }, [])

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Get timer color based on elapsed seconds
  const getTimerColor = (seconds: number): string => {
    if (seconds >= settings.kds_timer_red_seconds) return '#e94560'
    if (seconds >= settings.kds_timer_amber_seconds) return '#f39c12'
    return '#27ae60'
  }

  // Format time as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Get courses in order for a ticket
  const getOrderedCourses = (ticket: KDSTicket): string[] => {
    const ticketCourses = Object.keys(ticket.orders_by_course)
    return settings.kds_course_order.filter((c) => ticketCourses.includes(c))
      .concat(ticketCourses.filter((c) => !settings.kds_course_order.includes(c)))
  }

  // Get void display style based on time elapsed since void
  // First 5 mins: highlighted red, after 5 mins: just strikethrough, after 10 mins: hidden
  const getVoidStyle = (order: KDSOrder): React.CSSProperties | null => {
    if (!order.is_voided) return null
    if (!order.voided_at) return styles.orderVoided // No timestamp, just strikethrough

    const voidedTime = new Date(order.voided_at).getTime()
    const now = Date.now()
    const elapsedMins = (now - voidedTime) / 1000 / 60

    if (elapsedMins > 10) return null // Hide after 10 mins (filtered out below)
    if (elapsedMins <= 5) return styles.orderVoidedHighlight // First 5 mins: red highlight
    return styles.orderVoided // 5-10 mins: just strikethrough
  }

  // Filter orders to hide old voids
  const filterOrders = (orders: KDSOrder[]): KDSOrder[] => {
    return orders.filter(order => {
      if (!order.is_voided || !order.voided_at) return true
      const elapsedMins = (Date.now() - new Date(order.voided_at).getTime()) / 1000 / 60
      return elapsedMins <= 10 // Hide voids older than 10 mins
    })
  }

  return (
    <div style={{ ...styles.container, ...(isFullscreen ? styles.fullscreenContainer : {}) }}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>Kitchen Display System</h1>
        <div style={styles.headerActions}>
          <span style={styles.ticketCount}>{tickets.length} Active Tickets</span>
          <button onClick={() => refetch()} style={styles.headerButton}>
            Refresh
          </button>
          <button onClick={() => navigate('/settings')} style={styles.headerButton}>
            Settings
          </button>
          <button onClick={toggleFullscreen} style={styles.headerButton}>
            {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          </button>
          {isFullscreen && (
            <button
              onClick={() => window.open('mailto:support@example.com?subject=KDS Support Request', '_blank')}
              style={styles.helpButton}
              title="Get Help"
            >
              ?
            </button>
          )}
        </div>
      </div>

      {/* Status bar */}
      {error && (
        <div style={styles.errorBar}>
          Connection error - showing cached data. Check SambaPOS connection settings.
        </div>
      )}

      {/* Tickets grid */}
      {isLoading && tickets.length === 0 ? (
        <div style={styles.loading}>Loading tickets...</div>
      ) : tickets.length === 0 ? (
        <div style={styles.noTickets}>
          <h2>No Active Tickets</h2>
          <p>Tickets will appear here when orders are submitted in SambaPOS</p>
        </div>
      ) : (
        <div style={styles.ticketsGrid}>
          {tickets.map((ticket) => {
            const elapsedSeconds = localTimers[ticket.id] ?? ticket.time_elapsed_seconds
            const timerColor = getTimerColor(elapsedSeconds)
            const orderedCourses = getOrderedCourses(ticket)

            return (
              <div
                key={ticket.id}
                style={{ ...styles.ticketCard, borderTopColor: timerColor }}
              >
                {/* Ticket header */}
                <div style={styles.ticketHeader}>
                  <div style={styles.ticketInfo}>
                    <span style={styles.tableNumber}>{ticket.table_name || `#${ticket.ticket_number}`}</span>
                    {ticket.covers && <span style={styles.covers}>{ticket.covers} covers</span>}
                  </div>
                  <div style={{ ...styles.timer, backgroundColor: timerColor }}>
                    {formatTime(elapsedSeconds)}
                  </div>
                </div>

                {/* Courses */}
                <div style={styles.coursesContainer}>
                  {orderedCourses.map((courseName) => {
                    const orders = ticket.orders_by_course[courseName] || []
                    const isBumped = ticket.course_states[courseName]?.bumped || false

                    return (
                      <div
                        key={courseName}
                        style={{
                          ...styles.courseSection,
                          opacity: isBumped ? 0.5 : 1,
                        }}
                      >
                        <div style={styles.courseHeader}>
                          <span style={styles.courseName}>{courseName}</span>
                          {!isBumped && (
                            <button
                              onClick={() => bumpCourseMutation.mutate({ ticketId: ticket.id, courseName })}
                              style={styles.bumpButton}
                              disabled={bumpCourseMutation.isPending}
                            >
                              BUMP
                            </button>
                          )}
                          {isBumped && <span style={styles.bumpedLabel}>SENT</span>}
                        </div>
                        <div style={styles.ordersList}>
                          {filterOrders(orders).map((order) => {
                            const voidStyle = getVoidStyle(order)
                            return (
                              <div
                                key={order.id}
                                style={{
                                  ...styles.orderItem,
                                  ...(voidStyle || {})
                                }}
                              >
                                <span style={styles.orderQty}>{order.quantity}x</span>
                                <span style={styles.orderName}>{order.name}</span>
                                {order.portion && order.portion !== 'Normal' && (
                                  <span style={styles.orderPortion}>({order.portion})</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Bump all button */}
                <button
                  onClick={() => bumpTicketMutation.mutate(ticket.id)}
                  style={styles.bumpAllButton}
                  disabled={bumpTicketMutation.isPending || ticket.is_bumped}
                >
                  COMPLETE TICKET
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: 'calc(100vh - 120px)',
    background: '#1a1a2e',
    color: 'white',
    padding: '1rem',
  },
  fullscreenContainer: {
    minHeight: '100vh',
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
    padding: '0.5rem 1rem',
    background: '#2d2d44',
    borderRadius: '8px',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  ticketCount: {
    color: '#aaa',
    fontSize: '0.9rem',
  },
  headerButton: {
    background: '#4a4a6a',
    border: 'none',
    color: 'white',
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  helpButton: {
    background: '#e94560',
    border: 'none',
    color: 'white',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: '1.2rem',
    fontWeight: 'bold',
  },
  errorBar: {
    background: '#e94560',
    color: 'white',
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    marginBottom: '1rem',
    textAlign: 'center',
  },
  loading: {
    textAlign: 'center',
    padding: '3rem',
    fontSize: '1.2rem',
    color: '#aaa',
  },
  noTickets: {
    textAlign: 'center',
    padding: '5rem 2rem',
    color: '#aaa',
  },
  ticketsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '1rem',
    alignItems: 'start',
  },
  ticketCard: {
    background: '#2d2d44',
    borderRadius: '8px',
    overflow: 'hidden',
    borderTop: '4px solid #27ae60',
  },
  ticketHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem',
    background: '#3d3d5c',
  },
  ticketInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  tableNumber: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
  },
  covers: {
    fontSize: '0.8rem',
    color: '#aaa',
  },
  timer: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    fontFamily: 'monospace',
  },
  coursesContainer: {
    padding: '1rem',
  },
  courseSection: {
    marginBottom: '1rem',
  },
  courseHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
    paddingBottom: '0.5rem',
    borderBottom: '1px solid #4a4a6a',
  },
  courseName: {
    fontWeight: 'bold',
    textTransform: 'uppercase',
    fontSize: '0.9rem',
    color: '#aaa',
  },
  bumpButton: {
    background: '#27ae60',
    border: 'none',
    color: 'white',
    padding: '0.25rem 0.75rem',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.8rem',
  },
  bumpedLabel: {
    background: '#4a4a6a',
    padding: '0.25rem 0.75rem',
    borderRadius: '4px',
    fontSize: '0.8rem',
    color: '#888',
  },
  ordersList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  orderItem: {
    display: 'flex',
    gap: '0.5rem',
    fontSize: '1rem',
  },
  orderVoided: {
    textDecoration: 'line-through',
    opacity: 0.6,
    color: '#888',
  },
  orderVoidedHighlight: {
    textDecoration: 'line-through',
    background: 'rgba(233, 69, 96, 0.3)',
    color: '#e94560',
    padding: '2px 4px',
    borderRadius: '4px',
  },
  voidedLabel: {
    background: '#e94560',
    color: 'white',
    padding: '0 0.5rem',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: 'bold',
    marginLeft: 'auto',
  },
  orderQty: {
    fontWeight: 'bold',
    minWidth: '2rem',
  },
  orderName: {
    flex: 1,
  },
  orderPortion: {
    color: '#aaa',
    fontSize: '0.9rem',
  },
  bumpAllButton: {
    width: '100%',
    background: '#4a4a6a',
    border: 'none',
    color: 'white',
    padding: '1rem',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
  },
}
