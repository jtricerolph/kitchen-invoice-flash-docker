import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useAuth } from '../App'

interface Division {
  id: number
  name: string
}

interface FlagState {
  food_flag_id: number
  flag_name: string
  flag_code: string | null
  flag_icon: string | null
  category_name: string
  propagation_type: string
  is_active: boolean
  excludable_on_request: boolean
}

interface Props {
  menuId?: number
  menuName?: string
  divisions?: Division[]
  preSelectedDivisionId?: number
  recipeId?: number  // when opened from DishEditor
  recipeName?: string
  recipeDesc?: string
  recipePrice?: number | null
  onClose: () => void
  onPublished: () => void
}

export default function PublishToMenuModal({
  menuId: propMenuId,
  divisions: propDivisions,
  preSelectedDivisionId,
  recipeId: propRecipeId,
  recipeName,
  recipeDesc,
  recipePrice,
  onClose,
  onPublished,
}: Props) {
  const { token, user } = useAuth()

  const [step, setStep] = useState<'select' | 'confirm'>('select')
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(propRecipeId || null)
  const [selectedMenuId, setSelectedMenuId] = useState<number | null>(propMenuId || null)
  const [selectedDivId, setSelectedDivId] = useState<number | null>(preSelectedDivisionId || null)
  const [displayName, setDisplayName] = useState(recipeName || '')
  const [description, setDescription] = useState(recipeDesc || '')
  const [price, setPrice] = useState(recipePrice ? String(recipePrice) : '')
  const [confirmedBy, setConfirmedBy] = useState(user?.name || '')
  const [dishSearch, setDishSearch] = useState('')

  // Fetch dishes list (when opened from MenuEditor, need to pick a dish)
  const { data: dishes } = useQuery<Array<{ id: number; name: string; description: string | null; gross_sell_price: number | null }>>({
    queryKey: ['dishes-for-menu'],
    queryFn: async () => {
      const res = await fetch('/api/recipes?recipe_type=dish', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch dishes')
      return res.json()
    },
    enabled: !!token && !propRecipeId,
  })

  // Fetch menus list (when opened from DishEditor, need to pick a menu)
  const { data: menus } = useQuery<Array<{ id: number; name: string; is_active: boolean }>>({
    queryKey: ['menus-for-publish'],
    queryFn: async () => {
      const res = await fetch('/api/menus', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch menus')
      return res.json()
    },
    enabled: !!token && !propMenuId,
  })

  // Fetch divisions for selected menu (when from DishEditor)
  const { data: menuDetail } = useQuery<{ divisions: Division[] }>({
    queryKey: ['menu-divisions', selectedMenuId],
    queryFn: async () => {
      const res = await fetch(`/api/menus/${selectedMenuId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token && !!selectedMenuId && !propMenuId,
  })

  // Fetch recipe flags when a recipe is selected
  const { data: flagData, isLoading: flagsLoading } = useQuery<{
    flags: FlagState[]
    unassessed_ingredients: Array<{ id: number; name: string; category: string }>
  }>({
    queryKey: ['recipe-flags-for-publish', selectedRecipeId],
    queryFn: async () => {
      const res = await fetch(`/api/food-flags/recipes/${selectedRecipeId}/flags`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token && !!selectedRecipeId,
  })

  const divisions = propDivisions || menuDetail?.divisions || []
  const activeMenus = (menus || []).filter(m => m.is_active)
  const unassessed = flagData?.unassessed_ingredients || []
  const activeFlags = (flagData?.flags || []).filter(f => f.is_active)
  const hasUnassessed = unassessed.length > 0

  // When a dish is selected (from dish picker), populate fields
  useEffect(() => {
    if (selectedRecipeId && dishes) {
      const dish = dishes.find(d => d.id === selectedRecipeId)
      if (dish) {
        setDisplayName(dish.name)
        setDescription(dish.description || '')
        setPrice(dish.gross_sell_price ? String(dish.gross_sell_price) : '')
      }
    }
  }, [selectedRecipeId, dishes])

  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/menus/${selectedMenuId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipe_id: selectedRecipeId,
          division_id: selectedDivId,
          display_name: displayName.trim(),
          description: description.trim() || null,
          price: price ? parseFloat(price) : null,
          confirmed_by_name: confirmedBy.trim(),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(typeof err.detail === 'string' ? err.detail : err.detail?.message || 'Failed to publish')
      }
      return res.json()
    },
    onSuccess: () => onPublished(),
  })

  const filteredDishes = (dishes || []).filter(d =>
    !dishSearch || d.name.toLowerCase().includes(dishSearch.toLowerCase())
  )

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: '550px' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 1rem' }}>
          {step === 'select' ? 'Publish Dish to Menu' : 'Confirm Allergens & Publish'}
        </h3>

        {step === 'select' && (
          <>
            {/* Dish selection (when from MenuEditor) */}
            {!propRecipeId && (
              <>
                <label style={styles.label}>Select Dish *</label>
                <input
                  type="text"
                  value={dishSearch}
                  onChange={(e) => setDishSearch(e.target.value)}
                  style={styles.input}
                  placeholder="Search dishes..."
                />
                <div style={{ maxHeight: '200px', overflow: 'auto', border: '1px solid #eee', borderRadius: '4px', marginTop: '0.25rem' }}>
                  {filteredDishes.map(dish => (
                    <div
                      key={dish.id}
                      onClick={() => setSelectedRecipeId(dish.id)}
                      style={{
                        padding: '0.5rem',
                        cursor: 'pointer',
                        background: selectedRecipeId === dish.id ? '#eff6ff' : '#fff',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      <span style={{ fontWeight: selectedRecipeId === dish.id ? 600 : 400 }}>{dish.name}</span>
                    </div>
                  ))}
                  {filteredDishes.length === 0 && <p style={{ padding: '0.5rem', color: '#999' }}>No dishes found</p>}
                </div>
              </>
            )}

            {/* Menu selection (when from DishEditor) */}
            {!propMenuId && (
              <>
                <label style={styles.label}>Menu *</label>
                <select
                  value={selectedMenuId || ''}
                  onChange={(e) => { setSelectedMenuId(parseInt(e.target.value)); setSelectedDivId(null) }}
                  style={styles.input}
                >
                  <option value="">Select a menu...</option>
                  {activeMenus.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </>
            )}

            {/* Division selection */}
            {divisions.length > 0 && (
              <>
                <label style={styles.label}>Section *</label>
                <select
                  value={selectedDivId || ''}
                  onChange={(e) => setSelectedDivId(parseInt(e.target.value))}
                  style={styles.input}
                >
                  <option value="">Select section...</option>
                  {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </>
            )}

            <div style={styles.modalActions}>
              <button onClick={onClose} style={styles.btn}>Cancel</button>
              <button
                onClick={() => setStep('confirm')}
                style={styles.btnPrimary}
                disabled={!selectedRecipeId || !selectedMenuId || !selectedDivId}
              >
                Next: Review Allergens
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            {flagsLoading && <p>Loading allergen data...</p>}

            {!flagsLoading && hasUnassessed && (
              <div style={{ background: '#fee2e2', padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem' }}>
                <strong style={{ color: '#dc2626' }}>Cannot publish: unassessed ingredients</strong>
                <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                  {unassessed.map((u, i) => <li key={i} style={{ fontSize: '0.875rem' }}>{u.name} — {u.category}</li>)}
                </ul>
              </div>
            )}

            {!flagsLoading && !hasUnassessed && (
              <>
                {activeFlags.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={styles.label}>Confirmed Allergens</label>
                    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                      {activeFlags.map(f => (
                        <span key={f.food_flag_id} style={{
                          padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem',
                          background: f.propagation_type === 'contains' ? '#fee2e2' : '#dcfce7',
                          color: f.propagation_type === 'contains' ? '#991b1b' : '#166534',
                        }}>
                          {f.flag_code || f.flag_name}
                          {f.excludable_on_request && ' *'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <label style={styles.label}>Display Name *</label>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={styles.input} />

                <label style={styles.label}>Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{ ...styles.input, minHeight: '60px', resize: 'vertical' }}
                />

                <label style={styles.label}>Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  style={{ ...styles.input, width: '120px' }}
                />

                <label style={styles.label}>Confirmed by *</label>
                <input value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} style={styles.input} />
              </>
            )}

            <div style={styles.modalActions}>
              <button onClick={() => setStep('select')} style={styles.btn}>Back</button>
              <button onClick={onClose} style={styles.btn}>Cancel</button>
              {!hasUnassessed && (
                <button
                  onClick={() => publishMutation.mutate()}
                  style={styles.btnPrimary}
                  disabled={!displayName.trim() || !confirmedBy.trim() || publishMutation.isPending}
                >
                  {publishMutation.isPending ? 'Publishing...' : 'Publish to Menu'}
                </button>
              )}
            </div>

            {publishMutation.isError && (
              <p style={{ color: '#dc2626', marginTop: '0.5rem', fontSize: '0.875rem' }}>
                {(publishMutation.error as Error).message}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: '8px', padding: '1.5rem', width: '90%', maxHeight: '90vh', overflow: 'auto' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' },
  label: { display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem', marginTop: '0.75rem' },
  input: { width: '100%', padding: '0.4rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.875rem', boxSizing: 'border-box' },
  btn: { padding: '0.4rem 0.75rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnPrimary: { padding: '0.4rem 0.75rem', border: 'none', borderRadius: '4px', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
}
