import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import * as pdfjsLib from 'pdfjs-dist'
import { getPriceStatusConfig, formatPercent } from '../utils/searchHelpers'
import LineItemHistoryModal from './LineItemHistoryModal'

// Use local worker file from public directory
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

// Simple Scale icon SVG component
const ScaleIcon = ({ style }: { style?: React.CSSProperties }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{ width: '18px', height: '18px', ...style }}
  >
    <path d="M12 3c-1.27 0-2.4.8-2.82 2H3v2h1.95L2 14c-.47 2 1 4 4 4s4.5-2 4-4L7.05 7H9.18c.35.99 1.17 1.74 2.18 1.94V19H7v2h10v-2h-4.18V8.94c1.01-.2 1.83-.95 2.18-1.94h2.13L14 14c-.47 2 1 4 4 4s4.5-2 4-4l-2.95-7H21V5h-6.18C14.4 3.8 13.27 3 12 3zm0 2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM6 10.45L7.5 14h-3L6 10.45zm12 0L19.5 14h-3L18 10.45z" />
  </svg>
)

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
  ocr_raw_text: string | null  // OCR text or error message
  image_path: string
  document_type: string | null
  order_number: string | null
  duplicate_status: string | null
  duplicate_of_id: number | null
  // Dext integration
  notes: string | null
  dext_sent_at: string | null
  dext_sent_by_username: string | null
}

interface Supplier {
  id: number
  name: string
  aliases?: string[]
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
  portions_per_unit: number | null  // null = not defined yet
  cost_per_item: number | null
  cost_per_portion: number | null
  // OCR warnings for values that needed correction
  ocr_warnings: string | null
  // Price change tracking
  price_status: string | null  // "consistent", "amber", "red", "no_history", "acknowledged"
  price_change_percent: number | null
  previous_price: number | null
}

// Scale icon color based on data completeness
const getScaleIconColor = (item: LineItem): string => {
  if (!item.pack_quantity) return '#dc3545'  // Red - no pack data
  if (item.portions_per_unit === null) return '#ffc107'  // Amber - portions not defined
  if (item.cost_per_portion !== null) return '#28a745'  // Green - fully complete
  return '#ffc107'  // Amber - fallback
}

interface DuplicateCompare {
  current_invoice: Invoice
  firm_duplicate: Invoice | null
  possible_duplicates: Invoice[]
  related_documents: Invoice[]
}

interface ProductDefinition {
  id: number
  kitchen_id: number
  supplier_id: number | null
  product_code: string | null
  description_pattern: string | null
  pack_quantity: number | null
  unit_size: number | null
  unit_size_type: string | null
  portions_per_unit: number | null
  portion_description: string | null
  saved_by_user_id: number | null
  saved_by_username: string | null
  source_invoice_id: number | null
  source_invoice_number: string | null
  updated_at: string | null
}

interface Settings {
  high_quantity_threshold: number
  dext_manual_send_enabled: boolean
}

interface SearchResultItem {
  description: string
  unit_price: number | null
  unit: string | null
  pack_info: string | null
  last_invoice_date: string | null
  invoice_id: number
  similarity: number
}

interface SupplierSearchGroup {
  supplier_id: number | null
  supplier_name: string
  items: SearchResultItem[]
}

interface SearchResponse {
  query: string
  extracted_keywords: string
  results: SupplierSearchGroup[]
  total_matches: number
}

const TOLERANCE = 0.02; // 2p tolerance for rounding

// Date warning levels for unconfirmed invoices
type DateWarning = 'none' | 'amber' | 'red';
function getDateWarning(dateStr: string | null, status: string): DateWarning {
  // Only warn for unconfirmed invoices
  if (status === 'confirmed') return 'none';

  // No date = red
  if (!dateStr) return 'red';

  const invoiceDate = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  invoiceDate.setHours(0, 0, 0, 0);

  const diffMs = Math.abs(today.getTime() - invoiceDate.getTime());
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // More than 7 days AND different month/year = red
  if (diffDays > 7) {
    const sameMonth = invoiceDate.getMonth() === today.getMonth();
    const sameYear = invoiceDate.getFullYear() === today.getFullYear();
    if (!sameMonth || !sameYear) return 'red';
    return 'amber'; // More than 7 days but same month/year = amber
  }

  return 'none';
}

const dateWarningStyles: Record<DateWarning, React.CSSProperties> = {
  none: {},
  amber: { backgroundColor: '#fff3cd', borderColor: '#ffc107' },
  red: { backgroundColor: '#f8d7da', borderColor: '#dc3545' },
};

