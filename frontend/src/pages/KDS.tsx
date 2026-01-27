import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

interface KDSOrderTag {
  tag: string
  tagName: string
  quantity?: number
}

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
  voided_at?: string | null
  tags?: KDSOrderTag[]
}

interface CourseState {
  status: 'pending' | 'away' | 'sent' | 'cleared'
  called_away_at: string | null
  sent_at: string | null
  sent_by: string | null
  cleared_at?: string | null
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
  course_states: Record<string, CourseState>
  is_bumped: boolean
}

interface CourseConfig {
  name: string
  prep_green: number
  prep_amber: number
  prep_red: number
  away_green: number
  away_amber: number
  away_red: number
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
  kds_away_timer_green_seconds: number
  kds_away_timer_amber_seconds: number
  kds_away_timer_red_seconds: number
  kds_course_order: CourseConfig[]
  kds_show_completed_for_seconds: number
}

const defaultCourseConfig: CourseConfig[] = [
  { name: 'Starters', prep_green: 300, prep_amber: 600, prep_red: 900, away_green: 600, away_amber: 900, away_red: 1200 },
  { name: 'Mains', prep_green: 300, prep_amber: 600, prep_red: 900, away_green: 600, away_amber: 900, away_red: 1200 },
  { name: 'Desserts', prep_green: 300, prep_amber: 600, prep_red: 900, away_green: 600, away_amber: 900, away_red: 1200 },
]

const defaultSettings: KDSSettings = {
  kds_enabled: false,
  kds_graphql_url: null,
  kds_graphql_username: null,
  kds_graphql_client_id: null,
  kds_poll_interval_seconds: 5,
  kds_timer_green_seconds: 300,
  kds_timer_amber_seconds: 600,
  kds_timer_red_seconds: 900,
  kds_away_timer_green_seconds: 600,
  kds_away_timer_amber_seconds: 900,
  kds_away_timer_red_seconds: 1200,
  kds_course_order: defaultCourseConfig,
  kds_show_completed_for_seconds: 30,
}

// SVG Icon components
const RefreshIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
)

const FullscreenIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <polyline points="21 3 14 10" />
    <polyline points="3 21 10 14" />
  </svg>
)

const ExitFullscreenIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

const ExitIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

// Simple plate icon (circle with inner ring)
const PlateIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="7" />
    <circle cx="8" cy="8" r="4" />
  </svg>
)

