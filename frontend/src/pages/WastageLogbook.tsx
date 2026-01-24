import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface LineItem {
  id: number
  product_id: number | null
  product_name: string
  product_code: string | null
  supplier_name: string | null
  quantity: number
  unit: string | null
  unit_price: number | null
  total_cost: number
  notes: string | null
}

interface Attachment {
  id: number
  file_name: string
  file_path: string
  file_type: string
  file_size_bytes: number
  description: string | null
  uploaded_at: string
}

interface LogbookEntry {
  id: number
  entry_type: string
  entry_date: string
  reference_number: string | null
  total_cost: number
  notes: string | null
  type_data: Record<string, unknown>
  created_by: number
  created_by_name: string | null
  created_at: string
  line_items: LineItem[]
  attachments: Attachment[]
}

interface LogbookSummary {
  total_entries: number
  total_cost: number
  by_type: Record<string, { count: number; total_cost: number }>
}

interface ProductSearchResult {
  id: number
  name: string
  product_code: string | null
  supplier_name: string | null
  unit: string | null
  last_price: number | null
}

interface LineItemInput {
  product_id?: number
  product_name: string
  product_code?: string
  supplier_name?: string
  quantity: number
  unit?: string
  unit_price?: number
  total_cost: number
  notes?: string
}

const entryTypeColors: Record<string, string> = {
  wastage: '#e94560',
  transfer: '#3498db',
  staff_food: '#27ae60',
  manual_adjustment: '#f39c12',
}

const entryTypeLabels: Record<string, string> = {
  wastage: 'Wastage',
  transfer: 'Transfer',
  staff_food: 'Staff Food',
  manual_adjustment: 'Manual Adjustment',
}

const wastageReasons = [
  { value: 'spoiled', label: 'Spoiled' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'overproduction', label: 'Overproduction' },
  { value: 'quality_issue', label: 'Quality Issue' },
  { value: 'other', label: 'Other' },
]

const mealTypes = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' },
]

