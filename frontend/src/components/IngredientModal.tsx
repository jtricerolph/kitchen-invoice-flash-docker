import { useState, useEffect, useMemo, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useDebounce } from '../utils/searchHelpers'
import IngredientFlagEditor, { AllergenSuggestion } from './IngredientFlagEditor'
import ImageCropModal from './ImageCropModal'
import {
  IngredientCategory,
  SimilarIngredient,
  LineItemResult,
  EditingIngredient,
  IngredientModalResult,
  calcConversionDisplay,
  parsePackFromDescription,
} from '../utils/ingredientHelpers'

// ── Supplier product lookup config (add entries here for new suppliers) ──────
interface SupplierLookup {
  key: string           // unique identifier
  namePattern: RegExp   // match against supplier_name
  label: string         // display label e.g. "Fetch Brakes"
  color: string         // accent color for button/border
  endpoint: string      // API endpoint path
  paramName: string     // query param name for product code
}

const SUPPLIER_LOOKUPS: SupplierLookup[] = [
  {
    key: 'brakes',
    namePattern: /brakes/i,
    label: 'Fetch Brakes',
    color: '#f59e0b',
    endpoint: '/api/food-flags/brakes-lookup',
    paramName: 'product_code',
  },
  // To add another supplier, add an entry here:
  // { key: 'bidfood', namePattern: /bidfood/i, label: 'Fetch Bidfood', color: '#3b82f6', endpoint: '/api/food-flags/bidfood-lookup', paramName: 'product_code' },
]

function getSupplierLookup(supplierName: string | null | undefined): SupplierLookup | null {
  if (!supplierName) return null
  return SUPPLIER_LOOKUPS.find(l => l.namePattern.test(supplierName)) || null
}

interface IngredientModalProps {
  open: boolean
  onClose: () => void
  onSaved?: (result: IngredientModalResult) => void
  editingIngredient?: EditingIngredient | null
  prePopulateName?: string
  preSelectLineItem?: LineItemResult | null
}

