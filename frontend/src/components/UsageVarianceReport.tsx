import { useState } from 'react'
import { useAuth } from '../App'

// ============ Types ============

interface UsageVarianceItem {
  ingredient_id: number
  ingredient_name: string
  category: string | null
  standard_unit: string
  theoretical_qty: number
  theoretical_value: number
  dishes_using: number
  actual_qty: number | null
  actual_value: number | null
  invoice_count: number
  variance_qty: number | null
  variance_pct: number | null
  variance_value: number | null
}

interface UnmappedSaleItem {
  menu_item_name: string
  portion_name: string
  total_qty: number
  category: string | null
}

interface UsageVarianceResponse {
  from_date: string
  to_date: string
  items: UsageVarianceItem[]
  total_theoretical_value: number
  total_actual_value: number
  total_variance_value: number
  mapped_dish_count: number
  unmapped_dish_count: number
  ingredients_with_purchases: number
  ingredients_without_purchases: number
  unmapped_sales: UnmappedSaleItem[]
}

// ============ Helpers ============

function fmtQty(qty: number, unit: string): string {
  if (unit === 'g' && Math.abs(qty) >= 1000) return `${(qty / 1000).toFixed(2)} kg`
  if (unit === 'ml' && Math.abs(qty) >= 1000) return `${(qty / 1000).toFixed(2)} ltr`
  if (unit === 'g') return `${qty.toFixed(0)} g`
  if (unit === 'ml') return `${qty.toFixed(0)} ml`
  if (unit === 'kg') return `${qty.toFixed(2)} kg`
  if (unit === 'ltr') return `${qty.toFixed(2)} ltr`
  if (unit === 'each') return `${qty.toFixed(1)}`
  return `${qty.toFixed(2)} ${unit}`
}

