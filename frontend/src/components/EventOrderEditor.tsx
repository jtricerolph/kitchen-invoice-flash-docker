import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

interface EventOrderDetail {
  id: number
  name: string
  event_date: string | null
  notes: string | null
  status: string
  items: EventOrderItemDetail[]
  created_at: string
  updated_at: string
}

interface EventOrderItemDetail {
  id: number
  recipe_id: number
  recipe_name: string
  recipe_type: string
  batch_portions: number
  quantity: number
  cost_per_portion: number | null
  subtotal: number | null
  notes: string | null
  sort_order: number
}

interface ShoppingListItem {
  ingredient_id: number
  ingredient_name: string
  category: string
  total_quantity: number
  adjusted_quantity: number
  unit: string
  yield_percent: number
  sources: Array<{
    supplier_name: string
    product_code: string | null
    pack_description: string | null
    suggested_packs: number | null
    cost_per_pack: number | null
    subtotal: number | null
  }>
  recipe_breakdown: Array<{ recipe_name: string; quantity: number }>
}

interface RecipeOption {
  id: number
  name: string
  recipe_type: string
  batch_portions: number
  cost_per_portion: number | null
}

export default function EventOrderEditor() {
  const { id } = useParams<{ id: string }>()
  const orderId = parseInt(id || '0')
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [showAddRecipe, setShowAddRecipe] = useState(false)
  const [selectedRecipeId, setSelectedRecipeId] = useState<string>('')
  const [recipeQty, setRecipeQty] = useState('1')
  const [showShopping, setShowShopping] = useState(false)
  const [groupBySupplier, setGroupBySupplier] = useState(false)

  const { data: order } = useQuery<EventOrderDetail>({
    queryKey: ['event-order', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/event-orders/${orderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Not found')
      return res.json()
    },
    enabled: !!token && !!orderId,
  })

  const { data: recipes } = useQuery<RecipeOption[]>({
    queryKey: ['recipes-for-event'],
    queryFn: async () => {
      const res = await fetch('/api/recipes', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token && showAddRecipe,
  })

  const { data: shoppingList } = useQuery<{ items: ShoppingListItem[] }>({
    queryKey: ['event-shopping-list', orderId, groupBySupplier],
    queryFn: async () => {
      const params = groupBySupplier ? '?group_by_supplier=true' : ''
      const res = await fetch(`/api/event-orders/${orderId}/shopping-list${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    },
    enabled: !!token && !!orderId && showShopping,
  })

  const addItemMutation = useMutation({
    mutationFn: async (data: { recipe_id: number; quantity: number }) => {
      const res = await fetch(`/api/event-orders/${orderId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['event-shopping-list', orderId] })
      setShowAddRecipe(false)
      setSelectedRecipeId('')
      setRecipeQty('1')
    },
  })

  const removeItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/event-orders/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['event-shopping-list', orderId] })
    },
  })

  const updateStatusMutation = useMutation({
    mutationFn: async (status: string) => {
      const res = await fetch(`/api/event-orders/${orderId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['event-order', orderId] }),
  })

  if (!order) return <div style={styles.loading}>Loading event order...</div>

  const totalCost = order.items.reduce((sum, i) => sum + (i.subtotal || 0), 0)
  const totalServings = order.items.reduce((sum, i) => {
    if (i.recipe_type === 'plated') return sum + i.quantity
    return sum + (i.quantity * i.batch_portions)
  }, 0)

  return (
    <div style={styles.page}>
      <div style={styles.topBar}>
        <button onClick={() => navigate('/event-orders')} style={styles.backBtn}>← Back</button>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {order.status === 'DRAFT' && (
            <button onClick={() => updateStatusMutation.mutate('FINALISED')} style={styles.secondaryBtn}>Finalise</button>
          )}
          {order.status === 'FINALISED' && (
            <button onClick={() => updateStatusMutation.mutate('ORDERED')} style={styles.primaryBtn}>Mark Ordered</button>
          )}
        </div>
      </div>

      <div style={styles.headerCard}>
        <div>
          <h2 style={{ margin: 0 }}>{order.name}</h2>
          {order.event_date && <div style={{ color: '#888', marginTop: '4px' }}>{order.event_date}</div>}
          {order.notes && <div style={{ color: '#666', marginTop: '4px', fontSize: '0.85rem' }}>{order.notes}</div>}
        </div>
        <span style={{
          background: order.status === 'DRAFT' ? '#f59e0b' : order.status === 'FINALISED' ? '#3b82f6' : '#22c55e',
          color: 'white', padding: '4px 12px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
        }}>
          {order.status}
        </span>
      </div>

      {/* Recipe items */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Recipes</h3>
          <button onClick={() => setShowAddRecipe(true)} style={styles.addBtn}>+ Add Recipe</button>
        </div>
        {order.items.length > 0 ? (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Recipe</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Quantity</th>
                <th style={styles.th}>Cost/Portion</th>
                <th style={styles.th}>Subtotal</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {order.items.map(item => (
                <tr key={item.id}>
                  <td style={styles.td}>
                    <span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => navigate(`/recipes/${item.recipe_id}`)}>
                      {item.recipe_name}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{ fontSize: '0.75rem', color: '#888' }}>
                      {item.recipe_type === 'component' ? `Component (${item.batch_portions} per batch)` : 'Plated'}
                    </span>
                  </td>
                  <td style={styles.td}>{item.quantity}</td>
                  <td style={styles.td}>{item.cost_per_portion != null ? `£${item.cost_per_portion.toFixed(2)}` : '-'}</td>
                  <td style={styles.td}>{item.subtotal != null ? `£${item.subtotal.toFixed(2)}` : '-'}</td>
                  <td style={styles.td}>
                    <button onClick={() => removeItemMutation.mutate(item.id)} style={styles.removeBtn}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #ddd' }}>
                <td colSpan={4} style={{ ...styles.td, fontWeight: 600, textAlign: 'right' }}>Total:</td>
                <td style={{ ...styles.td, fontWeight: 600 }}>£{totalCost.toFixed(2)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <div style={{ color: '#888', fontStyle: 'italic', padding: '1rem 0' }}>No recipes added yet</div>
        )}

        {order.items.length > 0 && (
          <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' }}>
            ~{totalServings} total servings | £{totalServings > 0 ? (totalCost / totalServings).toFixed(2) : '0.00'}/head
          </div>
        )}
      </div>

      {/* Shopping list */}
      {order.items.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <h3 style={{ margin: 0 }}>Shopping List</h3>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <label style={{ fontSize: '0.8rem' }}>
                <input type="checkbox" checked={groupBySupplier} onChange={(e) => setGroupBySupplier(e.target.checked)} />
                {' '}Group by supplier
              </label>
              <button onClick={() => setShowShopping(!showShopping)} style={styles.addBtn}>
                {showShopping ? 'Hide' : 'Show'} Shopping List
              </button>
            </div>
          </div>

          {showShopping && shoppingList && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Ingredient</th>
                  <th style={styles.th}>Category</th>
                  <th style={styles.th}>Qty Needed</th>
                  <th style={styles.th}>Adjusted (yield)</th>
                  <th style={styles.th}>Source</th>
                  <th style={styles.th}>Packs</th>
                  <th style={styles.th}>Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {shoppingList.items.map(item => (
                  <tr key={item.ingredient_id}>
                    <td style={styles.td}>{item.ingredient_name}</td>
                    <td style={styles.td}><span style={{ fontSize: '0.75rem', color: '#888' }}>{item.category}</span></td>
                    <td style={styles.td}>{item.total_quantity}{item.unit}</td>
                    <td style={styles.td}>
                      {item.adjusted_quantity !== item.total_quantity
                        ? <span style={{ color: '#e94560' }}>{item.adjusted_quantity}{item.unit}</span>
                        : `${item.adjusted_quantity}${item.unit}`
                      }
                    </td>
                    <td style={styles.td}>
                      {item.sources.length > 0
                        ? item.sources[0].supplier_name
                        : <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}>No source</span>
                      }
                    </td>
                    <td style={styles.td}>
                      {item.sources.length > 0 && item.sources[0].suggested_packs
                        ? `${item.sources[0].suggested_packs} × ${item.sources[0].pack_description || 'pack'}`
                        : '-'
                      }
                    </td>
                    <td style={styles.td}>
                      {item.sources.length > 0 && item.sources[0].subtotal != null
                        ? `£${item.sources[0].subtotal.toFixed(2)}`
                        : '-'
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Add recipe modal */}
      {showAddRecipe && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Add Recipe</h3>
              <button onClick={() => setShowAddRecipe(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Select Recipe</label>
              <select value={selectedRecipeId} onChange={(e) => setSelectedRecipeId(e.target.value)} style={styles.input}>
                <option value="">Select...</option>
                {recipes?.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.recipe_type}{r.recipe_type === 'component' ? `, batch: ${r.batch_portions}` : ''})
                  </option>
                ))}
              </select>
              <label style={styles.label}>
                Quantity ({selectedRecipeId && recipes?.find(r => r.id === parseInt(selectedRecipeId))?.recipe_type === 'component' ? 'batches' : 'servings'})
              </label>
              <input type="number" value={recipeQty} onChange={(e) => setRecipeQty(e.target.value)} style={styles.input} min="1" />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowAddRecipe(false)} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => addItemMutation.mutate({ recipe_id: parseInt(selectedRecipeId), quantity: parseInt(recipeQty) })}
                disabled={!selectedRecipeId || !recipeQty || addItemMutation.isPending}
                style={styles.primaryBtn}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  backBtn: { padding: '0.5rem 1rem', background: 'white', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer' },
  headerCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: 'white', padding: '1.25rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '1rem' },
  section: { background: 'white', padding: '1rem 1.25rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '1rem' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { padding: '0.5rem 0.5rem', textAlign: 'left' as const, borderBottom: '2px solid #e0e0e0', fontSize: '0.75rem', fontWeight: 600, color: '#666' },
  td: { padding: '0.4rem 0.5rem', fontSize: '0.85rem', borderBottom: '1px solid #f0f0f0' },
  addBtn: { padding: '0.35rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' },
  removeBtn: { padding: '2px 6px', background: 'none', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem', color: '#e94560' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 },
  secondaryBtn: { padding: '0.5rem 1rem', background: 'white', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer' },
  cancelBtn: { padding: '0.6rem 1.25rem', background: '#f0f0f0', color: '#333', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  loading: { padding: '3rem', textAlign: 'center' as const, color: '#888' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', borderRadius: '10px', width: '450px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #eee' },
  modalBody: { padding: '1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.25rem', borderTop: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#888' },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#555', marginTop: '0.75rem', marginBottom: '0.25rem' },
  input: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' as const },
}