export default function KDS() {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<KDSTicket | null>(null)
  const [showPending, setShowPending] = useState(false)
  // Tick counter for live timer updates
  const [, setTick] = useState(0)

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

  // Tick every second for live timers
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Subscribe to SSE for real-time updates from SignalR listener
  useEffect(() => {
    const eventSource = new EventSource('/api/kds/events')

    eventSource.onmessage = () => {
      // Any event from the SignalR listener means a ticket changed - refetch immediately
      queryClient.invalidateQueries({ queryKey: ['kds-tickets'] })
    }

    eventSource.onerror = () => {
      // SSE will auto-reconnect; no action needed
    }

    return () => eventSource.close()
  }, [queryClient])

  // Course AWAY mutation (mark course as called away)
  const courseAwayMutation = useMutation({
    mutationFn: async ({ ticketId, courseName }: { ticketId: number; courseName: string }) => {
      const res = await fetch('/api/kds/course-away', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ticket_id: ticketId, course_name: courseName }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to call away course')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kds-tickets'] })
    },
  })

  // Course SENT mutation (mark course as food delivered)
  const courseSentMutation = useMutation({
    mutationFn: async ({ ticketId, courseName }: { ticketId: number; courseName: string }) => {
      const res = await fetch('/api/kds/course-sent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ticket_id: ticketId, course_name: courseName }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to mark course as sent')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kds-tickets'] })
    },
  })

  // Bump full ticket mutation (complete)
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

  // Compute elapsed seconds from an ISO timestamp
  const getElapsedSeconds = (isoString: string | null): number => {
    if (!isoString) return 0
    return Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  }

  // Look up per-course config, falling back to global settings
  const getCourseConfig = (courseName: string): CourseConfig => {
    const found = settings.kds_course_order.find((c) => c.name === courseName)
    if (found) return found
    return {
      name: courseName,
      prep_green: settings.kds_timer_green_seconds,
      prep_amber: settings.kds_timer_amber_seconds,
      prep_red: settings.kds_timer_red_seconds,
      away_green: settings.kds_away_timer_green_seconds,
      away_amber: settings.kds_away_timer_amber_seconds,
      away_red: settings.kds_away_timer_red_seconds,
    }
  }

  // Get prep timer color (course is "away" - waiting to be served)
  const getPrepTimerColor = (seconds: number, config: CourseConfig): string => {
    if (seconds >= config.prep_red) return '#e94560'
    if (seconds >= config.prep_amber) return '#f39c12'
    return '#27ae60'
  }

  // Get away timer color (course is "sent" - food at table, eating)
  const getAwayTimerColor = (seconds: number, config: CourseConfig): string => {
    if (seconds >= config.away_red) return '#e94560'
    if (seconds >= config.away_amber) return '#f39c12'
    return '#8e8ea0'
  }

  // Format seconds as MM:SS
  const formatTimer = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Get courses in order for a ticket
  const getOrderedCourses = (ticket: KDSTicket): string[] => {
    const ticketCourses = Object.keys(ticket.orders_by_course)
    const configNames = settings.kds_course_order.map((c) => c.name)
    return configNames.filter((c) => ticketCourses.includes(c))
      .concat(ticketCourses.filter((c) => !configNames.includes(c)))
  }

  // Check if all courses are sent or cleared
  const allCoursesSent = (ticket: KDSTicket): boolean => {
    const courses = getOrderedCourses(ticket)
    return courses.every((c) => {
      const s = ticket.course_states[c]?.status
      return s === 'sent' || s === 'cleared'
    })
  }

  // Get the "active" course timer color for the ticket header border
  const getTicketHeaderColor = (ticket: KDSTicket): string => {
    const courses = getOrderedCourses(ticket)
    // Find the first course that's "away" - use its prep timer with per-course config
    for (const c of courses) {
      const state = ticket.course_states[c]
      if (state?.status === 'away' && state.called_away_at) {
        return getPrepTimerColor(getElapsedSeconds(state.called_away_at), getCourseConfig(c))
      }
    }
    // If all sent, use first course config as fallback
    const firstConfig = courses.length > 0 ? getCourseConfig(courses[0]) : getCourseConfig('default')
    return getPrepTimerColor(getElapsedSeconds(ticket.received_at), firstConfig)
  }

  // Get table state: what's currently "on the table"
  // Empty when no course sent yet, or when course has been cleared
  // Shows plate + course letter when food is at the table
  const getTableState = (ticket: KDSTicket): { isEmpty: boolean; courseLabel: string | null } => {
    const courses = getOrderedCourses(ticket)
    // Walk backwards to find the latest "sent" course (not cleared)
    for (let i = courses.length - 1; i >= 0; i--) {
      const state = ticket.course_states[courses[i]]
      if (state?.status === 'sent') {
        return { isEmpty: false, courseLabel: courses[i].charAt(0).toUpperCase() }
      }
    }
    return { isEmpty: true, courseLabel: null }
  }

  // Check if previous course is sent or cleared (for enabling AWAY button)
  const isPreviousCourseSent = (ticket: KDSTicket, courseName: string): boolean => {
    const courses = getOrderedCourses(ticket)
    const idx = courses.indexOf(courseName)
    if (idx <= 0) return true // First course or not found
    const prevCourse = courses[idx - 1]
    const s = ticket.course_states[prevCourse]?.status
    return s === 'sent' || s === 'cleared'
  }

  // Get consolidated pending orders (not yet sent) across all tickets, grouped by course
  const getPendingOrdersByCourse = (): { courseName: string; items: { name: string; portion: string | null; qty: number }[] }[] => {
    const courseMap: Record<string, Record<string, { name: string; portion: string | null; qty: number }>> = {}
    for (const ticket of tickets) {
      const courses = getOrderedCourses(ticket)
      for (const courseName of courses) {
        const status = ticket.course_states[courseName]?.status || 'pending'
        if (status === 'sent' || status === 'cleared') continue
        const orders = ticket.orders_by_course[courseName] || []
        for (const order of orders) {
          if (order.is_voided) continue
          if (!courseMap[courseName]) courseMap[courseName] = {}
          const key = `${order.name}||${order.portion || ''}`
          if (!courseMap[courseName][key]) {
            courseMap[courseName][key] = { name: order.name, portion: order.portion, qty: 0 }
          }
          courseMap[courseName][key].qty += order.quantity
        }
      }
    }
    const configNames = settings.kds_course_order.map((c) => c.name)
    const courseNames = Object.keys(courseMap)
    const ordered = configNames.filter((c) => courseNames.includes(c))
      .concat(courseNames.filter((c) => !configNames.includes(c)))
    return ordered.map((courseName) => ({
      courseName,
      items: Object.values(courseMap[courseName]).sort((a, b) => b.qty - a.qty),
    }))
  }

  // Format ISO timestamp as HH:MM
  const formatTime = (isoString: string | null): string => {
    if (!isoString) return ''
    const date = new Date(isoString)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  // Filter out voided and cancelled orders completely
  const filterOrders = (orders: KDSOrder[]): KDSOrder[] => {
    return orders.filter(order => {
      if (order.is_voided) return false
      const s = (order.status || '').toLowerCase()
      if (s === 'void' || s === 'cancelled' || s === 'canceled') return false
      return true
    })
  }

  return (
    <div style={styles.container}>
      {/* Main content area */}
      <div style={styles.mainArea}>
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
          <>
          <div style={styles.ticketsGrid}>
            {[...tickets].sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime()).map((ticket) => {
              const orderedCourses = getOrderedCourses(ticket)
              const headerColor = getTicketHeaderColor(ticket)
              const isAllSent = allCoursesSent(ticket)

              const tableState = getTableState(ticket)

              return (
                <div key={ticket.id} style={styles.ticketCard}>
                  {/* Ticket header - click to open detail modal */}
                  <div
                    style={{ ...styles.ticketHeader, borderTopColor: headerColor, cursor: 'pointer' }}
                    onClick={() => setSelectedTicket(ticket)}
                  >
                    <span style={styles.tableNumber}>{ticket.table_name || `#${ticket.ticket_number}`}</span>
                    {ticket.covers && <span style={styles.covers}>{ticket.covers} pax</span>}
                    {/* Table state indicator - centered */}
                    <div style={{
                      ...styles.tableStateBox,
                      ...(tableState.isEmpty ? {} : styles.tableStateBoxFilled),
                    }}>
                      {!tableState.isEmpty && (
                        <>
                          <PlateIcon />
                          <span style={styles.tableStateLetter}>{tableState.courseLabel}</span>
                        </>
                      )}
                    </div>
                    <span style={styles.timePlaced}>{formatTime(ticket.received_at)}</span>
                  </div>

                  {/* Courses */}
                  <div style={styles.coursesContainer}>
                    {orderedCourses.map((courseName, courseIdx) => {
                      const orders = ticket.orders_by_course[courseName] || []
                      const courseState = ticket.course_states[courseName]
                      const status = courseState?.status || 'pending'
                      const isCleared = status === 'cleared'
                      const isSent = status === 'sent'
                      const isAway = status === 'away'
                      const isPending = status === 'pending'
                      const canCallAway = isPending && isPreviousCourseSent(ticket, courseName)

                      // Check if next course has moved on (away or sent) - hide sent timer if so
                      const nextCourse = courseIdx < orderedCourses.length - 1 ? orderedCourses[courseIdx + 1] : null
                      const nextCourseStatus = nextCourse ? (ticket.course_states[nextCourse]?.status || 'pending') : 'pending'
                      const nextCourseMovedOn = nextCourseStatus === 'away' || nextCourseStatus === 'sent' || nextCourseStatus === 'cleared'

                      // Compute timers
                      const awayElapsed = isAway && courseState?.called_away_at
                        ? getElapsedSeconds(courseState.called_away_at) : 0
                      const sentElapsed = isSent && courseState?.sent_at
                        ? getElapsedSeconds(courseState.sent_at) : 0

                      // Per-course timer config and colors
                      const courseConfig = getCourseConfig(courseName)
                      const awayTimerColor = isAway ? getPrepTimerColor(awayElapsed, courseConfig) : '#4a4a6a'
                      const sentTimerColor = isSent ? getAwayTimerColor(sentElapsed, courseConfig) : '#4a4a6a'

                      // Hide cleared courses and sent courses whose next has moved on
                      if (isCleared) return null
                      if (isSent && nextCourseMovedOn) return null

                      return (
                        <div
                          key={courseName}
                          style={{
                            ...styles.courseSection,
                            // Fade sent courses that are still visible (next course hasn't moved on yet)
                            ...(isSent ? { opacity: 0.45 } : {}),
                          }}
                        >
                          <div style={styles.courseHeader}>
                            <span style={styles.courseName}>{courseName}</span>

                            {/* AWAY state: show timer + SENT button */}
                            {isAway && (
                              <>
                                <span style={{
                                  ...styles.courseTimer,
                                  color: awayTimerColor,
                                }}>
                                  {formatTimer(awayElapsed)}
                                </span>
                                <button
                                  onClick={() => courseSentMutation.mutate({ ticketId: ticket.id, courseName })}
                                  style={styles.sentButton}
                                  disabled={courseSentMutation.isPending}
                                >
                                  SENT
                                </button>
                              </>
                            )}

                            {/* PENDING state: only show AWAY button when enabled */}
                            {isPending && canCallAway && (
                              <button
                                onClick={() => courseAwayMutation.mutate({ ticketId: ticket.id, courseName })}
                                style={styles.awayButton}
                                disabled={courseAwayMutation.isPending}
                              >
                                AWAY
                              </button>
                            )}

                            {/* SENT state: show "SENT MM:SS" timer, but hide once next course moves on */}
                            {isSent && !nextCourseMovedOn && (
                              <span style={{
                                ...styles.courseTimer,
                                color: sentTimerColor,
                              }}>
                                SENT {formatTimer(sentElapsed)}
                              </span>
                            )}
                          </div>
                          <div style={styles.ordersList}>
                            {filterOrders(orders).map((order) => (
                              <div key={order.id} style={styles.orderItemWrap}>
                                <div style={styles.orderItem}>
                                  <span style={styles.orderQty}>{order.quantity}x</span>
                                  <span style={styles.orderName}>{order.name}</span>
                                  {order.portion && order.portion !== 'Normal' && (
                                    <span style={styles.orderPortion}>({order.portion})</span>
                                  )}
                                </div>
                                {order.tags && order.tags.length > 0 && (
                                  <div style={styles.orderTags}>
                                    {order.tags.map((t, i) => (
                                      <div key={i} style={styles.orderTag}>
                                        {t.quantity && t.quantity > 1 ? `${Math.round(t.quantity)}x ` : ''}{t.tag}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Complete ticket button - only shows when all courses sent */}
                  {isAllSent && (
                    <button
                      onClick={() => bumpTicketMutation.mutate(ticket.id)}
                      style={styles.bumpAllButton}
                      disabled={bumpTicketMutation.isPending}
                    >
                      COMPLETE TICKET
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {/* Pending orders overlay panel - bottom right, toggled from sidebar */}
          {showPending && (() => {
            const pendingCourses = getPendingOrdersByCourse()
            if (pendingCourses.length === 0) return (
              <div style={styles.pendingPanel}>
                <div style={styles.pendingPanelHeader}>PENDING</div>
                <div style={{ fontSize: '0.75rem', color: '#888', padding: '0.3rem 0' }}>No pending orders</div>
              </div>
            )
            return (
              <div style={styles.pendingPanel}>
                <div style={styles.pendingPanelHeader}>PENDING</div>
                {pendingCourses.map((course) => (
                  <div key={course.courseName} style={styles.pendingCourseGroup}>
                    <div style={styles.pendingCourseName}>{course.courseName}</div>
                    {course.items.map((item, i) => (
                      <div key={i} style={styles.pendingItemRow}>
                        <span style={styles.pendingItemQty}>{item.qty}x</span>
                        <span>{item.name}</span>
                        {item.portion && item.portion !== 'Normal' && (
                          <span style={styles.pendingItemPortion}>({item.portion})</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          })()}
          </>
        )}
      </div>

      {/* Ticket detail modal */}
      {selectedTicket && (() => {
        const ticket = selectedTicket
        const orderedCourses = getOrderedCourses(ticket)
        return (
          <div style={styles.modalOverlay} onClick={() => setSelectedTicket(null)}>
            <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              {/* Modal header */}
              <div style={styles.modalHeader}>
                <div style={styles.modalTitle}>
                  <span style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
                    {ticket.table_name || `#${ticket.ticket_number}`}
                  </span>
                  <span style={{ color: '#aaa', fontSize: '0.85rem' }}>
                    Ticket #{ticket.ticket_number}
                  </span>
                  {ticket.covers && (
                    <span style={{ color: '#aaa', fontSize: '0.85rem' }}>{ticket.covers} pax</span>
                  )}
                  <span style={{ color: '#8e8ea0', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                    Arrived {formatTime(ticket.received_at)}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedTicket(null)}
                  style={styles.modalClose}
                >
                  ✕
                </button>
              </div>

              {/* All courses with full detail */}
              <div style={styles.modalCourses}>
                {orderedCourses.map((courseName) => {
                  const orders = ticket.orders_by_course[courseName] || []
                  const courseState = ticket.course_states[courseName]
                  const status = courseState?.status || 'pending'

                  const statusColor = status === 'cleared' ? '#3498db'
                    : status === 'sent' ? '#27ae60'
                    : status === 'away' ? '#e67e22' : '#8e8ea0'
                  const statusLabel = status.toUpperCase()

                  return (
                    <div key={courseName} style={styles.modalCourseSection}>
                      <div style={styles.modalCourseHeader}>
                        <span style={styles.modalCourseName}>{courseName}</span>
                        <span style={{ ...styles.modalCourseStatus, color: statusColor }}>
                          {statusLabel}
                        </span>
                      </div>
                      {/* Course timing info */}
                      <div style={styles.modalCourseTimes}>
                        {courseState?.called_away_at && (
                          <span style={styles.modalTimeTag}>
                            Away: {formatTime(courseState.called_away_at)}
                          </span>
                        )}
                        {courseState?.sent_at && (
                          <span style={styles.modalTimeTag}>
                            Sent: {formatTime(courseState.sent_at)}
                          </span>
                        )}
                        {courseState?.cleared_at && (
                          <span style={styles.modalTimeTag}>
                            Cleared: {formatTime(courseState.cleared_at)}
                          </span>
                        )}
                      </div>
                      {/* Orders - show all, voided with strikethrough */}
                      <div style={styles.modalOrdersList}>
                        {orders.map((order) => {
                          const voided = order.is_voided || ['void', 'cancelled', 'canceled'].includes((order.status || '').toLowerCase())
                          return (
                            <div key={order.id} style={styles.modalOrderItemWrap}>
                              <div style={{
                                ...styles.modalOrderItem,
                                ...(voided ? { textDecoration: 'line-through', opacity: 0.5, color: '#e94560' } : {}),
                              }}>
                                <span style={styles.modalOrderQty}>{order.quantity}x</span>
                                <span style={{ flex: 1 }}>{order.name}</span>
                                {order.portion && order.portion !== 'Normal' && (
                                  <span style={{ color: '#888', fontSize: '0.8rem' }}>({order.portion})</span>
                                )}
                                {voided && <span style={{ fontSize: '0.7rem', color: '#e94560', marginLeft: '0.3rem' }}>VOID</span>}
                              </div>
                              {!voided && order.tags && order.tags.length > 0 && (
                                <div style={styles.modalOrderTags}>
                                  {order.tags.map((t, i) => (
                                    <div key={i} style={styles.modalOrderTag}>
                                      {t.quantity && t.quantity > 1 ? `${Math.round(t.quantity)}x ` : ''}{t.tag}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Right toolbar */}
      <div style={styles.toolbar}>
        {/* Ticket count badge */}
        <div style={styles.ticketBadge} title={`${tickets.length} active tickets`}>
          {tickets.length}
        </div>

        <div style={styles.toolbarDivider} />

        {/* Refresh */}
        <button
          onClick={() => refetch()}
          style={styles.toolbarButton}
          title="Refresh tickets"
        >
          <RefreshIcon />
        </button>

        {/* Fullscreen toggle */}
        <button
          onClick={toggleFullscreen}
          style={styles.toolbarButton}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>

        {/* Pending orders toggle */}
        <button
          onClick={() => setShowPending((p) => !p)}
          style={{
            ...styles.toolbarButton,
            ...(showPending ? styles.pendingButtonActive : {}),
            height: 'auto',
            padding: '0.4rem 0',
          }}
          title="Toggle pending orders"
        >
          <span style={styles.pendingButtonText}>PENDING{'\n'}ORDERS</span>
        </button>

        <div style={{ flex: 1 }} />

        {/* Exit to dashboard */}
        <button
          onClick={() => {
            if (document.fullscreenElement) {
              document.exitFullscreen()
            }
            navigate('/')
          }}
          style={{ ...styles.toolbarButton, ...styles.exitButton }}
          title="Exit to dashboard"
        >
          <ExitIcon />
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    height: '100%',
    background: '#1a1a2e',
    color: 'white',
    overflow: 'hidden',
  },
  mainArea: {
    flex: 1,
    overflow: 'auto',
    padding: '0.5rem',
  },
  // Right toolbar
  toolbar: {
    width: '52px',
    background: '#2d2d44',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '0.75rem 0',
    gap: '0.5rem',
    borderLeft: '1px solid #3d3d5c',
    flexShrink: 0,
  },
  toolbarButton: {
    width: '40px',
    height: '40px',
    background: 'transparent',
    border: '1px solid #4a4a6a',
    color: '#ccc',
    borderRadius: '6px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.15s, color 0.15s',
  },
  exitButton: {
    borderColor: '#e94560',
    color: '#e94560',
  },
  ticketBadge: {
    width: '36px',
    height: '36px',
    background: '#4a4a6a',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.9rem',
    fontWeight: 'bold',
    color: '#fff',
  },
  toolbarDivider: {
    width: '30px',
    height: '1px',
    background: '#4a4a6a',
  },
  // Error / loading / empty
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
  // Tickets grid
  ticketsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '0.5rem',
    alignItems: 'start',
  },
  ticketCard: {
    background: '#2d2d44',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  ticketHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.4rem 0.5rem',
    background: '#3d3d5c',
    borderTop: '3px solid #27ae60',
    position: 'relative' as const,
  },
  tableNumber: {
    fontSize: '0.85rem',
    fontWeight: 'bold',
    whiteSpace: 'nowrap',
  },
  covers: {
    fontSize: '0.75rem',
    color: '#aaa',
    whiteSpace: 'nowrap',
  },
  tableStateBox: {
    width: '28px',
    height: '20px',
    border: '1px dashed #666',
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1px',
    flexShrink: 0,
    position: 'absolute' as const,
    left: '50%',
    transform: 'translateX(-50%)',
  },
  tableStateBoxFilled: {
    border: '1px solid #8e8ea0',
    background: 'rgba(255,255,255,0.08)',
  },
  tableStateLetter: {
    fontSize: '0.6rem',
    fontWeight: 'bold',
    color: '#fff',
    lineHeight: 1,
  },
  timePlaced: {
    fontSize: '0.75rem',
    color: '#ccc',
    marginLeft: 'auto',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
  },
  coursesContainer: {
    padding: '0.4rem 0.5rem',
  },
  courseSection: {
    marginBottom: '0.4rem',
  },
  courseHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
    marginBottom: '0.25rem',
    paddingBottom: '0.25rem',
    borderBottom: '1px solid #4a4a6a',
  },
  courseName: {
    fontWeight: 'bold',
    textTransform: 'uppercase',
    fontSize: '0.7rem',
    color: '#aaa',
  },
  courseTimer: {
    fontFamily: 'monospace',
    fontSize: '0.7rem',
    fontWeight: 'bold',
    marginLeft: 'auto',
  },
  sentButton: {
    background: '#3498db',
    border: 'none',
    color: 'white',
    padding: '0.15rem 0.5rem',
    borderRadius: '3px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.65rem',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  awayButton: {
    background: '#e67e22',
    border: 'none',
    color: 'white',
    padding: '0.15rem 0.5rem',
    borderRadius: '3px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.65rem',
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  ordersList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.15rem',
  },
  orderItemWrap: {
    display: 'flex',
    flexDirection: 'column',
  },
  orderItem: {
    display: 'flex',
    gap: '0.3rem',
    fontSize: '0.78rem',
    fontWeight: 'bold',
  },
  orderTags: {
    paddingLeft: '1.8rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.05rem',
  },
  orderTag: {
    fontSize: '0.7rem',
    color: '#e67e22',
    fontStyle: 'italic',
  },
  orderQty: {
    fontWeight: 'bold',
    minWidth: '1.5rem',
  },
  orderName: {
    flex: 1,
  },
  orderPortion: {
    color: '#aaa',
    fontSize: '0.7rem',
  },
  bumpAllButton: {
    width: '100%',
    background: '#27ae60',
    border: 'none',
    color: 'white',
    padding: '0.4rem',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.7rem',
  },
  // Pending panel - bottom right floating
  pendingPanel: {
    position: 'fixed' as const,
    bottom: '0.5rem',
    right: '62px', // clear the toolbar
    background: '#2d2d44',
    borderRadius: '6px',
    border: '1px solid #4a4a6a',
    padding: '0.5rem',
    maxHeight: '40vh',
    overflowY: 'auto' as const,
    minWidth: '160px',
    maxWidth: '220px',
    zIndex: 10,
  },
  pendingPanelHeader: {
    fontSize: '0.7rem',
    fontWeight: 'bold',
    color: '#e67e22',
    marginBottom: '0.4rem',
    paddingBottom: '0.3rem',
    borderBottom: '1px solid #4a4a6a',
  },
  pendingCourseGroup: {
    marginBottom: '0.4rem',
  },
  pendingCourseName: {
    fontSize: '0.65rem',
    fontWeight: 'bold',
    color: '#aaa',
    textTransform: 'uppercase' as const,
    marginBottom: '0.15rem',
  },
  pendingItemRow: {
    display: 'flex',
    gap: '0.25rem',
    fontSize: '0.75rem',
    color: '#ccc',
    paddingLeft: '0.3rem',
  },
  pendingItemQty: {
    fontWeight: 'bold',
    minWidth: '1.5rem',
  },
  pendingItemPortion: {
    color: '#888',
    fontSize: '0.65rem',
  },
  // Modal
  modalOverlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modalContent: {
    background: '#2d2d44',
    borderRadius: '8px',
    width: '90%',
    maxWidth: '500px',
    maxHeight: '85vh',
    overflowY: 'auto' as const,
    border: '1px solid #4a4a6a',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.75rem 1rem',
    background: '#3d3d5c',
    borderBottom: '1px solid #4a4a6a',
    borderRadius: '8px 8px 0 0',
  },
  modalTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  modalClose: {
    background: 'transparent',
    border: '1px solid #4a4a6a',
    color: '#ccc',
    width: '30px',
    height: '30px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  modalCourses: {
    padding: '0.75rem 1rem',
  },
  modalCourseSection: {
    marginBottom: '0.75rem',
    paddingBottom: '0.5rem',
    borderBottom: '1px solid #3d3d5c',
  },
  modalCourseHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.25rem',
  },
  modalCourseName: {
    fontWeight: 'bold',
    textTransform: 'uppercase' as const,
    fontSize: '0.85rem',
    color: '#ccc',
  },
  modalCourseStatus: {
    fontSize: '0.7rem',
    fontWeight: 'bold',
    marginLeft: 'auto',
  },
  modalCourseTimes: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '0.4rem',
    flexWrap: 'wrap' as const,
  },
  modalTimeTag: {
    fontSize: '0.75rem',
    color: '#8e8ea0',
    fontFamily: 'monospace',
  },
  modalOrdersList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.2rem',
  },
  modalOrderItem: {
    display: 'flex',
    gap: '0.4rem',
    fontSize: '0.85rem',
    padding: '0.15rem 0',
  },
  modalOrderQty: {
    fontWeight: 'bold',
    minWidth: '2rem',
  },
  modalOrderItemWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  modalOrderTags: {
    paddingLeft: '2.4rem',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.05rem',
  },
  modalOrderTag: {
    fontSize: '0.8rem',
    color: '#e67e22',
    fontStyle: 'italic',
  },
  // Pending toggle button in sidebar
  pendingButtonActive: {
    borderColor: '#e67e22',
    color: '#e67e22',
  },
  pendingButtonText: {
    writingMode: 'vertical-rl' as const,
    transform: 'rotate(180deg)',
    fontSize: '0.55rem',
    fontWeight: 'bold',
    letterSpacing: '0.05em',
    lineHeight: 1.3,
    whiteSpace: 'pre-line' as const,
    textAlign: 'center' as const,
  },
}