function fmt(val: number | null | undefined): string {
  if (val == null) return '—'
  return `£${Number(val).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(val: number | null | undefined): string {
  if (val == null) return '—'
  const v = Number(val)
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}

function varianceColor(pct: number | null, absVal: number | null): string {
  if (pct == null && absVal == null) return '#666'
  const absPct = Math.abs(pct ?? 0)
  const absValue = Math.abs(absVal ?? 0)
  if (absPct > 50 || absValue > 50) return '#dc2626'  // red
  if (absPct > 15 || absValue > 15) return '#d97706'   // amber
  return '#16a34a'  // green
}

function varianceBg(pct: number | null, absVal: number | null): string {
  if (pct == null && absVal == null) return 'transparent'
  const absPct = Math.abs(pct ?? 0)
  const absValue = Math.abs(absVal ?? 0)
  if (absPct > 50 || absValue > 50) return '#fef2f2'
  if (absPct > 15 || absValue > 15) return '#fffbeb'
  return 'transparent'
}

// ============ Component ============

type SortKey = 'variance_value' | 'variance_pct' | 'name'

export default function UsageVarianceReport() {
  const { token } = useAuth()

  const today = new Date().toISOString().slice(0, 10)
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const [fromDate, setFromDate] = useState(monthAgo)
  const [toDate, setToDate] = useState(today)
  const [result, setResult] = useState<UsageVarianceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('variance_value')
  const [unmappedCollapsed, setUnmappedCollapsed] = useState(true)

  const fetchReport = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/reports/usage-variance?from_date=${fromDate}&to_date=${toDate}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Request failed' }))
        throw new Error(err.detail || 'Request failed')
      }
      const data: UsageVarianceResponse = await res.json()
      setResult(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  // Filter + sort items
  let items = result?.items ?? []
  if (search) {
    const s = search.toLowerCase()
    items = items.filter(i => i.ingredient_name.toLowerCase().includes(s) || (i.category || '').toLowerCase().includes(s))
  }
  if (!showAll) {
    items = items.filter(i => Math.abs(i.variance_pct ?? 0) > 10 || Math.abs(i.variance_value ?? 0) > 5)
  }
  items = [...items].sort((a, b) => {
    if (sortKey === 'name') return a.ingredient_name.localeCompare(b.ingredient_name)
    if (sortKey === 'variance_pct') return Math.abs(b.variance_pct ?? 0) - Math.abs(a.variance_pct ?? 0)
    return Math.abs(b.variance_value ?? 0) - Math.abs(a.variance_value ?? 0)
  })

  const r = result

  return (
    <div style={styles.container}>
      <h2 style={styles.pageTitle}>Theoretical vs Actual Usage</h2>

      {/* Date range selector */}
      <div style={styles.dateBar}>
        <label style={styles.dateLabel}>
          From
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={styles.dateInput} />
        </label>
        <label style={styles.dateLabel}>
          To
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={styles.dateInput} />
        </label>
        <button onClick={fetchReport} disabled={loading} style={styles.generateBtn}>
          {loading ? 'Loading...' : 'Generate'}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {r && (
        <>
          {/* Summary banner */}
          <div style={styles.summaryBar}>
            <div style={styles.summaryPeriod}>
              {formatDate(r.from_date)} – {formatDate(r.to_date)}
            </div>
            <div style={styles.summaryGrid}>
              <div style={styles.summaryItem}>
                <div style={styles.summaryLabel}>Theoretical Cost</div>
                <div style={styles.summaryValue}>{fmt(r.total_theoretical_value)}</div>
              </div>
              <div style={styles.summaryItem}>
                <div style={styles.summaryLabel}>Actual Purchased</div>
                <div style={styles.summaryValue}>{fmt(r.total_actual_value)}</div>
              </div>
              <div style={styles.summaryItem}>
                <div style={styles.summaryLabel}>Variance</div>
                <div style={{
                  ...styles.summaryValue,
                  color: r.total_variance_value > 50 ? '#f87171' : r.total_variance_value < -50 ? '#fbbf24' : '#4ade80',
                }}>
                  {fmt(r.total_variance_value)}
                </div>
              </div>
            </div>
            <div style={styles.summaryCounts}>
              <span style={styles.countBadgeGreen}>{r.mapped_dish_count} dishes mapped</span>
              {r.unmapped_dish_count > 0 && (
                <span style={styles.countBadgeAmber}>{r.unmapped_dish_count} unmapped</span>
              )}
              <span style={styles.countBadgeBlue}>{r.ingredients_with_purchases} ingredients with purchases</span>
              {r.ingredients_without_purchases > 0 && (
                <span style={styles.countBadgeBlue}>{r.ingredients_without_purchases} theoretical only</span>
              )}
            </div>
            <div style={styles.footnote}>
              Variance = Actual - Theoretical. Positive = over-purchased. This report estimates usage from recipes and may not account for stock carried forward, staff meals, or wastage.
            </div>
          </div>

          {/* Controls */}
          <div style={styles.controlsBar}>
            <input
              type="text"
              placeholder="Search ingredient..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            <label style={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={!showAll}
                onChange={e => setShowAll(!e.target.checked)}
              />
              {' '}Variances only
            </label>
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              style={styles.sortSelect}
            >
              <option value="variance_value">Sort: Variance £</option>
              <option value="variance_pct">Sort: Variance %</option>
              <option value="name">Sort: Name</option>
            </select>
          </div>

          {/* Main table */}
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Ingredient</th>
                  <th style={styles.th}>Category</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Theo. Qty</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Theo. £</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Actual Qty</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Actual £</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Variance £</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Variance %</th>
                  <th style={{ ...styles.th, textAlign: 'center' }}>Dishes</th>
                  <th style={{ ...styles.th, textAlign: 'center' }}>Invoices</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const bg = varianceBg(item.variance_pct, item.variance_value)
                  const vc = varianceColor(item.variance_pct, item.variance_value)
                  return (
                    <tr key={item.ingredient_id} style={{ ...styles.tr, background: bg }}>
                      <td style={styles.td}>
                        <span style={{ fontWeight: 600 }}>{item.ingredient_name}</span>
                      </td>
                      <td style={{ ...styles.td, color: '#888', fontSize: '0.8rem' }}>
                        {item.category || '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {item.theoretical_qty > 0 ? fmtQty(item.theoretical_qty, item.standard_unit) : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {item.theoretical_value > 0 ? fmt(item.theoretical_value) : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}
                        title={item.actual_qty == null ? 'No mapped purchases in period' : undefined}
                      >
                        {item.actual_qty != null ? fmtQty(item.actual_qty, item.standard_unit) : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {item.actual_value != null ? fmt(item.actual_value) : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, color: vc }}>
                        {item.variance_value != null ? fmt(item.variance_value) : '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, color: vc }}>
                        {fmtPct(item.variance_pct)}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center', color: '#888', fontSize: '0.8rem' }}>
                        {item.dishes_using}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center', color: '#888', fontSize: '0.8rem' }}>
                        {item.invoice_count || '—'}
                      </td>
                    </tr>
                  )
                })}
                {items.length === 0 && (
                  <tr><td colSpan={10} style={{ ...styles.td, textAlign: 'center', color: '#999' }}>
                    {search || !showAll ? 'No items match filters.' : 'No data.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Unmapped sales */}
          {r.unmapped_sales.length > 0 && (
            <div style={styles.section}>
              <div
                style={styles.sectionHeader}
                onClick={() => setUnmappedCollapsed(!unmappedCollapsed)}
              >
                <span>
                  <span style={styles.collapseIcon}>{unmappedCollapsed ? '▸' : '▾'}</span>
                  Unmapped Sales Items ({r.unmapped_sales.length}) — no recipe, can't calculate theoretical usage
                </span>
              </div>
              {!unmappedCollapsed && (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Menu Item</th>
                      <th style={styles.th}>Portion</th>
                      <th style={styles.th}>Category</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Qty Sold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.unmapped_sales.map((u, idx) => (
                      <tr key={idx} style={styles.tr}>
                        <td style={styles.td}>{u.menu_item_name}</td>
                        <td style={{ ...styles.td, color: '#888' }}>
                          {u.portion_name !== 'Normal' ? u.portion_name : '—'}
                        </td>
                        <td style={{ ...styles.td, color: '#888' }}>{u.category || '—'}</td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>{u.total_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ============ Styles ============

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: '1200px', margin: '0 auto', padding: '1.5rem' },
  pageTitle: { fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' },

  // Date bar
  dateBar: { display: 'flex', gap: '1rem', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap' as const },
  dateLabel: { fontSize: '0.8rem', fontWeight: 600, color: '#666', display: 'flex', flexDirection: 'column' as const, gap: '0.25rem' },
  dateInput: { padding: '0.4rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontSize: '0.85rem' },
  generateBtn: {
    padding: '0.45rem 1.2rem', background: '#e94560', color: 'white', border: 'none',
    borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem',
  },
  error: { padding: '1rem', color: '#dc3545', background: '#fde8e8', borderRadius: '6px', marginBottom: '1rem' },

  // Summary bar
  summaryBar: {
    background: '#1a1a2e', color: 'white', padding: '1.25rem', borderRadius: '10px', marginBottom: '1.5rem',
  },
  summaryPeriod: { fontSize: '0.85rem', color: '#aaa', marginBottom: '0.75rem' },
  summaryGrid: { display: 'flex', gap: '2rem', marginBottom: '0.75rem', flexWrap: 'wrap' as const },
  summaryItem: {},
  summaryLabel: { fontSize: '0.7rem', textTransform: 'uppercase' as const, color: '#888', fontWeight: 600 },
  summaryValue: { fontSize: '1.3rem', fontWeight: 700 },
  summaryCounts: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap' as const, marginTop: '0.5rem' },
  countBadgeGreen: { fontSize: '0.8rem', background: 'rgba(22,163,74,0.2)', color: '#4ade80', padding: '0.2rem 0.6rem', borderRadius: '4px' },
  countBadgeAmber: { fontSize: '0.8rem', background: 'rgba(245,158,11,0.2)', color: '#fbbf24', padding: '0.2rem 0.6rem', borderRadius: '4px' },
  countBadgeBlue: { fontSize: '0.8rem', background: 'rgba(59,130,246,0.2)', color: '#60a5fa', padding: '0.2rem 0.6rem', borderRadius: '4px' },
  footnote: { fontSize: '0.72rem', color: '#777', marginTop: '0.75rem', fontStyle: 'italic' as const, lineHeight: 1.5 },

  // Controls
  controlsBar: {
    display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' as const,
  },
  searchInput: {
    padding: '0.4rem 0.6rem', border: '1px solid #ccc', borderRadius: '4px', fontSize: '0.85rem', width: '200px',
  },
  toggleLabel: { fontSize: '0.85rem', color: '#555', cursor: 'pointer', userSelect: 'none' as const },
  sortSelect: {
    padding: '0.35rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontSize: '0.8rem', color: '#555',
  },

  // Table
  tableWrap: { overflowX: 'auto' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: {
    padding: '0.5rem 0.75rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0',
    fontSize: '0.72rem', fontWeight: 600, color: '#666', background: '#fafafa',
    whiteSpace: 'nowrap' as const,
  },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.4rem 0.75rem', fontSize: '0.83rem', whiteSpace: 'nowrap' as const },

  // Unmapped section
  section: {
    marginTop: '1.5rem', border: '1px solid #e0e0e0', borderRadius: '8px', overflow: 'hidden',
  },
  sectionHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '0.75rem 1rem', background: '#f8f9fa', cursor: 'pointer',
    fontWeight: 600, fontSize: '0.9rem', color: '#888',
  },
  collapseIcon: { marginRight: '0.5rem', fontSize: '0.85rem' },
}