export default function IngredientModal({
  open,
  onClose,
  onSaved,
  editingIngredient,
  prePopulateName,
  preSelectLineItem,
}: IngredientModalProps) {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  // Form state
  const [formName, setFormName] = useState('')
  const [formCategory, setFormCategory] = useState<string>('')
  const [formUnit, setFormUnit] = useState('g')
  const [formYield, setFormYield] = useState('100')
  const [formPrice, setFormPrice] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [duplicateWarnings, setDuplicateWarnings] = useState<SimilarIngredient[]>([])

  // Line item mapping
  const [liSearch, setLiSearch] = useState('')
  const [liSupplierId, setLiSupplierId] = useState('')
  const [selectedLi, setSelectedLi] = useState<LineItemResult | null>(null)
  const [liPackQty, setLiPackQty] = useState(1)
  const [liUnitSize, setLiUnitSize] = useState('')
  const [liUnitSizeType, setLiUnitSizeType] = useState('g')
  const [liMappingError, setLiMappingError] = useState('')

  // Pending flags for create mode
  const [pendingFlagIds, setPendingFlagIds] = useState<number[]>([])
  const [pendingNoneCatIds, setPendingNoneCatIds] = useState<number[]>([])

  // Prepackaged ingredient fields
  const [formPrepackaged, setFormPrepackaged] = useState(false)
  const [formProductIngredients, setFormProductIngredients] = useState('')
  const [scanResult, setScanResult] = useState<{ raw_text: string; suggested_flags: AllergenSuggestion[] } | null>(null)
  const [scanning, setScanning] = useState(false)
  const [labelPreview, setLabelPreview] = useState<string | null>(null)
  const [showLabelModal, setShowLabelModal] = useState(false)
  const [showLineItemPreview, setShowLineItemPreview] = useState(false)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [supplierFetching, setSupplierFetching] = useState(false)
  const [supplierManualCode, setSupplierManualCode] = useState('')
  const [supplierAutoApplyIds, setSupplierAutoApplyIds] = useState<number[]>([])

  // Track if initial supplier fetch is needed (set during init, consumed by separate effect)
  const [pendingSupplierFetch, setPendingSupplierFetch] = useState<string | null>(null)

  // ---- Queries ----

  const { data: categories } = useQuery<IngredientCategory[]>({
    queryKey: ['ingredient-categories'],
    queryFn: async () => {
      const res = await fetch('/api/ingredients/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch categories')
      return res.json()
    },
    enabled: !!token && open,
  })

  const { data: liSuppliers } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return []
      const data = await res.json()
      return data.suppliers || data || []
    },
    enabled: !!token && open,
  })

  const debouncedLiSearch = useDebounce(liSearch, 300)
  const { data: liResults, isLoading: liSearching } = useQuery<{ items: LineItemResult[]; total_count: number }>({
    queryKey: ['ing-modal-li-search', debouncedLiSearch, liSupplierId],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedLiSearch) params.set('q', debouncedLiSearch)
      if (liSupplierId) params.set('supplier_id', liSupplierId)
      params.set('limit', '20')
      const res = await fetch(`/api/search/line-items?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return { items: [], total_count: 0 }
      return res.json()
    },
    enabled: !!token && open && debouncedLiSearch.length >= 2,
  })

  // ---- Helpers ----

  const isSelectedLi = (item: LineItemResult) =>
    selectedLi != null &&
    item.product_code === selectedLi.product_code &&
    item.description === selectedLi.description &&
    item.supplier_id === selectedLi.supplier_id

  // ---- Computed ----

  const liConversionDisplay = useMemo(() => {
    const us = parseFloat(liUnitSize)
    if (!us || !liUnitSizeType || !selectedLi) return ''
    const price = selectedLi.most_recent_price != null ? Number(selectedLi.most_recent_price) : null
    return calcConversionDisplay(liPackQty, us, liUnitSizeType, formUnit, price)
  }, [liPackQty, liUnitSize, liUnitSizeType, formUnit, selectedLi])

  // ---- Functions ----

  const resetAllState = () => {
    setFormName('')
    setFormCategory('')
    setFormUnit('g')
    setFormYield('100')
    setFormPrice('')
    setFormNotes('')
    setDuplicateWarnings([])
    setLiSearch('')
    setLiSupplierId('')
    setSelectedLi(null)
    setLiPackQty(1)
    setLiUnitSize('')
    setLiUnitSizeType('g')
    setLiMappingError('')
    setPendingFlagIds([])
    setPendingNoneCatIds([])
    setFormPrepackaged(false)
    setFormProductIngredients('')
    setScanResult(null)
    setScanning(false)
    setLabelPreview(null)
    setShowLabelModal(false)
    setShowLineItemPreview(false)
    setCropFile(null)
    setSupplierFetching(false)
    setSupplierManualCode('')
    setSupplierAutoApplyIds([])
    setPendingSupplierFetch(null)
  }

  const handleClose = () => {
    resetAllState()
    onClose()
  }

  const activeLookup = useMemo(() => getSupplierLookup(selectedLi?.supplier_name), [selectedLi?.supplier_name])

  const fetchSupplierProduct = async (productCode: string, lookup: SupplierLookup, force = false) => {
    setSupplierFetching(true)
    try {
      const params = new URLSearchParams({ [lookup.paramName]: productCode })
      if (force) params.set('force', 'true')
      const res = await fetch(`${lookup.endpoint}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        if (data.found) {
          setFormPrepackaged(true)
          let ingText = data.ingredients_text || ''
          if (data.contains_allergens?.length > 0) {
            ingText += `\nContains: ${data.contains_allergens.join(', ')}`
          } else if (ingText) {
            ingText += '\nContains: None of the 14 Food Allergens'
          }
          if (data.suitable_for?.length > 0) {
            ingText += `\nSuitable for: ${data.suitable_for.join(', ')}`
          }
          setFormProductIngredients(ingText)
          setScanResult({
            raw_text: data.ingredients_text || '',
            suggested_flags: data.suggested_flags || [],
          })
          const autoApplyIds = (data.suggested_flags || [])
            .filter((f: { source: string }) => f.source === 'contains' || f.source === 'dietary')
            .map((f: { flag_id: number }) => f.flag_id)
          if (autoApplyIds.length > 0) setSupplierAutoApplyIds(autoApplyIds)
        }
      }
    } catch { /* ignore */ }
    setSupplierFetching(false)
  }

  const handleScanLabel = async (file: File) => {
    setScanning(true)
    setScanResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const reader = new FileReader()
      reader.onload = (e) => setLabelPreview(e.target?.result as string)
      reader.readAsDataURL(file)
      const url = editingIngredient
        ? `/api/food-flags/scan-label/${editingIngredient.id}`
        : '/api/food-flags/scan-label'
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (res.ok) {
        const data = await res.json()
        setScanResult(data)
        if (data.raw_text) setFormProductIngredients(data.raw_text)
      }
    } catch { /* ignore */ }
    setScanning(false)
  }

  const createSourceMapping = async (ingredientId: number) => {
    if (!selectedLi || !token) return
    try {
      const sourceData: Record<string, unknown> = {
        supplier_id: selectedLi.supplier_id,
        pack_quantity: liPackQty || 1,
        unit_size: parseFloat(liUnitSize) || null,
        unit_size_type: liUnitSizeType || null,
        apply_to_existing: true,
      }
      if (selectedLi.product_code) {
        sourceData.product_code = selectedLi.product_code
      } else if (selectedLi.description) {
        sourceData.description_pattern = selectedLi.description.substring(0, 100).toLowerCase().trim()
      }
      if (selectedLi.most_recent_price) sourceData.latest_unit_price = selectedLi.most_recent_price
      if (selectedLi.most_recent_invoice_id) sourceData.invoice_id = selectedLi.most_recent_invoice_id
      const srcRes = await fetch(`/api/ingredients/${ingredientId}/sources`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sourceData),
      })
      if (!srcRes.ok) {
        const errBody = await srcRes.json().catch(() => ({}))
        setLiMappingError(errBody.detail || 'Saved but source mapping failed')
      }
    } catch {
      setLiMappingError('Saved but source mapping failed (network error)')
    }
  }

  const applyPendingFlags = async (ingredientId: number) => {
    if (pendingFlagIds.length > 0) {
      try {
        await fetch(`/api/ingredients/${ingredientId}/flags`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ food_flag_ids: pendingFlagIds }),
        })
      } catch { /* ignore */ }
    }
    for (const catId of pendingNoneCatIds) {
      try {
        await fetch(`/api/ingredients/${ingredientId}/flags/none`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ category_id: catId }),
        })
      } catch { /* ignore */ }
    }
  }

  // ---- Effects ----

  // Initialize form when modal opens
  useEffect(() => {
    if (!open) return
    if (editingIngredient) {
      setFormName(editingIngredient.name)
      setFormCategory(editingIngredient.category_id?.toString() || '')
      setFormUnit(editingIngredient.standard_unit)
      setFormYield(editingIngredient.yield_percent.toString())
      setFormPrice(editingIngredient.manual_price?.toString() || '')
      setFormNotes(editingIngredient.notes || '')
      setFormPrepackaged(editingIngredient.is_prepackaged || false)
      setFormProductIngredients(editingIngredient.product_ingredients || '')
      setLabelPreview(editingIngredient.has_label_image ? `/api/ingredients/${editingIngredient.id}/label-image?token=${encodeURIComponent(token || '')}` : null)
      setLiSearch(editingIngredient.name)
    } else {
      const name = prePopulateName || ''
      setFormName(name)
      setLiSearch(preSelectLineItem?.description || name)
      if (preSelectLineItem) {
        setSelectedLi(preSelectLineItem)
        if (preSelectLineItem.most_recent_pack_quantity && preSelectLineItem.most_recent_unit_size) {
          setLiPackQty(preSelectLineItem.most_recent_pack_quantity)
          setLiUnitSize(Number(preSelectLineItem.most_recent_unit_size).toString())
          setLiUnitSizeType(preSelectLineItem.most_recent_unit_size_type || 'g')
        } else {
          const parsed = parsePackFromDescription(preSelectLineItem.description || '')
          if (parsed) {
            setLiPackQty(parsed.qty)
            setLiUnitSize(parsed.size)
            setLiUnitSizeType(parsed.type)
          }
        }
        const lookup = getSupplierLookup(preSelectLineItem.supplier_name)
        if (lookup && preSelectLineItem.product_code) {
          setSupplierManualCode(preSelectLineItem.product_code)
          setPendingSupplierFetch(preSelectLineItem.product_code)
        }
      }
    }
  }, [open])

  // Handle deferred supplier fetch (triggered from init effect)
  useEffect(() => {
    if (pendingSupplierFetch && token && activeLookup) {
      const code = pendingSupplierFetch
      setPendingSupplierFetch(null)
      fetchSupplierProduct(code, activeLookup)
    }
  }, [pendingSupplierFetch, token, activeLookup])

  // Duplicate check
  useEffect(() => {
    if (!formName || formName.length < 3 || !token || !open) {
      setDuplicateWarnings([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ingredients/check-duplicate?name=${encodeURIComponent(formName)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          setDuplicateWarnings(data.filter((d: SimilarIngredient) => editingIngredient ? d.id !== editingIngredient.id : true))
        }
      } catch { /* ignore */ }
    }, 500)
    return () => clearTimeout(timer)
  }, [formName, token, editingIngredient?.id, open])

  // ---- Mutations ----

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/ingredients', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to create')
      }
      return res.json()
    },
    onSuccess: async (newIng: { id: number; name: string; standard_unit: string }) => {
      if (selectedLi) await createSourceMapping(newIng.id)
      await applyPendingFlags(newIng.id)
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      queryClient.invalidateQueries({ queryKey: ['ingredient-sources'] })
      onSaved?.({ id: newIng.id, name: newIng.name, standard_unit: newIng.standard_unit })
      handleClose()
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const res = await fetch(`/api/ingredients/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
      return res.json()
    },
    onSuccess: async (_data: unknown, variables: { id: number; data: Record<string, unknown> }) => {
      if (selectedLi) await createSourceMapping(variables.id)
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      queryClient.invalidateQueries({ queryKey: ['ingredient-sources'] })
      onSaved?.({ id: variables.id, name: formName, standard_unit: formUnit })
      handleClose()
    },
  })

  const handleSave = () => {
    const data: Record<string, unknown> = {
      name: formName,
      category_id: formCategory ? parseInt(formCategory) : null,
      standard_unit: formUnit,
      yield_percent: parseFloat(formYield),
      manual_price: !selectedLi && formPrice ? parseFloat(formPrice) : null,
      notes: formNotes || null,
      is_prepackaged: formPrepackaged,
      product_ingredients: formPrepackaged ? (formProductIngredients || null) : null,
    }
    if (editingIngredient) {
      updateMutation.mutate({ id: editingIngredient.id, data })
    } else {
      createMutation.mutate(data)
    }
  }

  const handleLineItemSelect = (item: LineItemResult) => {
    setSelectedLi(item)
    setFormPrice('')
    if (item.most_recent_pack_quantity && item.most_recent_unit_size) {
      setLiPackQty(item.most_recent_pack_quantity)
      setLiUnitSize(Number(item.most_recent_unit_size).toString())
      setLiUnitSizeType(item.most_recent_unit_size_type || formUnit)
    } else {
      const parsed = parsePackFromDescription(item.description || '')
      if (parsed) {
        setLiPackQty(parsed.qty)
        setLiUnitSize(parsed.size)
        setLiUnitSizeType(parsed.type)
      } else {
        setLiPackQty(1)
        setLiUnitSize('')
        setLiUnitSizeType(formUnit)
      }
    }
    const lookup = getSupplierLookup(item.supplier_name)
    if (lookup && item.product_code) {
      setSupplierManualCode(item.product_code)
      fetchSupplierProduct(item.product_code, lookup)
    }
  }

  // ---- Render ----

  if (!open) return null

  return (
    <div style={styles.overlay}>
      <div style={{ ...styles.modal, width: '850px' }}>
        <div style={styles.modalHeader}>
          <h3 style={{ margin: 0 }}>{editingIngredient ? 'Edit Ingredient' : 'Create Ingredient'}</h3>
          <button onClick={handleClose} style={styles.closeBtn}>{'\u2715'}</button>
        </div>
        <div style={{ ...styles.modalBody, display: 'flex', gap: '1.5rem' }}>
          {/* Left column: ingredient fields */}
          <div style={{ flex: '0 0 280px' }}>
            <label style={styles.label}>Name *</label>
            <input value={formName} onChange={(e) => setFormName(e.target.value)} style={styles.input} placeholder="e.g. Butter, Minced Beef 80/20" />
            {duplicateWarnings.length > 0 && (
              <div style={styles.warning}>
                Similar ingredients exist: {duplicateWarnings.map(d => `${d.name} (${Math.round(d.similarity * 100)}%)`).join(', ')}
              </div>
            )}

            {/* Type toggle */}
            <div style={{ display: 'flex', marginTop: '0.6rem', borderRadius: '6px', overflow: 'hidden', border: '1px solid #ddd' }}>
              <button
                type="button"
                onClick={() => setFormPrepackaged(false)}
                style={{
                  flex: 1,
                  padding: '0.4rem 0.5rem',
                  border: 'none',
                  background: !formPrepackaged ? '#1a1a2e' : '#f5f5f5',
                  color: !formPrepackaged ? 'white' : '#888',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  letterSpacing: '0.03em',
                }}
              >
                RAW INGREDIENT
              </button>
              <button
                type="button"
                onClick={() => setFormPrepackaged(true)}
                style={{
                  flex: 1,
                  padding: '0.4rem 0.5rem',
                  border: 'none',
                  borderLeft: '1px solid #ddd',
                  background: formPrepackaged ? '#6366f1' : '#f5f5f5',
                  color: formPrepackaged ? 'white' : '#888',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  letterSpacing: '0.03em',
                }}
              >
                PACKAGED PRODUCT
              </button>
            </div>

            <label style={styles.label}>Category</label>
            <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)} style={styles.input}>
              <option value="">None</option>
              {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            <div style={styles.row}>
              <div style={{ flex: 1 }}>
                <label style={styles.label}>Standard Unit</label>
                <select value={formUnit} onChange={(e) => setFormUnit(e.target.value)} style={styles.input}>
                  <option value="g">g (grams)</option>
                  <option value="kg">kg (kilograms)</option>
                  <option value="ml">ml (millilitres)</option>
                  <option value="ltr">ltr (litres)</option>
                  <option value="each">each</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={styles.label}>Yield %</label>
                <input type="number" value={formYield} onChange={(e) => setFormYield(e.target.value)} style={styles.input} min="1" max="100" step="0.5" />
              </div>
            </div>

            {!selectedLi && (
              <>
                <label style={styles.label}>Manual Price (per {formUnit}, optional)</label>
                <input type="number" value={formPrice} onChange={(e) => setFormPrice(e.target.value)} style={styles.input} step="0.0001" placeholder="Only if no line item linked" />
              </>
            )}
            {selectedLi && (
              <div style={{ marginTop: '0.5rem', padding: '0.4rem 0.6rem', background: '#e8f5e9', borderRadius: '6px', fontSize: '0.8rem', color: '#2e7d32' }}>
                Price from supplier source
              </div>
            )}

            <label style={styles.label}>Notes</label>
            <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} style={{ ...styles.input, minHeight: '50px' }} placeholder="Optional notes..." />

            {formPrepackaged && (
              <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #e0e0e0' }}>
                <label style={{ ...styles.label, marginTop: 0 }}>Product Ingredients</label>
                <textarea
                  value={formProductIngredients}
                  onChange={(e) => setFormProductIngredients(e.target.value)}
                  style={{ ...styles.input, minHeight: '60px', fontSize: '0.8rem' }}
                  placeholder="Ingredients list from product label..."
                />
                <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.35rem' }}>
                  <label style={{
                    padding: '0.3rem 0.6rem',
                    border: '1px solid #6366f1',
                    borderRadius: '4px',
                    background: scanning ? '#e0e0e0' : '#6366f1',
                    color: 'white',
                    cursor: scanning ? 'default' : 'pointer',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}>
                    {scanning ? 'Scanning...' : '\uD83D\uDCF7 Scan Label'}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) setCropFile(file)
                        e.target.value = ''
                      }}
                      disabled={scanning}
                    />
                  </label>
                  {labelPreview && (
                    <button
                      onClick={() => setShowLabelModal(true)}
                      style={{
                        padding: '0.3rem 0.6rem',
                        border: '1px solid #ccc',
                        borderRadius: '4px',
                        background: 'white',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        color: '#555',
                      }}
                    >
                      {'\uD83D\uDDBC'} View Label
                    </button>
                  )}
                </div>
                {scanning && (
                  <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', color: '#6366f1' }}>
                    Analysing label image...
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column: line item mapping */}
          <div style={{ flex: 1, borderLeft: '1px solid #eee', paddingLeft: '1.5rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem', color: '#555' }}>Link to Supplier Line Item</div>
            <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '0.5rem' }}>Optional — search invoiced items to auto-map pricing</div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                value={liSearch}
                onChange={(e) => { setLiSearch(e.target.value); setSelectedLi(null); setLiMappingError('') }}
                style={{ ...styles.input, flex: 2 }}
                placeholder="Search line items..."
              />
              <select
                value={liSupplierId}
                onChange={(e) => setLiSupplierId(e.target.value)}
                style={{ ...styles.input, flex: 1, minWidth: '120px' }}
              >
                <option value="">All Suppliers</option>
                {liSuppliers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            {/* Results table */}
            {debouncedLiSearch.length >= 2 && (
              <div style={{ maxHeight: '180px', overflow: 'auto', border: '1px solid #e0e0e0', borderRadius: '6px', marginBottom: '0.5rem' }}>
                {liSearching ? (
                  <div style={{ padding: '0.75rem', color: '#888', textAlign: 'center', fontSize: '0.85rem' }}>Searching...</div>
                ) : !liResults?.items.length ? (
                  <div style={{ padding: '0.75rem', color: '#888', textAlign: 'center', fontSize: '0.85rem' }}>No line items found</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                    <thead>
                      <tr>
                        <th style={styles.liTh}>Supplier</th>
                        <th style={styles.liTh}>Description</th>
                        <th style={{ ...styles.liTh, textAlign: 'right' }}>Qty</th>
                        <th style={{ ...styles.liTh, textAlign: 'right' }}>Unit Price</th>
                        <th style={{ ...styles.liTh, textAlign: 'right' }}>Total</th>
                        <th style={{ ...styles.liTh, textAlign: 'center' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {liResults.items.map((item, idx) => (
                        <tr
                          key={`${item.product_code || ''}-${item.supplier_id}-${idx}`}
                          style={{
                            borderBottom: '1px solid #f0f0f0',
                            background: isSelectedLi(item) ? '#e8f5e9' : undefined,
                          }}
                        >
                          <td style={{ padding: '0.3rem 0.5rem', fontSize: '0.73rem', color: '#666' }}>{item.supplier_name || '-'}</td>
                          <td style={{ padding: '0.3rem 0.5rem' }}>
                            {item.product_code && <span style={{ color: '#888', fontSize: '0.68rem', marginRight: '0.25rem' }}>{item.product_code}</span>}
                            {item.description}
                          </td>
                          <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', whiteSpace: 'nowrap', color: '#666' }}>
                            {item.total_quantity != null ? Number(item.total_quantity).toFixed(0) : '-'}
                            {item.unit ? <span style={{ fontSize: '0.65rem', color: '#999' }}> {item.unit}</span> : ''}
                          </td>
                          <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {item.most_recent_price != null ? `\u00a3${Number(item.most_recent_price).toFixed(2)}` : '-'}
                          </td>
                          <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', whiteSpace: 'nowrap', color: '#666' }}>
                            {item.most_recent_price != null && item.total_quantity != null
                              ? `\u00a3${(Number(item.most_recent_price) * Number(item.total_quantity)).toFixed(2)}`
                              : '-'}
                          </td>
                          <td style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                            <button
                              onClick={() => handleLineItemSelect(item)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', padding: '0.15rem 0.3rem', borderRadius: '4px', color: isSelectedLi(item) ? '#2e7d32' : item.ingredient_id != null ? '#22c55e' : parsePackFromDescription(item.description || '') ? '#f59e0b' : '#ef4444' }}
                              title={isSelectedLi(item) ? 'Selected' : item.ingredient_id != null ? `Mapped to ${item.ingredient_name}` : parsePackFromDescription(item.description || '') ? 'Pack info detected' : 'No pack info — manual entry needed'}
                            >
                              {'\u2696'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Line item invoice preview */}
            {selectedLi && selectedLi.most_recent_line_number != null && (
              <div
                style={{ marginTop: '0.5rem', borderRadius: '6px', overflow: 'hidden', border: '1px solid #e0e0e0', cursor: 'pointer' }}
                onClick={() => setShowLineItemPreview(true)}
                title="Click to enlarge"
              >
                <img
                  src={`/api/invoices/${selectedLi.most_recent_invoice_id}/line-items/${selectedLi.most_recent_line_number}/preview?token=${encodeURIComponent(token || '')}`}
                  alt="Invoice line item"
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                  onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }}
                />
              </div>
            )}

            {/* Selected line item pack config */}
            {selectedLi && (
              <div style={{ background: '#f8f9fa', padding: '0.6rem', borderRadius: '6px', marginTop: '0.25rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                  {'\u2713'} {selectedLi.description}
                  <button onClick={() => { setSelectedLi(null); setLiMappingError('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c62828', fontSize: '0.75rem', marginLeft: '0.5rem' }}>{'\u2715'} remove</button>
                </div>
                <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.35rem' }}>
                  {selectedLi.supplier_name}{selectedLi.most_recent_price != null ? ` \u2014 \u00a3${Number(selectedLi.most_recent_price).toFixed(2)}` : ''}
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: '#888', marginBottom: '0.15rem' }}>Contains</div>
                    <input type="number" value={liUnitSize} onChange={(e) => setLiUnitSize(e.target.value)} style={styles.input} step="0.1" min="0" placeholder="Size" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: '#888', marginBottom: '0.15rem' }}>Unit</div>
                    <select value={liUnitSizeType} onChange={(e) => setLiUnitSizeType(e.target.value)} style={styles.input}>
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
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: '#888', marginBottom: '0.15rem' }}>Pack of</div>
                    <input type="number" value={liPackQty} onChange={(e) => setLiPackQty(parseInt(e.target.value) || 1)} style={styles.input} min="1" step="1" />
                  </div>
                </div>
                {liConversionDisplay && (
                  <div style={{ marginTop: '0.35rem', padding: '0.35rem 0.5rem', background: '#e8f5e9', borderRadius: '4px', fontSize: '0.8rem', color: '#2e7d32', fontWeight: 500 }}>
                    {liConversionDisplay}
                  </div>
                )}
              </div>
            )}

            {/* Supplier product lookup (Brakes, etc.) */}
            {selectedLi && activeLookup && (
              <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: '#fefce8', borderRadius: '6px', border: `1px solid ${activeLookup.color}33` }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
                  {selectedLi.most_recent_line_number != null && (
                    <div style={{ flex: '0 0 auto', maxWidth: '120px', borderRadius: '4px', overflow: 'hidden', border: '1px solid #e0e0e0' }}>
                      <img
                        src={`/api/invoices/${selectedLi.most_recent_invoice_id}/line-items/${selectedLi.most_recent_line_number}/preview/field/product_code?token=${encodeURIComponent(token || '')}`}
                        alt="Product code from invoice"
                        style={{ width: '100%', height: 'auto', display: 'block' }}
                        onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }}
                      />
                    </div>
                  )}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {supplierFetching && (
                      <div style={{ fontSize: '0.72rem', color: activeLookup.color }}>
                        Fetching product data...
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                      <input
                        value={supplierManualCode}
                        onChange={(e) => setSupplierManualCode(e.target.value)}
                        style={{ ...styles.input, flex: 1, fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                        placeholder="Product code"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && supplierManualCode.trim()) {
                            fetchSupplierProduct(supplierManualCode.trim(), activeLookup, true)
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          if (supplierManualCode.trim()) fetchSupplierProduct(supplierManualCode.trim(), activeLookup, true)
                        }}
                        disabled={!supplierManualCode.trim() || supplierFetching}
                        style={{
                          padding: '0.25rem 0.5rem',
                          border: `1px solid ${activeLookup.color}`,
                          borderRadius: '4px',
                          background: supplierFetching ? '#e0e0e0' : activeLookup.color,
                          color: 'white',
                          cursor: supplierFetching ? 'default' : 'pointer',
                          fontSize: '0.7rem',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {activeLookup.label}
                      </button>
                    </div>
                  </div>
                </div>
                {supplierAutoApplyIds.length > 0 && scanResult?.suggested_flags && (
                  <div style={{
                    marginTop: '0.35rem',
                    padding: '0.35rem 0.5rem',
                    background: '#e8f5e9',
                    border: '1px solid #a5d6a7',
                    borderRadius: '4px',
                    fontSize: '0.72rem',
                    color: '#2e7d32',
                  }}>
                    <span style={{ fontWeight: 600 }}>Auto-flagged: </span>
                    {scanResult.suggested_flags
                      .filter(f => supplierAutoApplyIds.includes(f.flag_id))
                      .map(f => f.flag_name)
                      .join(', ')
                    }
                  </div>
                )}
              </div>
            )}

            {liMappingError && <div style={{ marginTop: '0.35rem', padding: '0.35rem 0.5rem', background: '#fdecea', borderRadius: '4px', fontSize: '0.8rem', color: '#c62828' }}>{liMappingError}</div>}
          </div>
        </div>
        <IngredientFlagEditor
          ingredientId={editingIngredient?.id ?? null}
          token={token || ''}
          onChange={(flagIds, noneCatIds) => { setPendingFlagIds(flagIds); setPendingNoneCatIds(noneCatIds) }}
          ingredientName={formName}
          productIngredients={formPrepackaged ? formProductIngredients : undefined}
          scanSuggestions={scanResult?.suggested_flags}
          autoApplyFlagIds={supplierAutoApplyIds}
        />
        <div style={styles.modalFooter}>
          <button onClick={handleClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={!formName || createMutation.isPending || updateMutation.isPending}
            style={styles.primaryBtn}
          >
            {createMutation.isPending || updateMutation.isPending ? 'Saving...' : selectedLi ? (editingIngredient ? 'Save & Map' : 'Create & Map') : 'Save'}
          </button>
        </div>
        {(createMutation.error || updateMutation.error) && (
          <div style={{ padding: '0 1.25rem 0.75rem' }}><div style={styles.errorMsg}>{(createMutation.error || updateMutation.error)?.message}</div></div>
        )}
      </div>
      {cropFile && (
        <ImageCropModal
          imageFile={cropFile}
          onCropped={(croppedFile) => {
            setCropFile(null)
            handleScanLabel(croppedFile)
          }}
          onCancel={() => setCropFile(null)}
        />
      )}
      {showLabelModal && labelPreview && (
        <div
          onClick={() => setShowLabelModal(false)}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, cursor: 'pointer' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
            <button
              onClick={() => setShowLabelModal(false)}
              style={{ position: 'absolute', top: '-12px', right: '-12px', width: '28px', height: '28px', borderRadius: '50%', background: 'white', border: '1px solid #ccc', cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.2)', zIndex: 1 }}
            >
              {'\u2715'}
            </button>
            <img
              src={labelPreview}
              alt="Product label"
              style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}
            />
          </div>
        </div>
      )}
      {showLineItemPreview && selectedLi?.most_recent_line_number != null && (
        <div
          onClick={() => setShowLineItemPreview(false)}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, cursor: 'pointer' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', maxWidth: '95vw', maxHeight: '90vh' }}>
            <button
              onClick={() => setShowLineItemPreview(false)}
              style={{ position: 'absolute', top: '-12px', right: '-12px', width: '28px', height: '28px', borderRadius: '50%', background: 'white', border: '1px solid #ccc', cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.2)', zIndex: 1 }}
            >
              {'\u2715'}
            </button>
            <img
              src={`/api/invoices/${selectedLi.most_recent_invoice_id}/line-items/${selectedLi.most_recent_line_number}/preview?token=${encodeURIComponent(token || '')}`}
              alt="Invoice line item"
              style={{ maxWidth: '95vw', maxHeight: '90vh', borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '500px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  modalBody: { padding: '1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.25rem', borderTop: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#555', marginTop: '0.75rem', marginBottom: '0.25rem' },
  input: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' as const },
  row: { display: 'flex', gap: '0.75rem' },
  warning: { background: '#fff3cd', color: '#856404', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', marginTop: '0.35rem' },
  errorMsg: { padding: '0.75rem 1.25rem', color: '#dc3545', fontSize: '0.85rem' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  liTh: { padding: '0.35rem 0.5rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.7rem', fontWeight: 600, color: '#555', position: 'sticky' as const, top: 0 },
}
