/**
 * Product Definitions Search Page
 * Search and browse product definitions with portion info.
 */
import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import {
  useDebounce,
  usePersistedState,
  formatQuantity,
  formatCurrency,
  SEARCH_STORAGE_KEYS,
} from '../utils/searchHelpers'
import * as pdfjsLib from 'pdfjs-dist'

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

interface ProductDefinition {
  id: number
  product_code: string | null
  description_pattern: string | null
  supplier_id: number | null
  supplier_name: string | null
  pack_quantity: number | null
  unit_size: number | null
  unit_size_type: string | null
  portions_per_unit: number | null
  portion_description: string | null
  source_invoice_id: number | null
  source_invoice_number: string | null
  most_recent_price: number | null
  updated_at: string | null
}

interface SearchResponse {
  items: ProductDefinition[]
  total_count: number
}

interface Supplier {
  id: number
  name: string
}

interface LineItem {
  id: number
  product_code: string | null
  description: string | null
  line_number: number
  unit_price: number | null
  quantity: number | null
  unit: string | null
  net_total: number | null
}

interface OcrData {
  raw_json: any
  raw_text: string
}

const keys = SEARCH_STORAGE_KEYS.definitions

export default function SearchDefinitions() {
  const { token } = useAuth()
  const queryClient = useQueryClient()

  // Persisted search state
  const [searchInput, setSearchInput] = usePersistedState(keys.query, '')
  const [supplierId, setSupplierId] = usePersistedState<string>(keys.supplier, '')
  const [hasPortions, setHasPortions] = usePersistedState<string>(keys.hasPortions, '')
  const [sortColumn, setSortColumn] = usePersistedState<string>(keys.sortColumn, '')
  const [sortDirection, setSortDirection] = usePersistedState<'asc' | 'desc'>(keys.sortDirection, 'asc')

  // Edit modal state
  const [editingDef, setEditingDef] = useState<ProductDefinition | null>(null)
  const [editFormData, setEditFormData] = useState<{
    pack_quantity: number | null
    unit_size: number | null
    unit_size_type: string | null
    portions_per_unit: number | null
    portion_description: string
  }>({
    pack_quantity: null,
    unit_size: null,
    unit_size_type: null,
    portions_per_unit: null,
    portion_description: '',
  })

  // Image/PDF state for edit modal
  const [invoiceImageUrl, setInvoiceImageUrl] = useState<string | null>(null)
  const [isPDF, setIsPDF] = useState(false)
  const [pdfCanvas, setPdfCanvas] = useState<HTMLCanvasElement | null>(null)
  const [croppedImageUrl, setCroppedImageUrl] = useState<string | null>(null)
  const [matchingLineItem, setMatchingLineItem] = useState<LineItem | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  // Debounce search input
  const debouncedSearch = useDebounce(searchInput, 300)

  // Fetch suppliers
  const { data: suppliers } = useQuery<Supplier[]>({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await fetch('/api/suppliers/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch suppliers')
      return res.json()
    },
  })

  // Search definitions
  const { data, isLoading, error } = useQuery<SearchResponse>({
    queryKey: ['search-definitions', debouncedSearch, supplierId, hasPortions],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('q', debouncedSearch)
      if (supplierId) params.set('supplier_id', supplierId)
      if (hasPortions === 'yes') params.set('has_portions', 'true')
      if (hasPortions === 'no') params.set('has_portions', 'false')
      params.set('limit', '200')

      const res = await fetch(`/api/search/definitions?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Search failed')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch invoice line items when editing (to find matching line item for bounding box)
  const { data: lineItems } = useQuery<LineItem[]>({
    queryKey: ['invoice-line-items', editingDef?.source_invoice_id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${editingDef!.source_invoice_id}/line-items`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch line items')
      return res.json()
    },
    enabled: !!editingDef?.source_invoice_id,
  })

  // Fetch OCR data for bounding box
  const { data: ocrData } = useQuery<OcrData>({
    queryKey: ['invoice-ocr-data', editingDef?.source_invoice_id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${editingDef!.source_invoice_id}/ocr-data`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch OCR data')
      return res.json()
    },
    enabled: !!editingDef?.source_invoice_id,
  })

  // Update definition mutation
  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; updates: typeof editFormData }) => {
      const res = await fetch(`/api/search/definitions/${data.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data.updates),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Failed to update definition')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['search-definitions'] })
      setEditingDef(null)
    },
  })

  // Load invoice image when editing
  useEffect(() => {
    if (!editingDef?.source_invoice_id) {
      setInvoiceImageUrl(null)
      setIsPDF(false)
      setPdfCanvas(null)
      setCroppedImageUrl(null)
      return
    }

    const url = `/api/invoices/${editingDef.source_invoice_id}/image`
    setInvoiceImageUrl(url)

    // Check if PDF by fetching headers
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        const contentType = res.headers.get('content-type') || ''
        setIsPDF(contentType.includes('pdf'))
        if (contentType.includes('pdf')) {
          return res.arrayBuffer()
        }
        return null
      })
      .then(async (arrayBuffer) => {
        if (arrayBuffer) {
          // Render PDF to canvas
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
          const page = await pdf.getPage(1)
          const scale = 2
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')
          if (ctx) {
            await page.render({ canvas, canvasContext: ctx, viewport }).promise
            setPdfCanvas(canvas)
          }
        }
      })
      .catch(console.error)
  }, [editingDef?.source_invoice_id, token])

  // Find matching line item and crop bounding box
  useEffect(() => {
    if (!editingDef || !lineItems || !ocrData?.raw_json) {
      setCroppedImageUrl(null)
      setMatchingLineItem(null)
      return
    }

    // Find the line item that matches this definition
    const matchingIdx = lineItems.findIndex((item) => {
      if (editingDef.product_code && item.product_code) {
        return item.product_code === editingDef.product_code
      }
      if (editingDef.description_pattern && item.description) {
        return item.description.toLowerCase().includes(editingDef.description_pattern.toLowerCase())
      }
      return false
    })

    if (matchingIdx < 0) {
      setCroppedImageUrl(null)
      setMatchingLineItem(null)
      return
    }

    // Store the matching line item
    setMatchingLineItem(lineItems[matchingIdx])

    // Get bounding box from OCR data
    const bboxRegion = ocrData.raw_json?.documents?.[0]?.fields?.Items?.value?.[matchingIdx]?.bounding_regions?.[0]
    if (!bboxRegion?.polygon) {
      setCroppedImageUrl(null)
      return
    }

    const polygon = bboxRegion.polygon
    const pageNumber = bboxRegion.page_number || 1
    const pageInfo = ocrData.raw_json.pages?.[pageNumber - 1]
    const pageWidth = pageInfo?.width || 8.5
    const pageHeight = pageInfo?.height || 11

    const xs = polygon.map((p: number[]) => p[0])
    const ys = polygon.map((p: number[]) => p[1])
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // Convert to percentages
    const bboxPercent = {
      x: (minX / pageWidth) * 100,
      y: (minY / pageHeight) * 100,
      width: ((maxX - minX) / pageWidth) * 100,
      height: ((maxY - minY) / pageHeight) * 100,
    }

    // Create cropped image
    const sourceCanvas = isPDF ? pdfCanvas : null
    const sourceImage = !isPDF ? imageRef.current : null

    if (!sourceCanvas && !sourceImage) return

    const sourceWidth = sourceCanvas?.width || sourceImage?.naturalWidth || 0
    const sourceHeight = sourceCanvas?.height || sourceImage?.naturalHeight || 0

    if (sourceWidth === 0 || sourceHeight === 0) return

    const cropX = (bboxPercent.x / 100) * sourceWidth
    const cropY = (bboxPercent.y / 100) * sourceHeight
    const cropW = (bboxPercent.width / 100) * sourceWidth
    const cropH = (bboxPercent.height / 100) * sourceHeight

    const horzPadding = 40
    const vertPadding = 20
    const startX = Math.max(0, cropX - horzPadding)
    const startY = Math.max(0, cropY - vertPadding)
    const endX = Math.min(sourceWidth, cropX + cropW + horzPadding)
    const endY = Math.min(sourceHeight, cropY + cropH + vertPadding)
    const finalW = endX - startX
    const finalH = endY - startY

    const croppedCanvas = document.createElement('canvas')
    croppedCanvas.width = finalW
    croppedCanvas.height = finalH
    const ctx = croppedCanvas.getContext('2d')
    if (ctx) {
      if (sourceCanvas) {
        ctx.drawImage(sourceCanvas, startX, startY, finalW, finalH, 0, 0, finalW, finalH)
      } else if (sourceImage) {
        ctx.drawImage(sourceImage, startX, startY, finalW, finalH, 0, 0, finalW, finalH)
      }
      setCroppedImageUrl(croppedCanvas.toDataURL())
    }
  }, [editingDef, lineItems, ocrData, isPDF, pdfCanvas])

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const getSortIndicator = (column: string) => {
    if (sortColumn !== column) return null
    return sortDirection === 'asc' ? ' ▲' : ' ▼'
  }

  // Sort items
  const sortedItems = useMemo(() => {
    if (!data?.items || !sortColumn) return data?.items || []

    const sorted = [...data.items].sort((a, b) => {
      let aVal: any
      let bVal: any

      switch (sortColumn) {
        case 'code':
          aVal = a.product_code || ''
          bVal = b.product_code || ''
          break
        case 'description':
          aVal = a.description_pattern || ''
          bVal = b.description_pattern || ''
          break
        case 'supplier':
          aVal = a.supplier_name || ''
          bVal = b.supplier_name || ''
          break
        case 'pack_quantity':
          aVal = a.pack_quantity ?? -Infinity
          bVal = b.pack_quantity ?? -Infinity
          break
        case 'portions_per_unit':
          aVal = a.portions_per_unit ?? -Infinity
          bVal = b.portions_per_unit ?? -Infinity
          break
        case 'portion_cost':
          aVal = (a.portions_per_unit && a.pack_quantity && a.most_recent_price)
            ? (typeof a.most_recent_price === 'string' ? parseFloat(a.most_recent_price) : a.most_recent_price) / (a.pack_quantity * a.portions_per_unit)
            : -Infinity
          bVal = (b.portions_per_unit && b.pack_quantity && b.most_recent_price)
            ? (typeof b.most_recent_price === 'string' ? parseFloat(b.most_recent_price) : b.most_recent_price) / (b.pack_quantity * b.portions_per_unit)
            : -Infinity
          break
        case 'source':
          aVal = a.source_invoice_number || ''
          bVal = b.source_invoice_number || ''
          break
        default:
          return 0
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal)
      } else {
        return sortDirection === 'asc'
          ? aVal - bVal
          : bVal - aVal
      }
    })

    return sorted
  }, [data?.items, sortColumn, sortDirection])

  // Group by supplier for summary
  const supplierSummary = useMemo(() => {
    if (!sortedItems) return null
    const summary: Record<string, { count: number; withPortions: number }> = {}
    for (const item of sortedItems) {
      const name = item.supplier_name || 'Unknown'
      if (!summary[name]) summary[name] = { count: 0, withPortions: 0 }
      summary[name].count++
      if (item.portions_per_unit) summary[name].withPortions++
    }
    return summary
  }, [sortedItems])

  const openEditModal = (def: ProductDefinition) => {
    setEditingDef(def)
    setEditFormData({
      pack_quantity: def.pack_quantity,
      unit_size: def.unit_size,
      unit_size_type: def.unit_size_type,
      portions_per_unit: def.portions_per_unit,
      portion_description: def.portion_description || '',
    })
    // Clear previous modal state
    setCroppedImageUrl(null)
    setMatchingLineItem(null)
  }

  const handleSave = () => {
    if (!editingDef) return
    updateMutation.mutate({
      id: editingDef.id,
      updates: editFormData,
    })
  }

  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '20px' }}>Search Product Definitions</h1>

      {/* Search Controls */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: '#f8fafc',
          borderRadius: '8px',
        }}
      >
        <input
          type="text"
          placeholder="Search product code, description..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{
            flex: '1 1 300px',
            padding: '8px 12px',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            fontSize: '14px',
          }}
        />

        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">All Suppliers</option>
          {suppliers?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          value={hasPortions}
          onChange={(e) => setHasPortions(e.target.value)}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
        >
          <option value="">All Definitions</option>
          <option value="yes">Has Portions Defined</option>
          <option value="no">No Portions Defined</option>
        </select>
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: '16px',
          marginBottom: '16px',
          fontSize: '13px',
          color: '#6b7280',
        }}
      >
        <span>
          <span style={{ color: '#8b5cf6' }}>📦</span> Has portions defined
        </span>
        <span>
          <span style={{ color: '#9ca3af' }}>○</span> No portions defined
        </span>
      </div>

      {/* Results */}
      {isLoading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>Error: {(error as Error).message}</p>}

      {data && (
        <div>
          <p style={{ marginBottom: '12px', color: '#6b7280' }}>
            Found {data.total_count} definition{data.total_count !== 1 ? 's' : ''}
          </p>

          {/* Supplier Summary */}
          {supplierSummary && Object.keys(supplierSummary).length > 1 && (
            <div
              style={{
                marginBottom: '16px',
                padding: '12px',
                backgroundColor: '#f1f5f9',
                borderRadius: '8px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '16px',
              }}
            >
              {Object.entries(supplierSummary).map(([name, stats]) => (
                <div key={name} style={{ fontSize: '13px' }}>
                  <strong>{name}:</strong> {stats.count} ({stats.withPortions} with portions)
                </div>
              ))}
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
              <thead>
                <tr style={{ backgroundColor: '#f1f5f9' }}>
                  <th style={thStyleClickable} onClick={() => handleSort('code')}>
                    Code{getSortIndicator('code')}
                  </th>
                  <th style={{ ...thStyleClickable, minWidth: '280px' }} onClick={() => handleSort('description')}>
                    Description{getSortIndicator('description')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('supplier')}>
                    Supplier{getSortIndicator('supplier')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('pack_quantity')}>
                    Pack/Unit{getSortIndicator('pack_quantity')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('portions_per_unit')}>
                    Portions/Unit{getSortIndicator('portions_per_unit')}
                  </th>
                  <th style={thStyle}>Portion Desc</th>
                  <th style={{ ...thStyleClickable, textAlign: 'right' }} onClick={() => handleSort('portion_cost')}>
                    Portion Cost{getSortIndicator('portion_cost')}
                  </th>
                  <th style={thStyleClickable} onClick={() => handleSort('source')}>
                    Source{getSortIndicator('source')}
                  </th>
                  <th style={{ ...thStyle, width: '60px' }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((def) => (
                  <tr key={def.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={tdStyle}>{def.product_code || '-'}</td>
                    <td style={tdStyle}>
                      {def.description_pattern || '-'}
                      {def.portions_per_unit ? (
                        <span style={{ marginLeft: '6px', color: '#8b5cf6' }}>📦</span>
                      ) : (
                        <span style={{ marginLeft: '6px', color: '#9ca3af' }}>○</span>
                      )}
                    </td>
                    <td style={tdStyle}>{def.supplier_name || '-'}</td>
                    <td style={tdStyle}>
                      {def.pack_quantity || def.unit_size ? (
                        <>
                          {def.pack_quantity && `${def.pack_quantity}x `}
                          {def.unit_size && `${def.unit_size}${def.unit_size_type || ''}`}
                        </>
                      ) : '-'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      {formatQuantity(def.portions_per_unit)}
                    </td>
                    <td style={tdStyle}>
                      {def.portion_description ? (
                        <span
                          title={def.portion_description}
                          style={{
                            maxWidth: '150px',
                            display: 'inline-block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {def.portion_description}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      {def.portions_per_unit && def.pack_quantity && def.most_recent_price ? (
                        <span style={{ color: '#16a34a', fontWeight: 600 }}>
                          {formatCurrency(
                            (typeof def.most_recent_price === 'string'
                              ? parseFloat(def.most_recent_price)
                              : def.most_recent_price) / (def.pack_quantity * def.portions_per_unit)
                          )}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td style={tdStyle}>
                      {def.source_invoice_number ? (
                        <a
                          href={`/invoice/${def.source_invoice_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#2563eb', textDecoration: 'none' }}
                        >
                          {def.source_invoice_number}
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td style={tdStyle}>
                      <button
                        onClick={() => openEditModal(def)}
                        style={{
                          padding: '4px 8px',
                          background: '#f0f0f0',
                          border: '1px solid #ddd',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '12px',
                        }}
                        title="Edit definition"
                      >
                        ✏️
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingDef && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setEditingDef(null)}
        >
          <div
            style={{
              background: 'white',
              padding: '24px',
              borderRadius: '12px',
              maxWidth: '700px',
              width: '95%',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginBottom: '16px' }}>Edit Definition</h2>

            {/* Product Info */}
            <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
              <div><strong>Code:</strong> {editingDef.product_code || '-'}</div>
              <div><strong>Description:</strong> {editingDef.description_pattern || '-'}</div>
              <div><strong>Supplier:</strong> {editingDef.supplier_name || '-'}</div>
              {editingDef.source_invoice_number && (
                <div>
                  <strong>Source Invoice:</strong>{' '}
                  <a
                    href={`/invoice/${editingDef.source_invoice_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#2563eb' }}
                  >
                    {editingDef.source_invoice_number}
                  </a>
                </div>
              )}
            </div>

            {/* Cropped Invoice Image */}
            {croppedImageUrl && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>
                  Line Item from Invoice:
                </label>
                <div
                  style={{
                    background: '#fff',
                    borderRadius: '4px',
                    padding: '8px',
                    border: '1px solid #ddd',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <img
                    src={croppedImageUrl}
                    alt="Line item from invoice"
                    style={{ maxWidth: '100%', height: 'auto', borderRadius: '2px' }}
                  />
                </div>
              </div>
            )}

            {/* Hidden image for non-PDF sources */}
            {invoiceImageUrl && !isPDF && (
              <img
                ref={imageRef}
                src={invoiceImageUrl}
                alt=""
                style={{ display: 'none' }}
                crossOrigin="anonymous"
                onLoad={() => {
                  // Trigger re-render to crop image
                  setCroppedImageUrl(null)
                  setTimeout(() => {
                    if (imageRef.current && editingDef && lineItems && ocrData) {
                      // Re-trigger effect
                      setEditingDef({ ...editingDef })
                    }
                  }, 100)
                }}
              />
            )}

            {/* Line Item Details & Cost Calculations */}
            {matchingLineItem && (
              <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f0fdf4', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>
                  Invoice Line Item Details:
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '14px' }}>
                  <div>
                    <span style={{ color: '#6b7280' }}>Unit Price:</span>{' '}
                    <strong>{formatCurrency(matchingLineItem.unit_price)}</strong>
                  </div>
                  <div>
                    <span style={{ color: '#6b7280' }}>Qty:</span>{' '}
                    <strong>{formatQuantity(matchingLineItem.quantity, 0)}</strong>
                  </div>
                  {matchingLineItem.unit && (
                    <div>
                      <span style={{ color: '#6b7280' }}>Unit:</span>{' '}
                      <strong>{matchingLineItem.unit}</strong>
                    </div>
                  )}
                  <div>
                    <span style={{ color: '#6b7280' }}>Net Total:</span>{' '}
                    <strong>{formatCurrency(matchingLineItem.net_total)}</strong>
                  </div>
                </div>

                {/* Portion Cost Calculations */}
                {editFormData.portions_per_unit && editFormData.pack_quantity && matchingLineItem.unit_price && (
                  <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #bbf7d0' }}>
                    <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>
                      Portion Cost Breakdown:
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '14px' }}>
                      <div>
                        <span style={{ color: '#6b7280' }}>Pack Qty:</span>{' '}
                        <strong>{editFormData.pack_quantity}</strong>
                      </div>
                      <div>
                        <span style={{ color: '#6b7280' }}>Portions per Unit:</span>{' '}
                        <strong>{editFormData.portions_per_unit}</strong>
                      </div>
                      <div>
                        <span style={{ color: '#6b7280' }}>Cost per Portion:</span>{' '}
                        <strong style={{ color: '#16a34a' }}>
                          {formatCurrency(
                            (typeof matchingLineItem.unit_price === 'string'
                              ? parseFloat(matchingLineItem.unit_price)
                              : matchingLineItem.unit_price) / (editFormData.pack_quantity * editFormData.portions_per_unit)
                          )}
                        </strong>
                      </div>
                      {editFormData.portion_description && (
                        <div>
                          <span style={{ color: '#6b7280' }}>Portion Size:</span>{' '}
                          <strong>{editFormData.portion_description}</strong>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Edit Fields */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
              <div style={{ flex: '1 1 100px' }}>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>Pack Qty</label>
                <input
                  type="number"
                  value={editFormData.pack_quantity ?? ''}
                  onChange={(e) => setEditFormData({ ...editFormData, pack_quantity: e.target.value ? parseInt(e.target.value) : null })}
                  style={inputStyle}
                  placeholder="e.g., 120"
                />
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>Unit Size</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input
                    type="number"
                    step="0.1"
                    value={editFormData.unit_size ?? ''}
                    onChange={(e) => setEditFormData({ ...editFormData, unit_size: e.target.value ? parseFloat(e.target.value) : null })}
                    style={{ ...inputStyle, width: '70px' }}
                    placeholder="e.g., 15"
                  />
                  <select
                    value={editFormData.unit_size_type || ''}
                    onChange={(e) => setEditFormData({ ...editFormData, unit_size_type: e.target.value || null })}
                    style={{ ...inputStyle, width: '70px' }}
                  >
                    <option value="">—</option>
                    <option value="each">each</option>
                    <option value="g">g</option>
                    <option value="kg">kg</option>
                    <option value="ml">ml</option>
                    <option value="ltr">ltr</option>
                    <option value="oz">oz</option>
                    <option value="cl">cl</option>
                  </select>
                </div>
              </div>
              <div style={{ flex: '1 1 100px' }}>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>Portions/Unit</label>
                <input
                  type="number"
                  value={editFormData.portions_per_unit ?? ''}
                  onChange={(e) => setEditFormData({ ...editFormData, portions_per_unit: e.target.value ? parseInt(e.target.value) : null })}
                  style={inputStyle}
                  placeholder="—"
                  min="1"
                />
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <label style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>Portion Desc</label>
                <input
                  type="text"
                  value={editFormData.portion_description}
                  onChange={(e) => setEditFormData({ ...editFormData, portion_description: e.target.value })}
                  style={inputStyle}
                  placeholder="e.g., 250ml"
                />
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setEditingDef(null)}
                style={{
                  padding: '8px 16px',
                  background: '#f0f0f0',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={updateMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: '#2563eb',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  opacity: updateMutation.isPending ? 0.7 : 1,
                }}
              >
                {updateMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>

            {updateMutation.isError && (
              <p style={{ color: 'red', marginTop: '12px' }}>
                Error: {(updateMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '12px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '14px',
}

const thStyleClickable: React.CSSProperties = {
  ...thStyle,
  cursor: 'pointer',
  userSelect: 'none',
}

const tdStyle: React.CSSProperties = {
  padding: '12px',
  fontSize: '14px',
}

const inputStyle: React.CSSProperties = {
  padding: '8px',
  borderRadius: '4px',
  border: '1px solid #ddd',
  fontSize: '14px',
  width: '100%',
}
