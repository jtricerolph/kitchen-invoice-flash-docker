import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import * as pdfjsLib from 'pdfjs-dist'

// Use unpkg CDN for the worker (matches installed version 5.4.530)
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@5.4.530/build/pdf.worker.min.mjs'

interface Invoice {
  id: number
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  net_total: number | null
  stock_total: number | null
  supplier_id: number | null
  supplier_name: string | null
  supplier_match_type: string | null  // "exact", "fuzzy", or null
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
  product_code: string | null
  description: string | null
  unit: string | null
  quantity: number | null
  order_quantity: number | null
  unit_price: number | null
  tax_rate: string | null
  tax_amount: number | null
  amount: number | null
  line_number: number
  is_non_stock: boolean
  // Pack size fields
  raw_content: string | null
  pack_quantity: number | null
  unit_size: number | null
  unit_size_type: string | null
  portions_per_unit: number
  cost_per_item: number | null
  cost_per_portion: number | null
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
  const [highlightedField, setHighlightedField] = useState<string | null>(null)
  const [expandedLineItem, setExpandedLineItem] = useState<number | null>(null)
  const [pdfPages, setPdfPages] = useState<{ width: number; height: number; displayWidth: number; displayHeight: number; canvas: HTMLCanvasElement }[]>([])
  const [pdfScale, setPdfScale] = useState<number>(1)
  const [zoomLevel, setZoomLevel] = useState<number>(1)
  const [zoomTranslate, setZoomTranslate] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [zoomPageNum, setZoomPageNum] = useState<number>(0) // Which page the zoom applies to
  const pdfContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

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

