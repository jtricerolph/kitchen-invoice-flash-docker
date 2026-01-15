import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface SettingsData {
  azure_endpoint: string | null
  azure_key_set: boolean
  ocr_provider: string
  currency_symbol: string
  date_format: string
}

export default function Settings() {
  const { user, token } = useAuth()
  const queryClient = useQueryClient()

  const [azureEndpoint, setAzureEndpoint] = useState('')
  const [azureKey, setAzureKey] = useState('')
  const [ocrProvider, setOcrProvider] = useState('azure')
  const [currencySymbol, setCurrencySymbol] = useState('£')
  const [dateFormat, setDateFormat] = useState('DD/MM/YYYY')
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

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
      setOcrProvider(settings.ocr_provider)
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

  const handleSave = () => {
    const data: Record<string, string> = {
      azure_endpoint: azureEndpoint,
      ocr_provider: ocrProvider,
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

      {/* OCR Provider Selection */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>OCR Provider</h3>
        <div style={styles.form}>
          <label style={styles.radioLabel}>
            <input
              type="radio"
              name="ocrProvider"
              value="azure"
              checked={ocrProvider === 'azure'}
              onChange={(e) => setOcrProvider(e.target.value)}
            />
            <span>Azure Document Intelligence (Recommended)</span>
          </label>
          <p style={styles.radioHint}>
            Uses Microsoft's pre-trained invoice model. Extracts line items, vendor info, and more.
          </p>

          <label style={styles.radioLabel}>
            <input
              type="radio"
              name="ocrProvider"
              value="paddle"
              checked={ocrProvider === 'paddle'}
              onChange={(e) => setOcrProvider(e.target.value)}
            />
            <span>PaddleOCR (Local GPU)</span>
          </label>
          <p style={styles.radioHint}>
            Uses local GPU for OCR. Basic field extraction only.
          </p>
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
  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    fontWeight: '500',
  },
  radioHint: {
    color: '#666',
    fontSize: '0.85rem',
    marginLeft: '1.5rem',
    marginTop: '-0.5rem',
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
}