export default function WastageLogbook() {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const [selectedEntry, setSelectedEntry] = useState<LogbookEntry | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createEntryType, setCreateEntryType] = useState<string>('wastage')

  // Fetch entries
  const queryParams = new URLSearchParams()
  if (typeFilter) queryParams.append('entry_type', typeFilter)
  if (dateFrom) queryParams.append('date_from', dateFrom)
  if (dateTo) queryParams.append('date_to', dateTo)
  const queryString = queryParams.toString()

  const { data: entries, isLoading } = useQuery<LogbookEntry[]>({
    queryKey: ['logbook', typeFilter, dateFrom, dateTo],
    queryFn: async () => {
      const url = queryString ? `/api/logbook?${queryString}` : '/api/logbook'
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch logbook entries')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch summary
  const summaryParams = new URLSearchParams()
  if (dateFrom) summaryParams.append('date_from', dateFrom)
  if (dateTo) summaryParams.append('date_to', dateTo)
  const summaryString = summaryParams.toString()

  const { data: summary } = useQuery<LogbookSummary>({
    queryKey: ['logbook-summary', dateFrom, dateTo],
    queryFn: async () => {
      const url = summaryString ? `/api/logbook/summary?${summaryString}` : '/api/logbook/summary'
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch summary')
      return res.json()
    },
    enabled: !!token,
  })

  const deleteMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await fetch(`/api/logbook/${entryId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete entry')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['logbook'] })
      queryClient.invalidateQueries({ queryKey: ['logbook-summary'] })
      setSelectedEntry(null)
    },
  })

  const getTypeLabel = (type: string) => entryTypeLabels[type] || type

  const getTypeSpecificInfo = (entry: LogbookEntry) => {
    switch (entry.entry_type) {
      case 'wastage':
        return `Reason: ${(entry.type_data?.reason as string || 'Unknown').replace(/_/g, ' ')}`
      case 'transfer':
        return `Status: ${(entry.type_data?.status as string || 'pending').replace(/_/g, ' ')}`
      case 'staff_food':
        return `Meal: ${entry.type_data?.meal_type || 'Unknown'}${entry.type_data?.staff_count ? ` (${entry.type_data.staff_count} staff)` : ''}`
      case 'manual_adjustment':
        return entry.type_data?.adjustment_reason ? `Reason: ${entry.type_data.adjustment_reason}` : ''
      default:
        return ''
    }
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading logbook...</div>
  }

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>Kitchen Logbook</h2>
        <button
          onClick={() => setShowCreateModal(true)}
          style={styles.createBtn}
        >
          + New Entry
        </button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div style={styles.summaryGrid}>
          <div style={styles.summaryCard}>
            <div style={styles.summaryValue}>{summary.total_entries}</div>
            <div style={styles.summaryLabel}>Total Entries</div>
          </div>
          <div style={styles.summaryCard}>
            <div style={styles.summaryValue}>£{summary.total_cost.toFixed(2)}</div>
            <div style={styles.summaryLabel}>Total Cost</div>
          </div>
          {Object.entries(summary.by_type).map(([type, data]) => (
            <div key={type} style={{ ...styles.summaryCard, borderLeft: `4px solid ${entryTypeColors[type] || '#999'}` }}>
              <div style={styles.summaryValue}>£{data.total_cost.toFixed(2)}</div>
              <div style={styles.summaryLabel}>{getTypeLabel(type)} ({data.count})</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={styles.filters}>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={styles.filterSelect}
        >
          <option value="">All Types</option>
          <option value="wastage">Wastage</option>
          <option value="transfer">Transfer</option>
          <option value="staff_food">Staff Food</option>
          <option value="manual_adjustment">Manual Adjustment</option>
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={styles.filterInput}
          placeholder="From date"
        />

        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={styles.filterInput}
          placeholder="To date"
        />

        {(typeFilter || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setTypeFilter('')
              setDateFrom('')
              setDateTo('')
            }}
            style={styles.clearBtn}
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Entries List */}
      {!entries || entries.length === 0 ? (
        <div style={styles.empty}>
          <p>No logbook entries found.</p>
          <button onClick={() => setShowCreateModal(true)} style={styles.link}>
            Create your first entry
          </button>
        </div>
      ) : (
        <div style={styles.list}>
          {entries.map((entry) => (
            <div
              key={entry.id}
              onClick={() => setSelectedEntry(entry)}
              style={styles.card}
            >
              <div style={styles.cardLeft}>
                <div
                  style={{
                    ...styles.typeBadge,
                    background: entryTypeColors[entry.entry_type] || '#999',
                  }}
                >
                  {getTypeLabel(entry.entry_type)}
                </div>
              </div>
              <div style={styles.cardMain}>
                <div style={styles.cardDate}>
                  {new Date(entry.entry_date).toLocaleDateString('en-GB', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {entry.reference_number && (
                    <span style={styles.refNumber}>Ref: {entry.reference_number}</span>
                  )}
                </div>
                <div style={styles.cardInfo}>
                  {getTypeSpecificInfo(entry)}
                </div>
                <div style={styles.cardItems}>
                  {entry.line_items.slice(0, 3).map((item, i) => (
                    <span key={i} style={styles.itemPill}>
                      {item.product_name} ({item.quantity})
                    </span>
                  ))}
                  {entry.line_items.length > 3 && (
                    <span style={styles.moreItems}>+{entry.line_items.length - 3} more</span>
                  )}
                </div>
                {entry.notes && (
                  <div style={styles.cardNotes}>
                    {entry.notes.length > 80 ? `${entry.notes.substring(0, 80)}...` : entry.notes}
                  </div>
                )}
              </div>
              <div style={styles.cardRight}>
                <div style={styles.amount}>£{entry.total_cost.toFixed(2)}</div>
                <div style={styles.cardMeta}>
                  {entry.line_items.length} item{entry.line_items.length !== 1 ? 's' : ''}
                </div>
                {entry.attachments.length > 0 && (
                  <div style={styles.attachmentBadge}>
                    {entry.attachments.length} attachment{entry.attachments.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Entry Detail Modal */}
      {selectedEntry && (
        <EntryDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onDelete={() => deleteMutation.mutate(selectedEntry.id)}
        />
      )}

      {/* Create Entry Modal */}
      {showCreateModal && (
        <CreateEntryModal
          entryType={createEntryType}
          setEntryType={setCreateEntryType}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false)
            queryClient.invalidateQueries({ queryKey: ['logbook'] })
            queryClient.invalidateQueries({ queryKey: ['logbook-summary'] })
          }}
        />
      )}
    </div>
  )
}

function EntryDetailModal({
  entry,
  onClose,
  onDelete,
}: {
  entry: LogbookEntry
  onClose: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>
            <span
              style={{
                ...styles.typeBadge,
                background: entryTypeColors[entry.entry_type] || '#999',
                marginRight: '0.75rem',
              }}
            >
              {entryTypeLabels[entry.entry_type] || entry.entry_type}
            </span>
            {new Date(entry.entry_date).toLocaleDateString('en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        <div style={styles.modalBody}>
          {/* Entry Info */}
          <div style={styles.detailGrid}>
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Total Cost</span>
              <span style={styles.detailValue}>£{entry.total_cost.toFixed(2)}</span>
            </div>
            {entry.reference_number && (
              <div style={styles.detailItem}>
                <span style={styles.detailLabel}>Reference</span>
                <span style={styles.detailValue}>{entry.reference_number}</span>
              </div>
            )}
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Created By</span>
              <span style={styles.detailValue}>{entry.created_by_name || `User #${entry.created_by}`}</span>
            </div>
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Created At</span>
              <span style={styles.detailValue}>
                {new Date(entry.created_at).toLocaleString('en-GB')}
              </span>
            </div>
          </div>

          {/* Type-specific info */}
          {entry.entry_type === 'wastage' && entry.type_data?.reason != null && (
            <div style={styles.typeInfo}>
              <strong>Reason:</strong> {String(entry.type_data.reason).replace(/_/g, ' ')}
            </div>
          )}
          {entry.entry_type === 'transfer' && (
            <div style={styles.typeInfo}>
              <strong>Status:</strong> {String(entry.type_data?.status || 'pending').replace(/_/g, ' ')}
            </div>
          )}
          {entry.entry_type === 'staff_food' && (
            <div style={styles.typeInfo}>
              <strong>Meal:</strong> {String(entry.type_data?.meal_type || 'Unknown')}
              {entry.type_data?.staff_count != null && <> | <strong>Staff Count:</strong> {Number(entry.type_data.staff_count)}</>}
            </div>
          )}
          {entry.entry_type === 'manual_adjustment' && entry.type_data?.adjustment_reason != null && (
            <div style={styles.typeInfo}>
              <strong>Adjustment Reason:</strong> {String(entry.type_data.adjustment_reason)}
            </div>
          )}

          {/* Notes */}
          {entry.notes && (
            <div style={styles.notesSection}>
              <strong>Notes:</strong>
              <p style={styles.notesText}>{entry.notes}</p>
            </div>
          )}

          {/* Line Items */}
          <div style={styles.lineItemsSection}>
            <h4 style={styles.sectionTitle}>Items ({entry.line_items.length})</h4>
            <table style={styles.lineItemsTable}>
              <thead>
                <tr>
                  <th style={styles.th}>Product</th>
                  <th style={styles.th}>Qty</th>
                  <th style={styles.th}>Unit Price</th>
                  <th style={styles.th}>Total</th>
                </tr>
              </thead>
              <tbody>
                {entry.line_items.map((item) => (
                  <tr key={item.id}>
                    <td style={styles.td}>
                      <div>{item.product_name}</div>
                      {item.product_code && (
                        <div style={styles.productCode}>{item.product_code}</div>
                      )}
                      {item.supplier_name && (
                        <div style={styles.supplierName}>{item.supplier_name}</div>
                      )}
                    </td>
                    <td style={styles.td}>
                      {item.quantity} {item.unit || ''}
                    </td>
                    <td style={styles.td}>
                      {item.unit_price != null ? `£${item.unit_price.toFixed(2)}` : '-'}
                    </td>
                    <td style={styles.td}>£{item.total_cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...styles.td, fontWeight: 'bold', textAlign: 'right' }}>
                    Total:
                  </td>
                  <td style={{ ...styles.td, fontWeight: 'bold' }}>
                    £{entry.total_cost.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Attachments */}
          {entry.attachments.length > 0 && (
            <div style={styles.attachmentsSection}>
              <h4 style={styles.sectionTitle}>Attachments ({entry.attachments.length})</h4>
              <div style={styles.attachmentsList}>
                {entry.attachments.map((att) => (
                  <div key={att.id} style={styles.attachmentItem}>
                    <span>{att.file_name}</span>
                    <span style={styles.attachmentSize}>
                      ({(att.file_size_bytes / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Delete Button */}
          <div style={styles.deleteSection}>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                style={styles.deleteBtn}
              >
                Delete Entry
              </button>
            ) : (
              <div style={styles.confirmDelete}>
                <span>Are you sure?</span>
                <button onClick={onDelete} style={styles.confirmYes}>Yes, Delete</button>
                <button onClick={() => setConfirmDelete(false)} style={styles.confirmNo}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CreateEntryModal({
  entryType,
  setEntryType,
  onClose,
  onSuccess,
}: {
  entryType: string
  setEntryType: (type: string) => void
  onClose: () => void
  onSuccess: () => void
}) {
  const { token } = useAuth()
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [wastageReason, setWastageReason] = useState('spoiled')
  const [mealType, setMealType] = useState('lunch')
  const [staffCount, setStaffCount] = useState<number | ''>('')
  const [adjustmentReason, setAdjustmentReason] = useState('')
  const [lineItems, setLineItems] = useState<LineItemInput[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<ProductSearchResult[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Product search
  const searchProducts = async (query: string) => {
    if (query.length < 2) {
      setProductResults([])
      return
    }
    try {
      const res = await fetch(`/api/logbook/products/search?query=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setProductResults(data)
      }
    } catch {
      // Ignore search errors
    }
  }

  const addLineItem = (product?: ProductSearchResult) => {
    const newItem: LineItemInput = {
      product_id: product?.id,
      product_name: product?.name || '',
      product_code: product?.product_code || undefined,
      supplier_name: product?.supplier_name || undefined,
      quantity: 1,
      unit: product?.unit || undefined,
      unit_price: product?.last_price || undefined,
      total_cost: product?.last_price || 0,
    }
    setLineItems([...lineItems, newItem])
    setProductSearch('')
    setProductResults([])
  }

  const updateLineItem = (index: number, field: keyof LineItemInput, value: unknown) => {
    const updated = [...lineItems]
    updated[index] = { ...updated[index], [field]: value }

    // Auto-calculate total cost
    if (field === 'quantity' || field === 'unit_price') {
      const qty = field === 'quantity' ? (value as number) : updated[index].quantity
      const price = field === 'unit_price' ? (value as number) : updated[index].unit_price
      updated[index].total_cost = (qty || 0) * (price || 0)
    }

    setLineItems(updated)
  }

  const removeLineItem = (index: number) => {
    setLineItems(lineItems.filter((_, i) => i !== index))
  }

  const getTotalCost = () => {
    return lineItems.reduce((sum, item) => sum + (item.total_cost || 0), 0)
  }

  const handleSubmit = async () => {
    if (lineItems.length === 0) {
      setError('Please add at least one item')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      let endpoint = '/api/logbook/'
      let body: Record<string, unknown> = {
        entry_date: entryDate,
        notes: notes || undefined,
        line_items: lineItems,
      }

      switch (entryType) {
        case 'wastage':
          endpoint += 'wastage'
          body.reason = wastageReason
          body.reference_number = referenceNumber || undefined
          break
        case 'transfer':
          endpoint += 'transfer'
          body.destination_kitchen_id = 1 // TODO: Make this selectable
          body.reference_number = referenceNumber || undefined
          break
        case 'staff_food':
          endpoint += 'staff-food'
          body.meal_type = mealType
          body.staff_count = staffCount || undefined
          break
        case 'manual_adjustment':
          endpoint += 'manual-adjustment'
          body.adjustment_reason = adjustmentReason
          body.reference_number = referenceNumber || undefined
          break
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to create entry')
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create entry')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: '1000px' }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>New Logbook Entry</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        <div style={styles.modalBody}>
          {error && <div style={styles.errorMsg}>{error}</div>}

          {/* Entry Type Selector */}
          <div style={styles.typeSelector}>
            {Object.entries(entryTypeLabels).map(([type, label]) => (
              <button
                key={type}
                onClick={() => setEntryType(type)}
                style={{
                  ...styles.typeBtn,
                  background: entryType === type ? entryTypeColors[type] : '#f0f0f0',
                  color: entryType === type ? 'white' : '#333',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Top Row: Date/Reason on left, Notes on right */}
          <div style={styles.topFieldsRow}>
            {/* Left column: Date and Type-specific fields */}
            <div style={styles.leftFieldsColumn}>
              <div style={styles.formGroup}>
                <label style={styles.label}>Date</label>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  style={styles.input}
                />
              </div>

              {/* Type-specific fields */}
              {entryType === 'wastage' && (
                <div style={styles.formGroup}>
                  <label style={styles.label}>Wastage Reason</label>
                  <select
                    value={wastageReason}
                    onChange={(e) => setWastageReason(e.target.value)}
                    style={styles.input}
                  >
                    {wastageReasons.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {entryType === 'transfer' && (
                <div style={styles.formGroup}>
                  <label style={styles.label}>Reference Number</label>
                  <input
                    type="text"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    style={styles.input}
                    placeholder="Optional"
                  />
                </div>
              )}

              {entryType === 'staff_food' && (
                <>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>Meal Type</label>
                    <select
                      value={mealType}
                      onChange={(e) => setMealType(e.target.value)}
                      style={styles.input}
                    >
                      {mealTypes.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>Staff Count</label>
                    <input
                      type="number"
                      value={staffCount}
                      onChange={(e) => setStaffCount(e.target.value ? parseInt(e.target.value) : '')}
                      style={styles.input}
                      placeholder="Optional"
                      min="1"
                    />
                  </div>
                </>
              )}

              {entryType === 'manual_adjustment' && (
                <div style={styles.formGroup}>
                  <label style={styles.label}>Adjustment Reason</label>
                  <input
                    type="text"
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    style={styles.input}
                    placeholder="e.g., Stock count correction"
                  />
                </div>
              )}
            </div>

            {/* Right column: Notes */}
            <div style={styles.rightFieldsColumn}>
              <div style={{ ...styles.formGroup, flex: 1, display: 'flex', flexDirection: 'column' }}>
                <label style={styles.label}>Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  style={{ ...styles.input, flex: 1, minHeight: '100px', resize: 'vertical' }}
                  placeholder="Optional notes..."
                />
              </div>
            </div>
          </div>

          {/* Wastage Line Items Section */}
          <div style={styles.lineItemsSection}>
            <h4 style={styles.sectionTitle}>Wastage Items ({lineItems.length})</h4>

            {/* Line Items Table */}
            <div style={styles.lineItemsTableContainer}>
              <table style={styles.lineItemsTable}>
                <thead>
                  <tr>
                    <th style={styles.th}>Product</th>
                    <th style={{ ...styles.th, width: '80px' }}>Qty</th>
                    <th style={{ ...styles.th, width: '100px' }}>Unit Price</th>
                    <th style={{ ...styles.th, width: '100px' }}>Total</th>
                    <th style={{ ...styles.th, width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ ...styles.td, textAlign: 'center', color: '#999', padding: '1.5rem' }}>
                        No items added yet. Search below or add manually.
                      </td>
                    </tr>
                  ) : (
                    lineItems.map((item, index) => (
                      <tr key={index}>
                        <td style={styles.td}>
                          <input
                            type="text"
                            value={item.product_name}
                            onChange={(e) => updateLineItem(index, 'product_name', e.target.value)}
                            style={styles.tableInput}
                            placeholder="Product name"
                          />
                          {item.supplier_name && (
                            <div style={{ fontSize: '0.75rem', color: '#3498db', marginTop: '2px' }}>{item.supplier_name}</div>
                          )}
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            value={item.quantity}
                            onChange={(e) => updateLineItem(index, 'quantity', parseFloat(e.target.value) || 0)}
                            style={styles.tableInput}
                            min="0"
                            step="0.01"
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            value={item.unit_price || ''}
                            onChange={(e) => updateLineItem(index, 'unit_price', e.target.value ? parseFloat(e.target.value) : undefined)}
                            style={styles.tableInput}
                            min="0"
                            step="0.01"
                            placeholder="£0.00"
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            value={item.total_cost}
                            onChange={(e) => updateLineItem(index, 'total_cost', parseFloat(e.target.value) || 0)}
                            style={styles.tableInput}
                            min="0"
                            step="0.01"
                          />
                        </td>
                        <td style={styles.td}>
                          <button
                            onClick={() => removeLineItem(index)}
                            style={styles.removeItemBtn}
                          >
                            &times;
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {lineItems.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ ...styles.td, fontWeight: 'bold', textAlign: 'right' }}>
                        Total:
                      </td>
                      <td style={{ ...styles.td, fontWeight: 'bold' }}>
                        £{getTotalCost().toFixed(2)}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {/* Manual Add Button */}
            <button
              onClick={() => addLineItem()}
              style={styles.manualAddBtn}
            >
              + Add Manual Item
            </button>
          </div>

          {/* Product Search Section */}
          <div style={styles.productSearchSection}>
            <h4 style={styles.sectionTitle}>Search Products</h4>
            <input
              type="text"
              value={productSearch}
              onChange={(e) => {
                setProductSearch(e.target.value)
                searchProducts(e.target.value)
              }}
              style={{ ...styles.input, marginBottom: '0.5rem' }}
              placeholder="Search by product name or code..."
            />
            <div style={styles.productSearchResultsContainer}>
              {productSearch.length < 2 ? (
                <div style={styles.searchPlaceholder}>
                  Type at least 2 characters to search products...
                </div>
              ) : productResults.length === 0 ? (
                <div style={styles.searchPlaceholder}>
                  No products found matching "{productSearch}"
                </div>
              ) : (
                <table style={styles.searchResultsTable}>
                  <thead>
                    <tr>
                      <th style={styles.searchTh}>Supplier</th>
                      <th style={styles.searchTh}>Description</th>
                      <th style={{ ...styles.searchTh, width: '80px' }}>Unit</th>
                      <th style={{ ...styles.searchTh, width: '80px' }}>Price</th>
                      <th style={{ ...styles.searchTh, width: '60px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {productResults.map((product, idx) => (
                      <tr key={`${idx}-${product.name}-${product.product_code || ''}`} style={styles.searchResultRow}>
                        <td style={styles.searchTd}>{product.supplier_name || '-'}</td>
                        <td style={styles.searchTd}>
                          {product.name}
                          {product.product_code && (
                            <span style={{ fontSize: '0.75rem', color: '#999', marginLeft: '0.5rem' }}>
                              ({product.product_code})
                            </span>
                          )}
                        </td>
                        <td style={styles.searchTd}>{product.unit || '-'}</td>
                        <td style={styles.searchTd}>
                          {product.last_price != null ? `£${product.last_price.toFixed(2)}` : '-'}
                        </td>
                        <td style={styles.searchTd}>
                          <button
                            onClick={() => addLineItem(product)}
                            style={styles.addFromSearchBtn}
                          >
                            Add
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Submit */}
          <div style={styles.submitRow}>
            <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
            <button
              onClick={handleSubmit}
              style={styles.submitBtn}
              disabled={isSubmitting || lineItems.length === 0}
            >
              {isSubmitting ? 'Creating...' : 'Create Entry'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
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
  createBtn: {
    padding: '0.75rem 1.5rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '1rem',
    marginBottom: '1.5rem',
  },
  summaryCard: {
    background: 'white',
    padding: '1rem',
    borderRadius: '8px',
    textAlign: 'center',
    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
  },
  summaryValue: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  summaryLabel: {
    fontSize: '0.85rem',
    color: '#666',
    marginTop: '0.25rem',
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
  filterInput: {
    padding: '0.5rem 1rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
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
    padding: '1rem',
    background: 'white',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    cursor: 'pointer',
    gap: '1rem',
  },
  cardLeft: {
    display: 'flex',
    alignItems: 'flex-start',
  },
  typeBadge: {
    padding: '0.35rem 0.75rem',
    borderRadius: '6px',
    fontSize: '0.75rem',
    fontWeight: 'bold',
    color: 'white',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  cardMain: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  cardDate: {
    fontSize: '1rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  refNumber: {
    fontSize: '0.8rem',
    color: '#666',
    fontWeight: 'normal',
  },
  cardInfo: {
    fontSize: '0.9rem',
    color: '#666',
  },
  cardItems: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    marginTop: '0.25rem',
  },
  itemPill: {
    padding: '0.2rem 0.5rem',
    background: '#f0f0f0',
    borderRadius: '4px',
    fontSize: '0.8rem',
    color: '#666',
  },
  moreItems: {
    fontSize: '0.8rem',
    color: '#999',
  },
  cardNotes: {
    fontSize: '0.85rem',
    color: '#888',
    fontStyle: 'italic',
    marginTop: '0.25rem',
  },
  cardRight: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.25rem',
  },
  amount: {
    fontSize: '1.25rem',
    fontWeight: 'bold',
    color: '#e94560',
  },
  cardMeta: {
    fontSize: '0.8rem',
    color: '#999',
  },
  attachmentBadge: {
    fontSize: '0.75rem',
    color: '#3498db',
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
    maxWidth: '700px',
    width: '95%',
    maxHeight: '90vh',
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
    display: 'flex',
    flexDirection: 'column',
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
    display: 'flex',
    alignItems: 'center',
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
    overflowY: 'auto',
    flex: 1,
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '1rem',
    marginBottom: '1rem',
    padding: '1rem',
    background: '#f8f8f8',
    borderRadius: '8px',
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
  },
  detailLabel: {
    fontSize: '0.75rem',
    color: '#666',
    textTransform: 'uppercase',
  },
  detailValue: {
    fontSize: '1rem',
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  typeInfo: {
    padding: '0.75rem 1rem',
    background: '#f0f0f0',
    borderRadius: '8px',
    marginBottom: '1rem',
  },
  notesSection: {
    marginBottom: '1rem',
  },
  notesText: {
    margin: '0.5rem 0 0 0',
    padding: '0.75rem',
    background: '#fafafa',
    borderRadius: '8px',
    fontStyle: 'italic',
    color: '#666',
  },
  lineItemsSection: {
    marginTop: '1.5rem',
  },
  sectionTitle: {
    margin: '0 0 1rem 0',
    color: '#1a1a2e',
    fontSize: '1.1rem',
  },
  lineItemsTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    padding: '0.75rem',
    textAlign: 'left',
    borderBottom: '2px solid #ddd',
    background: '#f8f8f8',
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
    verticalAlign: 'top',
  },
  productCode: {
    fontSize: '0.75rem',
    color: '#999',
  },
  supplierName: {
    fontSize: '0.75rem',
    color: '#3498db',
  },
  attachmentsSection: {
    marginTop: '1.5rem',
  },
  attachmentsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  attachmentItem: {
    padding: '0.5rem 0.75rem',
    background: '#f8f8f8',
    borderRadius: '4px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  attachmentSize: {
    fontSize: '0.8rem',
    color: '#999',
  },
  deleteSection: {
    marginTop: '2rem',
    paddingTop: '1rem',
    borderTop: '1px solid #eee',
  },
  deleteBtn: {
    padding: '0.75rem 1.5rem',
    background: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  confirmDelete: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  confirmYes: {
    padding: '0.5rem 1rem',
    background: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  confirmNo: {
    padding: '0.5rem 1rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  errorMsg: {
    padding: '1rem',
    background: '#fee',
    color: '#c00',
    borderRadius: '8px',
    marginBottom: '1rem',
  },
  typeSelector: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
  },
  typeBtn: {
    padding: '0.5rem 1rem',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
    transition: 'all 0.2s',
  },
  formRow: {
    display: 'flex',
    gap: '1rem',
    marginBottom: '1rem',
  },
  formGroup: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    marginBottom: '1rem',
  },
  topFieldsRow: {
    display: 'flex',
    gap: '1.5rem',
    marginBottom: '1.5rem',
  },
  leftFieldsColumn: {
    flex: '0 0 50%',
    display: 'flex',
    flexDirection: 'column',
  },
  rightFieldsColumn: {
    flex: '0 0 50%',
    display: 'flex',
    flexDirection: 'column',
  },
  lineItemsTableContainer: {
    maxHeight: '250px',
    overflowY: 'auto',
    border: '1px solid #ddd',
    borderRadius: '8px',
  },
  manualAddBtn: {
    marginTop: '0.75rem',
    padding: '0.5rem 1rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  productSearchSection: {
    marginTop: '1.5rem',
    padding: '1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
    border: '1px solid #e9ecef',
  },
  productSearchResultsContainer: {
    height: '200px',
    overflowY: 'auto',
    background: 'white',
    border: '1px solid #ddd',
    borderRadius: '8px',
  },
  searchPlaceholder: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#999',
    fontSize: '0.9rem',
  },
  searchResultsTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  searchTh: {
    padding: '0.5rem 0.75rem',
    textAlign: 'left',
    borderBottom: '2px solid #ddd',
    background: '#f8f8f8',
    position: 'sticky',
    top: 0,
    fontSize: '0.8rem',
  },
  searchTd: {
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid #eee',
    verticalAlign: 'middle',
  },
  searchResultRow: {
    cursor: 'pointer',
  },
  addFromSearchBtn: {
    padding: '0.35rem 0.75rem',
    background: '#27ae60',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.8rem',
  },
  label: {
    fontSize: '0.85rem',
    fontWeight: 'bold',
    color: '#333',
    marginBottom: '0.5rem',
  },
  input: {
    padding: '0.75rem',
    borderRadius: '8px',
    border: '1px solid #ccc',
    fontSize: '1rem',
  },
  productSearchContainer: {
    position: 'relative',
    marginBottom: '1rem',
  },
  searchResults: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    background: 'white',
    border: '1px solid #ccc',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    zIndex: 10,
    maxHeight: '200px',
    overflow: 'auto',
  },
  searchResultItem: {
    padding: '0.75rem 1rem',
    cursor: 'pointer',
    borderBottom: '1px solid #eee',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  productCodeSmall: {
    fontSize: '0.75rem',
    color: '#999',
    marginLeft: '0.5rem',
  },
  priceSmall: {
    fontSize: '0.8rem',
    color: '#27ae60',
    fontWeight: 'bold',
  },
  addItemBtn: {
    marginTop: '0.5rem',
    padding: '0.5rem 1rem',
    background: '#27ae60',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  tableInput: {
    width: '100%',
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: '4px',
    fontSize: '0.9rem',
  },
  removeItemBtn: {
    width: '24px',
    height: '24px',
    background: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
    lineHeight: 1,
  },
  submitRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '1rem',
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid #eee',
  },
  cancelBtn: {
    padding: '0.75rem 1.5rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  submitBtn: {
    padding: '0.75rem 1.5rem',
    background: '#27ae60',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
}
