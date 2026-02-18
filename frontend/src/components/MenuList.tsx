import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'

interface MenuListItem {
  id: number
  name: string
  description: string | null
  notes: string | null
  is_active: boolean
  sort_order: number
  division_count: number
  item_count: number
  stale_count: number
  created_at: string | null
  updated_at: string | null
}

export default function MenuList() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formPreset, setFormPreset] = useState(true)
  const [sorting, setSorting] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<number | null>(null)
  const [duplicateName, setDuplicateName] = useState('')

  const { data: menus, isLoading } = useQuery<MenuListItem[]>({
    queryKey: ['menus'],
    queryFn: async () => {
      const res = await fetch('/api/menus', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch menus')
      return res.json()
    },
    enabled: !!token,
    staleTime: 0,
  })

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string | null; notes: string | null; preset_divisions: boolean }) => {
      const res = await fetch('/api/menus', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to create menu')
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['menus'] })
      setShowCreate(false)
      setFormName('')
      setFormDesc('')
      setFormNotes('')
      navigate(`/menus/${data.id}`)
    },
  })

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: number; is_active: boolean }) => {
      const res = await fetch(`/api/menus/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active }),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menus'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/menus/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menus'] }),
  })

  const duplicateMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await fetch(`/api/menus/${id}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to duplicate')
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['menus'] })
      setDuplicatingId(null)
      setDuplicateName('')
      navigate(`/menus/${data.id}`)
    },
  })

  const reorderMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch('/api/menus/reorder', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error('Failed to reorder')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['menus'] }),
  })

  const handleDrop = () => {
    if (dragIdx === null || dragOverIdx === null || !menus) return
    const sorted = [...menus]
    const [moved] = sorted.splice(dragIdx, 1)
    sorted.splice(dragOverIdx, 0, moved)
    reorderMutation.mutate(sorted.map(m => m.id))
    setDragIdx(null)
    setDragOverIdx(null)
  }

  const filtered = menus?.filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase())
  ) || []

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Menus</h2>
        <div style={styles.headerActions}>
          <input
            type="text"
            placeholder="Search menus..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={styles.searchInput}
          />
          {filtered.length > 1 && (
            <button
              onClick={() => setSorting(!sorting)}
              style={{ ...styles.btn, background: sorting ? '#3b82f6' : undefined, color: sorting ? '#fff' : undefined }}
            >
              {sorting ? 'Done' : 'Sort'}
            </button>
          )}
          <button onClick={() => setShowCreate(true)} style={styles.btnPrimary}>
            + New Menu
          </button>
        </div>
      </div>

      {isLoading && <p style={{ padding: '1rem' }}>Loading...</p>}

      {!isLoading && filtered.length === 0 && (
        <p style={{ padding: '1rem', color: '#666' }}>No menus found. Create your first menu to get started.</p>
      )}

      <div style={styles.list}>
        {filtered.map((menu, idx) => (
          <div
            key={menu.id}
            style={{
              ...styles.card,
              opacity: dragIdx === idx ? 0.4 : 1,
              background: dragOverIdx === idx ? '#e0f2fe' : '#fff',
            }}
            draggable={sorting}
            onDragStart={() => { setDragIdx(idx) }}
            onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
            onDrop={handleDrop}
            onDragEnd={() => { setDragIdx(null); setDragOverIdx(null) }}
          >
            {sorting && <span style={styles.dragHandle}>☰</span>}
            <div style={styles.cardContent} onClick={() => navigate(`/menus/${menu.id}`)}>
              <div style={styles.cardHeader}>
                <span style={styles.menuName}>{menu.name}</span>
                <span style={{
                  ...styles.badge,
                  background: menu.is_active ? '#dcfce7' : '#f3f4f6',
                  color: menu.is_active ? '#166534' : '#6b7280',
                }}>
                  {menu.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              {menu.description && <p style={styles.desc}>{menu.description}</p>}
              <div style={styles.meta}>
                <span>{menu.division_count} section{menu.division_count !== 1 ? 's' : ''}</span>
                <span style={{ margin: '0 0.5rem' }}>·</span>
                <span>{menu.item_count} dish{menu.item_count !== 1 ? 'es' : ''}</span>
                {menu.stale_count > 0 && (
                  <>
                    <span style={{ margin: '0 0.5rem' }}>·</span>
                    <span style={{ background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: '3px', fontSize: '0.75rem', fontWeight: 600 }}>
                      {menu.stale_count} need{menu.stale_count === 1 ? 's' : ''} republishing
                    </span>
                  </>
                )}
              </div>
            </div>
            <div style={styles.cardActions}>
              <button
                onClick={(e) => { e.stopPropagation(); toggleActiveMutation.mutate({ id: menu.id, is_active: !menu.is_active }) }}
                style={styles.btnSmall}
                title={menu.is_active ? 'Deactivate' : 'Activate'}
              >
                {menu.is_active ? 'Deactivate' : 'Activate'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setDuplicatingId(menu.id)
                  setDuplicateName(`${menu.name} (Copy)`)
                }}
                style={styles.btnSmall}
              >
                Duplicate
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete "${menu.name}"? This will remove all divisions and items.`))
                    deleteMutation.mutate(menu.id)
                }}
                style={{ ...styles.btnSmall, color: '#dc2626' }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div style={styles.overlay} onClick={() => setShowCreate(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>New Menu</h3>
            <label style={styles.label}>Name *</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              style={styles.input}
              placeholder="e.g. Evening Menu"
              autoFocus
            />
            <label style={styles.label}>Description (customer-facing)</label>
            <input
              type="text"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              style={styles.input}
              placeholder="e.g. Seasonal tasting menu"
            />
            <label style={styles.label}>Internal Notes</label>
            <textarea
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              style={{ ...styles.input, minHeight: '60px', resize: 'vertical' }}
              placeholder="e.g. Available Fri-Sun 6pm-9pm"
            />
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={formPreset}
                onChange={(e) => setFormPreset(e.target.checked)}
              />
              <span style={{ marginLeft: '0.5rem' }}>Pre-load default sections (Starters, Mains, Sides, Desserts)</span>
            </label>
            <div style={styles.modalActions}>
              <button onClick={() => setShowCreate(false)} style={styles.btn}>Cancel</button>
              <button
                onClick={() => createMutation.mutate({
                  name: formName.trim(),
                  description: formDesc.trim() || null,
                  notes: formNotes.trim() || null,
                  preset_divisions: formPreset,
                })}
                style={styles.btnPrimary}
                disabled={!formName.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating...' : 'Create Menu'}
              </button>
            </div>
            {createMutation.isError && (
              <p style={{ color: '#dc2626', marginTop: '0.5rem', fontSize: '0.875rem' }}>
                {(createMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Duplicate Modal */}
      {duplicatingId !== null && (
        <div style={styles.overlay} onClick={() => setDuplicatingId(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>Duplicate Menu</h3>
            <label style={styles.label}>New menu name *</label>
            <input
              type="text"
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
              style={styles.input}
              autoFocus
            />
            <div style={styles.modalActions}>
              <button onClick={() => setDuplicatingId(null)} style={styles.btn}>Cancel</button>
              <button
                onClick={() => duplicateMutation.mutate({ id: duplicatingId, name: duplicateName.trim() })}
                style={styles.btnPrimary}
                disabled={!duplicateName.trim() || duplicateMutation.isPending}
              >
                {duplicateMutation.isPending ? 'Duplicating...' : 'Duplicate'}
              </button>
            </div>
            {duplicateMutation.isError && (
              <p style={{ color: '#dc2626', marginTop: '0.5rem', fontSize: '0.875rem' }}>
                {(duplicateMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: '900px', margin: '0 auto', padding: '1rem' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' },
  title: { margin: 0, fontSize: '1.5rem' },
  headerActions: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' },
  searchInput: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.875rem', width: '200px' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  card: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '0.75rem 1rem', border: '1px solid #e5e7eb', borderRadius: '8px',
    background: '#fff', cursor: 'pointer', transition: 'box-shadow 0.2s',
  },
  dragHandle: { cursor: 'grab', fontSize: '1rem', color: '#999' },
  cardContent: { flex: 1, minWidth: 0 },
  cardHeader: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  menuName: { fontWeight: 600, fontSize: '1rem' },
  badge: { padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 500 },
  desc: { margin: '0.25rem 0 0', fontSize: '0.875rem', color: '#666' },
  meta: { fontSize: '0.8rem', color: '#999', marginTop: '0.25rem' },
  cardActions: { display: 'flex', gap: '0.25rem', flexShrink: 0 },
  btn: { padding: '0.4rem 0.75rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnPrimary: { padding: '0.4rem 0.75rem', border: 'none', borderRadius: '4px', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnSmall: { padding: '0.25rem 0.5rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.75rem' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: '8px', padding: '1.5rem', minWidth: '360px', maxWidth: '500px', width: '90%' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' },
  label: { display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem', marginTop: '0.75rem' },
  input: { width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.875rem', boxSizing: 'border-box' },
  checkboxLabel: { display: 'flex', alignItems: 'center', marginTop: '1rem', fontSize: '0.875rem', cursor: 'pointer' },
}
