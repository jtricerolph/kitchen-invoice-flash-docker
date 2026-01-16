import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

interface Invoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  net_total: number | null
  stock_total: number | null
  supplier_id: number | null
  supplier_name: string | null
  vendor_name: string | null  // OCR-extracted vendor name
  status: string
  category: string | null
  ocr_confidence: number | null
  image_path: string
  document_type: string | null
  order_number: string | null
  duplicate_status: string | null
  duplicate_of_id: number | null
}

interface Supplier {
  id: number
  name: string
}

interface LineItem {
  id: number
  description: string | null
  quantity: number | null
  unit_price: number | null
  amount: number | null
  product_code: string | null
  line_number: number
  is_non_stock: boolean
}

interface DuplicateCompare {
  current_invoice: Invoice
  firm_duplicate: Invoice | null
  possible_duplicates: Invoice[]
  related_documents: Invoice[]
}

const TOLERANCE = 0.02; // 2p tolerance for rounding

function LineItemsValidation({ lineItems, invoiceTotal, netTotal }: { lineItems: LineItem[]; invoiceTotal: number; netTotal: number | null }) {
  const lineItemsTotal = lineItems.reduce((sum, item) => sum + (item.amount || 0), 0);
  const stockItemsTotal = lineItems
    .filter(item => !item.is_non_stock)
    .reduce((sum, item) => sum + (item.amount || 0), 0);
  const nonStockItemsTotal = lineItems
    .filter(item => item.is_non_stock)
    .reduce((sum, item) => sum + (item.amount || 0), 0);

  const difference = Math.abs(invoiceTotal - lineItemsTotal);
  const exactMatch = difference <= TOLERANCE;
  const isValid = exactMatch;
  const hasNonStock = nonStockItemsTotal > 0;

  return (
    <div style={{
      marginTop: '1rem',
      padding: '0.75rem',
      background: isValid ? '#d4edda' : '#fff3cd',
      borderRadius: '6px',
      border: `1px solid ${isValid ? '#c3e6cb' : '#ffeeba'}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: '500' }}>
          Line Items Total: <strong>£{lineItemsTotal.toFixed(2)}</strong>
        </span>
        <span style={{ fontWeight: '500' }}>
          Invoice Total: <strong>£{invoiceTotal.toFixed(2)}</strong>
          {netTotal && <span style={{ fontSize: '0.85rem', color: '#666' }}> (Net: £{netTotal.toFixed(2)})</span>}
        </span>
      </div>
      {hasNonStock && (
        <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'rgba(255,255,255,0.5)', borderRadius: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
            <span><strong>Stock Items:</strong> £{stockItemsTotal.toFixed(2)}</span>
            <span style={{ color: '#856404' }}><strong>Non-Stock:</strong> £{nonStockItemsTotal.toFixed(2)}</span>
          </div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', color: '#155724' }}>
            GP will be calculated using stock items only
          </div>
        </div>
      )}
      {exactMatch ? (
        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#155724' }}>
          ✓ Totals match
        </div>
      ) : (
        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: isValid ? '#155724' : '#856404' }}>
          {isValid ? '✓ ' : '⚠ '}Difference: £{difference.toFixed(2)}
        </div>
      )}
    </div>
  );
}

export default function Review() {
  const { id } = useParams()
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [total, setTotal] = useState('')
  const [netTotal, setNetTotal] = useState('')
  const [category, setCategory] = useState('food')
  const [orderNumber, setOrderNumber] = useState('')
  const [documentType, setDocumentType] = useState('invoice')
  const [supplierId, setSupplierId] = useState<string>('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showDuplicateModal, setShowDuplicateModal] = useState(false)
  const [showCreateSupplierModal, setShowCreateSupplierModal] = useState(false)
  const [showRawOcrModal, setShowRawOcrModal] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [editingLineItem, setEditingLineItem] = useState<number | null>(null)
  const [lineItemEdits, setLineItemEdits] = useState<Partial<LineItem>>({})

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

  const { data: lineItems, refetch: refetchLineItems } = useQuery<LineItem[]>({
    queryKey: ['invoice-line-items', id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${id}/line-items`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch line items')
      return res.json()
    },
  })

  const { data: duplicateInfo } = useQuery<DuplicateCompare>({
    queryKey: ['invoice-duplicates', id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${id}/duplicates`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch duplicates')
      return res.json()
    },
    enabled: !!invoice?.duplicate_status,
  })

  const { data: rawOcrData } = useQuery<{ raw_json: any; raw_text: string }>({
    queryKey: ['invoice-ocr-data', id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${id}/ocr-data`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch OCR data')
      return res.json()
    },
    enabled: showRawOcrModal,
  })

  const { data: suppliers } = useQuery<Supplier[]>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
  })

  useEffect(() => {
    if (invoice) {
      setInvoiceNumber(invoice.invoice_number || '')
      setInvoiceDate(invoice.invoice_date || '')
      setTotal(invoice.total?.toString() || '')
      setNetTotal(invoice.net_total?.toString() || '')
      setCategory(invoice.category || 'food')
      setOrderNumber(invoice.order_number || '')
      setDocumentType(invoice.document_type || 'invoice')
      setSupplierId(invoice.supplier_id?.toString() || '')
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

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/invoices/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      navigate('/invoices')
    },
  })

  const updateLineItemMutation = useMutation({
    mutationFn: async ({ itemId, data }: { itemId: number; data: Partial<LineItem> }) => {
      const res = await fetch(`/api/invoices/${id}/line-items/${itemId}`, {
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
      refetchLineItems()
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })  // Refresh stock_total
      setEditingLineItem(null)
      setLineItemEdits({})
    },
  })

  const createSupplierMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/suppliers/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to create supplier')
      return res.json()
    },
    onSuccess: (newSupplier: { id: number; name: string }) => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setSupplierId(newSupplier.id.toString())
      setShowCreateSupplierModal(false)
      setNewSupplierName('')
    },
  })

  const handleCreateSupplier = () => {
    if (newSupplierName.trim()) {
      createSupplierMutation.mutate(newSupplierName.trim())
    }
  }

  const openCreateSupplierModal = () => {
    setNewSupplierName(invoice?.vendor_name || '')
    setShowCreateSupplierModal(true)
  }

  const handleSave = async (status: string = 'reviewed') => {
    await updateMutation.mutateAsync({
      invoice_number: invoiceNumber || null,
      invoice_date: invoiceDate || null,
      total: total ? parseFloat(total) : null,
      net_total: netTotal ? parseFloat(netTotal) : null,
      supplier_id: supplierId ? parseInt(supplierId) : null,
      category,
      order_number: orderNumber || null,
      document_type: documentType,
      status,
    })
  }

  const handleConfirm = async () => {
    await handleSave('confirmed')
    navigate('/invoices')
  }

  const handleDelete = () => {
    deleteMutation.mutate()
  }

  const startEditLineItem = (item: LineItem) => {
    setEditingLineItem(item.id)
    setLineItemEdits({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      product_code: item.product_code,
      is_non_stock: item.is_non_stock,
    })
  }

  const saveLineItemEdit = (itemId: number) => {
    updateLineItemMutation.mutate({ itemId, data: lineItemEdits })
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading invoice...</div>
  }

  if (!invoice) {
    return <div style={styles.error}>Invoice not found</div>
  }

  const confidence = invoice.ocr_confidence
    ? (Number(invoice.ocr_confidence) * 100).toFixed(0)
    : null

  // Check if the file is a PDF
  const isPDF = invoice?.image_path?.toLowerCase().endsWith('.pdf')

  return (
    <div style={styles.container}>
      <div style={styles.imageSection}>
        <h3>Invoice {isPDF ? 'Document' : 'Image'}</h3>
        {imageUrl ? (
          isPDF ? (
            <object
              data={imageUrl}
              type="application/pdf"
              style={styles.pdfViewer}
            >
              <div style={styles.pdfFallback}>
                <p>PDF preview not available in your browser.</p>
                <a href={imageUrl} target="_blank" rel="noopener noreferrer" style={styles.pdfLink}>
                  Open PDF in new tab
                </a>
              </div>
            </object>
          ) : (
            <img src={imageUrl} alt="Invoice" style={styles.image} />
          )
        ) : (
          <div style={styles.imagePlaceholder}>Loading {isPDF ? 'document' : 'image'}...</div>
        )}
        {confidence && (
          <div style={styles.confidenceBadge}>
            OCR Confidence: {confidence}%
          </div>
        )}
      </div>

      <div style={styles.formSection}>
        {/* Duplicate Warning Banner */}
        {invoice.duplicate_status && (
          <div
            style={{
              ...styles.duplicateWarning,
              background: invoice.duplicate_status === 'firm_duplicate' ? '#f8d7da' : '#fff3cd',
              borderColor: invoice.duplicate_status === 'firm_duplicate' ? '#f5c6cb' : '#ffeeba',
              color: invoice.duplicate_status === 'firm_duplicate' ? '#721c24' : '#856404',
            }}
            onClick={() => setShowDuplicateModal(true)}
          >
            {invoice.duplicate_status === 'firm_duplicate'
              ? '⚠️ DUPLICATE: This invoice matches an existing record. Click to compare.'
              : '⚠️ Possible duplicate detected. Click to compare.'}
          </div>
        )}

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

          <div style={styles.row}>
            <label style={{ ...styles.label, flex: 1 }}>
              Gross Total (£)
              <input
                type="number"
                step="0.01"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                style={styles.input}
                placeholder="Inc. VAT"
              />
            </label>

            <label style={{ ...styles.label, flex: 1 }}>
              Net Total (£)
              <input
                type="number"
                step="0.01"
                value={netTotal}
                onChange={(e) => setNetTotal(e.target.value)}
                style={styles.input}
                placeholder="Exc. VAT"
              />
            </label>
          </div>

          <div style={styles.label}>
            <span>Supplier</span>
            <div style={styles.supplierRow}>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                style={{ ...styles.input, flex: 1 }}
              >
                <option value="">-- Select Supplier --</option>
                {suppliers?.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={openCreateSupplierModal}
                style={styles.createSupplierBtn}
                title="Create new supplier"
              >
                + New
              </button>
            </div>
            {invoice?.vendor_name && !supplierId && (
              <div style={styles.extractedHintRow}>
                <span style={styles.extractedHint}>Extracted: {invoice.vendor_name}</span>
                <button
                  type="button"
                  onClick={openCreateSupplierModal}
                  style={styles.createFromExtractedBtn}
                >
                  Create "{invoice.vendor_name}"
                </button>
              </div>
            )}
          </div>

          <label style={styles.label}>
            Order/PO Number
            <input
              type="text"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              style={styles.input}
              placeholder="e.g., PO-12345"
            />
          </label>

          <div style={styles.row}>
            <label style={{ ...styles.label, flex: 1 }}>
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

            <label style={{ ...styles.label, flex: 1 }}>
              Document Type
              <select
                value={documentType}
                onChange={(e) => setDocumentType(e.target.value)}
                style={styles.input}
              >
                <option value="invoice">Invoice</option>
                <option value="delivery_note">Delivery Note</option>
              </select>
            </label>
          </div>
        </div>

        {/* Line Items Section */}
        <div style={styles.lineItemsSection}>
          <h4>Line Items</h4>
          {lineItems && lineItems.length > 0 ? (
            <table style={styles.lineItemsTable}>
              <thead>
                <tr>
                  <th style={styles.th}>Description</th>
                  <th style={styles.th}>Qty</th>
                  <th style={styles.th}>Unit</th>
                  <th style={styles.th}>Amount</th>
                  <th style={{ ...styles.th, textAlign: 'center' }}>Non-Stock</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item) => (
                  <tr key={item.id}>
                    {editingLineItem === item.id ? (
                      <>
                        <td style={styles.td}>
                          <input
                            type="text"
                            value={lineItemEdits.description || ''}
                            onChange={(e) => setLineItemEdits({ ...lineItemEdits, description: e.target.value })}
                            style={styles.tableInput}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            step="0.01"
                            value={lineItemEdits.quantity || ''}
                            onChange={(e) => setLineItemEdits({ ...lineItemEdits, quantity: parseFloat(e.target.value) })}
                            style={{ ...styles.tableInput, width: '60px' }}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            step="0.01"
                            value={lineItemEdits.unit_price || ''}
                            onChange={(e) => setLineItemEdits({ ...lineItemEdits, unit_price: parseFloat(e.target.value) })}
                            style={{ ...styles.tableInput, width: '70px' }}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            step="0.01"
                            value={lineItemEdits.amount || ''}
                            onChange={(e) => setLineItemEdits({ ...lineItemEdits, amount: parseFloat(e.target.value) })}
                            style={{ ...styles.tableInput, width: '70px' }}
                          />
                        </td>
                        <td style={{ ...styles.td, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={lineItemEdits.is_non_stock || false}
                            onChange={(e) => setLineItemEdits({ ...lineItemEdits, is_non_stock: e.target.checked })}
                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                          />
                        </td>
                        <td style={styles.td}>
                          <button onClick={() => saveLineItemEdit(item.id)} style={styles.smallBtn}>Save</button>
                          <button onClick={() => setEditingLineItem(null)} style={styles.smallBtnCancel}>X</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td style={{ ...styles.td, ...(item.is_non_stock ? { color: '#856404', fontStyle: 'italic' } : {}) }}>
                          {item.description || '—'}
                        </td>
                        <td style={styles.td}>{item.quantity?.toFixed(2) || '—'}</td>
                        <td style={styles.td}>{item.unit_price ? `£${item.unit_price.toFixed(2)}` : '—'}</td>
                        <td style={styles.td}>{item.amount ? `£${item.amount.toFixed(2)}` : '—'}</td>
                        <td style={{ ...styles.td, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={item.is_non_stock}
                            onChange={(e) => {
                              updateLineItemMutation.mutate({
                                itemId: item.id,
                                data: { is_non_stock: e.target.checked }
                              })
                            }}
                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                            title={item.is_non_stock ? 'Mark as stock item' : 'Mark as non-stock item'}
                          />
                        </td>
                        <td style={styles.td}>
                          <button onClick={() => startEditLineItem(item)} style={styles.editBtn}>Edit</button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={styles.noItems}>No line items extracted</p>
          )}

          {/* Line Items Total Validation */}
          {lineItems && lineItems.length > 0 && (
            <LineItemsValidation
              lineItems={lineItems}
              invoiceTotal={parseFloat(total) || 0}
              netTotal={netTotal ? parseFloat(netTotal) : null}
            />
          )}
        </div>

        <div style={styles.status}>
          Current status: <strong>{invoice.status}</strong>
          {invoice.document_type === 'delivery_note' && (
            <span style={styles.docTypeBadge}>Delivery Note</span>
          )}
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
          onClick={() => setShowDeleteModal(true)}
          style={styles.deleteBtn}
        >
          Delete Invoice
        </button>

        <button
          onClick={() => setShowRawOcrModal(true)}
          style={styles.rawOcrBtn}
        >
          View Raw OCR Data
        </button>

        <button onClick={() => navigate('/invoices')} style={styles.backBtn}>
          ← Back to Invoices
        </button>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div style={styles.modalOverlay} onClick={() => setShowDeleteModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Delete Invoice?</h3>
            <div style={styles.modalInfo}>
              <p><strong>Invoice #:</strong> {invoice.invoice_number || 'N/A'}</p>
              <p><strong>Date:</strong> {invoice.invoice_date || 'N/A'}</p>
              <p><strong>Total:</strong> {invoice.total ? `£${Number(invoice.total).toFixed(2)}` : 'N/A'}</p>
            </div>
            {invoice.duplicate_status && (
              <div style={styles.modalDuplicateInfo}>
                This invoice is marked as a {invoice.duplicate_status === 'firm_duplicate' ? 'duplicate' : 'possible duplicate'}.
                Deleting it will resolve the duplicate warning.
              </div>
            )}
            <div style={styles.modalActions}>
              <button onClick={() => setShowDeleteModal(false)} style={styles.cancelBtn}>Cancel</button>
              <button onClick={handleDelete} style={styles.confirmDeleteBtn}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate Comparison Modal */}
      {showDuplicateModal && duplicateInfo && (
        <div style={styles.modalOverlay} onClick={() => setShowDuplicateModal(false)}>
          <div style={styles.wideModal} onClick={(e) => e.stopPropagation()}>
            <h3>Duplicate Comparison</h3>
            <div style={styles.compareGrid}>
              <div style={styles.compareCard}>
                <h4>Current Invoice</h4>
                <p><strong>Invoice #:</strong> {duplicateInfo.current_invoice.invoice_number || '—'}</p>
                <p><strong>Date:</strong> {duplicateInfo.current_invoice.invoice_date || '—'}</p>
                <p><strong>Total:</strong> {duplicateInfo.current_invoice.total ? `£${Number(duplicateInfo.current_invoice.total).toFixed(2)}` : '—'}</p>
                <p><strong>Order #:</strong> {duplicateInfo.current_invoice.order_number || '—'}</p>
                <p><strong>Type:</strong> {duplicateInfo.current_invoice.document_type || 'invoice'}</p>
              </div>

              {duplicateInfo.firm_duplicate && (
                <div style={{ ...styles.compareCard, borderColor: '#dc3545' }}>
                  <h4 style={{ color: '#dc3545' }}>Exact Duplicate</h4>
                  <p><strong>Invoice #:</strong> {duplicateInfo.firm_duplicate.invoice_number || '—'}</p>
                  <p><strong>Date:</strong> {duplicateInfo.firm_duplicate.invoice_date || '—'}</p>
                  <p><strong>Total:</strong> {duplicateInfo.firm_duplicate.total ? `£${Number(duplicateInfo.firm_duplicate.total).toFixed(2)}` : '—'}</p>
                  <p><strong>Order #:</strong> {duplicateInfo.firm_duplicate.order_number || '—'}</p>
                  <p><strong>Type:</strong> {duplicateInfo.firm_duplicate.document_type || 'invoice'}</p>
                  <button
                    onClick={() => navigate(`/invoice/${duplicateInfo.firm_duplicate!.id}`)}
                    style={styles.viewBtn}
                  >
                    View This Invoice
                  </button>
                </div>
              )}

              {duplicateInfo.possible_duplicates.map((dup) => (
                <div key={dup.id} style={{ ...styles.compareCard, borderColor: '#ffc107' }}>
                  <h4 style={{ color: '#856404' }}>Possible Duplicate</h4>
                  <p><strong>Invoice #:</strong> {dup.invoice_number || '—'}</p>
                  <p><strong>Date:</strong> {dup.invoice_date || '—'}</p>
                  <p><strong>Total:</strong> {dup.total ? `£${Number(dup.total).toFixed(2)}` : '—'}</p>
                  <p><strong>Order #:</strong> {dup.order_number || '—'}</p>
                  <button
                    onClick={() => navigate(`/invoice/${dup.id}`)}
                    style={styles.viewBtn}
                  >
                    View This Invoice
                  </button>
                </div>
              ))}

              {duplicateInfo.related_documents.map((doc) => (
                <div key={doc.id} style={{ ...styles.compareCard, borderColor: '#17a2b8' }}>
                  <h4 style={{ color: '#17a2b8' }}>Related {doc.document_type === 'delivery_note' ? 'Delivery Note' : 'Invoice'}</h4>
                  <p><strong>Invoice #:</strong> {doc.invoice_number || '—'}</p>
                  <p><strong>Date:</strong> {doc.invoice_date || '—'}</p>
                  <p><strong>Total:</strong> {doc.total ? `£${Number(doc.total).toFixed(2)}` : '—'}</p>
                  <p><strong>Order #:</strong> {doc.order_number || '—'}</p>
                  <button
                    onClick={() => navigate(`/invoice/${doc.id}`)}
                    style={styles.viewBtn}
                  >
                    View This Invoice
                  </button>
                </div>
              ))}
            </div>
            <button onClick={() => setShowDuplicateModal(false)} style={styles.closeBtn}>Close</button>
          </div>
        </div>
      )}

      {/* Create Supplier Modal */}
      {showCreateSupplierModal && (
        <div style={styles.modalOverlay} onClick={() => setShowCreateSupplierModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Create New Supplier</h3>
            <label style={styles.modalLabel}>
              Supplier Name
              <input
                type="text"
                value={newSupplierName}
                onChange={(e) => setNewSupplierName(e.target.value)}
                style={styles.input}
                placeholder="e.g., Sysco, US Foods"
                autoFocus
              />
            </label>
            <div style={styles.modalActions}>
              <button onClick={() => setShowCreateSupplierModal(false)} style={styles.cancelBtn}>
                Cancel
              </button>
              <button
                onClick={handleCreateSupplier}
                style={styles.saveBtn}
                disabled={!newSupplierName.trim() || createSupplierMutation.isPending}
              >
                {createSupplierMutation.isPending ? 'Creating...' : 'Create & Select'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Raw OCR Data Modal */}
      {showRawOcrModal && (
        <div style={styles.modalOverlay} onClick={() => setShowRawOcrModal(false)}>
          <div style={styles.rawOcrModal} onClick={(e) => e.stopPropagation()}>
            <h3>Raw Azure OCR Data</h3>
            <p style={styles.rawOcrHint}>
              This shows the raw data extracted by Azure. Use this to debug field extraction issues
              or identify custom field names that need mapping.
            </p>
            {rawOcrData?.raw_json ? (
              <div style={styles.rawOcrContent}>
                <h4>Extracted Fields</h4>
                {rawOcrData.raw_json.documents?.map((doc: any, docIdx: number) => (
                  <div key={docIdx} style={styles.rawOcrDoc}>
                    <h5>Document {docIdx + 1} (Confidence: {(doc.confidence * 100).toFixed(1)}%)</h5>
                    <table style={styles.rawOcrTable}>
                      <thead>
                        <tr>
                          <th style={styles.rawOcrTh}>Field</th>
                          <th style={styles.rawOcrTh}>Value</th>
                          <th style={styles.rawOcrTh}>Content</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(doc.fields || {}).map(([fieldName, field]: [string, any]) => (
                          <tr key={fieldName}>
                            <td style={styles.rawOcrTd}><strong>{fieldName}</strong></td>
                            <td style={styles.rawOcrTd}>
                              {typeof field?.value === 'object'
                                ? JSON.stringify(field?.value, null, 2)
                                : String(field?.value ?? '—')}
                            </td>
                            <td style={styles.rawOcrTd}>{field?.content || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: '#999' }}>No raw OCR data available for this invoice.</p>
            )}
            <button onClick={() => setShowRawOcrModal(false)} style={styles.closeBtn}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: '2rem', textAlign: 'center', color: '#666' },
  error: { padding: '2rem', textAlign: 'center', color: '#c00' },
  container: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' },
  imageSection: { background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  image: { width: '100%', borderRadius: '8px', marginTop: '1rem' },
  imagePlaceholder: { width: '100%', height: '300px', background: '#f5f5f5', borderRadius: '8px', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' },
  pdfViewer: { width: '100%', height: '600px', borderRadius: '8px', marginTop: '1rem', border: '1px solid #ddd' },
  pdfFallback: { width: '100%', height: '300px', background: '#f5f5f5', borderRadius: '8px', marginTop: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#666' },
  pdfLink: { marginTop: '1rem', padding: '0.75rem 1.5rem', background: '#1a1a2e', color: 'white', textDecoration: 'none', borderRadius: '6px' },
  confidenceBadge: { marginTop: '1rem', padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '20px', textAlign: 'center', fontSize: '0.9rem', color: '#666' },
  formSection: { background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  duplicateWarning: { padding: '1rem', borderRadius: '8px', marginBottom: '1rem', cursor: 'pointer', border: '1px solid', fontWeight: '500' },
  hint: { color: '#666', marginBottom: '1.5rem' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  row: { display: 'flex', gap: '1rem' },
  label: { display: 'flex', flexDirection: 'column', gap: '0.5rem', color: '#333', fontWeight: '500' },
  input: { padding: '0.75rem', borderRadius: '6px', border: '1px solid #ddd', fontSize: '1rem' },
  extractedHint: { fontSize: '0.8rem', color: '#666', fontWeight: 'normal', fontStyle: 'italic' },
  extractedHintRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' },
  supplierRow: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  createSupplierBtn: { padding: '0.75rem 1rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', whiteSpace: 'nowrap' },
  createFromExtractedBtn: { padding: '0.25rem 0.5rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'normal' },
  modalLabel: { display: 'flex', flexDirection: 'column', gap: '0.5rem', color: '#333', fontWeight: '500', marginTop: '1rem' },
  lineItemsSection: { marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid #eee' },
  lineItemsTable: { width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem', fontSize: '0.9rem' },
  th: { textAlign: 'left', padding: '0.5rem', borderBottom: '2px solid #ddd', fontWeight: '600' },
  td: { padding: '0.5rem', borderBottom: '1px solid #eee' },
  tableInput: { padding: '0.25rem', borderRadius: '4px', border: '1px solid #ddd', fontSize: '0.85rem' },
  smallBtn: { padding: '0.25rem 0.5rem', background: '#5cb85c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginRight: '0.25rem', fontSize: '0.75rem' },
  smallBtnCancel: { padding: '0.25rem 0.5rem', background: '#999', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' },
  editBtn: { padding: '0.25rem 0.5rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' },
  nonStockBadge: { padding: '0.125rem 0.375rem', background: '#fff3cd', color: '#856404', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '500' },
  noItems: { color: '#999', fontStyle: 'italic', marginTop: '0.5rem' },
  status: { marginTop: '1.5rem', padding: '1rem', background: '#f5f5f5', borderRadius: '6px', color: '#666' },
  docTypeBadge: { marginLeft: '1rem', padding: '0.25rem 0.5rem', background: '#17a2b8', color: 'white', borderRadius: '4px', fontSize: '0.75rem' },
  actions: { display: 'flex', gap: '1rem', marginTop: '1.5rem' },
  saveBtn: { flex: 1, padding: '0.75rem', background: '#1a1a2e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' },
  confirmBtn: { flex: 1, padding: '0.75rem', background: '#5cb85c', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' },
  deleteBtn: { marginTop: '1rem', padding: '0.75rem', background: '#dc3545', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', width: '100%' },
  rawOcrBtn: { marginTop: '0.5rem', padding: '0.75rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', width: '100%', fontSize: '0.9rem' },
  backBtn: { marginTop: '0.5rem', padding: '0.75rem', background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', width: '100%' },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'white', padding: '2rem', borderRadius: '12px', maxWidth: '400px', width: '90%' },
  wideModal: { background: 'white', padding: '2rem', borderRadius: '12px', maxWidth: '800px', width: '90%', maxHeight: '80vh', overflowY: 'auto' },
  modalInfo: { margin: '1rem 0', padding: '1rem', background: '#f5f5f5', borderRadius: '8px' },
  modalDuplicateInfo: { padding: '0.75rem', background: '#d4edda', borderRadius: '6px', marginBottom: '1rem', color: '#155724', fontSize: '0.9rem' },
  modalActions: { display: 'flex', gap: '1rem', marginTop: '1.5rem' },
  cancelBtn: { flex: 1, padding: '0.75rem', background: '#f0f0f0', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  confirmDeleteBtn: { flex: 1, padding: '0.75rem', background: '#dc3545', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' },
  compareGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginTop: '1rem' },
  compareCard: { padding: '1rem', border: '2px solid #ddd', borderRadius: '8px' },
  viewBtn: { marginTop: '0.5rem', padding: '0.5rem', background: '#1a1a2e', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', width: '100%', fontSize: '0.85rem' },
  closeBtn: { marginTop: '1.5rem', padding: '0.75rem 2rem', background: '#1a1a2e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' },
  rawOcrModal: { background: 'white', padding: '2rem', borderRadius: '12px', maxWidth: '900px', width: '95%', maxHeight: '85vh', overflowY: 'auto' },
  rawOcrHint: { color: '#666', fontSize: '0.9rem', marginBottom: '1rem' },
  rawOcrContent: { marginTop: '1rem' },
  rawOcrDoc: { marginBottom: '1.5rem', padding: '1rem', background: '#f8f9fa', borderRadius: '8px' },
  rawOcrTable: { width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem', fontSize: '0.85rem' },
  rawOcrTh: { textAlign: 'left', padding: '0.5rem', borderBottom: '2px solid #ddd', fontWeight: '600', background: '#e9ecef' },
  rawOcrTd: { padding: '0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word', maxWidth: '300px' },
}
