import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../App'

interface LineItemAvail {
  id: number
  description: string | null
  unit: string | null
  quantity: number | null
  unit_price: number | null
  amount: number | null
  is_non_stock: boolean
  already_distributed_qty: number
  available_qty: number
}

interface InvoiceAvailability {
  invoice_id: number
  invoice_number: string | null
  invoice_date: string | null
  supplier_name: string | null
  line_items: LineItemAvail[]
}

interface EntryOut {
  id: number
  entry_date: string
  amount: number
  is_source_offset: boolean
  is_overpay: boolean
}

interface LineSelectionOut {
  id: number
  line_item_id: number
  description: string | null
  original_quantity: number | null
  selected_quantity: number
  unit_price: number
  distributed_value: number
}

interface DistributionDetail {
  id: number
  invoice_id: number
  invoice_number: string | null
  invoice_date: string | null
  supplier_name: string | null
  status: string
  method: string
  notes: string | null
  total_distributed_value: number
  remaining_balance: number
  source_date: string
  created_by_name: string | null
  created_at: string
  line_selections: LineSelectionOut[]
  entries: EntryOut[]
}

interface Selection {
  selected: boolean
  qty: number
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSaved: () => void
  invoiceId: number | null
  distributionId?: number | null
  isAdmin?: boolean
}

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function CostDistributionModal({ isOpen, onClose, onSaved, invoiceId, distributionId, isAdmin }: Props) {
  const { token } = useAuth()

  // Form state
  const [invoice, setInvoice] = useState<InvoiceAvailability | null>(null)
  const [existing, setExisting] = useState<DistributionDetail | null>(null)
  const [selections, setSelections] = useState<Record<number, Selection>>({})
  const [method, setMethod] = useState<'OFFSET' | 'DISTRIBUTE'>('OFFSET')
  const [targetDate, setTargetDate] = useState('')
  const [daysOfWeek, setDaysOfWeek] = useState<boolean[]>([true, true, true, true, true, false, false])
  const [numWeeks, setNumWeeks] = useState(4)
  const [startDate, setStartDate] = useState('')
  const [notes, setNotes] = useState('')

  // UI state
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Settle early state
  const [settleMode, setSettleMode] = useState(false)
  const [settleDate, setSettleDate] = useState('')
  const [settleAmount, setSettleAmount] = useState<string>('')

  // Reset state when modal opens
  useEffect(() => {
    if (!isOpen) return
    setError(null)
    setSelections({})
    setMethod('OFFSET')
    setTargetDate('')
    setDaysOfWeek([true, true, true, true, true, false, false])
    setNumWeeks(4)
    setStartDate('')
    setNotes('')
    setExisting(null)
    setInvoice(null)
    setSettleMode(false)
    setSettleDate('')
    setSettleAmount('')
  }, [isOpen, invoiceId, distributionId])

  // Load invoice availability or existing distribution
  useEffect(() => {
    if (!isOpen || !token) return

    if (distributionId) {
      // Load existing distribution
      setLoading(true)
      fetch(`/api/cost-distributions/${distributionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => { if (!r.ok) throw new Error('Failed to load distribution'); return r.json() })
        .then((data: DistributionDetail) => {
          setExisting(data)
          setNotes(data.notes || '')
          setLoading(false)
        })
        .catch(e => { setError(e.message); setLoading(false) })
    } else if (invoiceId) {
      // Load invoice availability
      setLoading(true)
      fetch(`/api/cost-distributions/invoice/${invoiceId}/availability`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => { if (!r.ok) throw new Error('Failed to load invoice data'); return r.json() })
        .then((data: InvoiceAvailability) => {
          setInvoice(data)
          // Initialize selections
          const init: Record<number, Selection> = {}
          for (const li of data.line_items) {
            if (!li.is_non_stock && li.available_qty > 0) {
              init[li.id] = { selected: false, qty: li.available_qty }
            }
          }
          setSelections(init)
          // Set default start date to next Monday after invoice date
          if (data.invoice_date) {
            const d = new Date(data.invoice_date)
            const day = d.getDay() // 0=Sun, 1=Mon...
            const daysUntilMon = day === 0 ? 1 : (8 - day)
            d.setDate(d.getDate() + daysUntilMon)
            setStartDate(d.toISOString().slice(0, 10))
          }
          setLoading(false)
        })
        .catch(e => { setError(e.message); setLoading(false) })
    }
  }, [isOpen, token, invoiceId, distributionId])

  // Calculate actual remaining balance from future entries (not the stale DB field)
  const actualRemaining = useMemo(() => {
    if (!existing) return 0
    const today = new Date().toISOString().slice(0, 10)
    const total = existing.entries
      .filter(e => !e.is_source_offset && !e.is_overpay && e.entry_date > today)
      .reduce((sum, e) => sum + e.amount, 0)
    return Math.round(total * 100) / 100
  }, [existing])

  // Settable amount recalculates based on chosen settle date (entries from that date onwards)
  const settleMax = useMemo(() => {
    if (!existing || !settleDate) return actualRemaining
    const total = existing.entries
      .filter(e => !e.is_source_offset && !e.is_overpay && e.entry_date >= settleDate)
      .reduce((sum, e) => sum + e.amount, 0)
    return Math.round(total * 100) / 100
  }, [existing, settleDate, actualRemaining])

  // Auto-update settle amount when settle date changes
  useEffect(() => {
    if (settleMode && existing && settleDate) {
      const total = existing.entries
        .filter(e => !e.is_source_offset && !e.is_overpay && e.entry_date >= settleDate)
        .reduce((sum, e) => sum + e.amount, 0)
      setSettleAmount((Math.round(total * 100) / 100).toFixed(2))
    }
  }, [settleDate, settleMode, existing])

  // Calculate total distributed value from selections
  const totalDistValue = useMemo(() => {
    if (!invoice) return 0
    let total = 0
    for (const li of invoice.line_items) {
      const sel = selections[li.id]
      if (sel?.selected && li.unit_price) {
        total += sel.qty * li.unit_price
      }
    }
    return Math.round(total * 100) / 100
  }, [invoice, selections])

  // Generate preview dates for DISTRIBUTE method
  const previewEntries = useMemo(() => {
    if (method !== 'DISTRIBUTE' || !startDate || numWeeks < 1 || totalDistValue <= 0) return []
    const selectedDows = daysOfWeek.reduce<number[]>((acc, v, i) => { if (v) acc.push(i); return acc }, [])
    if (selectedDows.length === 0) return []

    const dates: string[] = []
    const start = new Date(startDate)
    for (let w = 0; w < numWeeks; w++) {
      for (let d = 0; d < 7; d++) {
        const current = new Date(start)
        current.setDate(start.getDate() + w * 7 + d)
        const dow = (current.getDay() + 6) % 7 // Convert JS Sun=0 to Mon=0
        if (selectedDows.includes(dow)) {
          dates.push(current.toISOString().slice(0, 10))
        }
      }
    }
    // Deduplicate and sort
    const unique = [...new Set(dates)].sort()
    if (unique.length === 0) return []

    const perEntry = Math.round((totalDistValue / unique.length) * 100) / 100
    const entries = unique.map((date, i) => ({
      date,
      amount: i === unique.length - 1
        ? Math.round((totalDistValue - perEntry * (unique.length - 1)) * 100) / 100
        : perEntry,
    }))
    return entries
  }, [method, startDate, numWeeks, daysOfWeek, totalDistValue])

  const handleSave = async () => {
    if (!token || !invoiceId) return
    setError(null)
    setSaving(true)

    try {
      const lineSelections = Object.entries(selections)
        .filter(([_, sel]) => sel.selected)
        .map(([id, sel]) => ({
          line_item_id: parseInt(id),
          selected_quantity: sel.qty,
        }))

      if (lineSelections.length === 0) {
        setError('Please select at least one line item')
        setSaving(false)
        return
      }

      const body: any = {
        invoice_id: invoiceId,
        method,
        notes: notes || null,
        line_selections: lineSelections,
      }

      if (method === 'OFFSET') {
        if (!targetDate) { setError('Please select a target date'); setSaving(false); return }
        body.target_date = targetDate
      } else {
        const selectedDows = daysOfWeek.reduce<number[]>((acc, v, i) => { if (v) acc.push(i); return acc }, [])
        if (selectedDows.length === 0) { setError('Please select at least one day'); setSaving(false); return }
        if (!startDate) { setError('Please select a start date'); setSaving(false); return }
        body.days_of_week = selectedDows
        body.num_weeks = numWeeks
        body.start_date = startDate
      }

      const res = await fetch('/api/cost-distributions/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to create distribution')
      }

      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateNotes = async () => {
    if (!token || !distributionId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/cost-distributions/${distributionId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      })
      if (!res.ok) throw new Error('Failed to update')
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!token || !distributionId) return
    if (!confirm('Are you sure you want to cancel this distribution? This will remove all scheduled entries.')) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/cost-distributions/${distributionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to delete')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  const handleSettleEarly = async (settleAll?: boolean) => {
    if (!token || !distributionId || !settleDate) return
    setSaving(true)
    try {
      const body: any = { entry_date: settleDate }
      if (!settleAll && settleAmount) body.amount = parseFloat(settleAmount)
      const res = await fetch(`/api/cost-distributions/${distributionId}/settle-early`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to settle')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  const isViewing = !!distributionId && !!existing
  const isActive = existing?.status === 'ACTIVE'

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>
              {isViewing ? `Cost Distribution #${existing.id}` : 'New Cost Distribution'}
            </h2>
            {existing && (
              <span style={{
                ...styles.statusBadge,
                background: existing.status === 'ACTIVE' ? '#e3f2fd' : existing.status === 'COMPLETED' ? '#e8f5e9' : '#ffebee',
                color: existing.status === 'ACTIVE' ? '#1565c0' : existing.status === 'COMPLETED' ? '#2e7d32' : '#c62828',
              }}>
                {existing.status}
              </span>
            )}
          </div>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {loading && <div style={styles.loadingText}>Loading...</div>}
          {error && <div style={styles.error}>{error}</div>}

          {/* Invoice Reference (read-only) */}
          {(invoice || existing) && (
            <div style={styles.fieldRow}>
              <label style={styles.field}>
                <span style={styles.label}>Invoice Date</span>
                <input type="text" disabled value={existing?.invoice_date || invoice?.invoice_date || ''} style={styles.input} />
              </label>
              <label style={styles.field}>
                <span style={styles.label}>Invoice #</span>
                <input type="text" disabled value={existing?.invoice_number || invoice?.invoice_number || ''} style={styles.input} />
              </label>
              <label style={styles.field}>
                <span style={styles.label}>Supplier</span>
                <input type="text" disabled value={existing?.supplier_name || invoice?.supplier_name || ''} style={styles.input} />
              </label>
            </div>
          )}

          {/* Notes */}
          <label style={{ ...styles.field, marginBottom: '1rem' }}>
            <span style={styles.label}>Notes</span>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              style={styles.textarea}
              placeholder="Optional notes..."
              disabled={isViewing && !isActive}
            />
          </label>

          {/* === CREATE MODE: Line items selection === */}
          {!isViewing && invoice && (
            <>
              <h3 style={styles.sectionTitle}>Line Items</h3>
              <div style={styles.lineItemsContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}></th>
                      <th style={{ ...styles.th, textAlign: 'left' }}>Description</th>
                      <th style={styles.th}>Unit</th>
                      <th style={styles.th}>Available</th>
                      <th style={styles.th}>Distribute Qty</th>
                      <th style={styles.th}>Price</th>
                      <th style={styles.th}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.line_items.filter(li => !li.is_non_stock).map(li => {
                      const sel = selections[li.id]
                      const isDisabled = li.available_qty <= 0
                      const distValue = sel?.selected ? Math.round((sel.qty * (li.unit_price || 0)) * 100) / 100 : 0
                      return (
                        <tr key={li.id} style={{ opacity: isDisabled ? 0.4 : 1 }}>
                          <td style={styles.td}>
                            <input
                              type="checkbox"
                              checked={sel?.selected || false}
                              disabled={isDisabled}
                              onChange={e => setSelections(prev => ({
                                ...prev,
                                [li.id]: { ...prev[li.id], selected: e.target.checked },
                              }))}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: 'left', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {li.description || '-'}
                          </td>
                          <td style={styles.td}>{li.unit || '-'}</td>
                          <td style={styles.td}>{li.available_qty.toFixed(2)}</td>
                          <td style={styles.td}>
                            {sel?.selected ? (
                              <input
                                type="number"
                                value={sel.qty}
                                min={0.001}
                                max={li.available_qty}
                                step={0.001}
                                onChange={e => {
                                  const val = Math.min(parseFloat(e.target.value) || 0, li.available_qty)
                                  setSelections(prev => ({
                                    ...prev,
                                    [li.id]: { ...prev[li.id], qty: val },
                                  }))
                                }}
                                style={{ ...styles.qtyInput }}
                              />
                            ) : '-'}
                          </td>
                          <td style={styles.td}>£{(li.unit_price || 0).toFixed(2)}</td>
                          <td style={{ ...styles.td, fontWeight: sel?.selected ? 600 : 400 }}>
                            {sel?.selected ? `£${distValue.toFixed(2)}` : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={styles.totalRow}>
                      <td colSpan={6} style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>Total to Distribute:</td>
                      <td style={{ ...styles.td, fontWeight: 700, fontSize: '0.95rem' }}>£{totalDistValue.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Method tabs */}
              <h3 style={styles.sectionTitle}>Distribution Method</h3>
              <div style={styles.tabs}>
                <button
                  style={method === 'OFFSET' ? styles.tabActive : styles.tab}
                  onClick={() => setMethod('OFFSET')}
                >
                  Offset to Date
                </button>
                <button
                  style={method === 'DISTRIBUTE' ? styles.tabActive : styles.tab}
                  onClick={() => setMethod('DISTRIBUTE')}
                >
                  Distribute Over Period
                </button>
              </div>

              {/* OFFSET content */}
              {method === 'OFFSET' && (
                <div style={styles.methodContent}>
                  <label style={styles.field}>
                    <span style={styles.label}>Target Date</span>
                    <input
                      type="date"
                      value={targetDate}
                      onChange={e => setTargetDate(e.target.value)}
                      style={styles.input}
                    />
                  </label>
                </div>
              )}

              {/* DISTRIBUTE content */}
              {method === 'DISTRIBUTE' && (
                <div style={styles.methodContent}>
                  <div style={styles.field}>
                    <span style={styles.label}>Days of Week</span>
                    <div style={styles.dowRow}>
                      {DOW_LABELS.map((label, i) => (
                        <button
                          key={i}
                          style={daysOfWeek[i] ? styles.dowBtnActive : styles.dowBtn}
                          onClick={() => {
                            const next = [...daysOfWeek]
                            next[i] = !next[i]
                            setDaysOfWeek(next)
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={styles.fieldRow}>
                    <label style={styles.field}>
                      <span style={styles.label}>For how many weeks?</span>
                      <input
                        type="number"
                        value={numWeeks}
                        min={1}
                        max={52}
                        onChange={e => setNumWeeks(parseInt(e.target.value) || 1)}
                        style={{ ...styles.input, maxWidth: '80px' }}
                      />
                    </label>
                    <label style={styles.field}>
                      <span style={styles.label}>Starting from</span>
                      <input
                        type="date"
                        value={startDate}
                        onChange={e => setStartDate(e.target.value)}
                        style={styles.input}
                      />
                    </label>
                  </div>

                  {/* Preview panel */}
                  {previewEntries.length > 0 && (
                    <div style={styles.preview}>
                      <div style={styles.previewTitle}>
                        Preview: {previewEntries.length} entries, £{totalDistValue.toFixed(2)} total
                      </div>
                      <div style={styles.previewGrid}>
                        {previewEntries.map(e => (
                          <div key={e.date} style={styles.previewEntry}>
                            <span style={styles.previewDate}>
                              {new Date(e.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                            </span>
                            <span style={styles.previewAmount}>£{e.amount.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* === VIEW MODE: Existing distribution details === */}
          {isViewing && existing && (
            <>
              {/* Summary */}
              <div style={styles.summaryRow}>
                <div style={styles.summaryItem}>
                  <span style={styles.summaryLabel}>Total Value</span>
                  <span style={styles.summaryValue}>£{existing.total_distributed_value.toFixed(2)}</span>
                </div>
                <div style={styles.summaryItem}>
                  <span style={styles.summaryLabel}>Remaining</span>
                  <span style={{ ...styles.summaryValue, color: existing.remaining_balance > 0 ? '#e65100' : '#2e7d32' }}>
                    £{existing.remaining_balance.toFixed(2)}
                  </span>
                </div>
                <div style={styles.summaryItem}>
                  <span style={styles.summaryLabel}>Method</span>
                  <span style={styles.summaryValue}>{existing.method}</span>
                </div>
                <div style={styles.summaryItem}>
                  <span style={styles.summaryLabel}>Created</span>
                  <span style={styles.summaryValue}>
                    {existing.created_by_name || 'Unknown'}, {new Date(existing.created_at).toLocaleDateString('en-GB')}
                  </span>
                </div>
              </div>

              {/* Line selections */}
              <h3 style={styles.sectionTitle}>Distributed Items</h3>
              <div style={styles.lineItemsContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: 'left' }}>Description</th>
                      <th style={styles.th}>Qty</th>
                      <th style={styles.th}>Price</th>
                      <th style={styles.th}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {existing.line_selections.map(sel => (
                      <tr key={sel.id}>
                        <td style={{ ...styles.td, textAlign: 'left' }}>{sel.description || '-'}</td>
                        <td style={styles.td}>{sel.selected_quantity}</td>
                        <td style={styles.td}>£{sel.unit_price.toFixed(2)}</td>
                        <td style={styles.td}>£{sel.distributed_value.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Schedule entries */}
              <h3 style={styles.sectionTitle}>Schedule</h3>
              <div style={styles.lineItemsContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: 'left' }}>Date</th>
                      <th style={styles.th}>Amount</th>
                      <th style={styles.th}>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {existing.entries.map(entry => (
                      <tr key={entry.id} style={{
                        background: entry.is_source_offset ? '#fff3e0' : entry.is_overpay ? '#e3f2fd' : 'transparent',
                      }}>
                        <td style={{ ...styles.td, textAlign: 'left' }}>
                          {new Date(entry.entry_date).toLocaleDateString('en-GB', {
                            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
                          })}
                        </td>
                        <td style={{
                          ...styles.td,
                          color: entry.amount < 0 ? '#c62828' : '#2e7d32',
                          fontWeight: 600,
                        }}>
                          {entry.amount < 0 ? '-' : ''}£{Math.abs(entry.amount).toFixed(2)}
                        </td>
                        <td style={styles.td}>
                          {entry.is_source_offset ? 'Source Offset' : entry.is_overpay ? 'Settled Early' : 'Scheduled'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Settle Early section */}
              {isActive && actualRemaining > 0 && (
                <>
                  <h3 style={styles.sectionTitle}>Settle Early</h3>
                  {!settleMode ? (
                    <button
                      style={styles.settleBtn}
                      onClick={() => {
                        setSettleMode(true)
                        setSettleDate(new Date().toISOString().slice(0, 10))
                        setSettleAmount(actualRemaining.toFixed(2))
                      }}
                    >
                      Settle Early...
                    </button>
                  ) : (
                    <div style={styles.settleForm}>
                      <div style={styles.fieldRow}>
                        <label style={styles.field}>
                          <span style={styles.label}>Settle Date</span>
                          <input
                            type="date"
                            value={settleDate}
                            onChange={e => setSettleDate(e.target.value)}
                            style={styles.input}
                          />
                        </label>
                        <label style={styles.field}>
                          <span style={styles.label}>Amount (max £{settleMax.toFixed(2)})</span>
                          <input
                            type="number"
                            value={settleAmount}
                            min={0.01}
                            max={settleMax}
                            step={0.01}
                            onChange={e => setSettleAmount(e.target.value)}
                            style={{ ...styles.input, maxWidth: '120px' }}
                          />
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <button
                          style={styles.submitBtn}
                          onClick={() => handleSettleEarly()}
                          disabled={saving || !settleDate}
                        >
                          {saving ? 'Settling...' : 'Confirm Settle'}
                        </button>
                        <button
                          style={styles.settleAllBtn}
                          onClick={() => handleSettleEarly(true)}
                          disabled={saving}
                        >
                          Settle All
                        </button>
                        <button style={styles.cancelBtn} onClick={() => setSettleMode(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {isViewing && isAdmin && existing?.status !== 'CANCELLED' && (
              <button style={styles.deleteBtn} onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Cancelling...' : 'Cancel Distribution'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={styles.cancelBtn} onClick={onClose}>Close</button>
            {!isViewing && (
              <button
                style={styles.submitBtn}
                onClick={handleSave}
                disabled={saving || totalDistValue <= 0}
              >
                {saving ? 'Saving...' : 'Create Distribution'}
              </button>
            )}
            {isViewing && isActive && (
              <button
                style={styles.submitBtn}
                onClick={handleUpdateNotes}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Notes'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
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
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    maxWidth: '850px',
    width: '95%',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 1.5rem',
    borderBottom: '1px solid #eee',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    color: '#999',
    lineHeight: 1,
  },
  statusBadge: {
    padding: '0.2rem 0.6rem',
    borderRadius: '12px',
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '1.5rem',
  },
  loadingText: {
    textAlign: 'center',
    padding: '2rem',
    color: '#999',
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
    marginBottom: '1rem',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3rem',
    flex: 1,
  },
  label: {
    fontSize: '0.8rem',
    fontWeight: 500,
    color: '#666',
  },
  input: {
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '0.9rem',
  },
  textarea: {
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '0.9rem',
    minHeight: '50px',
    resize: 'vertical' as const,
    fontFamily: 'inherit',
  },
  sectionTitle: {
    fontSize: '0.95rem',
    fontWeight: 600,
    margin: '1rem 0 0.5rem 0',
    color: '#333',
  },
  lineItemsContainer: {
    maxHeight: '300px',
    overflowY: 'auto',
    border: '1px solid #eee',
    borderRadius: '6px',
    marginBottom: '1rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  th: {
    padding: '0.5rem 0.4rem',
    background: '#f5f5f5',
    fontWeight: 600,
    textAlign: 'center',
    borderBottom: '2px solid #ddd',
    fontSize: '0.8rem',
    position: 'sticky' as const,
    top: 0,
    zIndex: 1,
  },
  td: {
    padding: '0.4rem',
    borderBottom: '1px solid #f0f0f0',
    textAlign: 'center',
    fontSize: '0.85rem',
  },
  totalRow: {
    background: '#f8f9fa',
  },
  qtyInput: {
    width: '70px',
    padding: '0.3rem',
    border: '1px solid #ddd',
    borderRadius: '4px',
    textAlign: 'center' as const,
    fontSize: '0.85rem',
  },
  tabs: {
    display: 'flex',
    gap: '0',
    marginBottom: '1rem',
  },
  tab: {
    flex: 1,
    padding: '0.6rem 1rem',
    border: '1px solid #ddd',
    background: '#f5f5f5',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
    color: '#666',
    textAlign: 'center' as const,
  },
  tabActive: {
    flex: 1,
    padding: '0.6rem 1rem',
    border: '1px solid #1a1a2e',
    background: '#1a1a2e',
    color: 'white',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
    textAlign: 'center' as const,
  },
  methodContent: {
    padding: '1rem',
    background: '#fafafa',
    borderRadius: '6px',
    marginBottom: '1rem',
  },
  dowRow: {
    display: 'flex',
    gap: '0.25rem',
  },
  dowBtn: {
    padding: '0.4rem 0.6rem',
    border: '1px solid #ddd',
    borderRadius: '4px',
    background: 'white',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 500,
    color: '#666',
    minWidth: '42px',
    textAlign: 'center' as const,
  },
  dowBtnActive: {
    padding: '0.4rem 0.6rem',
    border: '1px solid #1565c0',
    borderRadius: '4px',
    background: '#e3f2fd',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#1565c0',
    minWidth: '42px',
    textAlign: 'center' as const,
  },
  preview: {
    marginTop: '1rem',
    padding: '0.75rem',
    border: '1px solid #c8e6c9',
    borderRadius: '6px',
    background: '#f1f8e9',
  },
  previewTitle: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#33691e',
    marginBottom: '0.5rem',
  },
  previewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: '0.25rem',
  },
  previewEntry: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.2rem 0.4rem',
    fontSize: '0.8rem',
    background: 'white',
    borderRadius: '3px',
  },
  previewDate: {
    color: '#555',
  },
  previewAmount: {
    fontWeight: 600,
    color: '#2e7d32',
  },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  summaryItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    padding: '0.75rem',
    background: '#f5f5f5',
    borderRadius: '6px',
  },
  summaryLabel: {
    fontSize: '0.75rem',
    fontWeight: 500,
    color: '#999',
    textTransform: 'uppercase' as const,
  },
  summaryValue: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#333',
  },
  settleBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #e65100',
    borderRadius: '6px',
    background: '#fff3e0',
    color: '#e65100',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  settleForm: {
    padding: '1rem',
    background: '#fff3e0',
    borderRadius: '6px',
    border: '1px solid #ffcc80',
  },
  settleAllBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #e65100',
    borderRadius: '6px',
    background: '#e65100',
    color: 'white',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 1.5rem',
    borderTop: '1px solid #eee',
  },
  cancelBtn: {
    padding: '0.5rem 1rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    background: 'white',
    cursor: 'pointer',
    fontSize: '0.9rem',
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
}
