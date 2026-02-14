import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface MatrixCell {
  has_flag: boolean
  is_unassessed: boolean
}

interface MatrixIngredient {
  ingredient_id: number
  ingredient_name: string
  is_sub_recipe: boolean
  sub_recipe_name: string | null
  flags: Record<number, MatrixCell>
}

interface FlagColumn {
  id: number
  name: string
  code: string | null
  category_id: number
  category_name: string
  propagation_type: string
}

interface MatrixData {
  flags: FlagColumn[]
  ingredients: MatrixIngredient[]
}

interface Props {
  recipeId: number
}

export default function RecipeFlagMatrix({ recipeId }: Props) {
  const { token } = useAuth()

  const { data, isLoading } = useQuery<MatrixData>({
    queryKey: ['recipe-flag-matrix', recipeId],
    queryFn: async () => {
      const res = await fetch(`/api/food-flags/recipes/${recipeId}/flags/matrix`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch matrix')
      return res.json()
    },
    enabled: !!token && !!recipeId,
  })

  if (isLoading) return <div style={{ padding: '1rem', color: '#888' }}>Loading matrix...</div>
  if (!data || !data.flags.length) return <div style={{ padding: '1rem', color: '#888' }}>No flags configured</div>

  // Group flags by category
  const categories: Record<number, { name: string; propagation: string; flags: FlagColumn[] }> = {}
  for (const f of data.flags) {
    if (!categories[f.category_id]) {
      categories[f.category_id] = { name: f.category_name, propagation: f.propagation_type, flags: [] }
    }
    categories[f.category_id].flags.push(f)
  }

  // Group ingredients by sub-recipe
  let currentSubRecipe = ''
  const rows: Array<{ type: 'header' | 'ingredient'; label: string; ingredient?: MatrixIngredient }> = []
  for (const ing of data.ingredients) {
    if (ing.is_sub_recipe && ing.sub_recipe_name !== currentSubRecipe) {
      currentSubRecipe = ing.sub_recipe_name || ''
      rows.push({ type: 'header', label: `▸ ${currentSubRecipe}` })
    } else if (!ing.is_sub_recipe && currentSubRecipe) {
      currentSubRecipe = ''
    }
    rows.push({ type: 'ingredient', label: ing.is_sub_recipe ? `  ↳ ${ing.ingredient_name}` : ing.ingredient_name, ingredient: ing })
  }

  // Compute totals
  const totals: Record<number, { has: boolean; unassessed: boolean }> = {}
  for (const f of data.flags) {
    const cat = categories[f.category_id]
    if (cat.propagation === 'contains') {
      // Union: any has_flag -> total is true
      const anyHas = data.ingredients.some(ing => ing.flags[f.id]?.has_flag)
      totals[f.id] = { has: anyHas, unassessed: false }
    } else {
      // Intersection: all must have, any unassessed or missing -> not suitable
      const allHave = data.ingredients.every(ing => ing.flags[f.id]?.has_flag)
      const anyUnassessed = data.ingredients.some(ing => ing.flags[f.id]?.is_unassessed)
      totals[f.id] = { has: allHave && !anyUnassessed, unassessed: anyUnassessed }
    }
  }

  const renderCell = (_flagId: number, cell: MatrixCell | undefined, propagation: string) => {
    if (!cell) return <td style={styles.cell}></td>
    if (cell.is_unassessed) return <td style={{ ...styles.cell, color: '#f59e0b' }} title="Unassessed">❓</td>
    if (propagation === 'contains') {
      return <td style={{ ...styles.cell, color: cell.has_flag ? '#dc3545' : undefined }}>
        {cell.has_flag ? '✓' : ''}
      </td>
    } else {
      if (cell.has_flag) return <td style={{ ...styles.cell, color: '#22c55e' }}>✓</td>
      return <td style={{ ...styles.cell, color: '#dc3545' }}>{cell.has_flag === false ? '✗' : ''}</td>
    }
  }

  return (
    <div style={styles.container}>
      <div style={{ overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, minWidth: '160px' }}>Ingredient</th>
              {Object.values(categories).map(cat => (
                cat.flags.map(f => (
                  <th key={f.id} style={styles.th} title={`${f.name} (${cat.name})`}>
                    <div style={{ fontSize: '0.65rem', color: '#888' }}>{cat.name}</div>
                    <div>{f.code || f.name.substring(0, 4)}</div>
                  </th>
                ))
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              if (row.type === 'header') {
                return (
                  <tr key={`h-${idx}`}>
                    <td colSpan={data.flags.length + 1} style={styles.subHeader}>{row.label}</td>
                  </tr>
                )
              }
              const ing = row.ingredient!
              return (
                <tr key={ing.ingredient_id + '-' + idx}>
                  <td style={{ ...styles.td, fontWeight: ing.is_sub_recipe ? 400 : 500 }}>{row.label}</td>
                  {data.flags.map(f => {
                    const cat = categories[f.category_id]
                    return renderCell(f.id, ing.flags[f.id], cat.propagation)
                  })}
                </tr>
              )
            })}
            {/* Total row */}
            <tr style={{ borderTop: '3px double #333' }}>
              <td style={{ ...styles.td, fontWeight: 700 }}>Recipe Total</td>
              {data.flags.map(f => {
                const t = totals[f.id]
                const cat = categories[f.category_id]
                if (t.unassessed) return <td key={f.id} style={{ ...styles.cell, color: '#f59e0b' }}>❓</td>
                if (cat.propagation === 'contains') {
                  return <td key={f.id} style={{ ...styles.cell, color: t.has ? '#dc3545' : undefined, fontWeight: 700 }}>
                    {t.has ? '✓' : ''}
                  </td>
                } else {
                  return <td key={f.id} style={{ ...styles.cell, color: t.has ? '#22c55e' : '#dc3545', fontWeight: 700 }}>
                    {t.has ? '✓' : '✗'}
                  </td>
                }
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { background: 'white', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '1rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.8rem' },
  th: { padding: '0.4rem 0.35rem', textAlign: 'center' as const, borderBottom: '2px solid #ddd', fontSize: '0.7rem', fontWeight: 600, minWidth: '40px' },
  td: { padding: '0.35rem 0.5rem', borderBottom: '1px solid #f0f0f0', fontSize: '0.8rem' },
  cell: { padding: '0.35rem', textAlign: 'center' as const, borderBottom: '1px solid #f0f0f0', fontSize: '0.9rem' },
  subHeader: { padding: '0.5rem', fontWeight: 700, background: '#f8f9fa', fontSize: '0.8rem', color: '#555' },
}
