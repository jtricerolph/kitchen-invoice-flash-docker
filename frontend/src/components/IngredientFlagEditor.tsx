import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDebounce } from '../utils/searchHelpers'

interface FlagCategory {
  id: number
  name: string
  propagation_type: string
  required: boolean
  sort_order: number
  flags: Array<{
    id: number
    name: string
    code: string | null
    icon: string | null
    sort_order: number
  }>
}

interface IngredientFlagInfo {
  food_flag_id: number
  flag_name: string
  flag_code: string | null
  category_name: string
  source: string
}

export interface AllergenSuggestion {
  flag_id: number
  flag_name: string
  flag_code: string | null
  category_name: string
  matched_keywords: string[]
}

export interface DismissalInfo {
  id?: number  // server ID (only present after persist)
  food_flag_id: number
  flag_name?: string
  dismissed_by_name: string
  reason?: string
  matched_keyword?: string
}

interface Props {
  ingredientId: number | null // null = create mode (flags stored locally)
  token: string
  onChange?: (flagIds: number[], noneCategoryIds: number[]) => void
  onDismissalsChange?: (dismissals: DismissalInfo[]) => void  // for create mode batch persist
  ingredientName?: string       // for name-based suggestions
  productIngredients?: string   // for product-text-based suggestions
  lineItemDescription?: string  // for line-item-based suggestions
  scanSuggestions?: AllergenSuggestion[] // from label OCR scan (passed from parent)
  llmSuggestions?: AllergenSuggestion[] // LLM FEATURE — from AI label analysis (passed from parent)
  llmAnalysing?: boolean // LLM FEATURE — show spinner while LLM is processing
  autoApplyFlagIds?: number[] // flag IDs to auto-apply (e.g. from Brakes "Contains" statement)
  autoApplyNoneCategoryIds?: number[] // category IDs to auto-set "None" (e.g. Brakes "Contains: None")
}

