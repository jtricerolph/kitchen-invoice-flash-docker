import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import FoodFlagBadges from './FoodFlagBadges'
import RecipeFlagMatrix from './RecipeFlagMatrix'
import IngredientModal from './IngredientModal'
import PublishToMenuModal from './PublishToMenuModal'
import { EditingIngredient, IngredientModalResult } from '../utils/ingredientHelpers'

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
  gross_sell_price: number | null
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
  standard_unit: string
  compatible_units: string[]
  yield_percent: number
  effective_price: number | null
  cost: number | null
  is_manual_price?: boolean
  has_no_price?: boolean
  notes: string | null
  sort_order: number
}

interface SubRecipeItem {
  id: number
  child_recipe_id: number
  child_recipe_name: string
  child_recipe_type: string
  batch_portions: number
  batch_output_type: string
  batch_yield_qty: number | null
  batch_yield_unit: string | null
  output_qty: number
  output_unit: string
  portions_needed: number
  portions_needed_unit: string
  compatible_units: string[]
  cost_per_portion: number | null
  cost_contribution: number | null
  has_manual_price_ingredients?: boolean
  has_no_price_ingredients?: boolean
  notes: string | null
  sort_order: number
}

interface StepItem {
  id: number
  step_number: number
  title: string | null
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

interface CostIngredient {
  ingredient_id: number
  ingredient_name: string
  quantity: number
  unit: string
  yield_percent: number
  cost_recent: number | null
  cost_min: number | null
  cost_max: number | null
  is_manual_price?: boolean
  has_no_price?: boolean
}

interface CostSubRecipe {
  child_recipe_id: number
  child_recipe_name: string
  batch_output_type: string
  output_qty: number
  output_unit: string
  portions_needed: number
  cost_contribution: number | null
  child_ingredients?: CostIngredient[]
  child_sub_recipes?: CostSubRecipe[]
}

interface CostData {
  recipe_id: number
  batch_portions: number
  batch_output_type: string
  output_qty: number
  output_unit: string
  ingredients: CostIngredient[]
  sub_recipes: CostSubRecipe[]
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
    category_id: number
    category_name: string
    propagation_type: string
    source_type: string
    is_active: boolean
    excludable_on_request: boolean
    source_ingredients: string[]
  }>
  unassessed_ingredients: Array<{ id: number; name: string }>
  open_suggestion_ingredients?: Array<{ ingredient_id: number; ingredient_name: string; suggestion_count: number }>
}

interface CostTrendSnapshot {
  id: number
  cost_per_portion: number
  total_cost: number
  trigger: string
  created_at: string
  changes: string[]
}

interface CostTrendResponse {
  snapshots: CostTrendSnapshot[]
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
  standard_unit: string
  similarity: number
}

interface MenuSection {
  id: number
  name: string
}

const COMPATIBLE_UNITS: Record<string, string[]> = {
  g: ['g', 'kg'], kg: ['g', 'kg'],
  ml: ['ml', 'ltr'], ltr: ['ml', 'ltr'],
  each: ['each'], portion: ['portion'],
}
function getCompatibleUnits(unit: string): string[] {
  return COMPATIBLE_UNITS[unit] || [unit]
}

