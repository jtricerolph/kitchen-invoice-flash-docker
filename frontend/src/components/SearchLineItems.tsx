/**
 * Line Items Search Page
 * Search consolidated line items with price change detection.
 */
import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'
import {
  useDebounce,
  usePersistedState,
  getDefaultDateRange,
  formatDateForDisplay,
  formatCurrency,
  formatPercent,
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

const keys = SEARCH_STORAGE_KEYS.lineItems

export default function SearchLineItems() {
  const { token } = useAuth()
  const defaultDates = useMemo(() => getDefaultDateRange(), [])

  // Persisted search state
  const [searchInput, setSearchInput] = usePersistedState(keys.query, '')
  const [supplierId, setSupplierId] = usePersistedState<string>(keys.supplier, '')
  const [dateFrom, setDateFrom] = usePersistedState(keys.dateFrom, defaultDates.from)
  const [dateTo, setDateTo] = usePersistedState(keys.dateTo, defaultDates.to)
  const [groupBy, setGroupBy] = usePersistedState<string>(keys.groupBy, '')
  const [priceChangeFilter, setPriceChangeFilter] = usePersistedState<string>(keys.priceChangeFilter, '')
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

  // Search line items
  const { data, isLoading, error } = useQuery<SearchResponse>({
    queryKey: ['search-line-items', debouncedSearch, supplierId, dateFrom, dateTo, groupBy],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('q', debouncedSearch)
      if (supplierId) params.set('supplier_id', supplierId)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (groupBy) params.set('group_by', groupBy)
      params.set('limit', '200')

      const res = await fetch(`/api/search/line-items?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Search failed')
      return res.json()
    },
    enabled: !!token,
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
      if (priceChangeFilter === 'amber_or_red') {
        return item.price_change_status === 'amber' || item.price_change_status === 'red'
      } else if (priceChangeFilter === 'amber') {
        return item.price_change_status === 'amber'
      } else if (priceChangeFilter === 'red') {
        return item.price_change_status === 'red'
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
        case 'portion_cost':
          aVal = (a.portions_per_unit && a.pack_quantity && a.most_recent_price)
            ? (typeof a.most_recent_price === 'string' ? parseFloat(a.most_recent_price) : a.most_recent_price) / (a.pack_quantity * a.portions_per_unit)
            : -Infinity
          bVal = (b.portions_per_unit && b.pack_quantity && b.most_recent_price)
            ? (typeof b.most_recent_price === 'string' ? parseFloat(b.most_recent_price) : b.most_recent_price) / (b.pack_quantity * b.portions_per_unit)
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
    if (!config.icon || !item.price_change_percent) return null

    const isIncrease = item.price_change_percent > 0
    const arrow = isIncrease ? '▲' : '▼'
    const color = isIncrease ? '#ef4444' : '#22c55e' // Red for increase, green for decrease

    return (
      <div style={{ fontSize: '0.75rem', marginTop: '2px', color }}>
        <span style={{ fontWeight: 'bold' }}>{arrow}</span>{' '}
        {Math.abs(item.price_change_percent).toFixed(1)}%
      </div>
    )
  }

  const clearSearch = () => {
    setSearchInput('')
    setSupplierId('')
    setPriceChangeFilter('')
    setGroupBy('')
    const defaultDates = getDefaultDateRange()
    setDateFrom(defaultDates.from)
    setDateTo(defaultDates.to)
  }

  const hasActiveFilters = searchInput || supplierId || priceChangeFilter || groupBy

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
          <option value="amber_or_red">⚠️ Amber or Red Only</option>
          <option value="amber">? Amber Only</option>
          <option value="red">! Red Only</option>
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
        }}
      >
        <span>
          <span style={{ color: '#22c55e', fontWeight: 'bold' }}>✓</span> Price consistent
        </span>
        <span>
          <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>?</span> Price changed
        </span>
        <span>
          <span style={{ color: '#ef4444', fontWeight: 'bold' }}>!</span> Large change (&gt;20%)
        </span>
        <span>
          <span style={{ color: '#8b5cf6' }}>📦</span> Has portions defined
        </span>
      </div>

      {/* Results */}
      {isLoading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>Error: {(error as Error).message}</p>}

      {data && (
        <div>
          <p style={{ marginBottom: '12px', color: '#6b7280' }}>
            Found {data.total_count} unique item{data.total_count !== 1 ? 's' : ''}
            {priceChangeFilter && ` (showing ${sortedItems.length} with price changes)`}
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
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
                  <th style={{ ...thStyleClickable, textAlign: 'right' }} onClick={() => handleSort('portion_cost')}>
                    Portion Cost{getSortIndicator('portion_cost')}
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
                      {item.description || '-'}
                      {item.has_definition && (
                        <span
                          title={`${item.portions_per_unit || '?'} portions per unit`}
                          style={{ marginLeft: '6px', color: '#8b5cf6' }}
                        >
                          📦
                        </span>
                      )}
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
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      {item.portions_per_unit && item.pack_quantity && item.most_recent_price ? (
                        <span style={{ color: '#16a34a', fontWeight: 600 }}>
                          {formatCurrency(
                            (typeof item.most_recent_price === 'string'
                              ? parseFloat(item.most_recent_price)
                              : item.most_recent_price) / (item.pack_quantity * item.portions_per_unit)
                          )}
                        </span>
                      ) : (
                        '-'
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
