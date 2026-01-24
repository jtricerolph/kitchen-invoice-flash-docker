import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface OpenDispute {
  id: number
  title: string
  dispute_type: string
  status: string
  disputed_amount: number
  opened_at: string
  invoice_number: string | null
}

interface LinkDisputeModalProps {
  supplierId: number
  supplierName: string | null
  creditNoteInvoiceId: number
  creditNoteNumber: string | null
  creditNoteAmount: number | null
  onClose: () => void
  onSuccess?: () => void
}

const disputeTypeLabels: Record<string, string> = {
  price_discrepancy: 'Price Discrepancy',
  short_delivery: 'Short Delivery',
  wrong_product: 'Wrong Product',
  quality_issue: 'Quality Issue',
  calculation_error: 'Calculation Error',
  missing_items: 'Missing Items',
  damaged_goods: 'Damaged Goods',
  other: 'Other',
}

const statusColors: Record<string, string> = {
  NEW: '#17a2b8',
  OPEN: '#17a2b8',
  CONTACTED: '#6c757d',
  IN_PROGRESS: '#ffc107',
  AWAITING_CREDIT: '#fd7e14',
  AWAITING_REPLACEMENT: '#fd7e14',
  ESCALATED: '#dc3545',
}

export default function LinkDisputeModal({
  supplierId,
  supplierName,
  creditNoteInvoiceId,
  creditNoteNumber,
  creditNoteAmount,
  onClose,
  onSuccess,
}: LinkDisputeModalProps) {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const [selectedDisputeId, setSelectedDisputeId] = useState<number | null>(null)
  const [resolvedAmount, setResolvedAmount] = useState<string>(
    creditNoteAmount ? Math.abs(creditNoteAmount).toFixed(2) : ''
  )
  const [resolutionNotes, setResolutionNotes] = useState<string>('')

  // Fetch open disputes for this supplier
  const { data: disputes, isLoading } = useQuery<OpenDispute[]>({
    queryKey: ['open-disputes', supplierId],
    queryFn: async () => {
      const res = await fetch(`/api/disputes/supplier/${supplierId}/open`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch disputes')
      return res.json()
    },
    enabled: !!supplierId,
  })

  // Link mutation
  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDisputeId) throw new Error('No dispute selected')

      const res = await fetch(`/api/disputes/${selectedDisputeId}/link-credit-note`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          credit_note_invoice_id: creditNoteInvoiceId,
          resolved_amount: resolvedAmount ? parseFloat(resolvedAmount) : undefined,
          resolution_notes: resolutionNotes || undefined,
        }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to link dispute')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['disputes'] })
      queryClient.invalidateQueries({ queryKey: ['dispute-stats'] })
      queryClient.invalidateQueries({ queryKey: ['open-disputes', supplierId] })
      queryClient.invalidateQueries({ queryKey: ['invoice', creditNoteInvoiceId] })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      if (onSuccess) onSuccess()
      onClose()
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedDisputeId) {
      alert('Please select a dispute to link')
      return
    }
    linkMutation.mutate()
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Link Credit Note to Dispute</h2>
          <button style={styles.closeBtn} onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div style={styles.content}>
          {/* Credit Note Info */}
          <div style={styles.infoBox}>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Credit Note:</span>
              <span style={styles.infoValue}>#{creditNoteNumber || creditNoteInvoiceId}</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Supplier:</span>
              <span style={styles.infoValue}>{supplierName || 'Unknown'}</span>
            </div>
            {creditNoteAmount && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Amount:</span>
                <span style={styles.infoValue}>£{Math.abs(creditNoteAmount).toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* Disputes List */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Select Open Dispute</h3>

            {isLoading ? (
              <div style={styles.loading}>Loading disputes...</div>
            ) : !disputes || disputes.length === 0 ? (
              <div style={styles.emptyState}>
                No open disputes found for this supplier.
              </div>
            ) : (
              <div style={styles.disputeList}>
                {disputes.map((dispute) => (
                  <label
                    key={dispute.id}
                    style={{
                      ...styles.disputeItem,
                      borderColor: selectedDisputeId === dispute.id ? '#e94560' : '#eee',
                      background: selectedDisputeId === dispute.id ? '#fff5f7' : 'white',
                    }}
                  >
                    <input
                      type="radio"
                      name="dispute"
                      value={dispute.id}
                      checked={selectedDisputeId === dispute.id}
                      onChange={() => setSelectedDisputeId(dispute.id)}
                      style={styles.radio}
                    />
                    <div style={styles.disputeContent}>
                      <div style={styles.disputeHeader}>
                        <span style={styles.disputeTitle}>{dispute.title}</span>
                        <span
                          style={{
                            ...styles.statusBadge,
                            background: statusColors[dispute.status] || '#6c757d',
                          }}
                        >
                          {dispute.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div style={styles.disputeMeta}>
                        <span style={styles.disputeType}>
                          {disputeTypeLabels[dispute.dispute_type] || dispute.dispute_type}
                        </span>
                        <span style={styles.disputeAmount}>
                          £{dispute.disputed_amount.toFixed(2)}
                        </span>
                        <span style={styles.disputeDate}>
                          Opened {formatDate(dispute.opened_at)}
                        </span>
                        {dispute.invoice_number && (
                          <span style={styles.invoiceRef}>
                            Invoice #{dispute.invoice_number}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Optional Fields */}
          {selectedDisputeId && (
            <div style={styles.section}>
              <div style={styles.formGroup}>
                <label style={styles.label}>Resolved Amount (£)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={resolvedAmount}
                  onChange={(e) => setResolvedAmount(e.target.value)}
                  style={styles.input}
                  placeholder="0.00"
                />
                <div style={styles.hint}>Leave as-is to use credit note amount</div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label}>Resolution Notes (optional)</label>
                <textarea
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  style={styles.textarea}
                  placeholder="Any additional notes about the resolution..."
                  rows={3}
                />
              </div>
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <button type="button" onClick={onClose} style={styles.cancelBtn}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{
              ...styles.submitBtn,
              opacity: !selectedDisputeId || linkMutation.isPending ? 0.5 : 1,
              cursor: !selectedDisputeId || linkMutation.isPending ? 'not-allowed' : 'pointer',
            }}
            disabled={!selectedDisputeId || linkMutation.isPending}
          >
            {linkMutation.isPending ? 'Linking...' : 'Link & Resolve Dispute'}
          </button>
        </div>

        {linkMutation.isError && (
          <div style={styles.error}>
            Error: {linkMutation.error?.message || 'Failed to link dispute'}
          </div>
        )}
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
    maxWidth: '600px',
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
    alignItems: 'center',
    padding: '1.5rem',
    borderBottom: '1px solid #eee',
    flexShrink: 0,
  },
  modalTitle: {
    margin: 0,
    color: '#1a1a2e',
    fontSize: '1.25rem',
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
  content: {
    padding: '1.5rem',
    flex: 1,
    overflow: 'auto',
  },
  infoBox: {
    background: '#f8f9fa',
    padding: '1rem',
    borderRadius: '8px',
    marginBottom: '1.5rem',
    border: '1px solid #e9ecef',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '0.5rem',
  },
  infoLabel: {
    color: '#666',
    fontWeight: '500',
  },
  infoValue: {
    fontWeight: '600',
    color: '#1a1a2e',
  },
  section: {
    marginBottom: '1.5rem',
  },
  sectionTitle: {
    fontSize: '1rem',
    fontWeight: '600',
    color: '#1a1a2e',
    marginBottom: '0.75rem',
  },
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  emptyState: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
    background: '#f8f9fa',
    borderRadius: '8px',
    fontStyle: 'italic',
  },
  disputeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    maxHeight: '250px',
    overflow: 'auto',
  },
  disputeItem: {
    display: 'flex',
    alignItems: 'flex-start',
    padding: '1rem',
    border: '2px solid #eee',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'border-color 0.2s, background 0.2s',
  },
  radio: {
    marginRight: '1rem',
    marginTop: '0.25rem',
    cursor: 'pointer',
  },
  disputeContent: {
    flex: 1,
  },
  disputeHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '0.5rem',
    gap: '0.5rem',
  },
  disputeTitle: {
    fontWeight: '600',
    color: '#1a1a2e',
    flex: 1,
  },
  statusBadge: {
    padding: '0.2rem 0.5rem',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: '600',
    color: 'white',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  disputeMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.75rem',
    fontSize: '0.85rem',
    color: '#666',
  },
  disputeType: {
    background: '#e9ecef',
    padding: '0.15rem 0.5rem',
    borderRadius: '4px',
  },
  disputeAmount: {
    fontWeight: '600',
    color: '#dc3545',
  },
  disputeDate: {
    color: '#999',
  },
  invoiceRef: {
    color: '#666',
  },
  formGroup: {
    marginBottom: '1rem',
  },
  label: {
    display: 'block',
    marginBottom: '0.5rem',
    fontWeight: '600',
    color: '#1a1a2e',
    fontSize: '0.9rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
    boxSizing: 'border-box',
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
  },
  hint: {
    fontSize: '0.75rem',
    color: '#999',
    marginTop: '0.25rem',
    fontStyle: 'italic',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '1rem',
    padding: '1rem 1.5rem',
    borderTop: '1px solid #eee',
    flexShrink: 0,
  },
  cancelBtn: {
    padding: '0.75rem 1.5rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    background: 'white',
    color: '#666',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
  },
  submitBtn: {
    padding: '0.75rem 1.5rem',
    borderRadius: '8px',
    border: 'none',
    background: '#28a745',
    color: 'white',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
  },
  error: {
    margin: '0 1.5rem 1rem',
    padding: '0.75rem',
    background: '#fee',
    color: '#c00',
    borderRadius: '8px',
    fontSize: '0.9rem',
  },
}
