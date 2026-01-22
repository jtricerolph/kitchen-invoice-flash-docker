import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface LineItem {
  id: number
  product_code: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  amount: number | null
}

interface CreateDisputeModalProps {
  invoiceId: number
  invoiceNumber: string | null
  supplierId: number | null
  supplierName: string | null
  lineItems?: LineItem[]
  onClose: () => void
  onSuccess?: () => void
}

interface DisputeLineItemInput {
  invoice_line_item_id?: number
  product_name: string
  product_code?: string
  quantity_ordered?: number
  quantity_received?: number
  unit_price_quoted?: number
  unit_price_charged?: number
  total_charged: number
  total_expected?: number
  notes?: string
}

interface CreateDisputeRequest {
  invoice_id: number
  dispute_type: string
  priority: string
  title: string
  description?: string
  disputed_amount: number
  expected_amount?: number
  line_items?: DisputeLineItemInput[]
  tags?: string[]
}

export default function CreateDisputeModal({
  invoiceId,
  invoiceNumber,
  supplierId,
  supplierName,
  lineItems = [],
  onClose,
  onSuccess,
}: CreateDisputeModalProps) {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  const [disputeType, setDisputeType] = useState<string>('price_discrepancy')
  const [priority, setPriority] = useState<string>('medium')
  const [title, setTitle] = useState<string>('')
  const [description, setDescription] = useState<string>('')
  const [disputedAmount, setDisputedAmount] = useState<string>('')
  const [expectedAmount, setExpectedAmount] = useState<string>('')
  const [selectedLineItems, setSelectedLineItems] = useState<Set<number>>(new Set())
  const [lineItemSearch, setLineItemSearch] = useState<string>('')

  const createMutation = useMutation({
    mutationFn: async (data: CreateDisputeRequest) => {
      const res = await fetch('/api/disputes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to create dispute')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['disputes'] })
      queryClient.invalidateQueries({ queryKey: ['dispute-stats'] })
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] })
      if (onSuccess) onSuccess()
      onClose()
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!title.trim()) {
      alert('Please enter a dispute title')
      return
    }

    if (!disputedAmount) {
      alert('Please enter a disputed amount')
      return
    }

    const data: CreateDisputeRequest = {
      invoice_id: invoiceId,
      dispute_type: disputeType,
      priority,
      title: title.trim(),
      disputed_amount: parseFloat(disputedAmount),
    }

    if (description.trim()) data.description = description.trim()
    if (expectedAmount) data.expected_amount = parseFloat(expectedAmount)

    // Convert selected line items to DisputeLineItemInput format
    if (selectedLineItems.size > 0) {
      data.line_items = Array.from(selectedLineItems)
        .map(itemId => {
          const item = lineItems.find(li => li.id === itemId)
          if (!item) return null

          return {
            invoice_line_item_id: item.id,
            product_name: item.description || item.product_code || 'Unnamed item',
            product_code: item.product_code || undefined,
            quantity_ordered: item.quantity || undefined,
            unit_price_charged: item.unit_price || undefined,
            total_charged: item.amount || 0,
          }
        })
        .filter((item): item is DisputeLineItemInput => item !== null)
    }

    createMutation.mutate(data)
  }

  const toggleLineItem = (lineItemId: number) => {
    const newSet = new Set(selectedLineItems)
    if (newSet.has(lineItemId)) {
      newSet.delete(lineItemId)
    } else {
      newSet.add(lineItemId)
    }
    setSelectedLineItems(newSet)

    // Auto-calculate disputed amount from selected items
    const selectedItems = lineItems.filter(item => newSet.has(item.id))
    const total = selectedItems.reduce((sum, item) => sum + (item.amount || 0), 0)
    if (total > 0) {
      setDisputedAmount(total.toFixed(2))
    } else if (newSet.size === 0) {
      // Clear disputed amount if no items selected
      setDisputedAmount('')
    }
  }

  // Filter line items based on search
  const filteredLineItems = lineItems.filter(item => {
    if (!lineItemSearch) return true
    const searchLower = lineItemSearch.toLowerCase()
    const description = (item.description || '').toLowerCase()
    const productCode = (item.product_code || '').toLowerCase()
    return description.includes(searchLower) || productCode.includes(searchLower)
  })

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>Create Dispute</h2>
          <button style={styles.closeBtn} onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Invoice</label>
              <div style={styles.staticValue}>
                #{invoiceNumber || invoiceId}
                {supplierName && <span style={styles.supplier}> - {supplierName}</span>}
              </div>
            </div>
          </div>

          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Dispute Type *</label>
              <select
                value={disputeType}
                onChange={(e) => setDisputeType(e.target.value)}
                style={styles.select}
                required
              >
                <option value="price_discrepancy">Price Discrepancy</option>
                <option value="short_delivery">Short Delivery</option>
                <option value="wrong_product">Wrong Product</option>
                <option value="quality_issue">Quality Issue</option>
                <option value="calculation_error">Calculation Error</option>
                <option value="missing_items">Missing Items</option>
                <option value="damaged_goods">Damaged Goods</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Priority *</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                style={styles.select}
                required
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={styles.input}
              placeholder="Brief summary of the issue"
              required
              maxLength={200}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={styles.textarea}
              placeholder="Detailed description of the dispute (optional)..."
              rows={4}
            />
          </div>

          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Disputed Amount (£) *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={disputedAmount}
                onChange={(e) => setDisputedAmount(e.target.value)}
                style={styles.input}
                placeholder="0.00"
                required
              />
              <div style={styles.fieldHint}>Auto-fills when you select line items</div>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Expected Amount (£)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={expectedAmount}
                onChange={(e) => setExpectedAmount(e.target.value)}
                style={styles.input}
                placeholder="0.00"
              />
            </div>
          </div>

          {lineItems.length > 0 && (
            <div style={styles.formGroup}>
              <label style={styles.label}>Disputed Line Items (optional)</label>
              <input
                type="text"
                value={lineItemSearch}
                onChange={(e) => setLineItemSearch(e.target.value)}
                style={styles.input}
                placeholder="Search line items by description or code..."
              />
              <div style={styles.lineItemsContainer}>
                {filteredLineItems.length === 0 ? (
                  <div style={styles.noResults}>No items match your search</div>
                ) : (
                  filteredLineItems.map((item) => (
                    <label key={item.id} style={styles.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={selectedLineItems.has(item.id)}
                        onChange={() => toggleLineItem(item.id)}
                        style={styles.checkbox}
                      />
                      <span style={styles.lineItemText}>
                        {item.description || item.product_code || 'Unnamed item'}
                        {item.amount != null && (
                          <span style={styles.lineItemAmount}> - £{Number(item.amount).toFixed(2)}</span>
                        )}
                      </span>
                    </label>
                  ))
                )}
              </div>
              {selectedLineItems.size > 0 && (
                <div style={styles.selectedSummary}>
                  {selectedLineItems.size} item(s) selected
                </div>
              )}
            </div>
          )}

          <div style={styles.footer}>
            <button
              type="button"
              onClick={onClose}
              style={styles.cancelBtn}
              disabled={createMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={styles.submitBtn}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create Dispute'}
            </button>
          </div>

          {createMutation.isError && (
            <div style={styles.error}>
              Error: {createMutation.error?.message || 'Failed to create dispute'}
            </div>
          )}
        </form>
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
    maxWidth: '700px',
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
  form: {
    padding: '1.5rem',
    flex: 1,
    overflow: 'auto',
  },
  formRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
    marginBottom: '1rem',
  },
  formGroup: {
    marginBottom: '1rem',
  },
  label: {
    display: 'block',
    marginBottom: '0.5rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
    fontSize: '0.9rem',
  },
  staticValue: {
    padding: '0.75rem',
    background: '#f5f5f5',
    borderRadius: '8px',
    color: '#666',
  },
  supplier: {
    color: '#999',
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
  select: {
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
  lineItemsContainer: {
    maxHeight: '200px',
    overflow: 'auto',
    border: '1px solid #eee',
    borderRadius: '8px',
    padding: '0.5rem',
    marginTop: '0.5rem',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    padding: '0.5rem',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  checkbox: {
    marginRight: '0.75rem',
    cursor: 'pointer',
  },
  lineItemText: {
    fontSize: '0.9rem',
    color: '#333',
  },
  lineItemAmount: {
    color: '#666',
    fontWeight: 'bold',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '1rem',
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid #eee',
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
    background: '#e94560',
    color: 'white',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
  },
  error: {
    marginTop: '1rem',
    padding: '0.75rem',
    background: '#fee',
    color: '#c00',
    borderRadius: '8px',
    fontSize: '0.9rem',
  },
  noResults: {
    padding: '1rem',
    textAlign: 'center',
    color: '#999',
    fontStyle: 'italic',
  },
  selectedSummary: {
    marginTop: '0.5rem',
    padding: '0.5rem',
    background: '#e8f4f8',
    borderRadius: '4px',
    fontSize: '0.85rem',
    color: '#1565c0',
    fontWeight: 'bold',
  },
  fieldHint: {
    fontSize: '0.75rem',
    color: '#999',
    marginTop: '0.25rem',
    fontStyle: 'italic',
  },
}