export default function DishEditor() {
  const { id } = useParams<{ id: string }>()
  const recipeId = parseInt(id || '0')
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Edit states
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
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
  const [selectedIngUnit, setSelectedIngUnit] = useState('')
  const [selectedIngCompatUnits, setSelectedIngCompatUnits] = useState<string[]>([])
  const [ingQty, setIngQty] = useState('')
  const [ingNotes, setIngNotes] = useState('')

  // Create ingredient sub-modal
  const [showCreateIng, setShowCreateIng] = useState(false)

  // Edit ingredient modal (from open suggestion click)
  const [editIngId, setEditIngId] = useState<number | null>(null)

  // Inline editing ingredient rows
  const [editingRiId, setEditingRiId] = useState<number | null>(null)
  const [editRiQty, setEditRiQty] = useState('')
  const [editRiUnit, setEditRiUnit] = useState('')
  const [editRiYield, setEditRiYield] = useState('100')
  const [editRiNotes, setEditRiNotes] = useState('')

  // Drag-and-drop sort mode
  const [sortingIngredients, setSortingIngredients] = useState(false)
  const [sortingSubs, setSortingSubs] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [dragType, setDragType] = useState<'ing' | 'sub' | null>(null)

  // Add sub-recipe modal
  const [showAddSub, setShowAddSub] = useState(false)
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [subPortions, setSubPortions] = useState('')
  const [subUnit, setSubUnit] = useState('')

  // Add/Edit step
  const [showAddStep, setShowAddStep] = useState(false)
  const [stepTitle, setStepTitle] = useState('')
  const [stepInstruction, setStepInstruction] = useState('')
  const [stepDuration, setStepDuration] = useState('')
  const [editingStepId, setEditingStepId] = useState<number | null>(null)

  // Scale
  const [scalePortions, setScalePortions] = useState('')

  // Image upload
  const [showImageUpload, setShowImageUpload] = useState(false)
  const [imageCaption, setImageCaption] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)

  // Gross price GP calculator
  const [grossPrice, setGrossPrice] = useState('')

  // Publish to menu
  const [showPublishModal, setShowPublishModal] = useState(false)

  // Cost trend
  const [showCostTrend, setShowCostTrend] = useState(false)
  const [trendTooltip, setTrendTooltip] = useState<{ x: number; y: number; date: string; cost: string; trigger: string } | null>(null)

  // Image lightbox
  const [lightboxImg, setLightboxImg] = useState<string | null>(null)

  // Sections — showMatrix stores category_id or null
  const [showMatrix, setShowMatrix] = useState<number | null>(null)
  const [showHistory, setShowHistory] = useState(false)

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

  // Fetch sections (dish courses)
  const { data: sections } = useQuery<MenuSection[]>({
    queryKey: ['dish-courses'],
    queryFn: async () => {
      const res = await fetch('/api/recipes/menu-sections?section_type=dish', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch costing (base, unscaled)
  const { data: costData } = useQuery<CostData>({
    queryKey: ['recipe-cost', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/${recipeId}/costing`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && !!recipeId,
  })

  // Fetch costing (scaled)
  const { data: scaledCostData } = useQuery<CostData>({
    queryKey: ['recipe-cost-scaled', recipeId, scalePortions],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/${recipeId}/costing?scale_to=${scalePortions}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && !!recipeId && !!scalePortions && parseInt(scalePortions) > 0,
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

  // Fetch all flag categories (for matrix buttons regardless of active flags)
  const { data: flagCategories } = useQuery<Array<{ id: number; name: string; propagation_type: string; required: boolean }>>({
    queryKey: ['food-flag-categories'],
    queryFn: async () => {
      const res = await fetch('/api/food-flags/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token,
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

  // Fetch cost trend
  const { data: costTrendRaw } = useQuery<CostTrendResponse>({
    queryKey: ['recipe-cost-trend', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/${recipeId}/cost-trend`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch cost trend')
      return res.json()
    },
    enabled: !!token && !!recipeId && showCostTrend,
  })

  // Fetch menus this dish is published on
  const { data: dishMenus } = useQuery<Array<{ menu_id: number; menu_name: string; is_active: boolean }>>({
    queryKey: ['dish-menus', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/menus/dish/${recipeId}/menus`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token && !!recipeId,
  })

  // Fetch ingredient detail for edit modal
  const { data: editIngData } = useQuery<EditingIngredient>({
    queryKey: ['ingredient-edit', editIngId],
    queryFn: async () => {
      const res = await fetch(`/api/ingredients/${editIngId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Not found')
      const data = await res.json()
      return {
        id: data.id,
        name: data.name,
        category_id: data.category_id,
        standard_unit: data.standard_unit,
        yield_percent: Number(data.yield_percent),
        manual_price: data.manual_price != null ? Number(data.manual_price) : null,
        notes: data.notes,
        is_prepackaged: data.is_prepackaged || false,
        is_free: data.is_free || false,
        product_ingredients: data.product_ingredients,
        has_label_image: data.has_label_image || false,
      }
    },
    enabled: !!token && !!editIngId,
  })

  // Fetch available recipes for sub-recipe dropdown (component recipes only)
  const { data: availableRecipes } = useQuery<Array<{ id: number; name: string; recipe_type: string; batch_portions: number; batch_output_type: string; batch_yield_qty: number | null; batch_yield_unit: string | null; output_unit: string }>>({
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
      setEditPrep(recipe.prep_time_minutes?.toString() || '')
      setEditCook(recipe.cook_time_minutes?.toString() || '')
      setEditNotes(recipe.notes || '')
      setEditSection(recipe.menu_section_id?.toString() || '')
      setEditKds(recipe.kds_menu_item_name || '')
      setGrossPrice(recipe.gross_sell_price?.toString() || '')
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
          setIngSuggestions(Array.isArray(data) ? data : data.suggestions || [])
        } else {
          console.warn('Ingredient suggest failed:', res.status, await res.text().catch(() => ''))
        }
      } catch (err) { console.warn('Ingredient suggest error:', err) }
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
      queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost-trend', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
      setIsDirty(false)
    },
  })

  const addIngMutation = useMutation({
    mutationFn: async (data: { ingredient_id: number; quantity: number; unit?: string; notes?: string }) => {
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
      queryClient.invalidateQueries({ queryKey: ['recipe-cost-trend', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
      setShowAddIng(false)
      setIngSearch('')
      setSelectedIngId(null)
      setSelectedIngUnit('')
      setSelectedIngCompatUnits([])
      setIngQty('')
      setIngNotes('')
    },
  })

  const updateIngMutation = useMutation({
    mutationFn: async ({ riId, quantity, unit, yield_percent, notes }: { riId: number; quantity?: number; unit?: string; yield_percent?: number; notes?: string }) => {
      const res = await fetch(`/api/recipes/recipe-ingredients/${riId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity, unit, yield_percent, notes }),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-cost-trend', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
      setEditingRiId(null)
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
      queryClient.invalidateQueries({ queryKey: ['recipe-cost-trend', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
    },
  })

  const addSubMutation = useMutation({
    mutationFn: async (data: { child_recipe_id: number; portions_needed: number; portions_needed_unit?: string }) => {
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
      queryClient.invalidateQueries({ queryKey: ['recipe-cost-trend', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
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
      queryClient.invalidateQueries({ queryKey: ['recipe-cost-trend', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-changelog', recipeId] })
    },
  })

  const addStepMutation = useMutation({
    mutationFn: async (data: { title?: string; instruction: string; step_number: number; duration_minutes?: number }) => {
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
      setStepTitle('')
      setStepInstruction('')
      setStepDuration('')
    },
  })

  const updateStepMutation = useMutation({
    mutationFn: async ({ stepId, data }: { stepId: number; data: { title?: string; instruction?: string; duration_minutes?: number } }) => {
      const res = await fetch(`/api/recipes/recipe-steps/${stepId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      setEditingStepId(null)
      setShowAddStep(false)
      setStepTitle('')
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

  // Image upload mutation
  const uploadImageMutation = useMutation({
    mutationFn: async ({ file, caption, image_type }: { file: File; caption: string; image_type: string }) => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('caption', caption)
      formData.append('image_type', image_type)
      const res = await fetch(`/api/recipes/${recipeId}/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (!res.ok) throw new Error('Failed to upload image')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
      setShowImageUpload(false)
      setImageCaption('')
      setImageFile(null)
    },
  })

  // Delete image mutation
  const deleteImageMutation = useMutation({
    mutationFn: async (imageId: number) => {
      const res = await fetch(`/api/recipes/${recipeId}/images/${imageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete image')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
    },
  })

  // Batch reorder ingredients
  const reorderIngMutation = useMutation({
    mutationFn: async (ingredientIds: number[]) => {
      const res = await fetch(`/api/recipes/${recipeId}/ingredients/reorder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredient_ids: ingredientIds }),
      })
      if (!res.ok) throw new Error('Failed to reorder')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
    },
  })

  // Batch reorder sub-recipes
  const reorderSubMutation = useMutation({
    mutationFn: async (subRecipeIds: number[]) => {
      const res = await fetch(`/api/recipes/${recipeId}/sub-recipes/reorder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub_recipe_ids: subRecipeIds }),
      })
      if (!res.ok) throw new Error('Failed to reorder')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
    },
  })

  // Reorder steps mutation
  const reorderStepsMutation = useMutation({
    mutationFn: async (stepIds: number[]) => {
      const res = await fetch(`/api/recipes/${recipeId}/steps/reorder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_ids: stepIds }),
      })
      if (!res.ok) throw new Error('Failed to reorder steps')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
    },
  })

  // Drag-and-drop handlers
  const handleDragStart = (index: number, type: 'ing' | 'sub') => {
    setDragIdx(index)
    setDragType(type)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIdx(index)
  }

  const handleDropIngredients = () => {
    if (dragIdx === null || dragOverIdx === null || !recipe || dragType !== 'ing') {
      setDragIdx(null)
      setDragOverIdx(null)
      setDragType(null)
      return
    }
    const sorted = [...recipe.ingredients].sort((a, b) => a.sort_order - b.sort_order)
    const items = [...sorted]
    const [moved] = items.splice(dragIdx, 1)
    items.splice(dragOverIdx, 0, moved)
    reorderIngMutation.mutate(items.map(i => i.id))
    setDragIdx(null)
    setDragOverIdx(null)
    setDragType(null)
  }

  const handleDropSubs = () => {
    if (dragIdx === null || dragOverIdx === null || !recipe || dragType !== 'sub') {
      setDragIdx(null)
      setDragOverIdx(null)
      setDragType(null)
      return
    }
    const items = [...recipe.sub_recipes]
    const [moved] = items.splice(dragIdx, 1)
    items.splice(dragOverIdx, 0, moved)
    reorderSubMutation.mutate(items.map(i => i.id))
    setDragIdx(null)
    setDragOverIdx(null)
    setDragType(null)
  }

  // Step reorder helpers
  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    if (!recipe) return
    const steps = [...recipe.steps]
    const swapIndex = direction === 'up' ? index - 1 : index + 1
    if (swapIndex < 0 || swapIndex >= steps.length) return
    const newSteps = [...steps]
    const temp = newSteps[index]
    newSteps[index] = newSteps[swapIndex]
    newSteps[swapIndex] = temp
    reorderStepsMutation.mutate(newSteps.map(s => s.id))
  }

  const handleSave = () => {
    updateMutation.mutate({
      name: editName,
      description: editDesc || null,
      batch_portions: 1,
      prep_time_minutes: editPrep ? parseInt(editPrep) : null,
      cook_time_minutes: editCook ? parseInt(editCook) : null,
      notes: editNotes || null,
      menu_section_id: editSection ? parseInt(editSection) : null,
      kds_menu_item_name: editKds || null,
      gross_sell_price: grossPrice && parseFloat(grossPrice) > 0 ? parseFloat(grossPrice) : null,
    })
  }

  const handlePrint = (format: string) => {
    window.open(`/api/recipes/${recipeId}/print?format=${format}&token=${token}`, '_blank')
  }

  if (!recipe) return <div style={styles.loading}>Loading dish...</div>

  const totalCost = costData?.total_cost_recent
  const costPerPortion = costData?.cost_per_portion

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.topBar}>
        <button onClick={() => navigate('/dishes')} style={styles.backBtn}>← Back</button>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setShowPublishModal(true)} style={{ ...styles.secondaryBtn, background: '#eff6ff', color: '#2563eb' }}>Publish to Menu</button>
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
          <span style={{ background: '#3b82f6', color: 'white', padding: '4px 12px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>DISH</span>
        </div>

        {dishMenus && dishMenus.length > 0 && (
          <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.25rem' }}>
            Published on: {dishMenus.map((m, i) => (
              <span key={m.menu_id}>
                {i > 0 && ', '}
                <span style={{ color: m.is_active ? '#2563eb' : '#999' }}>{m.menu_name}</span>
              </span>
            ))}
          </div>
        )}

        <div style={styles.metaGrid}>
          <div>
            <label style={styles.label}>Course</label>
            <select value={editSection} onChange={(e) => { setEditSection(e.target.value); setIsDirty(true) }} style={styles.input}>
              <option value="">None</option>
              {sections?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
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
      {flagData && flagData.open_suggestion_ingredients && flagData.open_suggestion_ingredients.length > 0 && (
        <div style={{ background: '#fffbeb', color: '#b45309', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.85rem', border: '1px solid #f59e0b55' }}>
          <strong>{flagData.open_suggestion_ingredients.length} ingredient{flagData.open_suggestion_ingredients.length > 1 ? 's have' : ' has'} unreviewed allergen suggestions</strong>
          {' — '}{flagData.open_suggestion_ingredients.map((i, idx) => (
            <span key={i.ingredient_id}>
              {idx > 0 && ', '}
              <span
                style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 600 }}
                onClick={() => setEditIngId(i.ingredient_id)}
              >{i.ingredient_name}</span>
              {' '}({i.suggestion_count})
            </span>
          ))}
        </div>
      )}

      {/* Manual price / no price warnings */}
      {recipe && (() => {
        const manualPriceIngs = recipe.ingredients.filter(i => i.is_manual_price)
        const noPriceIngs = recipe.ingredients.filter(i => i.has_no_price)
        const manualPriceSubs = recipe.sub_recipes.filter(sr => sr.has_manual_price_ingredients)
        const noPriceSubs = recipe.sub_recipes.filter(sr => sr.has_no_price_ingredients)
        if (manualPriceIngs.length === 0 && noPriceIngs.length === 0 && manualPriceSubs.length === 0 && noPriceSubs.length === 0) return null
        return (
          <div style={{ background: '#fef3cd', color: '#856404', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.85rem', border: '1px solid #ffc10755' }}>
            {noPriceIngs.length > 0 && (
              <div>
                <strong>{noPriceIngs.length} ingredient{noPriceIngs.length > 1 ? 's have' : ' has'} no price</strong>
                {' — '}{noPriceIngs.map((i, idx) => (
                  <span key={i.ingredient_id}>
                    {idx > 0 && ', '}
                    <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setEditIngId(i.ingredient_id)}>{i.ingredient_name}</span>
                  </span>
                ))}
              </div>
            )}
            {manualPriceIngs.length > 0 && (
              <div style={{ marginTop: noPriceIngs.length > 0 ? '0.3rem' : 0 }}>
                <strong>{manualPriceIngs.length} ingredient{manualPriceIngs.length > 1 ? 's use' : ' uses'} manual price</strong>
                {' — '}{manualPriceIngs.map((i, idx) => (
                  <span key={i.ingredient_id}>
                    {idx > 0 && ', '}
                    <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setEditIngId(i.ingredient_id)}>{i.ingredient_name}</span>
                  </span>
                ))}
              </div>
            )}
            {noPriceSubs.length > 0 && (
              <div style={{ marginTop: '0.3rem' }}>
                <strong>{noPriceSubs.length} sub-recipe{noPriceSubs.length > 1 ? 's contain' : ' contains'} unpriced ingredients</strong>
                {' — '}{noPriceSubs.map((sr, idx) => (
                  <span key={sr.child_recipe_id}>
                    {idx > 0 && ', '}
                    <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => navigate(`/recipes/${sr.child_recipe_id}`)}>{sr.child_recipe_name}</span>
                  </span>
                ))}
              </div>
            )}
            {manualPriceSubs.length > 0 && (
              <div style={{ marginTop: '0.3rem' }}>
                <strong>{manualPriceSubs.length} sub-recipe{manualPriceSubs.length > 1 ? 's contain' : ' contains'} manual-priced ingredients</strong>
                {' — '}{manualPriceSubs.map((sr, idx) => (
                  <span key={sr.child_recipe_id}>
                    {idx > 0 && ', '}
                    <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => navigate(`/recipes/${sr.child_recipe_id}`)}>{sr.child_recipe_name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* Flag badges and matrix buttons */}
      {flagData && (
        <div style={{ margin: '0.75rem 0' }}>
          {flagData.flags.length > 0 && <FoodFlagBadges flags={flagData.flags} size="medium" />}
          {flagCategories && flagCategories.length > 0 && (
            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
              {flagCategories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setShowMatrix(showMatrix === cat.id ? null : cat.id)}
                  style={{
                    padding: '3px 10px', fontSize: '0.75rem', border: '1px solid #ddd',
                    borderRadius: '4px', background: showMatrix === cat.id ? '#e94560' : '#f5f5f5',
                    color: showMatrix === cat.id ? 'white' : '#555', cursor: 'pointer',
                  }}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {showMatrix != null && <RecipeFlagMatrix recipeId={recipeId} categoryId={showMatrix || undefined} />}

      {/* Ingredients */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Ingredients</h3>
          <div style={{ display: 'flex', gap: '6px' }}>
            {recipe.ingredients.length > 1 && (
              <button
                onClick={() => setSortingIngredients(!sortingIngredients)}
                style={{ ...styles.addBtn, background: sortingIngredients ? '#3b82f6' : undefined, color: sortingIngredients ? '#fff' : undefined }}
              >{sortingIngredients ? '✓ Done' : '↕ Sort'}</button>
            )}
            <button onClick={() => setShowAddIng(true)} style={styles.addBtn}>+ Add</button>
          </div>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              {sortingIngredients && <th style={{ ...styles.th, width: '30px' }}></th>}
              <th style={styles.th}>Ingredient</th>
              <th style={styles.th}>Quantity</th>
              <th style={styles.th}>Yield %</th>
              <th style={styles.th}>Cost</th>
              <th style={styles.th}>Notes</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {[...recipe.ingredients].sort((a, b) => a.sort_order - b.sort_order).map((ri, idx) => (
              <tr
                key={ri.id}
                style={{ ...styles.tr, opacity: dragType === 'ing' && dragIdx === idx ? 0.4 : 1, background: dragType === 'ing' && dragOverIdx === idx ? '#e0f2fe' : undefined }}
                draggable={sortingIngredients}
                onDragStart={() => handleDragStart(idx, 'ing')}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={handleDropIngredients}
                onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); setDragType(null) }}
              >
                {sortingIngredients && (
                  <td style={{ ...styles.td, cursor: 'grab', textAlign: 'center', fontSize: '1rem', color: '#999' }}>☰</td>
                )}
                <td style={styles.td}>
                  <span
                    style={{ cursor: 'pointer', color: '#3b82f6', textDecoration: 'none' }}
                    onClick={() => setEditIngId(ri.ingredient_id)}
                    title="Edit ingredient"
                  >{ri.ingredient_name}</span>
                </td>
                {editingRiId === ri.id ? (
                  <>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                        <input
                          type="number"
                          value={editRiQty}
                          onChange={(e) => setEditRiQty(e.target.value)}
                          style={{ ...styles.input, width: '80px', padding: '0.25rem 0.4rem', fontSize: '0.85rem' }}
                          step="0.1"
                          autoFocus
                        />
                        {ri.compatible_units && ri.compatible_units.length > 1 ? (
                          <select
                            value={editRiUnit}
                            onChange={(e) => setEditRiUnit(e.target.value)}
                            style={{ ...styles.input, width: '55px', padding: '0.25rem 0.2rem', fontSize: '0.75rem' }}
                          >
                            {ri.compatible_units.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: '#888' }}>{ri.unit}</span>
                        )}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        value={editRiYield}
                        onChange={(e) => setEditRiYield(e.target.value)}
                        style={{ ...styles.input, width: '60px', padding: '0.25rem 0.4rem', fontSize: '0.85rem' }}
                        step="0.5"
                        min="1"
                        max="100"
                      />
                    </td>
                    <td style={styles.td}>{ri.cost != null ? `£${ri.cost.toFixed(2)}` : '-'}</td>
                    <td style={styles.td}>
                      <input
                        value={editRiNotes}
                        onChange={(e) => setEditRiNotes(e.target.value)}
                        style={{ ...styles.input, width: '120px', padding: '0.25rem 0.4rem', fontSize: '0.8rem' }}
                        placeholder="notes..."
                      />
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          onClick={() => updateIngMutation.mutate({
                            riId: ri.id,
                            quantity: parseFloat(editRiQty),
                            unit: editRiUnit,
                            yield_percent: parseFloat(editRiYield),
                            notes: editRiNotes || undefined,
                          })}
                          disabled={!editRiQty || updateIngMutation.isPending}
                          style={{ ...styles.addBtn, fontSize: '0.7rem', padding: '2px 6px', color: '#16a34a' }}
                        >Save</button>
                        <button onClick={() => setEditingRiId(null)} style={{ ...styles.removeBtn, color: '#888' }}>Cancel</button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ ...styles.td, cursor: 'pointer' }} onClick={() => { setEditingRiId(ri.id); setEditRiQty(ri.quantity.toString()); setEditRiUnit(ri.unit); setEditRiYield(ri.yield_percent.toString()); setEditRiNotes(ri.notes || '') }}>{ri.quantity}{ri.unit}</td>
                    <td style={{ ...styles.td, cursor: 'pointer' }} onClick={() => { setEditingRiId(ri.id); setEditRiQty(ri.quantity.toString()); setEditRiUnit(ri.unit); setEditRiYield(ri.yield_percent.toString()); setEditRiNotes(ri.notes || '') }}>
                      {ri.yield_percent < 100 ? <span style={{ color: '#e94560' }}>{ri.yield_percent}%</span> : '100%'}
                    </td>
                    <td style={styles.td}>
                      {ri.cost != null ? (
                        <span style={ri.is_manual_price ? { textDecoration: 'underline dashed #b45309', textUnderlineOffset: '2px' } : undefined} title={ri.is_manual_price ? 'Manual price' : undefined}>
                          £{ri.cost.toFixed(2)}
                        </span>
                      ) : '-'}
                    </td>
                    <td style={{ ...styles.td, cursor: 'pointer' }} onClick={() => { setEditingRiId(ri.id); setEditRiQty(ri.quantity.toString()); setEditRiUnit(ri.unit); setEditRiYield(ri.yield_percent.toString()); setEditRiNotes(ri.notes || '') }}>
                      <span style={{ color: '#888', fontSize: '0.8rem' }}>{ri.notes || '-'}</span>
                    </td>
                    <td style={styles.td}>
                      <button onClick={() => removeIngMutation.mutate(ri.id)} style={styles.removeBtn}>✕</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sub-recipes - always shown for dishes */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Sub-Recipes</h3>
          <div style={{ display: 'flex', gap: '6px' }}>
            {recipe.sub_recipes.length > 1 && (
              <button
                onClick={() => setSortingSubs(!sortingSubs)}
                style={{ ...styles.addBtn, background: sortingSubs ? '#3b82f6' : undefined, color: sortingSubs ? '#fff' : undefined }}
              >{sortingSubs ? '✓ Done' : '↕ Sort'}</button>
            )}
            <button onClick={() => setShowAddSub(true)} style={styles.addBtn}>+ Add</button>
          </div>
        </div>
        {recipe.sub_recipes.length > 0 ? (
          <table style={styles.table}>
            <thead>
              <tr>
                {sortingSubs && <th style={{ ...styles.th, width: '30px' }}></th>}
                <th style={styles.th}>Recipe</th>
                <th style={styles.th}>Batch Output</th>
                <th style={styles.th}>Amount Used</th>
                <th style={styles.th}>Cost</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {recipe.sub_recipes.map((sr, idx) => (
                <tr
                  key={sr.id}
                  style={{ ...styles.tr, opacity: dragType === 'sub' && dragIdx === idx ? 0.4 : 1, background: dragType === 'sub' && dragOverIdx === idx ? '#e0f2fe' : undefined }}
                  draggable={sortingSubs}
                  onDragStart={() => handleDragStart(idx, 'sub')}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDrop={handleDropSubs}
                  onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); setDragType(null) }}
                >
                  {sortingSubs && (
                    <td style={{ ...styles.td, cursor: 'grab', textAlign: 'center', fontSize: '1rem', color: '#999' }}>☰</td>
                  )}
                  <td style={styles.td}>
                    <span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => navigate(`/recipes/${sr.child_recipe_id}`)}>
                      {sr.child_recipe_name}
                    </span>
                  </td>
                  <td style={styles.td}>
                    {sr.batch_output_type === 'bulk'
                      ? `${sr.output_qty}${sr.output_unit}`
                      : `${sr.batch_portions} portions`}
                  </td>
                  <td style={styles.td}>
                    {sr.portions_needed}{sr.batch_output_type === 'bulk' ? sr.portions_needed_unit : ' portions'}
                    {sr.batch_output_type === 'bulk' && sr.portions_needed_unit !== sr.output_unit && (
                      <span style={{ fontSize: '0.7rem', color: '#888', marginLeft: '4px' }}>
                        ({sr.output_unit})
                      </span>
                    )}
                  </td>
                  <td style={styles.td}>
                    {sr.cost_contribution != null ? (
                      <span style={(sr.has_manual_price_ingredients || sr.has_no_price_ingredients) ? { textDecoration: 'underline dashed #b45309', textUnderlineOffset: '2px' } : undefined} title={sr.has_manual_price_ingredients ? 'Includes manual-priced ingredients' : sr.has_no_price_ingredients ? 'Includes unpriced ingredients' : undefined}>
                        £{sr.cost_contribution.toFixed(2)}
                      </span>
                    ) : '-'}
                  </td>
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

      {/* Steps */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Method</h3>
          <button onClick={() => { setEditingStepId(null); setStepTitle(''); setStepInstruction(''); setStepDuration(''); setShowAddStep(true) }} style={styles.addBtn}>+ Add Step</button>
        </div>
        {recipe.steps.length > 0 ? (
          <div style={{ margin: 0 }}>
            {recipe.steps.map((step, idx) => (
              <div key={step.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0, marginTop: '2px' }}>
                  <button
                    onClick={() => handleMoveStep(idx, 'up')}
                    disabled={idx === 0 || reorderStepsMutation.isPending}
                    style={{ ...styles.reorderBtn, opacity: idx === 0 ? 0.3 : 1 }}
                    title="Move up"
                  >&#9650;</button>
                  <button
                    onClick={() => handleMoveStep(idx, 'down')}
                    disabled={idx === recipe.steps.length - 1 || reorderStepsMutation.isPending}
                    style={{ ...styles.reorderBtn, opacity: idx === recipe.steps.length - 1 ? 0.3 : 1 }}
                    title="Move down"
                  >&#9660;</button>
                </div>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#e94560', minWidth: '24px', marginTop: '1px' }}>{idx + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                    {step.title && <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{step.title}</span>}
                    {step.duration_minutes && <span style={{ fontSize: '0.8rem', color: '#888' }}>({step.duration_minutes} min)</span>}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#555', marginTop: step.title ? '2px' : 0, whiteSpace: 'pre-wrap' }}>{step.instruction}</div>
                </div>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button
                    onClick={() => {
                      setEditingStepId(step.id)
                      setStepTitle(step.title || '')
                      setStepInstruction(step.instruction)
                      setStepDuration(step.duration_minutes ? String(step.duration_minutes) : '')
                      setShowAddStep(true)
                    }}
                    style={{ ...styles.reorderBtn, fontSize: '0.75rem' }}
                    title="Edit step"
                  >&#9998;</button>
                  <button onClick={() => removeStepMutation.mutate(step.id)} style={{ ...styles.removeBtn, flexShrink: 0 }}>✕</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>No steps added yet</div>
        )}
      </div>

      {/* Images */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Images</h3>
          <button onClick={() => setShowImageUpload(!showImageUpload)} style={styles.addBtn}>
            {showImageUpload ? 'Cancel' : '+ Upload'}
          </button>
        </div>

        {showImageUpload && (
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #e0e0e0' }}>
            <label style={styles.label}>Image File</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setImageFile(e.target.files?.[0] || null)}
              style={{ ...styles.input, padding: '0.35rem' }}
            />
            <label style={styles.label}>Caption (optional)</label>
            <input
              value={imageCaption}
              onChange={(e) => setImageCaption(e.target.value)}
              style={styles.input}
              placeholder="Describe this image..."
            />
            <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  if (imageFile) {
                    uploadImageMutation.mutate({ file: imageFile, caption: imageCaption, image_type: 'general' })
                  }
                }}
                disabled={!imageFile || uploadImageMutation.isPending}
                style={styles.primaryBtn}
              >
                {uploadImageMutation.isPending ? 'Uploading...' : 'Upload Image'}
              </button>
            </div>
            {uploadImageMutation.error && <div style={styles.errorMsg}>{uploadImageMutation.error.message}</div>}
          </div>
        )}

        {recipe.images.length > 0 ? (
          <div style={styles.imageGrid}>
            {recipe.images.map(img => (
              <div key={img.id} style={styles.imageCard}>
                <img
                  src={`/api/recipes/${recipeId}/images/${img.id}?token=${token}`}
                  alt={img.caption || 'Dish image'}
                  style={{ ...styles.imageThumb, cursor: 'pointer' }}
                  onClick={() => setLightboxImg(`/api/recipes/${recipeId}/images/${img.id}?token=${token}`)}
                />
                <div style={{ padding: '0.4rem' }}>
                  {img.caption && <div style={{ fontSize: '0.8rem', color: '#333', marginTop: '2px' }}>{img.caption}</div>}
                  <button
                    onClick={() => { if (confirm('Delete this image?')) deleteImageMutation.mutate(img.id) }}
                    style={{ ...styles.removeBtn, marginTop: '4px', fontSize: '0.7rem' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>No images uploaded</div>
        )}
      </div>

      {/* Cost summary */}
      <div style={styles.costPanel}>
        <div style={styles.costHeader}>
          <h3 style={{ margin: 0 }}>Cost Summary</h3>
        </div>

        <div style={styles.costGrid}>
          <div style={styles.costBox}>
            <div style={styles.costLabel}>Dish Total</div>
            <div style={styles.costValue}>{totalCost != null ? `£${totalCost.toFixed(2)}` : '-'}</div>
          </div>
          <div style={styles.costBox}>
            <div style={styles.costLabel}>Portion Cost</div>
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
            <strong style={{ fontSize: '0.85rem' }}>Suggested Sell Price (incl. VAT):</strong>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
              {costData.gp_comparison.map(gp => (
                <div key={gp.gp_target} style={styles.gpBadge}>
                  {gp.gp_target}% GP → <strong>£{gp.suggested_price.toFixed(2)}</strong>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reverse GP calculator */}
        {costPerPortion != null && (
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '2px' }}>Gross Sell Price</label>
              <input
                type="number"
                value={grossPrice}
                onChange={(e) => { setGrossPrice(e.target.value); setIsDirty(true) }}
                style={{ ...styles.input, width: '100px' }}
                step="0.5"
                min="0"
                placeholder="£"
              />
            </div>
            {grossPrice && parseFloat(grossPrice) > 0 && (() => {
              const gross = parseFloat(grossPrice)
              const net = gross / 1.20
              const gp = ((net - costPerPortion) / net) * 100
              const gpColor = gp >= 70 ? '#16a34a' : gp >= 60 ? '#ca8a04' : '#dc2626'
              return (
                <div style={{ ...styles.gpBadge, borderColor: gpColor, background: `${gpColor}10` }}>
                  <span style={{ color: gpColor, fontWeight: 700, fontSize: '1rem' }}>{gp.toFixed(1)}% GP</span>
                  <span style={{ color: '#888', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                    (net £{net.toFixed(2)})
                  </span>
                </div>
              )
            })()}
          </div>
        )}

        {/* Cost Trend */}
        <div style={{ marginTop: '0.5rem' }}>
          <button onClick={() => setShowCostTrend(!showCostTrend)} style={styles.linkBtn}>
            {showCostTrend ? 'Hide' : 'Show'} cost trend
          </button>
        </div>

        {showCostTrend && costTrendRaw?.snapshots && costTrendRaw.snapshots.length > 1 && (() => {
          const data = costTrendRaw.snapshots
          const costs = data.map(d => d.cost_per_portion)
          const minCost = Math.min(...costs)
          const maxCost = Math.max(...costs)
          const costRange = maxCost - minCost || 1
          const chartWidth = 500
          const chartHeight = 120
          const padX = 40
          const padY = 20
          const plotW = chartWidth - padX * 2
          const plotH = chartHeight - padY * 2

          const points = data.map((d, i) => {
            const x = padX + (i / (data.length - 1)) * plotW
            const y = padY + plotH - ((d.cost_per_portion - minCost) / costRange) * plotH
            return { x, y, ...d }
          })
          const polyline = points.map(p => `${p.x},${p.y}`).join(' ')

          // Y-axis labels
          const yLabels = [minCost, minCost + costRange / 2, maxCost]

          // X-axis labels (first, middle, last)
          const xLabelIndices = [0, Math.floor(data.length / 2), data.length - 1]

          // Find snapshots where cost changed from previous
          const changeAnnotations = data.filter((d, i) => i > 0 && d.cost_per_portion !== data[i - 1].cost_per_portion)

          return (
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{ position: 'relative' }}>
                <svg width={chartWidth} height={chartHeight} style={{ background: 'white', borderRadius: '6px', border: '1px solid #e0e0e0' }}>
                  {/* Grid lines */}
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

                  {/* X-axis labels */}
                  {xLabelIndices.filter((v, i, a) => a.indexOf(v) === i).map(idx => {
                    const p = points[idx]
                    const dateStr = new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                    return (
                      <text key={idx} x={p.x} y={chartHeight - 2} textAnchor="middle" fontSize="9" fill="#888">
                        {dateStr}
                      </text>
                    )
                  })}

                  {/* Line */}
                  <polyline points={polyline} fill="none" stroke="#e94560" strokeWidth="2" />

                  {/* Data points */}
                  {points.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={4}
                      fill="#e94560"
                      stroke="white"
                      strokeWidth="2"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        const rect = (e.target as SVGElement).closest('svg')?.getBoundingClientRect()
                        setTrendTooltip({
                          x: rect ? p.x + rect.left - (rect?.left || 0) : p.x,
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

                {/* Tooltip */}
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
                    <div style={{ color: '#ccc', fontSize: '0.7rem' }}>{trendTooltip.trigger}</div>
                  </div>
                )}
              </div>

              {/* Change annotations panel */}
              {changeAnnotations.length > 0 && (
                <div style={{ flex: 1, minWidth: '220px', maxHeight: '300px', overflow: 'auto', fontSize: '0.75rem', background: '#fafafa', borderRadius: '6px', padding: '6px 8px', border: '1px solid #e0e0e0' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.7rem', color: '#888', marginBottom: '4px' }}>Change Log ({changeAnnotations.length} snapshots)</div>
                  {changeAnnotations.slice().reverse().map((snap, i) => {
                    const prevSnap = data[data.indexOf(snap) - 1]
                    const diff = snap.cost_per_portion - prevSnap.cost_per_portion
                    const diffColor = diff > 0 ? '#dc2626' : '#16a34a'
                    return (
                      <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid #eee' }}>
                        <div style={{ color: '#888' }}>
                          {new Date(snap.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                          <span style={{ color: diffColor, fontWeight: 600, marginLeft: '4px' }}>
                            {diff > 0 ? '+' : ''}{'\u00A3'}{diff.toFixed(4)}
                          </span>
                        </div>
                        {snap.changes.length > 0 && (
                          <div style={{ color: '#666', marginTop: '1px' }}>
                            {snap.changes.map((c, j) => (
                              <div key={j} style={{ fontSize: '0.7rem', lineHeight: 1.3 }}>{c}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        {showCostTrend && costTrendRaw?.snapshots && costTrendRaw.snapshots.length <= 1 && (
          <div style={{ marginTop: '0.5rem', color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>
            Not enough data points to display a trend chart
          </div>
        )}
      </div>

      {/* Scale Dish */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Scale Dish</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
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

        {(() => {
          const displayData = scaledCostData || costData
          if (!displayData?.ingredients) return null

          const totalRecent = displayData.ingredients.reduce((sum, ci) => sum + (ci.cost_recent ?? 0), 0)
            + (displayData.sub_recipes?.reduce((sum, sr) => sum + (sr.cost_contribution ?? 0), 0) ?? 0)
          const totalMin = displayData.ingredients.reduce((sum, ci) => sum + (ci.cost_min ?? 0), 0)
          const totalMax = displayData.ingredients.reduce((sum, ci) => sum + (ci.cost_max ?? 0), 0)

          return (
            <table style={styles.table}>
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
                {displayData.ingredients.map(ci => {
                  const manualStyle = ci.is_manual_price ? { textDecoration: 'underline dashed #b45309', textUnderlineOffset: '2px' } as const : undefined
                  return (
                    <tr key={ci.ingredient_id}>
                      <td style={styles.td}>
                        <span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => setEditIngId(ci.ingredient_id)} title="Edit ingredient">{ci.ingredient_name}</span>
                      </td>
                      <td style={styles.td}>{ci.quantity}{ci.unit}</td>
                      <td style={styles.td}><span style={manualStyle} title={ci.is_manual_price ? 'Manual price' : undefined}>{ci.cost_recent != null ? `£${ci.cost_recent.toFixed(2)}` : '-'}</span></td>
                      <td style={styles.td}><span style={manualStyle} title={ci.is_manual_price ? 'Manual price' : undefined}>{ci.cost_min != null ? `£${ci.cost_min.toFixed(2)}` : '-'}</span></td>
                      <td style={styles.td}><span style={manualStyle} title={ci.is_manual_price ? 'Manual price' : undefined}>{ci.cost_max != null ? `£${ci.cost_max.toFixed(2)}` : '-'}</span></td>
                    </tr>
                  )
                })}
                {(() => {
                  const renderSubRecipes = (subs: CostSubRecipe[], depth: number): React.ReactNode[] => {
                    const rows: React.ReactNode[] = []
                    for (const sr of subs) {
                      const indent = depth * 1.5
                      const hasContent = (sr.child_ingredients && sr.child_ingredients.length > 0) || (sr.child_sub_recipes && sr.child_sub_recipes.length > 0)
                      const srHasManual = sr.child_ingredients?.some(ci => ci.is_manual_price) || false
                      const costStyle = srHasManual ? { textDecoration: 'underline dashed #b45309', textUnderlineOffset: '2px' } as const : undefined
                      // Sub-recipe header row
                      rows.push(
                        <tr key={`sub-header-${depth}-${sr.child_recipe_id}`}>
                          <td colSpan={5} style={{ ...styles.td, background: depth === 0 ? '#f0f0f0' : '#f5f5f5', fontWeight: 600, fontSize: '0.8rem', color: '#555', paddingLeft: `${0.5 + indent}rem` }}>
                            {depth > 0 && '→ '}<span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => navigate(`/recipes/${sr.child_recipe_id}`)}>{sr.child_recipe_name}</span> ({sr.portions_needed}{sr.output_unit === 'portion' ? ' portions' : sr.output_unit}) — <span style={costStyle} title={srHasManual ? 'Includes manual-priced ingredients' : undefined}>£{sr.cost_contribution?.toFixed(2) ?? '-'}</span>
                          </td>
                        </tr>
                      )
                      if (hasContent) {
                        // Direct ingredients of this sub-recipe
                        for (const ci of (sr.child_ingredients || [])) {
                          const ciManualStyle = ci.is_manual_price ? { textDecoration: 'underline dashed #b45309', textUnderlineOffset: '2px' } as const : undefined
                          rows.push(
                            <tr key={`sub-${depth}-${sr.child_recipe_id}-ing-${ci.ingredient_id}`} style={{ background: '#fafafa' }}>
                              <td style={{ ...styles.td, paddingLeft: `${1.5 + indent}rem`, color: '#666' }}>
                                <span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => setEditIngId(ci.ingredient_id)} title="Edit ingredient">{ci.ingredient_name}</span>
                              </td>
                              <td style={{ ...styles.td, color: '#666' }}>{ci.quantity}{ci.unit}</td>
                              <td style={{ ...styles.td, color: '#666' }}><span style={ciManualStyle} title={ci.is_manual_price ? 'Manual price' : undefined}>{ci.cost_recent != null ? `£${ci.cost_recent.toFixed(2)}` : '-'}</span></td>
                              <td style={{ ...styles.td, color: '#666' }}><span style={ciManualStyle} title={ci.is_manual_price ? 'Manual price' : undefined}>{ci.cost_min != null ? `£${ci.cost_min.toFixed(2)}` : '-'}</span></td>
                              <td style={{ ...styles.td, color: '#666' }}><span style={ciManualStyle} title={ci.is_manual_price ? 'Manual price' : undefined}>{ci.cost_max != null ? `£${ci.cost_max.toFixed(2)}` : '-'}</span></td>
                            </tr>
                          )
                        }
                        // Nested sub-recipes (recursive)
                        if (sr.child_sub_recipes && sr.child_sub_recipes.length > 0) {
                          rows.push(...renderSubRecipes(sr.child_sub_recipes, depth + 1))
                        }
                      }
                    }
                    return rows
                  }
                  return renderSubRecipes(displayData.sub_recipes || [], 0)
                })()}
                <tr style={{ borderTop: '2px solid #333' }}>
                  <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
                  <td style={styles.td}></td>
                  <td style={{ ...styles.td, fontWeight: 700 }}>{totalRecent > 0 ? `£${totalRecent.toFixed(2)}` : '-'}</td>
                  <td style={{ ...styles.td, fontWeight: 700 }}>{totalMin > 0 ? `£${totalMin.toFixed(2)}` : '-'}</td>
                  <td style={{ ...styles.td, fontWeight: 700 }}>{totalMax > 0 ? `£${totalMax.toFixed(2)}` : '-'}</td>
                </tr>
              </tbody>
            </table>
          )
        })()}
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
              {ingSearch.length >= 2 && !selectedIngId && (
                <div style={styles.suggestions}>
                  {ingSuggestions.map(s => (
                    <div
                      key={s.id}
                      style={styles.suggestionItem}
                      onClick={() => {
                        const compat = getCompatibleUnits(s.standard_unit)
                        setSelectedIngId(s.id); setSelectedIngUnit(s.standard_unit); setSelectedIngCompatUnits(compat); setIngSearch(s.name)
                      }}
                    >
                      {s.name} <span style={{ color: '#888', fontSize: '0.75rem' }}>({Math.round(s.similarity * 100)}%)</span>
                    </div>
                  ))}
                  <div
                    style={{ ...styles.suggestionItem, color: '#16a34a', fontWeight: 600, borderBottom: 'none' }}
                    onClick={() => setShowCreateIng(true)}
                  >
                    + Create "{ingSearch}"
                  </div>
                </div>
              )}
              {selectedIngId && (
                <>
                  <label style={styles.label}>Quantity</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input type="number" value={ingQty} onChange={(e) => setIngQty(e.target.value)} style={{ ...styles.input, flex: 1 }} step="0.1" />
                    {selectedIngCompatUnits.length > 1 ? (
                      <select value={selectedIngUnit} onChange={(e) => setSelectedIngUnit(e.target.value)} style={{ ...styles.input, width: '70px' }}>
                        {selectedIngCompatUnits.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    ) : (
                      <span style={{ alignSelf: 'center', fontSize: '0.85rem', color: '#666', minWidth: '30px' }}>{selectedIngUnit}</span>
                    )}
                  </div>
                  <label style={styles.label}>Notes (optional)</label>
                  <input value={ingNotes} onChange={(e) => setIngNotes(e.target.value)} style={styles.input} placeholder="e.g. finely diced" />
                </>
              )}
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowAddIng(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => addIngMutation.mutate({
                  ingredient_id: selectedIngId!,
                  quantity: parseFloat(ingQty),
                  unit: selectedIngUnit || undefined,
                  notes: ingNotes || undefined,
                })}
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

      {/* Create Ingredient Modal (shared component) */}
      <IngredientModal
        open={showCreateIng}
        onClose={() => setShowCreateIng(false)}
        onSaved={(result: IngredientModalResult) => {
          const compat = getCompatibleUnits(result.standard_unit)
          setSelectedIngId(result.id)
          setSelectedIngUnit(result.standard_unit)
          setSelectedIngCompatUnits(compat)
          setIngSearch(result.name)
        }}
        prePopulateName={ingSearch}
      />

      {/* Edit Ingredient Modal (from ingredient name click) */}
      <IngredientModal
        open={!!editIngId && !!editIngData}
        onClose={() => setEditIngId(null)}
        onSaved={() => {
          setEditIngId(null)
          queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] })
          queryClient.invalidateQueries({ queryKey: ['recipe-cost', recipeId] })
          queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
        }}
        editingIngredient={editIngData || undefined}
      />

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
                onChange={(e) => {
                  const id = parseInt(e.target.value)
                  setSelectedSubId(id)
                  const r = availableRecipes?.find(r => r.id === id)
                  setSubUnit(r?.batch_output_type === 'bulk' ? (r?.batch_yield_unit || '') : '')
                }}
                style={styles.input}
              >
                <option value="">Select...</option>
                {availableRecipes?.filter(r => r.id !== recipeId).map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.batch_output_type === 'bulk'
                      ? `yield: ${r.batch_yield_qty}${r.batch_yield_unit}`
                      : `batch: ${r.batch_portions}`})
                  </option>
                ))}
              </select>
              {(() => {
                const selectedRecipe = availableRecipes?.find(r => r.id === selectedSubId)
                const isBulk = selectedRecipe?.batch_output_type === 'bulk'
                const yieldUnit = selectedRecipe?.batch_yield_unit || ''
                const compatibleUnits = isBulk
                  ? (yieldUnit === 'ml' || yieldUnit === 'ltr' ? ['ml', 'ltr'] : yieldUnit === 'g' || yieldUnit === 'kg' ? ['g', 'kg'] : [yieldUnit])
                  : []
                return (
                  <>
                    <label style={styles.label}>{isBulk ? 'Amount' : 'Portions Needed'}</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="number"
                        value={subPortions}
                        onChange={(e) => setSubPortions(e.target.value)}
                        style={{ ...styles.input, flex: 1 }}
                        step={isBulk ? '0.1' : '0.5'}
                        min="0.1"
                      />
                      {isBulk && compatibleUnits.length > 1 ? (
                        <select value={subUnit} onChange={(e) => setSubUnit(e.target.value)} style={{ ...styles.input, width: '80px', flex: 'none' }}>
                          {compatibleUnits.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      ) : isBulk ? (
                        <span style={{ padding: '0.5rem 0', fontSize: '0.85rem', color: '#555' }}>{yieldUnit}</span>
                      ) : null}
                    </div>
                  </>
                )
              })()}
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowAddSub(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => addSubMutation.mutate({
                  child_recipe_id: selectedSubId!,
                  portions_needed: parseFloat(subPortions),
                  portions_needed_unit: subUnit || undefined,
                })}
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

      {/* Add/Edit Step Modal */}
      {showAddStep && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>{editingStepId ? 'Edit Step' : 'Add Step'}</h3>
              <button onClick={() => { setShowAddStep(false); setEditingStepId(null) }} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Title (optional)</label>
              <input value={stepTitle} onChange={(e) => setStepTitle(e.target.value)} style={styles.input} placeholder="e.g. Prepare the base, Sear the protein" />
              <label style={styles.label}>Instructions</label>
              <textarea value={stepInstruction} onChange={(e) => setStepInstruction(e.target.value)} style={{ ...styles.input, minHeight: '80px' }} />
              <label style={styles.label}>Duration (minutes, optional)</label>
              <input type="number" value={stepDuration} onChange={(e) => setStepDuration(e.target.value)} style={styles.input} />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => { setShowAddStep(false); setEditingStepId(null) }} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => {
                  if (editingStepId) {
                    updateStepMutation.mutate({
                      stepId: editingStepId,
                      data: {
                        title: stepTitle || '',
                        instruction: stepInstruction,
                        duration_minutes: stepDuration ? parseInt(stepDuration) : undefined,
                      },
                    })
                  } else {
                    addStepMutation.mutate({
                      title: stepTitle || undefined,
                      instruction: stepInstruction,
                      step_number: (recipe?.steps.length || 0) + 1,
                      duration_minutes: stepDuration ? parseInt(stepDuration) : undefined,
                    })
                  }
                }}
                disabled={!stepInstruction || addStepMutation.isPending || updateStepMutation.isPending}
                style={styles.primaryBtn}
              >
                {editingStepId
                  ? (updateStepMutation.isPending ? 'Saving...' : 'Save')
                  : (addStepMutation.isPending ? 'Adding...' : 'Add Step')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Image lightbox modal */}
      {lightboxImg && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, cursor: 'pointer',
          }}
          onClick={() => setLightboxImg(null)}
        >
          <img
            src={lightboxImg}
            alt="Dish image"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxImg(null)}
            style={{
              position: 'absolute', top: '20px', right: '20px', background: 'rgba(255,255,255,0.2)',
              border: 'none', color: 'white', fontSize: '1.5rem', cursor: 'pointer', borderRadius: '50%',
              width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {'\u2715'}
          </button>
        </div>
      )}

      {/* Publish to Menu Modal */}
      {showPublishModal && recipe && (
        <PublishToMenuModal
          recipeId={recipe.id}
          recipeName={recipe.name}
          recipeDesc={recipe.description || ''}
          recipePrice={recipe.gross_sell_price}
          onClose={() => setShowPublishModal(false)}
          onPublished={() => {
            setShowPublishModal(false)
            queryClient.invalidateQueries({ queryKey: ['dish-menus', recipeId] })
          }}
        />
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
  reorderBtn: { padding: '0', width: '18px', height: '16px', background: 'none', border: '1px solid #ddd', borderRadius: '3px', cursor: 'pointer', fontSize: '0.55rem', color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 },
  imageGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.75rem' },
  imageCard: { background: '#f8f9fa', borderRadius: '6px', border: '1px solid #e0e0e0', overflow: 'hidden' },
  imageThumb: { width: '100%', height: '120px', objectFit: 'cover' as const, display: 'block' },
}