function LineItemsValidation({ lineItems, invoiceTotal, netTotal }: { lineItems: LineItem[]; invoiceTotal: number; netTotal: number | null }) {
  const lineItemsTotal = lineItems.reduce((sum, item) => sum + (item.amount || 0), 0);
  const stockItemsTotal = lineItems
    .filter(item => !item.is_non_stock)
    .reduce((sum, item) => sum + (item.amount || 0), 0);
  const nonStockItemsTotal = lineItems
    .filter(item => item.is_non_stock)
    .reduce((sum, item) => sum + (item.amount || 0), 0);

  // Line item amounts are net values, so compare against netTotal (if available)
  const compareTotal = netTotal ?? invoiceTotal;
  const difference = Math.abs(compareTotal - lineItemsTotal);
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
          Invoice Net: <strong>£{(netTotal ?? invoiceTotal).toFixed(2)}</strong>
          {netTotal && <span style={{ fontSize: '0.85rem', color: '#666' }}> (Gross: £{invoiceTotal.toFixed(2)})</span>}
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
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [searchingLineItem, setSearchingLineItem] = useState<LineItem | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [editingLineItem, setEditingLineItem] = useState<number | null>(null)
  const [lineItemEdits, setLineItemEdits] = useState<Partial<LineItem>>({})
  const [highlightedField, setHighlightedField] = useState<string | null>(null)
  const [expandedLineItem, setExpandedLineItem] = useState<number | null>(null)
  const [expandedCostBreakdown, setExpandedCostBreakdown] = useState<number | null>(null)
  const [costBreakdownEdits, setCostBreakdownEdits] = useState<Partial<LineItem>>({})
  const [portionDescription, setPortionDescription] = useState<string>('')
  const [saveAsDefault, setSaveAsDefault] = useState(false)
  const [currentDefinition, setCurrentDefinition] = useState<ProductDefinition | null>(null)
  const [definitionLoading, setDefinitionLoading] = useState(false)
  const [pdfPages, setPdfPages] = useState<{ width: number; height: number; displayWidth: number; displayHeight: number; canvas: HTMLCanvasElement }[]>([])
  const [zoomLevel, setZoomLevel] = useState<number>(1)
  const [zoomPageNum, setZoomPageNum] = useState<number>(0) // Which page the zoom applies to
  const [imageZoom, setImageZoom] = useState<number>(1) // Zoom level for non-PDF images
  const pdfContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  // Dext integration state
  const [invoiceNotes, setInvoiceNotes] = useState('')
  const [showDextSendConfirm, setShowDextSendConfirm] = useState(false)
  // Line items sorting and filtering
  const [lineItemSortColumn, setLineItemSortColumn] = useState<string>('')
  const [lineItemSortDirection, setLineItemSortDirection] = useState<'asc' | 'desc'>('asc')
  const [lineItemPriceFilter, setLineItemPriceFilter] = useState<string>('')

  // Price history modal state
  const [historyModal, setHistoryModal] = useState<{
    isOpen: boolean
    productCode: string | null
    description: string | null
    unit: string | null
    supplierId: number
    supplierName: string
    currentPrice?: number
    sourceInvoiceId?: number
    sourceLineItemId?: number
  } | null>(null)

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

  // Fetch settings for high quantity threshold
  const { data: settings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    staleTime: 60000, // Cache for 1 minute
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

    // Set zoom level for target page directly
    setZoomLevel(zoom)
    setZoomPageNum(bbox.pageNumber)

    // Wait for DOM update, then scroll to centered position
    setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!pdfContainerRef.current) return

          const container = pdfContainerRef.current

          // Force layout recalculation
          void container.offsetHeight

          // Find the actual page element to get its real position
          const pageElements = container.querySelectorAll('[data-page-container]')
          const targetPageElement = pageElements[bbox.pageNumber - 1] as HTMLElement

          if (!targetPageElement) {
            console.warn('Could not find page element for scrolling', {
              totalPages: pdfPages.length,
              targetPage: bbox.pageNumber,
              foundElements: pageElements.length
            })
            return
          }

          // Use getBoundingClientRect for accurate positioning
          const containerRect = container.getBoundingClientRect()
          const pageRect = targetPageElement.getBoundingClientRect()

          // Get the actual dimensions of the zoomed page
          const pageActualWidth = pageRect.width
          const pageActualHeight = pageRect.height

          // Calculate bbox center position in pixels (bbox coords are percentages of the page)
          const bboxCenterX = ((bbox.x + bbox.width / 2) / 100) * pageActualWidth
          const bboxCenterY = ((bbox.y + bbox.height / 2) / 100) * pageActualHeight

          // Calculate bbox center position relative to the container
          // pageRect.left/top are relative to viewport, containerRect.left/top are container position
          // Add current scroll position to get absolute position within scrollable content
          const pageLeftInContainer = pageRect.left - containerRect.left + container.scrollLeft
          const pageTopInContainer = pageRect.top - containerRect.top + container.scrollTop

          const bboxAbsoluteX = pageLeftInContainer + bboxCenterX
          const bboxAbsoluteY = pageTopInContainer + bboxCenterY

          // Container viewport dimensions (clientWidth/Height excludes scrollbars but includes padding)
          const containerWidth = container.clientWidth
          const containerHeight = container.clientHeight

          // Calculate scroll position to center the bbox in the viewport
          const scrollLeft = Math.max(0, bboxAbsoluteX - containerWidth / 2)
          const scrollTop = Math.max(0, bboxAbsoluteY - containerHeight / 2)

          console.log('Zoom scroll debug:', {
            bboxPageNum: bbox.pageNumber,
            zoom,
            pageActualSize: { w: pageActualWidth, h: pageActualHeight },
            pageRectInViewport: { left: pageRect.left, top: pageRect.top },
            containerRectInViewport: { left: containerRect.left, top: containerRect.top },
            currentScroll: { left: container.scrollLeft, top: container.scrollTop },
            pageInContainer: { left: pageLeftInContainer, top: pageTopInContainer },
            bboxCenter: { x: bboxCenterX, y: bboxCenterY },
            bboxAbsolute: { x: bboxAbsoluteX, y: bboxAbsoluteY },
            scrollTarget: { left: scrollLeft, top: scrollTop },
            containerSize: { w: containerWidth, h: containerHeight }
          })

          // Scroll instantly to show the highlighted area centered
          container.scrollTo({
            left: scrollLeft,
            top: scrollTop,
            behavior: 'auto' // Instant scroll instead of smooth
          })
        })
      })
    }, 100) // Wait for zoom to apply and DOM to update
  }

  // Reset zoom
  const resetZoom = () => {
    setZoomLevel(1)
    setZoomPageNum(0)
    if (pdfContainerRef.current) {
      pdfContainerRef.current.scrollTo({ left: 0, top: 0, behavior: 'smooth' })
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
  const handleHighlightLineItem = (itemId: number, _lineIndex: number) => {
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
      setInvoiceNotes(invoice.notes || '')
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
        // Account for: imageSection padding (48px) + pdfScrollContainer padding (32px) + extra margin (32px) = 112px total
        const containerWidth = containerRef.current.clientWidth - 112

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
              canvas: canvas,
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

  const saveDefinitionMutation = useMutation({
    mutationFn: async ({ itemId, portionDesc }: { itemId: number; portionDesc?: string }) => {
      const res = await fetch(`/api/invoices/${id}/line-items/${itemId}/save-definition`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ portion_description: portionDesc || null }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Failed to save definition')
      }
      return res.json()
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
    })
  }

  const saveLineItemEdit = (itemId: number) => {
    updateLineItemMutation.mutate({ itemId, data: lineItemEdits })
  }

  // Build dynamic list of supplier words from loaded suppliers
  const getSupplierWords = (): string[] => {
    if (!suppliers) return []
    const words: string[] = []
    for (const supplier of suppliers) {
      // Add each word from supplier name
      if (supplier.name) {
        words.push(...supplier.name.toLowerCase().split(/\s+/))
      }
      // Add each alias and its words
      if (supplier.aliases) {
        for (const alias of supplier.aliases) {
          if (alias) {
            words.push(...alias.toLowerCase().split(/\s+/))
          }
        }
      }
    }
    // Remove duplicates and filter short words
    return [...new Set(words)].filter(w => w.length > 1)
  }

  // Extract meaningful keywords from description for search
  const extractKeywords = (description: string): string => {
    if (!description) return ''
    let text = description
    // Remove pack sizes (12x1L, 120x15g)
    text = text.replace(/\b\d+\s*x\s*\d+(\.\d+)?\s*(g|kg|ml|ltr|l|oz|cl)?\b/gi, '')
    // Remove quantity patterns
    text = text.replace(/\b(qty|quantity)\s*:?\s*\d+\b/gi, '')
    text = text.replace(/\bcase\s*(of\s*)?\d+\b/gi, '')
    // Remove product codes like (L-AG)
    text = text.replace(/\([A-Z]{1,3}-?[A-Z0-9]{1,5}\)/gi, '')
    text = text.replace(/\[[A-Z0-9-]+\]/gi, '')
    // Remove generic packaging terms
    text = text.replace(/\b(case|qty|un|pack|box|each|per|unit|pkt|bag|bottle|tin|can|carton|tray|portion|portions)\b/gi, '')
    // Remove standalone numbers and weights
    text = text.replace(/\b\d+(\.\d+)?\s*(g|kg|ml|ltr|l|oz|cl|lb)?\b/gi, '')
    // Clean up special characters
    text = text.replace(/[^\w\s]/g, ' ')
    // Remove common English stop words
    text = text.replace(/\b(the|a|an|in|on|at|by|for|with|to|of|and|or|is|it|as|be|are|was|been|being|have|has|had|do|does|did|will|would|could|should|may|might|this|that|these|those|from|into|through|during|before|after|above|below|between|under|over)\b/gi, '')
    // Remove supplier names dynamically from loaded suppliers
    const supplierWords = getSupplierWords()
    if (supplierWords.length > 0) {
      const supplierPattern = new RegExp(`\\b(${supplierWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
      text = text.replace(supplierPattern, '')
    }
    return text.split(/\s+/).filter(w => w.length > 1).join(' ').trim()
  }

  const openSearchModal = (item: LineItem) => {
    setSearchingLineItem(item)
    const keywords = extractKeywords(item.description || '')
    setSearchQuery(keywords)
    setSearchResults(null)
    setShowSearchModal(true)
    // Auto-search if we have keywords
    if (keywords) {
      performSearch(keywords)
    }
  }

  const openPriceHistoryModal = (item: LineItem) => {
    if (!invoice?.supplier_id) return
    setHistoryModal({
      isOpen: true,
      productCode: item.product_code,
      description: item.description,
      unit: item.unit,
      supplierId: invoice.supplier_id,
      supplierName: invoice.supplier_name || 'Unknown',
      currentPrice: item.unit_price || undefined,
      sourceInvoiceId: invoice.id,
      sourceLineItemId: item.id,
    })
  }

  const performSearch = async (query: string) => {
    if (!query || query.length < 2) return
    setSearchLoading(true)
    try {
      const res = await fetch('/api/invoices/line-items/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query,
          exclude_invoice_id: id ? parseInt(id) : null
        })
      })
      if (res.ok) {
        setSearchResults(await res.json())
      }
    } finally {
      setSearchLoading(false)
    }
  }

  const toggleCostBreakdown = async (item: LineItem) => {
    if (expandedCostBreakdown === item.id) {
      setExpandedCostBreakdown(null)
      setCostBreakdownEdits({})
      setPortionDescription('')
      setSaveAsDefault(false)
      setCurrentDefinition(null)
    } else {
      setExpandedCostBreakdown(item.id)
      setCostBreakdownEdits({
        pack_quantity: item.pack_quantity,
        unit_size: item.unit_size,
        unit_size_type: item.unit_size_type,
        portions_per_unit: item.portions_per_unit,
        unit_price: item.unit_price,
      })
      setPortionDescription('')
      setSaveAsDefault(false)
      setCurrentDefinition(null)

      // Fetch the saved definition for this line item
      setDefinitionLoading(true)
      try {
        const res = await fetch(`/api/invoices/${id}/line-items/${item.id}/definition`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const def = await res.json()
          setCurrentDefinition(def)
          // Load portion description from saved definition
          setPortionDescription(def?.portion_description || '')
        } else {
          setCurrentDefinition(null)
        }
      } catch {
        setCurrentDefinition(null)
      } finally {
        setDefinitionLoading(false)
      }
    }
  }

  const saveCostBreakdown = async (itemId: number) => {
    // First update the line item
    await updateLineItemMutation.mutateAsync({ itemId, data: costBreakdownEdits })

    // If "save as default" is checked, save the definition (works with or without product code)
    if (saveAsDefault) {
      try {
        await saveDefinitionMutation.mutateAsync({ itemId, portionDesc: portionDescription })
      } catch (err) {
        console.error('Failed to save definition:', err)
        // Don't block the main save operation
      }
    }

    setExpandedCostBreakdown(null)
    setCostBreakdownEdits({})
    setPortionDescription('')
    setSaveAsDefault(false)
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

  // Sort and filter line items
  const handleLineItemSort = (column: string) => {
    if (lineItemSortColumn === column) {
      setLineItemSortDirection(lineItemSortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setLineItemSortColumn(column)
      setLineItemSortDirection('asc')
    }
  }

  const filteredAndSortedLineItems = useMemo(() => {
    if (!lineItems) return []

    // Add original index to each item so we can look up bounding boxes correctly
    let filtered = lineItems.map((item, originalIndex) => ({ ...item, _originalIndex: originalIndex }))

    // Filter by price change status
    if (lineItemPriceFilter) {
      filtered = filtered.filter(item => {
        if (lineItemPriceFilter === 'consistent') return item.price_status === 'consistent'
        if (lineItemPriceFilter === 'amber') return item.price_status === 'amber'
        if (lineItemPriceFilter === 'red') return item.price_status === 'red'
        if (lineItemPriceFilter === 'no_history') return item.price_status === 'no_history'
        return true
      })
    }

    // Sort
    if (lineItemSortColumn) {
      filtered.sort((a, b) => {
        let aVal: any = null
        let bVal: any = null

        switch (lineItemSortColumn) {
          case 'code':
            aVal = a.product_code || ''
            bVal = b.product_code || ''
            break
          case 'description':
            aVal = a.description || ''
            bVal = b.description || ''
            break
          case 'unit':
            aVal = a.unit || ''
            bVal = b.unit || ''
            break
          case 'quantity':
            aVal = a.quantity || 0
            bVal = b.quantity || 0
            break
          case 'unit_price':
            aVal = a.unit_price || 0
            bVal = b.unit_price || 0
            break
          case 'price_change':
            aVal = a.price_change_percent || 0
            bVal = b.price_change_percent || 0
            break
          case 'amount':
            aVal = a.amount || 0
            bVal = b.amount || 0
            break
        }

        if (typeof aVal === 'string') {
          return lineItemSortDirection === 'asc'
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal)
        } else {
          return lineItemSortDirection === 'asc' ? aVal - bVal : bVal - aVal
        }
      })
    }

    return filtered
  }, [lineItems, lineItemSortColumn, lineItemSortDirection, lineItemPriceFilter])

  return (
    <div style={styles.pageContainer}>
      {/* Error banner for Azure OCR failures */}
      {invoice?.ocr_raw_text && invoice.ocr_raw_text.startsWith('Error:') && (
        <div style={styles.errorBanner}>
          <div style={styles.errorBannerIcon}>⚠️</div>
          <div style={styles.errorBannerContent}>
            <strong>OCR Processing Error</strong>
            <p>{invoice.ocr_raw_text.replace('Error: ', '')}</p>
            {invoice.ocr_raw_text.includes('quota exceeded') && (
              <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
                <strong>Next steps:</strong> Check your Azure subscription budget limits in the Azure portal.
                Once resolved, use the "Reprocess" button below to retry OCR extraction.
              </p>
            )}
            {invoice.ocr_raw_text.includes('authentication failed') && (
              <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
                <strong>Next steps:</strong> Verify your Azure API credentials in Settings → Azure Configuration.
              </p>
            )}
          </div>
        </div>
      )}

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
                        {/* Wrapper for image + highlights with actual size scaling for scrollable zoom */}
                        <div
                          data-page-container
                          style={{
                            ...styles.pdfPageContainer,
                            position: 'relative',
                            width: page.displayWidth * (zoomPageNum === pageNum ? zoomLevel : 1),
                            height: page.displayHeight * (zoomPageNum === pageNum ? zoomLevel : 1),
                            margin: '0 auto',
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
              <>
                <div style={styles.imageZoomControls}>
                  <button onClick={() => setImageZoom(Math.min(imageZoom + 0.5, 5))} style={styles.zoomBtn} title="Zoom In">
                    +
                  </button>
                  <span style={styles.zoomLabel}>{Math.round(imageZoom * 100)}%</span>
                  <button onClick={() => setImageZoom(Math.max(imageZoom - 0.5, 1))} style={styles.zoomBtn} title="Zoom Out">
                    −
                  </button>
                  {imageZoom > 1 && (
                    <button onClick={() => setImageZoom(1)} style={styles.zoomResetBtnSmall} title="Reset Zoom">
                      Reset
                    </button>
                  )}
                </div>
                <div
                  style={{
                    ...styles.imageScrollContainer,
                    cursor: imageZoom > 1 ? 'grab' : 'default'
                  }}
                  ref={imageContainerRef}
                  onWheel={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault()
                      const delta = e.deltaY > 0 ? -0.1 : 0.1
                      setImageZoom(Math.max(1, Math.min(5, imageZoom + delta)))
                    }
                  }}
                >
                  <div style={{
                    ...styles.imageContainer,
                    width: `${imageZoom * 100}%`,
                    height: 'auto'
                  }}>
                    <img
                      src={imageUrl}
                      alt="Invoice"
                      style={{
                        ...styles.image,
                        width: '100%',
                        height: 'auto'
                      }}
                    />
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
                </div>
              </>
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
                {(() => {
                  const dateWarning = getDateWarning(invoiceDate || null, invoice?.status || '');
                  return (
                    <>
                      <div style={styles.inputWithEye}>
                        <input
                          type="date"
                          value={invoiceDate}
                          onChange={(e) => setInvoiceDate(e.target.value)}
                          style={{ ...styles.input, ...dateWarningStyles[dateWarning] }}
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
                      {dateWarning !== 'none' && (
                        <span style={{ fontSize: '0.8rem', color: dateWarning === 'red' ? '#dc3545' : '#856404' }}>
                          {!invoiceDate ? 'No date set' : 'Date differs from today by more than 7 days'}
                        </span>
                      )}
                    </>
                  );
                })()}
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

            <label style={styles.label}>
              Invoice Notes
              <small style={{ marginLeft: '0.5rem', color: '#666', fontSize: '0.85em' }}>
                (Optional - included in Dext email if configured)
              </small>
              <textarea
                value={invoiceNotes}
                onChange={(e) => setInvoiceNotes(e.target.value)}
                onBlur={async () => {
                  try {
                    await fetch(`/api/invoices/${id}`, {
                      method: 'PATCH',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                      },
                      body: JSON.stringify({ notes: invoiceNotes })
                    })
                  } catch (error) {
                    console.error('Failed to save notes:', error)
                  }
                }}
                placeholder="Add notes about this invoice..."
                rows={3}
                style={{
                  ...styles.input,
                  resize: 'vertical',
                  fontFamily: 'inherit'
                }}
              />
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
              Confirm & DEXT
            </button>
            {invoice.status === 'confirmed' && (
              <>
                {invoice.dext_sent_at ? (
                  // Show sent status always, resend button only if manual send is enabled
                  settings?.dext_manual_send_enabled ? (
                    <button
                      onClick={() => setShowDextSendConfirm(true)}
                      style={{
                        padding: '0.75rem 1.5rem',
                        background: '#d4edda',
                        borderRadius: '4px',
                        border: '1px solid #c3e6cb',
                        color: '#155724',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        fontWeight: '500',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: '0.25rem'
                      }}
                    >
                      <span>✓ Sent to Dext - Click to Resend</span>
                      <small style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>
                        {new Date(invoice.dext_sent_at).toLocaleString()}
                        {invoice.dext_sent_by_username && ` by ${invoice.dext_sent_by_username}`}
                      </small>
                    </button>
                  ) : (
                    <div style={{
                      padding: '0.75rem 1.5rem',
                      background: '#d4edda',
                      borderRadius: '4px',
                      border: '1px solid #c3e6cb',
                      color: '#155724',
                      fontSize: '0.95rem',
                      fontWeight: '500',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '0.25rem'
                    }}>
                      <span>✓ Sent to Dext</span>
                      <small style={{ fontSize: '0.8rem', fontWeight: 'normal' }}>
                        {new Date(invoice.dext_sent_at).toLocaleString()}
                        {invoice.dext_sent_by_username && ` by ${invoice.dext_sent_by_username}`}
                      </small>
                    </div>
                  )
                ) : (
                  // Not sent yet
                  settings?.dext_manual_send_enabled ? (
                    <button
                      onClick={() => setShowDextSendConfirm(true)}
                      style={{
                        ...styles.confirmBtn,
                        background: '#17a2b8'
                      }}
                    >
                      Send to Dext
                    </button>
                  ) : (
                    <div style={{
                      padding: '0.75rem 1.5rem',
                      background: '#fff3cd',
                      borderRadius: '4px',
                      border: '1px solid #ffc107',
                      color: '#856404',
                      fontSize: '0.95rem',
                      fontWeight: '500'
                    }}>
                      Not submitted to Dext
                    </div>
                  )
                )}
              </>
            )}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <h3 style={{ margin: 0 }}>Line Items</h3>
          {lineItems && lineItems.length > 0 && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <label style={{ fontSize: '0.9rem', color: '#6b7280' }}>
                Filter by price:
                <select
                  value={lineItemPriceFilter}
                  onChange={(e) => setLineItemPriceFilter(e.target.value)}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                >
                  <option value="">All</option>
                  <option value="consistent">✓ Consistent</option>
                  <option value="amber">? Changed</option>
                  <option value="red">! Large change</option>
                  <option value="no_history">No history</option>
                </select>
              </label>
              {(lineItemSortColumn || lineItemPriceFilter) && (
                <button
                  onClick={() => {
                    setLineItemSortColumn('')
                    setLineItemPriceFilter('')
                  }}
                  style={{
                    padding: '4px 10px',
                    fontSize: '0.85rem',
                    color: '#6b7280',
                    background: '#f3f4f6',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
        {lineItems && lineItems.length > 0 ? (
          <table style={styles.lineItemsTable}>
            <thead>
              <tr>
                <th style={{ ...styles.th, width: '30px' }}></th>
                <th
                  style={{ ...styles.th, width: '80px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('code')}
                >
                  Code {lineItemSortColumn === 'code' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  style={{ ...styles.th, minWidth: '280px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('description')}
                >
                  Description {lineItemSortColumn === 'description' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  style={{ ...styles.th, width: '50px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('unit')}
                >
                  Unit {lineItemSortColumn === 'unit' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  style={{ ...styles.th, width: '50px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('quantity')}
                >
                  Qty {lineItemSortColumn === 'quantity' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  style={{ ...styles.th, width: '70px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('unit_price')}
                >
                  Unit Price {lineItemSortColumn === 'unit_price' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th style={{ ...styles.th, width: '50px' }}>VAT %</th>
                <th
                  style={{ ...styles.th, width: '70px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('amount')}
                >
                  Net Total {lineItemSortColumn === 'amount' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th style={{ ...styles.th, textAlign: 'center', width: '60px' }}>Non-Stock</th>
                <th style={{ ...styles.th, textAlign: 'center', width: '40px' }} title="Cost Breakdown"></th>
                <th style={{ ...styles.th, width: '70px' }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedLineItems.map((item) => {
                const bbox = getLineItemBoundingBox(item._originalIndex)
                const hasOcrWarning = !!item.ocr_warnings
                const highQtyThreshold = settings?.high_quantity_threshold ?? 100
                const isHighQuantity = item.quantity !== null && item.quantity > highQtyThreshold
                // OCR warning takes priority (darker amber), high quantity is lighter
                const rowBackground = hasOcrWarning ? '#fff3cd' : isHighQuantity ? '#fff8e1' : undefined
                return (
                  <React.Fragment key={item.id}>
                    <tr style={rowBackground ? { backgroundColor: rowBackground } : undefined}>
                      <td style={styles.td}>
                        {bbox && (
                          <button
                            type="button"
                            onClick={() => handleHighlightLineItem(item.id, item._originalIndex)}
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
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={lineItemEdits.is_non_stock || false}
                              onChange={(e) => setLineItemEdits({ ...lineItemEdits, is_non_stock: e.target.checked })}
                              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            {/* Scale icon disabled during edit */}
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
                            {item.ocr_warnings && (
                              <span
                                title={item.ocr_warnings}
                                style={{
                                  display: 'inline-block',
                                  marginRight: '6px',
                                  color: '#856404',
                                  cursor: 'help',
                                  fontWeight: 'bold',
                                  fontSize: '1.1rem'
                                }}
                              >
                                ⚠️
                              </span>
                            )}
                            {item.description || '—'}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>{item.unit || '—'}</td>
                          <td style={styles.td}>{item.quantity?.toFixed(2) || '—'}</td>
                          <td style={styles.td}>
                            <div>
                              <div>
                                {item.unit_price ? `£${item.unit_price.toFixed(2)}` : '—'}
                                {item.price_status && item.price_status !== 'no_history' && item.price_change_percent !== null && (
                                  <span
                                    onClick={() => openPriceHistoryModal(item)}
                                    style={{
                                      marginLeft: '6px',
                                      cursor: 'pointer',
                                      color: '#6b7280',
                                    }}
                                    title="View price history"
                                  >
                                    📊
                                  </span>
                                )}
                              </div>
                              {item.price_status && item.price_status !== 'no_history' && item.price_change_percent !== null && (() => {
                                const isIncrease = item.price_change_percent > 0
                                const arrow = isIncrease ? '▲' : '▼'
                                const color = isIncrease ? '#ef4444' : '#22c55e'
                                return (
                                  <div style={{ fontSize: '0.75rem', marginTop: '2px', color }}>
                                    <span style={{ fontWeight: 'bold' }}>{arrow}</span>{' '}
                                    {Math.abs(item.price_change_percent).toFixed(1)}%
                                  </div>
                                )
                              })()}
                            </div>
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>{item.tax_rate || '—'}</td>
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
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            <button
                              type="button"
                              onClick={() => toggleCostBreakdown(item)}
                              style={{
                                ...styles.scaleBtn,
                                ...(expandedCostBreakdown === item.id ? styles.scaleBtnActive : {}),
                                color: getScaleIconColor(item)
                              }}
                              title={
                                !item.pack_quantity
                                  ? 'No pack data - click to define'
                                  : item.portions_per_unit === null
                                    ? 'Pack data extracted - portions not defined'
                                    : 'Complete - cost per portion calculated'
                              }
                            >
                              <ScaleIcon />
                            </button>
                          </td>
                          <td style={styles.td}>
                            <button onClick={() => startEditLineItem(item)} style={styles.editBtn}>Edit</button>
                            <button onClick={() => openSearchModal(item)} style={styles.searchBtn} title="Search similar items">
                              🔍
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                    {expandedCostBreakdown === item.id && (
                      <tr>
                        <td colSpan={11} style={styles.costBreakdownCell}>
                          <div style={styles.costBreakdownContainer}>
                            <div style={styles.costBreakdownHeader}>
                              <span style={{ fontWeight: '600' }}>Pack Size & Cost Breakdown</span>
                              {item.raw_content && (
                                <span style={styles.rawContentHint} title={item.raw_content}>
                                  Raw: {item.raw_content.substring(0, 50)}...
                                </span>
                              )}
                            </div>
                            <div style={styles.costBreakdownGrid}>
                              <div style={styles.costBreakdownField}>
                                <label>Pack Qty</label>
                                <input
                                  type="number"
                                  value={costBreakdownEdits.pack_quantity || ''}
                                  onChange={(e) => setCostBreakdownEdits({ ...costBreakdownEdits, pack_quantity: parseInt(e.target.value) || null })}
                                  onFocus={(e) => e.target.select()}
                                  style={styles.costBreakdownInput}
                                  placeholder="e.g., 120"
                                />
                              </div>
                              <div style={styles.costBreakdownField}>
                                <label>Unit Size</label>
                                <div style={{ display: 'flex', gap: '4px' }}>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={costBreakdownEdits.unit_size || ''}
                                    onChange={(e) => setCostBreakdownEdits({ ...costBreakdownEdits, unit_size: parseFloat(e.target.value) || null })}
                                    onFocus={(e) => e.target.select()}
                                    style={{ ...styles.costBreakdownInput, width: '60px' }}
                                    placeholder="e.g., 15"
                                  />
                                  <select
                                    value={costBreakdownEdits.unit_size_type || ''}
                                    onChange={(e) => setCostBreakdownEdits({ ...costBreakdownEdits, unit_size_type: e.target.value || null })}
                                    style={{ ...styles.costBreakdownInput, width: '55px' }}
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
                              <div style={styles.costBreakdownField}>
                                <label>Portions/Unit</label>
                                <input
                                  type="number"
                                  value={costBreakdownEdits.portions_per_unit ?? ''}
                                  onChange={(e) => setCostBreakdownEdits({ ...costBreakdownEdits, portions_per_unit: e.target.value ? parseInt(e.target.value) : null })}
                                  onFocus={(e) => e.target.select()}
                                  style={styles.costBreakdownInput}
                                  min="1"
                                  placeholder="—"
                                />
                              </div>
                              <div style={styles.costBreakdownField}>
                                <label>Portion Desc</label>
                                <input
                                  type="text"
                                  value={portionDescription}
                                  onChange={(e) => setPortionDescription(e.target.value)}
                                  style={{ ...styles.costBreakdownInput, width: '80px' }}
                                  placeholder="e.g., 250ml"
                                  title="Describe what a portion is, e.g., '250ml glass', '1 slice'"
                                />
                              </div>
                              <div style={styles.costBreakdownField}>
                                <label>Unit Price</label>
                                <span style={styles.costBreakdownValue}>
                                  {costBreakdownEdits.unit_price ? `£${costBreakdownEdits.unit_price.toFixed(2)}` : '—'}
                                </span>
                              </div>
                              <div style={styles.costBreakdownField}>
                                <label>Cost/Item</label>
                                <span style={{ ...styles.costBreakdownValue, color: '#28a745', fontWeight: '600' }}>
                                  {costBreakdownEdits.pack_quantity && costBreakdownEdits.unit_price
                                    ? `£${(costBreakdownEdits.unit_price / costBreakdownEdits.pack_quantity).toFixed(4)}`
                                    : '—'}
                                </span>
                              </div>
                              <div style={styles.costBreakdownField}>
                                <label>Cost/Portion</label>
                                <span style={{ ...styles.costBreakdownValue, color: '#28a745', fontWeight: '600' }}>
                                  {costBreakdownEdits.pack_quantity && costBreakdownEdits.unit_price && costBreakdownEdits.portions_per_unit
                                    ? `£${(costBreakdownEdits.unit_price / (costBreakdownEdits.pack_quantity * costBreakdownEdits.portions_per_unit)).toFixed(4)}`
                                    : '—'}
                                </span>
                              </div>
                            </div>
                            {/* Show saved definition info OR update checkbox */}
                            {(item.product_code || item.description) && (
                              <>
                                {definitionLoading ? (
                                  <div style={styles.saveAsDefaultRow}>
                                    <span style={{ fontSize: '0.85rem', color: '#666' }}>Loading saved default...</span>
                                  </div>
                                ) : currentDefinition ? (
                                  <>
                                    {/* Show saved by info */}
                                    <div style={styles.savedByInfo}>
                                      <span>
                                        Definition saved by <strong>{currentDefinition.saved_by_username || 'Unknown'}</strong>
                                        {currentDefinition.updated_at && (
                                          <> on {new Date(currentDefinition.updated_at).toLocaleDateString()}</>
                                        )}
                                        {currentDefinition.source_invoice_number && (
                                          <> from invoice{' '}
                                            <a
                                              href={`/invoice/${currentDefinition.source_invoice_id}`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              style={{ color: '#007bff', textDecoration: 'underline' }}
                                            >
                                              {currentDefinition.source_invoice_number}
                                            </a>
                                          </>
                                        )}
                                      </span>
                                    </div>
                                    {/* Only show update checkbox if values have changed */}
                                    {(
                                      costBreakdownEdits.pack_quantity !== currentDefinition.pack_quantity ||
                                      costBreakdownEdits.unit_size !== currentDefinition.unit_size ||
                                      costBreakdownEdits.unit_size_type !== currentDefinition.unit_size_type ||
                                      costBreakdownEdits.portions_per_unit !== currentDefinition.portions_per_unit ||
                                      portionDescription !== (currentDefinition.portion_description || '')
                                    ) && (
                                      <div style={styles.saveAsDefaultRow}>
                                        <label style={styles.saveAsDefaultLabel}>
                                          <input
                                            type="checkbox"
                                            checked={saveAsDefault}
                                            onChange={(e) => setSaveAsDefault(e.target.checked)}
                                            style={{ marginRight: '0.5rem' }}
                                          />
                                          Update saved default
                                        </label>
                                        <span style={styles.saveAsDefaultHint}>
                                          Values have changed from saved default
                                        </span>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  /* No saved definition - show save as default option */
                                  <div style={styles.saveAsDefaultRow}>
                                    <label style={styles.saveAsDefaultLabel}>
                                      <input
                                        type="checkbox"
                                        checked={saveAsDefault}
                                        onChange={(e) => setSaveAsDefault(e.target.checked)}
                                        style={{ marginRight: '0.5rem' }}
                                      />
                                      Save as default for "{item.product_code || item.description?.substring(0, 30)}"
                                    </label>
                                    <span style={styles.saveAsDefaultHint}>
                                      Future invoices will auto-apply these settings
                                    </span>
                                  </div>
                                )}
                              </>
                            )}
                            <div style={styles.costBreakdownActions}>
                              <button onClick={() => saveCostBreakdown(item.id)} style={styles.smallBtn}>
                                {saveAsDefault ? 'Save & Update Default' : 'Save'}
                              </button>
                              <button onClick={() => { setExpandedCostBreakdown(null); setCostBreakdownEdits({}); setPortionDescription(''); setSaveAsDefault(false); setCurrentDefinition(null); }} style={styles.smallBtnCancel}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {expandedLineItem === item.id && bbox && (
                      <tr>
                        <td colSpan={11} style={styles.lineItemPreviewCell}>
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

      {/* Dext Send Confirmation Modal */}
      {showDextSendConfirm && (
        <div style={styles.modalOverlay} onClick={() => setShowDextSendConfirm(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Send Invoice to Dext?</h3>
            <p style={{ marginBottom: '1rem' }}>
              This will email the invoice PDF to your configured Dext address.
            </p>
            {invoiceNotes && (
              <p style={{ fontSize: '0.9rem', color: '#666' }}>
                <strong>Note:</strong> Invoice notes will be included in the email.
              </p>
            )}
            {lineItems && lineItems.some(item => item.is_non_stock) && (
              <p style={{ fontSize: '0.9rem', color: '#666' }}>
                <strong>Note:</strong> Non-stock items table will be included in the email.
              </p>
            )}
            <div style={styles.modalActions}>
              <button onClick={() => setShowDextSendConfirm(false)} style={styles.cancelBtn}>
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/invoices/${id}/send-to-dext`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` }
                    })
                    if (res.ok) {
                      const result = await res.json()
                      alert(`Invoice sent to Dext successfully at ${new Date(result.sent_at).toLocaleString()}`)
                      setShowDextSendConfirm(false)
                      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
                    } else {
                      const error = await res.json()
                      alert(`Failed to send: ${error.detail}`)
                    }
                  } catch (error) {
                    console.error('Failed to send to Dext:', error)
                    alert('Failed to send invoice to Dext')
                  }
                }}
                style={styles.confirmBtn}
              >
                Send to Dext
              </button>
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

      {/* Line Item Search Modal */}
      {showSearchModal && searchingLineItem && (
        <div style={styles.modalOverlay} onClick={() => setShowSearchModal(false)}>
          <div style={styles.searchModal} onClick={(e) => e.stopPropagation()}>
            <h3>Compare Similar Items</h3>

            {/* Current Item - shown at top for comparison */}
            <div style={styles.currentItemSection}>
              <h4 style={styles.currentItemHeader}>Current Item ({suppliers?.find(s => s.id === invoice?.supplier_id)?.name || 'Unknown Supplier'})</h4>
              <table style={styles.searchResultsTable}>
                <thead>
                  <tr>
                    <th style={styles.searchTh}>Description</th>
                    <th style={styles.searchThRight}>Unit Price</th>
                    <th style={styles.searchTh}>Unit</th>
                    <th style={styles.searchTh}>Pack Info</th>
                    <th style={styles.searchTh}>Invoice Date</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={styles.currentItemRow}>
                    <td style={styles.searchTd}>{searchingLineItem.description}</td>
                    <td style={styles.searchTdRight}>
                      {searchingLineItem.unit_price ? `£${searchingLineItem.unit_price.toFixed(2)}` : '—'}
                    </td>
                    <td style={styles.searchTd}>{searchingLineItem.unit || '—'}</td>
                    <td style={styles.searchTd}>
                      {searchingLineItem.pack_quantity && searchingLineItem.unit_size && searchingLineItem.unit_size_type
                        ? `${searchingLineItem.pack_quantity}x${searchingLineItem.unit_size}${searchingLineItem.unit_size_type}`
                        : searchingLineItem.pack_quantity
                          ? `${searchingLineItem.pack_quantity} pack`
                          : '—'}
                    </td>
                    <td style={styles.searchTd}>{invoice?.invoice_date || '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={styles.searchInputRow}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && performSearch(searchQuery)}
                style={styles.searchInput}
                placeholder="Enter search keywords..."
                autoFocus
              />
              <button
                onClick={() => performSearch(searchQuery)}
                style={styles.searchButton}
                disabled={searchLoading}
              >
                {searchLoading ? 'Searching...' : 'Search'}
              </button>
            </div>

            {searchResults && (
              <div style={styles.searchResultsContainer}>
                <p style={styles.resultsInfo}>
                  Found {searchResults.total_matches} matches
                  {searchResults.extracted_keywords && (
                    <span style={{ color: '#666' }}> (searched: "{searchResults.extracted_keywords}")</span>
                  )}
                </p>

                {searchResults.results.length === 0 ? (
                  <p style={{ color: '#999', fontStyle: 'italic' }}>No matching items found.</p>
                ) : (
                  searchResults.results.map((group) => (
                    <div key={group.supplier_id || 'unknown'} style={styles.supplierGroup}>
                      <h4 style={styles.supplierHeader}>{group.supplier_name}</h4>
                      <table style={styles.searchResultsTable}>
                        <thead>
                          <tr>
                            <th style={styles.searchTh}>Description</th>
                            <th style={styles.searchThRight}>Unit Price</th>
                            <th style={styles.searchTh}>Unit</th>
                            <th style={styles.searchTh}>Pack Info</th>
                            <th style={styles.searchTh}>Last Invoice</th>
                            <th style={styles.searchTh}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map((item, idx) => (
                            <tr key={idx}>
                              <td style={styles.searchTd}>{item.description}</td>
                              <td style={styles.searchTdRight}>
                                {item.unit_price ? `£${item.unit_price.toFixed(2)}` : '—'}
                              </td>
                              <td style={styles.searchTd}>{item.unit || '—'}</td>
                              <td style={styles.searchTd}>{item.pack_info || '—'}</td>
                              <td style={styles.searchTd}>{item.last_invoice_date || '—'}</td>
                              <td style={styles.searchTd}>
                                <a
                                  href={`/review/${item.invoice_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={styles.invoiceLink}
                                  title="Open invoice in new tab"
                                >
                                  View
                                </a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))
                )}
              </div>
            )}

            <button onClick={() => setShowSearchModal(false)} style={styles.closeBtn}>Close</button>
          </div>
        </div>
      )}

      {/* Price History Modal */}
      {historyModal && (
        <LineItemHistoryModal
          isOpen={historyModal.isOpen}
          onClose={() => setHistoryModal(null)}
          productCode={historyModal.productCode}
          description={historyModal.description}
          unit={historyModal.unit}
          supplierId={historyModal.supplierId}
          supplierName={historyModal.supplierName}
          currentPrice={historyModal.currentPrice}
          sourceInvoiceId={historyModal.sourceInvoiceId}
          sourceLineItemId={historyModal.sourceLineItemId}
          onAcknowledge={() => {
            refetchLineItems()
          }}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: '2rem', textAlign: 'center', color: '#666' },
  error: { padding: '2rem', textAlign: 'center', color: '#c00' },
  pageContainer: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  topRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' },
  imageSection: { background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden', minWidth: 0 },
  imageZoomControls: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', justifyContent: 'center' },
  zoomBtn: { padding: '0.5rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '1rem', fontWeight: 'bold', minWidth: '36px' },
  zoomLabel: { fontSize: '0.9rem', color: '#666', minWidth: '50px', textAlign: 'center' },
  zoomResetBtnSmall: { padding: '0.4rem 0.75rem', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '500' },
  imageScrollContainer: { marginTop: '0.5rem', maxHeight: '70vh', maxWidth: '100%', overflow: 'auto', background: '#f5f5f5', borderRadius: '8px', padding: '8px' },
  imageContainer: { position: 'relative' },
  image: { width: '100%', borderRadius: '8px', display: 'block' },
  pdfScrollContainer: { marginTop: '1rem', maxHeight: '70vh', overflow: 'auto', background: '#e5e5e5', borderRadius: '8px', padding: '16px' },
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
  duplicateWarning: { padding: '1rem', borderRadius: '8px', marginBottom: '1rem', cursor: 'pointer', borderWidth: '1px', borderStyle: 'solid', fontWeight: '500' },
  form: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  row: { display: 'flex', gap: '1rem' },
  label: { display: 'flex', flexDirection: 'column', gap: '0.25rem', color: '#333', fontWeight: '500', fontSize: '0.9rem' },
  input: { padding: '0.5rem', borderRadius: '6px', border: '1px solid #ddd', fontSize: '0.95rem', flex: 1 },
  inputWithEye: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  eyeBtn: { padding: '0.4rem 0.5rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, flexShrink: 0 },
  eyeBtnActive: { background: '#fff3cd', border: '1px solid #ffc107' },
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
  scaleBtn: { padding: '0.25rem', background: 'transparent', borderWidth: '1px', borderStyle: 'solid', borderColor: '#ddd', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' },
  scaleBtnActive: { background: '#e8f5e9', borderColor: '#28a745' },
  costBreakdownCell: { padding: '0', background: '#f8f9fa', borderBottom: '1px solid #ddd' },
  costBreakdownContainer: { padding: '1rem', margin: '0.5rem', background: '#fff', borderRadius: '8px', border: '1px solid #e0e0e0', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
  costBreakdownHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', paddingBottom: '0.5rem', borderBottom: '1px solid #eee' },
  rawContentHint: { fontSize: '0.75rem', color: '#999', fontStyle: 'italic', maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  costBreakdownGrid: { display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' },
  costBreakdownField: { display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: '70px' },
  costBreakdownInput: { padding: '0.4rem', borderRadius: '4px', border: '1px solid #ddd', fontSize: '0.9rem', width: '70px', MozAppearance: 'textfield', appearance: 'textfield' } as React.CSSProperties,
  costBreakdownValue: { fontSize: '0.95rem', padding: '0.4rem 0' },
  costBreakdownActions: { display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '0.5rem', borderTop: '1px solid #eee' },
  saveAsDefaultRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem', marginBottom: '0.5rem', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #e0e0e0' },
  saveAsDefaultLabel: { display: 'flex', alignItems: 'center', fontSize: '0.9rem', cursor: 'pointer', fontWeight: '500' },
  saveAsDefaultHint: { fontSize: '0.75rem', color: '#666', fontStyle: 'italic' },
  savedByInfo: { display: 'flex', alignItems: 'center', padding: '0.6rem 0.75rem', marginBottom: '0.5rem', background: '#e8f4fd', borderRadius: '6px', border: '1px solid #b8daff', fontSize: '0.85rem', color: '#004085' },
  // Search modal styles
  searchBtn: { padding: '0.25rem 0.5rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem', marginRight: '0.25rem' },
  searchModal: { background: 'white', padding: '2rem', borderRadius: '12px', maxWidth: '900px', width: '95%', maxHeight: '85vh', overflowY: 'auto' },
  searchContext: { color: '#666', marginBottom: '1rem', fontSize: '0.9rem' },
  searchInputRow: { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
  searchInput: { flex: 1, padding: '0.75rem', borderRadius: '6px', border: '1px solid #ddd', fontSize: '1rem' },
  searchButton: { padding: '0.75rem 1.5rem', background: '#1a1a2e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '500' },
  searchResultsContainer: { marginTop: '1rem', maxHeight: '50vh', overflowY: 'auto' },
  resultsInfo: { color: '#333', fontSize: '0.9rem', marginBottom: '1rem' },
  supplierGroup: { marginBottom: '1.5rem', padding: '1rem', background: '#f8f9fa', borderRadius: '8px' },
  supplierHeader: { margin: '0 0 0.75rem', color: '#1a1a2e', fontSize: '1rem' },
  searchResultsTable: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  searchTh: { textAlign: 'left', padding: '0.5rem', borderBottom: '2px solid #ddd', fontWeight: '600', background: '#e9ecef' },
  searchThRight: { textAlign: 'right', padding: '0.5rem', borderBottom: '2px solid #ddd', fontWeight: '600', background: '#e9ecef' },
  searchTd: { padding: '0.5rem', borderBottom: '1px solid #eee' },
  searchTdRight: { padding: '0.5rem', borderBottom: '1px solid #eee', textAlign: 'right' },
  currentItemSection: { marginBottom: '1.5rem', padding: '1rem', background: '#e8f4f8', borderRadius: '8px', border: '2px solid #2196f3' },
  currentItemHeader: { margin: '0 0 0.75rem', color: '#1565c0', fontSize: '1rem', fontWeight: '600' },
  currentItemRow: { background: '#fff' },
  invoiceLink: { color: '#1976d2', textDecoration: 'none', fontSize: '0.8rem', padding: '0.2rem 0.5rem', background: '#e3f2fd', borderRadius: '4px' },
  // Error banner styles
  errorBanner: { display: 'flex', gap: '1rem', padding: '1rem 1.5rem', marginBottom: '1.5rem', background: '#fff3cd', border: '2px solid #ffc107', borderRadius: '8px', color: '#856404' },
  errorBannerIcon: { fontSize: '2rem', flexShrink: 0 },
  errorBannerContent: { flex: 1 },
}
