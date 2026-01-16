import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface SettingsData {
  azure_endpoint: string | null
  azure_key_set: boolean
  currency_symbol: string
  date_format: string
}

interface UserData {
  id: number
  email: string
  name: string | null
  is_active: boolean
  is_admin: boolean
  created_at: string
}

export default function Settings() {
  const { user, token } = useAuth()
  const queryClient = useQueryClient()

  const [azureEndpoint, setAzureEndpoint] = useState('')
  const [azureKey, setAzureKey] = useState('')
  const [currencySymbol, setCurrencySymbol] = useState('£')
  const [dateFormat, setDateFormat] = useState('DD/MM/YYYY')
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null)

  // Data management state
  const [dataMessage, setDataMessage] = useState<string | null>(null)

  const { data: settings, isLoading } = useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
  })

  useEffect(() => {
    if (settings) {
      setAzureEndpoint(settings.azure_endpoint || '')
      setCurrencySymbol(settings.currency_symbol)
      setDateFormat(settings.date_format)
    }
  }, [settings])

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<SettingsData & { azure_key?: string }>) => {
      const res = await fetch('/api/settings/', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update settings')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setSaveMessage('Settings saved successfully')
      setAzureKey('')
      setTimeout(() => setSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSaveMessage(`Error: ${error.message}`)
    },
  })

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/test-azure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Connection test failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setTestStatus(data.message)
      setTimeout(() => setTestStatus(null), 5000)
    },
    onError: (error) => {
      setTestStatus(`Error: ${error.message}`)
    },
  })

  const passwordMutation = useMutation({
    mutationFn: async (data: { current_password: string; new_password: string }) => {
      const res = await fetch('/auth/change-password', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.detail || 'Failed to change password')
      }
      return res.json()
    },
    onSuccess: () => {
      setPasswordMessage('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setPasswordMessage(null), 5000)
    },
    onError: (error) => {
      setPasswordMessage(`Error: ${error.message}`)
    },
  })

  const handlePasswordChange = () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordMessage('Error: Please fill in all password fields')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage('Error: New passwords do not match')
      return
    }
    if (newPassword.length < 6) {
      setPasswordMessage('Error: Password must be at least 6 characters')
      return
    }
    passwordMutation.mutate({
      current_password: currentPassword,
      new_password: newPassword,
    })
  }

  // User management (admin only)
  const { data: users } = useQuery<UserData[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/auth/users', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        if (res.status === 403) return [] // Not admin
        throw new Error('Failed to fetch users')
      }
      return res.json()
    },
    enabled: !!user?.is_admin,
  })

  const toggleUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      const res = await fetch(`/auth/users/${userId}/toggle-active`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to toggle user')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      const res = await fetch(`/auth/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to delete user')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const reprocessMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/invoices/reprocess-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to reprocess invoices')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setDataMessage(data.message)
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setTimeout(() => setDataMessage(null), 5000)
    },
    onError: (error) => {
      setDataMessage(`Error: ${error.message}`)
    },
  })

  const rematchFuzzyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/suppliers/rematch-fuzzy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to rematch invoices')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setDataMessage(data.message)
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setTimeout(() => setDataMessage(null), 5000)
    },
    onError: (error) => {
      setDataMessage(`Error: ${error.message}`)
    },
  })

  const handleSave = () => {
    const data: Record<string, string> = {
      azure_endpoint: azureEndpoint,
      currency_symbol: currencySymbol,
      date_format: dateFormat,
    }
    if (azureKey) {
      data.azure_key = azureKey
    }
    updateMutation.mutate(data)
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading settings...</div>
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Settings</h2>

      {/* Account Info */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Account</h3>
        <p><strong>Email:</strong> {user?.email}</p>
        <p><strong>Name:</strong> {user?.name}</p>
        <p><strong>Kitchen:</strong> {user?.kitchen_name}</p>
        {user?.is_admin && <p><strong>Role:</strong> Admin</p>}
      </div>

      {/* User Management (Admin Only) */}
      {user?.is_admin && users && users.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>User Management</h3>
          <p style={styles.hint}>Manage users who have access to this kitchen.</p>
          <table style={styles.userTable}>
            <thead>
              <tr>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={!u.is_active ? styles.disabledRow : undefined}>
                  <td style={styles.td}>{u.email}</td>
                  <td style={styles.td}>{u.name || '-'}</td>
                  <td style={styles.td}>
                    <span style={u.is_active ? styles.activeStatus : styles.inactiveStatus}>
                      {u.is_active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td style={styles.td}>{u.is_admin ? 'Admin' : 'User'}</td>
                  <td style={styles.td}>
                    {u.id !== user.id && (
                      <div style={styles.actionButtons}>
                        <button
                          onClick={() => toggleUserMutation.mutate(u.id)}
                          style={u.is_active ? styles.disableBtn : styles.enableBtn}
                          disabled={toggleUserMutation.isPending}
                        >
                          {u.is_active ? 'Disable' : 'Enable'}
                        </button>
                        {!u.is_admin && (
                          <button
                            onClick={() => {
                              if (confirm(`Delete user ${u.email}? This cannot be undone.`)) {
                                deleteUserMutation.mutate(u.id)
                              }
                            }}
                            style={styles.deleteBtn}
                            disabled={deleteUserMutation.isPending}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                    {u.id === user.id && <span style={styles.youLabel}>(You)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Change Password */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Change Password</h3>
        <div style={styles.form}>
          <label style={styles.label}>
            Current Password
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              style={styles.input}
              placeholder="Enter your current password"
            />
          </label>

          <label style={styles.label}>
            New Password
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={styles.input}
              placeholder="Enter new password (min 6 characters)"
            />
          </label>

          <label style={styles.label}>
            Confirm New Password
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              style={styles.input}
              placeholder="Confirm new password"
            />
          </label>

          <button
            onClick={handlePasswordChange}
            style={styles.changePasswordBtn}
            disabled={passwordMutation.isPending}
          >
            {passwordMutation.isPending ? 'Changing...' : 'Change Password'}
          </button>

          {passwordMessage && (
            <div style={{
              ...styles.statusMessage,
              background: passwordMessage.startsWith('Error') ? '#fee' : '#efe',
              color: passwordMessage.startsWith('Error') ? '#c00' : '#060',
            }}>
              {passwordMessage}
            </div>
          )}
        </div>
      </div>

      {/* Azure Document Intelligence Settings */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Azure Document Intelligence</h3>
        <p style={styles.hint}>
          Configure Azure credentials for invoice OCR processing with line item extraction.
        </p>

        <div style={styles.form}>
          <label style={styles.label}>
            Endpoint URL
            <input
              type="text"
              value={azureEndpoint}
              onChange={(e) => setAzureEndpoint(e.target.value)}
              style={styles.input}
              placeholder="https://your-resource.cognitiveservices.azure.com/"
            />
          </label>

          <label style={styles.label}>
            API Key
            <input
              type="password"
              value={azureKey}
              onChange={(e) => setAzureKey(e.target.value)}
              style={styles.input}
              placeholder={settings?.azure_key_set ? '••••••••••••••••' : 'Enter your API key'}
            />
            {settings?.azure_key_set && !azureKey && (
              <span style={styles.keyStatus}>Key is configured</span>
            )}
          </label>

          <div style={styles.buttonRow}>
            <button
              onClick={() => testMutation.mutate()}
              style={styles.testBtn}
              disabled={testMutation.isPending || !settings?.azure_key_set}
            >
              {testMutation.isPending ? 'Testing...' : 'Test Connection'}
            </button>
          </div>

          {testStatus && (
            <div style={{
              ...styles.statusMessage,
              background: testStatus.startsWith('Error') ? '#fee' : '#efe',
              color: testStatus.startsWith('Error') ? '#c00' : '#060',
            }}>
              {testStatus}
            </div>
          )}
        </div>
      </div>

      {/* General Settings */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Display Settings</h3>
        <div style={styles.form}>
          <label style={styles.label}>
            Currency Symbol
            <select
              value={currencySymbol}
              onChange={(e) => setCurrencySymbol(e.target.value)}
              style={styles.input}
            >
              <option value="£">£ (GBP)</option>
              <option value="$">$ (USD)</option>
              <option value="€">€ (EUR)</option>
            </select>
          </label>

          <label style={styles.label}>
            Date Format
            <select
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              style={styles.input}
            >
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            </select>
          </label>
        </div>
      </div>

      {/* Data Management */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Data Management</h3>
        <p style={styles.hint}>
          Tools for reprocessing invoices and fixing supplier matching issues.
        </p>

        <div style={styles.dataActions}>
          <div style={styles.dataAction}>
            <div>
              <strong>Reprocess All Invoices</strong>
              <p style={styles.actionDesc}>
                Re-run OCR processing on all non-confirmed invoices. This clears existing
                extracted data and line items, then processes them again with current settings.
              </p>
            </div>
            <button
              onClick={() => {
                if (confirm('Reprocess all non-confirmed invoices? This will clear their current data and re-run OCR.')) {
                  reprocessMutation.mutate()
                }
              }}
              style={styles.actionBtn}
              disabled={reprocessMutation.isPending}
            >
              {reprocessMutation.isPending ? 'Reprocessing...' : 'Reprocess Invoices'}
            </button>
          </div>

          <div style={styles.dataAction}>
            <div>
              <strong>Clear Fuzzy Matches</strong>
              <p style={styles.actionDesc}>
                Clear all invoices with fuzzy supplier matches and re-run supplier matching.
                Use this after updating supplier names or aliases.
              </p>
            </div>
            <button
              onClick={() => {
                if (confirm('Clear all fuzzy supplier matches and re-run matching?')) {
                  rematchFuzzyMutation.mutate()
                }
              }}
              style={styles.actionBtn}
              disabled={rematchFuzzyMutation.isPending}
            >
              {rematchFuzzyMutation.isPending ? 'Clearing...' : 'Clear Fuzzy Matches'}
            </button>
          </div>
        </div>

        {dataMessage && (
          <div style={{
            ...styles.statusMessage,
            background: dataMessage.startsWith('Error') ? '#fee' : '#efe',
            color: dataMessage.startsWith('Error') ? '#c00' : '#060',
          }}>
            {dataMessage}
          </div>
        )}
      </div>

      {/* Save Button */}
      <div style={styles.saveSection}>
        <button
          onClick={handleSave}
          style={styles.saveBtn}
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? 'Saving...' : 'Save Settings'}
        </button>

        {saveMessage && (
          <div style={{
            ...styles.statusMessage,
            background: saveMessage.startsWith('Error') ? '#fee' : '#efe',
            color: saveMessage.startsWith('Error') ? '#c00' : '#060',
          }}>
            {saveMessage}
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: '800px',
    margin: '0 auto',
  },
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  title: {
    color: '#1a1a2e',
    marginBottom: '2rem',
  },
  section: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    marginBottom: '1.5rem',
  },
  sectionTitle: {
    color: '#1a1a2e',
    marginTop: 0,
    marginBottom: '1rem',
    fontSize: '1.1rem',
  },
  hint: {
    color: '#666',
    marginBottom: '1.5rem',
    fontSize: '0.9rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    color: '#333',
    fontWeight: '500',
  },
  input: {
    padding: '0.75rem',
    borderRadius: '6px',
    border: '1px solid #ddd',
    fontSize: '1rem',
  },
  keyStatus: {
    fontSize: '0.8rem',
    color: '#5cb85c',
  },
  buttonRow: {
    display: 'flex',
    gap: '1rem',
  },
  testBtn: {
    padding: '0.5rem 1rem',
    background: '#5bc0de',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  statusMessage: {
    padding: '0.75rem',
    borderRadius: '6px',
    marginTop: '0.5rem',
  },
  saveSection: {
    marginTop: '2rem',
  },
  saveBtn: {
    padding: '0.75rem 2rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '1rem',
  },
  changePasswordBtn: {
    padding: '0.75rem 1.5rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '500',
    fontSize: '0.95rem',
    alignSelf: 'flex-start',
  },
  userTable: {
    width: '100%',
    borderCollapse: 'collapse',
    marginTop: '1rem',
  },
  th: {
    textAlign: 'left',
    padding: '0.75rem',
    borderBottom: '2px solid #eee',
    color: '#666',
    fontSize: '0.85rem',
    fontWeight: '600',
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
    fontSize: '0.9rem',
  },
  disabledRow: {
    opacity: 0.6,
    background: '#f9f9f9',
  },
  activeStatus: {
    color: '#28a745',
    fontWeight: '500',
  },
  inactiveStatus: {
    color: '#dc3545',
    fontWeight: '500',
  },
  actionButtons: {
    display: 'flex',
    gap: '0.5rem',
  },
  disableBtn: {
    padding: '0.35rem 0.75rem',
    background: '#ffc107',
    color: '#212529',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  enableBtn: {
    padding: '0.35rem 0.75rem',
    background: '#28a745',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  deleteBtn: {
    padding: '0.35rem 0.75rem',
    background: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  youLabel: {
    color: '#666',
    fontSize: '0.85rem',
    fontStyle: 'italic',
  },
  dataActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  dataAction: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '1rem',
    padding: '1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
  },
  actionDesc: {
    margin: '0.5rem 0 0 0',
    fontSize: '0.85rem',
    color: '#666',
  },
  actionBtn: {
    padding: '0.5rem 1rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '500',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
}
