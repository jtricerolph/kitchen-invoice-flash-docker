/**
 * Line Items Search Page
 * Search consolidated line items with price change detection.
 */
import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import IngredientModal from './IngredientModal'
import { IngredientModalResult, LineItemResult } from '../utils/ingredientHelpers'
import {
  useDebounce,
  usePersistedState,
  getDefaultDateRange,
  formatDateForDisplay,
  formatCurrency,
  formatQuantity,
  getPriceStatusConfig,
  SEARCH_STORAGE_KEYS,
} from '../utils/searchHelpers'
import LineItemHistoryModal from './LineItemHistoryModal'

interface LineItemSearchItem {
  product_code: string | null
  description: string | null
  supplier_id: number | null
  supplier_name: string | null
  unit: string | null
  most_recent_price: number | null
  earliest_price_in_period: number | null
  price_change_percent: number | null
  price_change_status: string
  total_quantity: number | null
  occurrence_count: number
  most_recent_invoice_id: number
  most_recent_invoice_number: string | null
  most_recent_date: string | null
  has_definition: boolean
  portions_per_unit: number | null
  pack_quantity: number | null
  most_recent_line_item_id: number | null
  most_recent_line_number: number | null
  most_recent_raw_content: string | null
  most_recent_pack_quantity: number | null
  most_recent_unit_size: number | null
  most_recent_unit_size_type: string | null
  // Ingredient mapping
  ingredient_id: number | null
  ingredient_name: string | null
  ingredient_standard_unit: string | null
  price_per_std_unit: number | null
}

interface GroupSummary {
  name: string
  count: number
  total: number | null
}

interface SearchResponse {
  items: LineItemSearchItem[]
  total_count: number
  grouped_by: string | null
  groups: GroupSummary[] | null
}

interface Supplier {
  id: number
  name: string
}

interface SearchSettings {
  price_change_lookback_days: number
  price_change_amber_threshold: number
  price_change_red_threshold: number
}

interface IngredientSuggestion {
  id: number
  name: string
  category_name: string | null
  standard_unit: string
  yield_percent: number
  similarity?: number
}

const keys = SEARCH_STORAGE_KEYS.lineItems

