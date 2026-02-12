import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'
import PurchaseOrderModal from './PurchaseOrderModal'

interface PurchaseOrderSummary {
  id: number
  supplier_id: number
  supplier_name: string | null
  order_date: string
  order_type: string
  status: string
  total_amount: number | null
  order_reference: string | null
  created_by_name: string | null
  created_at: string
}

const statusColors: Record<string, { bg: string; color: string }> = {
  DRAFT: { bg: '#e0e0e0', color: '#555' },
  PENDING: { bg: '#e3f2fd', color: '#1565c0' },
  LINKED: { bg: '#d4edda', color: '#155724' },
  CLOSED: { bg: '#f5f5f5', color: '#666' },
  CANCELLED: { bg: '#ffebee', color: '#c62828' },
}

export default function PurchaseOrderList() {
  const { token } = useAuth()
  const [statusFilter, setStatusFilter] = useState('DRAFT,PENDING')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [editPoId, setEditPoId] = useState<number | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)

  // Fetch suppliers for filter
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

  // Build query string
  const params = new URLSearchParams()
  if (statusFilter) params.append('status', statusFilter)
  if (supplierFilter) params.append('supplier_id', supplierFilter)

  const { data: poList, refetch } = useQuery<PurchaseOrderSummary[]>({
    queryKey: ['purchase-orders', statusFilter, supplierFilter],
    queryFn: async () => {
      const res = await fetch(`/api/purchase-orders/?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch purchase orders')
      return res.json()
    },
    enabled: !!token,
  })

  const formatDate = (d: string) => {
    const dt = new Date(d + 'T00:00:00')
    return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  }

  return (
    <div>
      <div style={styles.headerRow}>
        <h2 style={styles.pageTitle}>Purchase Orders</h2>
        <button style={styles.newBtn} onClick={() => setShowNewModal(true)}>+ New PO</button>
      </div>

      {/* Filter bar */}
      <div style={styles.filterBar}>
        <div style={styles.statusTabs}>
          {[
            { label: 'Open', value: 'DRAFT,PENDING' },
            { label: 'All', value: '' },
            { label: 'Draft', value: 'DRAFT' },
            { label: 'Pending', value: 'PENDING' },
            { label: 'Linked', value: 'LINKED' },
            { label: 'Closed', value: 'CLOSED' },
          ].map(tab => (
            <button
              key={tab.value}
              style={{
                ...styles.filterTab,
                ...(statusFilter === tab.value ? styles.filterTabActive : {}),
              }}
              onClick={() => setStatusFilter(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <select
          value={supplierFilter}
          onChange={e => setSupplierFilter(e.target.value)}
          style={styles.filterSelect}
        >
          <option value="">All Suppliers</option>
          {suppliersData?.suppliers?.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div style={styles.tableContainer}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Reference</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Total</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {(!poList || poList.length === 0) ? (
              <tr>
                <td colSpan={7} style={styles.emptyTd}>No purchase orders found</td>
              </tr>
            ) : (
              poList.map(po => {
                const sc = statusColors[po.status] || statusColors.DRAFT
                return (
                  <tr
                    key={po.id}
                    style={styles.row}
                    onClick={() => setEditPoId(po.id)}
                  >
                    <td style={styles.td}>{formatDate(po.order_date)}</td>
                    <td style={styles.td}>{po.supplier_name || '-'}</td>
                    <td style={styles.td}>
                      <span style={styles.typeBadge}>
                        {po.order_type === 'itemised' ? 'Itemised' : 'Single Value'}
                      </span>
                    </td>
                    <td style={styles.td}>{po.order_reference || '-'}</td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 500 }}>
                      {po.total_amount != null ? `\u00A3${po.total_amount.toFixed(2)}` : '-'}
                    </td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.statusBadge,
                        background: sc.bg,
                        color: sc.color,
                      }}>
                        {po.status}
                      </span>
                    </td>
                    <td style={{ ...styles.td, fontSize: '0.8rem', color: '#888' }}>
                      {po.created_by_name || ''}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modals */}
      <PurchaseOrderModal
        isOpen={!!editPoId}
        onClose={() => setEditPoId(null)}
        onSaved={() => refetch()}
        poId={editPoId}
      />
      <PurchaseOrderModal
        isOpen={showNewModal}
        onClose={() => setShowNewModal(false)}
        onSaved={() => refetch()}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
  },
  pageTitle: {
    margin: 0,
    color: '#1a1a2e',
  },
  newBtn: {
    padding: '0.6rem 1.2rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.9rem',
  },
  filterBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
    gap: '1rem',
    flexWrap: 'wrap',
  },
  statusTabs: {
    display: 'flex',
    gap: '0.25rem',
  },
  filterTab: {
    padding: '0.4rem 0.75rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    background: 'white',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  filterTabActive: {
    background: '#1a1a2e',
    color: 'white',
    borderColor: '#1a1a2e',
  },
  filterSelect: {
    padding: '0.4rem 0.75rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '0.85rem',
  },
  tableContainer: {
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
    overflow: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '0.75rem 1rem',
    borderBottom: '2px solid #eee',
    fontWeight: 600,
    color: '#666',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '0.75rem 1rem',
    borderBottom: '1px solid #f0f0f0',
    fontSize: '0.9rem',
  },
  emptyTd: {
    padding: '2rem',
    textAlign: 'center',
    color: '#999',
  },
  row: {
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  statusBadge: {
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: '12px',
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  typeBadge: {
    fontSize: '0.8rem',
    color: '#666',
  },
}
