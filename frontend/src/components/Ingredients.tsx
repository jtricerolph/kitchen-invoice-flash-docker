import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import FoodFlagBadges from './FoodFlagBadges'
import IngredientModal from './IngredientModal'
import { IngredientCategory, EditingIngredient } from '../utils/ingredientHelpers'

interface FlagInfo {
  id: number
  food_flag_id: number
  flag_name: string
  flag_code: string | null
  category_name: string
  propagation_type: string
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
  is_prepackaged: boolean
  product_ingredients: string | null
  has_label_image: boolean
  source_count: number
  effective_price: number | null
  flags: FlagInfo[]
  none_categories: string[]
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

export default function Ingredients() {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [showUnmapped, setShowUnmapped] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [editingIngredient, setEditingIngredient] = useState<EditingIngredient | null>(null)

  // Categories (for filter dropdown)
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

  // Ingredients list
  const { data: ingredients, isLoading } = useQuery<IngredientItem[]>({
    queryKey: ['ingredients', search, categoryFilter, showUnmapped, showArchived],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (categoryFilter) params.set('category_id', categoryFilter)
      if (showUnmapped) params.set('unmapped', 'true')
      if (showArchived) params.set('archived', 'true')
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

  const unarchiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/ingredients/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_archived: false }),
      })
      if (!res.ok) throw new Error('Failed to unarchive')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ingredients'] }),
  })

  const startEdit = (ing: IngredientItem) => {
    setEditingIngredient({
      id: ing.id,
      name: ing.name,
      category_id: ing.category_id,
      standard_unit: ing.standard_unit,
      yield_percent: ing.yield_percent,
      manual_price: ing.manual_price,
      notes: ing.notes,
      is_prepackaged: ing.is_prepackaged,
      product_ingredients: ing.product_ingredients,
      has_label_image: ing.has_label_image,
    })
    setShowModal(true)
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>Ingredient Library</h2>
        <button onClick={() => { setEditingIngredient(null); setShowModal(true) }} style={styles.primaryBtn}>
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
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show Archived
        </label>
      </div>

      {/* Stats */}
      <div style={styles.statsBar}>
        <span>{ingredients?.length || 0} {showArchived ? 'archived' : ''} ingredients</span>
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
                  style={{ ...styles.tr, cursor: 'pointer', ...(ing.is_archived ? { opacity: 0.5 } : {}) }}
                  onClick={() => setExpandedId(expandedId === ing.id ? null : ing.id)}
                >
                  <td style={styles.td}>
                    <span style={{ fontWeight: 500, ...(ing.is_archived ? { textDecoration: 'line-through' } : {}) }}>{ing.name}</span>
                    {ing.is_archived && <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: '#999', fontStyle: 'italic' }}>archived</span>}
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
                      ? (() => {
                          const p = ing.effective_price!
                          const u = ing.standard_unit
                          if (u === 'g' && p < 1) return `£${(p * 1000).toFixed(2)}/kg`
                          if (u === 'ml' && p < 1) return `£${(p * 1000).toFixed(2)}/ltr`
                          return `£${p >= 1 ? p.toFixed(2) : p.toFixed(4)}/${u}`
                        })()
                      : <span style={{ color: '#aaa' }}>-</span>
                    }
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', alignItems: 'center' }}>
                      <FoodFlagBadges flags={ing.flags.map(f => ({
                        name: f.flag_name,
                        code: f.flag_code || undefined,
                        category_name: f.category_name,
                        propagation: f.propagation_type,
                      }))} />
                      {ing.none_categories?.map(cat => (
                        <span
                          key={cat}
                          title={`${cat}: None apply`}
                          style={{
                            display: 'inline-block',
                            borderRadius: '10px',
                            color: 'white',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            lineHeight: 1.4,
                            fontSize: '0.7rem',
                            padding: '1px 5px',
                            background: '#999',
                          }}
                        >
                          {cat.substring(0, 3)}: None
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <button onClick={(e) => { e.stopPropagation(); startEdit(ing) }} style={styles.smallBtn}>Edit</button>
                    {ing.is_archived ? (
                      <button onClick={(e) => { e.stopPropagation(); unarchiveMutation.mutate(ing.id) }} style={{ ...styles.smallBtn, color: '#22c55e' }}>Unarchive</button>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(ing.id) }} style={{ ...styles.smallBtn, color: '#e94560' }}>Archive</button>
                    )}
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
                                  <td style={styles.tdSmall}>
                                    {s.product_code && s.supplier_name?.toLowerCase().includes('brakes') ? (
                                      <a
                                        href={`https://www.brake.co.uk/p/${s.product_code}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ color: '#2563eb', textDecoration: 'underline' }}
                                        title="View on Brakes website"
                                      >
                                        {s.product_code}
                                      </a>
                                    ) : (
                                      s.product_code || s.description_pattern || '-'
                                    )}
                                  </td>
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
                                    {s.price_per_std_unit != null ? (() => {
                                      const p = typeof s.price_per_std_unit === 'string' ? parseFloat(s.price_per_std_unit) : s.price_per_std_unit
                                      const u = ing.standard_unit
                                      if (u === 'g' && p < 1) return `£${(p * 1000).toFixed(2)}/kg`
                                      if (u === 'ml' && p < 1) return `£${(p * 1000).toFixed(2)}/ltr`
                                      return `£${p >= 1 ? p.toFixed(2) : p.toFixed(4)}/${u}`
                                    })() : '-'}
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

      <IngredientModal
        open={showModal}
        onClose={() => { setShowModal(false); setEditingIngredient(null) }}
        editingIngredient={editingIngredient}
      />
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
  loading: { padding: '2rem', textAlign: 'center' as const, color: '#888' },
}
