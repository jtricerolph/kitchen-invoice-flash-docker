import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface MatrixCell {
  has_flag: boolean
  is_unassessed: boolean
  is_none: boolean
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
  required: boolean
}

interface MatrixData {
  flags: FlagColumn[]
  ingredients: MatrixIngredient[]
}

interface Props {
  recipeId: number
  categoryId?: number
}

export default function RecipeFlagMatrix({ recipeId, categoryId }: Props) {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set())

  const { data: rawData, isLoading } = useQuery<MatrixData>({
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

  // Filter to specific category if provided
  const data = rawData ? {
    flags: categoryId ? rawData.flags.filter(f => f.category_id === categoryId) : rawData.flags,
    ingredients: rawData.ingredients,
  } : undefined

  const toggleMutation = useMutation({
    mutationFn: async ({ ingredientId, flagId, hasFlag }: { ingredientId: number; flagId: number; hasFlag: boolean }) => {
      const res = await fetch(`/api/food-flags/recipes/${recipeId}/flags/matrix`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ ingredient_id: ingredientId, food_flag_id: flagId, has_flag: hasFlag }] }),
      })
      if (!res.ok) throw new Error('Failed to update flag')
    },
    onMutate: ({ ingredientId, flagId }) => {
      setPendingCells(prev => new Set(prev).add(`${ingredientId}-${flagId}`))
    },
    onSettled: (_data, _err, { ingredientId, flagId }) => {
      setPendingCells(prev => {
        const next = new Set(prev)
        next.delete(`${ingredientId}-${flagId}`)
        return next
      })
      queryClient.invalidateQueries({ queryKey: ['recipe-flag-matrix', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
    },
  })

  const toggleNoneMutation = useMutation({
    mutationFn: async ({ ingredientId, catId }: { ingredientId: number; catId: number }) => {
      const res = await fetch(`/api/food-flags/recipes/${recipeId}/flags/matrix/none`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredient_id: ingredientId, category_id: catId }),
      })
      if (!res.ok) throw new Error('Failed to toggle none')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['recipe-flag-matrix', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['recipe-flags', recipeId] })
      queryClient.invalidateQueries({ queryKey: ['ingredients'] })
    },
  })

  if (isLoading) return <div style={{ padding: '1rem', color: '#888' }}>Loading matrix...</div>
  if (!data || !data.flags.length) return <div style={{ padding: '1rem', color: '#888' }}>No flags configured for this category</div>

  // Group flags by category
  const categories: Record<number, { name: string; propagation: string; required: boolean; flags: FlagColumn[] }> = {}
  for (const f of data.flags) {
    if (!categories[f.category_id]) {
      categories[f.category_id] = { name: f.category_name, propagation: f.propagation_type, required: f.required, flags: [] }
    }
    categories[f.category_id].flags.push(f)
  }

  // Group ingredients by sub-recipe
  let currentSubRecipe = ''
  const rows: Array<{ type: 'header' | 'ingredient'; label: string; ingredient?: MatrixIngredient }> = []
  for (const ing of data.ingredients) {
    if (ing.is_sub_recipe && ing.sub_recipe_name !== currentSubRecipe) {
      currentSubRecipe = ing.sub_recipe_name || ''
      rows.push({ type: 'header', label: `\u25B8 ${currentSubRecipe}` })
    } else if (!ing.is_sub_recipe && currentSubRecipe) {
      currentSubRecipe = ''
    }
    rows.push({ type: 'ingredient', label: ing.is_sub_recipe ? `  \u21B3 ${ing.ingredient_name}` : ing.ingredient_name, ingredient: ing })
  }

  // Compute totals per flag
  const totals: Record<number, { has: boolean; unassessed: boolean }> = {}
  for (const f of data.flags) {
    const cat = categories[f.category_id]
    if (cat.propagation === 'contains') {
      const anyHas = data.ingredients.some(ing => ing.flags[f.id]?.has_flag)
      totals[f.id] = { has: anyHas, unassessed: false }
    } else {
      const allHave = data.ingredients.every(ing => ing.flags[f.id]?.has_flag)
      const anyUnassessed = data.ingredients.some(ing => ing.flags[f.id]?.is_unassessed)
      totals[f.id] = { has: allHave && !anyUnassessed, unassessed: anyUnassessed }
    }
  }

  // Check if "none" is set per ingredient per category
  const getNoneForCategory = (ing: MatrixIngredient, catId: number): boolean => {
    const catFlags = categories[catId]?.flags || []
    return catFlags.length > 0 && catFlags.every(f => ing.flags[f.id]?.is_none)
  }

  const handleToggle = (ingredientId: number, flagId: number, currentHasFlag: boolean) => {
    toggleMutation.mutate({ ingredientId, flagId, hasFlag: !currentHasFlag })
  }

  const renderCell = (ingredientId: number, flagId: number, cell: MatrixCell | undefined, propagation: string) => {
    const isPending = pendingCells.has(`${ingredientId}-${flagId}`)
    const hasFlag = cell?.has_flag ?? false
    const isUnassessed = cell?.is_unassessed ?? false
    const isNone = cell?.is_none ?? false

    const cellStyle: React.CSSProperties = {
      ...styles.cell,
      cursor: 'pointer',
      opacity: isPending ? 0.5 : 1,
      transition: 'background 0.15s',
    }

    const handleClick = () => {
      if (isPending) return
      if (isUnassessed) {
        handleToggle(ingredientId, flagId, false)
      } else {
        handleToggle(ingredientId, flagId, hasFlag)
      }
    }

    if (isUnassessed) {
      return <td style={{ ...cellStyle, color: '#f59e0b' }} title="Unassessed \u2014 click to assess" onClick={handleClick}>{'\u2753'}</td>
    }
    if (isNone) {
      return (
        <td
          style={{ ...cellStyle, color: '#94a3b8', background: '#f8fafc' }}
          title="None apply \u2014 click to set this flag"
          onClick={handleClick}
        >
          {'\u2014'}
        </td>
      )
    }
    if (propagation === 'contains') {
      return (
        <td
          style={{ ...cellStyle, color: hasFlag ? '#dc3545' : '#ccc', background: hasFlag ? '#fef2f2' : undefined }}
          title={hasFlag ? 'Contains \u2014 click to remove' : 'Click to mark as contains'}
          onClick={handleClick}
        >
          {hasFlag ? '\u2713' : '\u00B7'}
        </td>
      )
    } else {
      return (
        <td
          style={{ ...cellStyle, color: hasFlag ? '#22c55e' : '#dc3545', background: hasFlag ? '#f0fdf4' : undefined }}
          title={hasFlag ? 'Suitable \u2014 click to remove' : 'Click to mark as suitable'}
          onClick={handleClick}
        >
          {hasFlag ? '\u2713' : '\u2717'}
        </td>
      )
    }
  }

  const showNoneColumn = Object.values(categories).some(c => c.required)

  return (
    <div style={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', color: '#888' }}>
          Click cells to toggle flags{showNoneColumn ? '. Use "N" column to mark "None apply".' : '.'}
        </span>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
        <table style={styles.table}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
            <tr>
              <th style={{ ...styles.th, minWidth: '160px', position: 'sticky', top: 0, background: 'white', zIndex: 2 }}>Ingredient</th>
              {Object.entries(categories).map(([catId, cat]) => (
                <>
                  {cat.flags.map(f => (
                    <th key={f.id} style={styles.th} title={`${f.name} (${cat.name})`}>
                      {Object.keys(categories).length > 1 && (
                        <div style={{ fontSize: '0.6rem', color: '#888' }}>{cat.name}</div>
                      )}
                      <div>{f.code || f.name.substring(0, 4)}</div>
                    </th>
                  ))}
                  {cat.required && (
                    <th key={`none-${catId}`} style={{ ...styles.th, borderLeft: '2px solid #e0e0e0', fontSize: '0.6rem', minWidth: '28px' }} title={`None apply for ${cat.name}`}>
                      <div>N</div>
                    </th>
                  )}
                </>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              if (row.type === 'header') {
                const noneColCount = Object.values(categories).filter(c => c.required).length
                const totalCols = data.flags.length + noneColCount + 1
                return (
                  <tr key={`h-${idx}`}>
                    <td colSpan={totalCols} style={styles.subHeader}>{row.label}</td>
                  </tr>
                )
              }
              const ing = row.ingredient!
              return (
                <tr key={ing.ingredient_id + '-' + idx}>
                  <td style={{ ...styles.td, fontWeight: ing.is_sub_recipe ? 400 : 500 }}>{row.label}</td>
                  {Object.entries(categories).map(([catId, cat]) => (
                    <>
                      {cat.flags.map(f => renderCell(ing.ingredient_id, f.id, ing.flags[f.id], cat.propagation))}
                      {cat.required && (
                        <td
                          key={`none-${catId}-${ing.ingredient_id}`}
                          style={{
                            ...styles.cell,
                            borderLeft: '2px solid #e0e0e0',
                            cursor: 'pointer',
                            color: getNoneForCategory(ing, Number(catId)) ? '#3b82f6' : '#ddd',
                            background: getNoneForCategory(ing, Number(catId)) ? '#eff6ff' : undefined,
                            fontWeight: getNoneForCategory(ing, Number(catId)) ? 600 : 400,
                          }}
                          title={getNoneForCategory(ing, Number(catId)) ? `None apply \u2014 click to unset` : `Click to mark "None apply" for ${cat.name}`}
                          onClick={() => toggleNoneMutation.mutate({ ingredientId: ing.ingredient_id, catId: Number(catId) })}
                        >
                          N
                        </td>
                      )}
                    </>
                  ))}
                </tr>
              )
            })}
            {/* Total row */}
            <tr style={{ borderTop: '3px double #333' }}>
              <td style={{ ...styles.td, fontWeight: 700 }}>Recipe Total</td>
              {Object.entries(categories).map(([catId, cat]) => (
                <>
                  {cat.flags.map(f => {
                    const t = totals[f.id]
                    if (t.unassessed) return <td key={f.id} style={{ ...styles.cell, color: '#f59e0b' }}>{'\u2753'}</td>
                    if (cat.propagation === 'contains') {
                      return <td key={f.id} style={{ ...styles.cell, color: t.has ? '#dc3545' : undefined, fontWeight: 700 }}>
                        {t.has ? '\u2713' : ''}
                      </td>
                    } else {
                      return <td key={f.id} style={{ ...styles.cell, color: t.has ? '#22c55e' : '#dc3545', fontWeight: 700 }}>
                        {t.has ? '\u2713' : '\u2717'}
                      </td>
                    }
                  })}
                  {cat.required && (
                    <td key={`none-total-${catId}`} style={{ ...styles.cell, borderLeft: '2px solid #e0e0e0' }}></td>
                  )}
                </>
              ))}
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
  th: { padding: '0.4rem 0.35rem', textAlign: 'center' as const, borderBottom: '2px solid #ddd', fontSize: '0.7rem', fontWeight: 600, minWidth: '40px', position: 'sticky' as const, top: 0, background: 'white', zIndex: 1 },
  td: { padding: '0.35rem 0.5rem', borderBottom: '1px solid #f0f0f0', fontSize: '0.8rem' },
  cell: { padding: '0.35rem', textAlign: 'center' as const, borderBottom: '1px solid #f0f0f0', fontSize: '0.9rem' },
  subHeader: { padding: '0.5rem', fontWeight: 700, background: '#f8f9fa', fontSize: '0.8rem', color: '#555' },
}
