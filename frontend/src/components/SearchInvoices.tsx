/**
 * Invoice Search Page
 * Search and filter invoices with optional line item content search.
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
  SEARCH_STORAGE_KEYS,
} from '../utils/searchHelpers'

interface InvoiceSearchItem {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  net_total: number | null
  supplier_id: number | null
  supplier_name: string | null
  vendor_name: string | null
  status: string
  document_type: string | null
}

interface GroupSummary {
  name: string
  count: number
  total: number | null
}

interface SearchResponse {
  items: InvoiceSearchItem[]
  total_count: number
  grouped_by: string | null
  groups: GroupSummary[] | null
}

interface Supplier {
  id: number
  name: string
}

const keys = SEARCH_STORAGE_KEYS.invoices

export default function SearchInvoices() {
  const { token } = useAuth()
  const defaultDates = useMemo(() => getDefaultDateRange(), [])

  // Persisted search state
  const [searchInput, setSearchInput] = usePersistedState(keys.query, '')
  const [includeLineItems, setIncludeLineItems] = usePersistedState(keys.includeLineItems, false)
  const [supplierId, setSupplierId] = usePersistedState<string>(keys.supplier, '')
  const [status, setStatus] = usePersistedState<string>(keys.status, '')
  const [dateFrom, setDateFrom] = usePersistedState(keys.dateFrom, defaultDates.from)
  const [dateTo, setDateTo] = usePersistedState(keys.dateTo, defaultDates.to)
  const [groupBy, setGroupBy] = usePersistedState<string>(keys.groupBy, '')
  const [sortColumn, setSortColumn] = usePersistedState<string>(keys.sortColumn, '')
  const [sortDirection, setSortDirection] = usePersistedState<'asc' | 'desc'>(keys.sortDirection, 'asc')

  // Collapsed groups state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Debounce search input for live search
  const debouncedSearch = useDebounce(searchInput, 300)

  // Fetch suppliers for dropdown
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

  // Search invoices
  const { data, isLoading, error } = useQuery<SearchResponse>({
    queryKey: [
      'search-invoices',
      debouncedSearch,
      includeLineItems,
      supplierId,
      status,
      dateFrom,
      dateTo,
      groupBy,
    ],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('q', debouncedSearch)
      if (includeLineItems) params.set('include_line_items', 'true')
      if (supplierId) params.set('supplier_id', supplierId)
      if (status) params.set('status', status)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (groupBy) params.set('group_by', groupBy)
      params.set('limit', '200')

      const res = await fetch(`/api/search/invoices?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Search failed')
      return res.json()
    },
    enabled: !!token,
  })

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
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

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: '#f59e0b',
      processed: '#3b82f6',
      reviewed: '#8b5cf6',
      confirmed: '#22c55e',
    }
    return (
      <span
        style={{
          padding: '2px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          backgroundColor: colors[status] || '#9ca3af',
          color: 'white',
        }}
      >
        {status}
      </span>
    )
  }

  // Helper to get net/gross total, filling in missing values
  const getNetTotal = (inv: InvoiceSearchItem) => {
    if (inv.net_total !== null) return inv.net_total
    if (inv.total !== null) return inv.total // Assume no VAT if net is missing
    return null
  }

  const getGrossTotal = (inv: InvoiceSearchItem) => {
    if (inv.total !== null) return inv.total
    if (inv.net_total !== null) return inv.net_total // Assume no VAT if gross is missing
    return null
  }

  // Sort items
  const sortedItems = useMemo(() => {
    if (!data?.items || !sortColumn) return data?.items || []

    const sorted = [...data.items].sort((a, b) => {
      let aVal: any
      let bVal: any

      switch (sortColumn) {
        case 'invoice_number':
          aVal = a.invoice_number || ''
          bVal = b.invoice_number || ''
          break
        case 'supplier':
          aVal = a.supplier_name || a.vendor_name || ''
          bVal = b.supplier_name || b.vendor_name || ''
          break
        case 'date':
          aVal = a.invoice_date || ''
          bVal = b.invoice_date || ''
          break
        case 'net_total':
          aVal = getNetTotal(a) ?? -Infinity
          bVal = getNetTotal(b) ?? -Infinity
          break
        case 'gross_total':
          aVal = getGrossTotal(a) ?? -Infinity
          bVal = getGrossTotal(b) ?? -Infinity
          break
        case 'status':
          aVal = a.status || ''
          bVal = b.status || ''
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
  }, [data?.items, sortColumn, sortDirection])

  // Group items by the groupBy field
  const groupedItems = useMemo(() => {
    if (!sortedItems || !groupBy || !data?.groups) return null

    const grouped: Record<string, InvoiceSearchItem[]> = {}
    for (const item of sortedItems) {
      let key: string
      if (groupBy === 'supplier') {
        key = item.supplier_name || 'Unknown'
      } else if (groupBy === 'month') {
        key = item.invoice_date?.substring(0, 7) || 'Unknown'
      } else {
        key = 'All'
      }
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(item)
    }
    return grouped
  }, [sortedItems, groupBy, data?.groups])

  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '20px' }}>Search Invoices</h1>

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
          placeholder="Search invoice number, vendor..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{
            flex: '1 1 250px',
            padding: '8px 12px',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            fontSize: '14px',
          }}
        />

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={includeLineItems}
            onChange={(e) => setIncludeLineItems(e.target.checked)}
          />
          Include line items
        </label>

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
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="processed">Processed</option>
          <option value="reviewed">Reviewed</option>
          <option value="confirmed">Confirmed</option>
        </select>

        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">No Grouping</option>
          <option value="supplier">Group by Supplier</option>
          <option value="month">Group by Month</option>
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
      </div>

      {/* Results */}
      {isLoading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>Error: {(error as Error).message}</p>}

      {data && (
        <div>
          <p style={{ marginBottom: '12px', color: '#6b7280' }}>
            Found {data.total_count} invoice{data.total_count !== 1 ? 's' : ''}
          </p>

          {groupBy && data.groups ? (
            // Grouped view
            <div>
              {data.groups.map((group) => (
                <div
                  key={group.name}
                  style={{
                    marginBottom: '16px',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    onClick={() => toggleGroup(group.name)}
                    style={{
                      padding: '12px 16px',
                      backgroundColor: '#f1f5f9',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {collapsedGroups.has(group.name) ? '▸' : '▾'} {group.name}
                    </span>
                    <span style={{ color: '#6b7280' }}>
                      {group.count} invoice{group.count !== 1 ? 's' : ''}
                      {group.total !== null && ` • ${formatCurrency(group.total)}`}
                    </span>
                  </div>
                  {!collapsedGroups.has(group.name) && groupedItems?.[group.name] && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f8fafc' }}>
                          <th style={thStyleClickable} onClick={() => handleSort('invoice_number')}>
                            Invoice #{getSortIndicator('invoice_number')}
                          </th>
                          <th style={thStyleClickable} onClick={() => handleSort('supplier')}>
                            Supplier{getSortIndicator('supplier')}
                          </th>
                          <th style={thStyleClickable} onClick={() => handleSort('date')}>
                            Date{getSortIndicator('date')}
                          </th>
                          <th style={thStyleClickable} onClick={() => handleSort('net_total')}>
                            Net Total{getSortIndicator('net_total')}
                          </th>
                          <th style={thStyleClickable} onClick={() => handleSort('gross_total')}>
                            Gross Total{getSortIndicator('gross_total')}
                          </th>
                          <th style={thStyleClickable} onClick={() => handleSort('status')}>
                            Status{getSortIndicator('status')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupedItems[group.name].map((inv) => (
                          <tr key={inv.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                            <td style={tdStyle}>
                              <a
                                href={`/invoice/${inv.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: '#2563eb', textDecoration: 'none' }}
                              >
                                {inv.invoice_number || '-'}
                              </a>
                            </td>
                            <td style={tdStyle}>{inv.supplier_name || inv.vendor_name || '-'}</td>
                            <td style={tdStyle}>{formatDateForDisplay(inv.invoice_date)}</td>
                            <td style={tdStyle}>{formatCurrency(getNetTotal(inv))}</td>
                            <td style={tdStyle}>{formatCurrency(getGrossTotal(inv))}</td>
                            <td style={tdStyle}>{getStatusBadge(inv.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          ) : (
            // Flat table view
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#f1f5f9' }}>
                  <th style={thStyleClickable} onClick={() => handleSort('invoice_number')}>
                    Invoice #{getSortIndicator('invoice_number')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('supplier')}>
                    Supplier{getSortIndicator('supplier')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('date')}>
                    Date{getSortIndicator('date')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('net_total')}>
                    Net Total{getSortIndicator('net_total')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('gross_total')}>
                    Gross Total{getSortIndicator('gross_total')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('status')}>
                    Status{getSortIndicator('status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((inv) => (
                  <tr key={inv.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={tdStyle}>
                      <a
                        href={`/invoice/${inv.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#2563eb', textDecoration: 'none' }}
                      >
                        {inv.invoice_number || '-'}
                      </a>
                    </td>
                    <td style={tdStyle}>{inv.supplier_name || inv.vendor_name || '-'}</td>
                    <td style={tdStyle}>{formatDateForDisplay(inv.invoice_date)}</td>
                    <td style={tdStyle}>{formatCurrency(getNetTotal(inv))}</td>
                    <td style={tdStyle}>{formatCurrency(getGrossTotal(inv))}</td>
                    <td style={tdStyle}>{getStatusBadge(inv.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
