import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface DashboardData {
  current_period: {
    total_revenue: number
    total_costs: number
    gp_percentage: number
  } | null
  previous_period: {
    total_revenue: number
    total_costs: number
    gp_percentage: number
  } | null
  forecast_period: {
    total_revenue: number
    total_costs: number
    gp_percentage: number
  } | null
  rolling_30_days: {
    total_revenue: number
    total_costs: number
    gp_percentage: number
  } | null
  recent_invoices: number
  pending_review: number
}

interface CoversDayData {
  date: string
  day_label: string
  total_bookings: number
  total_covers: number
  service_breakdown: Array<{
    period: string
    bookings: number
    covers: number
  }>
  has_flagged_bookings: boolean
  unique_flag_types: string[] | null
}

interface ResosCoversData {
  today: CoversDayData | null
  tomorrow: CoversDayData | null
  day_after: CoversDayData | null
}

interface ResosSettings {
  resos_flag_icon_mapping: Record<string, string> | null
}

interface ArrivalDayStats {
  date: string
  day_name: string
  arrival_count: number
  arrival_guests: number
  table_bookings: number
  table_covers: number
  matched_arrivals: number
  unmatched_arrivals: number
  opportunity_guests: number
}

interface ArrivalDashboardData {
  days: ArrivalDayStats[]
  service_filter_name?: string | null
}

interface DisputeStats {
  total_disputes: number
  open_disputes: number
  total_disputed_amount: number
  status_counts: Record<string, { count: number; amount: number }>
  recent_disputes: Array<{
    id: number
    invoice_id: number
    invoice_number: string | null
    supplier_name: string
    title: string
    status: string
    disputed_amount: number
    opened_at: string
  }>
}

