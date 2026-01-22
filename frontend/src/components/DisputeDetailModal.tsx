import { useState } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface DisputeLineItem {
  id: number
  product_name: string
  product_code: string | null
  quantity_ordered: number | null
  quantity_received: number | null
  quantity_difference: number | null
  unit_price_quoted: number | null
  unit_price_charged: number | null
  price_difference: number | null
  total_charged: number
  total_expected: number | null
  notes: string | null
}

interface DisputeAttachment {
  id: number
  file_name: string
  file_type: string
  file_size_bytes: number
  attachment_type: string
  description: string | null
  uploaded_at: string
  uploaded_by_username: string | null
}

interface DisputeActivity {
  id: number
  activity_type: string
  description: string
  created_at: string
  created_by_username: string | null
}

interface DisputeDetail {
  id: number
  invoice_id: number
  invoice_number: string | null
  supplier_name: string
  dispute_type: string
  status: string
  priority: string
  title: string
  description: string
  disputed_amount: number
  expected_amount: number | null
  difference_amount: number
  supplier_contacted_at: string | null
  supplier_response: string | null
  supplier_contact_name: string | null
  resolved_amount: number | null
  opened_at: string
  opened_by: string
  resolved_at: string | null
  closed_at: string | null
  tags: string[] | null
  line_items: DisputeLineItem[]
  attachments: DisputeAttachment[]
  activity_log: DisputeActivity[]
}

interface DisputeDetailModalProps {
  disputeId: number
  onClose: () => void
  onUpdate?: () => void
}

const statusOptions = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'awaiting_credit', label: 'Awaiting Credit' },
  { value: 'awaiting_replacement', label: 'Awaiting Replacement' },
  { value: 'resolved', label: 'Resolved' },
]

const priorityOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

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

