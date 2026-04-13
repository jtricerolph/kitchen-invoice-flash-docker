import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

interface SalesGPItem {
  menu_item_name: string
  portion_name: string
  category: string
  total_qty: number
  total_revenue_net: number
  recipe_id: number | null
  recipe_name: string | null
  dish_course: string | null
  cost_per_portion: number | null
  total_cost: number | null
  item_gp_percent: number | null
}

interface SalesGPCourseGroup {
  course_name: string
  items: SalesGPItem[]
  course_revenue: number
  course_cost: number
  course_gp_percent: number | null
}

interface SalesGPResponse {
  from_date: string
  to_date: string
  courses: SalesGPCourseGroup[]
  unmapped_items: SalesGPItem[]
  mapped_revenue_net: number
  mapped_total_cost: number
  mapped_gp_percent: number | null
  total_all_revenue_net: number
  unmapped_revenue_net: number
  mapped_revenue_percent: number
  mapped_item_count: number
  unmapped_item_count: number
}

interface DishRecipe {
  id: number
  name: string
  menu_section_name: string | null
  cost_per_portion: number | null
  kds_menu_item_name: string | null
  sambapos_portion_name: string | null
}

export default function SalesGPReport() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Date range
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const [fromDate, setFromDate] = useState(weekAgo)
  const [toDate, setToDate] = useState(today)
  const [submitted, setSubmitted] = useState(false)
  const [submittedFrom, setSubmittedFrom] = useState(weekAgo)
  const [submittedTo, setSubmittedTo] = useState(today)

  // Collapsed courses
  const [collapsedCourses, setCollapsedCourses] = useState<Set<string>>(new Set())

  // Mapping modal
  const [mappingItem, setMappingItem] = useState<SalesGPItem | null>(null)
  const [recipeSearch, setRecipeSearch] = useState('')

  // Fetch report data
  const { data: report, isLoading, error } = useQuery<SalesGPResponse>({
    queryKey: ['sales-gp', submittedFrom, submittedTo],
    queryFn: async () => {
      const res = await fetch(`/api/reports/sales-gp?from_date=${submittedFrom}&to_date=${submittedTo}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Request failed' }))
        throw new Error(err.detail || 'Request failed')
      }
      return res.json()
    },
    enabled: !!token && submitted,
  })

  // Fetch dish recipes for mapping modal
  const { data: dishRecipes } = useQuery<DishRecipe[]>({
    queryKey: ['recipes-for-mapping', recipeSearch],
    queryFn: async () => {
      const url = `/api/recipes?recipe_type=dish${recipeSearch ? `&search=${encodeURIComponent(recipeSearch)}` : ''}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      return res.json()
    },
    enabled: !!token && !!mappingItem,
  })

  // Map unmapped item to recipe
  const mapMutation = useMutation({
    mutationFn: async ({ recipeId, menuItemName, portionName }: { recipeId: number; menuItemName: string; portionName: string }) => {
      const res = await fetch(`/api/recipes/${recipeId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kds_menu_item_name: menuItemName,
          sambapos_portion_name: portionName === 'Normal' ? null : portionName,
        }),
      })
      if (!res.ok) throw new Error('Failed to update recipe')
    },
    onSuccess: () => {
      setMappingItem(null)
      setRecipeSearch('')
      queryClient.invalidateQueries({ queryKey: ['sales-gp'] })
    },
  })

  const handleGenerate = () => {
    setSubmittedFrom(fromDate)
    setSubmittedTo(toDate)
    setSubmitted(true)
  }

  const toggleCourse = (name: string) => {
    setCollapsedCourses(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const fmt = (n: number) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtPct = (n: number | null) => n != null ? `${Number(n).toFixed(1)}%` : '—'

  const gpColor = (pct: number | null) => {
    if (pct == null) return '#888'
    if (pct >= 70) return '#16a34a'
    if (pct >= 60) return '#ca8a04'
    return '#dc2626'
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.pageTitle}>Sales GP% Report</h2>

      {/* Date range selector */}
      <div style={styles.dateBar}>
        <div style={styles.dateGroup}>
          <label style={styles.dateLabel}>From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={styles.dateInput} />
        </div>
        <div style={styles.dateGroup}>
          <label style={styles.dateLabel}>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={styles.dateInput} />
        </div>
        <button onClick={handleGenerate} style={styles.generateBtn}>Generate</button>
      </div>

      {isLoading && <div style={styles.loading}>Loading sales data from SambaPOS...</div>}
      {error && <div style={styles.error}>{(error as Error).message}</div>}

      {report && (
        <>
          {/* Summary banner */}
          <div style={styles.summaryBanner}>
            <div style={styles.summaryMain}>
              <div style={styles.summaryLabel}>Estimated Sales GP%</div>
              <div style={{ ...styles.summaryValue, color: gpColor(report.mapped_gp_percent) }}>
                {fmtPct(report.mapped_gp_percent)}
              </div>
              <div style={styles.summarySubtext}>mapped items only</div>
            </div>
            <div style={styles.summaryStats}>
              <div style={styles.statBox}>
                <div style={styles.statLabel}>Mapped Revenue</div>
                <div style={styles.statValue}>&pound;{fmt(report.mapped_revenue_net)}</div>
              </div>
              <div style={styles.statBox}>
                <div style={styles.statLabel}>Mapped Cost</div>
                <div style={styles.statValue}>&pound;{fmt(report.mapped_total_cost)}</div>
              </div>
              <div style={styles.statBox}>
                <div style={styles.statLabel}>Total Revenue</div>
                <div style={styles.statValue}>&pound;{fmt(report.total_all_revenue_net)}</div>
              </div>
            </div>
            {/* Coverage bar */}
            <div style={styles.coverageSection}>
              <div style={styles.coverageLabel}>
                Coverage: {Number(report.mapped_revenue_percent).toFixed(1)}% of food sales revenue is costed
                <span style={{ color: '#888', marginLeft: '0.5rem' }}>
                  ({report.mapped_item_count} mapped, {report.unmapped_item_count} unmapped)
                </span>
              </div>
              <div style={styles.coverageBarBg}>
                <div style={{ ...styles.coverageBarFill, width: `${Math.min(Number(report.mapped_revenue_percent), 100)}%` }} />
              </div>
            </div>
          </div>

          {/* Course sections */}
          {report.courses.map(course => (
            <div key={course.course_name} style={styles.courseSection}>
              <div style={styles.courseHeader} onClick={() => toggleCourse(course.course_name)}>
                <div style={styles.courseTitle}>
                  <span style={styles.collapseIcon}>{collapsedCourses.has(course.course_name) ? '▸' : '▾'}</span>
                  {course.course_name}
                </div>
                <div style={styles.courseStats}>
                  <span style={{ marginRight: '1.5rem' }}>Revenue: &pound;{fmt(course.course_revenue)}</span>
                  <span style={{ marginRight: '1.5rem' }}>Cost: &pound;{fmt(course.course_cost)}</span>
                  <span style={{ fontWeight: 700, color: gpColor(course.course_gp_percent) }}>
                    GP: {fmtPct(course.course_gp_percent)}
                  </span>
                </div>
              </div>
              {!collapsedCourses.has(course.course_name) && (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Item</th>
                      <th style={styles.th}>Portion</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Qty</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Net Revenue</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Cost/Portion</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Total Cost</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>GP%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {course.items.map((item, idx) => (
                      <tr key={idx} style={styles.tr}>
                        <td style={styles.td}>
                          {item.recipe_id ? (
                            <span
                              title={`Recipe: ${item.recipe_name}`}
                              onClick={() => navigate(`/dishes/${item.recipe_id}`)}
                              style={{ cursor: 'pointer', color: '#3b82f6', textDecoration: 'underline dotted', textUnderlineOffset: '3px' }}
                            >{item.menu_item_name}</span>
                          ) : item.menu_item_name}
                        </td>
                        <td style={{ ...styles.td, color: item.portion_name === 'Normal' ? '#ccc' : '#555' }}>
                          {item.portion_name === 'Normal' ? '—' : item.portion_name}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>{item.total_qty}</td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>&pound;{fmt(item.total_revenue_net)}</td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>
                          {item.cost_per_portion != null ? `\u00A3${fmt(item.cost_per_portion)}` : '—'}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right' }}>
                          {item.total_cost != null ? `\u00A3${fmt(item.total_cost)}` : '—'}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, color: gpColor(item.item_gp_percent) }}>
                          {fmtPct(item.item_gp_percent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          {/* Unmapped items section */}
          {report.unmapped_items.length > 0 && (
            <div style={styles.unmappedSection}>
              <div style={styles.unmappedHeader}>
                <span>Unmapped Items</span>
                <span style={styles.unmappedSubtext}>
                  &pound;{fmt(report.unmapped_revenue_net)} unmapped ({(100 - Number(report.mapped_revenue_percent)).toFixed(1)}% of sales)
                </span>
              </div>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Item</th>
                    <th style={styles.th}>Portion</th>
                    <th style={styles.th}>Category</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Qty</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Net Revenue</th>
                    <th style={{ ...styles.th, textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {report.unmapped_items.map((item, idx) => (
                    <tr key={idx} style={styles.tr}>
                      <td style={styles.td}>{item.menu_item_name}</td>
                      <td style={{ ...styles.td, color: item.portion_name === 'Normal' ? '#ccc' : '#555' }}>
                        {item.portion_name === 'Normal' ? '—' : item.portion_name}
                      </td>
                      <td style={{ ...styles.td, color: '#888' }}>{item.category}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{item.total_qty}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>&pound;{fmt(item.total_revenue_net)}</td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <button
                          onClick={() => { setMappingItem(item); setRecipeSearch('') }}
                          style={styles.mapBtn}
                        >Map</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Recipe mapping modal */}
      {mappingItem && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>
                Map: {mappingItem.menu_item_name}
                {mappingItem.portion_name !== 'Normal' && ` (${mappingItem.portion_name})`}
              </h3>
              <button onClick={() => { setMappingItem(null); setRecipeSearch('') }} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <input
                value={recipeSearch}
                onChange={(e) => setRecipeSearch(e.target.value)}
                style={{ ...styles.searchInput, marginBottom: '0.75rem' }}
                placeholder="Search dish recipes..."
                autoFocus
              />
              {!dishRecipes ? (
                <div style={{ color: '#888', textAlign: 'center', padding: '1rem' }}>Loading recipes...</div>
              ) : dishRecipes.length === 0 ? (
                <div style={{ color: '#888', textAlign: 'center', padding: '1rem' }}>No dish recipes found.</div>
              ) : (
                <div style={{ maxHeight: '350px', overflow: 'auto' }}>
                  {dishRecipes.map(r => (
                    <div
                      key={r.id}
                      onClick={() => mapMutation.mutate({
                        recipeId: r.id,
                        menuItemName: mappingItem.menu_item_name,
                        portionName: mappingItem.portion_name,
                      })}
                      style={styles.recipeRow}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f7ff')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        <div style={{ fontSize: '0.75rem', color: '#888' }}>
                          {r.menu_section_name || 'No course'}
                          {r.cost_per_portion != null && ` \u2022 Cost: \u00A3${Number(r.cost_per_portion).toFixed(2)}`}
                        </div>
                      </div>
                      {r.kds_menu_item_name && (
                        <div style={{ fontSize: '0.7rem', color: '#999' }}>
                          Already mapped: {r.kds_menu_item_name}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' },
  pageTitle: { fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' },
  dateBar: { display: 'flex', gap: '1rem', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap' },
  dateGroup: { display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  dateLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#666' },
  dateInput: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem' },
  generateBtn: { padding: '0.5rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' },
  loading: { padding: '2rem', textAlign: 'center', color: '#888' },
  error: { padding: '1rem', color: '#dc3545', background: '#fde8e8', borderRadius: '6px', marginBottom: '1rem' },

  // Summary
  summaryBanner: { background: '#f8f9fa', padding: '1.25rem', borderRadius: '8px', border: '2px solid #e0e0e0', marginBottom: '1.5rem' },
  summaryMain: { textAlign: 'center', marginBottom: '1rem' },
  summaryLabel: { fontSize: '0.85rem', fontWeight: 600, color: '#666', textTransform: 'uppercase' },
  summaryValue: { fontSize: '2.5rem', fontWeight: 800, lineHeight: 1.2 },
  summarySubtext: { fontSize: '0.75rem', color: '#999' },
  summaryStats: { display: 'flex', justifyContent: 'center', gap: '2rem', marginBottom: '1rem', flexWrap: 'wrap' },
  statBox: { textAlign: 'center' },
  statLabel: { fontSize: '0.75rem', color: '#666', fontWeight: 600 },
  statValue: { fontSize: '1.1rem', fontWeight: 700 },
  coverageSection: { borderTop: '1px solid #e0e0e0', paddingTop: '0.75rem' },
  coverageLabel: { fontSize: '0.8rem', color: '#555', marginBottom: '0.4rem' },
  coverageBarBg: { height: '8px', background: '#e0e0e0', borderRadius: '4px', overflow: 'hidden' },
  coverageBarFill: { height: '100%', background: '#16a34a', borderRadius: '4px', transition: 'width 0.3s' },

  // Course sections
  courseSection: { marginBottom: '1rem', border: '1px solid #e0e0e0', borderRadius: '8px', overflow: 'hidden' },
  courseHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: '#f8f9fa', cursor: 'pointer', flexWrap: 'wrap', gap: '0.5rem' },
  courseTitle: { fontWeight: 700, fontSize: '1rem' },
  collapseIcon: { marginRight: '0.5rem', fontSize: '0.85rem' },
  courseStats: { fontSize: '0.85rem', color: '#555' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '0.5rem 0.75rem', textAlign: 'left', borderBottom: '2px solid #e0e0e0', fontSize: '0.75rem', fontWeight: 600, color: '#666', background: '#fafafa' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.4rem 0.75rem', fontSize: '0.85rem' },

  // Unmapped
  unmappedSection: { marginTop: '1.5rem', border: '1px solid #f0c040', borderRadius: '8px', overflow: 'hidden' },
  unmappedHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: '#fffbeb', fontWeight: 700, fontSize: '1rem', flexWrap: 'wrap', gap: '0.5rem' },
  unmappedSubtext: { fontSize: '0.85rem', fontWeight: 400, color: '#92400e' },
  mapBtn: { padding: '0.25rem 0.75rem', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 },

  // Modal
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '500px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  modalBody: { padding: '1.25rem' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  searchInput: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' },
  recipeRow: { padding: '0.6rem 0.75rem', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
}
