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

interface BySupplierItem {
  ingredient_name: string
  quantity_needed: number
  unit: string
  supplier_name: string
  product_code: string | null
  pack_description: string | null
  suggested_packs: number | null
  cost_per_pack: number | null
  subtotal: number | null
}

interface ShoppingListResponse {
  items: ShoppingListItem[]
  by_supplier: Record<string, BySupplierItem[]>
}

interface RecipeOption {
  id: number
  name: string
  recipe_type: string
  batch_portions: number
  cost_per_portion: number | null
}

interface MenuOption {
  id: number
  name: string
  description: string | null
  is_active: boolean
  item_count: number
  division_count: number
}

interface MenuDetail {
  id: number
  name: string
  divisions: Array<{
    id: number
    name: string
    items: Array<{
      id: number
      recipe_id: number | null
      display_name: string
      description: string | null
      is_archived: boolean
    }>
  }>
}

interface MenuDishEntry {
  recipe_id: number
  display_name: string
  division_name: string
  checked: boolean
  quantity: number
}

export default function EventOrderEditor() {
  const { id } = useParams<{ id: string }>()
  const orderId = parseInt(id || '0')
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Modal state: which modal is open
  const [addModalType, setAddModalType] = useState<'recipe' | 'dish' | 'menu' | null>(null)
  const [searchText, setSearchText] = useState('')
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null)
  const [recipeQty, setRecipeQty] = useState('1')

  // Menu modal state
  const [selectedMenuId, setSelectedMenuId] = useState<number | null>(null)
  const [menuDishes, setMenuDishes] = useState<MenuDishEntry[]>([])
  const [covers, setCovers] = useState('1')

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

  // Fetch recipes filtered by type for recipe/dish modals
  const recipeType = addModalType === 'recipe' ? 'component' : addModalType === 'dish' ? 'dish' : null
  const { data: recipes } = useQuery<RecipeOption[]>({
    queryKey: ['recipes-for-event', recipeType],
    queryFn: async () => {
      const res = await fetch(`/api/recipes?recipe_type=${recipeType}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token && (addModalType === 'recipe' || addModalType === 'dish'),
  })

  // Fetch menus for menu modal
  const { data: menus } = useQuery<MenuOption[]>({
    queryKey: ['menus-for-event'],
    queryFn: async () => {
      const res = await fetch('/api/menus', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token && addModalType === 'menu' && !selectedMenuId,
  })

  // Fetch selected menu detail
  const { data: menuDetail } = useQuery<MenuDetail>({
    queryKey: ['menu-detail-for-event', selectedMenuId],
    queryFn: async () => {
      const res = await fetch(`/api/menus/${selectedMenuId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token && !!selectedMenuId,
  })

  const { data: shoppingList } = useQuery<ShoppingListResponse>({
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
      closeModal()
    },
  })

  const bulkAddMutation = useMutation({
    mutationFn: async (items: Array<{ recipe_id: number; quantity: number; notes?: string }>) => {
      const res = await fetch(`/api/event-orders/${orderId}/items/bulk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['event-shopping-list', orderId] })
      closeModal()
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

  function closeModal() {
    setAddModalType(null)
    setSearchText('')
    setSelectedRecipeId(null)
    setRecipeQty('1')
    setSelectedMenuId(null)
    setMenuDishes([])
    setCovers('1')
  }

  // When menu detail loads, build the dishes list
  function handleMenuSelected(menuId: number) {
    setSelectedMenuId(menuId)
    setSearchText('')
  }

  // Populate menuDishes when menuDetail loads
  const populateMenuDishes = (detail: MenuDetail) => {
    const existingRecipeIds = new Set((order?.items || []).map(i => i.recipe_id))
    const dishes: MenuDishEntry[] = []
    for (const div of detail.divisions) {
      for (const item of div.items) {
        if (item.recipe_id && !item.is_archived) {
          dishes.push({
            recipe_id: item.recipe_id,
            display_name: item.display_name,
            division_name: div.name,
            checked: !existingRecipeIds.has(item.recipe_id),
            quantity: parseInt(covers) || 1,
          })
        }
      }
    }
    setMenuDishes(dishes)
  }

  // Effect: when menuDetail changes, populate
  if (menuDetail && menuDishes.length === 0 && selectedMenuId) {
    populateMenuDishes(menuDetail)
  }

  function handleCoversChange(val: string) {
    setCovers(val)
    const num = parseInt(val) || 1
    setMenuDishes(prev => prev.map(d => ({ ...d, quantity: num })))
  }

  function handleMenuDishQty(idx: number, val: string) {
    setMenuDishes(prev => prev.map((d, i) => i === idx ? { ...d, quantity: parseInt(val) || 0 } : d))
  }

  function handleMenuDishToggle(idx: number) {
    setMenuDishes(prev => prev.map((d, i) => i === idx ? { ...d, checked: !d.checked } : d))
  }

  function handleBulkAdd() {
    const items = menuDishes
      .filter(d => d.checked && d.quantity > 0)
      .map(d => ({
        recipe_id: d.recipe_id,
        quantity: d.quantity,
        notes: `From menu: ${menuDetail?.name || ''}`,
      }))
    if (items.length > 0) bulkAddMutation.mutate(items)
  }

  if (!order) return <div style={styles.loading}>Loading event order...</div>

  const totalCost = order.items.reduce((sum, i) => sum + (i.subtotal || 0), 0)
  const totalServings = order.items.reduce((sum, i) => {
    if (i.recipe_type === 'dish') return sum + i.quantity
    return sum + (i.quantity * i.batch_portions)
  }, 0)

  // Filter recipes by search
  const filteredRecipes = (recipes || []).filter(r =>
    !searchText || r.name.toLowerCase().includes(searchText.toLowerCase())
  )

  // Filter menus by search
  const activeMenus = (menus || []).filter(m => m.is_active)
  const filteredMenus = activeMenus.filter(m =>
    !searchText || m.name.toLowerCase().includes(searchText.toLowerCase())
  )

  // Supplier grouped data
  const bySupplier = shoppingList?.by_supplier || {}
  const supplierNames = Object.keys(bySupplier).sort()

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

      {/* Items */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ margin: 0 }}>Items</h3>
          <div style={{ display: 'flex', gap: '0.35rem' }}>
            <button onClick={() => setAddModalType('recipe')} style={styles.addBtn}>+ Recipe</button>
            <button onClick={() => setAddModalType('dish')} style={styles.addBtn}>+ Dish</button>
            <button onClick={() => setAddModalType('menu')} style={{ ...styles.addBtn, background: '#eff6ff', borderColor: '#93c5fd' }}>+ Menu</button>
          </div>
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
                    {item.notes && (
                      <span style={{ fontSize: '0.7rem', color: '#999', marginLeft: '0.5rem' }}>{item.notes}</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <span style={{ fontSize: '0.75rem', color: '#888' }}>
                      {item.recipe_type === 'component' ? `Component (${item.batch_portions} per batch)` : 'Dish'}
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
          <div style={{ color: '#888', fontStyle: 'italic', padding: '1rem 0' }}>No items added yet</div>
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

          {showShopping && shoppingList && !groupBySupplier && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Ingredient</th>
                  <th style={styles.th}>Category</th>
                  <th style={styles.th}>Quantity</th>
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
                    <td style={styles.td}>{item.adjusted_quantity}{item.unit}</td>
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

          {showShopping && shoppingList && groupBySupplier && (
            <div>
              {supplierNames.length === 0 && (
                <p style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>No supplier data available</p>
              )}
              {supplierNames.map(supplier => {
                const items = bySupplier[supplier]
                const supplierTotal = items.reduce((sum, i) => sum + (i.subtotal || 0), 0)
                return (
                  <div key={supplier} style={{ marginBottom: '1rem' }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.4rem 0.5rem', background: '#f8f9fa', borderRadius: '4px', marginBottom: '0.25rem',
                    }}>
                      <strong style={{ fontSize: '0.85rem' }}>{supplier}</strong>
                      {supplierTotal > 0 && (
                        <span style={{ fontSize: '0.8rem', color: '#666' }}>£{supplierTotal.toFixed(2)}</span>
                      )}
                    </div>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>Ingredient</th>
                          <th style={styles.th}>Quantity</th>
                          <th style={styles.th}>Packs</th>
                          <th style={styles.th}>Est. Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item, idx) => (
                          <tr key={idx}>
                            <td style={styles.td}>{item.ingredient_name}</td>
                            <td style={styles.td}>{item.quantity_needed}{item.unit}</td>
                            <td style={styles.td}>
                              {item.suggested_packs
                                ? `${item.suggested_packs} × ${item.pack_description || 'pack'}`
                                : '-'
                              }
                            </td>
                            <td style={styles.td}>
                              {item.subtotal != null ? `£${item.subtotal.toFixed(2)}` : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })}
              {/* Show unsourced ingredients */}
              {shoppingList.items.filter(i => i.sources.length === 0).length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{
                    padding: '0.4rem 0.5rem', background: '#fef3c7', borderRadius: '4px', marginBottom: '0.25rem',
                  }}>
                    <strong style={{ fontSize: '0.85rem', color: '#92400e' }}>No Supplier</strong>
                  </div>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Ingredient</th>
                        <th style={styles.th}>Category</th>
                        <th style={styles.th}>Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shoppingList.items.filter(i => i.sources.length === 0).map(item => (
                        <tr key={item.ingredient_id}>
                          <td style={styles.td}>{item.ingredient_name}</td>
                          <td style={styles.td}><span style={{ fontSize: '0.75rem', color: '#888' }}>{item.category}</span></td>
                          <td style={styles.td}>{item.adjusted_quantity}{item.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add Recipe / Add Dish modal */}
      {(addModalType === 'recipe' || addModalType === 'dish') && (
        <div style={styles.overlay} onClick={closeModal}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Add {addModalType === 'recipe' ? 'Recipe' : 'Dish'}</h3>
              <button onClick={closeModal} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <input
                type="text"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder={`Search ${addModalType === 'recipe' ? 'recipes' : 'dishes'}...`}
                style={styles.input}
                autoFocus
              />
              <div style={{ maxHeight: '250px', overflow: 'auto', border: '1px solid #eee', borderRadius: '6px', marginTop: '0.5rem' }}>
                {filteredRecipes.map(r => (
                  <div
                    key={r.id}
                    onClick={() => setSelectedRecipeId(r.id)}
                    style={{
                      padding: '0.5rem 0.75rem',
                      cursor: 'pointer',
                      background: selectedRecipeId === r.id ? '#eff6ff' : '#fff',
                      borderBottom: '1px solid #f3f4f6',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: selectedRecipeId === r.id ? 600 : 400, fontSize: '0.9rem' }}>
                      {r.name}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: '#888' }}>
                      {addModalType === 'recipe'
                        ? `batch: ${r.batch_portions}`
                        : r.cost_per_portion != null ? `£${r.cost_per_portion.toFixed(2)}/portion` : ''
                      }
                    </span>
                  </div>
                ))}
                {filteredRecipes.length === 0 && (
                  <p style={{ padding: '0.75rem', color: '#999', textAlign: 'center', margin: 0, fontSize: '0.85rem' }}>
                    No {addModalType === 'recipe' ? 'recipes' : 'dishes'} found
                  </p>
                )}
              </div>
              {selectedRecipeId && (
                <>
                  <label style={styles.label}>
                    Quantity ({addModalType === 'recipe' ? 'batches' : 'servings'})
                  </label>
                  <input type="number" value={recipeQty} onChange={e => setRecipeQty(e.target.value)} style={styles.input} min="1" />
                </>
              )}
            </div>
            <div style={styles.modalFooter}>
              <button onClick={closeModal} style={styles.cancelBtn}>Cancel</button>
              <button
                onClick={() => selectedRecipeId && addItemMutation.mutate({ recipe_id: selectedRecipeId, quantity: parseInt(recipeQty) || 1 })}
                disabled={!selectedRecipeId || !recipeQty || addItemMutation.isPending}
                style={styles.primaryBtn}
              >
                {addItemMutation.isPending ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Menu modal */}
      {addModalType === 'menu' && (
        <div style={styles.overlay} onClick={closeModal}>
          <div style={{ ...styles.modal, width: '600px' }} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>
                {selectedMenuId ? `Add from: ${menuDetail?.name || 'Loading...'}` : 'Add Menu'}
              </h3>
              <button onClick={closeModal} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              {!selectedMenuId && (
                <>
                  <input
                    type="text"
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    placeholder="Search menus..."
                    style={styles.input}
                    autoFocus
                  />
                  <div style={{ maxHeight: '300px', overflow: 'auto', border: '1px solid #eee', borderRadius: '6px', marginTop: '0.5rem' }}>
                    {filteredMenus.map(m => (
                      <div
                        key={m.id}
                        onClick={() => handleMenuSelected(m.id)}
                        style={{
                          padding: '0.6rem 0.75rem',
                          cursor: 'pointer',
                          borderBottom: '1px solid #f3f4f6',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                      >
                        <div>
                          <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{m.name}</span>
                          {m.description && <div style={{ fontSize: '0.75rem', color: '#888' }}>{m.description}</div>}
                        </div>
                        <span style={{ fontSize: '0.75rem', color: '#888' }}>
                          {m.item_count} dish{m.item_count !== 1 ? 'es' : ''}
                        </span>
                      </div>
                    ))}
                    {filteredMenus.length === 0 && (
                      <p style={{ padding: '0.75rem', color: '#999', textAlign: 'center', margin: 0, fontSize: '0.85rem' }}>
                        No active menus found
                      </p>
                    )}
                  </div>
                </>
              )}

              {selectedMenuId && menuDishes.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#555', whiteSpace: 'nowrap' }}>Covers:</label>
                    <input
                      type="number"
                      value={covers}
                      onChange={e => handleCoversChange(e.target.value)}
                      style={{ ...styles.input, width: '80px' }}
                      min="1"
                    />
                    <span style={{ fontSize: '0.75rem', color: '#888' }}>Sets quantity for all dishes</span>
                  </div>
                  <div style={{ maxHeight: '350px', overflow: 'auto', border: '1px solid #eee', borderRadius: '6px' }}>
                    <table style={{ ...styles.table, fontSize: '0.85rem' }}>
                      <thead>
                        <tr>
                          <th style={{ ...styles.th, width: '30px' }}></th>
                          <th style={styles.th}>Dish</th>
                          <th style={styles.th}>Section</th>
                          <th style={{ ...styles.th, width: '80px' }}>Qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {menuDishes.map((dish, idx) => {
                          const alreadyOnOrder = (order?.items || []).some(i => i.recipe_id === dish.recipe_id)
                          return (
                            <tr key={idx} style={{ opacity: alreadyOnOrder ? 0.5 : 1 }}>
                              <td style={styles.td}>
                                <input
                                  type="checkbox"
                                  checked={dish.checked}
                                  onChange={() => handleMenuDishToggle(idx)}
                                  disabled={alreadyOnOrder}
                                />
                              </td>
                              <td style={styles.td}>
                                {dish.display_name}
                                {alreadyOnOrder && <span style={{ fontSize: '0.7rem', color: '#f59e0b', marginLeft: '0.5rem' }}>already added</span>}
                              </td>
                              <td style={styles.td}>
                                <span style={{ fontSize: '0.75rem', color: '#888' }}>{dish.division_name}</span>
                              </td>
                              <td style={styles.td}>
                                <input
                                  type="number"
                                  value={dish.quantity}
                                  onChange={e => handleMenuDishQty(idx, e.target.value)}
                                  style={{ width: '60px', padding: '0.25rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.85rem', textAlign: 'center' }}
                                  min="0"
                                  disabled={!dish.checked || alreadyOnOrder}
                                />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {selectedMenuId && menuDishes.length === 0 && menuDetail && (
                <p style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85rem' }}>No dishes on this menu</p>
              )}
            </div>
            <div style={styles.modalFooter}>
              {selectedMenuId && (
                <button onClick={() => { setSelectedMenuId(null); setMenuDishes([]); setSearchText('') }} style={styles.cancelBtn}>
                  ← Back
                </button>
              )}
              <button onClick={closeModal} style={styles.cancelBtn}>Cancel</button>
              {selectedMenuId && (
                <button
                  onClick={handleBulkAdd}
                  disabled={menuDishes.filter(d => d.checked && d.quantity > 0).length === 0 || bulkAddMutation.isPending}
                  style={styles.primaryBtn}
                >
                  {bulkAddMutation.isPending ? 'Adding...' : `Add ${menuDishes.filter(d => d.checked && d.quantity > 0).length} Dishes`}
                </button>
              )}
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
