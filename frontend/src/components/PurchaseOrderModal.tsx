import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../App'

interface LineItem {
  id?: number
  product_id?: number | null
  product_code?: string | null
  description: string
  unit?: string | null
  unit_price: number
  quantity: number
  total: number
  line_number: number
  source: string
}

interface Supplier {
  id: number
  name: string
  order_email?: string | null
}

interface SearchResult {
  id: number
  name: string
  product_code: string | null
  supplier_name: string | null
  unit: string | null
  last_price: number | null
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSaved: () => void
  poId?: number | null
  defaultSupplierId?: number | null
  defaultDate?: string | null
}

export default function PurchaseOrderModal({ isOpen, onClose, onSaved, poId, defaultSupplierId, defaultDate }: Props) {
  const { token } = useAuth()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState<number>(defaultSupplierId || 0)
  const [orderDate, setOrderDate] = useState(defaultDate || new Date().toISOString().slice(0, 10))
  const [orderType, setOrderType] = useState<'itemised' | 'single_value'>('itemised')
  const [status, setStatus] = useState('DRAFT')
  const [totalAmount, setTotalAmount] = useState<number | null>(null)
  const [orderReference, setOrderReference] = useState('')
  const [notes, setNotes] = useState('')
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [attachmentName, setAttachmentName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [saving, setSaving] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [emailMessage, setEmailMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [smtpConfigured, setSmtpConfigured] = useState(false)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Load suppliers (including order_email for email button visibility)
  useEffect(() => {
    if (!token) return
    fetch('/api/suppliers/', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setSuppliers(data.suppliers || data || []))
      .catch(() => {})
  }, [token])

  // Check if SMTP is configured (for email button visibility)
  useEffect(() => {
    if (!token) return
    fetch('/api/settings/', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setSmtpConfigured(!!(data.smtp_host && data.smtp_from_email)))
      .catch(() => setSmtpConfigured(false))
  }, [token])

  // Load PO if editing
  useEffect(() => {
    if (!poId || !token) return
    setLoading(true)
    fetch(`/api/purchase-orders/${poId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => {
        if (!r.ok) throw new Error('Failed to load')
        return r.json()
      })
      .then((po: any) => {
        setSupplierId(po.supplier_id)
        setOrderDate(po.order_date)
        setOrderType(po.order_type)
        setStatus(po.status)
        setTotalAmount(po.total_amount)
        setOrderReference(po.order_reference || '')
        setNotes(po.notes || '')
        setAttachmentName(po.attachment_original_name || null)
        setLineItems(
          (po.line_items || []).map((li: any, idx: number) => ({
            id: li.id,
            product_id: li.product_id,
            product_code: li.product_code,
            description: li.description,
            unit: li.unit,
            unit_price: li.unit_price,
            quantity: li.quantity,
            total: li.total,
            line_number: li.line_number ?? idx,
            source: li.source || 'manual',
          }))
        )
      })
      .catch(() => setError('Failed to load purchase order'))
      .finally(() => setLoading(false))
  }, [poId, token])

  // Reset when opening fresh
  useEffect(() => {
    if (isOpen && !poId) {
      setSupplierId(defaultSupplierId || 0)
      setOrderDate(defaultDate || new Date().toISOString().slice(0, 10))
      setOrderType('itemised')
      setStatus('DRAFT')
      setTotalAmount(null)
      setOrderReference('')
      setNotes('')
      setLineItems([])
      setAttachmentName(null)
      setError(null)
      setSearchQuery('')
      setSearchResults([])
    }
  }, [isOpen, poId, defaultSupplierId, defaultDate])

  // Product search (debounced)
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    if (!searchQuery || searchQuery.length < 2 || !token) {
      setSearchResults([])
      return
    }
    searchTimeout.current = setTimeout(() => {
      const params = new URLSearchParams({ query: searchQuery })
      if (supplierId) params.append('supplier_id', String(supplierId))
      fetch(`/api/purchase-orders/products/search?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(setSearchResults)
        .catch(() => {})
    }, 300)
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current) }
  }, [searchQuery, supplierId, token])

  const addManualItem = () => {
    setLineItems(prev => [
      ...prev,
      { description: '', unit_price: 0, quantity: 1, total: 0, line_number: prev.length, source: 'manual' },
    ])
  }

  const addSearchItem = (item: SearchResult) => {
    setLineItems(prev => [
      ...prev,
      {
        product_id: item.id || null,
        product_code: item.product_code,
        description: item.name,
        unit: item.unit,
        unit_price: item.last_price || 0,
        quantity: 1,
        total: item.last_price || 0,
        line_number: prev.length,
        source: 'search',
      },
    ])
    setSearchQuery('')
    setSearchResults([])
  }

  const updateItem = (idx: number, field: string, value: any) => {
    setLineItems(prev => {
      const items = [...prev]
      const item = { ...items[idx], [field]: value }
      if (field === 'unit_price' || field === 'quantity') {
        item.total = parseFloat((item.unit_price * item.quantity).toFixed(2))
      }
      items[idx] = item
      return items
    })
  }

  const removeItem = (idx: number) => {
    setLineItems(prev => prev.filter((_, i) => i !== idx))
  }

  const calcTotal = useCallback(() => {
    if (orderType === 'single_value') return totalAmount || 0
    return lineItems.reduce((sum, li) => sum + (li.total || 0), 0)
  }, [orderType, totalAmount, lineItems])

  const handleSave = async (submitStatus?: string) => {
    if (!token || !supplierId || !orderDate) {
      setError('Please fill in supplier and date')
      return
    }
    if (orderType === 'itemised' && lineItems.length === 0) {
      setError('Please add at least one line item')
      return
    }
    if (orderType === 'single_value' && (!totalAmount || totalAmount <= 0)) {
      setError('Please enter a valid order value')
      return
    }

    setSaving(true)
    setError(null)

    const body: any = {
      supplier_id: supplierId,
      order_date: orderDate,
      order_type: orderType,
      status: submitStatus || status,
      order_reference: orderReference || null,
      notes: notes || null,
      line_items: orderType === 'itemised' ? lineItems.map((li, idx) => ({
        product_id: li.product_id || null,
        product_code: li.product_code || null,
        description: li.description,
        unit: li.unit || null,
        unit_price: li.unit_price,
        quantity: li.quantity,
        total: li.total,
        line_number: idx,
        source: li.source,
      })) : [],
    }

    if (orderType === 'single_value') {
      body.total_amount = totalAmount
    }

    try {
      const url = poId ? `/api/purchase-orders/${poId}` : '/api/purchase-orders/'
      const method = poId ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to save')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message || 'Failed to save purchase order')
    } finally {
      setSaving(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !poId || !token) return
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/attachment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json()
      setAttachmentName(data.attachment_original_name)
    } catch {
      setError('Failed to upload attachment')
    }
  }

  const handleRemoveAttachment = async () => {
    if (!poId || !token) return
    try {
      await fetch(`/api/purchase-orders/${poId}/attachment`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      setAttachmentName(null)
    } catch {
      setError('Failed to remove attachment')
    }
  }

  const handleDelete = async () => {
    if (!poId || !token) return
    if (!confirm('Delete this purchase order?')) return
    try {
      const res = await fetch(`/api/purchase-orders/${poId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Delete failed')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message || 'Failed to delete')
    }
  }

  const handlePreview = async () => {
    if (!token) return
    // If unsaved (new PO or has changes), save first then preview
    if (!poId) {
      // Save as draft first, then open preview
      if (!supplierId || !orderDate) {
        setError('Please fill in supplier and date')
        return
      }
      setSaving(true)
      setError(null)
      const body: any = {
        supplier_id: supplierId,
        order_date: orderDate,
        order_type: orderType,
        status: 'DRAFT',
        order_reference: orderReference || null,
        notes: notes || null,
        line_items: orderType === 'itemised' ? lineItems.map((li, idx) => ({
          product_id: li.product_id || null,
          product_code: li.product_code || null,
          description: li.description,
          unit: li.unit || null,
          unit_price: li.unit_price,
          quantity: li.quantity,
          total: li.total,
          line_number: idx,
          source: li.source,
        })) : [],
        ...(orderType === 'single_value' ? { total_amount: totalAmount } : {}),
      }
      try {
        const res = await fetch('/api/purchase-orders/', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to save')
        const data = await res.json()
        window.open(`/api/purchase-orders/${data.id}/preview?token=${encodeURIComponent(token || '')}`, '_blank')
        onSaved()
        onClose()
      } catch (e: any) {
        setError(e.message || 'Failed to save')
      } finally {
        setSaving(false)
      }
    } else {
      // Existing PO — save current state then preview
      await handleSave()
      window.open(`/api/purchase-orders/${poId}/preview?token=${encodeURIComponent(token || '')}`, '_blank')
    }
  }

  const handleSaveAndEmail = async () => {
    if (!token || !supplierId || !orderDate) {
      setError('Please fill in supplier and date')
      return
    }
    setEmailing(true)
    setError(null)
    setEmailMessage(null)

    // Save or create PO first
    const body: any = {
      supplier_id: supplierId,
      order_date: orderDate,
      order_type: orderType,
      status: status === 'DRAFT' ? 'DRAFT' : status,
      order_reference: orderReference || null,
      notes: notes || null,
      line_items: orderType === 'itemised' ? lineItems.map((li, idx) => ({
        product_id: li.product_id || null,
        product_code: li.product_code || null,
        description: li.description,
        unit: li.unit || null,
        unit_price: li.unit_price,
        quantity: li.quantity,
        total: li.total,
        line_number: idx,
        source: li.source,
      })) : [],
      ...(orderType === 'single_value' ? { total_amount: totalAmount } : {}),
    }

    try {
      const url = poId ? `/api/purchase-orders/${poId}` : '/api/purchase-orders/'
      const method = poId ? 'PUT' : 'POST'
      const saveRes = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!saveRes.ok) throw new Error('Failed to save PO')
      const savedPo = await saveRes.json()

      // Now send the email
      const emailRes = await fetch(`/api/purchase-orders/${savedPo.id}/send-email`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!emailRes.ok) {
        const err = await emailRes.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to send email')
      }
      const emailData = await emailRes.json()
      setEmailMessage(emailData.message || 'Email sent successfully')
      onSaved()
      // Close after a brief delay so user sees success message
      setTimeout(() => onClose(), 1500)
    } catch (e: any) {
      setError(e.message || 'Failed to send email')
    } finally {
      setEmailing(false)
    }
  }

  // Check if current supplier has order_email configured
  const selectedSupplier = suppliers.find(s => s.id === supplierId)
  const supplierHasEmail = !!(selectedSupplier?.order_email)
  const canEmail = supplierHasEmail && smtpConfigured

  if (!isOpen) return null

  const isEditable = !poId || status === 'DRAFT' || status === 'PENDING'
  const total = calcTotal()

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 style={styles.title}>
            {poId ? `Purchase Order #${poId}` : 'New Purchase Order'}
            {poId && <span style={{ ...styles.statusBadge, ...statusStyle(status) }}>{status}</span>}
          </h2>
          <button style={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <div style={styles.body}>
          {loading ? (
            <p>Loading...</p>
          ) : (
            <>
              {error && <div style={styles.error}>{error}</div>}
              {emailMessage && <div style={styles.success}>{emailMessage}</div>}

              {/* Top fields */}
              <div style={styles.fieldRow}>
                <div style={styles.field}>
                  <label style={styles.label}>Date</label>
                  <input
                    type="date"
                    value={orderDate}
                    onChange={e => setOrderDate(e.target.value)}
                    style={styles.input}
                    disabled={!isEditable}
                  />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Supplier</label>
                  <select
                    value={supplierId}
                    onChange={e => setSupplierId(Number(e.target.value))}
                    style={styles.input}
                    disabled={!isEditable}
                  >
                    <option value={0}>Select supplier...</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={styles.fieldRow}>
                <div style={{ ...styles.field, flex: 1 }}>
                  <label style={styles.label}>Notes</label>
                  <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    style={{ ...styles.input, minHeight: '50px', resize: 'vertical' }}
                    disabled={!isEditable}
                    placeholder="Optional notes..."
                  />
                </div>
              </div>

              {/* Order type tabs */}
              <div style={styles.tabs}>
                <button
                  style={{ ...styles.tab, ...(orderType === 'itemised' ? styles.tabActive : {}) }}
                  onClick={() => isEditable && setOrderType('itemised')}
                  disabled={!isEditable}
                >
                  Itemised Order
                </button>
                <button
                  style={{ ...styles.tab, ...(orderType === 'single_value' ? styles.tabActive : {}) }}
                  onClick={() => isEditable && setOrderType('single_value')}
                  disabled={!isEditable}
                >
                  Single Value
                </button>
              </div>

              {orderType === 'itemised' ? (
                <>
                  {/* Line items table */}
                  {lineItems.length > 0 && (
                    <div style={styles.tableWrap}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Product</th>
                            <th style={{ ...styles.th, width: '90px' }}>Price</th>
                            <th style={{ ...styles.th, width: '70px' }}>Qty</th>
                            <th style={{ ...styles.th, width: '90px' }}>Total</th>
                            {isEditable && <th style={{ ...styles.th, width: '36px' }}></th>}
                          </tr>
                        </thead>
                        <tbody>
                          {lineItems.map((li, idx) => (
                            <tr key={idx}>
                              <td style={styles.td}>
                                {li.source === 'search' ? (
                                  <span>{li.product_code ? `${li.product_code} - ` : ''}{li.description}</span>
                                ) : (
                                  <input
                                    value={li.description}
                                    onChange={e => updateItem(idx, 'description', e.target.value)}
                                    style={styles.cellInput}
                                    placeholder="Description"
                                    disabled={!isEditable}
                                  />
                                )}
                              </td>
                              <td style={styles.td}>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={li.unit_price}
                                  onChange={e => updateItem(idx, 'unit_price', parseFloat(e.target.value) || 0)}
                                  style={{ ...styles.cellInput, textAlign: 'right' }}
                                  disabled={!isEditable}
                                />
                              </td>
                              <td style={styles.td}>
                                <input
                                  type="number"
                                  step="0.001"
                                  value={li.quantity}
                                  onChange={e => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)}
                                  style={{ ...styles.cellInput, textAlign: 'right' }}
                                  disabled={!isEditable}
                                />
                              </td>
                              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 500 }}>
                                {'\u00A3'}{li.total.toFixed(2)}
                              </td>
                              {isEditable && (
                                <td style={styles.td}>
                                  <button style={styles.removeBtn} onClick={() => removeItem(idx)}>&times;</button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {isEditable && (
                    <>
                      <button style={styles.addBtn} onClick={addManualItem}>+ Add Manual Item</button>

                      {/* Product search */}
                      <div style={styles.searchSection}>
                        <label style={styles.label}>Search Products (filtered to supplier)</label>
                        <input
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          style={styles.input}
                          placeholder="Search by name or code..."
                        />
                        {searchResults.length > 0 && (
                          <div style={styles.searchResults}>
                            <table style={styles.table}>
                              <thead>
                                <tr>
                                  <th style={styles.th}>Code</th>
                                  <th style={styles.th}>Product</th>
                                  <th style={styles.th}>Unit</th>
                                  <th style={styles.th}>Price</th>
                                  <th style={styles.th}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {searchResults.map((r, i) => (
                                  <tr key={i}>
                                    <td style={styles.td}>{r.product_code || '-'}</td>
                                    <td style={styles.td}>{r.name}</td>
                                    <td style={styles.td}>{r.unit || '-'}</td>
                                    <td style={styles.td}>{r.last_price != null ? `\u00A3${r.last_price.toFixed(2)}` : '-'}</td>
                                    <td style={styles.td}>
                                      <button style={styles.addSearchBtn} onClick={() => addSearchItem(r)}>Add</button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              ) : (
                /* Single Value */
                <div style={{ marginTop: '1rem' }}>
                  <div style={styles.fieldRow}>
                    <div style={styles.field}>
                      <label style={styles.label}>Order Value ({'\u00A3'})</label>
                      <input
                        type="number"
                        step="0.01"
                        value={totalAmount ?? ''}
                        onChange={e => setTotalAmount(parseFloat(e.target.value) || null)}
                        style={styles.input}
                        disabled={!isEditable}
                      />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>Order Ref</label>
                      <input
                        value={orderReference}
                        onChange={e => setOrderReference(e.target.value)}
                        style={styles.input}
                        disabled={!isEditable}
                        placeholder="Optional"
                      />
                    </div>
                  </div>

                  {/* Attachment (only for saved POs) */}
                  {poId && (
                    <div style={{ marginTop: '0.75rem' }}>
                      <label style={styles.label}>Attachment</label>
                      {attachmentName ? (
                        <div style={styles.attachRow}>
                          <span>{attachmentName}</span>
                          {isEditable && <button style={styles.removeBtn} onClick={handleRemoveAttachment}>Remove</button>}
                        </div>
                      ) : isEditable ? (
                        <>
                          <button style={styles.addBtn} onClick={() => fileInput.current?.click()}>Upload File</button>
                          <input ref={fileInput} type="file" style={{ display: 'none' }} onChange={handleFileUpload} />
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              )}

              {/* Total */}
              <div style={styles.totalRow}>
                <strong>Total: {'\u00A3'}{total.toFixed(2)}</strong>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {poId && isEditable && (status === 'DRAFT' || status === 'PENDING') && (
              <button style={styles.deleteBtn} onClick={handleDelete}>Delete</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
            {isEditable && (
              <>
                <button style={styles.previewBtn} onClick={handlePreview} disabled={saving || emailing}>
                  {saving ? 'Saving...' : 'Preview'}
                </button>
                {canEmail && (
                  <button style={styles.emailBtn} onClick={handleSaveAndEmail} disabled={saving || emailing}>
                    {emailing ? 'Sending...' : 'Save & Email'}
                  </button>
                )}
                <button style={styles.draftBtn} onClick={() => handleSave('DRAFT')} disabled={saving || emailing}>
                  {saving ? 'Saving...' : 'Save Draft'}
                </button>
                <button style={styles.submitBtn} onClick={() => handleSave('PENDING')} disabled={saving || emailing}>
                  {saving ? 'Saving...' : 'Save & Submit'}
                </button>
              </>
            )}
            {!isEditable && poId && (
              <button style={styles.previewBtn} onClick={() => window.open(`/api/purchase-orders/${poId}/preview?token=${encodeURIComponent(token || '')}`, '_blank')}>
                Preview
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function statusStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'DRAFT': return { background: '#e0e0e0', color: '#555' }
    case 'PENDING': return { background: '#e3f2fd', color: '#1565c0' }
    case 'LINKED': return { background: '#d4edda', color: '#155724' }
    case 'CLOSED': return { background: '#f5f5f5', color: '#666' }
    case 'CANCELLED': return { background: '#ffebee', color: '#c62828' }
    default: return {}
  }
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
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
    width: '95%',
    maxHeight: '90vh',
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.5rem',
    borderBottom: '1px solid #eee',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    color: '#1a1a2e',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    fontSize: '1.2rem',
  },
  statusBadge: {
    fontSize: '0.75rem',
    padding: '0.2rem 0.6rem',
    borderRadius: '12px',
    fontWeight: 600,
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
  body: {
    padding: '1.5rem',
    overflowY: 'auto',
    flex: 1,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 1.5rem',
    borderTop: '1px solid #eee',
    flexShrink: 0,
  },
  error: {
    background: '#ffebee',
    color: '#c62828',
    padding: '0.75rem',
    borderRadius: '6px',
    marginBottom: '1rem',
    fontSize: '0.9rem',
  },
  fieldRow: {
    display: 'flex',
    gap: '1rem',
    marginBottom: '0.75rem',
  },
  field: {
    flex: 1,
  },
  label: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#555',
    marginBottom: '0.25rem',
  },
  input: {
    width: '100%',
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '0.9rem',
    boxSizing: 'border-box',
  },
  tabs: {
    display: 'flex',
    gap: '0.5rem',
    marginTop: '1rem',
    marginBottom: '0.75rem',
  },
  tab: {
    padding: '0.5rem 1rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    background: '#f9f9f9',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  tabActive: {
    background: '#1a1a2e',
    color: 'white',
    borderColor: '#1a1a2e',
  },
  tableWrap: {
    overflowX: 'auto',
    marginBottom: '0.75rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  th: {
    textAlign: 'left',
    padding: '0.5rem',
    borderBottom: '2px solid #eee',
    fontWeight: 600,
    color: '#666',
    fontSize: '0.8rem',
  },
  td: {
    padding: '0.4rem 0.5rem',
    borderBottom: '1px solid #f0f0f0',
    verticalAlign: 'middle',
  },
  cellInput: {
    width: '100%',
    padding: '0.3rem 0.4rem',
    border: '1px solid #ddd',
    borderRadius: '4px',
    fontSize: '0.85rem',
    boxSizing: 'border-box',
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#c62828',
    cursor: 'pointer',
    fontSize: '1.1rem',
    fontWeight: 'bold',
    padding: '0 0.25rem',
  },
  addBtn: {
    background: 'none',
    border: '1px dashed #999',
    borderRadius: '6px',
    padding: '0.4rem 0.75rem',
    cursor: 'pointer',
    color: '#555',
    fontSize: '0.85rem',
    marginBottom: '0.75rem',
  },
  searchSection: {
    marginTop: '0.5rem',
    padding: '0.75rem',
    background: '#fafafa',
    borderRadius: '6px',
    border: '1px solid #eee',
  },
  searchResults: {
    marginTop: '0.5rem',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  addSearchBtn: {
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '0.25rem 0.5rem',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  totalRow: {
    textAlign: 'right',
    marginTop: '1rem',
    fontSize: '1.1rem',
    padding: '0.75rem',
    background: '#f5f5f5',
    borderRadius: '6px',
  },
  attachRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem',
    background: '#f5f5f5',
    borderRadius: '6px',
    fontSize: '0.9rem',
  },
  cancelBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    background: 'white',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  draftBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #999',
    borderRadius: '6px',
    background: '#f5f5f5',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  submitBtn: {
    padding: '0.5rem 1rem',
    border: 'none',
    borderRadius: '6px',
    background: '#1a1a2e',
    color: 'white',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  deleteBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #c62828',
    borderRadius: '6px',
    background: '#ffebee',
    color: '#c62828',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  previewBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #1565c0',
    borderRadius: '6px',
    background: '#e3f2fd',
    color: '#1565c0',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  emailBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #2e7d32',
    borderRadius: '6px',
    background: '#e8f5e9',
    color: '#2e7d32',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  success: {
    background: '#e8f5e9',
    color: '#2e7d32',
    padding: '0.75rem',
    borderRadius: '6px',
    marginBottom: '1rem',
    fontSize: '0.9rem',
  },
}
