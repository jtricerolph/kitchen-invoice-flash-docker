import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../App'
import DisputeDetailModal from './DisputeDetailModal'

interface Dispute {
  id: number
  invoice_id: number
  invoice_number: string | null
  supplier_id: number | null
  supplier_name: string | null
  dispute_type: string
  status: string
  priority: string
  title: string
  description: string | null
  disputed_amount: number | null
  expected_amount: number | null
  difference_amount: number | null
  opened_at: string
  updated_at: string
  opened_by_username: string | null
  resolved_at: string | null
}

interface DisputeListResponse {
  disputes: Dispute[]
  total: number
}

const statusColors: Record<string, string> = {
  new: '#e94560',
  contacted: '#f0ad4e',
  awaiting_credit: '#9b59b6',
  awaiting_replacement: '#8b7ec8',
  resolved: '#5cb85c',
}

const priorityColors: Record<string, string> = {
  low: '#5cb85c',
  medium: '#5bc0de',
  high: '#f0ad4e',
  urgent: '#e94560',
}

export default function Disputes() {
  const { token } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [statusFilter, setStatusFilter] = useState<string>('not_resolved') // Default to show all non-resolved disputes
  const [priorityFilter, setPriorityFilter] = useState<string>('')
  const [supplierFilter, setSupplierFilter] = useState<string>('')
  const [selectedDispute, setSelectedDispute] = useState<Dispute | null>(null)

  // Fetch suppliers for filter dropdown
  const { data: suppliersData } = useQuery<{ suppliers: Array<{ id: number; name: string }> }>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch suppliers')
      return res.json()
    },
    enabled: !!token,
  })

  // Build query params
  const queryParams = new URLSearchParams()

  // Handle "not_resolved" special filter - don't send to backend, filter client-side
  if (statusFilter && statusFilter !== 'not_resolved') {
    queryParams.append('status', statusFilter.toUpperCase())
  }
  if (priorityFilter) queryParams.append('priority', priorityFilter)
  if (supplierFilter) queryParams.append('supplier_id', supplierFilter)
  const queryString = queryParams.toString()

  const { data, isLoading, error } = useQuery<DisputeListResponse>({
    queryKey: ['disputes', statusFilter, priorityFilter, supplierFilter],
    queryFn: async () => {
      const url = queryString ? `/api/disputes?${queryString}` : '/api/disputes'
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch disputes')
      return res.json()
    },
    enabled: !!token,
  })

  // Client-side filter for "not_resolved" - show all except resolved
  let disputes = data?.disputes || []
  if (statusFilter === 'not_resolved') {
    disputes = disputes.filter(d => d.status !== 'resolved')
  }

  // Auto-open dispute modal if invoice_id is in URL params
  useEffect(() => {
    const invoiceId = searchParams.get('invoice_id')
    if (invoiceId && disputes.length > 0 && !selectedDispute) {
      const invoiceDisputes = disputes.filter(d => d.invoice_id === parseInt(invoiceId))
      if (invoiceDisputes.length > 0) {
        setSelectedDispute(invoiceDisputes[0])
        // Remove the invoice_id param from URL after opening modal
        setSearchParams({})
      }
    }
  }, [disputes, searchParams, selectedDispute, setSearchParams])

  if (isLoading) {
    return <div style={styles.loading}>Loading disputes...</div>
  }

  if (error) {
    return <div style={styles.error}>Error loading disputes: {error.message}</div>
  }

  const suppliers = suppliersData?.suppliers || []

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>Invoice Disputes</h2>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={styles.filterSelect}
        >
          <option value="not_resolved">Not Resolved (Default)</option>
          <option value="">All Statuses</option>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="awaiting_credit">Awaiting Credit</option>
          <option value="awaiting_replacement">Awaiting Replacement</option>
          <option value="resolved">Resolved</option>
        </select>

        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          style={styles.filterSelect}
        >
          <option value="">All Priorities</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>

        <select
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          style={styles.filterSelect}
        >
          <option value="">All Suppliers</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>

        {(statusFilter !== 'not_resolved' || priorityFilter || supplierFilter) && (
          <button
            onClick={() => {
              setStatusFilter('not_resolved')
              setPriorityFilter('')
              setSupplierFilter('')
            }}
            style={styles.clearBtn}
          >
            Reset Filters
          </button>
        )}
      </div>

      {disputes.length === 0 ? (
        <div style={styles.empty}>
          <p>No disputes found.</p>
          {(statusFilter !== 'not_resolved' || priorityFilter || supplierFilter) ? (
            <button
              onClick={() => {
                setStatusFilter('not_resolved')
                setPriorityFilter('')
                setSupplierFilter('')
              }}
              style={styles.link}
            >
              Reset filters
            </button>
          ) : (
            <p style={styles.noDataSubtext}>
              No open disputes. Great job!
            </p>
          )}
        </div>
      ) : (
        <div style={styles.list}>
          {disputes.map((dispute) => (
            <div
              key={dispute.id}
              onClick={() => setSelectedDispute(dispute)}
              style={styles.card}
            >
              <div style={styles.cardMain}>
                <div style={styles.disputeTitleRow}>
                  {dispute.supplier_name || 'Unknown'} - Invoice #{dispute.invoice_number || dispute.invoice_id}
                  <span style={styles.disputeType}>{dispute.dispute_type.replace(/_/g, ' ').toUpperCase()}</span>
                </div>
                <div style={styles.disputeDateRow}>
                  Opened {new Date(dispute.opened_at).toLocaleDateString()} • Last updated {new Date(dispute.updated_at).toLocaleDateString()}
                </div>
                <div style={styles.disputeTitle}>
                  {dispute.title}
                </div>
                {dispute.description && (
                  <div style={styles.description}>
                    {dispute.description.length > 120
                      ? `${dispute.description.substring(0, 120)}...`
                      : dispute.description}
                  </div>
                )}
              </div>

              <div style={styles.cardRight}>
                <div
                  style={{
                    ...styles.status,
                    background: statusColors[dispute.status.toLowerCase()] || '#999',
                  }}
                >
                  {dispute.status.replace(/_/g, ' ')}
                </div>
                {dispute.difference_amount != null && (
                  <div style={styles.amount}>
                    £{Number(Math.abs(dispute.difference_amount)).toFixed(2)}
                  </div>
                )}
                <span
                  style={{
                    ...styles.priorityBadge,
                    background: priorityColors[dispute.priority] || '#999',
                  }}
                >
                  {dispute.priority}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dispute Detail Modal */}
      {selectedDispute && (
        <DisputeDetailModal
          disputeId={selectedDispute.id}
          onClose={() => setSelectedDispute(null)}
          onUpdate={() => {
            // Refetch disputes list after update
          }}
        />
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
  filters: {
    display: 'flex',
    gap: '1rem',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
  },
  filterSelect: {
    padding: '0.5rem 1rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
    minWidth: '150px',
  },
  clearBtn: {
    padding: '0.5rem 1rem',
    borderRadius: '8px',
    border: 'none',
    background: '#666',
    color: 'white',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  empty: {
    padding: '3rem',
    textAlign: 'center',
    color: '#666',
    background: 'white',
    borderRadius: '12px',
  },
  noDataSubtext: {
    marginTop: '0.5rem',
    color: '#999',
    fontSize: '0.9rem',
  },
  link: {
    display: 'inline-block',
    marginTop: '1rem',
    padding: '0.75rem 1.5rem',
    background: 'transparent',
    color: '#e94560',
    border: '2px solid #e94560',
    borderRadius: '8px',
    textDecoration: 'none',
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  card: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '1.5rem',
    background: 'white',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    cursor: 'pointer',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'box-shadow 0.2s',
  },
  cardMain: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  cardRight: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.5rem',
  },
  disputeTitleRow: {
    fontSize: '1.1rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  disputeType: {
    fontSize: '0.65rem',
    fontWeight: 'bold',
    color: '#666',
    letterSpacing: '0.5px',
  },
  disputeDateRow: {
    fontSize: '0.75rem',
    color: '#999',
    marginBottom: '0.25rem',
  },
  disputeTitle: {
    fontSize: '1rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  priorityBadge: {
    padding: '0.25rem 0.75rem',
    borderRadius: '12px',
    fontSize: '0.75rem',
    fontWeight: 'bold',
    color: 'white',
    textTransform: 'uppercase',
    flexShrink: 0,
  },
  description: {
    color: '#666',
    fontSize: '0.9rem',
  },
  amount: {
    fontSize: '1.25rem',
    fontWeight: 'bold',
    color: '#e94560',
  },
  status: {
    padding: '0.5rem 1rem',
    borderRadius: '12px',
    fontSize: '0.75rem',
    fontWeight: 'bold',
    color: 'white',
    textTransform: 'uppercase',
    textAlign: 'center',
    minWidth: '120px',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    maxWidth: '800px',
    width: '90%',
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.5rem',
    borderBottom: '1px solid #eee',
  },
  modalTitle: {
    margin: 0,
    color: '#1a1a2e',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    color: '#666',
    padding: '0.25rem',
    lineHeight: 1,
  },
  modalBody: {
    padding: '1.5rem',
  },
  modalNote: {
    marginTop: '2rem',
    padding: '1rem',
    background: '#f0f0f0',
    borderRadius: '8px',
    color: '#666',
    fontStyle: 'italic',
  },
}
