import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface Invoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  status: string
  category: string | null
  ocr_confidence: number | null
  created_at: string
  document_type: string | null
  duplicate_status: string | null
}

interface InvoiceListResponse {
  invoices: Invoice[]
  total: number
}

const statusColors: Record<string, string> = {
  pending: '#f0ad4e',
  processed: '#5bc0de',
  reviewed: '#5cb85c',
  confirmed: '#428bca',
}

export default function InvoiceList() {
  const { token } = useAuth()

  const { data, isLoading, error } = useQuery<InvoiceListResponse>({
    queryKey: ['invoices'],
    queryFn: async () => {
      const res = await fetch('/api/invoices/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch invoices')
      return res.json()
    },
  })

  if (isLoading) {
    return <div style={styles.loading}>Loading invoices...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading invoices: {error.message}</div>
  }

  const invoices = data?.invoices || []

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>Invoices</h2>
        <a href="/upload" style={styles.uploadBtn}>
          + Upload New
        </a>
      </div>

      {invoices.length === 0 ? (
        <div style={styles.empty}>
          <p>No invoices yet.</p>
          <a href="/upload" style={styles.link}>
            Upload your first invoice
          </a>
        </div>
      ) : (
        <div style={styles.list}>
          {invoices.map((invoice) => (
            <a
              key={invoice.id}
              href={`/invoice/${invoice.id}`}
              style={styles.card}
            >
              <div style={styles.cardMain}>
                <div style={styles.invoiceNumberRow}>
                  <span style={styles.invoiceNumber}>
                    {invoice.invoice_number || 'Pending extraction...'}
                  </span>
                  {invoice.document_type === 'delivery_note' && (
                    <span style={styles.dnBadge}>DN</span>
                  )}
                  {invoice.duplicate_status === 'firm_duplicate' && (
                    <span style={styles.duplicateBadge}>DUPLICATE</span>
                  )}
                  {invoice.duplicate_status === 'possible_duplicate' && (
                    <span style={styles.possibleDuplicateBadge}>POSSIBLE DUPLICATE</span>
                  )}
                </div>
                <div style={styles.invoiceDate}>
                  {invoice.invoice_date
                    ? new Date(invoice.invoice_date).toLocaleDateString()
                    : 'No date'}
                </div>
              </div>

              <div style={styles.cardRight}>
                <div style={styles.total}>
                  {invoice.total != null
                    ? `£${Number(invoice.total).toFixed(2)}`
                    : '—'}
                </div>
                <div
                  style={{
                    ...styles.status,
                    background: statusColors[invoice.status] || '#999',
                  }}
                >
                  {invoice.status}
                </div>
              </div>

              {invoice.ocr_confidence != null && (
                <div style={styles.confidence}>
                  {(Number(invoice.ocr_confidence) * 100).toFixed(0)}% confidence
                </div>
              )}
            </a>
          ))}
        </div>
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
  error: {
    padding: '2rem',
    textAlign: 'center',
    color: '#c00',
    background: '#fee',
    borderRadius: '8px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
  },
  title: {
    color: '#1a1a2e',
    margin: 0,
  },
  uploadBtn: {
    padding: '0.75rem 1.5rem',
    background: '#e94560',
    color: 'white',
    textDecoration: 'none',
    borderRadius: '8px',
    fontWeight: 'bold',
  },
  empty: {
    background: 'white',
    padding: '3rem',
    borderRadius: '12px',
    textAlign: 'center',
    color: '#666',
  },
  link: {
    color: '#e94560',
    marginTop: '1rem',
    display: 'inline-block',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'white',
    padding: '1.25rem 1.5rem',
    borderRadius: '12px',
    textDecoration: 'none',
    color: 'inherit',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    transition: 'transform 0.2s, box-shadow 0.2s',
    position: 'relative',
  },
  cardMain: {
    flex: 1,
  },
  invoiceNumberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  invoiceNumber: {
    fontWeight: 'bold',
    fontSize: '1.1rem',
    color: '#1a1a2e',
  },
  dnBadge: {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    background: '#6c757d',
    color: 'white',
    fontSize: '0.65rem',
    fontWeight: 'bold',
    borderRadius: '4px',
    textTransform: 'uppercase',
  },
  duplicateBadge: {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    background: '#dc3545',
    color: 'white',
    fontSize: '0.65rem',
    fontWeight: 'bold',
    borderRadius: '4px',
    textTransform: 'uppercase',
  },
  possibleDuplicateBadge: {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    background: '#fd7e14',
    color: 'white',
    fontSize: '0.65rem',
    fontWeight: 'bold',
    borderRadius: '4px',
    textTransform: 'uppercase',
  },
  invoiceDate: {
    color: '#666',
    fontSize: '0.9rem',
    marginTop: '0.25rem',
  },
  cardRight: {
    textAlign: 'right',
  },
  total: {
    fontWeight: 'bold',
    fontSize: '1.2rem',
    color: '#1a1a2e',
  },
  status: {
    display: 'inline-block',
    padding: '0.25rem 0.75rem',
    borderRadius: '20px',
    color: 'white',
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    marginTop: '0.5rem',
  },
  confidence: {
    position: 'absolute',
    top: '0.5rem',
    right: '0.75rem',
    fontSize: '0.7rem',
    color: '#999',
  },
}