export default function Dashboard() {
  const { token } = useAuth()

  // Fetch Resos settings for flag icon mapping
  const { data: resosSettings } = useQuery<ResosSettings>({
    queryKey: ['resos-settings'],
    queryFn: async () => {
      const res = await fetch('/api/resos/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch Resos settings')
      return res.json()
    },
    enabled: !!token,
  })

  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/reports/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch dashboard')
      return res.json()
    },
  })

  const { data: resosCovers } = useQuery<ResosCoversData>({
    queryKey: ['resos-dashboard-covers'],
    queryFn: async () => {
      const res = await fetch('/api/resos/dashboard/today-tomorrow', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch Resos covers')
      const data = await res.json()
      return data
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  })

  const { data: arrivalStats } = useQuery<ArrivalDashboardData>({
    queryKey: ['newbook-arrival-stats'],
    queryFn: async () => {
      const res = await fetch('/api/newbook/dashboard/arrivals?days=3', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch arrival stats')
      return res.json()
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  })

  const { data: upcomingEvents } = useQuery<{
    total_count: number
    upcoming_events: Array<{
      id: number
      event_date: string
      event_type: string
      title: string
    }>
  }>({
    queryKey: ['upcoming-events'],
    queryFn: async () => {
      const res = await fetch('/api/calendar-events/dashboard/upcoming', {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch upcoming events')
      return res.json()
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  })

  const { data: disputeStats } = useQuery<DisputeStats>({
    queryKey: ['dispute-stats'],
    queryFn: async () => {
      const res = await fetch('/api/disputes/stats/summary', {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch dispute stats')
      return res.json()
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  })

  // Helper function to get icon for a single flag type
  const getIconForFlag = (flag: string): string => {
    const iconMapping = resosSettings?.resos_flag_icon_mapping || {}

    // Default icons if not customized
    const defaultIcons: Record<string, string> = {
      'allergies': '🦀',
      'large_group': '⚠️',
      'note_keyword_birthday': '🎂',
      'note_keyword_anniversary': '💍',
    }

    // First check custom mapping
    if (iconMapping[flag]) {
      return iconMapping[flag]
    }

    // Check if it's a note_keyword flag and extract the keyword
    if (flag.startsWith('note_keyword_')) {
      const keyword = flag.replace('note_keyword_', '')
      if (iconMapping[keyword]) {
        return iconMapping[keyword]
      }
    }

    // Fall back to default icons
    if (defaultIcons[flag]) {
      return defaultIcons[flag]
    }

    return '⚠️'  // Generic warning if no match found
  }

  // Helper function to get multiple unique icons for flag types
  const getFlagIcons = (flagTypes: string[] | null): string[] => {
    if (!flagTypes || flagTypes.length === 0) {
      return []
    }

    // Map flags to icons and deduplicate
    const iconSet = new Set<string>()
    for (const flag of flagTypes) {
      const icon = getIconForFlag(flag)
      iconSet.add(icon)
    }

    return Array.from(iconSet)
  }

  // Helper to render a covers widget
  const renderCoversWidget = (dayData: CoversDayData | null, title: string) => {
    return (
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>
          {title}
          {dayData?.has_flagged_bookings && (
            <span style={styles.flagIcon}>
              {getFlagIcons(dayData.unique_flag_types).map((icon, idx) => (
                <span key={idx}>{icon}</span>
              ))}
            </span>
          )}
        </h3>
        {dayData && dayData.total_covers > 0 ? (
          <>
            <div style={styles.coverValue}>
              {dayData.total_covers} covers
            </div>
            <div style={styles.details}>
              <span>{dayData.total_bookings} bookings</span>
              {dayData.service_breakdown.map((s) => (
                <span key={s.period}>
                  {s.period}: {s.bookings} : {s.covers}
                </span>
              ))}
            </div>
          </>
        ) : (
          <p style={styles.noData}>No booking data</p>
        )}
      </div>
    )
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading dashboard...</div>
  }

  if (error) {
    return <div style={styles.loading}>Error loading dashboard. Please try logging in again.</div>
  }

  const current = data?.current_period
  const previous = data?.previous_period

  return (
    <div>
      <h2 style={styles.title}>Dashboard</h2>

      {/* ===== GP Section ===== */}
      <h3 style={styles.sectionTitle}>Gross Profit</h3>
      <div style={styles.fourGrid}>
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>This Week</h3>
          {current ? (
            <>
              <div style={styles.gpValue}>{Number(current.gp_percentage).toFixed(1)}%</div>
              <div style={styles.details}>
                <span>Revenue: £{Number(current.total_revenue).toFixed(2)}</span>
                <span>Costs: £{Number(current.total_costs).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p style={styles.noData}>No data for this period</p>
          )}
        </div>

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>This Week Forecast</h3>
          {data?.forecast_period ? (
            <>
              <div style={styles.gpValue}>{Number(data.forecast_period.gp_percentage).toFixed(1)}%</div>
              <div style={styles.details}>
                <span>Revenue: £{Number(data.forecast_period.total_revenue).toFixed(2)}</span>
                <span>Costs: £{Number(data.forecast_period.total_costs).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p style={styles.noData}>Coming soon</p>
          )}
        </div>

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Last Week</h3>
          {previous ? (
            <>
              <div style={styles.gpValue}>{Number(previous.gp_percentage).toFixed(1)}%</div>
              <div style={styles.details}>
                <span>Revenue: £{Number(previous.total_revenue).toFixed(2)}</span>
                <span>Costs: £{Number(previous.total_costs).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p style={styles.noData}>No data for this period</p>
          )}
        </div>

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Last 30 Days</h3>
          {data?.rolling_30_days ? (
            <>
              <div style={styles.gpValue}>{Number(data.rolling_30_days.gp_percentage).toFixed(1)}%</div>
              <div style={styles.details}>
                <span>Revenue: £{Number(data.rolling_30_days.total_revenue).toFixed(2)}</span>
                <span>Costs: £{Number(data.rolling_30_days.total_costs).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p style={styles.noData}>No data for this period</p>
          )}
        </div>
      </div>

      {/* ===== Documents Section ===== */}
      <h3 style={styles.sectionTitle}>Documents</h3>
      <div style={styles.fourGrid}>
        <a href="/upload" style={{ ...styles.card, ...styles.uploadCard, textDecoration: 'none' }}>
          <h3 style={styles.cardTitle}>Upload New</h3>
          <div style={styles.uploadIcon}>+</div>
          <p style={styles.statLabel}>Upload invoice</p>
        </a>

        <div style={{ ...styles.card, ...(data?.pending_review ? styles.alertCard : {}) }}>
          <h3 style={styles.cardTitle}>Pending Confirmation</h3>
          <div style={styles.statValue}>{data?.pending_review || 0}</div>
          <p style={styles.statLabel}>Awaiting confirmation</p>
          {(data?.pending_review || 0) > 0 && (
            <a href="/invoices?status=pending_confirmation" style={styles.link}>
              Review now →
            </a>
          )}
        </div>

        <div style={{
          ...styles.card,
          ...((disputeStats?.open_disputes || 0) > 0 ? styles.alertCard : {})
        }}>
          <h3 style={styles.cardTitle}>Disputes</h3>
          <div style={{
            ...styles.statValue,
            color: (disputeStats?.open_disputes || 0) > 0 ? '#e94560' : '#4ade80'
          }}>
            {disputeStats?.open_disputes || 0}
          </div>
          <p style={styles.statLabel}>Open disputes</p>
          {disputeStats && disputeStats.status_counts && Object.keys(disputeStats.status_counts).length > 0 && (
            <div style={styles.statusBreakdown}>
              {Object.entries(disputeStats.status_counts)
                .filter(([status]) => status !== 'RESOLVED')
                .filter(([, data]) => (data as any).count > 0)
                .map(([status, data]) => (
                  <span key={status} style={styles.statusBreakdownItem}>
                    {status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}: {(data as any).count}
                  </span>
                ))}
            </div>
          )}
          <a href="/disputes" style={styles.link}>
            View all →
          </a>
        </div>

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Recent Invoices</h3>
          <div style={styles.statValue}>{data?.recent_invoices || 0}</div>
          <p style={styles.statLabel}>Uploaded this week</p>
          {(data?.recent_invoices || 0) > 0 && (
            <a href={`/invoices?date_from=${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}&date_to=${new Date().toISOString().split('T')[0]}`} style={styles.link}>
              View all →
            </a>
          )}
        </div>
      </div>

      {/* ===== Covers Section ===== */}
      <h3 style={styles.sectionTitle}>Covers</h3>
      <div style={styles.fourGrid}>
        {renderCoversWidget(resosCovers?.today || null, 'Today')}
        {renderCoversWidget(resosCovers?.tomorrow || null, 'Tomorrow')}
        {renderCoversWidget(resosCovers?.day_after || null, resosCovers?.day_after?.day_label || 'Day After')}

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Upcoming Events</h3>
          {upcomingEvents && upcomingEvents.total_count > 0 ? (
            <>
              <div style={styles.gpValue}>{upcomingEvents.total_count}</div>
              <div style={styles.details}>
                {upcomingEvents.upcoming_events.map((event) => (
                  <span key={event.id} style={{ fontSize: '0.85rem' }}>
                    {event.event_date}: {event.title}
                  </span>
                ))}
              </div>
              <a href="/resos" style={styles.link}>View Calendar →</a>
            </>
          ) : (
            <p style={styles.noData}>No upcoming events</p>
          )}
        </div>
      </div>

      {/* ===== Hotel Arrivals & Restaurant Bookings ===== */}
      {arrivalStats && arrivalStats.days && arrivalStats.days.length > 0 && (
        <>
          <h3 style={styles.sectionTitle}>
            {arrivalStats.service_filter_name
              ? `Hotel Arrivals & ${arrivalStats.service_filter_name} Bookings`
              : 'Hotel Arrivals & Restaurant Bookings'
            }
          </h3>
          <div style={styles.wideCard}>
            {arrivalStats.service_filter_name && (
              <span style={styles.serviceFilterInfo}>(showing {arrivalStats.service_filter_name} tables only)</span>
            )}
            <div style={styles.arrivalGrid}>
              {arrivalStats.days.map((day) => (
                <div key={day.date} style={styles.arrivalDay}>
                  <div style={styles.dayName}>{day.day_name}</div>
                  <div style={styles.arrivalStats}>
                    <div style={styles.arrivalStat}>
                      <div style={styles.arrivalValue}>{day.arrival_count}</div>
                      <div style={styles.arrivalLabel}>arrivals</div>
                      <div style={styles.arrivalSubtext}>{day.arrival_guests} guests</div>
                    </div>
                    <div style={styles.arrivalStat}>
                      <div style={styles.arrivalValue}>{day.table_bookings}</div>
                      <div style={styles.arrivalLabel}>table bookings</div>
                      <div style={styles.arrivalSubtext}>{day.table_covers} covers</div>
                    </div>
                    <div style={styles.arrivalStat}>
                      <div style={{ ...styles.arrivalValue, color: '#4ade80' }}>{day.matched_arrivals}</div>
                      <div style={styles.arrivalLabel}>have booked</div>
                    </div>
                    <div style={styles.arrivalStat}>
                      <div style={{ ...styles.arrivalValue, color: '#e94560' }}>{day.unmatched_arrivals}</div>
                      <div style={styles.arrivalLabel}>no booking yet</div>
                      <div style={styles.arrivalSubtext}>{day.opportunity_guests} guests</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  title: {
    marginBottom: '1.5rem',
    color: '#1a1a2e',
  },
  sectionTitle: {
    color: '#1a1a2e',
    fontSize: '1rem',
    fontWeight: 600,
    marginBottom: '1rem',
    marginTop: '0.5rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  fourGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '1.5rem',
    marginBottom: '2rem',
  },
  card: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  uploadCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'transform 0.2s, box-shadow 0.2s',
    border: '2px dashed #e94560',
  },
  uploadIcon: {
    fontSize: '3rem',
    fontWeight: 'bold',
    color: '#e94560',
    marginBottom: '0.5rem',
  },
  alertCard: {
    borderLeft: '4px solid #e94560',
  },
  cardTitle: {
    color: '#666',
    fontSize: '0.9rem',
    marginBottom: '1rem',
    textTransform: 'uppercase',
  },
  serviceFilterInfo: {
    color: '#999',
    fontSize: '0.75rem',
    fontWeight: 'normal',
    textTransform: 'none',
    marginBottom: '1rem',
    display: 'block',
  },
  gpValue: {
    fontSize: '2.5rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  statValue: {
    fontSize: '2.5rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  coverValue: {
    fontSize: '2rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  flagIcon: {
    fontSize: '1.2rem',
    marginLeft: '0.5rem',
  },
  statLabel: {
    color: '#666',
    marginTop: '0.5rem',
  },
  details: {
    marginTop: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    color: '#666',
    fontSize: '0.9rem',
  },
  noData: {
    color: '#999',
    fontStyle: 'italic',
  },
  link: {
    display: 'inline-block',
    marginTop: '1rem',
    color: '#e94560',
    textDecoration: 'none',
    fontWeight: 'bold',
  },
  wideCard: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    marginBottom: '2rem',
  },
  arrivalGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '1.5rem',
  },
  arrivalDay: {
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '1rem',
  },
  dayName: {
    fontSize: '0.875rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: '0.75rem',
    textTransform: 'uppercase',
  },
  arrivalStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '0.75rem',
  },
  arrivalStat: {
    textAlign: 'center',
  },
  arrivalValue: {
    fontSize: '1.75rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  arrivalLabel: {
    fontSize: '0.75rem',
    color: '#666',
    marginTop: '0.25rem',
  },
  arrivalSubtext: {
    fontSize: '0.75rem',
    color: '#999',
    marginTop: '0.125rem',
  },
  statusBreakdown: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginTop: '0.5rem',
    marginBottom: '0.75rem',
  },
  statusBreakdownItem: {
    fontSize: '0.75rem',
    color: '#666',
  },
}