export default function DisputeDetailModal({ disputeId, onClose, onUpdate }: DisputeDetailModalProps) {
  const { token, user } = useAuth()
  const queryClient = useQueryClient()

  const [note, setNote] = useState<string>('')
  const [showUploadAttachment, setShowUploadAttachment] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  const [editedDescription, setEditedDescription] = useState('')

  const { data: dispute, isLoading, error } = useQuery<DisputeDetail>({
    queryKey: ['dispute', disputeId],
    queryFn: async () => {
      const res = await fetch(`/api/disputes/${disputeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch dispute')
      return res.json()
    },
    enabled: !!token,
  })

  const updateMutation = useMutation({
    mutationFn: async (data: { status?: string; priority?: string; supplier_response?: string; supplier_contact_name?: string; title?: string; description?: string }) => {
      const res = await fetch(`/api/disputes/${disputeId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to update dispute')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dispute', disputeId] })
      queryClient.invalidateQueries({ queryKey: ['disputes'] })
      queryClient.invalidateQueries({ queryKey: ['dispute-stats'] })
      if (onUpdate) onUpdate()
      setNote('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/disputes/${disputeId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to delete dispute')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['disputes'] })
      queryClient.invalidateQueries({ queryKey: ['dispute-stats'] })
      if (onUpdate) onUpdate()
      onClose()
    },
  })

  const handleStatusChange = (status: string) => {
    updateMutation.mutate({ status: status.toUpperCase() })
  }

  const handlePriorityChange = (priority: string) => {
    updateMutation.mutate({ priority: priority.toLowerCase() })
  }

  const handleAddNote = () => {
    if (!note.trim()) {
      alert('Please enter a note')
      return
    }
    updateMutation.mutate({
      supplier_response: note.trim(),
    })
  }

  const handleDelete = () => {
    if (!confirm(`Are you sure you want to permanently delete this dispute?\n\nDispute: ${dispute?.title}\nInvoice #${dispute?.invoice_number}\n\nThis action cannot be undone.`)) {
      return
    }
    deleteMutation.mutate()
  }

  const handleEdit = () => {
    if (dispute) {
      setEditedTitle(dispute.title)
      setEditedDescription(dispute.description || '')
      setIsEditing(true)
    }
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditedTitle('')
    setEditedDescription('')
  }

  const handleSaveEdit = () => {
    if (!editedTitle.trim()) {
      alert('Title cannot be empty')
      return
    }

    updateMutation.mutate({
      title: editedTitle.trim(),
      description: editedDescription.trim() || undefined
    } as any)
    setIsEditing(false)
  }

  if (isLoading) {
    return (
      <div style={styles.modalOverlay} onClick={onClose}>
        <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div style={styles.loading}>Loading dispute details...</div>
        </div>
      </div>
    )
  }

  if (error || !dispute) {
    return (
      <div style={styles.modalOverlay} onClick={onClose}>
        <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div style={styles.error}>Error loading dispute: {error?.message || 'Unknown error'}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.modalSubtitle}>
              {dispute.supplier_name} - <a
                href={`/invoice/${dispute.invoice_id}`}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.invoiceLink}
              >
                Invoice #{dispute.invoice_number || dispute.invoice_id}
              </a> - <span style={styles.disputeTypeHeader}>{dispute.dispute_type.replace(/_/g, ' ').toUpperCase()}</span>
            </div>
            {isEditing ? (
              <input
                type="text"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                style={{ ...styles.modalTitle, border: '2px solid #e94560', padding: '0.5rem' }}
                maxLength={200}
              />
            ) : (
              <h2 style={styles.modalTitle}>{dispute.title}</h2>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {isEditing ? (
              <>
                <button
                  onClick={handleSaveEdit}
                  disabled={updateMutation.isPending}
                  style={{ ...styles.deleteBtn, background: '#5cb85c' }}
                  type="button"
                >
                  {updateMutation.isPending ? 'Saving...' : '✓ Save'}
                </button>
                <button
                  onClick={handleCancelEdit}
                  disabled={updateMutation.isPending}
                  style={styles.deleteBtn}
                  type="button"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleEdit}
                  style={{ ...styles.deleteBtn, background: '#5bc0de' }}
                  type="button"
                  title="Edit title and description"
                >
                  ✏️ Edit
                </button>
                {user?.is_admin && (
                  <button
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    style={styles.deleteBtn}
                    type="button"
                    title="Delete dispute (Admin only)"
                  >
                    {deleteMutation.isPending ? '...' : '🗑️ Delete'}
                  </button>
                )}
              </>
            )}
            <button style={styles.closeBtn} onClick={onClose} type="button">
              ✕
            </button>
          </div>
        </div>

        <div style={styles.modalBody}>
          {/* Status and Priority */}
          <div style={styles.section}>
            <div style={styles.actionGroup}>
              <div style={styles.buttonRow}>
                {statusOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleStatusChange(opt.value)}
                    disabled={updateMutation.isPending || dispute.status.toLowerCase() === opt.value}
                    style={{
                      ...styles.statusButton,
                      ...(dispute.status.toLowerCase() === opt.value ? {
                        background: statusColors[opt.value] || '#999',
                        color: 'white',
                        fontWeight: 'bold',
                      } : {}),
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={styles.actionGroup}>
              <div style={styles.buttonRow}>
                {priorityOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handlePriorityChange(opt.value)}
                    disabled={updateMutation.isPending || dispute.priority.toLowerCase() === opt.value}
                    style={{
                      ...styles.statusButton,
                      ...(dispute.priority.toLowerCase() === opt.value ? {
                        background: priorityColors[opt.value] || '#999',
                        color: 'white',
                        fontWeight: 'bold',
                      } : {}),
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

          </div>

          {/* Financial Summary */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Financial Impact</h3>
            <div style={styles.financialGrid}>
              <div style={styles.financialCard}>
                <div style={styles.financialLabel}>Disputed Amount</div>
                <div style={styles.financialValue}>£{Number(dispute.disputed_amount).toFixed(2)}</div>
              </div>
              {dispute.expected_amount != null && (
                <div style={styles.financialCard}>
                  <div style={styles.financialLabel}>Expected Amount</div>
                  <div style={styles.financialValue}>£{Number(dispute.expected_amount).toFixed(2)}</div>
                </div>
              )}
              <div style={styles.financialCard}>
                <div style={styles.financialLabel}>Difference</div>
                <div style={{ ...styles.financialValue, color: '#e94560' }}>
                  £{Number(Math.abs(dispute.difference_amount)).toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* Description */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Description</h3>
            {isEditing ? (
              <textarea
                value={editedDescription}
                onChange={(e) => setEditedDescription(e.target.value)}
                style={{ ...styles.textarea, width: '100%', minHeight: '100px' }}
                placeholder="Detailed description of the dispute (optional)..."
              />
            ) : (
              <p style={styles.description}>{dispute.description || 'No description provided'}</p>
            )}
          </div>

          {/* Line Items */}
          {dispute.line_items.length > 0 && (
            <div style={styles.section}>
              <h3 style={styles.sectionTitle}>Disputed Line Items ({dispute.line_items.length})</h3>
              <div style={styles.tableContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Product</th>
                      <th style={styles.th}>Qty</th>
                      <th style={styles.th}>Unit Price</th>
                      <th style={styles.th}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dispute.line_items.map((item) => (
                      <tr key={item.id}>
                        <td style={styles.td}>
                          <div>{item.product_name}</div>
                          {item.product_code && (
                            <div style={styles.productCode}>{item.product_code}</div>
                          )}
                        </td>
                        <td style={styles.td}>
                          {item.quantity_ordered != null ? Number(item.quantity_ordered).toFixed(2) : '-'}
                        </td>
                        <td style={styles.td}>
                          {item.unit_price_charged != null ? `£${Number(item.unit_price_charged).toFixed(2)}` : '-'}
                        </td>
                        <td style={styles.td}>£{Number(item.total_charged).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Attachments */}
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h3 style={styles.sectionTitle}>Attachments ({dispute.attachments.length})</h3>
              <button
                style={styles.secondaryBtn}
                onClick={() => setShowUploadAttachment(!showUploadAttachment)}
              >
                {showUploadAttachment ? 'Cancel' : '+ Upload'}
              </button>
            </div>
            {showUploadAttachment && (
              <div style={styles.uploadSection}>
                <p style={styles.metadata}>Attachment upload coming soon...</p>
              </div>
            )}
            {dispute.attachments.length === 0 ? (
              <p style={styles.empty}>No attachments yet</p>
            ) : (
              <div style={styles.attachmentList}>
                {dispute.attachments.map((att) => (
                  <div key={att.id} style={styles.attachmentItem}>
                    <span style={styles.attachmentName}>📎 {att.file_name}</span>
                    <span style={styles.attachmentMeta}>
                      {(att.file_size_bytes / 1024).toFixed(1)} KB -
                      {new Date(att.uploaded_at).toLocaleDateString()} by {att.uploaded_by_username || 'Unknown'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Activity & Notes */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Activity & Notes</h3>
            {dispute.activity_log.length === 0 ? (
              <p style={styles.empty}>No activity logged</p>
            ) : (
              <div style={styles.chatLog}>
                {dispute.activity_log.map((activity) => {
                  const isLogType = activity.activity_type === 'status_change' ||
                                    activity.activity_type === 'priority_change' ||
                                    activity.activity_type === 'created'

                  if (isLogType) {
                    // Single-line compact format for status/priority changes and created
                    return (
                      <div key={activity.id} style={styles.logItem}>
                        <span style={styles.logMessage}>{activity.description}</span>
                        <span style={styles.logMeta}>
                          {new Date(activity.created_at).toLocaleString()} - {activity.created_by_username || 'System'}
                        </span>
                      </div>
                    )
                  } else {
                    // Full chat-style format for notes
                    return (
                      <div key={activity.id} style={styles.chatItem}>
                        <div style={styles.chatMessage}>{activity.description}</div>
                        <div style={styles.chatFooter}>
                          <span style={styles.chatTime}>{new Date(activity.created_at).toLocaleString()}</span>
                          <span style={styles.chatUser}> - {activity.created_by_username || 'System'}</span>
                        </div>
                      </div>
                    )
                  }
                })}
              </div>
            )}

            {/* Add Note */}
            <div style={styles.addNoteSection}>
              <label style={styles.label}>Add Note</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                style={styles.textarea}
                placeholder="Add a note about this dispute..."
                rows={3}
              />
              <button
                style={styles.primaryBtn}
                onClick={handleAddNote}
                disabled={updateMutation.isPending || !note.trim()}
              >
                Add Note
              </button>
            </div>
          </div>

          {updateMutation.isError && (
            <div style={styles.errorBox}>
              Error: {updateMutation.error?.message || 'Failed to update dispute'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
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
    padding: '1rem',
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    maxWidth: '900px',
    width: '100%',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '1.5rem',
    borderBottom: '1px solid #eee',
    position: 'sticky',
    top: 0,
    background: 'white',
    zIndex: 1,
  },
  modalTitle: {
    margin: 0,
    marginTop: '0.5rem',
    color: '#1a1a2e',
    fontSize: '1.25rem',
  },
  modalSubtitle: {
    color: '#666',
    fontSize: '0.9rem',
  },
  invoiceLink: {
    color: '#e94560',
    textDecoration: 'none',
    fontWeight: 'bold',
  },
  disputeTypeHeader: {
    fontSize: '0.7rem',
    fontWeight: 'bold',
    color: '#666',
    letterSpacing: '0.5px',
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
  deleteBtn: {
    background: '#dc3545',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
    transition: 'background 0.2s',
  },
  modalBody: {
    padding: '1.5rem',
    flex: 1,
    overflow: 'auto',
  },
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
    margin: '1rem',
  },
  badgeRow: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  badge: {
    padding: '0.5rem 1rem',
    borderRadius: '12px',
    fontSize: '0.8rem',
    fontWeight: 'bold',
    color: 'white',
    textTransform: 'uppercase',
  },
  badgeLabel: {
    fontSize: '0.9rem',
    color: '#666',
  },
  section: {
    marginBottom: '2rem',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  sectionTitle: {
    margin: 0,
    marginBottom: '1rem',
    color: '#1a1a2e',
    fontSize: '1rem',
    fontWeight: 'bold',
  },
  financialGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '1rem',
  },
  financialCard: {
    display: 'flex',
    flexDirection: 'column',
    padding: '1.25rem',
    background: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  financialLabel: {
    fontSize: '0.75rem',
    color: '#666',
    marginBottom: '0.5rem',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: '0.5px',
  },
  financialValue: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  description: {
    margin: 0,
    color: '#333',
    lineHeight: 1.6,
  },
  tableContainer: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    textAlign: 'left',
    padding: '0.75rem',
    background: '#f5f5f5',
    fontWeight: 'bold',
    color: '#1a1a2e',
    borderBottom: '2px solid #ddd',
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
    color: '#333',
  },
  productCode: {
    fontSize: '0.8rem',
    color: '#999',
    marginTop: '0.25rem',
  },
  diff: {
    fontSize: '0.8rem',
    color: '#e94560',
    fontWeight: 'bold',
  },
  metadata: {
    margin: '0.5rem 0 0 0',
    fontSize: '0.85rem',
    color: '#666',
  },
  empty: {
    padding: '1rem',
    textAlign: 'center',
    color: '#999',
    fontStyle: 'italic',
  },
  attachmentList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  attachmentItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem',
    background: '#f9f9f9',
    borderRadius: '8px',
  },
  attachmentName: {
    color: '#1a1a2e',
    fontWeight: '500',
  },
  attachmentMeta: {
    fontSize: '0.8rem',
    color: '#666',
  },
  chatLog: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    marginBottom: '1.5rem',
    padding: '1rem',
    background: '#f5f5f5',
    borderRadius: '8px',
  },
  logItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
    fontSize: '0.8rem',
    color: '#999',
  },
  logMessage: {
    color: '#666',
    fontSize: '0.8rem',
  },
  logMeta: {
    fontSize: '0.7rem',
    color: '#999',
    whiteSpace: 'nowrap',
    marginLeft: '1rem',
  },
  chatItem: {
    padding: '1rem',
    background: 'white',
    borderRadius: '8px',
    border: '1px solid #e0e0e0',
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  chatMessage: {
    color: '#1a1a2e',
    fontSize: '1rem',
    lineHeight: 1.5,
    marginBottom: '0.5rem',
  },
  chatFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    fontSize: '0.75rem',
    color: '#999',
  },
  chatUser: {
    fontSize: '0.75rem',
    color: '#999',
  },
  chatTime: {
    fontSize: '0.75rem',
    color: '#999',
  },
  addNoteSection: {
    marginTop: '1.5rem',
    paddingTop: '1.5rem',
    borderTop: '1px solid #eee',
  },
  buttonRow: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  statusButton: {
    padding: '0.75rem 1.5rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    background: 'white',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: '500',
    transition: 'all 0.2s',
    color: '#333',
  },
  actionGroup: {
    marginBottom: '1.5rem',
  },
  label: {
    display: 'block',
    marginBottom: '0.5rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
    fontSize: '0.9rem',
  },
  actionRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
  },
  select: {
    flex: 1,
    padding: '0.75rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
    boxSizing: 'border-box',
    marginBottom: '0.75rem',
  },
  textarea: {
    width: '100%',
    padding: '0.75rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
    resize: 'vertical',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    marginBottom: '0.75rem',
  },
  primaryBtn: {
    padding: '0.75rem 1.5rem',
    borderRadius: '8px',
    border: 'none',
    background: '#e94560',
    color: 'white',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
    whiteSpace: 'nowrap',
  },
  secondaryBtn: {
    padding: '0.5rem 1rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    background: 'white',
    color: '#666',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.9rem',
  },
  errorBox: {
    marginTop: '1rem',
    padding: '0.75rem',
    background: '#fee',
    color: '#c00',
    borderRadius: '8px',
    fontSize: '0.9rem',
  },
  uploadSection: {
    padding: '1rem',
    background: '#f9f9f9',
    borderRadius: '8px',
    marginBottom: '1rem',
  },
}
