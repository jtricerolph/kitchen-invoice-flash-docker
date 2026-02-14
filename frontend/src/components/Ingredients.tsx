import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import FoodFlagBadges from './FoodFlagBadges'

interface IngredientCategory {
  id: number
  name: string
  sort_order: number
  ingredient_count: number
}

interface FlagInfo {
  id: number
  food_flag_id: number
  flag_name: string
  flag_code: string | null
  category_name: string
  source: string
}

interface IngredientItem {
  id: number
  name: string
  category_id: number | null
  category_name: string | null
  standard_unit: string
  yield_percent: number
  manual_price: number | null
  notes: string | null
  is_archived: boolean
  source_count: number
  effective_price: number | null
  flags: FlagInfo[]
  created_at: string
}

interface SourceItem {
  id: number
  supplier_id: number
  supplier_name: string
  product_code: string | null
  description_pattern: string | null
  pack_quantity: number | null
  unit_size: number | null
  unit_size_type: string | null
  latest_unit_price: number | null
  latest_invoice_date: string | null
  price_per_std_unit: number | null
}

interface SimilarIngredient {
  id: number
  name: string
  similarity: number
}

export default function Ingredients() {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [showUnmapped, setShowUnmapped] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  // Create/edit form
  const [formName, setFormName] = useState('')
  const [formCategory, setFormCategory] = useState<string>('')
  const [formUnit, setFormUnit] = useState('g')
  const [formYield, setFormYield] = useState('100')
  const [formPrice, setFormPrice] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [duplicateWarnings, setDuplicateWarnings] = useState<SimilarIngredient[]>([])

  // Categories
  const { data: categories } = useQuery<IngredientCategory[]>({
    queryKey: ['ingredient-categories'],
    queryFn: async () => {
      const res = await fetch('/api/ingredients/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch categories')
      return res.json()
    },
    enabled: !!token,
  })

  // Ingredients
  const { data: ingredients, isLoading } = useQuery<IngredientItem[]>({
    queryKey: ['ingredients', search, categoryFilter, showUnmapped],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (categoryFilter) params.set('category_id', categoryFilter)
      if (showUnmapped) params.set('unmapped', 'true')
      const res = await fetch(`/api/ingredients?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch ingredients')
      return res.json()
    },
    enabled: !!token,
  })

  // Sources for expanded ingredient
  const { data: sources } = useQuery<SourceItem[]>({
    queryKey: ['ingredient-sources', expandedId],
    queryFn: async () => {
      const res = await fetch(`/api/ingredients/${expandedId}/sources`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch sources')
      return res.json()
    },
    enabled: !!token && !!expandedId,
  })

  // Duplicate check
  useEffect(() => {
    if (!formName || formName.length < 3 || !token) {
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
          setDuplicateWarnings(data.filter((d: SimilarIngredient) => editingId ? d.id !== editingId : true))
        }
      } catch { /* ignore */ }
    }, 500)
    return () => clearTimeout(timer)
  }, [formName, token, editingId])

  // Create mutation
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      resetForm()
    },
  })

  // Update mutation
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      resetForm()
    },
  })

  // Archive mutation
  const archiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/ingredients/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to archive')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ingredients'] }),
  })

  const resetForm = () => {
    setShowCreateModal(false)
    setEditingId(null)
    setFormName('')
    setFormCategory('')
    setFormUnit('g')
    setFormYield('100')
    setFormPrice('')
    setFormNotes('')
    setDuplicateWarnings([])
  }

  const startEdit = (ing: IngredientItem) => {
    setEditingId(ing.id)
    setFormName(ing.name)
    setFormCategory(ing.category_id?.toString() || '')
    setFormUnit(ing.standard_unit)
    setFormYield(ing.yield_percent.toString())
    setFormPrice(ing.manual_price?.toString() || '')
    setFormNotes(ing.notes || '')
    setShowCreateModal(true)
  }

  const handleSave = () => {
    const data: Record<string, unknown> = {
      name: formName,
      category_id: formCategory ? parseInt(formCategory) : null,
      standard_unit: formUnit,
      yield_percent: parseFloat(formYield),
      manual_price: formPrice ? parseFloat(formPrice) : null,
      notes: formNotes || null,
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, data })
    } else {
      createMutation.mutate(data)
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>Ingredient Library</h2>
        <button onClick={() => { resetForm(); setShowCreateModal(true) }} style={styles.primaryBtn}>
          + Create Ingredient
        </button>
      </div>

      {/* Filters */}
      <div style={styles.filterBar}>
        <input
          type="text"
          placeholder="Search ingredients..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={styles.select}>
          <option value="">All Categories</option>
          {categories?.map(c => (
            <option key={c.id} value={c.id}>{c.name} ({c.ingredient_count})</option>
          ))}
        </select>
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={showUnmapped}
            onChange={(e) => setShowUnmapped(e.target.checked)}
          />
          Unmapped only
        </label>
      </div>

      {/* Stats */}
      <div style={styles.statsBar}>
        <span>{ingredients?.length || 0} ingredients</span>
        <span style={{ color: '#888' }}>|</span>
        <span>{ingredients?.filter(i => i.source_count === 0).length || 0} unmapped</span>
      </div>

      {/* Table */}
      {isLoading ? (
        <div style={styles.loading}>Loading ingredients...</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Unit</th>
              <th style={styles.th}>Yield %</th>
              <th style={styles.th}>Sources</th>
              <th style={styles.th}>Price/Unit</th>
              <th style={styles.th}>Flags</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {ingredients?.map(ing => (
              <>
                <tr
                  key={ing.id}
                  style={{ ...styles.tr, cursor: 'pointer' }}
                  onClick={() => setExpandedId(expandedId === ing.id ? null : ing.id)}
                >
                  <td style={styles.td}>
                    <span style={{ fontWeight: 500 }}>{ing.name}</span>
                  </td>
                  <td style={styles.td}>{ing.category_name || '-'}</td>
                  <td style={styles.td}>{ing.standard_unit}</td>
                  <td style={styles.td}>
                    <span style={{ color: ing.yield_percent < 100 ? '#e94560' : '#666' }}>
                      {ing.yield_percent}%
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{
                      background: ing.source_count > 0 ? '#22c55e' : '#f59e0b',
                      color: 'white',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                    }}>
                      {ing.source_count}
                    </span>
                  </td>
                  <td style={styles.td}>
                    {ing.effective_price != null
                      ? `£${ing.effective_price.toFixed(4)}/${ing.standard_unit}`
                      : <span style={{ color: '#aaa' }}>-</span>
                    }
                  </td>
                  <td style={styles.td}>
                    <FoodFlagBadges flags={ing.flags.map(f => ({
                      name: f.flag_name,
                      code: f.flag_code || undefined,
                      category_name: f.category_name,
                    }))} />
                  </td>
                  <td style={styles.td}>
                    <button onClick={(e) => { e.stopPropagation(); startEdit(ing) }} style={styles.smallBtn}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(ing.id) }} style={{ ...styles.smallBtn, color: '#e94560' }}>Archive</button>
                  </td>
                </tr>
                {expandedId === ing.id && (
                  <tr key={`${ing.id}-expanded`}>
                    <td colSpan={8} style={styles.expandedTd}>
                      <div style={styles.sourcesSection}>
                        <h4 style={{ margin: '0 0 8px 0' }}>Supplier Sources</h4>
                        {sources && sources.length > 0 ? (
                          <table style={{ ...styles.table, margin: 0 }}>
                            <thead>
                              <tr>
                                <th style={styles.thSmall}>Supplier</th>
                                <th style={styles.thSmall}>Code/Pattern</th>
                                <th style={styles.thSmall}>Pack</th>
                                <th style={styles.thSmall}>Last Price</th>
                                <th style={styles.thSmall}>Price/{ing.standard_unit}</th>
                                <th style={styles.thSmall}>Last Invoice</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sources.map(s => (
                                <tr key={s.id}>
                                  <td style={styles.tdSmall}>{s.supplier_name}</td>
                                  <td style={styles.tdSmall}>{s.product_code || s.description_pattern || '-'}</td>
                                  <td style={styles.tdSmall}>
                                    {s.pack_quantity && s.unit_size
                                      ? `${s.pack_quantity}×${s.unit_size}${s.unit_size_type || ''}`
                                      : '-'
                                    }
                                  </td>
                                  <td style={styles.tdSmall}>
                                    {s.latest_unit_price != null ? `£${s.latest_unit_price.toFixed(2)}` : '-'}
                                  </td>
                                  <td style={styles.tdSmall}>
                                    {s.price_per_std_unit != null ? `£${s.price_per_std_unit.toFixed(4)}` : '-'}
                                  </td>
                                  <td style={styles.tdSmall}>{s.latest_invoice_date || '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div style={{ color: '#888', fontStyle: 'italic' }}>No supplier sources mapped yet</div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>{editingId ? 'Edit Ingredient' : 'Create Ingredient'}</h3>
              <button onClick={resetForm} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} style={styles.input} placeholder="e.g. Butter, Minced Beef 80/20" />
              {duplicateWarnings.length > 0 && (
                <div style={styles.warning}>
                  Similar ingredients exist: {duplicateWarnings.map(d => `${d.name} (${Math.round(d.similarity * 100)}%)`).join(', ')}
                </div>
              )}

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

              <label style={styles.label}>Manual Price (per {formUnit}, if no sources)</label>
              <input type="number" value={formPrice} onChange={(e) => setFormPrice(e.target.value)} style={styles.input} step="0.0001" placeholder="Optional" />

              <label style={styles.label}>Notes</label>
              <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} style={{ ...styles.input, minHeight: '60px' }} placeholder="Optional notes..." />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={resetForm} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={handleSave}
                disabled={!formName || createMutation.isPending || updateMutation.isPending}
                style={styles.primaryBtn}
              >
                {createMutation.isPending || updateMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
            {(createMutation.error || updateMutation.error) && (
              <div style={styles.errorMsg}>{(createMutation.error || updateMutation.error)?.message}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  filterBar: { display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' },
  searchInput: { padding: '0.5rem 0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', width: '250px' },
  select: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.9rem', color: '#555' },
  statsBar: { display: 'flex', gap: '0.75rem', fontSize: '0.85rem', color: '#666', marginBottom: '0.75rem' },
  table: { width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  th: { padding: '0.6rem 0.75rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.8rem', fontWeight: 600, color: '#555' },
  thSmall: { padding: '0.4rem 0.5rem', textAlign: 'left' as const, borderBottom: '1px solid #e0e0e0', background: '#f5f5f5', fontSize: '0.75rem', fontWeight: 600, color: '#666' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.5rem 0.75rem', fontSize: '0.85rem' },
  tdSmall: { padding: '0.35rem 0.5rem', fontSize: '0.8rem' },
  expandedTd: { padding: '0.75rem 1rem', background: '#f9f9f9' },
  sourcesSection: { padding: '0.5rem' },
  smallBtn: { padding: '0.25rem 0.5rem', border: '1px solid #ddd', borderRadius: '4px', background: 'white', cursor: 'pointer', fontSize: '0.75rem', marginRight: '0.25rem' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  loading: { padding: '2rem', textAlign: 'center' as const, color: '#888' },
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
}
