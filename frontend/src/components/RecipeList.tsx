import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'
import FoodFlagBadges from './FoodFlagBadges'

interface MenuSection {
  id: number
  name: string
  sort_order: number
  recipe_count: number
}

interface RecipeItem {
  id: number
  name: string
  recipe_type: string
  menu_section_id: number | null
  menu_section_name: string | null
  batch_portions: number
  cost_per_portion: number | null
  total_cost: number | null
  is_archived: boolean
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  flag_summary: Array<{
    name: string
    code: string | null
    icon: string | null
    category: string
    propagation: string
    active: boolean
    excludable: boolean
  }>
  image_count: number
  kds_menu_item_name: string | null
  created_at: string
  updated_at: string
}

export default function RecipeList() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [sectionFilter, setSectionFilter] = useState<string>('')
  const [showCreate, setShowCreate] = useState(false)
  const [showSectionModal, setShowSectionModal] = useState(false)

  // Create form
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState('plated')
  const [formSection, setFormSection] = useState<string>('')
  const [formBatch, setFormBatch] = useState('1')
  const [formDesc, setFormDesc] = useState('')

  // Section form
  const [sectionName, setSectionName] = useState('')

  const { data: sections } = useQuery<MenuSection[]>({
    queryKey: ['menu-sections'],
    queryFn: async () => {
      const res = await fetch('/api/recipes/menu-sections', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch sections')
      return res.json()
    },
    enabled: !!token,
  })

  const { data: recipes, isLoading } = useQuery<RecipeItem[]>({
    queryKey: ['recipes', search, typeFilter, sectionFilter],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (typeFilter) params.set('recipe_type', typeFilter)
      if (sectionFilter) params.set('menu_section_id', sectionFilter)
      const res = await fetch(`/api/recipes?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch recipes')
      return res.json()
    },
    enabled: !!token,
  })

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create recipe')
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] })
      setShowCreate(false)
      navigate(`/recipes/${data.id}`)
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/recipes/${id}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to duplicate')
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] })
      navigate(`/recipes/${data.id}`)
    },
  })

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/recipes/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to archive')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recipes'] }),
  })

  const createSectionMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/recipes/menu-sections', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to create section')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menu-sections'] })
      setSectionName('')
      setShowSectionModal(false)
    },
  })

  const handleCreate = () => {
    createMutation.mutate({
      name: formName,
      recipe_type: formType,
      menu_section_id: formSection ? parseInt(formSection) : null,
      batch_portions: formType === 'component' ? parseInt(formBatch) : 1,
      description: formDesc || null,
    })
  }

  const componentCount = recipes?.filter(r => r.recipe_type === 'component').length || 0
  const platedCount = recipes?.filter(r => r.recipe_type === 'plated').length || 0

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>Recipes</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setShowSectionModal(true)} style={styles.secondaryBtn}>+ Section</button>
          <button onClick={() => { setShowCreate(true); setFormName(''); setFormType('plated'); setFormSection(''); setFormBatch('1'); setFormDesc('') }} style={styles.primaryBtn}>+ New Recipe</button>
        </div>
      </div>

      {/* Stats */}
      <div style={styles.statsBar}>
        <span>{recipes?.length || 0} recipes</span>
        <span style={{ color: '#ccc' }}>|</span>
        <span>{platedCount} plated</span>
        <span style={{ color: '#ccc' }}>|</span>
        <span>{componentCount} components</span>
      </div>

      {/* Filters */}
      <div style={styles.filterBar}>
        <input
          type="text"
          placeholder="Search recipes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={styles.select}>
          <option value="">All Types</option>
          <option value="plated">Plated</option>
          <option value="component">Component</option>
        </select>
        <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)} style={styles.select}>
          <option value="">All Sections</option>
          {sections?.map(s => (
            <option key={s.id} value={s.id}>{s.name} ({s.recipe_count})</option>
          ))}
        </select>
      </div>

      {/* Recipe cards */}
      {isLoading ? (
        <div style={styles.loading}>Loading recipes...</div>
      ) : (
        <div style={styles.grid}>
          {recipes?.map(r => (
            <div key={r.id} style={styles.card} onClick={() => navigate(`/recipes/${r.id}`)}>
              <div style={styles.cardHeader}>
                <span style={{ fontWeight: 600, fontSize: '1rem' }}>{r.name}</span>
                <span style={{
                  background: r.recipe_type === 'plated' ? '#3b82f6' : '#8b5cf6',
                  color: 'white',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase' as const,
                }}>
                  {r.recipe_type}
                </span>
              </div>

              {r.menu_section_name && (
                <div style={styles.sectionTag}>{r.menu_section_name}</div>
              )}

              {r.recipe_type === 'component' && r.batch_portions > 1 && (
                <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '4px' }}>
                  Batch: {r.batch_portions} portions
                </div>
              )}

              <div style={styles.cardMeta}>
                {r.cost_per_portion != null ? (
                  <span style={styles.costBadge}>£{r.cost_per_portion.toFixed(2)}/portion</span>
                ) : (
                  <span style={{ color: '#aaa', fontSize: '0.8rem' }}>No costing</span>
                )}
                {(r.prep_time_minutes || r.cook_time_minutes) && (
                  <span style={{ fontSize: '0.75rem', color: '#888' }}>
                    {r.prep_time_minutes ? `${r.prep_time_minutes}m prep` : ''}
                    {r.prep_time_minutes && r.cook_time_minutes ? ' + ' : ''}
                    {r.cook_time_minutes ? `${r.cook_time_minutes}m cook` : ''}
                  </span>
                )}
              </div>

              {r.flag_summary.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <FoodFlagBadges flags={r.flag_summary} />
                </div>
              )}

              <div style={styles.cardActions}>
                <button onClick={(e) => { e.stopPropagation(); duplicateMutation.mutate(r.id) }} style={styles.actionBtn}>Duplicate</button>
                <button onClick={(e) => { e.stopPropagation(); archiveMutation.mutate(r.id) }} style={{ ...styles.actionBtn, color: '#e94560' }}>Archive</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Recipe Modal */}
      {showCreate && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>New Recipe</h3>
              <button onClick={() => setShowCreate(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} style={styles.input} placeholder="e.g. Beef Burger, Hollandaise Sauce" />

              <label style={styles.label}>Type *</label>
              <select value={formType} onChange={(e) => setFormType(e.target.value)} style={styles.input}>
                <option value="plated">Plated (single serving)</option>
                <option value="component">Component (batch recipe)</option>
              </select>

              <label style={styles.label}>Menu Section</label>
              <select value={formSection} onChange={(e) => setFormSection(e.target.value)} style={styles.input}>
                <option value="">None</option>
                {sections?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>

              {formType === 'component' && (
                <>
                  <label style={styles.label}>Batch Portions</label>
                  <input type="number" value={formBatch} onChange={(e) => setFormBatch(e.target.value)} style={styles.input} min="1" />
                </>
              )}

              <label style={styles.label}>Description</label>
              <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} style={{ ...styles.input, minHeight: '60px' }} placeholder="Brief description..." />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowCreate(false)} style={styles.cancelBtn}>Cancel</button>
              <button onClick={handleCreate} disabled={!formName || createMutation.isPending} style={styles.primaryBtn}>
                {createMutation.isPending ? 'Creating...' : 'Create Recipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Section Modal */}
      {showSectionModal && (
        <div style={styles.overlay}>
          <div style={{ ...styles.modal, width: '350px' }}>
            <div style={styles.modalHeader}>
              <h3 style={{ margin: 0 }}>Add Menu Section</h3>
              <button onClick={() => setShowSectionModal(false)} style={styles.closeBtn}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Section Name</label>
              <input value={sectionName} onChange={(e) => setSectionName(e.target.value)} style={styles.input} placeholder="e.g. Starters, Sauces" />
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowSectionModal(false)} style={styles.cancelBtn}>Cancel</button>
              <button onClick={() => createSectionMutation.mutate(sectionName)} disabled={!sectionName} style={styles.primaryBtn}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  statsBar: { display: 'flex', gap: '0.75rem', fontSize: '0.85rem', color: '#666', marginBottom: '0.75rem' },
  filterBar: { display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' as const },
  searchInput: { padding: '0.5rem 0.75rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem', width: '250px' },
  select: { padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', fontSize: '0.9rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' },
  card: { background: 'white', borderRadius: '8px', padding: '1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', cursor: 'pointer', transition: 'box-shadow 0.2s', border: '1px solid #eee' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' },
  sectionTag: { fontSize: '0.75rem', color: '#888', marginTop: '2px' },
  cardMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' },
  costBadge: { background: '#f0fdf4', color: '#166534', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 },
  cardActions: { display: 'flex', gap: '0.5rem', marginTop: '10px', borderTop: '1px solid #f0f0f0', paddingTop: '8px' },
  actionBtn: { padding: '0.25rem 0.5rem', border: '1px solid #ddd', borderRadius: '4px', background: 'white', cursor: 'pointer', fontSize: '0.75rem' },
  primaryBtn: { padding: '0.6rem 1.25rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' },
  secondaryBtn: { padding: '0.6rem 1.25rem', background: 'white', color: '#333', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem' },
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
