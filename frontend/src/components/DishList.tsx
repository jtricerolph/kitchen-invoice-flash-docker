import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'
import FoodFlagBadges from './FoodFlagBadges'

interface MenuSection {
  id: number
  name: string
  sort_order: number
  recipe_count: number
}

interface RecipeItem {
  id: number
  name: string
  recipe_type: string
  menu_section_id: number | null
  menu_section_name: string | null
  batch_portions: number
  batch_output_type: string
  batch_yield_qty: number | null
  batch_yield_unit: string | null
  output_unit: string
  cost_per_portion: number | null
  total_cost: number | null
  is_archived: boolean
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  flag_summary: Array<{
    name: string
    code: string | null
    icon: string | null
    category: string
    propagation: string
    active: boolean
    excludable: boolean
  }>
  image_count: number
  kds_menu_item_name: string | null
  created_at: string
  updated_at: string
}

export default function DishList() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [sectionFilter, setSectionFilter] = useState<string>('')
  const [showCreate, setShowCreate] = useState(false)
  const [showSectionModal, setShowSectionModal] = useState(false)
  const [viewMode, setViewMode] = useState<'card' | 'list'>('list')
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)

  // Advanced filters (client-side)
  const [ingredientSearch, setIngredientSearch] = useState('')
  const [costMin, setCostMin] = useState('')
  const [costMax, setCostMax] = useState('')
  const [flagFilters, setFlagFilters] = useState<Record<string, 'neutral' | 'include' | 'exclude'>>({})

  // Section management
  const [editingSectionId, setEditingSectionId] = useState<number | null>(null)
  const [editingSectionName, setEditingSectionName] = useState('')

  // Create form
  const [formName, setFormName] = useState('')
  const [formSection, setFormSection] = useState<string>('')
  const [formDesc, setFormDesc] = useState('')

  // Section form
  const [sectionName, setSectionName] = useState('')

  const { data: sections } = useQuery<MenuSection[]>({
    queryKey: ['dish-courses'],
    queryFn: async () => {
      const res = await fetch('/api/recipes/menu-sections?section_type=dish', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch sections')
      return res.json()
    },
    enabled: !!token,
  })

  const { data: recipes, isLoading } = useQuery<RecipeItem[]>({
    queryKey: ['dishes', search, sectionFilter],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      params.set('recipe_type', 'dish')
      if (sectionFilter) params.set('menu_section_id', sectionFilter)
      const res = await fetch(`/api/recipes?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch dishes')
      return res.json()
    },
    enabled: !!token,
  })

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create dish')
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['dishes'] })
      setShowCreate(false)
      navigate(`/dishes/${data.id}`)
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/recipes/${id}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to duplicate')
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['dishes'] })
      navigate(`/dishes/${data.id}`)
    },
  })

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/recipes/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to archive')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dishes'] }),
  })

  const createSectionMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/recipes/menu-sections', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, section_type: 'dish' }),
      })
      if (!res.ok) throw new Error('Failed to create course')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dish-courses'] })
      setSectionName('')
      setShowSectionModal(false)
    },
  })

  const updateSectionMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await fetch(`/api/recipes/menu-sections/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to update course')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dish-courses'] })
      queryClient.invalidateQueries({ queryKey: ['dishes'] })
      setEditingSectionId(null)
      setEditingSectionName('')
    },
  })

  const deleteSectionMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/recipes/menu-sections/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete course')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dish-courses'] })
      queryClient.invalidateQueries({ queryKey: ['dishes'] })
    },
  })

  const { data: flagCategories } = useQuery<Array<{ id: number; name: string; flags: Array<{ id: number; name: string; code: string | null }> }>>({
    queryKey: ['food-flag-categories'],
    queryFn: async () => {
      const res = await fetch('/api/food-flags/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch flag categories')
      return res.json()
    },
    enabled: !!token && showAdvancedFilters,
  })

  // Client-side advanced filtering
  const filteredRecipes = (() => {
    let result = recipes || []

    // Ingredient name filter (client-side search through flag_summary or recipe name containing ingredient)
    if (ingredientSearch.trim()) {
      const term = ingredientSearch.toLowerCase()
      result = result.filter(r =>
        r.name.toLowerCase().includes(term) ||
        r.flag_summary.some(f => f.name.toLowerCase().includes(term))
      )
    }

    // Cost range filter
    if (costMin) {
      const min = parseFloat(costMin)
      if (!isNaN(min)) {
        result = result.filter(r => r.cost_per_portion != null && r.cost_per_portion >= min)
      }
    }
    if (costMax) {
      const max = parseFloat(costMax)
      if (!isNaN(max)) {
        result = result.filter(r => r.cost_per_portion != null && r.cost_per_portion <= max)
      }
    }

    // Flag filters
    const includeFlags = Object.entries(flagFilters).filter(([, v]) => v === 'include').map(([k]) => k)
    const excludeFlags = Object.entries(flagFilters).filter(([, v]) => v === 'exclude').map(([k]) => k)
    if (includeFlags.length > 0) {
      result = result.filter(r =>
        includeFlags.every(flagName =>
          r.flag_summary.some(f => f.name === flagName && f.active)
        )
      )
    }
    if (excludeFlags.length > 0) {
      result = result.filter(r =>
        !excludeFlags.some(flagName =>
          r.flag_summary.some(f => f.name === flagName && f.active)
        )
      )
    }

    return result
  })()

  const handleCreate = () => {
    createMutation.mutate({
      name: formName,
      recipe_type: 'dish',
      menu_section_id: formSection ? parseInt(formSection) : null,
      batch_portions: 1,
      description: formDesc || null,
    })
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>Dishes</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setShowSectionModal(true)} style={styles.secondaryBtn}>+ Course</button>
          <button onClick={() => { setShowCreate(true); setFormName(''); setFormSection(''); setFormDesc('') }} style={styles.primaryBtn}>+ New Dish</button>
        </div>
      </div>

      {/* Stats */}
      <div style={styles.statsBar}>
        <span>{recipes?.length || 0} dishes</span>
      </div>

      {/* Filters */}
      <div style={styles.filterBar}>
        <input
          type="text"
          placeholder="Search dishes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)} style={styles.select}>
          <option value="">All Courses</option>
          {sections?.map(s => (
            <option key={s.id} value={s.id}>{s.name} ({s.recipe_count})</option>
          ))}
        </select>
        <button
          onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
          style={{ ...styles.secondaryBtn, padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
        >
          {showAdvancedFilters ? 'Hide Filters' : 'Show Filters'}
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
          <button
            onClick={() => setViewMode('card')}
            style={{
              ...styles.viewToggleBtn,
              ...(viewMode === 'card' ? styles.viewToggleBtnActive : {}),
              borderRadius: '4px 0 0 4px',
            }}
          >Cards</button>
          <button
            onClick={() => setViewMode('list')}
            style={{
              ...styles.viewToggleBtn,
              ...(viewMode === 'list' ? styles.viewToggleBtnActive : {}),
              borderRadius: '0 4px 4px 0',
            }}
          >List</button>
        </div>
      </div>

      {/* Advanced Filter Panel */}
      {showAdvancedFilters && (
        <div style={styles.advancedFilterPanel}>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' as const, alignItems: 'flex-start' }}>
            <div style={{ minWidth: '200px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '4px' }}>Contains ingredient</label>
              <input
                type="text"
                placeholder="Search by ingredient..."
                value={ingredientSearch}
                onChange={(e) => setIngredientSearch(e.target.value)}
                style={{ ...styles.searchInput, width: '100%' }}
              />
            </div>
            <div style={{ minWidth: '150px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '4px' }}>Cost/portion range</label>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <input
                  type="number"
                  placeholder="Min"
                  value={costMin}
                  onChange={(e) => setCostMin(e.target.value)}
                  style={{ ...styles.searchInput, width: '80px', padding: '0.4rem' }}
                  step="0.01"
                />
                <span style={{ color: '#888' }}>-</span>
                <input
                  type="number"
                  placeholder="Max"
                  value={costMax}
                  onChange={(e) => setCostMax(e.target.value)}
                  style={{ ...styles.searchInput, width: '80px', padding: '0.4rem' }}
                  step="0.01"
                />
              </div>
            </div>
            {flagCategories && flagCategories.length > 0 && (
              <div style={{ flex: 1, minWidth: '250px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '4px' }}>Food flag filters</label>
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '4px' }}>
                  {flagCategories.flatMap(cat => cat.flags || []).map(flag => {
                    const state = flagFilters[flag.name] || 'neutral'
                    const nextState = state === 'neutral' ? 'include' : state === 'include' ? 'exclude' : 'neutral'
                    return (
                      <button
                        key={flag.id}
                        onClick={() => setFlagFilters(prev => {
                          const next = { ...prev }
                          if (nextState === 'neutral') delete next[flag.name]
                          else next[flag.name] = nextState
                          return next
                        })}
                        style={{
                          padding: '2px 8px',
                          borderRadius: '10px',
                          fontSize: '0.7rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          border: '1px solid',
                          borderColor: state === 'include' ? '#22c55e' : state === 'exclude' ? '#ef4444' : '#ddd',
                          background: state === 'include' ? '#dcfce7' : state === 'exclude' ? '#fef2f2' : 'white',
                          color: state === 'include' ? '#166534' : state === 'exclude' ? '#991b1b' : '#666',
                        }}
                        title={`${flag.name}: ${state} (click to cycle)`}
                      >
                        {state === 'include' ? '+ ' : state === 'exclude' ? '- ' : ''}{flag.code || flag.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dishes */}
      {isLoading ? (
        <div style={styles.loading}>Loading dishes...</div>
      ) : viewMode === 'card' ? (
        <div style={styles.grid}>
          {filteredRecipes.map(r => (
            <div key={r.id} style={styles.card} onClick={() => navigate(`/dishes/${r.id}`)}>
              <div style={styles.cardHeader}>
                <span style={{ fontWeight: 600, fontSize: '1rem' }}>{r.name}</span>
                <span style={{
                  background: '#3b82f6',
                  color: 'white',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase' as const,
                }}>
                  DISH
                </span>
              </div>

              {r.menu_section_name && (
                <div style={styles.sectionTag}>{r.menu_section_name}</div>
              )}

              <div style={styles.cardMeta}>
                {r.cost_per_portion != null ? (
                  <span style={styles.costBadge}>{'\u00A3'}{r.cost_per_portion.toFixed(2)}/portion</span>
                ) : (
                  <span style={{ color: '#aaa', fontSize: '0.8rem' }}>No costing</span>
                )}
                {(r.prep_time_minutes || r.cook_time_minutes) && (
                  <span style={{ fontSize: '0.75rem', color: '#888' }}>
                    {r.prep_time_minutes ? `${r.prep_time_minutes}m prep` : ''}
                    {r.prep_time_minutes && r.cook_time_minutes ? ' + ' : ''}
                    {r.cook_time_minutes ? `${r.cook_time_minutes}m cook` : ''}
                  </span>
                )}
              </div>

              {r.flag_summary.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <FoodFlagBadges flags={r.flag_summary} />
                </div>
              )}

              <div style={styles.cardActions}>
                <button onClick={(e) => { e.stopPropagation(); duplicateMutation.mutate(r.id) }} style={styles.actionBtn}>Duplicate</button>
                <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#e94560' }}>Archive</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table style={styles.listTable}>
          <thead>
            <tr>
              <th style={styles.listTh}>Name</th>
              <th style={styles.listTh}>Type</th>
              <th style={styles.listTh}>Course</th>
              <th style={styles.listTh}>Cost/Portion</th>
              <th style={styles.listTh}>Flags</th>
              <th style={styles.listTh}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRecipes.map(r => (
              <tr key={r.id} style={{ ...styles.listTr, cursor: 'pointer' }} onClick={() => navigate(`/dishes/${r.id}`)}>
                <td style={styles.listTd}>
                  <span style={{ fontWeight: 500 }}>{r.name}</span>
                </td>
                <td style={styles.listTd}>
                  <span style={{
                    background: '#3b82f6',
                    color: 'white',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    textTransform: 'uppercase' as const,
                  }}>
                    DISH
                  </span>
                </td>
                <td style={styles.listTd}>{r.menu_section_name || '-'}</td>
                <td style={styles.listTd}>
                  {r.cost_per_portion != null ? (
                    <span style={styles.costBadge}>{'\u00A3'}{r.cost_per_portion.toFixed(2)}</span>
                  ) : (
                    <span style={{ color: '#aaa', fontSize: '0.8rem' }}>-</span>
                  )}
                </td>
                <td style={styles.listTd}>
                  {r.flag_summary.length > 0 && <FoodFlagBadges flags={r.flag_summary} />}
                </td>
                <td style={styles.listTd}>
                  <button onClick={(e) => { e.stopPropagation(); duplicateMutation.mutate(r.id) }} style={styles.actionBtn}>Duplicate</button>
                  <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#e94560', marginLeft: '4px' }}>Archive</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create Dish Modal */}
      {showCreate && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>New Dish</h3>
              <button onClick={() => setShowCreate(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} style={styles.input} placeholder="e.g. Beef Burger, Caesar Salad" />

              <label style={styles.label}>Course</label>
              <select value={formSection} onChange={(e) => setFormSection(e.target.value)} style={styles.input}>
                <option value="">None</option>
                {sections?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>

              <label style={styles.label}>Description</label>
              <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} style={{ ...styles.input, minHeight: '60px' }} placeholder="Brief description..." />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
              <button onClick={handleCreate} disabled={!formName || createMutation.isPending} style={styles.primaryBtn}>
                {createMutation.isPending ? 'Creating...' : 'Create Dish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Course Modal */}
      {showSectionModal && (
        <div style={styles.overlay}>
          <div style={{ ...styles.modal, width: '450px' }}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Manage Courses</h3>
              <button onClick={() => { setShowSectionModal(false); setEditingSectionId(null) }} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              {/* Existing courses */}
              {sections && sections.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  {sections.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0', borderBottom: '1px solid #f0f0f0' }}>
                      {editingSectionId === s.id ? (
                        <>
                          <input
                            value={editingSectionName}
                            onChange={(e) => setEditingSectionName(e.target.value)}
                            style={{ ...styles.input, flex: 1 }}
                            autoFocus
                          />
                          <button
                            onClick={() => updateSectionMutation.mutate({ id: s.id, name: editingSectionName })}
                            disabled={!editingSectionName.trim()}
                            style={{ ...styles.actionBtn, color: '#22c55e' }}
                          >Save</button>
                          <button
                            onClick={() => { setEditingSectionId(null); setEditingSectionName('') }}
                            style={styles.actionBtn}
                          >Cancel</button>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1, fontSize: '0.9rem' }}>{s.name}</span>
                          <span style={{ fontSize: '0.75rem', color: '#888' }}>({s.recipe_count})</span>
                          <button
                            onClick={() => { setEditingSectionId(s.id); setEditingSectionName(s.name) }}
                            style={styles.actionBtn}
                          >Edit</button>
                          <button
                            onClick={() => {
                              if (confirm(`Delete course "${s.name}"? Dishes in this course will be unassigned.`)) {
                                deleteSectionMutation.mutate(s.id)
                              }
                            }}
                            style={{ ...styles.actionBtn, color: '#e94560' }}
                          >Delete</button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Add new course */}
              <label style={styles.label}>Add New Course</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input value={sectionName} onChange={(e) => setSectionName(e.target.value)} style={{ ...styles.input, flex: 1 }} placeholder="e.g. Starters, Mains, Desserts, Sides" />
                <button onClick={() => createSectionMutation.mutate(sectionName)} disabled={!sectionName} style={styles.primaryBtn}>Add</button>
              </div>
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => { setShowSectionModal(false); setEditingSectionId(null) }} style={styles.cancelBtn}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  statsBar: { display: 'flex', gap: '0.75rem', fontSize: '0.85rem', color: '#666', marginBottom: '0.75rem' },
  filterBar: { display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' as const },
  searchInput: { padding: '0.5rem 0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', width: '250px' },
  select: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' },
  card: { background: 'white', borderRadius: '8px', padding: '1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', cursor: 'pointer', transition: 'box-shadow 0.2s', border: '1px solid #eee' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' },
  sectionTag: { fontSize: '0.75rem', color: '#888', marginTop: '2px' },
  cardMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' },
  costBadge: { background: '#f0fdf4', color: '#166534', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 },
  cardActions: { display: 'flex', gap: '0.5rem', marginTop: '10px', borderTop: '1px solid #f0f0f0', paddingTop: '8px' },
  actionBtn: { padding: '0.25rem 0.5rem', border: '1px solid #ddd', borderRadius: '4px', background: 'white', cursor: 'pointer', fontSize: '0.75rem' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' },
  secondaryBtn: { padding: '0.6rem 1.25rem', background: 'white', color: '#333', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem' },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  loading: { padding: '3rem', textAlign: 'center' as const, color: '#888' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '450px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  modalBody: { padding: '1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.25rem', borderTop: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#555', marginTop: '0.75rem', marginBottom: '0.25rem' },
  input: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' as const },
  viewToggleBtn: { padding: '0.4rem 0.75rem', border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontSize: '0.8rem', color: '#666' },
  viewToggleBtnActive: { background: '#e94560', color: 'white', borderColor: '#e94560' },
  advancedFilterPanel: { background: '#fafafa', border: '1px solid #eee', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' },
  listTable: { width: '100%', borderCollapse: 'collapse' as const, background: 'white', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  listTh: { padding: '0.6rem 0.75rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.8rem', fontWeight: 600, color: '#555' },
  listTr: { borderBottom: '1px solid #f0f0f0' },
  listTd: { padding: '0.5rem 0.75rem', fontSize: '0.85rem' },
}
