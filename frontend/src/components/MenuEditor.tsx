import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useNavigate, useParams } from 'react-router-dom'
import PublishToMenuModal from './PublishToMenuModal'
import BulkPublishModal from './BulkPublishModal'
import MenuFlagMatrix from './MenuFlagMatrix'

interface MenuItem {
  id: number
  recipe_id: number | null
  display_name: string
  description: string | null
  price: string | null
  sort_order: number
  snapshot_json: Record<string, unknown> | null
  confirmed_by_name: string | null
  confirmed_by_user_id: number | null
  published_at: string | null
  has_image: boolean
  is_stale: boolean
  stale_reason: string | null
  is_archived: boolean
}

interface Division {
  id: number
  name: string
  sort_order: number
  items: MenuItem[]
}

interface MenuDetail {
  id: number
  name: string
  description: string | null
  notes: string | null
  is_active: boolean
  sort_order: number
  divisions: Division[]
}

export default function MenuEditor() {
  const { id } = useParams<{ id: string }>()
  const menuId = parseInt(id || '0')
  const { token, user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descValue, setDescValue] = useState('')
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')

  // Division management
  const [showAddDiv, setShowAddDiv] = useState(false)
  const [newDivName, setNewDivName] = useState('')
  const [editingDivId, setEditingDivId] = useState<number | null>(null)
  const [editingDivName, setEditingDivName] = useState('')
  const [sortingDivs, setSortingDivs] = useState(false)
  const [divDragIdx, setDivDragIdx] = useState<number | null>(null)
  const [divDragOverIdx, setDivDragOverIdx] = useState<number | null>(null)

  // Item management
  const [sortingItems, setSortingItems] = useState<number | null>(null) // division_id being sorted
  const [itemDragIdx, setItemDragIdx] = useState<number | null>(null)
  const [itemDragOverIdx, setItemDragOverIdx] = useState<number | null>(null)
  const [editingItemId, setEditingItemId] = useState<number | null>(null)
  const [editItemName, setEditItemName] = useState('')
  const [editItemDesc, setEditItemDesc] = useState('')
  const [editItemPrice, setEditItemPrice] = useState('')
  const [editItemDivId, setEditItemDivId] = useState<number | null>(null)

  // Modals
  const [publishDivId, setPublishDivId] = useState<number | null>(null)
  const [bulkDivId, setBulkDivId] = useState<number | null>(null)
  const [showFlagMatrix, setShowFlagMatrix] = useState(false)
  const [showBatchRepublish, setShowBatchRepublish] = useState(false)
  const [batchConfirmedBy, setBatchConfirmedBy] = useState('')
  const [collapsedDivs, setCollapsedDivs] = useState<Set<number>>(new Set())

  const { data: menu, isLoading } = useQuery<MenuDetail>({
    queryKey: ['menu', menuId],
    queryFn: async () => {
      const res = await fetch(`/api/menus/${menuId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch menu')
      return res.json()
    },
    enabled: !!token && menuId > 0,
  })

  // Mutations
  const updateMenuMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch(`/api/menus/${menuId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const addDivMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/menus/${menuId}/divisions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to add division')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menu', menuId] })
      setShowAddDiv(false)
      setNewDivName('')
    },
  })

  const updateDivMutation = useMutation({
    mutationFn: async ({ divId, name }: { divId: number; name: string }) => {
      const res = await fetch(`/api/menus/${menuId}/divisions/${divId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to rename')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menu', menuId] })
      setEditingDivId(null)
    },
  })

  const deleteDivMutation = useMutation({
    mutationFn: async (divId: number) => {
      const res = await fetch(`/api/menus/${menuId}/divisions/${divId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const reorderDivsMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch(`/api/menus/${menuId}/divisions/reorder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error('Failed to reorder')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const updateItemMutation = useMutation({
    mutationFn: async ({ itemId, data }: { itemId: number; data: Record<string, unknown> }) => {
      const res = await fetch(`/api/menus/${menuId}/items/${itemId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menu', menuId] })
      setEditingItemId(null)
    },
  })

  const deleteItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/menus/${menuId}/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to remove')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const republishMutation = useMutation({
    mutationFn: async ({ itemId, confirmed_by_name }: { itemId: number; confirmed_by_name: string }) => {
      const res = await fetch(`/api/menus/${menuId}/items/${itemId}/republish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed_by_name }),
      })
      if (!res.ok) throw new Error('Failed to republish')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const reorderItemsMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch(`/api/menus/${menuId}/items/reorder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error('Failed to reorder')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const batchRepublishMutation = useMutation({
    mutationFn: async (body: { confirmed_by_name: string; items: Array<{ id: number; confirmed: boolean }> }) => {
      const res = await fetch(`/api/menus/${menuId}/republish-stale`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to batch republish')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menu', menuId] })
      setShowBatchRepublish(false)
    },
  })

  const uploadImageMutation = useMutation({
    mutationFn: async ({ itemId, file }: { itemId: number; file: File }) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`/api/menus/${menuId}/items/${itemId}/image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (!res.ok) throw new Error('Failed to upload image')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  const deleteImageMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/menus/${menuId}/items/${itemId}/image`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete image')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menu', menuId] }),
  })

  if (isLoading) return <div style={{ padding: '2rem' }}>Loading...</div>
  if (!menu) return <div style={{ padding: '2rem' }}>Menu not found</div>

  const allItems = menu.divisions.flatMap(d => d.items)
  const staleCount = allItems.filter(i => i.is_stale).length
  const archivedCount = allItems.filter(i => i.is_archived).length

  const handleDivDrop = () => {
    if (divDragIdx === null || divDragOverIdx === null) return
    const sorted = [...menu.divisions]
    const [moved] = sorted.splice(divDragIdx, 1)
    sorted.splice(divDragOverIdx, 0, moved)
    reorderDivsMutation.mutate(sorted.map(d => d.id))
    setDivDragIdx(null)
    setDivDragOverIdx(null)
  }

  const handleItemDrop = (divItems: MenuItem[]) => {
    if (itemDragIdx === null || itemDragOverIdx === null) return
    const sorted = [...divItems]
    const [moved] = sorted.splice(itemDragIdx, 1)
    sorted.splice(itemDragOverIdx, 0, moved)
    reorderItemsMutation.mutate(sorted.map(i => i.id))
    setItemDragIdx(null)
    setItemDragOverIdx(null)
  }

  const toggleCollapse = (divId: number) => {
    const next = new Set(collapsedDivs)
    if (next.has(divId)) next.delete(divId)
    else next.add(divId)
    setCollapsedDivs(next)
  }

  const staleItems = allItems.filter(i => i.is_stale && !i.is_archived)

  return (
    <div style={styles.container}>
      {/* Back button */}
      <button onClick={() => navigate('/menus')} style={styles.backBtn}>← Menus</button>

      {/* Header */}
      <div style={styles.menuHeader}>
        <div style={{ flex: 1 }}>
          {editingName ? (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input value={nameValue} onChange={(e) => setNameValue(e.target.value)} style={styles.input} autoFocus />
              <button onClick={() => { updateMenuMutation.mutate({ name: nameValue }); setEditingName(false) }} style={styles.btnPrimary}>Save</button>
              <button onClick={() => setEditingName(false)} style={styles.btn}>Cancel</button>
            </div>
          ) : (
            <h2 style={{ margin: 0, cursor: 'pointer' }} onClick={() => { setNameValue(menu.name); setEditingName(true) }}>
              {menu.name}
            </h2>
          )}

          {editingDesc ? (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <input value={descValue} onChange={(e) => setDescValue(e.target.value)} style={styles.input} placeholder="Customer-facing description" />
              <button onClick={() => { updateMenuMutation.mutate({ description: descValue }); setEditingDesc(false) }} style={styles.btnSmall}>Save</button>
              <button onClick={() => setEditingDesc(false)} style={styles.btnSmall}>Cancel</button>
            </div>
          ) : (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: '#666', cursor: 'pointer' }}
              onClick={() => { setDescValue(menu.description || ''); setEditingDesc(true) }}>
              {menu.description || 'Click to add description...'}
            </p>
          )}

          {editingNotes ? (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <input value={notesValue} onChange={(e) => setNotesValue(e.target.value)} style={styles.input} placeholder="Internal notes" />
              <button onClick={() => { updateMenuMutation.mutate({ notes: notesValue }); setEditingNotes(false) }} style={styles.btnSmall}>Save</button>
              <button onClick={() => setEditingNotes(false)} style={styles.btnSmall}>Cancel</button>
            </div>
          ) : (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#999', cursor: 'pointer', fontStyle: 'italic' }}
              onClick={() => { setNotesValue(menu.notes || ''); setEditingNotes(true) }}>
              {menu.notes ? `Notes: ${menu.notes}` : 'Click to add internal notes...'}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <button
            onClick={() => updateMenuMutation.mutate({ is_active: !menu.is_active })}
            style={{
              ...styles.btn,
              background: menu.is_active ? '#dcfce7' : '#f3f4f6',
              color: menu.is_active ? '#166534' : '#6b7280',
              border: 'none',
            }}
          >
            {menu.is_active ? 'Active' : 'Inactive'}
          </button>
          {staleCount > 0 && (
            <button onClick={() => { setBatchConfirmedBy(user?.name || ''); setShowBatchRepublish(true) }} style={{ ...styles.btn, background: '#fef3c7', color: '#92400e', border: 'none' }}>
              Republish All Stale ({staleCount})
            </button>
          )}
          <button onClick={() => setShowFlagMatrix(true)} style={styles.btn}>Print Flag Matrix</button>
        </div>
      </div>

      {/* Notification bars */}
      {staleCount > 0 && (
        <div style={{ ...styles.notifBar, background: '#fef3c7', borderColor: '#f59e0b' }}>
          {staleCount} item{staleCount !== 1 ? 's' : ''} need{staleCount === 1 ? 's' : ''} republishing
        </div>
      )}
      {archivedCount > 0 && (
        <div style={{ ...styles.notifBar, background: '#fee2e2', borderColor: '#ef4444' }}>
          {archivedCount} dish{archivedCount !== 1 ? 'es have' : ' has'} been archived and should be removed
        </div>
      )}

      {/* Divisions */}
      <div style={styles.divHeader}>
        <h3 style={{ margin: 0 }}>Sections</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {menu.divisions.length > 1 && (
            <button onClick={() => setSortingDivs(!sortingDivs)} style={{ ...styles.btn, background: sortingDivs ? '#3b82f6' : undefined, color: sortingDivs ? '#fff' : undefined }}>
              {sortingDivs ? 'Done' : 'Sort'}
            </button>
          )}
          <button onClick={() => setShowAddDiv(true)} style={styles.btnPrimary}>+ Add Section</button>
        </div>
      </div>

      {showAddDiv && (
        <div style={styles.inlineForm}>
          <input value={newDivName} onChange={(e) => setNewDivName(e.target.value)} style={styles.input} placeholder="Section name" autoFocus />
          <button onClick={() => { if (newDivName.trim()) addDivMutation.mutate(newDivName.trim()) }} style={styles.btnPrimary} disabled={!newDivName.trim()}>Add</button>
          <button onClick={() => { setShowAddDiv(false); setNewDivName('') }} style={styles.btn}>Cancel</button>
        </div>
      )}

      {menu.divisions.length === 0 && (
        <p style={{ color: '#666', padding: '1rem' }}>No sections yet. Add a section to start publishing dishes.</p>
      )}

      {menu.divisions.map((div, divIdx) => (
        <div
          key={div.id}
          style={{
            ...styles.divisionCard,
            opacity: sortingDivs && divDragIdx === divIdx ? 0.4 : 1,
            background: sortingDivs && divDragOverIdx === divIdx ? '#e0f2fe' : '#fff',
          }}
          draggable={sortingDivs}
          onDragStart={() => setDivDragIdx(divIdx)}
          onDragOver={(e) => { if (sortingDivs) { e.preventDefault(); setDivDragOverIdx(divIdx) } }}
          onDrop={() => { if (sortingDivs) handleDivDrop() }}
          onDragEnd={() => { setDivDragIdx(null); setDivDragOverIdx(null) }}
        >
          <div style={styles.divisionHeader} onClick={() => toggleCollapse(div.id)}>
            {sortingDivs && <span style={styles.dragHandle}>☰</span>}
            <span style={{ cursor: 'pointer', userSelect: 'none' }}>{collapsedDivs.has(div.id) ? '▶' : '▼'}</span>
            {editingDivId === div.id ? (
              <div style={{ display: 'flex', gap: '0.5rem', flex: 1 }} onClick={(e) => e.stopPropagation()}>
                <input value={editingDivName} onChange={(e) => setEditingDivName(e.target.value)} style={styles.input} autoFocus />
                <button onClick={() => updateDivMutation.mutate({ divId: div.id, name: editingDivName })} style={styles.btnSmall}>Save</button>
                <button onClick={() => setEditingDivId(null)} style={styles.btnSmall}>Cancel</button>
              </div>
            ) : (
              <>
                <span style={{ fontWeight: 600, flex: 1 }}>{div.name}</span>
                <span style={{ fontSize: '0.8rem', color: '#999' }}>{div.items.length} item{div.items.length !== 1 ? 's' : ''}</span>
              </>
            )}
            <div style={{ display: 'flex', gap: '0.25rem' }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setEditingDivId(div.id); setEditingDivName(div.name) }} style={styles.btnTiny}>Rename</button>
              <button onClick={() => setPublishDivId(div.id)} style={{ ...styles.btnTiny, background: '#eff6ff', color: '#2563eb' }}>+ Dish</button>
              <button onClick={() => setBulkDivId(div.id)} style={{ ...styles.btnTiny, background: '#f0fdf4', color: '#166534' }}>+ Bulk</button>
              <button
                onClick={() => {
                  const msg = div.items.length > 0
                    ? `Delete "${div.name}" and its ${div.items.length} item(s)?`
                    : `Delete "${div.name}"?`
                  if (confirm(msg)) deleteDivMutation.mutate(div.id)
                }}
                style={{ ...styles.btnTiny, color: '#dc2626' }}
              >
                Delete
              </button>
            </div>
          </div>

          {!collapsedDivs.has(div.id) && (
            <div style={styles.itemsList}>
              {div.items.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0.25rem 0' }}>
                  <button
                    onClick={() => setSortingItems(sortingItems === div.id ? null : div.id)}
                    style={{ ...styles.btnTiny, background: sortingItems === div.id ? '#3b82f6' : undefined, color: sortingItems === div.id ? '#fff' : undefined }}
                  >
                    {sortingItems === div.id ? 'Done' : 'Sort'}
                  </button>
                </div>
              )}
              {div.items.map((item, itemIdx) => (
                <div
                  key={item.id}
                  style={{
                    ...styles.itemRow,
                    opacity: item.is_archived ? 0.5 : (sortingItems === div.id && itemDragIdx === itemIdx ? 0.4 : 1),
                    background: sortingItems === div.id && itemDragOverIdx === itemIdx ? '#e0f2fe' : (item.is_archived ? '#f9fafb' : 'transparent'),
                  }}
                  draggable={sortingItems === div.id}
                  onDragStart={() => setItemDragIdx(itemIdx)}
                  onDragOver={(e) => { if (sortingItems === div.id) { e.preventDefault(); setItemDragOverIdx(itemIdx) } }}
                  onDrop={() => { if (sortingItems === div.id) handleItemDrop(div.items) }}
                  onDragEnd={() => { setItemDragIdx(null); setItemDragOverIdx(null) }}
                >
                  {sortingItems === div.id && <span style={styles.dragHandle}>☰</span>}

                  {/* Image thumbnail */}
                  {item.has_image ? (
                    <img
                      src={`/api/menus/${menuId}/items/${item.id}/image?token=${token}`}
                      alt=""
                      style={styles.thumbnail}
                    />
                  ) : (
                    <div style={styles.thumbnailPlaceholder}>
                      <label style={{ cursor: 'pointer', fontSize: '0.7rem', color: '#999' }}>
                        + img
                        <input
                          type="file"
                          accept="image/*"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (f) uploadImageMutation.mutate({ itemId: item.id, file: f })
                          }}
                        />
                      </label>
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingItemId === item.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }} onClick={(e) => e.stopPropagation()}>
                        <input value={editItemName} onChange={(e) => setEditItemName(e.target.value)} style={styles.inputSm} placeholder="Display name" />
                        <input value={editItemDesc} onChange={(e) => setEditItemDesc(e.target.value)} style={styles.inputSm} placeholder="Description" />
                        <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                          <input value={editItemPrice} onChange={(e) => setEditItemPrice(e.target.value)} style={{ ...styles.inputSm, width: '80px' }} placeholder="Price" />
                          <select
                            value={editItemDivId || ''}
                            onChange={(e) => setEditItemDivId(parseInt(e.target.value))}
                            style={styles.inputSm}
                          >
                            {menu.divisions.map(d => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </select>
                          <button onClick={() => {
                            const data: Record<string, unknown> = {}
                            if (editItemName) data.display_name = editItemName
                            if (editItemDesc !== undefined) data.description = editItemDesc
                            if (editItemPrice) data.price = parseFloat(editItemPrice)
                            if (editItemDivId && editItemDivId !== div.id) data.division_id = editItemDivId
                            updateItemMutation.mutate({ itemId: item.id, data })
                          }} style={styles.btnSmall}>Save</button>
                          <button onClick={() => setEditingItemId(null)} style={styles.btnSmall}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 500 }}>{item.display_name}</span>
                          {item.price && <span style={{ color: '#666', fontSize: '0.875rem' }}>£{item.price}</span>}
                          {item.is_archived && <span style={{ ...styles.badgeSm, background: '#fee2e2', color: '#dc2626' }}>Archived</span>}
                          {item.is_stale && <span style={{ ...styles.badgeSm, background: '#fef3c7', color: '#92400e' }} title={item.stale_reason || ''}>Needs Republishing</span>}
                        </div>
                        {item.description && <p style={{ margin: '0.125rem 0 0', fontSize: '0.8rem', color: '#666' }}>{item.description}</p>}
                        {/* Flag badges from snapshot */}
                        {item.snapshot_json && (item.snapshot_json as any).confirmed_flags && (
                          <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                            {((item.snapshot_json as any).confirmed_flags as Array<{ code?: string; name: string }>).map((f, i) => (
                              <span key={i} style={{ ...styles.flagBadge }}>{f.code || f.name}</span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {editingItemId !== item.id && (
                    <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                      <button onClick={() => {
                        setEditingItemId(item.id)
                        setEditItemName(item.display_name)
                        setEditItemDesc(item.description || '')
                        setEditItemPrice(item.price || '')
                        setEditItemDivId(div.id)
                      }} style={styles.btnTiny}>Edit</button>
                      {item.is_stale && !item.is_archived && (
                        <button
                          onClick={() => {
                            const name = prompt('Confirmed by:', user?.name || '')
                            if (name) republishMutation.mutate({ itemId: item.id, confirmed_by_name: name })
                          }}
                          style={{ ...styles.btnTiny, background: '#fef3c7', color: '#92400e' }}
                        >
                          Republish
                        </button>
                      )}
                      {item.has_image && (
                        <button onClick={() => { if (confirm('Remove image?')) deleteImageMutation.mutate(item.id) }} style={{ ...styles.btnTiny, color: '#dc2626' }}>- img</button>
                      )}
                      {!item.has_image && (
                        <label style={{ ...styles.btnTiny, background: '#f0fdf4', color: '#166534', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                          + img
                          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (f) uploadImageMutation.mutate({ itemId: item.id, file: f })
                          }} />
                        </label>
                      )}
                      <button
                        onClick={() => { if (confirm(`Remove "${item.display_name}" from menu?`)) deleteItemMutation.mutate(item.id) }}
                        style={{ ...styles.btnTiny, color: '#dc2626' }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {div.items.length === 0 && (
                <p style={{ color: '#999', fontSize: '0.875rem', padding: '0.5rem 0' }}>
                  No dishes in this section.{' '}
                  <button onClick={() => setPublishDivId(div.id)} style={{ ...styles.btnTiny, background: '#eff6ff', color: '#2563eb' }}>+ Add Dish</button>
                </p>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Publish Modal */}
      {publishDivId !== null && (
        <PublishToMenuModal
          menuId={menuId}
          menuName={menu.name}
          divisions={menu.divisions}
          preSelectedDivisionId={publishDivId}
          onClose={() => setPublishDivId(null)}
          onPublished={() => {
            queryClient.invalidateQueries({ queryKey: ['menu', menuId] })
            setPublishDivId(null)
          }}
        />
      )}

      {/* Bulk Publish Modal */}
      {bulkDivId !== null && (
        <BulkPublishModal
          menuId={menuId}
          divisionId={bulkDivId}
          divisionName={menu.divisions.find(d => d.id === bulkDivId)?.name || ''}
          onClose={() => setBulkDivId(null)}
          onPublished={() => {
            queryClient.invalidateQueries({ queryKey: ['menu', menuId] })
            setBulkDivId(null)
          }}
        />
      )}

      {/* Flag Matrix Modal */}
      {showFlagMatrix && (
        <MenuFlagMatrix menuId={menuId} menuName={menu.name} onClose={() => setShowFlagMatrix(false)} />
      )}

      {/* Batch Republish Modal */}
      {showBatchRepublish && (
        <div style={styles.overlay} onClick={() => setShowBatchRepublish(false)}>
          <div style={{ ...styles.modal, maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>Batch Republish Stale Items</h3>
            <p style={{ fontSize: '0.875rem', color: '#666', marginBottom: '1rem' }}>
              {staleItems.length} item{staleItems.length !== 1 ? 's' : ''} will be republished with updated allergen information.
            </p>
            <div style={{ maxHeight: '300px', overflow: 'auto', marginBottom: '1rem' }}>
              {staleItems.map(item => {
                const flags = item.snapshot_json ? ((item.snapshot_json as any).confirmed_flags || []) : []
                return (
                  <div key={item.id} style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                    <span style={{ fontWeight: 500 }}>{item.display_name}</span>
                    {item.stale_reason && <span style={{ fontSize: '0.75rem', color: '#92400e', marginLeft: '0.5rem' }}>({item.stale_reason})</span>}
                    <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                      {flags.map((f: any, i: number) => (
                        <span key={i} style={styles.flagBadge}>{f.code || f.name}</span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            <label style={styles.label}>Confirmed by *</label>
            <input value={batchConfirmedBy} onChange={(e) => setBatchConfirmedBy(e.target.value)} style={styles.input} />
            <div style={styles.modalActions}>
              <button onClick={() => setShowBatchRepublish(false)} style={styles.btn}>Cancel</button>
              <button
                onClick={() => batchRepublishMutation.mutate({
                  confirmed_by_name: batchConfirmedBy,
                  items: staleItems.map(i => ({ id: i.id, confirmed: true })),
                })}
                style={styles.btnPrimary}
                disabled={!batchConfirmedBy.trim() || batchRepublishMutation.isPending}
              >
                {batchRepublishMutation.isPending ? 'Republishing...' : `Republish ${staleItems.length} Items`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: '1000px', margin: '0 auto', padding: '1rem' },
  backBtn: { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: '0.875rem', padding: '0.25rem 0', marginBottom: '0.5rem' },
  menuHeader: { display: 'flex', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' },
  notifBar: { padding: '0.5rem 1rem', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.5rem', borderLeft: '4px solid' },
  divHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', marginTop: '1rem' },
  divisionCard: { border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '0.5rem', overflow: 'hidden' },
  divisionHeader: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', background: '#f9fafb', cursor: 'pointer', borderBottom: '1px solid #e5e7eb' },
  dragHandle: { cursor: 'grab', fontSize: '1rem', color: '#999' },
  itemsList: { padding: '0.5rem 1rem' },
  itemRow: { display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid #f3f4f6' },
  thumbnail: { width: '48px', height: '48px', objectFit: 'cover', borderRadius: '4px', flexShrink: 0 },
  thumbnailPlaceholder: { width: '48px', height: '48px', border: '1px dashed #ddd', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  flagBadge: { padding: '1px 6px', background: '#f3f4f6', borderRadius: '4px', fontSize: '0.7rem', color: '#374151' },
  badgeSm: { padding: '1px 6px', borderRadius: '10px', fontSize: '0.7rem', fontWeight: 500 },
  btn: { padding: '0.4rem 0.75rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnPrimary: { padding: '0.4rem 0.75rem', border: 'none', borderRadius: '4px', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnSmall: { padding: '0.25rem 0.5rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.75rem' },
  btnTiny: { padding: '2px 6px', border: '1px solid #e5e7eb', borderRadius: '3px', background: '#fff', cursor: 'pointer', fontSize: '0.7rem' },
  inlineForm: { display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' },
  input: { padding: '0.4rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.875rem', flex: 1 },
  inputSm: { padding: '0.25rem 0.4rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.8rem' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: '8px', padding: '1.5rem', width: '90%', maxWidth: '500px' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' },
  label: { display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem', marginTop: '0.5rem' },
}
