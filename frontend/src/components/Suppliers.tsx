import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface Supplier {
  id: number
  name: string
  aliases: string[]
  template_config: Record<string, unknown>
  identifier_config: Record<string, unknown>
  skip_dext: boolean
  created_at: string
}

export default function Suppliers() {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  const [showAddModal, setShowAddModal] = useState(false)
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)
  const [newName, setNewName] = useState('')
  const [newAliases, setNewAliases] = useState<string[]>([])
  const [aliasInput, setAliasInput] = useState('')
  const [skipDext, setSkipDext] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null)

  const { data: suppliers, isLoading } = useQuery<Supplier[]>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch suppliers')
      return res.json()
    },
  })

  const createMutation = useMutation({
    mutationFn: async ({ name, aliases, skip_dext }: { name: string; aliases: string[]; skip_dext: boolean }) => {
      const res = await fetch('/api/suppliers/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, aliases, skip_dext }),
      })
      if (!res.ok) throw new Error('Failed to create supplier')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setShowAddModal(false)
      setNewName('')
      setNewAliases([])
      setAliasInput('')
      setSkipDext(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({ id, name, aliases, skip_dext }: { id: number; name: string; aliases: string[]; skip_dext: boolean }) => {
      const res = await fetch(`/api/suppliers/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, aliases, skip_dext }),
      })
      if (!res.ok) throw new Error('Failed to update supplier')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setEditingSupplier(null)
      setNewName('')
      setNewAliases([])
      setAliasInput('')
      setSkipDext(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/suppliers/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete supplier')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setDeleteConfirm(null)
    },
  })

  const handleAdd = () => {
    if (newName.trim()) {
      createMutation.mutate({ name: newName.trim(), aliases: newAliases, skip_dext: skipDext })
    }
  }

  const handleUpdate = () => {
    if (editingSupplier && newName.trim()) {
      updateMutation.mutate({ id: editingSupplier.id, name: newName.trim(), aliases: newAliases, skip_dext: skipDext })
    }
  }

  const startEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier)
    setNewName(supplier.name)
    setNewAliases(supplier.aliases || [])
    setAliasInput('')
    setSkipDext(supplier.skip_dext || false)
  }

  const addAlias = () => {
    const trimmed = aliasInput.trim()
    if (trimmed && !newAliases.includes(trimmed)) {
      setNewAliases([...newAliases, trimmed])
      setAliasInput('')
    }
  }

  const removeAlias = (alias: string) => {
    setNewAliases(newAliases.filter(a => a !== alias))
  }

  const handleAliasKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addAlias()
    }
  }

  const closeAddModal = () => {
    setShowAddModal(false)
    setNewName('')
    setNewAliases([])
    setAliasInput('')
    setSkipDext(false)
  }

  const closeEditModal = () => {
    setEditingSupplier(null)
    setNewName('')
    setNewAliases([])
    setAliasInput('')
    setSkipDext(false)
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading suppliers...</div>
  }

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>Suppliers</h2>
        <button onClick={() => setShowAddModal(true)} style={styles.addBtn}>
          + Add Supplier
        </button>
      </div>

      <p style={styles.hint}>
        Define your suppliers here. Add aliases for suppliers that appear with different names
        on invoices (e.g., "US Foods", "USF", "U.S. Foods Inc").
      </p>

      {suppliers && suppliers.length === 0 ? (
        <div style={styles.empty}>
          <p>No suppliers defined yet.</p>
          <p style={styles.emptyHint}>
            Add your first supplier to start organizing invoices by vendor.
          </p>
        </div>
      ) : (
        <div style={styles.list}>
          {suppliers?.map((supplier) => (
            <div key={supplier.id} style={styles.card}>
              <div style={styles.cardMain}>
                <span style={styles.supplierName}>
                  {supplier.name}
                  {supplier.skip_dext && (
                    <span style={styles.skipDextBadge}>Skip Dext</span>
                  )}
                </span>
                {supplier.aliases && supplier.aliases.length > 0 && (
                  <div style={styles.aliasesList}>
                    <span style={styles.aliasesLabel}>Also known as: </span>
                    {supplier.aliases.map((alias, idx) => (
                      <span key={alias} style={styles.aliasTag}>
                        {alias}{idx < supplier.aliases.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </div>
                )}
                <span style={styles.date}>
                  Added: {new Date(supplier.created_at).toLocaleDateString()}
                </span>
              </div>
              <div style={styles.cardActions}>
                <button onClick={() => startEdit(supplier)} style={styles.editBtn}>
                  Edit
                </button>
                <button
                  onClick={() => setDeleteConfirm(supplier.id)}
                  style={styles.deleteBtn}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div style={styles.modalOverlay} onClick={closeAddModal}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Add Supplier</h3>
            <label style={styles.label}>
              Primary Name
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={styles.input}
                placeholder="e.g., Sysco"
                autoFocus
              />
            </label>

            <label style={styles.label}>
              Aliases (alternative names on invoices)
              <div style={styles.aliasInputRow}>
                <input
                  type="text"
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={handleAliasKeyDown}
                  style={{ ...styles.input, flex: 1 }}
                  placeholder="e.g., SYSCO FOODS"
                />
                <button type="button" onClick={addAlias} style={styles.addAliasBtn}>
                  Add
                </button>
              </div>
              {newAliases.length > 0 && (
                <div style={styles.aliasTagsContainer}>
                  {newAliases.map((alias) => (
                    <span key={alias} style={styles.aliasTagEditable}>
                      {alias}
                      <button
                        type="button"
                        onClick={() => removeAlias(alias)}
                        style={styles.removeAliasBtn}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </label>

            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={skipDext}
                onChange={(e) => setSkipDext(e.target.checked)}
                style={styles.checkbox}
              />
              <span>Don't Forward to Dext</span>
              <span style={styles.checkboxHint}>
                Invoices from this supplier won't be sent to Dext
              </span>
            </label>

            <div style={styles.modalActions}>
              <button onClick={closeAddModal} style={styles.cancelBtn}>
                Cancel
              </button>
              <button
                onClick={handleAdd}
                style={styles.saveBtn}
                disabled={!newName.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? 'Adding...' : 'Add Supplier'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingSupplier && (
        <div style={styles.modalOverlay} onClick={closeEditModal}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Edit Supplier</h3>
            <label style={styles.label}>
              Primary Name
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={styles.input}
                autoFocus
              />
            </label>

            <label style={styles.label}>
              Aliases (alternative names on invoices)
              <div style={styles.aliasInputRow}>
                <input
                  type="text"
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={handleAliasKeyDown}
                  style={{ ...styles.input, flex: 1 }}
                  placeholder="Add an alias..."
                />
                <button type="button" onClick={addAlias} style={styles.addAliasBtn}>
                  Add
                </button>
              </div>
              {newAliases.length > 0 && (
                <div style={styles.aliasTagsContainer}>
                  {newAliases.map((alias) => (
                    <span key={alias} style={styles.aliasTagEditable}>
                      {alias}
                      <button
                        type="button"
                        onClick={() => removeAlias(alias)}
                        style={styles.removeAliasBtn}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </label>

            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={skipDext}
                onChange={(e) => setSkipDext(e.target.checked)}
                style={styles.checkbox}
              />
              <span>Don't Forward to Dext</span>
              <span style={styles.checkboxHint}>
                Invoices from this supplier won't be sent to Dext
              </span>
            </label>

            <div style={styles.modalActions}>
              <button onClick={closeEditModal} style={styles.cancelBtn}>
                Cancel
              </button>
              <button
                onClick={handleUpdate}
                style={styles.saveBtn}
                disabled={!newName.trim() || updateMutation.isPending}
              >
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div style={styles.modalOverlay} onClick={() => setDeleteConfirm(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Delete Supplier?</h3>
            <p>Are you sure you want to delete this supplier?</p>
            <p style={styles.warningText}>
              Invoices linked to this supplier will have their supplier cleared.
            </p>
            <div style={styles.modalActions}>
              <button onClick={() => setDeleteConfirm(null)} style={styles.cancelBtn}>
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm)}
                style={styles.confirmDeleteBtn}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  title: {
    color: '#1a1a2e',
    margin: 0,
  },
  addBtn: {
    padding: '0.75rem 1.5rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  hint: {
    color: '#666',
    marginBottom: '1.5rem',
    background: 'white',
    padding: '1rem',
    borderRadius: '8px',
  },
  empty: {
    background: 'white',
    padding: '3rem',
    borderRadius: '12px',
    textAlign: 'center',
    color: '#666',
  },
  emptyHint: {
    marginTop: '0.5rem',
    fontSize: '0.9rem',
    color: '#999',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    background: 'white',
    padding: '1rem 1.5rem',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
  },
  cardMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    flex: 1,
  },
  supplierName: {
    fontWeight: 'bold',
    fontSize: '1.1rem',
    color: '#1a1a2e',
  },
  aliasesList: {
    fontSize: '0.85rem',
    color: '#666',
    marginTop: '0.25rem',
  },
  aliasesLabel: {
    color: '#999',
  },
  aliasTag: {
    color: '#1a1a2e',
  },
  date: {
    fontSize: '0.8rem',
    color: '#999',
    marginTop: '0.25rem',
  },
  cardActions: {
    display: 'flex',
    gap: '0.5rem',
    marginLeft: '1rem',
  },
  editBtn: {
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  deleteBtn: {
    padding: '0.5rem 1rem',
    background: 'white',
    border: '1px solid #dc3545',
    color: '#dc3545',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'white',
    padding: '2rem',
    borderRadius: '12px',
    maxWidth: '500px',
    width: '90%',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    color: '#333',
    fontWeight: '500',
    marginTop: '1rem',
  },
  input: {
    padding: '0.75rem',
    borderRadius: '6px',
    border: '1px solid #ddd',
    fontSize: '1rem',
  },
  aliasInputRow: {
    display: 'flex',
    gap: '0.5rem',
  },
  addAliasBtn: {
    padding: '0.75rem 1rem',
    background: '#f0f0f0',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  aliasTagsContainer: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    marginTop: '0.5rem',
  },
  aliasTagEditable: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0.25rem 0.5rem',
    background: '#e9ecef',
    borderRadius: '4px',
    fontSize: '0.85rem',
  },
  removeAliasBtn: {
    background: 'none',
    border: 'none',
    color: '#999',
    cursor: 'pointer',
    padding: '0 0.25rem',
    fontSize: '0.9rem',
    lineHeight: 1,
  },
  modalActions: {
    display: 'flex',
    gap: '1rem',
    marginTop: '1.5rem',
  },
  cancelBtn: {
    flex: 1,
    padding: '0.75rem',
    background: '#f0f0f0',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  saveBtn: {
    flex: 1,
    padding: '0.75rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  confirmDeleteBtn: {
    flex: 1,
    padding: '0.75rem',
    background: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  warningText: {
    color: '#856404',
    background: '#fff3cd',
    padding: '0.75rem',
    borderRadius: '6px',
    fontSize: '0.9rem',
    marginTop: '0.5rem',
  },
  checkboxLabel: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    marginTop: '1.25rem',
    padding: '1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
  },
  checkboxHint: {
    width: '100%',
    fontSize: '0.8rem',
    color: '#666',
    marginLeft: '26px',
  },
  skipDextBadge: {
    display: 'inline-block',
    fontSize: '0.7rem',
    padding: '0.2rem 0.5rem',
    background: '#28a745',
    color: 'white',
    borderRadius: '4px',
    marginLeft: '0.5rem',
    fontWeight: 'normal',
  },
}
