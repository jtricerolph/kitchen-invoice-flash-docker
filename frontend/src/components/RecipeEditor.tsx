import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import FoodFlagBadges from './FoodFlagBadges'
import RecipeFlagMatrix from './RecipeFlagMatrix'

interface RecipeDetail {
  id: number
  name: string
  recipe_type: string
  menu_section_id: number | null
  menu_section_name: string | null
  description: string | null
  batch_portions: number
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  notes: string | null
  is_archived: boolean
  kds_menu_item_name: string | null
  ingredients: RecipeIngredientItem[]
  sub_recipes: SubRecipeItem[]
  steps: StepItem[]
  images: ImageItem[]
  created_at: string
  updated_at: string
}

interface RecipeIngredientItem {
  id: number
  ingredient_id: number
  ingredient_name: string
  quantity: number
  unit: string
  yield_percent: number
  effective_price: number | null
  cost: number | null
  notes: string | null
  sort_order: number
}

interface SubRecipeItem {
  id: number
  child_recipe_id: number
  child_recipe_name: string
  child_recipe_type: string
  batch_portions: number
  portions_needed: number
  cost_per_portion: number | null
  cost_contribution: number | null
  notes: string | null
  sort_order: number
}

interface StepItem {
  id: number
  step_number: number
  instruction: string
  image_path: string | null
  duration_minutes: number | null
  notes: string | null
}

interface ImageItem {
  id: number
  image_path: string
  caption: string | null
  image_type: string
  sort_order: number
}

interface CostData {
  recipe_id: number
  batch_portions: number
  ingredients: Array<{
    ingredient_id: number
    ingredient_name: string
    quantity: number
    unit: string
    yield_percent: number
    cost_recent: number | null
    cost_min: number | null
    cost_max: number | null
  }>
  sub_recipes: Array<{
    child_recipe_name: string
    portions_needed: number
    cost_contribution: number | null
  }>
  total_cost_recent: number | null
  total_cost_min: number | null
  total_cost_max: number | null
  cost_per_portion: number | null
  gp_comparison: Array<{ gp_target: number; suggested_price: number }> | null
}

interface FlagState {
  flags: Array<{
    food_flag_id: number
    flag_name: string
    flag_code: string | null
    flag_icon: string | null
    category_name: string
    propagation_type: string
    source_type: string
    is_active: boolean
    excludable_on_request: boolean
    source_ingredients: string[]
  }>
  unassessed_ingredients: Array<{ id: number; name: string }>
}

interface ChangeLogEntry {
  id: number
  change_summary: string
  username: string
  created_at: string
}

interface IngredientSuggestion {
  id: number
  name: string
  similarity: number
}

interface MenuSection {
  id: number
  name: string
}

