import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'

interface EventOrderItem {
  id: number
  name: string
  event_date: string | null
  notes: string | null
  status: string
  item_count: number
  estimated_cost: number | null
  created_at: string
  updated_at: string
}

export default function EventOrders() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [showCreate, setShowCreate] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDate, setFormDate] = useState('')
  const [formNotes, setFormNotes] = useState('')

  const { data: orders, isLoading } = useQuery<EventOrderItem[]>({
    queryKey: ['event-orders'],
    queryFn: async () => {
      const res = await fetch('/api/event-orders', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token,
  })

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; event_date?: string; notes?: string }) => {
      const res = await fetch('/api/event-orders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create')
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['event-orders'] })
      setShowCreate(false)
      navigate(`/event-orders/${data.id}`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/event-orders/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['event-orders'] }),
  })

  const statusColors: Record<string, string> = {
    DRAFT: '#f59e0b',
    FINALISED: '#3b82f6',
    ORDERED: '#22c55e',
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>Event Orders</h2>
        <button onClick={() => { setShowCreate(true); setFormName(''); setFormDate(''); setFormNotes('') }} style={styles.primaryBtn}>
          + New Event Order
        </button>
      </div>

      {isLoading ? (
        <div style={styles.loading}>Loading...</div>
      ) : orders && orders.length > 0 ? (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Recipes</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.id} style={styles.tr} onClick={() => navigate(`/event-orders/${o.id}`)} >
                <td style={{ ...styles.td, fontWeight: 500, cursor: 'pointer' }}>{o.name}</td>
                <td style={styles.td}>{o.event_date || '-'}</td>
                <td style={styles.td}>
                  <span style={{
                    background: statusColors[o.status] || '#ccc',
                    color: 'white',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}>
                    {o.status}
                  </span>
                </td>
                <td style={styles.td}>{o.item_count}</td>
                <td style={styles.td}>
                  {o.status === 'DRAFT' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(o.id) }}
                      style={{ ...styles.smallBtn, color: '#e94560' }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#888' }}>
          No event orders yet. Create one to start planning.
        </div>
      )}

      {showCreate && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>New Event Order</h3>
              <button onClick={() => setShowCreate(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Event Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} style={styles.input} placeholder="e.g. Wedding Reception 15th March" />
              <label style={styles.label}>Event Date</label>
              <input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} style={styles.input} />
              <label style={styles.label}>Notes</label>
              <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} style={{ ...styles.input, minHeight: '60px' }} />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => createMutation.mutate({
                  name: formName,
                  event_date: formDate || undefined,
                  notes: formNotes || undefined,
                })}
                disabled={!formName || createMutation.isPending}
                style={styles.primaryBtn}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1000px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const, background: 'white', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  th: { padding: '0.6rem 0.75rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.8rem', fontWeight: 600, color: '#555' },
  tr: { borderBottom: '1px solid #f0f0f0', cursor: 'pointer' },
  td: { padding: '0.6rem 0.75rem', fontSize: '0.85rem' },
  smallBtn: { padding: '0.25rem 0.5rem', border: '1px solid #ddd', borderRadius: '4px', background: 'white', cursor: 'pointer', fontSize: '0.75rem' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  loading: { padding: '3rem', textAlign: 'center' as const, color: '#888' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '450px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  modalBody: { padding: '1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.25rem', borderTop: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#555', marginTop: '0.75rem', marginBottom: '0.25rem' },
  input: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' as const },
}
