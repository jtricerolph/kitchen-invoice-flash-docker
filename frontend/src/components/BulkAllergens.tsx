import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface FlagInfo {
  id: number
  food_flag_id: number
  flag_name: string
  flag_code: string | null
  category_name: string
  propagation_type: string
  source: string
}

interface AllergenSuggestion {
  flag_id: number
  flag_name: string
  flag_code: string | null
  category_name: string
  matched_keywords: string[]
}

interface IngredientItem {
  id: number
  name: string
  category_id: number | null
  category_name: string | null
  standard_unit: string
  notes: string | null
  is_prepackaged: boolean
  product_ingredients: string | null
  flags: FlagInfo[]
}

interface FoodFlagItem {
  id: number
  name: string
  code: string | null
  propagation_type: string
}

interface FoodFlagCategoryItem {
  id: number
  name: string
  propagation_type: string
  required: boolean
  flags: FoodFlagItem[]
}

interface IngredientCategory {
  id: number
  name: string
}

export default function BulkAllergens() {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [showUnassessedOnly, setShowUnassessedOnly] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // Fetch all non-archived ingredients
  const { data: ingredients } = useQuery<IngredientItem[]>({
    queryKey: ['ingredients-bulk'],
    queryFn: async () => {
      const res = await fetch('/api/ingredients?limit=9999', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch ingredients')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch ingredient categories
  const { data: categories } = useQuery<IngredientCategory[]>({
    queryKey: ['ingredient-categories'],
    queryFn: async () => {
      const res = await fetch('/api/ingredients/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch flag categories (only required ones shown as columns)
  const { data: flagCategories } = useQuery<FoodFlagCategoryItem[]>({
    queryKey: ['food-flag-categories-full'],
    queryFn: async () => {
      const res = await fetch('/api/food-flags/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch flag categories')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch bulk nones (ingredient_id -> category_ids where None is set)
  const { data: bulkNones } = useQuery<Record<number, number[]>>({
    queryKey: ['bulk-nones'],
    queryFn: async () => {
      const res = await fetch('/api/ingredients/bulk-nones', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return {}
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch suggestions for ALL ingredients in bulk (single request)
  const { data: allSuggestions } = useQuery<Record<number, AllergenSuggestion[]>>({
    queryKey: ['bulk-suggestions'],
    queryFn: async () => {
      const res = await fetch('/api/food-flags/suggest/bulk', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return {}
      return res.json()
    },
    enabled: !!token,
  })

  // Toggle a flag on an ingredient
  const toggleFlagMutation = useMutation({
    mutationFn: async ({ ingredientId, flagId, action }: { ingredientId: number; flagId: number; action: 'add' | 'remove' }) => {
      // Get current flags for this ingredient
      const ing = ingredients?.find(i => i.id === ingredientId)
      const currentFlagIds = ing?.flags.map(f => f.food_flag_id) || []

      let newFlagIds: number[]
      if (action === 'add') {
        newFlagIds = [...currentFlagIds, flagId]
      } else {
        newFlagIds = currentFlagIds.filter(id => id !== flagId)
      }

      const res = await fetch(`/api/ingredients/${ingredientId}/flags`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ food_flag_ids: newFlagIds }),
      })
      if (!res.ok) throw new Error('Failed to update flags')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingredients-bulk'] })
      queryClient.invalidateQueries({ queryKey: ['bulk-nones'] })
    },
  })

  // Toggle None for a category on an ingredient
  const toggleNoneMutation = useMutation({
    mutationFn: async ({ ingredientId, categoryId }: { ingredientId: number; categoryId: number }) => {
      const res = await fetch(`/api/ingredients/${ingredientId}/flags/none`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: categoryId }),
      })
      if (!res.ok) throw new Error('Failed to toggle none')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingredients-bulk'] })
      queryClient.invalidateQueries({ queryKey: ['bulk-nones'] })
    },
  })

  const toggleExpanded = (ing: IngredientItem) => {
    setExpandedId(expandedId === ing.id ? null : ing.id)
  }

  // Only show required categories as column groups
  const requiredCategories = flagCategories?.filter(c => c.required) || []

  // Build a flat list of flag columns
  const flagColumns: Array<{ flagId: number; flagName: string; flagCode: string | null; categoryId: number; categoryName: string; propagation: string }> = []
  for (const cat of requiredCategories) {
    for (const f of cat.flags) {
      flagColumns.push({
        flagId: f.id,
        flagName: f.name,
        flagCode: f.code,
        categoryId: cat.id,
        categoryName: cat.name,
        propagation: cat.propagation_type,
      })
    }
  }

  // Filter ingredients
  const filtered = (ingredients || []).filter(ing => {
    if (search && !ing.name.toLowerCase().includes(search.toLowerCase())) return false
    if (categoryFilter && ing.category_id !== parseInt(categoryFilter)) return false
    if (showUnassessedOnly) {
      // Check if ingredient is unassessed for any required category
      const nones = bulkNones?.[ing.id] || []
      for (const cat of requiredCategories) {
        if (nones.includes(cat.id)) continue // None set for this category
        const hasFlagInCat = ing.flags.some(f => cat.flags.some(cf => cf.id === f.food_flag_id))
        if (!hasFlagInCat) return true // Unassessed for this category
      }
      return false
    }
    return true
  })

  return (
    <div style={styles.page}>
      <h2 style={{ margin: '0 0 0.75rem 0' }}>Bulk Allergen Assessment</h2>

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
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showUnassessedOnly}
            onChange={(e) => setShowUnassessedOnly(e.target.checked)}
          />
          Unassessed only
        </label>
        <span style={{ fontSize: '0.85rem', color: '#666', marginLeft: 'auto' }}>
          {filtered.length} ingredients
        </span>
      </div>

      {flagColumns.length === 0 ? (
        <div style={styles.emptyState}>
          No required flag categories found. Go to Settings &gt; Food Flags and mark allergen categories as "Required".
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 3 }}>
              <tr>
                <th style={{ ...styles.th, position: 'sticky', left: 0, background: '#fafafa', zIndex: 4, minWidth: '200px' }}>
                  Ingredient
                </th>
                {requiredCategories.map(cat => (
                  <th
                    key={`cat-none-${cat.id}`}
                    style={{ ...styles.th, textAlign: 'center', fontSize: '0.7rem', background: '#f0fdf4', minWidth: '50px' }}
                    title={`None apply for ${cat.name}`}
                  >
                    None
                  </th>
                ))}
                {flagColumns.map(col => (
                  <th
                    key={col.flagId}
                    style={{ ...styles.th, textAlign: 'center' as const, minWidth: '45px', writingMode: 'vertical-lr' as const, fontSize: '0.7rem' }}
                    title={`${col.flagName} (${col.categoryName})`}
                  >
                    {col.flagCode || col.flagName}
                  </th>
                ))}
              </tr>
            </thead>
              {filtered.map(ing => {
                const ingFlagIds = new Set(ing.flags.map(f => f.food_flag_id))
                const nones = bulkNones?.[ing.id] || []
                const isExpanded = expandedId === ing.id
                const ingSuggestions = allSuggestions?.[ing.id]
                const pendingSuggestions = ingSuggestions?.filter(s => !ingFlagIds.has(s.flag_id))
                const hasPendingSuggestions = !!pendingSuggestions?.length
                const totalCols = 1 + requiredCategories.length + flagColumns.length

                return (
                  <tbody key={ing.id}>
                    <tr style={styles.tr}>
                      <td
                        style={{
                          ...styles.td, position: 'sticky', left: 0, zIndex: 1, fontWeight: 500, cursor: 'pointer',
                          background: isExpanded ? '#f0f7ff' : hasPendingSuggestions ? '#fffbeb' : 'white',
                          borderLeft: hasPendingSuggestions ? '3px solid #f59e0b' : undefined,
                        }}
                        onClick={() => toggleExpanded(ing)}
                        title={hasPendingSuggestions ? `${pendingSuggestions!.length} suggested allergen(s) — click to review` : 'Click to show details'}
                      >
                        <span style={{ fontSize: '0.65rem', color: '#888', marginRight: '4px' }}>{isExpanded ? '\u25BC' : '\u25B6'}</span>
                        {ing.name}
                        {ing.category_name && (
                          <span style={{ fontSize: '0.7rem', color: '#999', marginLeft: '6px' }}>{ing.category_name}</span>
                        )}
                        {ing.is_prepackaged && (
                          <span style={{ fontSize: '0.6rem', color: '#6366f1', marginLeft: '6px', fontWeight: 600 }}>PKG</span>
                        )}
                      </td>

                      {/* None columns per required category */}
                      {requiredCategories.map(cat => {
                        const isNone = nones.includes(cat.id)
                        return (
                          <td key={`none-${cat.id}`} style={{ ...styles.td, textAlign: 'center', background: isNone ? '#dcfce7' : undefined }}>
                            <input
                              type="checkbox"
                              checked={isNone}
                              onChange={() => toggleNoneMutation.mutate({ ingredientId: ing.id, categoryId: cat.id })}
                              disabled={toggleNoneMutation.isPending}
                              style={{ cursor: 'pointer' }}
                              title={`None apply for ${cat.name}`}
                            />
                          </td>
                        )
                      })}

                      {/* Flag columns */}
                      {flagColumns.map(col => {
                        const isChecked = ingFlagIds.has(col.flagId)
                        const isNoneForCategory = nones.includes(col.categoryId)
                        const isSuggested = pendingSuggestions?.some(s => s.flag_id === col.flagId)
                        return (
                          <td
                            key={col.flagId}
                            style={{
                              ...styles.td,
                              textAlign: 'center',
                              background: isChecked
                                ? (col.propagation === 'contains' ? '#fef2f2' : '#dcfce7')
                                : isSuggested ? '#fffbeb'
                                : isNoneForCategory ? '#f8f8f8' : undefined,
                              opacity: isNoneForCategory ? 0.4 : 1,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleFlagMutation.mutate({
                                ingredientId: ing.id,
                                flagId: col.flagId,
                                action: isChecked ? 'remove' : 'add',
                              })}
                              disabled={isNoneForCategory || toggleFlagMutation.isPending}
                              style={{ cursor: isNoneForCategory ? 'not-allowed' : 'pointer' }}
                              title={col.flagName + (isSuggested ? ' (suggested)' : '')}
                            />
                          </td>
                        )
                      })}
                    </tr>

                    {/* Expanded detail row */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={totalCols} style={{ padding: '0.5rem 0.75rem', background: '#f8fafc', borderBottom: '2px solid #e0e0e0' }}>
                          <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem' }}>
                            {/* Notes */}
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, color: '#555', marginBottom: '0.25rem', fontSize: '0.7rem', textTransform: 'uppercase' as const }}>Notes</div>
                              <div style={{ color: ing.notes ? '#333' : '#bbb', whiteSpace: 'pre-wrap' }}>
                                {ing.notes || 'No notes'}
                              </div>
                            </div>

                            {/* Product ingredients */}
                            <div style={{ flex: 2 }}>
                              <div style={{ fontWeight: 600, color: '#555', marginBottom: '0.25rem', fontSize: '0.7rem', textTransform: 'uppercase' as const }}>
                                Label Ingredients {ing.is_prepackaged && <span style={{ color: '#6366f1' }}>(prepackaged)</span>}
                              </div>
                              <div style={{ color: ing.product_ingredients ? '#333' : '#bbb', whiteSpace: 'pre-wrap', maxHeight: '80px', overflow: 'auto' }}>
                                {ing.product_ingredients || 'Not available'}
                              </div>
                            </div>

                            {/* Allergen suggestions */}
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, color: '#555', marginBottom: '0.25rem', fontSize: '0.7rem', textTransform: 'uppercase' as const }}>Keyword Suggestions</div>
                              {!pendingSuggestions?.length ? (
                                <div style={{ color: '#bbb' }}>No suggestions</div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                  {pendingSuggestions.map(s => (
                                    <div
                                      key={s.flag_id}
                                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.15rem 0.3rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '4px' }}
                                    >
                                      <span>
                                        <strong style={{ fontSize: '0.75rem' }}>{s.flag_name}</strong>
                                        <span style={{ color: '#999', fontSize: '0.65rem', marginLeft: '0.25rem' }}>
                                          {s.matched_keywords.join(', ')}
                                        </span>
                                      </span>
                                      <button
                                        onClick={() => {
                                          const cat = requiredCategories.find(c => c.flags.some(f => f.id === s.flag_id))
                                          if (cat) toggleFlagMutation.mutate({ ingredientId: ing.id, flagId: s.flag_id, action: 'add' })
                                        }}
                                        disabled={toggleFlagMutation.isPending}
                                        style={{ background: '#f59e0b', color: 'white', border: 'none', borderRadius: '3px', padding: '0.1rem 0.3rem', fontSize: '0.65rem', fontWeight: 600, cursor: 'pointer' }}
                                      >
                                        Apply
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                )
              })}
          </table>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1600px', margin: '0 auto' },
  filterBar: { display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' as const },
  searchInput: { padding: '0.5rem 0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', width: '250px' },
  select: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem' },
  emptyState: { padding: '3rem', textAlign: 'center' as const, color: '#888', background: '#fafafa', borderRadius: '8px' },
  table: { width: '100%', borderCollapse: 'collapse' as const, background: 'white', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  th: { padding: '0.5rem 0.4rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.75rem', fontWeight: 600, color: '#555' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.35rem 0.4rem', fontSize: '0.85rem' },
}
