import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface Invoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  supplier_id: number | null
  status: string
  category: string | null
  ocr_confidence: number | null
  image_path: string
}

export default function Review() {
  const { id } = useParams()
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [total, setTotal] = useState('')
  const [category, setCategory] = useState('food')

  const { data: invoice, isLoading } = useQuery<Invoice>({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch invoice')
      return res.json()
    },
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  // Fetch image separately with auth header
  const { data: imageUrl } = useQuery<string>({
    queryKey: ['invoice-image', id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${id}/image`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch image')
      const blob = await res.blob()
      return URL.createObjectURL(blob)
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (invoice) {
      setInvoiceNumber(invoice.invoice_number || '')
      setInvoiceDate(invoice.invoice_date || '')
      setTotal(invoice.total?.toString() || '')
      setCategory(invoice.category || 'food')
    }
  }, [invoice])

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Invoice>) => {
      const res = await fetch(`/api/invoices/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
    },
  })

  const handleSave = async (status: string = 'reviewed') => {
    await updateMutation.mutateAsync({
      invoice_number: invoiceNumber || null,
      invoice_date: invoiceDate || null,
      total: total ? parseFloat(total) : null,
      category,
      status,
    })
  }

  const handleConfirm = async () => {
    await handleSave('confirmed')
    navigate('/invoices')
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading invoice...</div>
  }

  if (!invoice) {
    return <div style={styles.error}>Invoice not found</div>
  }

  const confidence = invoice.ocr_confidence
    ? (invoice.ocr_confidence * 100).toFixed(0)
    : null

  return (
    <div style={styles.container}>
      <div style={styles.imageSection}>
        <h3>Invoice Image</h3>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Invoice"
            style={styles.image}
          />
        ) : (
          <div style={styles.imagePlaceholder}>Loading image...</div>
        )}
        {confidence && (
          <div style={styles.confidenceBadge}>
            OCR Confidence: {confidence}%
          </div>
        )}
      </div>

      <div style={styles.formSection}>
        <h3>Extracted Data</h3>
        <p style={styles.hint}>
          Review and correct the extracted information below
        </p>

        <div style={styles.form}>
          <label style={styles.label}>
            Invoice Number
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              style={styles.input}
              placeholder="e.g., INV-12345"
            />
          </label>

          <label style={styles.label}>
            Invoice Date
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              style={styles.input}
            />
          </label>

          <label style={styles.label}>
            Total Amount (£)
            <input
              type="number"
              step="0.01"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              style={styles.input}
              placeholder="0.00"
            />
          </label>

          <label style={styles.label}>
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={styles.input}
            >
              <option value="food">Food</option>
              <option value="beverages">Beverages</option>
              <option value="supplies">Supplies</option>
              <option value="equipment">Equipment</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>

        <div style={styles.status}>
          Current status: <strong>{invoice.status}</strong>
        </div>

        <div style={styles.actions}>
          <button
            onClick={() => handleSave('reviewed')}
            style={styles.saveBtn}
            disabled={updateMutation.isPending}
          >
            Save Changes
          </button>
          <button
            onClick={handleConfirm}
            style={styles.confirmBtn}
            disabled={updateMutation.isPending}
          >
            Confirm & Include in GP
          </button>
        </div>

        <button
          onClick={() => navigate('/invoices')}
          style={styles.backBtn}
        >
          ← Back to Invoices
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  error: {
    padding: '2rem',
    textAlign: 'center',
    color: '#c00',
  },
  container: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2rem',
  },
  imageSection: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  image: {
    width: '100%',
    borderRadius: '8px',
    marginTop: '1rem',
  },
  imagePlaceholder: {
    width: '100%',
    height: '300px',
    background: '#f5f5f5',
    borderRadius: '8px',
    marginTop: '1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#999',
  },
  confidenceBadge: {
    marginTop: '1rem',
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    borderRadius: '20px',
    textAlign: 'center',
    fontSize: '0.9rem',
    color: '#666',
  },
  formSection: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  hint: {
    color: '#666',
    marginBottom: '1.5rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
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
  status: {
    marginTop: '1.5rem',
    padding: '1rem',
    background: '#f5f5f5',
    borderRadius: '6px',
    color: '#666',
  },
  actions: {
    display: 'flex',
    gap: '1rem',
    marginTop: '1.5rem',
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
  confirmBtn: {
    flex: 1,
    padding: '0.75rem',
    background: '#5cb85c',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 'bold',
  },
  backBtn: {
    marginTop: '1rem',
    padding: '0.75rem',
    background: 'transparent',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    width: '100%',
  },
}
