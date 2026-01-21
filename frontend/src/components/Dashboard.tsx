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
  recent_invoices: number
  pending_review: number
}

interface ResosCoversData {
  today: {
    date: string
    total_bookings: number
    total_covers: number
    service_breakdown: Array<{
      period: string
      bookings: number
      covers: number
    }>
    has_flagged_bookings: boolean
    unique_flag_types: string[] | null
  } | null
  tomorrow: {
    date: string
    total_bookings: number
    total_covers: number
    service_breakdown: Array<{
      period: string
      bookings: number
      covers: number
    }>
    has_flagged_bookings: boolean
    unique_flag_types: string[] | null
  } | null
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
      console.log('Resos covers data:', data)
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
    console.log('getFlagIcons called with:', flagTypes)
    if (!flagTypes || flagTypes.length === 0) {
      console.log('No flag types, returning empty array')
      return []
    }

    // Map flags to icons and deduplicate
    const iconSet = new Set<string>()
    for (const flag of flagTypes) {
      const icon = getIconForFlag(flag)
      console.log(`Flag "${flag}" -> Icon "${icon}"`)
      iconSet.add(icon)
    }

    const result = Array.from(iconSet)
    console.log('Returning icons:', result)
    return result
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

      <div style={styles.grid}>
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>This Week GP</h3>
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
          <h3 style={styles.cardTitle}>Last Week GP</h3>
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
          <h3 style={styles.cardTitle}>Recent Invoices</h3>
          <div style={styles.statValue}>{data?.recent_invoices || 0}</div>
          <p style={styles.statLabel}>Uploaded this week</p>
        </div>

        <div style={{ ...styles.card, ...(data?.pending_review ? styles.alertCard : {}) }}>
          <h3 style={styles.cardTitle}>Pending Review</h3>
          <div style={styles.statValue}>{data?.pending_review || 0}</div>
          <p style={styles.statLabel}>Invoices need review</p>
          {(data?.pending_review || 0) > 0 && (
            <a href="/invoices?status=processed" style={styles.link}>
              Review now →
            </a>
          )}
        </div>

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>
            Today's Covers
            {resosCovers?.today?.has_flagged_bookings && (
              <span style={styles.flagIcon}>
                {getFlagIcons(resosCovers.today.unique_flag_types).map((icon, idx) => (
                  <span key={idx}>{icon}</span>
                ))}
              </span>
            )}
          </h3>
          {resosCovers?.today ? (
            <>
              <div style={styles.coverValue}>
                {resosCovers.today.total_covers} covers
              </div>
              <div style={styles.details}>
                <span>{resosCovers.today.total_bookings} bookings</span>
                {resosCovers.today.service_breakdown.map((s) => (
                  <span key={s.period}>
                    {s.period}: {s.bookings} : {s.covers}
                  </span>
                ))}
              </div>
              <a href="/resos" style={styles.link}>
                View Calendar →
              </a>
            </>
          ) : (
            <p style={styles.noData}>No booking data</p>
          )}
        </div>

        <div style={styles.card}>
          <h3 style={styles.cardTitle}>
            Tomorrow's Covers
            {resosCovers?.tomorrow?.has_flagged_bookings && (
              <span style={styles.flagIcon}>
                {getFlagIcons(resosCovers.tomorrow.unique_flag_types).map((icon, idx) => (
                  <span key={idx}>{icon}</span>
                ))}
              </span>
            )}
          </h3>
          {resosCovers?.tomorrow ? (
            <>
              <div style={styles.coverValue}>
                {resosCovers.tomorrow.total_covers} covers
              </div>
              <div style={styles.details}>
                <span>{resosCovers.tomorrow.total_bookings} bookings</span>
                {resosCovers.tomorrow.service_breakdown.map((s) => (
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

      {/* Hotel Arrivals & Restaurant Bookings */}
      {arrivalStats && arrivalStats.days && arrivalStats.days.length > 0 && (
        <div style={styles.wideCard}>
          <h3 style={styles.cardTitle}>
            {arrivalStats.service_filter_name
              ? `Hotel Arrivals & ${arrivalStats.service_filter_name} Bookings`
              : 'Hotel Arrivals & Restaurant Bookings'
            }
            {arrivalStats.service_filter_name && (
              <span style={styles.serviceFilterInfo}> (showing {arrivalStats.service_filter_name} tables only)</span>
            )}
          </h3>
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
      )}

      <div style={styles.actions}>
        <a href="/upload" style={styles.primaryBtn}>
          Upload Invoice
        </a>
        <a href="/invoices" style={styles.secondaryBtn}>
          View All Invoices
        </a>
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
  title: {
    marginBottom: '1.5rem',
    color: '#1a1a2e',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
    gap: '1.5rem',
    marginBottom: '2rem',
  },
  card: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
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
    marginLeft: '8px',
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
  actions: {
    display: 'flex',
    gap: '1rem',
  },
  primaryBtn: {
    padding: '1rem 2rem',
    background: '#e94560',
    color: 'white',
    textDecoration: 'none',
    borderRadius: '8px',
    fontWeight: 'bold',
  },
  secondaryBtn: {
    padding: '1rem 2rem',
    background: '#1a1a2e',
    color: 'white',
    textDecoration: 'none',
    borderRadius: '8px',
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
    marginTop: '1rem',
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
}