export default function IngredientFlagEditor({ ingredientId, token, onChange, onDismissalsChange, ingredientName, productIngredients, lineItemDescription, scanSuggestions, llmSuggestions, llmAnalysing, autoApplyFlagIds, autoApplyNoneCategoryIds }: Props) {
  const queryClient = useQueryClient()
  const [activeFlagIds, setActiveFlagIds] = useState<Set<number>>(new Set())
  const [noneCategoryIds, setNoneCategoryIds] = useState<Set<number>>(new Set())
  const [autoApplied, setAutoApplied] = useState<Set<number>>(new Set()) // track which were auto-applied
  const [autoAppliedNones, setAutoAppliedNones] = useState<Set<number>>(new Set()) // track auto-applied none categories
  const [expandedCats, setExpandedCats] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true)

  // Dismissal state
  const [dismissals, setDismissals] = useState<DismissalInfo[]>([])
  const [dismissingFlagId, setDismissingFlagId] = useState<number | null>(null)
  const [dismissName, setDismissName] = useState('')
  const [dismissReason, setDismissReason] = useState('')
  const [showDismissed, setShowDismissed] = useState(false)

  // Debounce name, line item description, and product ingredients for suggestion queries
  const debouncedName = useDebounce(ingredientName || '', 500)
  const debouncedLineItem = useDebounce(lineItemDescription || '', 500)
  const debouncedText = useDebounce(productIngredients || '', 500)

  // Fetch all flag categories
  const { data: categories } = useQuery<FlagCategory[]>({
    queryKey: ['food-flag-categories'],
    queryFn: async () => {
      const res = await fetch('/api/food-flags/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch current ingredient flags (edit mode only)
  const { data: currentFlags } = useQuery<IngredientFlagInfo[]>({
    queryKey: ['ingredient-flags', ingredientId],
    queryFn: async () => {
      const res = await fetch(`/api/ingredients/${ingredientId}/flags`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token && !!ingredientId,
  })

  // Fetch current nones (edit mode only)
  const { data: currentNones } = useQuery<{ none_category_ids: number[] }>({
    queryKey: ['ingredient-flag-nones', ingredientId],
    queryFn: async () => {
      const res = await fetch(`/api/ingredients/${ingredientId}/flags/nones`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return { none_category_ids: [] }
      return res.json()
    },
    enabled: !!token && !!ingredientId,
  })

  // Fetch existing dismissals (edit mode only)
  const { data: currentDismissals } = useQuery<DismissalInfo[]>({
    queryKey: ['ingredient-flag-dismissals', ingredientId],
    queryFn: async () => {
      const res = await fetch(`/api/ingredients/${ingredientId}/flags/dismissals`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token && !!ingredientId,
  })

  // Fetch allergen suggestions based on name, line item description, and product ingredients text
  const { data: nameSuggestions } = useQuery<AllergenSuggestion[]>({
    queryKey: ['allergen-suggestions', debouncedName, debouncedLineItem, debouncedText],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedName) params.set('name', debouncedName)
      if (debouncedLineItem) params.set('line_item', debouncedLineItem)
      if (debouncedText) params.set('text', debouncedText)
      const res = await fetch(`/api/food-flags/suggest?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token && (debouncedName.length >= 2 || debouncedLineItem.length >= 2 || debouncedText.length >= 5),
  })

  // Sync from API data for edit mode
  useEffect(() => {
    if (currentFlags) {
      setActiveFlagIds(new Set(currentFlags.map(f => f.food_flag_id)))
    }
  }, [currentFlags])

  useEffect(() => {
    if (currentNones) {
      setNoneCategoryIds(new Set(currentNones.none_category_ids))
    }
  }, [currentNones])

  // Sync dismissals from API for edit mode
  useEffect(() => {
    if (currentDismissals) {
      setDismissals(currentDismissals)
    }
  }, [currentDismissals])

  // Reset local state when ingredientId changes (e.g. modal opens for different ingredient)
  useEffect(() => {
    if (!ingredientId) {
      setActiveFlagIds(new Set())
      setNoneCategoryIds(new Set())
      setExpandedCats(new Set())
      setSuggestionsExpanded(true)
      setDismissals([])
      setDismissingFlagId(null)
      setShowDismissed(false)
      setAutoAppliedNones(new Set())
    }
  }, [ingredientId])

  // Auto-expand required categories in create mode
  useEffect(() => {
    if (!ingredientId && categories?.length) {
      const requiredIds = categories.filter(c => c.required).map(c => c.id)
      if (requiredIds.length > 0) {
        setExpandedCats(prev => {
          const next = new Set(prev)
          for (const id of requiredIds) next.add(id)
          return next
        })
      }
    }
  }, [ingredientId, categories])

  // Auto-apply flags from Brakes "Contains" statement
  useEffect(() => {
    if (!autoApplyFlagIds?.length || !categories?.length) return
    const toApply = autoApplyFlagIds.filter(id => !activeFlagIds.has(id) && !autoApplied.has(id))
    if (toApply.length === 0) return

    const newFlags = new Set(activeFlagIds)
    const newNones = new Set(noneCategoryIds)
    for (const flagId of toApply) {
      newFlags.add(flagId)
      const cat = categories.find(c => c.flags.some(f => f.id === flagId))
      if (cat) newNones.delete(cat.id)
    }
    setActiveFlagIds(newFlags)
    setNoneCategoryIds(newNones)
    setAutoApplied(prev => new Set([...prev, ...toApply]))
    onChange?.([...newFlags], [...newNones])

    // For edit mode, persist to API
    if (ingredientId) {
      fetch(`/api/ingredients/${ingredientId}/flags`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ food_flag_ids: [...newFlags] }),
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['ingredient-flags', ingredientId] })
        queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      }).catch(() => {})
    }
  }, [autoApplyFlagIds, categories])

  // Auto-apply "None" to allergen categories (from Brakes "Contains: None of the 14 Food Allergens")
  useEffect(() => {
    if (!autoApplyNoneCategoryIds?.length || !categories?.length) return
    const toApply = autoApplyNoneCategoryIds.filter(id => !noneCategoryIds.has(id) && !autoAppliedNones.has(id))
    if (toApply.length === 0) return

    const newNones = new Set(noneCategoryIds)
    const newFlags = new Set(activeFlagIds)
    for (const catId of toApply) {
      // Only set "None" if no flags are active in this category
      const catFlags = categories.find(c => c.id === catId)?.flags || []
      const hasActiveFlags = catFlags.some(f => newFlags.has(f.id))
      if (!hasActiveFlags) {
        newNones.add(catId)
      }
    }
    setNoneCategoryIds(newNones)
    setAutoAppliedNones(prev => new Set([...prev, ...toApply]))
    onChange?.([...newFlags], [...newNones])

    // For edit mode, persist each "None" to API
    if (ingredientId) {
      for (const catId of toApply) {
        const catFlags = categories.find(c => c.id === catId)?.flags || []
        const hasActiveFlags = catFlags.some(f => newFlags.has(f.id))
        if (!hasActiveFlags) {
          fetch(`/api/ingredients/${ingredientId}/flags/none`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ category_id: catId }),
          }).catch(() => {})
        }
      }
      queryClient.invalidateQueries({ queryKey: ['ingredient-flag-nones', ingredientId] })
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
    }
  }, [autoApplyNoneCategoryIds, categories])

  // Check if two flag names conflict (e.g. "Gluten" vs "Gluten Free")
  const flagNamesConflict = (containsName: string, suitableName: string): boolean => {
    const base = suitableName.replace(/\s*free$/i, '').trim().toLowerCase()
    const cName = containsName.toLowerCase()
    if (base === cName) return true
    // Plural: "Eggs" vs "Egg Free", "Nuts" vs "Nut Free"
    if (base + 's' === cName || base === cName + 's') return true
    if (cName.endsWith('s') && base === cName.slice(0, -1)) return true
    return false
  }

  const toggleFlag = async (flagId: number, categoryId: number) => {
    const newFlags = new Set(activeFlagIds)
    const newNones = new Set(noneCategoryIds)

    if (newFlags.has(flagId)) {
      newFlags.delete(flagId)
    } else {
      // Find the flag and its category
      const thisCat = categories?.find(c => c.id === categoryId)
      const thisFlag = thisCat?.flags.find(f => f.id === flagId)

      if (thisCat && thisFlag && categories) {
        // If enabling a "suitable_for" flag, check for conflicting active "contains" flags
        if (thisCat.propagation_type === 'suitable_for') {
          for (const cat of categories) {
            if (cat.propagation_type !== 'contains') continue
            for (const f of cat.flags) {
              if (newFlags.has(f.id) && flagNamesConflict(f.name, thisFlag.name)) {
                alert(`Cannot set "${thisFlag.name}" — this ingredient contains ${f.name}. Remove the ${f.name} flag first.`)
                return
              }
            }
          }
        }

        // If enabling a "contains" flag, auto-remove conflicting "suitable_for" flags
        if (thisCat.propagation_type === 'contains') {
          for (const cat of categories) {
            if (cat.propagation_type !== 'suitable_for') continue
            for (const f of cat.flags) {
              if (newFlags.has(f.id) && flagNamesConflict(thisFlag.name, f.name)) {
                newFlags.delete(f.id)
              }
            }
          }
        }
      }

      newFlags.add(flagId)
      newNones.delete(categoryId)
    }

    setActiveFlagIds(newFlags)
    setNoneCategoryIds(newNones)
    onChange?.([...newFlags], [...newNones])

    if (ingredientId) {
      setSaving(true)
      try {
        await fetch(`/api/ingredients/${ingredientId}/flags`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ food_flag_ids: [...newFlags] }),
        })
        queryClient.invalidateQueries({ queryKey: ['ingredient-flags', ingredientId] })
        queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      } catch { /* ignore */ }
      setSaving(false)
    }
  }

  const toggleNone = async (categoryId: number) => {
    const newNones = new Set(noneCategoryIds)
    const newFlags = new Set(activeFlagIds)

    if (newNones.has(categoryId)) {
      newNones.delete(categoryId)
    } else {
      newNones.add(categoryId)
      const catFlags = categories?.find(c => c.id === categoryId)?.flags || []
      catFlags.forEach(f => newFlags.delete(f.id))
    }

    setNoneCategoryIds(newNones)
    setActiveFlagIds(newFlags)
    onChange?.([...newFlags], [...newNones])

    if (ingredientId) {
      setSaving(true)
      try {
        await fetch(`/api/ingredients/${ingredientId}/flags/none`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ category_id: categoryId }),
        })
        queryClient.invalidateQueries({ queryKey: ['ingredient-flags', ingredientId] })
        queryClient.invalidateQueries({ queryKey: ['ingredient-flag-nones', ingredientId] })
        queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      } catch { /* ignore */ }
      setSaving(false)
    }
  }

  // Apply a single suggestion (add the flag)
  const applySuggestion = (suggestion: AllergenSuggestion) => {
    // Find which category this flag belongs to
    const cat = categories?.find(c => c.flags.some(f => f.id === suggestion.flag_id))
    if (cat) {
      toggleFlag(suggestion.flag_id, cat.id)
    }
  }

  // Dismiss a suggestion
  const confirmDismissal = async (suggestion: AllergenSuggestion) => {
    if (!dismissName.trim()) return

    const dismissal: DismissalInfo = {
      food_flag_id: suggestion.flag_id,
      flag_name: suggestion.flag_name,
      dismissed_by_name: dismissName.trim(),
      reason: dismissReason.trim() || undefined,
      matched_keyword: suggestion.matched_keywords.join(', '),
    }

    // Edit mode: persist immediately
    if (ingredientId) {
      try {
        const res = await fetch(`/api/ingredients/${ingredientId}/flags/dismissals`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(dismissal),
        })
        if (res.ok) {
          const saved = await res.json()
          dismissal.id = saved.id
        }
      } catch { /* ignore */ }
    }

    const updated = [...dismissals, dismissal]
    setDismissals(updated)
    setDismissingFlagId(null)
    setDismissReason('')
    // Keep dismissName for next dismiss in same session
    onDismissalsChange?.(updated)
  }

  // Undo a dismissal
  const undoDismissal = async (flagId: number) => {
    const dismissal = dismissals.find(d => d.food_flag_id === flagId)
    if (!dismissal) return

    // Edit mode: delete from API
    if (ingredientId && dismissal.id) {
      try {
        await fetch(`/api/ingredients/${ingredientId}/flags/dismissals/${dismissal.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch { /* ignore */ }
    }

    const updated = dismissals.filter(d => d.food_flag_id !== flagId)
    setDismissals(updated)
    onDismissalsChange?.(updated)
  }

  // Apply all pending suggestions at once
  const applyAllSuggestions = async () => {
    const newFlags = new Set(activeFlagIds)
    const newNones = new Set(noneCategoryIds)

    for (const s of pendingSuggestions) {
      newFlags.add(s.flag_id)
      // Clear "none" for the category if we're adding a flag
      const cat = categories?.find(c => c.flags.some(f => f.id === s.flag_id))
      if (cat) newNones.delete(cat.id)
    }

    setActiveFlagIds(newFlags)
    setNoneCategoryIds(newNones)
    onChange?.([...newFlags], [...newNones])

    if (ingredientId) {
      setSaving(true)
      try {
        await fetch(`/api/ingredients/${ingredientId}/flags`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ food_flag_ids: [...newFlags] }),
        })
        queryClient.invalidateQueries({ queryKey: ['ingredient-flags', ingredientId] })
        queryClient.invalidateQueries({ queryKey: ['ingredients'] })
      } catch { /* ignore */ }
      setSaving(false)
    }
  }

  if (!categories?.length) return null

  // Merge name-based and scan-based suggestions, deduplicate by flag_id
  const allSuggestions: AllergenSuggestion[] = []
  const seenFlagIds = new Set<number>()
  for (const s of (nameSuggestions || [])) {
    if (!seenFlagIds.has(s.flag_id)) {
      seenFlagIds.add(s.flag_id)
      allSuggestions.push(s)
    }
  }
  for (const s of (scanSuggestions || [])) {
    if (!seenFlagIds.has(s.flag_id)) {
      seenFlagIds.add(s.flag_id)
      // Use the source field if available (e.g. Brakes: "contains", "dietary", "keyword"),
      // otherwise fall back to "label" for OCR label scan results
      const src = 'source' in s ? (s as unknown as { source: string }).source : ''
      const sourceLabel = src ? ({ contains: 'product data', dietary: 'product data', keyword: 'product data' }[src] || 'label') : 'label'
      allSuggestions.push({ ...s, matched_keywords: s.matched_keywords.map(k => `${k} (${sourceLabel})`) })
    }
  }
  // LLM FEATURE — see LLM-MANIFEST.md for removal instructions
  for (const s of (llmSuggestions || [])) {
    if (!seenFlagIds.has(s.flag_id)) {
      seenFlagIds.add(s.flag_id)
      allSuggestions.push({ ...s, matched_keywords: s.matched_keywords.map(k => `\u2728 ${k}`) })
    }
  }

  // Filter out suggestions for flags already active or dismissed
  const dismissedFlagIds = new Set(dismissals.map(d => d.food_flag_id))
  const pendingSuggestions = allSuggestions.filter(s => !activeFlagIds.has(s.flag_id) && !dismissedFlagIds.has(s.flag_id))

  // Build badge list from active flags
  const activeFlags = categories.flatMap(c =>
    c.flags.filter(f => activeFlagIds.has(f.id)).map(f => ({
      name: f.name,
      code: f.code,
      icon: f.icon,
      propagation_type: c.propagation_type,
    }))
  )

  return (
    <div style={{ borderTop: '1px solid #eee', padding: '0.75rem 1.25rem' }}>
      {/* Current flag badges */}
      {activeFlags.length > 0 && (
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          {activeFlags.map(f => (
            <span
              key={f.name}
              style={{
                background: f.propagation_type === 'contains' ? '#dc3545' : '#28a745',
                color: 'white',
                padding: '1px 5px',
                borderRadius: '10px',
                fontSize: '0.7rem',
                fontWeight: 600,
              }}
              title={f.name}
            >
              {f.icon ? `${f.icon} ` : ''}{f.code || f.name.substring(0, 3)}
            </span>
          ))}
        </div>
      )}

      {/* LLM FEATURE — AI analysing spinner when no other suggestions yet */}
      {pendingSuggestions.length === 0 && llmAnalysing && (
        <div style={{ padding: '0.3rem 0.5rem', fontSize: '0.73rem', color: '#7c3aed' }}>
          {'\u2728'} AI analysing ingredients...
        </div>
      )}

      {/* Allergen suggestions bar */}
      {pendingSuggestions.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.3rem 0.5rem',
              background: '#fffbeb',
              border: '1px solid #f59e0b',
              borderRadius: suggestionsExpanded ? '6px 6px 0 0' : '6px',
              cursor: 'pointer',
            }}
            onClick={() => setSuggestionsExpanded(!suggestionsExpanded)}
          >
            <span style={{ fontSize: '0.73rem', color: '#b45309', fontWeight: 600 }}>
              {'\u26A0'} {pendingSuggestions.length} allergen suggestion{pendingSuggestions.length !== 1 ? 's' : ''}
              {/* LLM FEATURE — see LLM-MANIFEST.md */}
              {llmAnalysing && <span style={{ marginLeft: '0.4rem', fontSize: '0.68rem', color: '#7c3aed' }}>\u2728 AI analysing...</span>}
            </span>
            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
              <button
                onClick={(e) => { e.stopPropagation(); applyAllSuggestions() }}
                disabled={saving}
                style={{
                  padding: '0.15rem 0.4rem',
                  border: '1px solid #f59e0b',
                  borderRadius: '4px',
                  background: '#f59e0b',
                  color: 'white',
                  cursor: saving ? 'default' : 'pointer',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                }}
              >
                Apply All
              </button>
              <span style={{ fontSize: '0.7rem', color: '#b45309' }}>
                {suggestionsExpanded ? '\u25B2' : '\u25BC'}
              </span>
            </div>
          </div>
          {suggestionsExpanded && (
            <div style={{
              padding: '0.4rem 0.5rem',
              background: '#fffef5',
              border: '1px solid #f59e0b',
              borderTop: 'none',
              borderRadius: '0 0 6px 6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem',
            }}>
              {pendingSuggestions.map(s => (
                <div key={s.flag_id}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.73rem', color: '#555', flex: 1 }}>
                      <strong>{s.flag_name}</strong>
                      {s.flag_code && <span style={{ color: '#888' }}> ({s.flag_code})</span>}
                      <span style={{ color: '#999', marginLeft: '0.3rem', fontSize: '0.68rem' }}>
                        matched: {s.matched_keywords.join(', ')}
                      </span>
                    </span>
                    <div style={{ display: 'flex', gap: '0.25rem' }}>
                      <button
                        onClick={() => {
                          setDismissingFlagId(s.flag_id)
                          setDismissReason('')
                        }}
                        disabled={saving}
                        style={{
                          padding: '0.1rem 0.35rem',
                          border: '1px solid #dc3545',
                          borderRadius: '4px',
                          background: 'white',
                          cursor: saving ? 'default' : 'pointer',
                          fontSize: '0.68rem',
                          color: '#dc3545',
                        }}
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => applySuggestion(s)}
                        disabled={saving}
                        style={{
                          padding: '0.1rem 0.35rem',
                          border: '1px solid #ccc',
                          borderRadius: '4px',
                          background: 'white',
                          cursor: saving ? 'default' : 'pointer',
                          fontSize: '0.68rem',
                          color: '#555',
                        }}
                      >
                        + Apply
                      </button>
                    </div>
                  </div>
                  {/* Inline dismiss form */}
                  {dismissingFlagId === s.flag_id && (
                    <div style={{
                      marginTop: '0.25rem',
                      padding: '0.35rem 0.5rem',
                      background: '#fff5f5',
                      border: '1px solid #fca5a5',
                      borderRadius: '4px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.25rem',
                    }}>
                      <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                        <input
                          type="text"
                          placeholder="Your name (required)"
                          value={dismissName}
                          onChange={e => setDismissName(e.target.value)}
                          style={{
                            flex: 1,
                            padding: '0.2rem 0.4rem',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            fontSize: '0.73rem',
                          }}
                          autoFocus
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                        <input
                          type="text"
                          placeholder="Reason (optional)"
                          value={dismissReason}
                          onChange={e => setDismissReason(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && dismissName.trim()) confirmDismissal(s) }}
                          style={{
                            flex: 1,
                            padding: '0.2rem 0.4rem',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            fontSize: '0.73rem',
                          }}
                        />
                        <button
                          onClick={() => confirmDismissal(s)}
                          disabled={!dismissName.trim()}
                          style={{
                            padding: '0.15rem 0.4rem',
                            border: '1px solid #dc3545',
                            borderRadius: '4px',
                            background: dismissName.trim() ? '#dc3545' : '#f0f0f0',
                            color: dismissName.trim() ? 'white' : '#999',
                            cursor: dismissName.trim() ? 'pointer' : 'default',
                            fontSize: '0.68rem',
                            fontWeight: 600,
                          }}
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDismissingFlagId(null)}
                          style={{
                            padding: '0.15rem 0.4rem',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            background: 'white',
                            cursor: 'pointer',
                            fontSize: '0.68rem',
                            color: '#666',
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Dismissed suggestions */}
      {dismissals.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div
            onClick={() => setShowDismissed(!showDismissed)}
            style={{
              padding: '0.2rem 0.5rem',
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: showDismissed ? '6px 6px 0 0' : '6px',
              cursor: 'pointer',
              fontSize: '0.68rem',
              color: '#888',
            }}
          >
            {dismissals.length} dismissed {showDismissed ? '\u25B2' : '\u25BC'}
          </div>
          {showDismissed && (
            <div style={{
              padding: '0.3rem 0.5rem',
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderTop: 'none',
              borderRadius: '0 0 6px 6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.2rem',
            }}>
              {dismissals.map(d => (
                <div key={d.food_flag_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '0.7rem', color: '#999', textDecoration: 'line-through' }}>
                    {d.flag_name || `Flag #${d.food_flag_id}`}
                    {d.dismissed_by_name && (
                      <span style={{ fontStyle: 'italic', marginLeft: '0.3rem' }}>
                        by {d.dismissed_by_name}
                      </span>
                    )}
                    {d.reason && (
                      <span style={{ marginLeft: '0.3rem' }}>
                        — {d.reason}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => undoDismissal(d.food_flag_id)}
                    style={{
                      padding: '0.05rem 0.3rem',
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      background: 'white',
                      cursor: 'pointer',
                      fontSize: '0.65rem',
                      color: '#666',
                    }}
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Category buttons */}
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: expandedCats.size > 0 ? '0.5rem' : 0 }}>
        {categories.map(cat => {
          const catFlagCount = cat.flags.filter(f => activeFlagIds.has(f.id)).length
          const isNone = noneCategoryIds.has(cat.id)
          const isExpanded = expandedCats.has(cat.id)
          const isAssessed = catFlagCount > 0 || isNone

          return (
            <button
              key={cat.id}
              onClick={() => setExpandedCats(prev => {
                const next = new Set(prev)
                if (next.has(cat.id)) next.delete(cat.id)
                else next.add(cat.id)
                return next
              })}
              style={{
                padding: '0.25rem 0.5rem',
                border: `1px solid ${isExpanded ? '#555' : isAssessed ? '#ccc' : cat.required ? '#f59e0b' : '#ddd'}`,
                borderRadius: '4px',
                background: isExpanded ? '#f0f0f0' : 'white',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: isExpanded ? 600 : 400,
                color: isAssessed ? '#333' : cat.required ? '#b45309' : '#888',
              }}
            >
              {cat.name}
              {catFlagCount > 0 && <span style={{ marginLeft: '0.25rem', color: cat.propagation_type === 'contains' ? '#dc3545' : '#28a745', fontWeight: 600 }}>({catFlagCount})</span>}
              {isNone && <span style={{ marginLeft: '0.25rem', color: '#888' }}>({'\u2014'})</span>}
              {!isAssessed && cat.required && <span style={{ marginLeft: '0.25rem', color: '#f59e0b' }}>?</span>}
            </button>
          )
        })}
      </div>

      {/* Expanded categories: flag toggles */}
      {categories.filter(c => expandedCats.has(c.id)).map(cat => {
        const isNone = noneCategoryIds.has(cat.id)

        return (
          <div key={cat.id} style={{
            display: 'flex',
            gap: '0.35rem',
            flexWrap: 'wrap',
            padding: '0.5rem',
            background: '#fafafa',
            borderRadius: '6px',
            border: '1px solid #e0e0e0',
            alignItems: 'center',
            opacity: saving ? 0.6 : 1,
            marginBottom: '0.35rem',
          }}>
            <span style={{ fontSize: '0.7rem', color: '#888', fontWeight: 600, marginRight: '0.25rem' }}>
              {cat.name} ({cat.propagation_type}):
            </span>
            {cat.flags.map(flag => {
              const isActive = activeFlagIds.has(flag.id)
              const color = cat.propagation_type === 'contains' ? '#dc3545' : '#28a745'
              return (
                <button
                  key={flag.id}
                  onClick={() => toggleFlag(flag.id, cat.id)}
                  disabled={saving || isNone}
                  title={flag.name}
                  style={{
                    padding: '0.2rem 0.5rem',
                    border: `1.5px solid ${isActive ? color : '#ccc'}`,
                    borderRadius: '12px',
                    background: isActive ? color : 'white',
                    color: isActive ? 'white' : isNone ? '#ccc' : '#555',
                    cursor: saving || isNone ? 'default' : 'pointer',
                    fontSize: '0.73rem',
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  {flag.icon ? `${flag.icon} ` : ''}{flag.code || flag.name}
                </button>
              )
            })}
            <button
              onClick={() => toggleNone(cat.id)}
              disabled={saving}
              style={{
                padding: '0.2rem 0.5rem',
                border: `1.5px dashed ${isNone ? '#888' : '#ccc'}`,
                borderRadius: '12px',
                background: isNone ? '#888' : 'white',
                color: isNone ? 'white' : '#888',
                cursor: saving ? 'default' : 'pointer',
                fontSize: '0.73rem',
                fontWeight: isNone ? 600 : 400,
                marginLeft: '0.25rem',
              }}
              title="None of these apply"
            >
              None
            </button>
          </div>
        )
      })}
    </div>
  )
}
