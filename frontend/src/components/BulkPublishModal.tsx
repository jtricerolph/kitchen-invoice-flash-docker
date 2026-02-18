import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useAuth } from '../App'

interface DishItem {
  id: number
  name: string
  description: string | null
  gross_sell_price: number | null
  flag_summary: Array<{ name: string; code: string | null; active: boolean }>
}

interface Props {
  menuId: number
  divisionId: number
  divisionName: string
  onClose: () => void
  onPublished: () => void
}

export default function BulkPublishModal({ menuId, divisionId, divisionName, onClose, onPublished }: Props) {
  const { token, user } = useAuth()

  const [step, setStep] = useState<'select' | 'confirm'>('select')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')
  const [confirmedBy, setConfirmedBy] = useState(user?.name || '')
  const [editedNames, setEditedNames] = useState<Record<number, string>>({})
  const [editedPrices, setEditedPrices] = useState<Record<number, string>>({})

  const { data: dishes } = useQuery<DishItem[]>({
    queryKey: ['dishes-for-bulk'],
    queryFn: async () => {
      const res = await fetch('/api/recipes?recipe_type=dish', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token,
  })

  // Check flags for selected dishes
  const { data: flagChecks } = useQuery<Record<number, { ok: boolean; unassessed?: Array<{ name: string }> }>>({
    queryKey: ['bulk-flag-check', Array.from(selected)],
    queryFn: async () => {
      const results: Record<number, { ok: boolean; unassessed?: Array<{ name: string }> }> = {}
      for (const rid of selected) {
        const res = await fetch(`/api/food-flags/recipes/${rid}/flags`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          results[rid] = {
            ok: !data.unassessed_ingredients || data.unassessed_ingredients.length === 0,
            unassessed: data.unassessed_ingredients,
          }
        } else {
          results[rid] = { ok: false }
        }
      }
      return results
    },
    enabled: !!token && step === 'confirm' && selected.size > 0,
  })

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const validIds = Array.from(selected).filter(id => flagChecks?.[id]?.ok)
      const items = validIds.map(id => {
        const dish = dishes?.find(d => d.id === id)
        return {
          recipe_id: id,
          display_name: editedNames[id] || dish?.name || '',
          description: dish?.description || null,
          price: editedPrices[id] ? parseFloat(editedPrices[id]) : (dish?.gross_sell_price || null),
        }
      })
      const res = await fetch(`/api/menus/${menuId}/items/bulk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          division_id: divisionId,
          confirmed_by_name: confirmedBy.trim(),
          items,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail?.message || 'Failed to bulk publish')
      }
      return res.json()
    },
    onSuccess: () => onPublished(),
  })

  const filtered = (dishes || []).filter(d =>
    !search || d.name.toLowerCase().includes(search.toLowerCase())
  )

  const toggleSelect = (id: number) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const validCount = flagChecks ? Array.from(selected).filter(id => flagChecks[id]?.ok).length : 0
  const blockedCount = flagChecks ? Array.from(selected).filter(id => flagChecks[id] && !flagChecks[id].ok).length : 0

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 0.5rem' }}>Bulk Add Dishes to "{divisionName}"</h3>

        {step === 'select' && (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={styles.input}
              placeholder="Search dishes..."
            />
            <div style={{ maxHeight: '350px', overflow: 'auto', border: '1px solid #eee', borderRadius: '4px', marginTop: '0.5rem' }}>
              {filtered.map(dish => (
                <label
                  key={dish.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.5rem', cursor: 'pointer',
                    background: selected.has(dish.id) ? '#eff6ff' : '#fff',
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(dish.id)}
                    onChange={() => toggleSelect(dish.id)}
                  />
                  <span style={{ flex: 1 }}>{dish.name}</span>
                  {dish.flag_summary?.filter(f => f.active).map((f, i) => (
                    <span key={i} style={styles.flagBadge}>{f.code || f.name}</span>
                  ))}
                </label>
              ))}
              {filtered.length === 0 && <p style={{ padding: '0.5rem', color: '#999' }}>No dishes found</p>}
            </div>
            <p style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.5rem' }}>{selected.size} selected</p>
            <div style={styles.modalActions}>
              <button onClick={onClose} style={styles.btn}>Cancel</button>
              <button onClick={() => setStep('confirm')} style={styles.btnPrimary} disabled={selected.size === 0}>
                Next: Review
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            {!flagChecks && <p>Checking allergens...</p>}
            {flagChecks && (
              <>
                {blockedCount > 0 && (
                  <div style={{ background: '#fee2e2', padding: '0.5rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
                    <strong style={{ color: '#dc2626' }}>{blockedCount} dish{blockedCount !== 1 ? 'es' : ''} blocked</strong> — unassessed ingredients
                  </div>
                )}
                <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                  {Array.from(selected).map(id => {
                    const dish = dishes?.find(d => d.id === id)
                    const check = flagChecks[id]
                    if (!dish) return null
                    return (
                      <div key={id} style={{
                        padding: '0.5rem', borderBottom: '1px solid #eee',
                        opacity: check?.ok ? 1 : 0.5,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 500 }}>{dish.name}</span>
                          {!check?.ok && <span style={{ color: '#dc2626', fontSize: '0.75rem' }}>BLOCKED</span>}
                        </div>
                        {check?.ok && (
                          <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.25rem' }}>
                            <input
                              value={editedNames[id] ?? dish.name}
                              onChange={(e) => setEditedNames(prev => ({ ...prev, [id]: e.target.value }))}
                              style={{ ...styles.inputSm, flex: 1 }}
                              placeholder="Display name"
                            />
                            <input
                              value={editedPrices[id] ?? (dish.gross_sell_price ? String(dish.gross_sell_price) : '')}
                              onChange={(e) => setEditedPrices(prev => ({ ...prev, [id]: e.target.value }))}
                              style={{ ...styles.inputSm, width: '80px' }}
                              placeholder="Price"
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <label style={styles.label}>Confirmed by *</label>
                <input value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} style={styles.input} />
                <div style={styles.modalActions}>
                  <button onClick={() => setStep('select')} style={styles.btn}>Back</button>
                  <button onClick={onClose} style={styles.btn}>Cancel</button>
                  <button
                    onClick={() => bulkMutation.mutate()}
                    style={styles.btnPrimary}
                    disabled={validCount === 0 || !confirmedBy.trim() || bulkMutation.isPending}
                  >
                    {bulkMutation.isPending ? 'Publishing...' : `Publish ${validCount} Dishes`}
                  </button>
                </div>
                {bulkMutation.isError && (
                  <p style={{ color: '#dc2626', marginTop: '0.5rem', fontSize: '0.875rem' }}>
                    {(bulkMutation.error as Error).message}
                  </p>
                )}
              </>
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
  inputSm: { padding: '0.25rem 0.4rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.8rem' },
  btn: { padding: '0.4rem 0.75rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnPrimary: { padding: '0.4rem 0.75rem', border: 'none', borderRadius: '4px', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  flagBadge: { padding: '1px 6px', background: '#f3f4f6', borderRadius: '4px', fontSize: '0.7rem', color: '#374151' },
}