export default function RecipeEditor() {
  const { id } = useParams<{ id: string }>()
  const recipeId = parseInt(id || '0')
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Edit states
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editBatch, setEditBatch] = useState('1')
  const [editPrep, setEditPrep] = useState('')
  const [editCook, setEditCook] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editSection, setEditSection] = useState<string>('')
  const [editKds, setEditKds] = useState('')
  const [isDirty, setIsDirty] = useState(false)

  // Add ingredient modal
  const [showAddIng, setShowAddIng] = useState(false)
  const [ingSearch, setIngSearch] = useState('')
  const [ingSuggestions, setIngSuggestions] = useState<IngredientSuggestion[]>([])
  const [selectedIngId, setSelectedIngId] = useState<number | null>(null)
  const [ingQty, setIngQty] = useState('')
  const [ingNotes, setIngNotes] = useState('')

  // Add sub-recipe modal
  const [showAddSub, setShowAddSub] = useState(false)
  const [subSearch, setSubSearch] = useState('')
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [subPortions, setSubPortions] = useState('')

  // Add step
  const [showAddStep, setShowAddStep] = useState(false)
  const [stepInstruction, setStepInstruction] = useState('')
  const [stepDuration, setStepDuration] = useState('')

  // Scale
  const [scalePortions, setScalePortions] = useState('')

  // Sections
  const [showMatrix, setShowMatrix] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showCostDetail, setShowCostDetail] = useState(false)

  // Fetch recipe
  const { data: recipe } = useQuery<RecipeDetail>({
    queryKey: ['recipe', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/${recipeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Not found')
      return res.json()
    },
    enabled: !!token && !!recipeId,
  })

  // Fetch sections
  const { data: sections } = useQuery<MenuSection[]>({
    queryKey: ['menu-sections'],
    queryFn: async () => {
      const res = await fetch('/api/recipes/menu-sections', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch costing
  const { data: costData } = useQuery<CostData>({
    queryKey: ['recipe-cost', recipeId, scalePortions],
    queryFn: async () => {
      const params = scalePortions ? `?scale_to=${scalePortions}` : ''
      const res = await fetch(`/api/recipes/${recipeId}/costing${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && !!recipeId,
  })

  // Fetch flags
  const { data: flagData } = useQuery<FlagState>({
    queryKey: ['recipe-flags', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/food-flags/recipes/${recipeId}/flags`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && !!recipeId,
  })

  // Fetch change log
  const { data: changeLog } = useQuery<ChangeLogEntry[]>({
    queryKey: ['recipe-changelog', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/${recipeId}/change-log`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && !!recipeId && showHistory,
  })

  // Fetch available recipes for sub-recipe dropdown
  const { data: availableRecipes } = useQuery<Array<{ id: number; name: string; recipe_type: string; batch_portions: number }>>({
    queryKey: ['recipes-list-for-sub'],
    queryFn: async () => {
      const res = await fetch('/api/recipes?recipe_type=component', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && showAddSub,
  })

  // Init form from recipe
  useEffect(() => {
    if (recipe) {
      setEditName(recipe.name)
      setEditDesc(recipe.description || '')
      setEditBatch(recipe.batch_portions.toString())
      setEditPrep(recipe.prep_time_minutes?.toString() || '')
      setEditCook(recipe.cook_time_minutes?.toString() || '')
      setEditNotes(recipe.notes || '')
      setEditSection(recipe.menu_section_id?.toString() || '')
      setEditKds(recipe.kds_menu_item_name || '')
      setIsDirty(false)
    }
  }, [recipe])

  // Search ingredients
  useEffect(() => {
    if (!ingSearch || ingSearch.length < 2 || !token) return
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ingredients/suggest?description=${encodeURIComponent(ingSearch)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          setIngSuggestions(data.suggestions || [])
        }
      } catch { /* ignore */ }
    }, 300)
    return () => clearTimeout(timer)
  }, [ingSearch, token])

  // Mutations
  const updateMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch(`/api/recipes/${recipeId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
      setIsDirty(false)
    },
  })

  const addIngMutation = useMutation({
    mutationFn: async (data: { ingredient_id: number; quantity: number; notes?: string }) => {
      const res = await fetch(`/api/recipes/${recipeId}/ingredients`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to add')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
      setShowAddIng(false)
      setIngSearch('')
      setSelectedIngId(null)
      setIngQty('')
      setIngNotes('')
    },
  })

  const removeIngMutation = useMutation({
    mutationFn: async (riId: number) => {
      const res = await fetch(`/api/recipes/recipe-ingredients/${riId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to remove')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
    },
  })

  const addSubMutation = useMutation({
    mutationFn: async (data: { child_recipe_id: number; portions_needed: number }) => {
      const res = await fetch(`/api/recipes/${recipeId}/sub-recipes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to add sub-recipe')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
      setShowAddSub(false)
    },
  })

  const removeSubMutation = useMutation({
    mutationFn: async (srId: number) => {
      const res = await fetch(`/api/recipes/recipe-sub-recipes/${srId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
    },
  })

  const addStepMutation = useMutation({
    mutationFn: async (data: { instruction: string; step_number: number; duration_minutes?: number }) => {
      const res = await fetch(`/api/recipes/${recipeId}/steps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      setShowAddStep(false)
      setStepInstruction('')
      setStepDuration('')
    },
  })

  const removeStepMutation = useMutation({
    mutationFn: async (stepId: number) => {
      const res = await fetch(`/api/recipes/recipe-steps/${stepId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] }),
  })

  const handleSave = () => {
    updateMutation.mutate({
      name: editName,
      description: editDesc || null,
      batch_portions: recipe?.recipe_type === 'component' ? parseInt(editBatch) : 1,
      prep_time_minutes: editPrep ? parseInt(editPrep) : null,
      cook_time_minutes: editCook ? parseInt(editCook) : null,
      notes: editNotes || null,
      menu_section_id: editSection ? parseInt(editSection) : null,
      kds_menu_item_name: editKds || null,
    })
  }

  const handlePrint = (format: string) => {
    window.open(`/api/recipes/${recipeId}/print?format=${format}&token=${token}`, '_blank')
  }

  if (!recipe) return <div style={styles.loading}>Loading recipe...</div>

  const totalCost = costData?.total_cost_recent
  const costPerPortion = costData?.cost_per_portion

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.topBar}>
        <button onClick={() => navigate('/recipes')} style={styles.backBtn}>← Back</button>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => handlePrint('kitchen')} style={styles.secondaryBtn}>Print Kitchen Card</button>
          <button onClick={() => handlePrint('full')} style={styles.secondaryBtn}>Print Full</button>
          {isDirty && <button onClick={handleSave} disabled={updateMutation.isPending} style={styles.primaryBtn}>
            {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>}
        </div>
      </div>

      {/* Recipe metadata */}
      <div style={styles.metaSection}>
        <div style={styles.metaRow}>
          <input
            value={editName}
            onChange={(e) => { setEditName(e.target.value); setIsDirty(true) }}
            style={{ ...styles.nameInput, flex: 1 }}
          />
          <span style={{
            background: recipe.recipe_type === 'plated' ? '#3b82f6' : '#8b5cf6',
            color: 'white', padding: '4px 12px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
          }}>
            {recipe.recipe_type.toUpperCase()}
          </span>
        </div>

        <div style={styles.metaGrid}>
          <div>
            <label style={styles.label}>Section</label>
            <select value={editSection} onChange={(e) => { setEditSection(e.target.value); setIsDirty(true) }} style={styles.input}>
              <option value="">None</option>
              {sections?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {recipe.recipe_type === 'component' && (
            <div>
              <label style={styles.label}>Batch Portions</label>
              <input type="number" value={editBatch} onChange={(e) => { setEditBatch(e.target.value); setIsDirty(true) }} style={styles.input} min="1" />
            </div>
          )}
          <div>
            <label style={styles.label}>Prep (min)</label>
            <input type="number" value={editPrep} onChange={(e) => { setEditPrep(e.target.value); setIsDirty(true) }} style={styles.input} />
          </div>
          <div>
            <label style={styles.label}>Cook (min)</label>
            <input type="number" value={editCook} onChange={(e) => { setEditCook(e.target.value); setIsDirty(true) }} style={styles.input} />
          </div>
        </div>

        <label style={styles.label}>Description</label>
        <textarea value={editDesc} onChange={(e) => { setEditDesc(e.target.value); setIsDirty(true) }} style={{ ...styles.input, minHeight: '50px' }} />

        <label style={styles.label}>KDS Menu Item Name</label>
        <input value={editKds} onChange={(e) => { setEditKds(e.target.value); setIsDirty(true) }} style={styles.input} placeholder="Matches KDS/SambaPOS item name" />
      </div>

      {/* Flags notification */}
      {flagData && flagData.unassessed_ingredients.length > 0 && (
        <div style={styles.flagWarning}>
          <strong>{flagData.unassessed_ingredients.length} ingredient{flagData.unassessed_ingredients.length > 1 ? 's are' : ' is'} missing allergen details</strong>
          {' — '}{flagData.unassessed_ingredients.map(i => i.name).join(', ')}
        </div>
      )}

      {/* Flag badges */}
      {flagData && flagData.flags.length > 0 && (
        <div style={{ margin: '0.75rem 0' }}>
          <FoodFlagBadges flags={flagData.flags} size="medium" />
          <button onClick={() => setShowMatrix(!showMatrix)} style={{ ...styles.linkBtn, marginLeft: '0.5rem' }}>
            {showMatrix ? 'Hide' : 'Show'} flag matrix
          </button>
        </div>
      )}

      {showMatrix && <RecipeFlagMatrix recipeId={recipeId} />}

      {/* Ingredients */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Ingredients</h3>
          <button onClick={() => setShowAddIng(true)} style={styles.addBtn}>+ Add</button>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Ingredient</th>
              <th style={styles.th}>Quantity</th>
              <th style={styles.th}>Yield %</th>
              <th style={styles.th}>Cost</th>
              <th style={styles.th}>Notes</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {recipe.ingredients.map(ri => (
              <tr key={ri.id} style={styles.tr}>
                <td style={styles.td}>{ri.ingredient_name}</td>
                <td style={styles.td}>{ri.quantity}{ri.unit}</td>
                <td style={styles.td}>{ri.yield_percent < 100 ? <span style={{ color: '#e94560' }}>{ri.yield_percent}%</span> : '100%'}</td>
                <td style={styles.td}>{ri.cost != null ? `£${ri.cost.toFixed(2)}` : '-'}</td>
                <td style={styles.td}><span style={{ color: '#888', fontSize: '0.8rem' }}>{ri.notes || ''}</span></td>
                <td style={styles.td}>
                  <button onClick={() => removeIngMutation.mutate(ri.id)} style={styles.removeBtn}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sub-recipes */}
      {(recipe.sub_recipes.length > 0 || recipe.recipe_type === 'plated') && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <h3 style={{ margin: 0 }}>Sub-Recipes</h3>
            <button onClick={() => setShowAddSub(true)} style={styles.addBtn}>+ Add</button>
          </div>
          {recipe.sub_recipes.length > 0 ? (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Recipe</th>
                  <th style={styles.th}>Type</th>
                  <th style={styles.th}>Batch</th>
                  <th style={styles.th}>Portions Used</th>
                  <th style={styles.th}>Cost</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {recipe.sub_recipes.map(sr => (
                  <tr key={sr.id} style={styles.tr}>
                    <td style={styles.td}>
                      <span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => navigate(`/recipes/${sr.child_recipe_id}`)}>
                        {sr.child_recipe_name}
                      </span>
                    </td>
                    <td style={styles.td}>{sr.child_recipe_type}</td>
                    <td style={styles.td}>{sr.batch_portions} portions</td>
                    <td style={styles.td}>{sr.portions_needed}</td>
                    <td style={styles.td}>{sr.cost_contribution != null ? `£${sr.cost_contribution.toFixed(2)}` : '-'}</td>
                    <td style={styles.td}>
                      <button onClick={() => removeSubMutation.mutate(sr.id)} style={styles.removeBtn}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>No sub-recipes added</div>
          )}
        </div>
      )}

      {/* Steps */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Method</h3>
          <button onClick={() => setShowAddStep(true)} style={styles.addBtn}>+ Add Step</button>
        </div>
        {recipe.steps.length > 0 ? (
          <ol style={{ paddingLeft: '1.5rem', margin: 0 }}>
            {recipe.steps.map(step => (
              <li key={step.id} style={{ marginBottom: '8px', fontSize: '0.9rem' }}>
                {step.instruction}
                {step.duration_minutes && <em style={{ color: '#888' }}> ({step.duration_minutes} min)</em>}
                <button onClick={() => removeStepMutation.mutate(step.id)} style={{ ...styles.removeBtn, marginLeft: '8px' }}>✕</button>
              </li>
            ))}
          </ol>
        ) : (
          <div style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>No steps added yet</div>
        )}
      </div>

      {/* Cost summary */}
      <div style={styles.costPanel}>
        <div style={styles.costHeader}>
          <h3 style={{ margin: 0 }}>Cost Summary</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label style={{ fontSize: '0.8rem' }}>Scale to:</label>
            <input
              type="number"
              value={scalePortions}
              onChange={(e) => setScalePortions(e.target.value)}
              style={{ ...styles.input, width: '80px' }}
              placeholder={recipe.batch_portions.toString()}
              min="1"
            />
            <span style={{ fontSize: '0.8rem', color: '#888' }}>portions</span>
          </div>
        </div>

        <div style={styles.costGrid}>
          <div style={styles.costBox}>
            <div style={styles.costLabel}>Total Cost</div>
            <div style={styles.costValue}>{totalCost != null ? `£${totalCost.toFixed(2)}` : '-'}</div>
          </div>
          <div style={styles.costBox}>
            <div style={styles.costLabel}>Cost/Portion</div>
            <div style={styles.costValue}>{costPerPortion != null ? `£${costPerPortion.toFixed(2)}` : '-'}</div>
          </div>
          {costData?.total_cost_min != null && (
            <div style={styles.costBox}>
              <div style={styles.costLabel}>Min / Max</div>
              <div style={{ fontSize: '0.85rem' }}>
                £{costData.total_cost_min.toFixed(2)} – £{costData.total_cost_max?.toFixed(2)}
              </div>
            </div>
          )}
        </div>

        {costData?.gp_comparison && (
          <div style={{ marginTop: '0.75rem' }}>
            <strong style={{ fontSize: '0.85rem' }}>GP Targets:</strong>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.35rem' }}>
              {costData.gp_comparison.map(gp => (
                <div key={gp.gp_target} style={styles.gpBadge}>
                  {gp.gp_target}% GP → <strong>£{gp.suggested_price.toFixed(2)}</strong>
                </div>
              ))}
            </div>
          </div>
        )}

        <button onClick={() => setShowCostDetail(!showCostDetail)} style={styles.linkBtn}>
          {showCostDetail ? 'Hide' : 'Show'} ingredient breakdown
        </button>

        {showCostDetail && costData?.ingredients && (
          <table style={{ ...styles.table, marginTop: '0.5rem' }}>
            <thead>
              <tr>
                <th style={styles.th}>Ingredient</th>
                <th style={styles.th}>Qty</th>
                <th style={styles.th}>Recent</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
              </tr>
            </thead>
            <tbody>
              {costData.ingredients.map(ci => (
                <tr key={ci.ingredient_id}>
                  <td style={styles.td}>{ci.ingredient_name}</td>
                  <td style={styles.td}>{ci.quantity}{ci.unit}</td>
                  <td style={styles.td}>{ci.cost_recent != null ? `£${ci.cost_recent.toFixed(2)}` : '-'}</td>
                  <td style={styles.td}>{ci.cost_min != null ? `£${ci.cost_min.toFixed(2)}` : '-'}</td>
                  <td style={styles.td}>{ci.cost_max != null ? `£${ci.cost_max.toFixed(2)}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Notes */}
      <div style={styles.section}>
        <label style={styles.label}>Notes</label>
        <textarea value={editNotes} onChange={(e) => { setEditNotes(e.target.value); setIsDirty(true) }} style={{ ...styles.input, minHeight: '60px' }} />
      </div>

      {/* Change history */}
      <div style={styles.section}>
        <button onClick={() => setShowHistory(!showHistory)} style={styles.linkBtn}>
          {showHistory ? 'Hide' : 'Show'} change history
        </button>
        {showHistory && changeLog && (
          <div style={{ marginTop: '0.5rem' }}>
            {changeLog.map(log => (
              <div key={log.id} style={styles.logEntry}>
                <span style={{ color: '#888', fontSize: '0.75rem' }}>{log.created_at}</span>
                <span style={{ fontSize: '0.75rem', color: '#555' }}>{log.username}</span>
                <span style={{ fontSize: '0.85rem' }}>{log.change_summary}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Ingredient Modal */}
      {showAddIng && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Add Ingredient</h3>
              <button onClick={() => setShowAddIng(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Search Ingredient</label>
              <input
                value={ingSearch}
                onChange={(e) => { setIngSearch(e.target.value); setSelectedIngId(null) }}
                style={styles.input}
                placeholder="Type to search..."
              />
              {ingSuggestions.length > 0 && !selectedIngId && (
                <div style={styles.suggestions}>
                  {ingSuggestions.map(s => (
                    <div
                      key={s.id}
                      style={styles.suggestionItem}
                      onClick={() => { setSelectedIngId(s.id); setIngSearch(s.name) }}
                    >
                      {s.name} <span style={{ color: '#888', fontSize: '0.75rem' }}>({Math.round(s.similarity * 100)}%)</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedIngId && (
                <>
                  <label style={styles.label}>Quantity (in standard unit)</label>
                  <input type="number" value={ingQty} onChange={(e) => setIngQty(e.target.value)} style={styles.input} step="0.1" />
                  <label style={styles.label}>Notes (optional)</label>
                  <input value={ingNotes} onChange={(e) => setIngNotes(e.target.value)} style={styles.input} placeholder="e.g. finely diced" />
                </>
              )}
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowAddIng(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => addIngMutation.mutate({ ingredient_id: selectedIngId!, quantity: parseFloat(ingQty), notes: ingNotes || undefined })}
                disabled={!selectedIngId || !ingQty || addIngMutation.isPending}
                style={styles.primaryBtn}
              >
                {addIngMutation.isPending ? 'Adding...' : 'Add'}
              </button>
            </div>
            {addSubMutation.error && <div style={styles.errorMsg}>{addSubMutation.error.message}</div>}
          </div>
        </div>
      )}

      {/* Add Sub-recipe Modal */}
      {showAddSub && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Add Sub-Recipe</h3>
              <button onClick={() => setShowAddSub(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Select Component Recipe</label>
              <select
                value={selectedSubId?.toString() || ''}
                onChange={(e) => setSelectedSubId(parseInt(e.target.value))}
                style={styles.input}
              >
                <option value="">Select...</option>
                {availableRecipes?.filter(r => r.id !== recipeId).map(r => (
                  <option key={r.id} value={r.id}>{r.name} (batch: {r.batch_portions})</option>
                ))}
              </select>
              <label style={styles.label}>Portions Needed</label>
              <input type="number" value={subPortions} onChange={(e) => setSubPortions(e.target.value)} style={styles.input} step="0.5" min="0.1" />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowAddSub(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => addSubMutation.mutate({ child_recipe_id: selectedSubId!, portions_needed: parseFloat(subPortions) })}
                disabled={!selectedSubId || !subPortions || addSubMutation.isPending}
                style={styles.primaryBtn}
              >
                {addSubMutation.isPending ? 'Adding...' : 'Add'}
              </button>
            </div>
            {addSubMutation.error && <div style={styles.errorMsg}>{addSubMutation.error.message}</div>}
          </div>
        </div>
      )}

      {/* Add Step Modal */}
      {showAddStep && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Add Step</h3>
              <button onClick={() => setShowAddStep(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Instruction</label>
              <textarea value={stepInstruction} onChange={(e) => setStepInstruction(e.target.value)} style={{ ...styles.input, minHeight: '80px' }} />
              <label style={styles.label}>Duration (minutes, optional)</label>
              <input type="number" value={stepDuration} onChange={(e) => setStepDuration(e.target.value)} style={styles.input} />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowAddStep(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => addStepMutation.mutate({
                  instruction: stepInstruction,
                  step_number: (recipe?.steps.length || 0) + 1,
                  duration_minutes: stepDuration ? parseInt(stepDuration) : undefined,
                })}
                disabled={!stepInstruction || addStepMutation.isPending}
                style={styles.primaryBtn}
              >
                Add Step
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1000px', margin: '0 auto' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  backBtn: { padding: '0.5rem 1rem', background: 'white', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer' },
  metaSection: { background: 'white', padding: '1.25rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '1rem' },
  metaRow: { display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' },
  metaGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' },
  nameInput: { fontSize: '1.3rem', fontWeight: 600, padding: '0.4rem', border: '1px solid #e0e0e0', borderRadius: '6px' },
  section: { background: 'white', padding: '1rem 1.25rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '1rem' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { padding: '0.5rem 0.5rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', fontSize: '0.75rem', fontWeight: 600, color: '#666' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.4rem 0.5rem', fontSize: '0.85rem' },
  addBtn: { padding: '0.35rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' },
  removeBtn: { padding: '2px 6px', background: 'none', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem', color: '#e94560' },
  costPanel: { background: '#f8f9fa', padding: '1.25rem', borderRadius: '8px', border: '2px solid #e0e0e0', marginBottom: '1rem' },
  costHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  costGrid: { display: 'flex', gap: '1.5rem', flexWrap: 'wrap' as const },
  costBox: { minWidth: '120px' },
  costLabel: { fontSize: '0.75rem', color: '#666', fontWeight: 600 },
  costValue: { fontSize: '1.3rem', fontWeight: 700, color: '#333' },
  gpBadge: { background: 'white', padding: '0.35rem 0.75rem', borderRadius: '6px', border: '1px solid #ddd', fontSize: '0.8rem' },
  flagWarning: { background: '#fff3cd', color: '#856404', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.85rem' },
  logEntry: { display: 'flex', gap: '0.5rem', padding: '0.35rem 0', borderBottom: '1px solid #f0f0f0', alignItems: 'center' },
  linkBtn: { background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '0.8rem', padding: 0 },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 },
  secondaryBtn: { padding: '0.5rem 1rem', background: 'white', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem' },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  loading: { padding: '3rem', textAlign: 'center' as const, color: '#888' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '450px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  modalBody: { padding: '1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.25rem', borderTop: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#555', marginTop: '0.5rem', marginBottom: '0.2rem' },
  input: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' as const },
  suggestions: { background: 'white', border: '1px solid #ddd', borderRadius: '6px', maxHeight: '150px', overflow: 'auto', marginTop: '4px' },
  suggestionItem: { padding: '0.5rem 0.75rem', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: '0.85rem' },
  errorMsg: { padding: '0.75rem 1.25rem', color: '#dc3545', fontSize: '0.85rem' },
}