export default function SearchLineItems() {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const defaultDates = useMemo(() => getDefaultDateRange(), [])

  // Persisted search state
  const [searchInput, setSearchInput] = usePersistedState(keys.query, '')
  const [supplierId, setSupplierId] = usePersistedState<string>(keys.supplier, '')
  const [dateFrom, setDateFrom] = usePersistedState(keys.dateFrom, defaultDates.from)
  const [dateTo, setDateTo] = usePersistedState(keys.dateTo, defaultDates.to)
  const [groupBy, setGroupBy] = usePersistedState<string>(keys.groupBy, '')
  const [priceChangeFilter, setPriceChangeFilter] = usePersistedState<string>(keys.priceChangeFilter, '')
  const [mappedFilter, setMappedFilter] = usePersistedState<string>(keys.mappedFilter, '')
  const [sortColumn, setSortColumn] = usePersistedState<string>(keys.sortColumn, '')
  const [sortDirection, setSortDirection] = usePersistedState<'asc' | 'desc'>(keys.sortDirection, 'asc')

  // History modal state
  const [historyModal, setHistoryModal] = useState<{
    isOpen: boolean
    productCode: string | null
    description: string | null
    unit: string | null
    supplierId: number
    supplierName: string
  } | null>(null)

  // Ingredient mapping modal state (same as Review.tsx)
  const [modalItem, setModalItem] = useState<LineItemSearchItem | null>(null)
  const [costEdits, setCostEdits] = useState<{ pack_quantity?: number | null; unit_size?: number | null; unit_size_type?: string | null; unit_price?: number | null }>({})
  const [ingredientSearch, setIngredientSearch] = useState('')
  const [ingredientSuggestions, setIngredientSuggestions] = useState<IngredientSuggestion[]>([])
  const [ingredientSearchLoading, setIngredientSearchLoading] = useState(false)
  const [selectedIngredientId, setSelectedIngredientId] = useState<number | null>(null)
  const [selectedIngredientName, setSelectedIngredientName] = useState('')
  const [selectedIngredientUnit, setSelectedIngredientUnit] = useState('')
  const [showCreateIngredient, setShowCreateIngredient] = useState(false)
  const [conversionDisplay, setConversionDisplay] = useState('')
  const [savingMapping, setSavingMapping] = useState(false)

  // Description alias suggestion state
  const [aliasSuggestions, setAliasSuggestions] = useState<Record<string, {
    description: string
    source_id: number
    ingredient_id: number
    ingredient_name: string | null
    canonical_description: string
    product_code: string | null
    similarity: number
    price_difference: number | null
  }>>({})
  const [addingAliasFor, setAddingAliasFor] = useState<string | null>(null)

  // Debounce search input
  const debouncedSearch = useDebounce(searchInput, 300)

  // Fetch suppliers
  const { data: suppliers } = useQuery<Supplier[]>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch suppliers')
      return res.json()
    },
  })

  // Fetch search settings (for price change thresholds)
  const { data: _searchSettings } = useQuery<SearchSettings>({
    queryKey: ['search-settings'],
    queryFn: async () => {
      const res = await fetch('/api/search/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch search settings')
      return res.json()
    },
    staleTime: 60000, // Cache for 1 minute
  })

  // Search line items
  const { data, isLoading, error } = useQuery<SearchResponse>({
    queryKey: ['search-line-items', debouncedSearch, supplierId, dateFrom, dateTo, groupBy, mappedFilter],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('q', debouncedSearch)
      if (supplierId) params.set('supplier_id', supplierId)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (groupBy) params.set('group_by', groupBy)
      if (mappedFilter) params.set('mapped', mappedFilter)
      params.set('limit', '200')

      const res = await fetch(`/api/search/line-items?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Search failed')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch alias suggestions for unmapped items without product codes
  useEffect(() => {
    if (!data?.items || !token) return
    // Group unmapped items by supplier for batch requests
    const bySupplier = new Map<number, { description: string; price?: number }[]>()
    for (const item of data.items) {
      if (!item.ingredient_id && !item.product_code && item.description && item.supplier_id) {
        if (!bySupplier.has(item.supplier_id)) bySupplier.set(item.supplier_id, [])
        bySupplier.get(item.supplier_id)!.push({
          description: item.description,
          price: item.most_recent_price ?? undefined,
        })
      }
    }
    if (bySupplier.size === 0) { setAliasSuggestions({}); return }

    const allSuggestions: typeof aliasSuggestions = {}
    const promises = Array.from(bySupplier.entries()).map(([sid, items]) =>
      fetch('/api/ingredients/sources/alias-suggestions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_id: sid, items }),
      })
        .then(res => res.ok ? res.json() : [])
        .then((suggestions: any[]) => {
          for (const s of suggestions) {
            allSuggestions[`${sid}:${s.description.toLowerCase()}`] = s
          }
        })
        .catch(() => {})
    )
    Promise.all(promises).then(() => setAliasSuggestions({ ...allSuggestions }))
  }, [data?.items, token])

  const addDescriptionAliasMutation = useMutation({
    mutationFn: async ({ sourceId, alias }: { sourceId: number; alias: string }) => {
      const res = await fetch(`/api/ingredients/sources/${sourceId}/aliases`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ alias }),
      })
      if (!res.ok) throw new Error('Failed to add alias')
      return res.json()
    },
    onSuccess: (_data, variables) => {
      setAliasSuggestions(prev => {
        const next = { ...prev }
        // Remove matching key
        for (const key of Object.keys(next)) {
          if (key.endsWith(`:${variables.alias.toLowerCase()}`)) delete next[key]
        }
        return next
      })
      setAddingAliasFor(null)
      queryClient.invalidateQueries({ queryKey: ['search-line-items'] })
    },
  })

  const openHistoryModal = (item: LineItemSearchItem) => {
    if (!item.supplier_id) return
    setHistoryModal({
      isOpen: true,
      productCode: item.product_code,
      description: item.description,
      unit: item.unit,
      supplierId: item.supplier_id,
      supplierName: item.supplier_name || 'Unknown',
    })
  }

  const handleScaleClick = async (item: LineItemSearchItem) => {
    setModalItem(item)
    setCostEdits({
      pack_quantity: item.most_recent_pack_quantity ? Number(item.most_recent_pack_quantity) : null,
      unit_size: item.most_recent_unit_size ? Number(item.most_recent_unit_size) : null,
      unit_size_type: item.most_recent_unit_size_type,
      unit_price: item.most_recent_price != null ? Number(item.most_recent_price) : null,
    })
    setSelectedIngredientId(item.ingredient_id || null)
    setSelectedIngredientName(item.ingredient_name || '')
    setSelectedIngredientUnit(item.ingredient_standard_unit || '')
    setShowCreateIngredient(false)
    setIngredientSearch('')
    setIngredientSuggestions([])
    setConversionDisplay('')
    setSavingMapping(false)

    // Show conversion display if pack data exists
    if (item.most_recent_unit_size && item.most_recent_unit_size_type) {
      updateConversionDisplay(item.ingredient_standard_unit || undefined, {
        pack_quantity: item.most_recent_pack_quantity,
        unit_size: item.most_recent_unit_size,
        unit_size_type: item.most_recent_unit_size_type,
        unit_price: item.most_recent_price,
      })
    }

    // Auto-suggest ingredient match from description if unmapped
    if (item.description && !item.ingredient_id) {
      searchIngredients(item.description)
    }
  }

  const searchIngredients = async (query: string) => {
    if (!query || query.length < 2) {
      setIngredientSuggestions([])
      return
    }
    setIngredientSearchLoading(true)
    try {
      const res = await fetch(`/api/ingredients/suggest?description=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setIngredientSuggestions(await res.json())
    } catch { /* ignore */ }
    setIngredientSearchLoading(false)
  }

  const selectIngredient = (ing: IngredientSuggestion) => {
    setSelectedIngredientId(ing.id)
    setSelectedIngredientName(ing.name)
    setSelectedIngredientUnit(ing.standard_unit)
    setIngredientSearch('')
    setIngredientSuggestions([])
    if (!costEdits.unit_size_type) {
      setCostEdits(prev => ({ ...prev, unit_size_type: ing.standard_unit }))
    }
    updateConversionDisplay(ing.standard_unit)
  }

  const handleIngredientCreated = (_result: IngredientModalResult) => {
    // IngredientModal already created the source mapping, so close everything
    queryClient.invalidateQueries({ queryKey: ['search-line-items'] })
    closeModal()
  }

  const updateConversionDisplay = (stdUnit?: string, overrides?: Record<string, unknown>) => {
    const edits = overrides ? { ...costEdits, ...overrides } : costEdits
    const unit = stdUnit || selectedIngredientUnit || (edits.unit_size_type as string)
    const pq = (edits.pack_quantity as number) || 1
    const us = edits.unit_size as number
    const ust = edits.unit_size_type as string
    const up = edits.unit_price as number
    if (!us || !ust || !unit) { setConversionDisplay(''); return }
    const conversions: Record<string, Record<string, number>> = {
      g: { g: 1, kg: 0.001 }, kg: { g: 1000, kg: 1 }, oz: { g: 28.3495, kg: 0.0283495 },
      ml: { ml: 1, ltr: 0.001 }, cl: { ml: 10, ltr: 0.01 }, ltr: { ml: 1000, ltr: 1 },
      each: { each: 1 },
    }
    const conv = conversions[ust]?.[unit]
    if (!conv) { setConversionDisplay(ust !== unit ? `Cannot convert ${ust} → ${unit}` : `${us}${ust}`); return }
    const totalStd = pq * us * conv
    const pricePerStd = up ? (up / totalStd) : null
    const packNote = pq > 1 ? `${pq} × ${us}${ust} = ` : ''
    let display = `${packNote}${totalStd.toFixed(totalStd % 1 ? 2 : 0)} ${unit}`
    if (pricePerStd) {
      display += ` → £${pricePerStd.toFixed(4)} per ${unit}`
      if (unit === 'g') display += ` (£${(pricePerStd * 1000).toFixed(2)}/kg)`
      else if (unit === 'ml') display += ` (£${(pricePerStd * 1000).toFixed(2)}/ltr)`
    }
    setConversionDisplay(display)
  }

  const closeModal = () => {
    setModalItem(null)
    setCostEdits({})
    setSelectedIngredientId(null)
    setSelectedIngredientName('')
    setSelectedIngredientUnit('')
    setShowCreateIngredient(false)
    setIngredientSearch('')
    setIngredientSuggestions([])
    setConversionDisplay('')
  }

  const saveMapping = async () => {
    if (!modalItem) return
    setSavingMapping(true)
    try {
      // Update the most recent line item's pack fields if we have one
      if (modalItem.most_recent_line_item_id && modalItem.most_recent_invoice_id) {
        await fetch(`/api/invoices/${modalItem.most_recent_invoice_id}/line-items/${modalItem.most_recent_line_item_id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pack_quantity: costEdits.pack_quantity || null,
            unit_size: costEdits.unit_size || null,
            unit_size_type: costEdits.unit_size_type || null,
            ...(selectedIngredientId ? { ingredient_id: selectedIngredientId } : {}),
          }),
        })
      }

      // Create ingredient source mapping
      if (selectedIngredientId && modalItem.supplier_id) {
        const sourceData: Record<string, unknown> = {
          supplier_id: modalItem.supplier_id,
          pack_quantity: costEdits.pack_quantity || 1,
          unit_size: costEdits.unit_size || null,
          unit_size_type: costEdits.unit_size_type || selectedIngredientUnit || null,
        }
        if (modalItem.product_code) {
          sourceData.product_code = modalItem.product_code
        } else if (modalItem.description) {
          sourceData.description_pattern = modalItem.description.substring(0, 100).toLowerCase().trim()
        }
        if (costEdits.unit_price) sourceData.latest_unit_price = costEdits.unit_price
        if (modalItem.most_recent_invoice_id) sourceData.invoice_id = modalItem.most_recent_invoice_id

        await fetch(`/api/ingredients/${selectedIngredientId}/sources`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(sourceData),
        })
      }

      queryClient.invalidateQueries({ queryKey: ['search-line-items'] })
      closeModal()
    } catch (err) {
      console.error('Failed to save mapping:', err)
    }
    setSavingMapping(false)
  }

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const getSortIndicator = (column: string) => {
    if (sortColumn !== column) return null
    return sortDirection === 'asc' ? ' ▲' : ' ▼'
  }

  // Filter items by price change status
  const filteredItems = useMemo(() => {
    if (!data?.items) return []
    if (!priceChangeFilter) return data.items

    return data.items.filter((item) => {
      if (priceChangeFilter === 'no_history') {
        return item.price_change_status === 'no_history'
      } else if (priceChangeFilter === 'no_change') {
        return item.price_change_status === 'consistent' || item.price_change_status === 'acknowledged'
      } else if (priceChangeFilter === 'increase') {
        return item.price_change_percent !== null && item.price_change_percent > 0
      } else if (priceChangeFilter === 'decrease') {
        return item.price_change_percent !== null && item.price_change_percent < 0
      }
      return true
    })
  }, [data?.items, priceChangeFilter])

  // Sort filtered items
  const sortedItems = useMemo(() => {
    if (!filteredItems.length || !sortColumn) return filteredItems

    const sorted = [...filteredItems].sort((a, b) => {
      let aVal: any
      let bVal: any

      switch (sortColumn) {
        case 'code':
          aVal = a.product_code || ''
          bVal = b.product_code || ''
          break
        case 'description':
          aVal = a.description || ''
          bVal = b.description || ''
          break
        case 'supplier':
          aVal = a.supplier_name || ''
          bVal = b.supplier_name || ''
          break
        case 'price':
          aVal = a.most_recent_price ?? -Infinity
          bVal = b.most_recent_price ?? -Infinity
          break
        case 'ingredient_rate':
          aVal = a.price_per_std_unit != null
            ? (typeof a.price_per_std_unit === 'string' ? parseFloat(a.price_per_std_unit) : a.price_per_std_unit)
            : -Infinity
          bVal = b.price_per_std_unit != null
            ? (typeof b.price_per_std_unit === 'string' ? parseFloat(b.price_per_std_unit) : b.price_per_std_unit)
            : -Infinity
          break
        case 'total_quantity':
          aVal = a.total_quantity ?? -Infinity
          bVal = b.total_quantity ?? -Infinity
          break
        case 'occurrence_count':
          aVal = a.occurrence_count ?? 0
          bVal = b.occurrence_count ?? 0
          break
        case 'last_invoice':
          aVal = a.most_recent_invoice_number || ''
          bVal = b.most_recent_invoice_number || ''
          break
        case 'last_date':
          aVal = a.most_recent_date || ''
          bVal = b.most_recent_date || ''
          break
        default:
          return 0
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal)
      } else {
        return sortDirection === 'asc'
          ? aVal - bVal
          : bVal - aVal
      }
    })

    return sorted
  }, [filteredItems, sortColumn, sortDirection])

  const renderPriceStatus = (item: LineItemSearchItem) => {
    const config = getPriceStatusConfig(item.price_change_status)
    if (!config.icon) return null

    // Show icon for consistent prices (green tick)
    if (item.price_change_status === 'consistent' || item.price_change_status === 'acknowledged') {
      // Calculate lookback days from search period
      const searchPeriodDays = Math.ceil((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24))
      const lookbackDays = searchPeriodDays + 30

      return (
        <div
          style={{ fontSize: '0.75rem', marginTop: '2px', color: config.color, cursor: 'help' }}
          title={`Price stable over last ${lookbackDays} days\nClick 📊 to see full 12-month history`}
        >
          <span style={{ fontWeight: 'bold' }}>{config.icon}</span>
        </div>
      )
    }

    // Show icon + percentage for amber/red status with actual price changes
    if ((item.price_change_status === 'amber' || item.price_change_status === 'red') && item.price_change_percent !== null && item.price_change_percent !== 0) {
      const isIncrease = item.price_change_percent > 0
      const arrow = isIncrease ? '▲' : '▼'
      const color = isIncrease ? '#ef4444' : '#22c55e' // Red for increase, green for decrease
      const direction = isIncrease ? 'increased' : 'decreased'

      // Calculate lookback days from search period
      const searchPeriodDays = Math.ceil((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24))
      const lookbackDays = searchPeriodDays + 30

      return (
        <div
          style={{ fontSize: '0.75rem', marginTop: '2px', color, cursor: 'help' }}
          title={`Price ${direction} ${Math.abs(item.price_change_percent).toFixed(1)}% over last ${lookbackDays} days\nClick 📊 to see full history`}
        >
          <span style={{ fontWeight: 'bold' }}>{arrow}</span>{' '}
          {Math.abs(item.price_change_percent).toFixed(1)}%
        </div>
      )
    }

    // Show just the icon for amber/red without percentage
    if (item.price_change_status === 'amber' || item.price_change_status === 'red') {
      return (
        <div style={{ fontSize: '0.75rem', marginTop: '2px', color: config.color }}>
          <span style={{ fontWeight: 'bold' }}>{config.icon}</span>
        </div>
      )
    }

    return null
  }

  const formatRate = (item: LineItemSearchItem) => {
    if (item.price_per_std_unit == null) return null
    const rate = typeof item.price_per_std_unit === 'string' ? parseFloat(item.price_per_std_unit) : item.price_per_std_unit
    const unit = item.ingredient_standard_unit || '?'
    // Convert tiny per-g/ml prices to per-kg/ltr for readability
    if (unit === 'g' && rate < 1) return `£${(rate * 1000).toFixed(2)}/kg`
    if (unit === 'ml' && rate < 1) return `£${(rate * 1000).toFixed(2)}/ltr`
    // For prices >= £1 show 2 decimals, for smaller show 4
    const decimals = rate >= 1 ? 2 : 4
    return `£${rate.toFixed(decimals)}/${unit}`
  }

  const clearSearch = () => {
    setSearchInput('')
    setSupplierId('')
    setPriceChangeFilter('')
    setMappedFilter('')
    setGroupBy('')
    const defaultDates = getDefaultDateRange()
    setDateFrom(defaultDates.from)
    setDateTo(defaultDates.to)
  }

  const hasActiveFilters = searchInput || supplierId || priceChangeFilter || mappedFilter || groupBy

  return (
    <div style={{ padding: '20px', maxWidth: '1600px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '20px' }}>Search Line Items</h1>

      {/* Search Controls */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: '#f8fafc',
          borderRadius: '8px',
        }}
      >
        <input
          type="text"
          placeholder="Search product code, description..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{
            flex: '1 1 300px',
            padding: '8px 12px',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            fontSize: '14px',
          }}
        />

        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">All Suppliers</option>
          {suppliers?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          value={priceChangeFilter}
          onChange={(e) => setPriceChangeFilter(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">All Price Changes</option>
          <option value="no_history">No History</option>
          <option value="no_change">✓ No Change</option>
          <option value="increase">▲ Price Increase</option>
          <option value="decrease">▼ Price Decrease</option>
        </select>

        <select
          value={mappedFilter}
          onChange={(e) => setMappedFilter(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">All Mapping</option>
          <option value="yes">Mapped to Ingredient</option>
          <option value="no">Not Mapped</option>
        </select>

        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">No Grouping</option>
          <option value="supplier">Group by Supplier</option>
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '14px' }}>From:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
          <label style={{ fontSize: '14px' }}>To:</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
        </div>

        {hasActiveFilters && (
          <button
            onClick={clearSearch}
            style={{
              padding: '8px 16px',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: '16px',
          marginBottom: '16px',
          fontSize: '13px',
          color: '#6b7280',
          flexWrap: 'wrap',
        }}
      >
        <span>
          <span style={{ color: '#22c55e', fontWeight: 'bold' }}>✓</span> Price consistent
        </span>
        <span>
          <span style={{ color: '#ef4444', fontWeight: 'bold' }}>▲</span> Price increase
        </span>
        <span>
          <span style={{ color: '#22c55e', fontWeight: 'bold' }}>▼</span> Price decrease
        </span>
        <span>
          <span style={{ color: '#28a745' }}>⚖</span> Mapped to ingredient
        </span>
        <span>
          <span style={{ color: '#ccc' }}>⚖</span> Not mapped
        </span>
      </div>

      {/* Results */}
      {isLoading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>Error: {(error as Error).message}</p>}

      {data && (
        <div>
          <p style={{ marginBottom: '12px', color: '#6b7280' }}>
            Found {data.total_count} unique item{data.total_count !== 1 ? 's' : ''}
            {(priceChangeFilter || mappedFilter) && ` (showing ${sortedItems.length} filtered)`}
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1000px' }}>
              <thead>
                <tr style={{ backgroundColor: '#f1f5f9' }}>
                  <th style={thStyleClickable} onClick={() => handleSort('code')}>
                    Code{getSortIndicator('code')}
                  </th>
                  <th style={{ ...thStyleClickable, minWidth: '150px' }} onClick={() => handleSort('description')}>
                    Description{getSortIndicator('description')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('supplier')}>
                    Supplier{getSortIndicator('supplier')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('price')}>
                    Price{getSortIndicator('price')}
                  </th>
                  <th style={{ ...thStyle, textAlign: 'center', width: '40px' }}>
                    ⚖
                  </th>
                  <th style={{ ...thStyleClickable, textAlign: 'right' }} onClick={() => handleSort('ingredient_rate')}>
                    Ingredient Rate{getSortIndicator('ingredient_rate')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('total_quantity')}>
                    Total Qty{getSortIndicator('total_quantity')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('occurrence_count')}>
                    #{getSortIndicator('occurrence_count')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('last_invoice')}>
                    Last Invoice{getSortIndicator('last_invoice')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('last_date')}>
                    Last Date{getSortIndicator('last_date')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item, idx) => (
                  <tr
                    key={`${item.product_code}-${item.description}-${item.supplier_id}-${idx}`}
                    style={{ borderBottom: '1px solid #e5e7eb' }}
                  >
                    <td style={tdStyle}>{item.product_code || '-'}</td>
                    <td style={tdStyle}>
                      <div>
                        {item.description || '-'}
                        {item.has_definition && (
                          <span
                            title={`${item.portions_per_unit || '?'} portions per unit`}
                            style={{ marginLeft: '6px', color: '#8b5cf6' }}
                          >
                            📦
                          </span>
                        )}
                      </div>
                      {!item.ingredient_id && !item.product_code && item.description && item.supplier_id && (() => {
                        const key = `${item.supplier_id}:${item.description.toLowerCase()}`
                        const suggestion = aliasSuggestions[key]
                        if (!suggestion) return null
                        const isAdding = addingAliasFor === key
                        return (
                          <div style={{
                            fontSize: '0.7rem',
                            color: '#0c5460',
                            background: '#d1ecf1',
                            padding: '0.2rem 0.4rem',
                            borderRadius: '3px',
                            marginTop: '3px',
                            border: '1px solid #bee5eb',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '0.4rem',
                          }}>
                            <span>
                              Similar to "{suggestion.canonical_description}"
                              {suggestion.ingredient_name && <> → {suggestion.ingredient_name}</>}
                              {' '}({Math.round(suggestion.similarity * 100)}%)
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setAddingAliasFor(key)
                                addDescriptionAliasMutation.mutate({
                                  sourceId: suggestion.source_id,
                                  alias: item.description!,
                                })
                              }}
                              disabled={isAdding}
                              style={{
                                padding: '0.15rem 0.4rem',
                                background: '#17a2b8',
                                color: 'white',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: isAdding ? 'default' : 'pointer',
                                fontSize: '0.65rem',
                                fontWeight: '500',
                                whiteSpace: 'nowrap' as const,
                                opacity: isAdding ? 0.6 : 1,
                              }}
                            >
                              {isAdding ? 'Adding...' : '+ Alias'}
                            </button>
                          </div>
                        )
                      })()}
                    </td>
                    <td style={tdStyle}>{item.supplier_name || '-'}</td>
                    <td style={tdStyle}>
                      <div>
                        <div>
                          {formatCurrency(item.most_recent_price)}
                          <span
                            onClick={() => openHistoryModal(item)}
                            style={{
                              marginLeft: '6px',
                              cursor: 'pointer',
                            }}
                            title="View price history"
                          >
                            📊
                          </span>
                        </div>
                        {renderPriceStatus(item)}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center', padding: '4px' }}>
                      <button
                        type="button"
                        onClick={() => handleScaleClick(item)}
                        style={{
                          padding: '4px 6px',
                          background: 'transparent',
                          border: `1px solid ${item.ingredient_id ? '#28a745' : '#ddd'}`,
                          borderRadius: '4px',
                          cursor: 'pointer',
                          color: item.ingredient_id ? '#28a745' : '#999',
                          fontSize: '16px',
                          lineHeight: 1,
                          ...(item.ingredient_id ? { background: '#e8f5e9' } : {}),
                        }}
                        title={
                          item.ingredient_id
                            ? `Mapped to: ${item.ingredient_name}\nClick to view/edit mapping`
                            : 'Click to map to an ingredient'
                        }
                      >
                        ⚖
                      </button>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      {item.ingredient_id ? (
                        <div>
                          <span style={{ color: '#16a34a', fontWeight: 600 }}>
                            {formatRate(item) || '-'}
                          </span>
                          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '2px' }}>
                            {item.ingredient_name}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: '#d1d5db' }}>-</span>
                      )}
                    </td>
                    <td style={tdStyle}>{formatQuantity(item.total_quantity)}</td>
                    <td style={tdStyle}>{item.occurrence_count}</td>
                    <td style={tdStyle}>
                      <a
                        href={`/invoice/${item.most_recent_invoice_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#2563eb', textDecoration: 'none' }}
                      >
                        {item.most_recent_invoice_number || '-'}
                      </a>
                    </td>
                    <td style={tdStyle}>{formatDateForDisplay(item.most_recent_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyModal && (
        <LineItemHistoryModal
          isOpen={historyModal.isOpen}
          onClose={() => setHistoryModal(null)}
          productCode={historyModal.productCode}
          description={historyModal.description}
          unit={historyModal.unit}
          supplierId={historyModal.supplierId}
          supplierName={historyModal.supplierName}
        />
      )}

      {/* Ingredient Mapping Modal (same as Review.tsx) */}
      {modalItem && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={closeModal}
        >
          <div style={{ background: '#fff', borderRadius: '12px', padding: '1.5rem', width: '650px', maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Ingredient Mapping</h3>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#666' }}>&times;</button>
            </div>

            {/* Line item context */}
            <div style={{ padding: '0.75rem', background: '#f8f9fa', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.9rem' }}>
              <strong>{modalItem.description || modalItem.product_code || 'Unknown item'}</strong>
              {modalItem.supplier_name && <span style={{ marginLeft: '0.75rem', color: '#666' }}>({modalItem.supplier_name})</span>}
              {modalItem.most_recent_price != null && <span style={{ marginLeft: '0.75rem', color: '#666' }}>£{Number(modalItem.most_recent_price).toFixed(2)}</span>}
            </div>

            {/* Ingredient mapping section */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontWeight: 600, fontSize: '0.9rem', display: 'block', marginBottom: '0.5rem' }}>
                Ingredient {selectedIngredientId && <span style={{ color: '#28a745', fontWeight: 'normal' }}>({selectedIngredientName})</span>}
              </label>

              {selectedIngredientId ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', background: '#d4edda', borderRadius: '6px', border: '1px solid #c3e6cb' }}>
                  <span style={{ flex: 1 }}>{selectedIngredientName} <span style={{ color: '#666', fontSize: '0.85rem' }}>({selectedIngredientUnit})</span></span>
                  <button
                    onClick={() => { setSelectedIngredientId(null); setSelectedIngredientName(''); setSelectedIngredientUnit(''); setConversionDisplay('') }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', fontSize: '1.1rem' }}
                  >&times;</button>
                </div>
              ) : (
                <>
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text"
                      value={ingredientSearch}
                      onChange={(e) => { setIngredientSearch(e.target.value); searchIngredients(e.target.value) }}
                      placeholder="Search ingredients..."
                      style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '14px', width: '100%', boxSizing: 'border-box' }}
                    />
                    {ingredientSearchLoading && <span style={{ position: 'absolute', right: '10px', top: '10px', color: '#999' }}>...</span>}
                  </div>

                  {ingredientSuggestions.length > 0 && (
                    <div style={{ border: '1px solid #ddd', borderRadius: '0 0 6px 6px', maxHeight: '200px', overflowY: 'auto', background: '#fff' }}>
                      {ingredientSuggestions.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => selectIngredient(s)}
                          style={{ padding: '0.5rem 0.75rem', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: '0.9rem', display: 'flex', justifyContent: 'space-between' }}
                          onMouseOver={(e) => (e.currentTarget.style.background = '#f0f7ff')}
                          onMouseOut={(e) => (e.currentTarget.style.background = '#fff')}
                        >
                          <span>{s.name} <span style={{ color: '#999', fontSize: '0.8rem' }}>({s.standard_unit})</span></span>
                          <span style={{ color: '#999', fontSize: '0.8rem' }}>{s.category_name || ''} {s.similarity ? `${(s.similarity * 100).toFixed(0)}%` : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() => setShowCreateIngredient(true)}
                    style={{ marginTop: '0.5rem', padding: '0.4rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem' }}
                  >
                    + Create new ingredient
                  </button>
                </>
              )}
            </div>

            {/* Unit conversion fields */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontWeight: 600, fontSize: '0.9rem', display: 'block', marginBottom: '0.25rem' }}>
                {selectedIngredientId ? `How much ${selectedIngredientName} is in this line item?` : 'Unit size & pricing'}
              </label>
              <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '0.5rem' }}>
                {modalItem.description}{modalItem.most_recent_price != null ? ` @ £${Number(modalItem.most_recent_price).toFixed(2)}` : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
                <div>
                  <label style={{ fontSize: '0.8rem', color: '#666', display: 'block' }}>Contains</label>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input
                      type="number" step="0.1"
                      value={costEdits.unit_size || ''}
                      onChange={(e) => { const v = { ...costEdits, unit_size: parseFloat(e.target.value) || null }; setCostEdits(v); updateConversionDisplay(undefined, v) }}
                      onFocus={(e) => e.target.select()}
                      style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '70px', fontSize: '14px' }}
                      placeholder="e.g., 2"
                    />
                    <select
                      value={costEdits.unit_size_type || selectedIngredientUnit || ''}
                      onChange={(e) => { const v = { ...costEdits, unit_size_type: e.target.value || null }; setCostEdits(v); updateConversionDisplay(undefined, v) }}
                      style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '4px', width: '60px', fontSize: '14px' }}
                    >
                      <option value="">--</option>
                      <option value="each">each</option>
                      <option value="g">g</option>
                      <option value="kg">kg</option>
                      <option value="ml">ml</option>
                      <option value="ltr">ltr</option>
                      <option value="oz">oz</option>
                      <option value="cl">cl</option>
                    </select>
                    {selectedIngredientUnit && costEdits.unit_size_type && costEdits.unit_size_type !== selectedIngredientUnit && (
                      <span style={{ fontSize: '0.75rem', color: '#999' }}>→ {selectedIngredientUnit}</span>
                    )}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: '0.8rem', color: '#666', display: 'block' }}>Pack of</label>
                  <input
                    type="number"
                    value={costEdits.pack_quantity || ''}
                    onChange={(e) => { const v = { ...costEdits, pack_quantity: parseInt(e.target.value) || null }; setCostEdits(v); updateConversionDisplay(undefined, v) }}
                    onFocus={(e) => e.target.select()}
                    style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '50px', fontSize: '14px' }}
                    placeholder="1"
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.8rem', color: '#666', display: 'block' }}>Line Price</label>
                  <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                    {costEdits.unit_price ? `£${Number(costEdits.unit_price).toFixed(2)}` : '--'}
                  </span>
                </div>
              </div>
              {conversionDisplay && (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: '#e8f5e9', borderRadius: '6px', fontSize: '0.9rem', color: '#2e7d32', fontWeight: 500 }}>
                  {conversionDisplay}
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={{ padding: '0.5rem 1.25rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={saveMapping}
                disabled={savingMapping}
                style={{ padding: '0.5rem 1.25rem', background: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', opacity: savingMapping ? 0.6 : 1 }}
              >
                {savingMapping ? 'Saving...' : selectedIngredientId ? 'Save & Map Ingredient' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <IngredientModal
        open={showCreateIngredient}
        onClose={() => setShowCreateIngredient(false)}
        onSaved={handleIngredientCreated}
        prePopulateName={ingredientSearch || ''}
        preSelectLineItem={modalItem ? {
          product_code: modalItem.product_code,
          description: modalItem.description,
          supplier_id: modalItem.supplier_id,
          supplier_name: modalItem.supplier_name,
          unit: modalItem.unit,
          most_recent_price: modalItem.most_recent_price != null ? Number(modalItem.most_recent_price) : null,
          total_quantity: modalItem.total_quantity,
          occurrence_count: modalItem.occurrence_count,
          most_recent_invoice_id: modalItem.most_recent_invoice_id,
          most_recent_line_number: modalItem.most_recent_line_number,
          most_recent_pack_quantity: modalItem.most_recent_pack_quantity,
          most_recent_unit_size: modalItem.most_recent_unit_size,
          most_recent_unit_size_type: modalItem.most_recent_unit_size_type,
          ingredient_id: modalItem.ingredient_id,
          ingredient_name: modalItem.ingredient_name,
        } as LineItemResult : null}
      />
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '12px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '14px',
}

const thStyleClickable: React.CSSProperties = {
  ...thStyle,
  cursor: 'pointer',
  userSelect: 'none',
}

const tdStyle: React.CSSProperties = {
  padding: '12px',
  fontSize: '14px',
}
