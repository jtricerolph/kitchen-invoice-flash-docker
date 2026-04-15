import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'
import FoodFlagBadges from './FoodFlagBadges'

interface IngredientChange {
  summary: string
  date: string | null
  ingredient_name: string | null
  old_price: number | null
  new_price: number | null
  unit: string | null
  cost_impact: number | null
  source_invoice_id: number | null
  source_invoice_number: string | null
}

interface ImpactItem {
  recipe_id: number
  recipe_name: string
  recipe_type: string
  output_unit: string
  current_cost_per_unit: number | null
  previous_cost_per_unit: number | null
  cost_change: number | null
  cost_change_pct: number | null
  ingredient_changes: IngredientChange[]
}

interface CostTrendSnapshot {
  id: number
  created_at: string
  cost_per_portion: number
  total_cost: number
  trigger: string
  changes: string[]
}

function formatIngredientPrice(price: number, unit: string | null): string {
  if (unit === 'g' && price < 1) return `\u00A3${(price * 1000).toFixed(2)}/kg`
  if (unit === 'ml' && price < 1) return `\u00A3${(price * 1000).toFixed(2)}/ltr`
  return `\u00A3${price.toFixed(4)}/${unit || '?'}`
}

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
  gross_sell_price: number | null
  kds_menu_item_name: string | null
  sambapos_portion_name: string | null
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
  const [showArchived, setShowArchived] = useState(false)
  const [costChangeDays, setCostChangeDays] = useState(30)
  const [expandedCostId, setExpandedCostId] = useState<number | null>(null)
  const [trendTooltip, setTrendTooltip] = useState<{ x: number; y: number; date: string; cost: string; trigger: string } | null>(null)

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
    queryKey: ['dishes', search, sectionFilter, showArchived],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      params.set('recipe_type', 'dish')
      if (sectionFilter) params.set('menu_section_id', sectionFilter)
      if (showArchived) params.set('archived', 'true')
      const res = await fetch(`/api/recipes?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch dishes')
      return res.json()
    },
    enabled: !!token,
  })

  // Price impact data for badge overlay
  const { data: impactData } = useQuery<{ days: number; recipes: ImpactItem[] }>({
    queryKey: ['price-impact-dishes', costChangeDays],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/price-impact?days=${costChangeDays}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch price impact')
      return res.json()
    },
    enabled: !!token,
  })

  // Build lookup: recipe_id → impact item (dishes only)
  const impactMap = new Map<number, ImpactItem>()
  impactData?.recipes.filter(r => r.recipe_type === 'dish').forEach(r => impactMap.set(r.recipe_id, r))

  // Cost trend for expanded dish
  const { data: costTrendRaw } = useQuery<{ snapshots: CostTrendSnapshot[] }>({
    queryKey: ['cost-trend', expandedCostId],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/${expandedCostId}/cost-trend`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch cost trend')
      return res.json()
    },
    enabled: !!token && !!expandedCostId,
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

  const unarchiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/recipes/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_archived: false }),
      })
      if (!res.ok) throw new Error('Failed to unarchive')
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

  const renderCostTrendPanel = (recipeId: number) => {
    const impact = impactMap.get(recipeId)
    const snapshots = expandedCostId === recipeId ? costTrendRaw?.snapshots : undefined

    return (
      <div>
        {/* Cost trend chart */}
        {snapshots && snapshots.length > 1 && (() => {
          const costs = snapshots.map(d => d.cost_per_portion)
          const minCost = Math.min(...costs)
          const maxCost = Math.max(...costs)
          const costRange = maxCost - minCost || 1
          const chartWidth = 460
          const chartHeight = 110
          const padX = 40
          const padY = 18
          const plotW = chartWidth - padX * 2
          const plotH = chartHeight - padY * 2

          const points = snapshots.map((d, i) => {
            const x = padX + (i / (snapshots.length - 1)) * plotW
            const y = padY + plotH - ((d.cost_per_portion - minCost) / costRange) * plotH
            return { x, y, ...d }
          })
          const polyline = points.map(p => `${p.x},${p.y}`).join(' ')
          const yLabels = [minCost, minCost + costRange / 2, maxCost]
          const xLabelIndices = [0, Math.floor(snapshots.length / 2), snapshots.length - 1]

          return (
            <div>
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#888', marginBottom: '4px' }}>Cost Trend</div>
                <svg width={chartWidth} height={chartHeight} style={{ background: 'white', borderRadius: '6px', border: '1px solid #e0e0e0' }}>
                  {yLabels.map((val, i) => {
                    const y = padY + plotH - ((val - minCost) / costRange) * plotH
                    return (
                      <g key={i}>
                        <line x1={padX} y1={y} x2={chartWidth - padX} y2={y} stroke="#f0f0f0" strokeWidth="1" />
                        <text x={padX - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#888">
                          {'\u00A3'}{val.toFixed(2)}
                        </text>
                      </g>
                    )
                  })}
                  {xLabelIndices.filter((v, i, a) => a.indexOf(v) === i).map(idx => {
                    const p = points[idx]
                    const dateStr = new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                    return (
                      <text key={idx} x={p.x} y={chartHeight - 2} textAnchor="middle" fontSize="9" fill="#888">
                        {dateStr}
                      </text>
                    )
                  })}
                  <polyline points={polyline} fill="none" stroke="#e94560" strokeWidth="2" />
                  {points.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={3.5}
                      fill="#e94560"
                      stroke="white"
                      strokeWidth="1.5"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => {
                        setTrendTooltip({
                          x: p.x,
                          y: p.y - 10,
                          date: new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                          cost: `\u00A3${p.cost_per_portion.toFixed(2)}`,
                          trigger: p.trigger,
                        })
                      }}
                      onMouseLeave={() => setTrendTooltip(null)}
                    />
                  ))}
                </svg>
                {trendTooltip && (
                  <div style={{
                    position: 'absolute',
                    left: trendTooltip.x,
                    top: trendTooltip.y - 50,
                    transform: 'translateX(-50%)',
                    background: '#333',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                    zIndex: 20,
                  }}>
                    <div>{trendTooltip.date}</div>
                    <div>{trendTooltip.cost}</div>
                    {trendTooltip.trigger && <div style={{ color: '#ccc', fontSize: '0.7rem' }}>{trendTooltip.trigger}</div>}
                  </div>
                )}
              </div>

            </div>
          )
        })()}

        {snapshots && snapshots.length <= 1 && (
          <div style={{ color: '#888', fontStyle: 'italic', fontSize: '0.8rem', marginBottom: '6px' }}>
            Not enough data for trend chart
          </div>
        )}

        {!snapshots && <div style={{ color: '#888', fontSize: '0.8rem' }}>Loading cost trend...</div>}

        {/* Ingredient price changes from impact data */}
        {impact && impact.ingredient_changes.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontWeight: 600, fontSize: '0.7rem', color: '#888', marginBottom: '4px' }}>
              Ingredient Price Changes ({impact.ingredient_changes.length}) — last {costChangeDays} days
            </div>
            <div style={{ fontSize: '0.8rem', color: '#555' }}>
              {impact.ingredient_changes.map((c, i) => (
                <div key={i} style={{ padding: '3px 0', borderBottom: i < impact.ingredient_changes.length - 1 ? '1px solid #eee' : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    <span style={{ color: '#888', marginRight: '0.5rem', fontSize: '0.75rem' }}>{c.date}</span>
                    {c.source_invoice_id && (
                      <span
                        style={{ cursor: 'pointer', color: '#e94560', marginRight: '0.5rem', textDecoration: 'underline', fontSize: '0.75rem' }}
                        onClick={() => navigate(`/invoice/${c.source_invoice_id}`)}
                      >
                        {c.source_invoice_number || `#${c.source_invoice_id}`}
                      </span>
                    )}
                    {c.ingredient_name && c.old_price != null && c.new_price != null ? (
                      <>
                        {c.ingredient_name}: {formatIngredientPrice(c.old_price, c.unit)} {'\u2192'} {formatIngredientPrice(c.new_price, c.unit)}
                      </>
                    ) : c.ingredient_name && c.new_price != null && c.old_price == null ? (
                      <>
                        {c.ingredient_name} price set: {formatIngredientPrice(c.new_price, c.unit)}
                      </>
                    ) : (
                      c.summary
                    )}
                  </span>
                  {c.cost_impact != null && (
                    <span style={{
                      fontFamily: 'monospace',
                      fontWeight: 600,
                      fontSize: '0.75rem',
                      color: c.cost_impact > 0 ? '#dc2626' : c.cost_impact < 0 ? '#16a34a' : '#888',
                      marginLeft: '1rem',
                      whiteSpace: 'nowrap',
                    }}>
                      {c.cost_impact > 0 ? '+' : ''}{'\u00A3'}{c.cost_impact.toFixed(4)}/{impact.output_unit}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

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
        <span>{filteredRecipes.length} {showArchived ? 'archived ' : ''}dishes</span>
        {impactMap.size > 0 && (
          <>
            <span style={{ color: '#888' }}>|</span>
            <span style={{ color: '#dc2626', fontWeight: 600 }}>{impactMap.size} with cost changes</span>
          </>
        )}
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
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show Archived
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <label style={{ fontSize: '0.8rem', color: '#666', whiteSpace: 'nowrap' }}>Cost changes:</label>
          <select value={costChangeDays} onChange={e => setCostChangeDays(Number(e.target.value))} style={{ ...styles.select, padding: '0.35rem 0.4rem', fontSize: '0.8rem' }}>
            <option value={7}>7d</option>
            <option value={14}>14d</option>
            <option value={30}>30d</option>
            <option value={60}>60d</option>
            <option value={90}>90d</option>
          </select>
        </div>
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
            <div key={r.id} style={{ ...styles.card, ...(r.is_archived ? { opacity: 0.6 } : {}) }} onClick={() => navigate(`/dishes/${r.id}`)}>
              <div style={styles.cardHeader}>
                <span style={{ fontWeight: 600, fontSize: '1rem', ...(r.is_archived ? { textDecoration: 'line-through' } : {}) }}>{r.name}</span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {r.is_archived && <span style={{ background: '#999', color: 'white', padding: '2px 8px', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600 }}>ARCHIVED</span>}
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
              </div>

              {r.menu_section_name && (
                <div style={styles.sectionTag}>{r.menu_section_name}</div>
              )}

              {r.kds_menu_item_name && (
                <div style={{ fontSize: '0.7rem', color: '#999', marginTop: '0.15rem' }}>
                  SambaPOS: {r.kds_menu_item_name}
                  {r.sambapos_portion_name && r.sambapos_portion_name !== 'Normal' && ` (${r.sambapos_portion_name})`}
                </div>
              )}

              <div style={styles.cardMeta}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {r.cost_per_portion != null ? (
                    <span style={styles.costBadge}>{'\u00A3'}{r.cost_per_portion.toFixed(2)}/portion</span>
                  ) : (
                    <span style={{ color: '#aaa', fontSize: '0.8rem' }}>No costing</span>
                  )}
                  {impactMap.has(r.id) && (() => {
                    const impact = impactMap.get(r.id)!
                    const up = (impact.cost_change ?? 0) > 0
                    return (
                      <span
                        onClick={(e) => { e.stopPropagation(); setExpandedCostId(expandedCostId === r.id ? null : r.id); setTrendTooltip(null) }}
                        style={{
                          background: up ? '#fef2f2' : '#f0fdf4',
                          color: up ? '#dc2626' : '#16a34a',
                          border: `1px solid ${up ? '#fca5a5' : '#86efac'}`,
                          padding: '1px 6px',
                          borderRadius: '10px',
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                        title={`${impact.ingredient_changes.length} ingredient price change(s) in last ${costChangeDays}d`}
                      >
                        {up ? '\u25B2' : '\u25BC'} {impact.cost_change_pct != null ? `${impact.cost_change_pct > 0 ? '+' : ''}${impact.cost_change_pct}%` : ''}
                      </span>
                    )
                  })()}
                </div>
                {r.gross_sell_price != null && (
                  <span style={{ fontSize: '0.8rem', color: '#555' }}>
                    Sell: {'\u00A3'}{r.gross_sell_price.toFixed(2)}
                  </span>
                )}
                {r.gross_sell_price != null && r.cost_per_portion != null && (() => {
                  const netSell = r.gross_sell_price / 1.2
                  const gp = ((netSell - r.cost_per_portion) / netSell) * 100
                  return (
                    <span style={{
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      color: gp >= 70 ? '#16a34a' : gp >= 60 ? '#ca8a04' : '#dc2626',
                    }}>
                      {gp.toFixed(1)}% GP
                    </span>
                  )
                })()}
              </div>

              {/* Inline cost trend expansion */}
              {expandedCostId === r.id && (
                <div onClick={(e) => e.stopPropagation()} style={{ marginTop: '8px', borderTop: '1px solid #eee', paddingTop: '8px' }}>
                  {renderCostTrendPanel(r.id)}
                </div>
              )}

              {r.flag_summary.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <FoodFlagBadges flags={r.flag_summary} />
                </div>
              )}

              <div style={styles.cardActions}>
                <button onClick={(e) => { e.stopPropagation(); duplicateMutation.mutate(r.id) }} style={styles.actionBtn}>Duplicate</button>
                {r.is_archived ? (
                  <button onClick={(e) => { e.stopPropagation(); unarchiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#22c55e' }}>Restore</button>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#e94560' }}>Archive</button>
                )}
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
              <th style={styles.listTh}>Sell Price</th>
              <th style={styles.listTh}>GP%</th>
              <th style={styles.listTh}>Flags</th>
              <th style={styles.listTh}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRecipes.map(r => (
              <>
              <tr key={r.id} style={{ ...styles.listTr, cursor: 'pointer', ...(r.is_archived ? { opacity: 0.6 } : {}) }} onClick={() => navigate(`/dishes/${r.id}`)}>
                <td style={styles.listTd}>
                  <span style={{ fontWeight: 500, ...(r.is_archived ? { textDecoration: 'line-through' } : {}) }}>{r.name}</span>
                  {r.is_archived && <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: '#999', fontStyle: 'italic' }}>archived</span>}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {r.cost_per_portion != null ? (
                      <span style={styles.costBadge}>{'\u00A3'}{r.cost_per_portion.toFixed(2)}</span>
                    ) : (
                      <span style={{ color: '#aaa', fontSize: '0.8rem' }}>-</span>
                    )}
                    {impactMap.has(r.id) && (() => {
                      const impact = impactMap.get(r.id)!
                      const up = (impact.cost_change ?? 0) > 0
                      return (
                        <span
                          onClick={(e) => { e.stopPropagation(); setExpandedCostId(expandedCostId === r.id ? null : r.id); setTrendTooltip(null) }}
                          style={{
                            background: up ? '#fef2f2' : '#f0fdf4',
                            color: up ? '#dc2626' : '#16a34a',
                            border: `1px solid ${up ? '#fca5a5' : '#86efac'}`,
                            padding: '1px 6px',
                            borderRadius: '10px',
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                          title={`${impact.ingredient_changes.length} ingredient price change(s) in last ${costChangeDays}d — click to expand`}
                        >
                          {up ? '\u25B2' : '\u25BC'} {impact.cost_change_pct != null ? `${impact.cost_change_pct > 0 ? '+' : ''}${impact.cost_change_pct}%` : ''}
                        </span>
                      )
                    })()}
                  </div>
                </td>
                <td style={styles.listTd}>
                  {r.gross_sell_price != null ? (
                    <span>{'\u00A3'}{r.gross_sell_price.toFixed(2)}</span>
                  ) : (
                    <span style={{ color: '#aaa', fontSize: '0.8rem' }}>-</span>
                  )}
                </td>
                <td style={styles.listTd}>
                  {r.gross_sell_price != null && r.cost_per_portion != null ? (() => {
                    const netSell = r.gross_sell_price / 1.2
                    const gp = ((netSell - r.cost_per_portion) / netSell) * 100
                    return (
                      <span style={{
                        fontWeight: 600,
                        color: gp >= 70 ? '#16a34a' : gp >= 60 ? '#ca8a04' : '#dc2626',
                      }}>
                        {gp.toFixed(1)}%
                      </span>
                    )
                  })() : (
                    <span style={{ color: '#aaa', fontSize: '0.8rem' }}>-</span>
                  )}
                </td>
                <td style={styles.listTd}>
                  {r.flag_summary.length > 0 && <FoodFlagBadges flags={r.flag_summary} />}
                </td>
                <td style={styles.listTd}>
                  <button onClick={(e) => { e.stopPropagation(); duplicateMutation.mutate(r.id) }} style={styles.actionBtn}>Duplicate</button>
                  {r.is_archived ? (
                    <button onClick={(e) => { e.stopPropagation(); unarchiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#22c55e', marginLeft: '4px' }}>Restore</button>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#e94560', marginLeft: '4px' }}>Archive</button>
                  )}
                </td>
              </tr>
              {expandedCostId === r.id && (
                <tr key={`${r.id}-cost-detail`}>
                  <td colSpan={8} style={{ padding: '0.5rem 0.75rem 0.75rem 2rem', background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                    {renderCostTrendPanel(r.id)}
                  </td>
                </tr>
              )}
              </>
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
  checkLabel: { display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', color: '#555', cursor: 'pointer', whiteSpace: 'nowrap' as const },
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