  // Direct URL with token - simpler approach
  const imageUrl = invoice
    ? `/api/invoices/${id}/file?token=${encodeURIComponent(token || '')}#toolbar=0&navpanes=0&view=FitH`
    : null

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
  })

  // Helper to get bounding box for a field from raw OCR data
  const getFieldBoundingBox = (fieldName: string): { x: number; y: number; width: number; height: number; pageNumber: number } | null => {
    if (!rawOcrData?.raw_json?.documents?.[0]?.fields?.[fieldName]?.bounding_regions?.[0]) {
      return null
    }
    const region = rawOcrData.raw_json.documents[0].fields[fieldName].bounding_regions[0]
    const polygon = region.polygon
    const pageNumber = region.page_number || 1 // Azure uses 1-based page numbers
    if (!polygon || polygon.length < 4) return null

    // Get page dimensions for the correct page (Azure uses inches by default)
    const pageInfo = rawOcrData.raw_json.pages?.[pageNumber - 1] // Convert to 0-based
    const pageWidth = pageInfo?.width || 8.5
    const pageHeight = pageInfo?.height || 11

    // Convert polygon to bounding box (polygon is array of [x, y] pairs)
    const xs = polygon.map((p: number[]) => p[0])
    const ys = polygon.map((p: number[]) => p[1])
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // Return as percentages of page dimensions for easy scaling
    return {
      x: (minX / pageWidth) * 100,
      y: (minY / pageHeight) * 100,
      width: ((maxX - minX) / pageWidth) * 100,
      height: ((maxY - minY) / pageHeight) * 100,
      pageNumber,
    }
  }

  // Helper to get bounding box for a line item by index
  const getLineItemBoundingBox = (lineIndex: number): { x: number; y: number; width: number; height: number; pageNumber: number } | null => {
    if (!rawOcrData?.raw_json?.documents?.[0]?.fields?.Items?.value?.[lineIndex]?.bounding_regions?.[0]) {
      return null
    }
    const region = rawOcrData.raw_json.documents[0].fields.Items.value[lineIndex].bounding_regions[0]
    const polygon = region.polygon
    const pageNumber = region.page_number || 1
    if (!polygon || polygon.length < 4) return null

    const pageInfo = rawOcrData.raw_json.pages?.[pageNumber - 1]
    const pageWidth = pageInfo?.width || 8.5
    const pageHeight = pageInfo?.height || 11

    const xs = polygon.map((p: number[]) => p[0])
    const ys = polygon.map((p: number[]) => p[1])
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    return {
      x: (minX / pageWidth) * 100,
      y: (minY / pageHeight) * 100,
      width: ((maxX - minX) / pageWidth) * 100,
      height: ((maxY - minY) / pageHeight) * 100,
      pageNumber,
    }
  }

  // Calculate zoom level to make bounding box fill ~80% of container
  const calculateZoomForBbox = (bbox: { x: number; y: number; width: number; height: number; pageNumber: number } | null): number => {
    if (!bbox || !pdfContainerRef.current || pdfPages.length === 0) return 2

    const pageData = pdfPages[bbox.pageNumber - 1]
    if (!pageData) return 2

    // Get container dimensions
    const containerWidth = pdfContainerRef.current.clientWidth - 32 // padding
    const containerHeight = pdfContainerRef.current.clientHeight - 32

    // Calculate bbox size in display pixels
    const bboxDisplayWidth = (bbox.width / 100) * pageData.displayWidth
    const bboxDisplayHeight = (bbox.height / 100) * pageData.displayHeight

    // Calculate zoom to make bbox fill 80% of container (use the more constraining dimension)
    const targetFill = 0.8
    const zoomForWidth = (containerWidth * targetFill) / bboxDisplayWidth
    const zoomForHeight = (containerHeight * targetFill) / bboxDisplayHeight

    // Use the smaller zoom so it fits both dimensions, with min/max limits
    const zoom = Math.min(zoomForWidth, zoomForHeight)
    return Math.max(2, Math.min(zoom, 8)) // Clamp between 2x and 8x
  }

  // Scroll to page containing the bounding box and set zoom with centering
  const scrollToHighlight = (bbox: { x: number; y: number; width: number; height: number; pageNumber: number } | null, zoom: number) => {
    if (!bbox || !pdfContainerRef.current || pdfPages.length === 0) return

    const pageData = pdfPages[bbox.pageNumber - 1]
    if (!pageData) return

    // Calculate bbox center position in display pixels (relative to page top-left)
    const bboxCenterX = ((bbox.x + bbox.width / 2) / 100) * pageData.displayWidth
    const bboxCenterY = ((bbox.y + bbox.height / 2) / 100) * pageData.displayHeight

    // Container visible area center
    const containerCenterX = pageData.displayWidth / 2
    const containerCenterY = pageData.displayHeight / 2

    // Calculate translate needed to move bbox center to container center after scaling
    // When we scale by zoom from top-left, a point at (x, y) moves to (x*zoom, y*zoom)
    // We want the bbox center (after scaling) to appear at container center
    // So translate = containerCenter - bboxCenter * zoom
    const translateX = containerCenterX - bboxCenterX * zoom
    const translateY = containerCenterY - bboxCenterY * zoom

    // Set zoom and translate
    setZoomLevel(zoom)
    setZoomTranslate({ x: translateX, y: translateY })
    setZoomPageNum(bbox.pageNumber)

    // Scroll to the correct page
    setTimeout(() => {
      if (!pdfContainerRef.current) return

      // Calculate the Y offset to the target page
      let yOffset = 0
      for (let i = 0; i < bbox.pageNumber - 1 && i < pdfPages.length; i++) {
        yOffset += (pdfPages[i].displayHeight || pdfPages[i].height) + 24
      }

      // Scroll to show the page
      pdfContainerRef.current.scrollTo({
        top: yOffset,
        behavior: 'smooth'
      })
    }, 50)
  }

  // Reset zoom
  const resetZoom = () => {
    setZoomLevel(1)
    setZoomTranslate({ x: 0, y: 0 })
    setZoomPageNum(0)
    if (pdfContainerRef.current) {
      pdfContainerRef.current.scrollTo({ left: 0, behavior: 'smooth' })
    }
  }

  // Handler to toggle highlight and scroll to it
  const handleHighlightField = (fieldName: string) => {
    if (highlightedField === fieldName) {
      setHighlightedField(null)
      resetZoom()
    } else {
      setHighlightedField(fieldName)
      setExpandedLineItem(null) // Clear any line item highlight
      const bbox = getFieldBoundingBox(fieldName)
      const dynamicZoom = calculateZoomForBbox(bbox)
      scrollToHighlight(bbox, dynamicZoom)
    }
  }

  // Handler to toggle line item inline preview (no zoom/scroll for line items)
  const handleHighlightLineItem = (itemId: number, lineIndex: number) => {
    if (expandedLineItem === itemId) {
      setExpandedLineItem(null)
    } else {
      setExpandedLineItem(itemId)
      setHighlightedField(null) // Clear any field highlight
      resetZoom() // Reset zoom when showing inline preview
    }
  }

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

  // Render all PDF pages to canvases for highlighting support
  useEffect(() => {
    const renderPdf = async () => {
      if (!invoice || !token) return
      const isPdf = invoice.image_path?.toLowerCase().endsWith('.pdf')
      if (!isPdf || !containerRef.current) return

      try {
        // Fetch the PDF
        const pdfUrl = `/api/invoices/${id}/file?token=${encodeURIComponent(token)}`
        const response = await fetch(pdfUrl)
        const arrayBuffer = await response.arrayBuffer()

        // Load the PDF document
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        const numPages = pdf.numPages

        // Get container width for display scaling
        const containerWidth = containerRef.current.clientWidth - 48 // padding

        // Render at high fixed resolution for quality (matches upload max of 2000px)
        const targetRenderWidth = 1500 // High quality render width

        // Render all pages
        const pages: { width: number; height: number; displayWidth: number; displayHeight: number; canvas: HTMLCanvasElement }[] = []

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          const page = await pdf.getPage(pageNum)
          const viewport = page.getViewport({ scale: 1 })

          // Calculate display size for container fit
          const displayScale = containerWidth / viewport.width
          const displayWidth = viewport.width * displayScale
          const displayHeight = viewport.height * displayScale

          // Render at high resolution (independent of display size)
          const renderScale = targetRenderWidth / viewport.width
          const renderViewport = page.getViewport({ scale: renderScale })

          // Create canvas for this page at high resolution
          const canvas = document.createElement('canvas')
          canvas.width = renderViewport.width
          canvas.height = renderViewport.height

          const context = canvas.getContext('2d')
          if (context) {
            await page.render({
              canvasContext: context,
              viewport: renderViewport,
            }).promise
          }

          pages.push({
            width: renderViewport.width,  // High-res canvas dimensions
            height: renderViewport.height,
            displayWidth,  // Display dimensions (half of canvas for 2x)
            displayHeight,
            canvas,
          })
        }

        setPdfPages(pages)
        setPdfScale(containerWidth / (pdf.numPages > 0 ? (await pdf.getPage(1)).getViewport({ scale: 1 }).width : 1))
      } catch (err) {
        console.error('Error rendering PDF:', err)
      }
    }

    renderPdf()
  }, [invoice, token, id])

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

  const addAliasMutation = useMutation({
    mutationFn: async ({ supplierId, alias, invoiceId }: { supplierId: number; alias: string; invoiceId?: number }) => {
      const res = await fetch(`/api/suppliers/${supplierId}/aliases`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ alias, invoice_id: invoiceId }),
      })
      if (!res.ok) throw new Error('Failed to add alias')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
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
      product_code: item.product_code,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      amount: item.amount,
      is_non_stock: item.is_non_stock,
      pack_quantity: item.pack_quantity,
      unit_size: item.unit_size,
      unit_size_type: item.unit_size_type,
      portions_per_unit: item.portions_per_unit,
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
    <div style={styles.pageContainer}>
      {/* Top row: Image and Form side by side */}
      <div style={styles.topRow}>
        <div style={styles.imageSection} ref={containerRef}>
          <h3>Invoice {isPDF ? 'Document' : 'Image'}</h3>
          {imageUrl ? (
            isPDF ? (
              <div style={styles.pdfScrollContainer} ref={pdfContainerRef}>
                {pdfPages.length > 0 ? (
                  pdfPages.map((page, pageIndex) => {
                    const pageNum = pageIndex + 1
                    const fieldBbox = highlightedField ? getFieldBoundingBox(highlightedField) : null
                    const lineItemBbox = expandedLineItem !== null && lineItems
                      ? (() => {
                          const idx = lineItems.findIndex(item => item.id === expandedLineItem)
                          return idx >= 0 ? getLineItemBoundingBox(idx) : null
                        })()
                      : null

                    return (
                      <div key={pageIndex} style={styles.pdfPageWrapper}>
                        <div style={{
                          ...styles.pdfPageContainer,
                          width: page.displayWidth,
                          height: page.displayHeight,
                          overflow: 'hidden',
                        }}>
                          {/* Wrapper for image + highlights that transforms together */}
                          <div style={{
                            position: 'relative',
                            width: page.displayWidth,
                            height: page.displayHeight,
                            transformOrigin: '0 0',
                            transform: zoomLevel > 1 && zoomPageNum === pageNum
                              ? `translate(${zoomTranslate.x}px, ${zoomTranslate.y}px) scale(${zoomLevel})`
                              : 'scale(1)',
                            transition: 'transform 0.3s ease',
                          }}>
                            <img
                              src={page.canvas.toDataURL()}
                              alt={`Page ${pageNum}`}
                              style={{
                                width: '100%',
                                height: '100%',
                                display: 'block',
                              }}
                            />
                            {/* Highlight for header fields on this page */}
                            {fieldBbox && fieldBbox.pageNumber === pageNum && (() => {
                              // Add padding (0.5% ≈ 5px at typical sizes) and scale border inversely to zoom
                              const padding = 0.5
                              const borderWidth = Math.max(1, 2 / zoomLevel)
                              return (
                                <div
                                  ref={highlightRef}
                                  style={{
                                    ...styles.highlightOverlay,
                                    left: `${fieldBbox.x - padding}%`,
                                    top: `${fieldBbox.y - padding}%`,
                                    width: `${fieldBbox.width + padding * 2}%`,
                                    height: `${fieldBbox.height + padding * 2}%`,
                                    border: `${borderWidth}px solid #ffc107`,
                                  }}
                                  onClick={() => { setHighlightedField(null); resetZoom(); }}
                                />
                              )
                            })()}
                            {/* Highlight for line items on this page */}
                            {lineItemBbox && lineItemBbox.pageNumber === pageNum && (() => {
                              const padding = 0.5
                              const borderWidth = Math.max(1, 2 / zoomLevel)
                              return (
                                <div
                                  style={{
                                    ...styles.highlightOverlay,
                                    left: `${lineItemBbox.x - padding}%`,
                                    top: `${lineItemBbox.y - padding}%`,
                                    width: `${lineItemBbox.width + padding * 2}%`,
                                    height: `${lineItemBbox.height + padding * 2}%`,
                                    border: `${borderWidth}px solid #ffc107`,
                                  }}
                                  onClick={() => { setExpandedLineItem(null); resetZoom(); }}
                                />
                              )
                            })()}
                          </div>
                        </div>
                        {pdfPages.length > 1 && (
                          <div style={styles.pageLabel}>Page {pageNum} of {pdfPages.length}</div>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div style={styles.imagePlaceholder}>Rendering PDF...</div>
                )}
              </div>
            ) : (
              <div style={styles.imageContainer}>
                <img src={imageUrl} alt="Invoice" style={styles.image} />
                {highlightedField && getFieldBoundingBox(highlightedField) && (() => {
                  const bbox = getFieldBoundingBox(highlightedField)!
                  const padding = 0.5
                  return (
                    <div
                      style={{
                        ...styles.highlightOverlay,
                        left: `${bbox.x - padding}%`,
                        top: `${bbox.y - padding}%`,
                        width: `${bbox.width + padding * 2}%`,
                        height: `${bbox.height + padding * 2}%`,
                        border: '2px solid #ffc107',
                      }}
                      onClick={() => setHighlightedField(null)}
                    />
                  )
                })()}
              </div>
            )
          ) : (
            <div style={styles.imagePlaceholder}>Loading {isPDF ? 'document' : 'image'}...</div>
          )}
          {isPDF && zoomLevel > 1 && (
            <button
              onClick={resetZoom}
              style={styles.zoomResetBtn}
            >
              Reset Zoom ({zoomLevel}x)
            </button>
          )}
          {isPDF && imageUrl && (
            <a
              href={`/api/invoices/${id}/file?token=${encodeURIComponent(token || '')}`}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.openPdfLink}
            >
              Open PDF in new tab
            </a>
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

          <h3>Invoice Details</h3>

          <div style={styles.form}>
            <div style={styles.row}>
              <label style={{ ...styles.label, flex: 1 }}>
                Invoice Number
                <div style={styles.inputWithEye}>
                  <input
                    type="text"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    style={styles.input}
                    placeholder="e.g., INV-12345"
                  />
                  {getFieldBoundingBox('InvoiceId') && (
                    <button
                      type="button"
                      onClick={() => handleHighlightField('InvoiceId')}
                      style={{
                        ...styles.eyeBtn,
                        ...(highlightedField === 'InvoiceId' ? styles.eyeBtnActive : {})
                      }}
                      title="Show on document"
                    >
                      👁
                    </button>
                  )}
                </div>
              </label>

              <label style={{ ...styles.label, flex: 1 }}>
                Invoice Date
                <div style={styles.inputWithEye}>
                  <input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    style={styles.input}
                  />
                  {getFieldBoundingBox('InvoiceDate') && (
                    <button
                      type="button"
                      onClick={() => handleHighlightField('InvoiceDate')}
                      style={{
                        ...styles.eyeBtn,
                        ...(highlightedField === 'InvoiceDate' ? styles.eyeBtnActive : {})
                      }}
                      title="Show on document"
                    >
                      👁
                    </button>
                  )}
                </div>
              </label>
            </div>

            <div style={styles.row}>
              <label style={{ ...styles.label, flex: 1 }}>
                Gross Total (£)
                <div style={styles.inputWithEye}>
                  <input
                    type="number"
                    step="0.01"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    style={styles.input}
                    placeholder="Inc. VAT"
                  />
                  {getFieldBoundingBox('InvoiceTotal') && (
                    <button
                      type="button"
                      onClick={() => handleHighlightField('InvoiceTotal')}
                      style={{
                        ...styles.eyeBtn,
                        ...(highlightedField === 'InvoiceTotal' ? styles.eyeBtnActive : {})
                      }}
                      title="Show on document"
                    >
                      👁
                    </button>
                  )}
                </div>
              </label>

              <label style={{ ...styles.label, flex: 1 }}>
                Net Total (£)
                <div style={styles.inputWithEye}>
                  <input
                    type="number"
                    step="0.01"
                    value={netTotal}
                    onChange={(e) => setNetTotal(e.target.value)}
                    style={styles.input}
                    placeholder="Exc. VAT"
                  />
                  {getFieldBoundingBox('SubTotal') && (
                    <button
                      type="button"
                      onClick={() => handleHighlightField('SubTotal')}
                      style={{
                        ...styles.eyeBtn,
                        ...(highlightedField === 'SubTotal' ? styles.eyeBtnActive : {})
                      }}
                      title="Show on document"
                    >
                      👁
                    </button>
                  )}
                </div>
              </label>
            </div>

            <div style={styles.label}>
              <span>Supplier</span>
              <div style={styles.supplierRow}>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  style={{
                    ...styles.input,
                    flex: 1,
                    ...(invoice?.supplier_match_type === 'fuzzy' && supplierId ? {
                      borderColor: '#f0ad4e',
                      borderWidth: '2px',
                      background: '#fff8e6'
                    } : {})
                  }}
                >
                  <option value="">-- Select Supplier --</option>
                  {suppliers?.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {getFieldBoundingBox('VendorName') && (
                  <button
                    type="button"
                    onClick={() => handleHighlightField('VendorName')}
                    style={{
                      ...styles.eyeBtn,
                      ...(highlightedField === 'VendorName' ? styles.eyeBtnActive : {})
                    }}
                    title="Show on document"
                  >
                    👁
                  </button>
                )}
                <button
                  type="button"
                  onClick={openCreateSupplierModal}
                  style={styles.createSupplierBtn}
                  title="Create new supplier"
                >
                  + New
                </button>
              </div>
              {invoice?.supplier_match_type === 'fuzzy' && supplierId && invoice.vendor_name && (
                <div style={styles.fuzzyMatchWarning}>
                  <span>Fuzzy match from "{invoice.vendor_name}" - please verify</span>
                  <button
                    type="button"
                    onClick={() => addAliasMutation.mutate({
                      supplierId: parseInt(supplierId),
                      alias: invoice.vendor_name!,
                      invoiceId: invoice.id
                    })}
                    style={styles.addAliasBtn}
                    disabled={addAliasMutation.isPending}
                    title="Add this name as an alias so future invoices match exactly"
                  >
                    {addAliasMutation.isPending ? 'Adding...' : '+ Add as alias'}
                  </button>
                </div>
              )}
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

            <div style={styles.row}>
              <label style={{ ...styles.label, flex: 1 }}>
                Order/PO Number
                <div style={styles.inputWithEye}>
                  <input
                    type="text"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                    style={styles.input}
                    placeholder="e.g., PO-12345"
                  />
                  {getFieldBoundingBox('PurchaseOrder') && (
                    <button
                      type="button"
                      onClick={() => handleHighlightField('PurchaseOrder')}
                      style={{
                        ...styles.eyeBtn,
                        ...(highlightedField === 'PurchaseOrder' ? styles.eyeBtnActive : {})
                      }}
                      title="Show on document"
                    >
                      👁
                    </button>
                  )}
                </div>
              </label>

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
            </div>

            <label style={styles.label}>
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

          <div style={styles.secondaryActions}>
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
          </div>

          <button onClick={() => navigate('/invoices')} style={styles.backBtn}>
            ← Back to Invoices
          </button>
        </div>
      </div>

      {/* Full-width Line Items Section */}
      <div style={styles.lineItemsSection}>
        <h3>Line Items</h3>
        {lineItems && lineItems.length > 0 ? (
          <table style={styles.lineItemsTable}>
            <thead>
              <tr>
                <th style={{ ...styles.th, width: '30px' }}></th>
                <th style={{ ...styles.th, width: '80px' }}>Code</th>
                <th style={styles.th}>Description</th>
                <th style={{ ...styles.th, width: '50px' }}>Unit</th>
                <th style={{ ...styles.th, width: '50px' }}>Qty</th>
                <th style={{ ...styles.th, width: '70px' }}>Unit Price</th>
                <th style={{ ...styles.th, width: '50px' }}>VAT %</th>
                <th style={{ ...styles.th, width: '70px' }}>Net Total</th>
                <th style={{ ...styles.th, width: '55px' }}>Pack Qty</th>
                <th style={{ ...styles.th, width: '70px' }}>Unit Size</th>
                <th style={{ ...styles.th, width: '55px' }}>Portions</th>
                <th style={{ ...styles.th, width: '70px' }}>Cost/Item</th>
                <th style={{ ...styles.th, width: '70px' }}>Cost/Portion</th>
                <th style={{ ...styles.th, textAlign: 'center', width: '60px' }}>Non-Stock</th>
                <th style={{ ...styles.th, width: '70px' }}></th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, idx) => {
                const bbox = getLineItemBoundingBox(idx)
                return (
                  <React.Fragment key={item.id}>
                    <tr>
                      <td style={styles.td}>
                        {bbox && (
                          <button
                            type="button"
                            onClick={() => handleHighlightLineItem(item.id, idx)}
                            style={{
                              ...styles.eyeBtn,
                              padding: '0.25rem 0.4rem',
                              fontSize: '0.8rem',
                              ...(expandedLineItem === item.id ? styles.eyeBtnActive : {})
                            }}
                            title="Show on document"
                          >
                            👁
                          </button>
                        )}
                      </td>
                      {editingLineItem === item.id ? (
                        <>
                          <td style={styles.td}>
                            <input
                              type="text"
                              value={lineItemEdits.product_code || ''}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, product_code: e.target.value })}
                              style={{ ...styles.tableInput, width: '70px' }}
                            />
                          </td>
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
                              type="text"
                              value={lineItemEdits.unit || ''}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, unit: e.target.value })}
                              style={{ ...styles.tableInput, width: '50px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              value={lineItemEdits.quantity || ''}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, quantity: parseFloat(e.target.value) })}
                              style={{ ...styles.tableInput, width: '50px' }}
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
                              type="text"
                              value={lineItemEdits.tax_rate || ''}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, tax_rate: e.target.value })}
                              style={{ ...styles.tableInput, width: '50px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              value={lineItemEdits.amount || ''}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, amount: parseFloat(e.target.value) })}
                              style={{ ...styles.tableInput, width: '60px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              value={lineItemEdits.pack_quantity || ''}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, pack_quantity: parseInt(e.target.value) || null })}
                              style={{ ...styles.tableInput, width: '45px' }}
                              placeholder="—"
                            />
                          </td>
                          <td style={styles.td}>
                            <div style={{ display: 'flex', gap: '2px' }}>
                              <input
                                type="number"
                                step="0.1"
                                value={lineItemEdits.unit_size || ''}
                                onChange={(e) => setLineItemEdits({ ...lineItemEdits, unit_size: parseFloat(e.target.value) || null })}
                                style={{ ...styles.tableInput, width: '35px' }}
                                placeholder="—"
                              />
                              <select
                                value={lineItemEdits.unit_size_type || ''}
                                onChange={(e) => setLineItemEdits({ ...lineItemEdits, unit_size_type: e.target.value || null })}
                                style={{ ...styles.tableInput, width: '40px', padding: '0.2rem' }}
                              >
                                <option value="">—</option>
                                <option value="g">g</option>
                                <option value="kg">kg</option>
                                <option value="ml">ml</option>
                                <option value="ltr">ltr</option>
                                <option value="oz">oz</option>
                                <option value="cl">cl</option>
                              </select>
                            </div>
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              value={lineItemEdits.portions_per_unit || 1}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, portions_per_unit: parseInt(e.target.value) || 1 })}
                              style={{ ...styles.tableInput, width: '45px' }}
                              min="1"
                            />
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem', color: '#666' }}>
                            {lineItemEdits.pack_quantity && lineItemEdits.unit_price
                              ? `£${(lineItemEdits.unit_price / lineItemEdits.pack_quantity).toFixed(3)}`
                              : '—'}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem', color: '#666' }}>
                            {lineItemEdits.pack_quantity && lineItemEdits.unit_price
                              ? `£${(lineItemEdits.unit_price / (lineItemEdits.pack_quantity * (lineItemEdits.portions_per_unit || 1))).toFixed(3)}`
                              : '—'}
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
                          <td style={{ ...styles.td, fontSize: '0.85rem', color: '#666' }}>
                            {item.product_code || '—'}
                          </td>
                          <td style={{ ...styles.td, ...(item.is_non_stock ? { color: '#856404', fontStyle: 'italic' } : {}) }}>
                            {item.description || '—'}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>{item.unit || '—'}</td>
                          <td style={styles.td}>{item.quantity?.toFixed(2) || '—'}</td>
                          <td style={styles.td}>{item.unit_price ? `£${item.unit_price.toFixed(2)}` : '—'}</td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>{item.tax_rate || '—'}</td>
                          <td style={styles.td}>{item.amount ? `£${item.amount.toFixed(2)}` : '—'}</td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>
                            {item.pack_quantity || '—'}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>
                            {item.unit_size ? `${item.unit_size}${item.unit_size_type || ''}` : '—'}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>
                            {item.portions_per_unit || 1}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem', color: item.cost_per_item ? '#28a745' : '#999' }}>
                            {item.cost_per_item ? `£${item.cost_per_item.toFixed(3)}` : '—'}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem', color: item.cost_per_portion ? '#28a745' : '#999' }}>
                            {item.cost_per_portion ? `£${item.cost_per_portion.toFixed(3)}` : '—'}
                          </td>
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
                    {expandedLineItem === item.id && bbox && (
                      <tr>
                        <td colSpan={15} style={styles.lineItemPreviewCell}>
                          {isPDF && pdfPages.length > 0 ? (
                            (() => {
                              // Get the correct page canvas (high-res)
                              const pageIndex = bbox.pageNumber - 1
                              const pageData = pdfPages[pageIndex]
                              if (!pageData) return null

                              // Calculate crop coordinates in high-res canvas pixels
                              const cropX = (bbox.x / 100) * pageData.width
                              const cropY = (bbox.y / 100) * pageData.height
                              const cropW = (bbox.width / 100) * pageData.width
                              const cropH = (bbox.height / 100) * pageData.height

                              // Crop around bounding box with padding
                              const horzPadding = 40 // Horizontal padding in pixels
                              const vertPadding = 20 // Vertical padding in pixels
                              const startX = Math.max(0, cropX - horzPadding)
                              const startY = Math.max(0, cropY - vertPadding)
                              const endX = Math.min(pageData.width, cropX + cropW + horzPadding)
                              const endY = Math.min(pageData.height, cropY + cropH + vertPadding)
                              const finalW = endX - startX
                              const finalH = endY - startY

                              // Create a cropped canvas around the bounding box
                              const croppedCanvas = document.createElement('canvas')
                              croppedCanvas.width = finalW
                              croppedCanvas.height = finalH
                              const ctx = croppedCanvas.getContext('2d')
                              if (ctx) {
                                ctx.drawImage(
                                  pageData.canvas,
                                  startX, startY, finalW, finalH,
                                  0, 0, finalW, finalH
                                )
                              }

                              return (
                                <div style={styles.lineItemPreviewContainer}>
                                  <div style={{
                                    background: '#fff',
                                    borderRadius: '4px',
                                    padding: '8px',
                                    border: '1px solid #ddd',
                                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                    display: 'flex',
                                    justifyContent: 'center',
                                  }}>
                                    <img
                                      src={croppedCanvas.toDataURL()}
                                      alt="Line item from invoice"
                                      style={{
                                        maxWidth: '100%',
                                        height: 'auto',
                                        display: 'block',
                                        borderRadius: '2px',
                                      }}
                                    />
                                  </div>
                                </div>
                              )
                            })()
                          ) : imageUrl ? (
                            <div style={styles.lineItemPreviewContainer}>
                              <div style={{
                                position: 'relative',
                                width: '100%',
                                height: '60px',
                                overflow: 'hidden',
                              }}>
                                <img
                                  src={`${imageUrl.split('?')[0]}?token=${encodeURIComponent(token || '')}`}
                                  alt="Line item location"
                                  style={{
                                    position: 'absolute',
                                    width: `${100 / (bbox.width / 100)}%`,
                                    left: `${-bbox.x * (100 / bbox.width)}%`,
                                    top: `${-bbox.y * (100 / bbox.height) * (60 / 100)}%`,
                                    maxWidth: 'none',
                                  }}
                                />
                              </div>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
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
  pageContainer: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  topRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' },
  imageSection: { background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  imageContainer: { position: 'relative', marginTop: '1rem' },
  image: { width: '100%', borderRadius: '8px', display: 'block' },
  pdfScrollContainer: { marginTop: '1rem', maxHeight: '70vh', overflowY: 'auto', overflowX: 'hidden', background: '#e5e5e5', borderRadius: '8px', padding: '16px' },
  pdfPageWrapper: { marginBottom: '16px' },
  pdfPageContainer: { position: 'relative', margin: '0 auto', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' },
  pdfPageImage: { width: '100%', height: '100%', display: 'block' },
  pageLabel: { textAlign: 'center', fontSize: '0.8rem', color: '#666', marginTop: '4px' },
  pdfCanvas: { width: '100%', borderRadius: '8px', display: 'block' },
  highlightOverlay: { position: 'absolute', background: 'rgba(255, 200, 0, 0.3)', borderRadius: '2px', cursor: 'pointer', boxShadow: '0 0 8px rgba(255, 200, 0, 0.6)', animation: 'pulse 1.5s infinite' },
  imagePlaceholder: { width: '100%', height: '300px', background: '#f5f5f5', borderRadius: '8px', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' },
  pdfViewer: { width: '100%', height: '500px', borderRadius: '8px', border: 'none' },
  openPdfLink: { display: 'block', marginTop: '0.5rem', textAlign: 'center', color: '#0066cc', fontSize: '0.85rem' },
  zoomResetBtn: { display: 'block', margin: '0.5rem auto', padding: '0.4rem 1rem', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '500' },
  confidenceBadge: { marginTop: '1rem', padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '20px', textAlign: 'center', fontSize: '0.9rem', color: '#666' },
  formSection: { background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  duplicateWarning: { padding: '1rem', borderRadius: '8px', marginBottom: '1rem', cursor: 'pointer', border: '1px solid', fontWeight: '500' },
  form: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  row: { display: 'flex', gap: '1rem' },
  label: { display: 'flex', flexDirection: 'column', gap: '0.25rem', color: '#333', fontWeight: '500', fontSize: '0.9rem' },
  input: { padding: '0.5rem', borderRadius: '6px', border: '1px solid #ddd', fontSize: '0.95rem', flex: 1 },
  inputWithEye: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  eyeBtn: { padding: '0.4rem 0.5rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, flexShrink: 0 },
  eyeBtnActive: { background: '#fff3cd', borderColor: '#ffc107' },
  extractedHint: { fontSize: '0.8rem', color: '#666', fontWeight: 'normal', fontStyle: 'italic' },
  extractedHintRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' },
  fuzzyMatchWarning: { fontSize: '0.8rem', color: '#856404', background: '#fff3cd', padding: '0.35rem 0.5rem', borderRadius: '4px', marginTop: '0.25rem', border: '1px solid #ffc107', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' },
  addAliasBtn: { padding: '0.2rem 0.5rem', background: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: '500', whiteSpace: 'nowrap' },
  supplierRow: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  createSupplierBtn: { padding: '0.5rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', whiteSpace: 'nowrap' },
  createFromExtractedBtn: { padding: '0.25rem 0.5rem', background: '#e94560', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'normal' },
  modalLabel: { display: 'flex', flexDirection: 'column', gap: '0.5rem', color: '#333', fontWeight: '500', marginTop: '1rem' },
  lineItemsSection: { background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  lineItemsTable: { width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem', fontSize: '0.95rem' },
  th: { textAlign: 'left', padding: '0.75rem 0.5rem', borderBottom: '2px solid #ddd', fontWeight: '600', background: '#f8f9fa' },
  td: { padding: '0.75rem 0.5rem', borderBottom: '1px solid #eee' },
  tableInput: { padding: '0.35rem', borderRadius: '4px', border: '1px solid #ddd', fontSize: '0.9rem', width: '100%' },
  smallBtn: { padding: '0.35rem 0.75rem', background: '#5cb85c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginRight: '0.25rem', fontSize: '0.8rem' },
  smallBtnCancel: { padding: '0.35rem 0.75rem', background: '#999', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' },
  editBtn: { padding: '0.35rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' },
  noItems: { color: '#999', fontStyle: 'italic', marginTop: '0.5rem' },
  status: { marginTop: '1rem', padding: '0.75rem', background: '#f5f5f5', borderRadius: '6px', color: '#666', fontSize: '0.9rem' },
  docTypeBadge: { marginLeft: '1rem', padding: '0.25rem 0.5rem', background: '#17a2b8', color: 'white', borderRadius: '4px', fontSize: '0.75rem' },
  actions: { display: 'flex', gap: '0.75rem', marginTop: '1rem' },
  saveBtn: { flex: 1, padding: '0.75rem', background: '#1a1a2e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' },
  confirmBtn: { flex: 1, padding: '0.75rem', background: '#5cb85c', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' },
  secondaryActions: { display: 'flex', gap: '0.75rem', marginTop: '0.75rem' },
  deleteBtn: { flex: 1, padding: '0.5rem', background: '#dc3545', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem' },
  rawOcrBtn: { flex: 1, padding: '0.5rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem' },
  backBtn: { marginTop: '0.5rem', padding: '0.5rem', background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', width: '100%', fontSize: '0.9rem' },
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
  lineItemPreviewCell: { padding: '0.5rem', background: '#f8f9fa', borderBottom: '1px solid #eee' },
  lineItemPreviewContainer: { maxWidth: '100%', overflow: 'hidden', borderRadius: '4px', border: '2px solid #ffc107', background: '#fff' },
  lineItemPreviewCrop: { width: '100%', backgroundRepeat: 'no-repeat' },
}
