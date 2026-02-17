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

interface Props {
  ingredientId: number | null // null = create mode (flags stored locally)
  token: string
  onChange?: (flagIds: number[], noneCategoryIds: number[]) => void
  ingredientName?: string       // for name-based suggestions
  productIngredients?: string   // for product-text-based suggestions
  scanSuggestions?: AllergenSuggestion[] // from label OCR scan (passed from parent)
  autoApplyFlagIds?: number[] // flag IDs to auto-apply (e.g. from Brakes "Contains" statement)
}

export default function IngredientFlagEditor({ ingredientId, token, onChange, ingredientName, productIngredients, scanSuggestions, autoApplyFlagIds }: Props) {
  const queryClient = useQueryClient()
  const [activeFlagIds, setActiveFlagIds] = useState<Set<number>>(new Set())
  const [noneCategoryIds, setNoneCategoryIds] = useState<Set<number>>(new Set())
  const [autoApplied, setAutoApplied] = useState<Set<number>>(new Set()) // track which were auto-applied
  const [expandedCats, setExpandedCats] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true)

  // Debounce name and product ingredients for suggestion queries
  const debouncedName = useDebounce(ingredientName || '', 500)
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

  // Fetch allergen suggestions based on name + product ingredients text
  const { data: nameSuggestions } = useQuery<AllergenSuggestion[]>({
    queryKey: ['allergen-suggestions', debouncedName, debouncedText],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedName) params.set('name', debouncedName)
      if (debouncedText) params.set('text', debouncedText)
      const res = await fetch(`/api/food-flags/suggest?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!token && (debouncedName.length >= 2 || debouncedText.length >= 5),
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

  // Reset local state when ingredientId changes (e.g. modal opens for different ingredient)
  useEffect(() => {
    if (!ingredientId) {
      setActiveFlagIds(new Set())
      setNoneCategoryIds(new Set())
      setExpandedCats(new Set())
      setSuggestionsExpanded(true)
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
      allSuggestions.push({ ...s, matched_keywords: s.matched_keywords.map(k => `${k} (label)`) })
    }
  }

  // Filter out suggestions for flags already active
  const pendingSuggestions = allSuggestions.filter(s => !activeFlagIds.has(s.flag_id))

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
                <div key={s.flag_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '0.73rem', color: '#555' }}>
                    <strong>{s.flag_name}</strong>
                    {s.flag_code && <span style={{ color: '#888' }}> ({s.flag_code})</span>}
                    <span style={{ color: '#999', marginLeft: '0.3rem', fontSize: '0.68rem' }}>
                      matched: {s.matched_keywords.join(', ')}
                    </span>
                  </span>
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
