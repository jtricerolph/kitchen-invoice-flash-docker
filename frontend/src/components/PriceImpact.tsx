import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

interface IngredientChange {
  summary: string
  date: string | null
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

interface ImpactData {
  days: number
  recipes: ImpactItem[]
}

export default function PriceImpact() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [days, setDays] = useState(14)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const { data, isLoading } = useQuery<ImpactData>({
    queryKey: ['price-impact', days],
    queryFn: async () => {
      const res = await fetch(`/api/recipes/price-impact?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch price impact')
      return res.json()
    },
    enabled: !!token,
  })

  const filtered = data?.recipes.filter(r => typeFilter === 'all' || r.recipe_type === typeFilter) || []
  const dishCount = data?.recipes.filter(r => r.recipe_type === 'dish').length || 0
  const componentCount = data?.recipes.filter(r => r.recipe_type === 'component').length || 0

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>Price Impact Report</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <label style={{ fontSize: '0.85rem', color: '#666' }}>Period:</label>
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={styles.select}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
      </div>

      {isLoading && <div style={{ padding: '2rem', color: '#888' }}>Loading...</div>}

      {data && (
        <>
          {/* Summary stats */}
          <div style={styles.statsBar}>
            <span>{data.recipes.length} recipes affected</span>
            <span style={{ color: '#888' }}>|</span>
            <span>{dishCount} dishes</span>
            <span style={{ color: '#888' }}>|</span>
            <span>{componentCount} components</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem' }}>
              {(['all', 'dish', 'component'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  style={{
                    ...styles.filterBtn,
                    ...(typeFilter === t ? styles.filterBtnActive : {}),
                  }}
                >
                  {t === 'all' ? 'All' : t === 'dish' ? 'Dishes' : 'Recipes'}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              No recipes affected by ingredient price changes in the last {days} days.
            </div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Recipe</th>
                  <th style={styles.th}>Type</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Previous Cost</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Current Cost</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Change</th>
                  <th style={{ ...styles.th, textAlign: 'center' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <>
                    <tr key={r.recipe_id} style={styles.tr}>
                      <td style={{ ...styles.td, fontWeight: 500 }}>
                        <span
                          style={{ cursor: 'pointer', color: '#e94560' }}
                          onClick={() => navigate(r.recipe_type === 'dish' ? `/dishes/${r.recipe_id}` : `/recipes/${r.recipe_id}`)}
                        >
                          {r.recipe_name}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span style={{
                          background: r.recipe_type === 'dish' ? '#e94560' : '#3b82f6',
                          color: 'white',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          fontWeight: 600,
                        }}>
                          {r.recipe_type.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'monospace' }}>
                        {r.previous_cost_per_unit != null
                          ? `\u00A3${r.previous_cost_per_unit.toFixed(4)}/${r.output_unit}`
                          : '-'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontFamily: 'monospace' }}>
                        {r.current_cost_per_unit != null
                          ? `\u00A3${r.current_cost_per_unit.toFixed(4)}/${r.output_unit}`
                          : '-'}
                      </td>
                      <td style={{
                        ...styles.td,
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        fontWeight: 600,
                        color: r.cost_change != null ? (r.cost_change > 0 ? '#dc3545' : r.cost_change < 0 ? '#22c55e' : '#888') : '#888',
                      }}>
                        {r.cost_change != null ? (
                          <>
                            {r.cost_change > 0 ? '+' : ''}{`\u00A3${r.cost_change.toFixed(4)}`}
                            {r.cost_change_pct != null && (
                              <span style={{ fontSize: '0.75rem', marginLeft: '4px' }}>
                                ({r.cost_change_pct > 0 ? '+' : ''}{r.cost_change_pct}%)
                              </span>
                            )}
                          </>
                        ) : '-'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <button
                          onClick={() => setExpandedId(expandedId === r.recipe_id ? null : r.recipe_id)}
                          style={styles.detailBtn}
                        >
                          {r.ingredient_changes.length} change{r.ingredient_changes.length !== 1 ? 's' : ''}
                          {expandedId === r.recipe_id ? ' \u25B4' : ' \u25BE'}
                        </button>
                      </td>
                    </tr>
                    {expandedId === r.recipe_id && (
                      <tr key={`${r.recipe_id}-detail`}>
                        <td colSpan={6} style={{ padding: '0 0.75rem 0.75rem 2rem', background: '#fafafa' }}>
                          <div style={{ fontSize: '0.8rem', color: '#555' }}>
                            {r.ingredient_changes.map((c, i) => (
                              <div key={i} style={{ padding: '3px 0', borderBottom: i < r.ingredient_changes.length - 1 ? '1px solid #eee' : 'none' }}>
                                <span style={{ color: '#888', marginRight: '0.5rem' }}>{c.date}</span>
                                {c.summary}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  select: { padding: '0.4rem 0.6rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.85rem' },
  statsBar: { display: 'flex', gap: '0.75rem', alignItems: 'center', padding: '0.5rem 0', marginBottom: '0.5rem', fontSize: '0.85rem', color: '#555' },
  filterBtn: { padding: '3px 10px', border: '1px solid #ddd', borderRadius: '4px', background: '#f5f5f5', cursor: 'pointer', fontSize: '0.75rem', color: '#555' },
  filterBtnActive: { background: '#e94560', color: 'white', borderColor: '#e94560' },
  table: { width: '100%', borderCollapse: 'collapse' as const, background: 'white', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  th: { padding: '0.6rem 0.75rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', background: '#fafafa', fontSize: '0.8rem', fontWeight: 600, color: '#555' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.5rem 0.75rem', fontSize: '0.85rem' },
  detailBtn: { padding: '2px 8px', border: '1px solid #ddd', borderRadius: '4px', background: '#f5f5f5', cursor: 'pointer', fontSize: '0.75rem', color: '#555' },
}
