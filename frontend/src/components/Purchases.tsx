import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface PurchaseInvoice {
  id: number
  invoice_number: string | null
  total: number | null
  supplier_match_type: string | null
}

interface SupplierRow {
  supplier_id: number | null
  supplier_name: string
  is_unmatched: boolean
  invoices_by_date: Record<string, PurchaseInvoice[]>
  total: number
  percentage: number
}

interface WeeklyPurchasesResponse {
  week_start: string
  week_end: string
  dates: string[]
  suppliers: SupplierRow[]
  daily_totals: Record<string, number>
  week_total: number
}

export default function Purchases() {
  const { token } = useAuth()
  const [weekOffset, setWeekOffset] = useState(0)

  const { data, isLoading, error } = useQuery<WeeklyPurchasesResponse>({
    queryKey: ['weekly-purchases', weekOffset],
    queryFn: async () => {
      const res = await fetch(`/api/reports/purchases/weekly?week_offset=${weekOffset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch purchases')
      return res.json()
    },
  })

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
  }

  const formatWeekRange = (start: string, end: string) => {
    const startDate = new Date(start)
    const endDate = new Date(end)
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
    return `${startDate.toLocaleDateString('en-GB', opts)} - ${endDate.toLocaleDateString('en-GB', opts)}`
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading purchases...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading purchases: {(error as Error).message}</div>
  }

  const { dates = [], suppliers = [], daily_totals = {}, week_total = 0 } = data || {}

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>Weekly Purchases</h2>
        <div style={styles.weekNav}>
          <button onClick={() => setWeekOffset(weekOffset - 1)} style={styles.navBtn}>
            ← Previous
          </button>
          <span style={styles.weekLabel}>
            {data ? formatWeekRange(data.week_start, data.week_end) : ''}
          </span>
          <button
            onClick={() => setWeekOffset(weekOffset + 1)}
            style={styles.navBtn}
            disabled={weekOffset >= 0}
          >
            Next →
          </button>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(0)} style={styles.todayBtn}>
              Today
            </button>
          )}
        </div>
      </div>

      {suppliers.length === 0 ? (
        <div style={styles.empty}>
          <p>No purchases this week.</p>
        </div>
      ) : (
        <div style={styles.tableContainer}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, ...styles.supplierHeader }}>Supplier</th>
                {dates.map((d) => (
                  <th key={d} style={styles.th}>{formatDate(d)}</th>
                ))}
                <th style={{ ...styles.th, ...styles.totalHeader }}>Total</th>
                <th style={{ ...styles.th, ...styles.percentHeader }}>%</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((row) => (
                <tr key={row.supplier_id ?? row.supplier_name} style={styles.tr}>
                  <td style={{
                    ...styles.td,
                    ...styles.supplierCell,
                    ...(row.is_unmatched ? styles.unmatchedSupplier : {})
                  }}>
                    {row.supplier_name}
                    {row.is_unmatched && <span style={styles.unmatchedBadge}>!</span>}
                  </td>
                  {dates.map((d) => {
                    const invoices = row.invoices_by_date[d] || []
                    return (
                      <td key={d} style={styles.td}>
                        {invoices.length > 0 ? (
                          <div style={styles.invoicesCell}>
                            {invoices.map((inv) => (
                              <a
                                key={inv.id}
                                href={`/invoice/${inv.id}`}
                                style={{
                                  ...styles.invoiceLink,
                                  ...(inv.supplier_match_type === 'fuzzy' ? styles.fuzzyInvoice : {}),
                                  ...(inv.supplier_match_type === null && row.is_unmatched ? styles.unmatchedInvoice : {})
                                }}
                                title={inv.invoice_number || `Invoice #${inv.id}`}
                              >
                                £{(inv.total ?? 0).toFixed(2)}
                              </a>
                            ))}
                          </div>
                        ) : (
                          <span style={styles.emptyCell}>-</span>
                        )}
                      </td>
                    )
                  })}
                  <td style={{ ...styles.td, ...styles.totalCell }}>
                    £{row.total.toFixed(2)}
                  </td>
                  <td style={{ ...styles.td, ...styles.percentCell }}>
                    {row.percentage.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={styles.footerRow}>
                <td style={{ ...styles.td, ...styles.footerLabel }}>Daily Total</td>
                {dates.map((d) => (
                  <td key={d} style={{ ...styles.td, ...styles.footerCell }}>
                    £{(daily_totals[d] ?? 0).toFixed(2)}
                  </td>
                ))}
                <td style={{ ...styles.td, ...styles.grandTotal }}>
                  £{week_total.toFixed(2)}
                </td>
                <td style={{ ...styles.td, ...styles.footerCell }}>100%</td>
              </tr>
            </tfoot>
          </table>
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
    flexWrap: 'wrap',
    gap: '1rem',
  },
  title: {
    color: '#1a1a2e',
    margin: 0,
  },
  weekNav: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  navBtn: {
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  todayBtn: {
    padding: '0.5rem 1rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 'bold',
  },
  weekLabel: {
    fontWeight: 'bold',
    fontSize: '1rem',
    minWidth: '140px',
    textAlign: 'center',
  },
  empty: {
    background: 'white',
    padding: '3rem',
    borderRadius: '12px',
    textAlign: 'center',
    color: '#666',
  },
  tableContainer: {
    background: 'white',
    borderRadius: '12px',
    overflow: 'auto',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    padding: '0.75rem 0.5rem',
    background: '#1a1a2e',
    color: 'white',
    fontWeight: '600',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  supplierHeader: {
    textAlign: 'left',
    paddingLeft: '1rem',
    minWidth: '150px',
  },
  totalHeader: {
    background: '#2d2d44',
  },
  percentHeader: {
    background: '#2d2d44',
    minWidth: '60px',
  },
  tr: {
    borderBottom: '1px solid #eee',
  },
  td: {
    padding: '0.5rem',
    textAlign: 'center',
    verticalAlign: 'top',
  },
  supplierCell: {
    textAlign: 'left',
    paddingLeft: '1rem',
    fontWeight: '500',
    whiteSpace: 'nowrap',
  },
  unmatchedSupplier: {
    color: '#721c24',
    background: '#f8d7da',
  },
  unmatchedBadge: {
    display: 'inline-block',
    marginLeft: '0.3rem',
    width: '14px',
    height: '14px',
    lineHeight: '14px',
    textAlign: 'center',
    background: '#dc3545',
    color: 'white',
    borderRadius: '50%',
    fontSize: '0.7rem',
    fontWeight: 'bold',
  },
  invoicesCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    alignItems: 'center',
  },
  invoiceLink: {
    display: 'inline-block',
    padding: '0.2rem 0.5rem',
    background: '#e8f4e8',
    color: '#155724',
    borderRadius: '4px',
    textDecoration: 'none',
    fontSize: '0.85rem',
    fontWeight: '500',
    border: '1px solid #c3e6cb',
  },
  fuzzyInvoice: {
    background: '#fff3cd',
    color: '#856404',
    border: '1px solid #ffc107',
  },
  unmatchedInvoice: {
    background: '#f8d7da',
    color: '#721c24',
    border: '1px solid #f5c6cb',
  },
  emptyCell: {
    color: '#ccc',
  },
  totalCell: {
    fontWeight: 'bold',
    background: '#f8f9fa',
  },
  percentCell: {
    fontWeight: '500',
    background: '#f8f9fa',
    color: '#666',
  },
  footerRow: {
    background: '#f8f9fa',
    borderTop: '2px solid #dee2e6',
  },
  footerLabel: {
    textAlign: 'left',
    paddingLeft: '1rem',
    fontWeight: 'bold',
  },
  footerCell: {
    fontWeight: 'bold',
  },
  grandTotal: {
    fontWeight: 'bold',
    background: '#1a1a2e',
    color: 'white',
  },
}
