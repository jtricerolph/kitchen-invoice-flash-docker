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

export default function Dashboard() {
  const { token } = useAuth()

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
      </div>

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
}
