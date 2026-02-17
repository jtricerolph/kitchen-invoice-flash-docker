import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useDebounce, getDefaultDateRange } from '../utils/searchHelpers'

interface LineItemResult {
  product_code: string | null
  description: string | null
  supplier_id: number | null
  supplier_name: string | null
  unit: string | null
  most_recent_price: number | null
  occurrence_count: number
  most_recent_invoice_id: number
  most_recent_date: string | null
  pack_quantity: number | null
  most_recent_line_item_id: number | null
  most_recent_line_number: number | null
  most_recent_raw_content: string | null
  most_recent_pack_quantity: number | null
  most_recent_unit_size: number | null
  most_recent_unit_size_type: string | null
}

interface SearchResponse {
  items: LineItemResult[]
  total_count: number
}

interface Supplier {
  id: number
  name: string
}

interface MapLineItemsModalProps {
  ingredient: {
    id: number
    name: string
    standard_unit: string
    yield_percent: number
    effective_price: number | null
  }
  onClose: () => void
  onSaved: () => void
}

// Unit conversion factors (same as Review.tsx)
const CONVERSIONS: Record<string, Record<string, number>> = {
  g: { g: 1, kg: 0.001 }, kg: { g: 1000, kg: 1 }, oz: { g: 28.3495, kg: 0.0283495 },
  ml: { ml: 1, ltr: 0.001 }, cl: { ml: 10, ltr: 0.01 }, ltr: { ml: 1000, ltr: 1 },
  each: { each: 1 },
}

function calcConversionDisplay(
  packQty: number, unitSize: number | null, unitSizeType: string,
  standardUnit: string, unitPrice: number | null
): string {
  if (!unitSize || !unitSizeType) return ''
  const conv = CONVERSIONS[unitSizeType]?.[standardUnit]
  if (!conv) return unitSizeType !== standardUnit ? `Cannot convert ${unitSizeType} \u2192 ${standardUnit}` : ''
  const totalStd = packQty * unitSize * conv
  const pricePerStd = unitPrice ? (unitPrice / totalStd) : null
  const packNote = packQty > 1 ? `${packQty} \u00d7 ${unitSize}${unitSizeType} = ` : ''
  let display = `${packNote}${totalStd.toFixed(totalStd % 1 ? 2 : 0)} ${standardUnit}`
  if (pricePerStd) {
    display += ` \u2192 \u00a3${pricePerStd.toFixed(4)} per ${standardUnit}`
    if (standardUnit === 'g') display += ` (\u00a3${(pricePerStd * 1000).toFixed(2)}/kg)`
    else if (standardUnit === 'ml') display += ` (\u00a3${(pricePerStd * 1000).toFixed(2)}/ltr)`
  }
  return display
}

export default function MapLineItemsModal({ ingredient, onClose, onSaved }: MapLineItemsModalProps) {
  const { token } = useAuth()
  const defaultDates = useMemo(() => getDefaultDateRange(), [])

  // Search state
  const [searchInput, setSearchInput] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [dateFrom] = useState(defaultDates.from)
  const [dateTo] = useState(defaultDates.to)
  const debouncedSearch = useDebounce(searchInput, 300)

  // Selected item + pack config
  const [selectedItem, setSelectedItem] = useState<LineItemResult | null>(null)
  const [packQty, setPackQty] = useState(1)
  const [unitSize, setUnitSize] = useState<string>('')
  const [unitSizeType, setUnitSizeType] = useState(ingredient.standard_unit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [previewError, setPreviewError] = useState(false)

  // Suppliers
  const { data: suppliers } = useQuery<Supplier[]>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return []
      const data = await res.json()
      return data.suppliers || data || []
    },
  })

  // Search results
  const { data: searchData, isLoading } = useQuery<SearchResponse>({
    queryKey: ['map-line-items-search', debouncedSearch, supplierId, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('q', debouncedSearch)
      if (supplierId) params.set('supplier_id', supplierId)
      params.set('date_from', dateFrom)
      params.set('date_to', dateTo)
      params.set('limit', '50')
      const res = await fetch(`/api/search/line-items?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return { items: [], total_count: 0 }
      return res.json()
    },
    enabled: debouncedSearch.length >= 2,
  })

  // When selecting a line item, auto-fill pack fields from DB values first
  const handleSelect = (item: LineItemResult) => {
    setSelectedItem(item)
    setPreviewError(false)
    setError('')
    setSuccessMsg('')

    // Prefer DB-stored pack values from the most recent line item
    if (item.most_recent_pack_quantity && item.most_recent_unit_size) {
      setPackQty(item.most_recent_pack_quantity)
      setUnitSize(Number(item.most_recent_unit_size).toString())
      setUnitSizeType(item.most_recent_unit_size_type || ingredient.standard_unit)
    } else {
      // Reset — useEffect regex fallback will attempt to parse from description
      setPackQty(1)
      setUnitSize('')
      setUnitSizeType(ingredient.standard_unit)
    }
  }

  // Conversion display
  const conversionDisplay = useMemo(() => {
    const us = parseFloat(unitSize)
    if (!us || !unitSizeType) return ''
    const price = selectedItem?.most_recent_price != null ? Number(selectedItem.most_recent_price) : null
    return calcConversionDisplay(packQty, us, unitSizeType, ingredient.standard_unit, price)
  }, [packQty, unitSize, unitSizeType, ingredient.standard_unit, selectedItem?.most_recent_price])

  // Fallback: auto-fill unitSize from description via client-side regex (only if DB had no pack data)
  useEffect(() => {
    if (!selectedItem) return
    // Skip if we already populated from DB values
    if (selectedItem.most_recent_pack_quantity && selectedItem.most_recent_unit_size) return

    const desc = selectedItem.description || ''
    const packMatch = desc.match(/(\d+)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\s*(g|kg|ml|ltr|l|oz|cl|gm|gms)\b/i)
    if (packMatch) {
      setPackQty(parseInt(packMatch[1]))
      setUnitSize(packMatch[2])
      let ut = packMatch[3].toLowerCase()
      if (ut === 'l') ut = 'ltr'
      if (ut === 'gm' || ut === 'gms') ut = 'g'
      setUnitSizeType(ut)
      return
    }
    const standaloneMatch = desc.match(/(\d+(?:\.\d+)?)\s*(g|kg|ml|ltr|l|oz|cl|gm|gms|gram|grams|kilo|kilos|kilogram|litre|litres|liter)\b/i)
    if (standaloneMatch) {
      setPackQty(1)
      setUnitSize(standaloneMatch[1])
      let ut = standaloneMatch[2].toLowerCase()
      if (ut === 'l' || ut === 'litre' || ut === 'litres' || ut === 'liter') ut = 'ltr'
      if (ut === 'gm' || ut === 'gms' || ut === 'gram' || ut === 'grams') ut = 'g'
      if (ut === 'kilo' || ut === 'kilos' || ut === 'kilogram') ut = 'kg'
      setUnitSizeType(ut)
    }
  }, [selectedItem])

  const handleSave = async () => {
    if (!selectedItem) return
    setSaving(true)
    setError('')
    setSuccessMsg('')

    try {
      const sourceData: Record<string, unknown> = {
        supplier_id: selectedItem.supplier_id,
        pack_quantity: packQty || 1,
        unit_size: parseFloat(unitSize) || null,
        unit_size_type: unitSizeType || null,
        apply_to_existing: true,
      }

      if (selectedItem.product_code) {
        sourceData.product_code = selectedItem.product_code
      } else if (selectedItem.description) {
        sourceData.description_pattern = selectedItem.description.substring(0, 100).toLowerCase().trim()
      }

      if (selectedItem.most_recent_price) {
        sourceData.latest_unit_price = selectedItem.most_recent_price
      }
      if (selectedItem.most_recent_invoice_id) {
        sourceData.invoice_id = selectedItem.most_recent_invoice_id
      }

      const res = await fetch(`/api/ingredients/${ingredient.id}/sources`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sourceData),
      })

      if (res.ok) {
        const data = await res.json()
        const count = data.matched_line_items
        setSuccessMsg(`Source created${count ? ` \u2014 ${count} line item${count > 1 ? 's' : ''} mapped` : ''}`)
        setTimeout(() => onSaved(), 1200)
      } else if (res.status === 409) {
        setError('This supplier product is already mapped to this ingredient')
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.detail || 'Failed to create source')
      }
    } catch (err) {
      setError('Network error')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  // Preview URL for the selected line item
  const previewUrl = selectedItem?.most_recent_invoice_id && selectedItem?.most_recent_line_number != null
    ? `/api/invoices/${selectedItem.most_recent_invoice_id}/line-items/${selectedItem.most_recent_line_number}/preview?token=${token}`
    : null

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Map Line Items to "{ingredient.name}"</h3>
          <button onClick={onClose} style={styles.closeBtn}>{'\u2715'}</button>
        </div>

        {/* Context bar */}
        <div style={styles.contextBar}>
          <span><strong>{ingredient.name}</strong></span>
          <span>Unit: {ingredient.standard_unit}</span>
          {ingredient.effective_price != null && (
            <span>Current: {'\u00a3'}{Number(ingredient.effective_price).toFixed(4)}/{ingredient.standard_unit}</span>
          )}
        </div>

        <div style={styles.body}>
          {/* Search controls */}
          <div style={styles.searchRow}>
            <input
              value={searchInput}
              onChange={(e) => { setSearchInput(e.target.value); setSelectedItem(null); setError(''); setSuccessMsg('') }}
              style={{ ...styles.input, flex: 2 }}
              placeholder="Search by product code or description..."
              autoFocus
            />
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              style={{ ...styles.input, flex: 1, minWidth: '140px' }}
            >
              <option value="">All Suppliers</option>
              {suppliers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* Results table */}
          {debouncedSearch.length >= 2 && (
            <div style={styles.resultsContainer}>
              {isLoading ? (
                <div style={{ padding: '1rem', color: '#888', textAlign: 'center' }}>Searching...</div>
              ) : !searchData?.items.length ? (
                <div style={{ padding: '1rem', color: '#888', textAlign: 'center' }}>No line items found</div>
              ) : (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Description</th>
                      <th style={styles.th}>Supplier</th>
                      <th style={styles.th}>Price</th>
                      <th style={styles.th}>#</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchData.items.map((item, idx) => {
                      const isSelected = selectedItem === item
                      return (
                        <tr
                          key={`${item.product_code || ''}-${item.supplier_id}-${idx}`}
                          style={{
                            ...styles.tr,
                            background: isSelected ? '#e8f5e9' : undefined,
                            cursor: 'pointer',
                          }}
                          onClick={() => handleSelect(item)}
                        >
                          <td style={styles.td}>
                            {item.product_code && (
                              <span style={{ color: '#888', fontSize: '0.75rem', marginRight: '0.35rem' }}>{item.product_code}</span>
                            )}
                            {item.description}
                          </td>
                          <td style={styles.td}>{item.supplier_name || '-'}</td>
                          <td style={styles.td}>
                            {item.most_recent_price != null ? `\u00a3${Number(item.most_recent_price).toFixed(2)}` : '-'}
                          </td>
                          <td style={styles.td}>{item.occurrence_count}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* OCR bounding box preview */}
          {selectedItem && previewUrl && !previewError && (
            <div style={styles.previewContainer}>
              <img
                src={previewUrl}
                alt="Line item preview"
                style={styles.previewImage}
                onError={() => setPreviewError(true)}
              />
            </div>
          )}

          {/* Pack config - shown when a line item is selected */}
          {selectedItem && (
            <div style={styles.packSection}>
              <label style={styles.label}>
                How much {ingredient.name} is in "{selectedItem.description}"?
              </label>
              <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '0.5rem' }}>
                {selectedItem.supplier_name}
                {selectedItem.most_recent_price != null ? ` \u2014 \u00a3${Number(selectedItem.most_recent_price).toFixed(2)}` : ''}
              </div>

              {/* Raw OCR content for context */}
              {selectedItem.most_recent_raw_content && selectedItem.most_recent_raw_content !== selectedItem.description && (
                <div style={styles.rawContent}>
                  {selectedItem.most_recent_raw_content}
                </div>
              )}

              <div style={styles.packRow}>
                <div style={{ flex: 1 }}>
                  <div style={styles.packLabel}>Contains</div>
                  <input
                    type="number"
                    value={unitSize}
                    onChange={(e) => setUnitSize(e.target.value)}
                    style={styles.input}
                    step="0.1"
                    min="0"
                    placeholder="Size"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={styles.packLabel}>Unit</div>
                  <select
                    value={unitSizeType}
                    onChange={(e) => setUnitSizeType(e.target.value)}
                    style={styles.input}
                  >
                    <option value="each">each</option>
                    <option value="g">g</option>
                    <option value="kg">kg</option>
                    <option value="ml">ml</option>
                    <option value="ltr">ltr</option>
                    <option value="oz">oz</option>
                    <option value="cl">cl</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={styles.packLabel}>Pack of</div>
                  <input
                    type="number"
                    value={packQty}
                    onChange={(e) => setPackQty(parseInt(e.target.value) || 1)}
                    style={styles.input}
                    min="1"
                    step="1"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={styles.packLabel}>Line Price</div>
                  <div style={{ ...styles.input, background: '#f5f5f5', display: 'flex', alignItems: 'center' }}>
                    {selectedItem.most_recent_price != null ? `\u00a3${Number(selectedItem.most_recent_price).toFixed(2)}` : '--'}
                  </div>
                </div>
              </div>

              {conversionDisplay && (
                <div style={styles.conversionBar}>
                  {conversionDisplay}
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          {error && <div style={styles.errorMsg}>{error}</div>}
          {successMsg && <div style={styles.successMsg}>{successMsg}</div>}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={!selectedItem || saving}
            style={{ ...styles.primaryBtn, opacity: !selectedItem || saving ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Save & Map'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '750px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  contextBar: { display: 'flex', gap: '1rem', padding: '0.5rem 1.25rem', background: '#f8f9fa', borderBottom: '1px solid #eee', fontSize: '0.8rem', color: '#555', flexWrap: 'wrap' },
  body: { padding: '1rem 1.25rem', overflow: 'auto', flex: 1 },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.25rem', borderTop: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  searchRow: { display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' },
  input: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.85rem', boxSizing: 'border-box' as const },
  label: { fontWeight: 600, fontSize: '0.85rem', display: 'block', marginBottom: '0.25rem' },
  resultsContainer: { maxHeight: '220px', overflow: 'auto', border: '1px solid #e0e0e0', borderRadius: '6px', marginBottom: '0.75rem' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '0.4rem 0.6rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.75rem', fontWeight: 600, color: '#555', position: 'sticky' as const, top: 0 },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.4rem 0.6rem', fontSize: '0.8rem' },
  previewContainer: { marginBottom: '0.75rem', borderRadius: '6px', overflow: 'hidden', border: '2px solid #ffc107', boxShadow: '0 0 8px rgba(255, 193, 7, 0.3)' },
  previewImage: { width: '100%', display: 'block', maxHeight: '80px', objectFit: 'contain' as const, background: '#fff' },
  rawContent: { fontSize: '0.75rem', color: '#999', fontFamily: 'monospace', marginBottom: '0.5rem', padding: '0.35rem 0.5rem', background: '#f0f0f0', borderRadius: '4px', whiteSpace: 'pre-wrap' as const, lineHeight: 1.3 },
  packSection: { background: '#f8f9fa', padding: '0.75rem', borderRadius: '6px', marginTop: '0.5rem' },
  packRow: { display: 'flex', gap: '0.5rem', alignItems: 'flex-end' },
  packLabel: { fontSize: '0.7rem', fontWeight: 600, color: '#888', marginBottom: '0.2rem' },
  conversionBar: { marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: '#e8f5e9', borderRadius: '6px', fontSize: '0.85rem', color: '#2e7d32', fontWeight: 500 },
  errorMsg: { marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: '#fdecea', borderRadius: '6px', fontSize: '0.85rem', color: '#c62828' },
  successMsg: { marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: '#e8f5e9', borderRadius: '6px', fontSize: '0.85rem', color: '#2e7d32' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
}
