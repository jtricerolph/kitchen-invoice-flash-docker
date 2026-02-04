import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import * as pdfjsLib from 'pdfjs-dist'
import { AnnotationMode } from 'pdfjs-dist'
import LineItemHistoryModal from './LineItemHistoryModal'
import CreateDisputeModal from './CreateDisputeModal'
import DisputeDetailModal from './DisputeDetailModal'
import LinkDisputeModal from './LinkDisputeModal'

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

// Source badge component - shows where invoice came from
const sourceConfig: Record<string, { label: string; color: string; icon: string }> = {
  upload: { label: 'Upload', color: '#6c757d', icon: '📤' },
  email: { label: 'Email', color: '#3498db', icon: '📧' },
  api: { label: 'API', color: '#9b59b6', icon: '🔌' },
}

const SourceBadge = ({ source, sourceReference }: { source: string; sourceReference?: string | null }) => {
  const { label, color, icon } = sourceConfig[source] || sourceConfig.upload
  return (
    <span
      style={{
        background: color,
        color: 'white',
        padding: '0.4rem 0.6rem',
        borderRadius: '4px',
        fontSize: '0.8rem',
        fontWeight: '600',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
      }}
      title={sourceReference || undefined}
    >
      {icon} {label}
    </span>
  )
}

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
  // Dispute tracking
  dispute_count: number
  has_open_disputes: boolean
  disputes: Array<{
    id: number
    dispute_type: string
    status: string
    title: string
    disputed_amount: number
    opened_at: string
  }>
  disputed_line_item_ids: number[]
  // Source tracking
  source: string
  source_reference: string | null
  // Linked dispute (for credit notes)
  linked_dispute_id: number | null
  // Total pages from OCR (for multi-page invoices)
  total_pages: number | null
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
  description_alt: string | null  // Alternative description (Azure content vs value mismatch)
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
  price_change_status: string | null  // "consistent", "amber", "red", "no_history", "acknowledged"
  price_change_percent: number | null
  previous_price: number | null
  // Future price (for old invoices)
  future_price: number | null
  future_change_percent: number | null
  // Page number from OCR (for multi-page invoices)
  page_number: number | null
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
  pdf_preview_show_annotations: boolean
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

// Helper to get first line of description (before newline)
const getFirstLineOfDescription = (description: string | null): string => {
  if (!description) return '';
  return description.split('\n')[0].trim();
};

// Date warning levels for unconfirmed invoices
type DateWarning = 'none' | 'amber' | 'red';
function getDateWarning(dateStr: string | null, status: string): DateWarning {
  // No date = always red (regardless of status)
  if (!dateStr) return 'red';

  // Only warn for unconfirmed invoices (confirmed invoices can have any date)
  if (status === 'CONFIRMED') return 'none';

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
  // Handle case when there are no line items
  if (lineItems.length === 0) {
    return (
      <div style={{
        marginTop: '1rem',
        padding: '1rem',
        background: '#fef2f2',
        borderRadius: '6px',
        border: '1px solid #fca5a5'
      }}>
        <div style={{ color: '#dc2626', fontWeight: '600', marginBottom: '0.5rem' }}>
          ⚠️ No Line Items
        </div>
        <div style={{ color: '#991b1b', fontSize: '0.9rem' }}>
          This invoice has no line items. It will NOT be included in GP calculations.
          Use the "Edit Line Items" button above to manually add line items.
        </div>
        <div style={{ marginTop: '0.5rem', color: '#991b1b', fontSize: '0.9rem' }}>
          <strong>Invoice Total:</strong> £{invoiceTotal.toFixed(2)}
        </div>
      </div>
    );
  }

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
  const { token, user } = useAuth()
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
  const [showDisputeModal, setShowDisputeModal] = useState(false)
  const [viewingDisputeId, setViewingDisputeId] = useState<number | null>(null)
  const [adminOperationInProgress, setAdminOperationInProgress] = useState(false)
  const [adminOperationResult, setAdminOperationResult] = useState<{type: 'success' | 'error', message: string} | null>(null)
  const [showRawOcrModal, setShowRawOcrModal] = useState(false)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [showBulkStockModal, setShowBulkStockModal] = useState(false)
  const [searchingLineItem, setSearchingLineItem] = useState<LineItem | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [editingLineItem, setEditingLineItem] = useState<number | null>(null)
  const [lineItemEdits, setLineItemEdits] = useState<Partial<LineItem>>({})
  const [bulkEditMode, setBulkEditMode] = useState(false)
  const [highlightedField, setHighlightedField] = useState<string | null>(null)
  const [expandedLineItem, setExpandedLineItem] = useState<number | null>(null)
  const [expandedCostBreakdown, setExpandedCostBreakdown] = useState<number | null>(null)
  const [costBreakdownEdits, setCostBreakdownEdits] = useState<Partial<LineItem>>({})
  const [descSwapItem, setDescSwapItem] = useState<LineItem | null>(null)  // For description swap modal
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
  const [showLinkDisputeModal, setShowLinkDisputeModal] = useState(false)
  // Date picker modal state
  const [showDatePickerModal, setShowDatePickerModal] = useState(false)
  const [parsedDates, setParsedDates] = useState<Array<{ date: string; original: string; context: string }>>([])
  const [parsedDatesLoading, setParsedDatesLoading] = useState(false)
  // Line items sorting and filtering
  const [lineItemSortColumn, setLineItemSortColumn] = useState<string>('')
  const [lineItemSortDirection, setLineItemSortDirection] = useState<'asc' | 'desc'>('asc')
  const [lineItemPriceFilter, setLineItemPriceFilter] = useState<string>('')
  const [lineItemSearchText, setLineItemSearchText] = useState<string>('')
  const [lineItemPortionsFilter, setLineItemPortionsFilter] = useState<string>('')
  const [lineItemMissingDataFilter, setLineItemMissingDataFilter] = useState<string>('')
  // Current visible page for sticky indicator (multi-page invoices)
  const [currentVisiblePage, setCurrentVisiblePage] = useState<number>(1)
  const lineItemsTableRef = useRef<HTMLDivElement>(null)

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

  const { data: invoice, isLoading, refetch: refetchInvoice } = useQuery<Invoice>({
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

  const { data: stockHistory } = useQuery<Record<string, {
    has_history: boolean
    previously_non_stock: boolean
    total_occurrences: number
    non_stock_occurrences: number
    most_recent_status: boolean | null
  }>>({
    queryKey: ['invoice-stock-history', id],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${id}/stock-history`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch stock history')
      return res.json()
    },
    enabled: !!id,
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

  // Auto-reload when a PENDING invoice finishes processing
  useEffect(() => {
    if (!invoice || invoice.status !== 'PENDING') return

    const pollInterval = setInterval(async () => {
      try {
        const checkRes = await fetch(`/api/invoices/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (checkRes.ok) {
          const inv = await checkRes.json()
          if (inv.status !== 'PENDING') {
            clearInterval(pollInterval)
            window.location.reload()
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, 2000)

    return () => clearInterval(pollInterval)
  }, [invoice?.status, id, token])

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
            // If pdf_preview_show_annotations is false, hide PDF annotations
            const annotationMode = settings?.pdf_preview_show_annotations === false
              ? AnnotationMode.DISABLE
              : AnnotationMode.ENABLE
            await page.render({
              canvasContext: context,
              viewport: renderViewport,
              canvas: canvas,
              annotationMode: annotationMode,
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
  }, [invoice, token, id, settings?.pdf_preview_show_annotations])

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
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        const errorMessage = errorData.detail?.message || errorData.detail || 'Failed to update'
        const error = new Error(errorMessage) as Error & { code?: string }
        error.code = errorData.detail?.error
        throw error
      }
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
      setExpandedLineItem(null)  // Close line item preview
    },
  })

  const createLineItemMutation = useMutation({
    mutationFn: async (data: Partial<LineItem>) => {
      const res = await fetch(`/api/invoices/${id}/line-items`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create line item')
      return res.json()
    },
    onSuccess: () => {
      refetchLineItems()
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      setEditingLineItem(null)
      setLineItemEdits({})
    },
  })

  const deleteLineItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/invoices/${id}/line-items/${itemId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      if (!res.ok) throw new Error('Failed to delete line item')
      return res.json()
    },
    onSuccess: () => {
      refetchLineItems()
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      setEditingLineItem(null)
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

  const handleSave = async (status: string = 'REVIEWED') => {
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

  // Auto-save when invoice details change (debounced)
  useEffect(() => {
    if (!invoice) return

    const timeoutId = setTimeout(() => {
      // Only auto-save if values have actually changed from the invoice
      const hasChanges =
        invoiceNumber !== (invoice.invoice_number || '') ||
        invoiceDate !== (invoice.invoice_date || '') ||
        total !== (invoice.total?.toString() || '') ||
        netTotal !== (invoice.net_total?.toString() || '') ||
        supplierId !== (invoice.supplier_id?.toString() || '') ||
        category !== (invoice.category || 'food') ||
        orderNumber !== (invoice.order_number || '') ||
        documentType !== (invoice.document_type || 'invoice')

      if (hasChanges) {
        updateMutation.mutate({
          invoice_number: invoiceNumber || null,
          invoice_date: invoiceDate || null,
          total: total ? parseFloat(total) : null,
          net_total: netTotal ? parseFloat(netTotal) : null,
          supplier_id: supplierId ? parseInt(supplierId) : null,
          category,
          order_number: orderNumber || null,
          document_type: documentType,
        })
      }
    }, 1000) // 1 second debounce

    return () => clearTimeout(timeoutId)
  }, [invoiceNumber, invoiceDate, total, netTotal, supplierId, category, orderNumber, documentType])

  const handleConfirm = async () => {
    // Check for open disputes before confirming
    if (invoice?.has_open_disputes) {
      alert(
        `Cannot confirm invoice with open disputes.\n\n` +
        `This invoice has ${invoice.dispute_count} dispute(s) that must be resolved first.\n\n` +
        `Please resolve all disputes before confirming.`
      )
      return
    }

    // Check for invoice date before confirming
    if (!invoiceDate) {
      alert(
        `Cannot confirm invoice without a date.\n\n` +
        `Please set the invoice date before confirming.\n\n` +
        `Invoices without dates cannot be found in date-filtered views.`
      )
      return
    }

    try {
      await handleSave('CONFIRMED')
      navigate('/invoices')
    } catch (error) {
      // Handle any validation errors from the backend
      const message = error instanceof Error ? error.message : 'Failed to confirm invoice'
      alert(message)
    }
  }

  const handleDelete = () => {
    deleteMutation.mutate()
  }

  const handleMarkDextSent = async () => {
    if (!window.confirm('Mark this invoice as sent to Dext without actually sending?\n\nThis will also trigger Nextcloud archival if configured.')) {
      return
    }

    setAdminOperationInProgress(true)
    setAdminOperationResult(null)

    try {
      const res = await fetch(`/api/invoices/${id}/mark-dext-sent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to mark as sent')
      }

      const result = await res.json()
      setAdminOperationResult({
        type: 'success',
        message: result.message + (result.archival_status ? `\n\n${result.archival_status}` : '')
      })

      // Refresh invoice data
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
    } catch (error) {
      setAdminOperationResult({
        type: 'error',
        message: error instanceof Error ? error.message : 'Operation failed'
      })
    } finally {
      setAdminOperationInProgress(false)
    }
  }

  const handleReprocessOCR = async () => {
    if (!window.confirm('Reprocess existing OCR data?\n\nThis will:\n- Re-identify supplier\n- Re-detect document type\n- Re-create line items with product definitions\n- Re-run duplicate detection\n\nExisting line items will be replaced.')) {
      return
    }

    setAdminOperationInProgress(true)
    setAdminOperationResult(null)

    try {
      const res = await fetch(`/api/invoices/${id}/reprocess`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to reprocess')
      }

      const result = await res.json()
      setAdminOperationResult({
        type: 'success',
        message: `${result.message}\n\nSupplier ID: ${result.supplier_id || 'None'}\nDocument Type: ${result.document_type}\nLine Items: ${result.line_items_count}\nDuplicate Status: ${result.duplicate_status || 'None'}`
      })

      // Full page reload to ensure all data is fresh
      window.location.reload()
    } catch (error) {
      setAdminOperationResult({
        type: 'error',
        message: error instanceof Error ? error.message : 'Operation failed'
      })
    } finally {
      setAdminOperationInProgress(false)
    }
  }

  const handleFetchParsedDates = async () => {
    setParsedDatesLoading(true)
    setParsedDates([])
    setShowDatePickerModal(true)

    try {
      const res = await fetch(`/api/invoices/${id}/parse-dates`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        throw new Error('Failed to parse dates')
      }

      const data = await res.json()
      setParsedDates(data.found_dates || [])
    } catch (error) {
      console.error('Failed to fetch parsed dates:', error)
    } finally {
      setParsedDatesLoading(false)
    }
  }

  const handleSelectParsedDate = (dateStr: string) => {
    setInvoiceDate(dateStr)
    setShowDatePickerModal(false)
  }

  const handleResendToAzure = async () => {
    if (!window.confirm('Re-send invoice to Azure for OCR extraction?\n\nThis will:\n- Fully re-extract data from Azure\n- Update all invoice fields\n- Re-create line items with product definitions\n- Re-run duplicate detection\n\nExisting data will be replaced.')) {
      return
    }

    setAdminOperationInProgress(true)
    setAdminOperationResult(null)

    try {
      const res = await fetch(`/api/invoices/${id}/resend-to-azure`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to resend to Azure')
      }

      const result = await res.json()
      setAdminOperationResult({
        type: 'success',
        message: `${result.message}\n\nThe page will reload automatically when processing completes.`
      })

      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const checkRes = await fetch(`/api/invoices/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (checkRes.ok) {
            const inv = await checkRes.json()
            if (inv.status !== 'PENDING') {
              clearInterval(pollInterval)
              // Full page reload to ensure all data is fresh
              window.location.reload()
            }
          }
        } catch (e) {
          // Ignore polling errors
        }
      }, 2000)

      // Stop polling after 2 minutes
      setTimeout(() => clearInterval(pollInterval), 120000)
    } catch (error) {
      setAdminOperationResult({
        type: 'error',
        message: error instanceof Error ? error.message : 'Operation failed'
      })
    } finally {
      setAdminOperationInProgress(false)
    }
  }

  const handleRegenerateHighlights = async () => {
    setAdminOperationInProgress(true)
    setAdminOperationResult(null)

    try {
      const res = await fetch(`/api/invoices/${id}/regenerate-highlights`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to regenerate highlights')
      }

      const result = await res.json()
      const nonStockCount = result.non_stock_count || 0
      const hasNotes = result.has_notes
      let message = ''
      if (nonStockCount > 0) {
        message = `PDF highlights regenerated successfully.\n\nHighlighted ${nonStockCount} non-stock item(s).`
      } else {
        message = 'PDF highlights cleared (no non-stock items marked).'
      }
      if (hasNotes) {
        message += '\nNotes overlay added.'
      }
      setAdminOperationResult({
        type: 'success',
        message
      })

      // Refresh invoice to update PDF preview
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
    } catch (error) {
      setAdminOperationResult({
        type: 'error',
        message: error instanceof Error ? error.message : 'Operation failed'
      })
    } finally {
      setAdminOperationInProgress(false)
    }
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
    // Open line item preview
    setExpandedLineItem(item.id)
    setHighlightedField(null)
    resetZoom()
  }

  const saveLineItemEdit = (itemId: number) => {
    if (itemId === -1) {
      // This is a new line item - use POST
      createLineItemMutation.mutate(lineItemEdits)
    } else {
      // Existing line item - use PATCH
      updateLineItemMutation.mutate({ itemId, data: lineItemEdits })
    }
    // Clear edit state immediately after save
    setEditingLineItem(null)
    setLineItemEdits({})
    setExpandedLineItem(null)
  }

  const cancelEditLineItem = () => {
    setEditingLineItem(null)
    setLineItemEdits({})
    setExpandedLineItem(null)
  }

  const handleAddLineItem = () => {
    // Create a temporary new line item with placeholder ID
    const newItemId = -1  // Negative ID indicates unsaved

    // Set editing state to new item
    setEditingLineItem(newItemId)
    setLineItemEdits({
      product_code: '',
      description: '',
      unit: '',
      quantity: null,
      unit_price: null,
      tax_rate: '',
      amount: null,
      is_non_stock: false,
      line_number: (filteredAndSortedLineItems.length || 0) + 1
    })
  }

  const handleDeleteLineItem = (itemId: number) => {
    if (window.confirm('Are you sure you want to delete this line item? This action cannot be undone.')) {
      deleteLineItemMutation.mutate(itemId)
    }
  }

  // Helper to ensure item is being edited when user interacts with fields in bulk mode
  const ensureEditing = (item: LineItem) => {
    if (editingLineItem !== item.id) {
      startEditLineItem(item)
    }
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

  const handleBulkStockUpdate = async (markAsStock: boolean) => {
    if (!lineItems) return

    try {
      // Update all line items
      const promises = lineItems.map(item =>
        fetch(`/api/invoices/${id}/line-items/${item.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ is_non_stock: !markAsStock }),
        })
      )

      await Promise.all(promises)
      await refetchLineItems()
      queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      setShowBulkStockModal(false)
    } catch (error) {
      console.error('Failed to bulk update stock status:', error)
    }
  }

  const toggleCostBreakdown = async (item: LineItem) => {
    if (expandedCostBreakdown === item.id) {
      setExpandedCostBreakdown(null)
      setCostBreakdownEdits({})
      setPortionDescription('')
      setSaveAsDefault(false)
      setCurrentDefinition(null)
      // Close line item preview when closing cost breakdown
      setExpandedLineItem(null)
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
      // Automatically open line item preview when opening cost breakdown
      setExpandedLineItem(item.id)
      setHighlightedField(null)
      resetZoom()

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

  // Sort and filter line items - must be before early returns (Rules of Hooks)
  const filteredAndSortedLineItems = useMemo(() => {
    if (!lineItems) return []

    // Use line_number (original OCR index) so bounding boxes stay correct after deletions
    let filtered = lineItems.map((item) => ({ ...item, _originalIndex: item.line_number }))

    // Filter by search text (product code or description)
    if (lineItemSearchText) {
      const searchLower = lineItemSearchText.toLowerCase()
      filtered = filtered.filter(item => {
        const code = (item.product_code || '').toLowerCase()
        const desc = (item.description || '').toLowerCase()
        return code.includes(searchLower) || desc.includes(searchLower)
      })
    }

    // Filter by price change status
    if (lineItemPriceFilter) {
      filtered = filtered.filter(item => {
        if (lineItemPriceFilter === 'consistent') return item.price_change_status === 'consistent'
        if (lineItemPriceFilter === 'amber') return item.price_change_status === 'amber'
        if (lineItemPriceFilter === 'red') return item.price_change_status === 'red'
        if (lineItemPriceFilter === 'no_history') return item.price_change_status === 'no_history'
        return true
      })
    }

    // Filter by portions definition
    if (lineItemPortionsFilter) {
      filtered = filtered.filter(item => {
        const hasPortions = item.portions_per_unit != null && item.portions_per_unit > 0
        if (lineItemPortionsFilter === 'yes') return hasPortions
        if (lineItemPortionsFilter === 'no') return !hasPortions
        return true
      })
    }

    // Filter by missing key data
    if (lineItemMissingDataFilter === 'missing') {
      filtered = filtered.filter(item => {
        const missingQty = item.quantity == null || item.quantity === 0
        const missingPrice = item.unit_price == null || item.unit_price === 0
        const missingAmount = item.amount == null || item.amount === 0
        return missingQty || missingPrice || missingAmount
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
  }, [lineItems, lineItemSortColumn, lineItemSortDirection, lineItemPriceFilter, lineItemSearchText, lineItemPortionsFilter, lineItemMissingDataFilter])

  // Track visible page in line items table for sticky indicator
  useEffect(() => {
    const container = lineItemsTableRef.current
    if (!container) return

    const handleScroll = () => {
      // Find all rows with data-page attribute
      const rows = container.querySelectorAll('tr[data-page]')
      if (rows.length === 0) return

      const containerTop = container.getBoundingClientRect().top + 50 // Account for sticky header

      // Find the first visible row (closest to top of container)
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        if (rect.top >= containerTop - 10) {
          const pageNum = parseInt(row.getAttribute('data-page') || '1', 10)
          setCurrentVisiblePage(pageNum)
          return
        }
      }

      // If no row found above container top, use the last row's page
      const lastRow = rows[rows.length - 1]
      const pageNum = parseInt(lastRow.getAttribute('data-page') || '1', 10)
      setCurrentVisiblePage(pageNum)
    }

    container.addEventListener('scroll', handleScroll)
    // Initial check
    handleScroll()

    return () => container.removeEventListener('scroll', handleScroll)
  }, [filteredAndSortedLineItems])

  // Calculate line item statistics for checks section
  const lineItemStats = useMemo(() => {
    if (!lineItems) return {
      total: 0,
      withPortions: 0,
      withoutPortions: 0,
      missingData: 0,
      nonStock: 0,
      priceCalcErrors: 0,
      totalsMatch: true,
      totalDifference: 0,
      lineItemsTotal: 0,
      stockItemsTotal: 0,
      nonStockItemsTotal: 0,
      stockItemsGross: 0
    }

    const withPortions = lineItems.filter(item =>
      item.portions_per_unit != null && item.portions_per_unit > 0
    ).length

    const missingData = lineItems.filter(item => {
      const missingQty = item.quantity == null || item.quantity === 0
      const missingPrice = item.unit_price == null || item.unit_price === 0
      const missingAmount = item.amount == null || item.amount === 0
      return missingQty || missingPrice || missingAmount
    }).length

    const nonStock = lineItems.filter(item => item.is_non_stock).length

    // Count items with price calculation errors
    // Valid cases: qty only (free item), or all three values with correct calculation
    // For credit notes, totals are negative but qty/price are positive
    const isCreditNote = invoice?.document_type === 'credit_note'
    const priceCalcErrors = lineItems.filter(item => {
      const hasQty = item.quantity != null && item.quantity > 0
      const hasPrice = item.unit_price != null && item.unit_price > 0
      const hasTotal = item.amount != null && item.amount !== 0  // Changed to allow negative amounts (credit notes)

      // For credit notes, check if absolute values match (qty * price = |total|)
      const expectedTotal = (item.quantity || 0) * (item.unit_price || 0)
      const actualTotal = item.amount || 0
      const calculationMismatch = isCreditNote
        ? Math.abs(Math.abs(expectedTotal) - Math.abs(actualTotal)) > 0.02  // Compare absolute values for credit notes
        : Math.abs(expectedTotal - actualTotal) > 0.02  // Normal comparison for invoices

      return (
        (hasPrice && (!hasQty || !hasTotal)) ||  // price requires both qty and total
        (hasTotal && (!hasQty || !hasPrice)) ||  // total requires both qty and price
        (hasQty && hasPrice && hasTotal && calculationMismatch) // calculation mismatch
      )
    }).length

    // Calculate totals (line items are NET values)
    const lineItemsTotal = lineItems.reduce((sum, item) => sum + (item.amount || 0), 0)
    const stockItemsTotal = lineItems
      .filter(item => !item.is_non_stock)
      .reduce((sum, item) => sum + (item.amount || 0), 0)
    const nonStockItemsTotal = lineItems
      .filter(item => item.is_non_stock)
      .reduce((sum, item) => sum + (item.amount || 0), 0)

    // Calculate VAT ratio from invoice totals
    const invoiceGross = parseFloat(total) || 0
    const invoiceNet = parseFloat(netTotal) || invoiceGross
    const vatRatio = invoiceNet > 0 ? invoiceGross / invoiceNet : 1

    // Line item amounts are NET values
    // Calculate GROSS for stock items by multiplying by VAT ratio
    const stockItemsNet = stockItemsTotal
    const stockItemsGross = stockItemsTotal * vatRatio

    // Check if line items total matches invoice total
    // Line items are NET, so compare against invoice NET (or gross if no net available)
    const compareTotal = invoiceNet
    const difference = Math.abs(compareTotal - lineItemsTotal)
    const totalsMatch = difference <= TOLERANCE

    return {
      total: lineItems.length,
      withPortions,
      withoutPortions: lineItems.length - withPortions,
      missingData,
      nonStock,
      priceCalcErrors,
      totalsMatch,
      totalDifference: difference,
      lineItemsTotal,
      stockItemsTotal,
      stockItemsNet,
      nonStockItemsTotal,
      stockItemsGross
    }
  }, [lineItems, total, netTotal])

  // Check if line items have validation errors (for disabling Confirm/Dext buttons)
  const hasLineItemErrors = useMemo(() => {
    // No line items = error
    if (!lineItems || lineItems.length === 0) return true

    // Totals don't match = error
    if (!lineItemStats.totalsMatch) return true

    // Price calculation errors = error
    if (lineItemStats.priceCalcErrors > 0) return true

    return false
  }, [lineItems, lineItemStats.totalsMatch, lineItemStats.priceCalcErrors])

  // Calculate filter option counts for disabling
  const filterOptionCounts = useMemo(() => {
    if (!lineItems) return {
      consistent: 0,
      amber: 0,
      red: 0,
      no_history: 0,
      withPortions: 0,
      withoutPortions: 0,
      missingData: 0
    }

    return {
      consistent: lineItems.filter(item => item.price_change_status === 'consistent').length,
      amber: lineItems.filter(item => item.price_change_status === 'amber').length,
      red: lineItems.filter(item => item.price_change_status === 'red').length,
      no_history: lineItems.filter(item => item.price_change_status === 'no_history').length,
      withPortions: lineItems.filter(item => item.portions_per_unit != null && item.portions_per_unit > 0).length,
      withoutPortions: lineItems.filter(item => !(item.portions_per_unit != null && item.portions_per_unit > 0)).length,
      missingData: lineItems.filter(item => {
        const missingQty = item.quantity == null || item.quantity === 0
        const missingPrice = item.unit_price == null || item.unit_price === 0
        const missingAmount = item.amount == null || item.amount === 0
        return missingQty || missingPrice || missingAmount
      }).length
    }
  }, [lineItems])

  const handleLineItemSort = (column: string) => {
    if (lineItemSortColumn === column) {
      setLineItemSortDirection(lineItemSortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setLineItemSortColumn(column)
      setLineItemSortDirection('asc')
    }
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

      {/* Processing banner for PENDING invoices */}
      {invoice.status === 'PENDING' && (
        <div style={{
          display: 'flex',
          gap: '1rem',
          padding: '1rem 1.5rem',
          marginBottom: '1.5rem',
          background: '#d4edda',
          border: '2px solid #28a745',
          borderRadius: '8px',
          color: '#155724',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: '1.5rem', flexShrink: 0 }}>&#9881;</div>
          <div>
            <strong>Processing Invoice</strong>
            <p style={{ margin: '0.25rem 0 0' }}>Azure OCR extraction is in progress. The page will reload automatically when complete.</p>
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
                          const item = lineItems.find(item => item.id === expandedLineItem)
                          return item ? getLineItemBoundingBox(item.line_number) : null
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

          {/* Header: Title | Source Badge | Status Badge */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ margin: 0 }}>Invoice Details</h3>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {invoice.source && invoice.source !== 'upload' && (
                <SourceBadge source={invoice.source} sourceReference={invoice.source_reference} />
              )}
              <span style={{
                padding: '0.4rem 0.8rem',
                borderRadius: '4px',
                fontSize: '0.85rem',
                fontWeight: '600',
                background: invoice.status === 'CONFIRMED' ? '#22c55e' : invoice.status === 'REVIEWED' ? '#8b5cf6' : invoice.status === 'PROCESSED' ? '#3b82f6' : '#f59e0b',
                color: 'white'
              }}>
                {invoice.status.toUpperCase()}
                {invoice.document_type === 'delivery_note' && ' (DN)'}
              </span>
            </div>
          </div>

          <div style={styles.form}>
            {/* Supplier (full width) */}
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
                      border: '2px solid #f0ad4e',
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

            {/* Date | Type */}
            <div style={styles.row}>
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.8rem', color: dateWarning === 'red' ? '#dc3545' : '#856404' }}>
                            {!invoiceDate ? 'No date set' : 'Date differs from today by more than 7 days'}
                          </span>
                          {!invoiceDate && (
                            <button
                              type="button"
                              onClick={handleFetchParsedDates}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '2px 4px',
                                fontSize: '1rem',
                                color: '#007bff',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                              title="Find dates in document"
                            >
                              🔍
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </label>

              <label style={{ ...styles.label, flex: 1 }}>
                Document Type
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  style={styles.input}
                >
                  <option value="invoice">Invoice</option>
                  <option value="credit_note">Credit Note</option>
                  <option value="delivery_note">Delivery Note</option>
                </select>
              </label>
            </div>

            {/* Number | PO */}
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
            </div>

            {/* Net | Gross */}
            <div style={styles.row}>
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
            </div>

            {/* Notes */}
            <label style={styles.label}>
              <span>
                Invoice Notes{' '}
                <small style={{ color: '#666', fontSize: '0.85em' }}>
                  (Optional, included in Dext etc.)
                </small>
              </span>
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

          {/* Confirm & Dext (full width, auto-saves on change) */}
          <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
            {/* Link/Resolved Dispute button - only for credit notes with a supplier */}
            {invoice?.document_type === 'credit_note' && invoice?.supplier_id && (
              invoice?.linked_dispute_id ? (
                <button
                  onClick={() => setViewingDisputeId(invoice.linked_dispute_id)}
                  style={{
                    padding: '0.75rem 1rem',
                    background: '#6c757d',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '0.9rem',
                    whiteSpace: 'nowrap'
                  }}
                  title="View the dispute resolved by this credit note"
                >
                  ✓ Resolved Dispute
                </button>
              ) : (
                <button
                  onClick={() => setShowLinkDisputeModal(true)}
                  style={{
                    padding: '0.75rem 1rem',
                    background: '#28a745',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '0.9rem',
                    whiteSpace: 'nowrap'
                  }}
                  title="Link this credit note to an open dispute"
                >
                  Link Dispute
                </button>
              )
            )}
            <button
              onClick={handleConfirm}
              style={{
                ...styles.confirmBtn,
                flex: 1,
                opacity: (hasLineItemErrors || updateMutation.isPending) ? 0.5 : 1,
                cursor: (hasLineItemErrors || updateMutation.isPending) ? 'not-allowed' : 'pointer'
              }}
              disabled={hasLineItemErrors || updateMutation.isPending}
              title={hasLineItemErrors ? 'Fix line item validation errors before confirming' : ''}
            >
              {invoice?.dext_sent_at ? 'CONFIRM' : 'CONFIRM & DEXT'}
            </button>
          </div>

          {/* Checks Section */}
          {lineItems && lineItems.length > 0 && (
            <div style={{ margin: '20px 0', display: 'flex', gap: '8px' }}>
              {/* Items Total Check - RED if doesn't match (blocks confirm) */}
              <div style={{
                flex: 1,
                padding: '8px',
                borderRadius: '4px',
                border: `2px solid ${lineItemStats.totalsMatch ? '#c3e6cb' : '#dc2626'}`,
                background: lineItemStats.totalsMatch ? '#d4edda' : '#fef2f2',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                fontSize: '0.8rem'
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: '2px' }}>
                  {lineItemStats.totalsMatch ? '✓' : '⛔'}
                </div>
                <div style={{ fontWeight: '600', color: lineItemStats.totalsMatch ? '#155724' : '#dc2626', marginBottom: '2px' }}>
                  Items Total
                </div>
                <div style={{ fontSize: '0.7rem', color: lineItemStats.totalsMatch ? '#155724' : '#dc2626' }}>
                  {lineItemStats.totalsMatch ? 'Matches' : "Doesn't match"}
                </div>
              </div>

              {/* QTY/Price Check - RED if errors (blocks confirm) */}
              <div style={{
                flex: 1,
                padding: '8px',
                borderRadius: '4px',
                border: `2px solid ${lineItemStats.priceCalcErrors === 0 ? '#c3e6cb' : '#dc2626'}`,
                background: lineItemStats.priceCalcErrors === 0 ? '#d4edda' : '#fef2f2',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                fontSize: '0.8rem'
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: '2px' }}>
                  {lineItemStats.priceCalcErrors === 0 ? '✓' : '⛔'}
                </div>
                <div style={{ fontWeight: '600', color: lineItemStats.priceCalcErrors === 0 ? '#155724' : '#dc2626', marginBottom: '2px' }}>
                  QTY/Price
                </div>
                <div style={{ fontSize: '0.7rem', color: lineItemStats.priceCalcErrors === 0 ? '#155724' : '#dc2626' }}>
                  {lineItemStats.priceCalcErrors === 0 ? 'All OK' : `${lineItemStats.priceCalcErrors} error${lineItemStats.priceCalcErrors !== 1 ? 's' : ''}`}
                </div>
              </div>

              {/* Portions Check - AMBER warning (doesn't block) */}
              <div style={{
                flex: 1,
                padding: '8px',
                borderRadius: '4px',
                border: `1px solid ${lineItemStats.withoutPortions === 0 ? '#c3e6cb' : '#ffc107'}`,
                background: lineItemStats.withoutPortions === 0 ? '#d4edda' : '#fff3cd',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                fontSize: '0.8rem'
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: '2px' }}>📦</div>
                <div style={{ fontWeight: '600', color: lineItemStats.withoutPortions === 0 ? '#155724' : '#856404', marginBottom: '2px' }}>
                  Portions
                </div>
                <div style={{ fontSize: '0.7rem', color: lineItemStats.withoutPortions === 0 ? '#155724' : '#856404' }}>
                  {lineItemStats.withPortions} / {lineItemStats.total}
                </div>
              </div>

              {/* Missing Data Check - AMBER warning (doesn't block confirm) */}
              <div style={{
                flex: 1,
                padding: '8px',
                borderRadius: '4px',
                border: `1px solid ${lineItemStats.missingData === 0 ? '#c3e6cb' : '#ffc107'}`,
                background: lineItemStats.missingData === 0 ? '#d4edda' : '#fff3cd',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                fontSize: '0.8rem'
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: '2px' }}>
                  {lineItemStats.missingData === 0 ? '✓' : '⚠'}
                </div>
                <div style={{ fontWeight: '600', color: lineItemStats.missingData === 0 ? '#155724' : '#856404', marginBottom: '2px' }}>
                  Missing Data
                </div>
                <div style={{ fontSize: '0.7rem', color: lineItemStats.missingData === 0 ? '#155724' : '#856404' }}>
                  {lineItemStats.missingData} item{lineItemStats.missingData !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Non-Stock Check */}
              <div style={{
                flex: 1,
                padding: '8px',
                borderRadius: '4px',
                border: `1px solid ${lineItemStats.nonStock === 0 ? '#c3e6cb' : '#ffc107'}`,
                background: lineItemStats.nonStock === 0 ? '#d4edda' : '#fff3cd',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                fontSize: '0.8rem'
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: '2px' }}>🚫</div>
                <div style={{ fontWeight: '600', color: lineItemStats.nonStock === 0 ? '#155724' : '#856404', marginBottom: '2px' }}>
                  Non-Stock
                </div>
                <div style={{ fontSize: '0.7rem', color: lineItemStats.nonStock === 0 ? '#155724' : '#856404' }}>
                  {lineItemStats.nonStock} item{lineItemStats.nonStock !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Dext Status Check - Always visible */}
              <div style={{
                flex: 1,
                padding: '8px',
                borderRadius: '4px',
                border: `1px solid ${invoice.dext_sent_at ? '#c3e6cb' : '#ffc107'}`,
                background: invoice.dext_sent_at ? '#d4edda' : '#fff3cd',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                fontSize: '0.8rem'
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: '2px' }}>
                  {invoice.dext_sent_at ? '✓' : '⚠'}
                </div>
                <div style={{ fontWeight: '600', color: invoice.dext_sent_at ? '#155724' : '#856404', marginBottom: '2px' }}>
                  Dext Status
                </div>
                <div style={{ fontSize: '0.7rem', color: invoice.dext_sent_at ? '#155724' : '#856404' }}>
                  {invoice.dext_sent_at ? new Date(invoice.dext_sent_at).toLocaleDateString() : 'Not sent'}
                </div>
              </div>
            </div>
          )}

          {/* Dispute Indicator Blocks - clickable to open detail modal */}
          {invoice.disputes && invoice.disputes.length > 0 && (
            <div style={{ marginTop: '15px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {invoice.disputes.map((dispute) => {
                const isOpen = ['NEW', 'CONTACTED', 'AWAITING_CREDIT', 'AWAITING_REPLACEMENT'].includes(dispute.status)

                return (
                  <div
                    key={dispute.id}
                    onClick={() => setViewingDisputeId(dispute.id)}
                    style={{
                      padding: '12px',
                      background: isOpen ? '#fff3cd' : '#d1ecf1',
                      border: `2px solid ${isOpen ? '#ffc107' : '#17a2b8'}`,
                      borderRadius: '8px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 'bold', color: '#1a1a2e', marginBottom: '4px' }}>
                        {isOpen ? '⚠️' : 'ℹ️'} {dispute.status.replace(/_/g, ' ')}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#666' }}>
                        #{dispute.id} - {dispute.dispute_type.replace(/_/g, ' ').toUpperCase()} - {dispute.title}
                      </div>
                    </div>
                    <span
                      style={{
                        padding: '6px 12px',
                        background: '#e94560',
                        color: 'white',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        fontWeight: 'bold',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      View
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Button Rows - Centered */}
          <div style={{ marginTop: '15px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
            {/* Row 1: Resend to Dext | Delete | View OCR */}
            <div style={{ display: 'flex', gap: '10px' }}>
              {(invoice.status === 'CONFIRMED' || invoice.status === 'REVIEWED') && settings?.dext_manual_send_enabled && (
                <button
                  onClick={() => setShowDextSendConfirm(true)}
                  style={{
                    padding: '0.4rem 1.2rem',
                    fontSize: '0.8rem',
                    background: '#17a2b8',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: hasLineItemErrors ? 'not-allowed' : 'pointer',
                    minWidth: '130px',
                    whiteSpace: 'nowrap',
                    opacity: hasLineItemErrors ? 0.5 : 1
                  }}
                  disabled={hasLineItemErrors}
                  title={hasLineItemErrors ? 'Fix line item validation errors before sending to Dext' : ''}
                >
                  {invoice.dext_sent_at ? 'Resend to Dext' : 'Send to Dext'}
                </button>
              )}
              <button
                onClick={() => setShowDeleteModal(true)}
                style={{
                  padding: '0.4rem 1.2rem',
                  fontSize: '0.8rem',
                  background: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  minWidth: '110px',
                  whiteSpace: 'nowrap'
                }}
              >
                Delete Invoice
              </button>
              <button
                onClick={() => setShowDisputeModal(true)}
                style={{
                  padding: '0.4rem 1.2rem',
                  fontSize: '0.8rem',
                  background: '#f0ad4e',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  minWidth: '110px',
                  whiteSpace: 'nowrap'
                }}
              >
                Log Dispute
              </button>
              <button
                onClick={() => setShowRawOcrModal(true)}
                style={{
                  padding: '0.4rem 1.2rem',
                  fontSize: '0.8rem',
                  background: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  minWidth: '120px',
                  whiteSpace: 'nowrap'
                }}
              >
                View OCR Data
              </button>
            </div>

            {/* Row 2: Admin Only Manual Control Buttons */}
            {user?.is_admin && (
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={handleMarkDextSent}
                  disabled={adminOperationInProgress}
                  style={{
                    padding: '0.4rem 1.2rem',
                    fontSize: '0.8rem',
                    background: adminOperationInProgress ? '#ccc' : '#17a2b8',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: adminOperationInProgress ? 'not-allowed' : 'pointer',
                    minWidth: '140px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {adminOperationInProgress ? 'Processing...' : 'Mark Dext Sent'}
                </button>
                <button
                  onClick={handleReprocessOCR}
                  disabled={adminOperationInProgress}
                  style={{
                    padding: '0.4rem 1.2rem',
                    fontSize: '0.8rem',
                    background: adminOperationInProgress ? '#ccc' : '#ffc107',
                    color: '#000',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: adminOperationInProgress ? 'not-allowed' : 'pointer',
                    minWidth: '130px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {adminOperationInProgress ? 'Processing...' : 'Reprocess OCR'}
                </button>
                <button
                  onClick={handleResendToAzure}
                  disabled={adminOperationInProgress}
                  style={{
                    padding: '0.4rem 1.2rem',
                    fontSize: '0.8rem',
                    background: adminOperationInProgress ? '#ccc' : '#fd7e14',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: adminOperationInProgress ? 'not-allowed' : 'pointer',
                    minWidth: '150px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {adminOperationInProgress ? 'Processing...' : 'Resend to Azure'}
                </button>
                <button
                  onClick={handleRegenerateHighlights}
                  disabled={adminOperationInProgress}
                  style={{
                    padding: '0.4rem 1.2rem',
                    fontSize: '0.8rem',
                    background: adminOperationInProgress ? '#ccc' : '#6f42c1',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: adminOperationInProgress ? 'not-allowed' : 'pointer',
                    minWidth: '160px',
                    whiteSpace: 'nowrap'
                  }}
                  title="Regenerate PDF highlight annotations for non-stock items"
                >
                  {adminOperationInProgress ? 'Processing...' : 'Regen Highlights'}
                </button>
              </div>
            )}

            {/* Admin Operation Result Alert */}
            {adminOperationResult && (
              <div style={{
                marginTop: '10px',
                padding: '12px',
                borderRadius: '4px',
                background: adminOperationResult.type === 'success' ? '#d4edda' : '#f8d7da',
                color: adminOperationResult.type === 'success' ? '#155724' : '#721c24',
                border: `1px solid ${adminOperationResult.type === 'success' ? '#c3e6cb' : '#f5c6cb'}`,
                fontSize: '0.85rem',
                whiteSpace: 'pre-wrap',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start'
              }}>
                <span>{adminOperationResult.message}</span>
                <button
                  onClick={() => setAdminOperationResult(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '1.2rem',
                    cursor: 'pointer',
                    marginLeft: '10px',
                    color: 'inherit'
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Full-width Line Items Section */}
      <div style={styles.lineItemsSection}>
        <div style={{ marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ margin: '0' }}>Line Items</h3>
            <button
              onClick={() => {
                if (bulkEditMode) {
                  // Check if there are unsaved changes
                  if (editingLineItem !== null) {
                    if (!window.confirm('You have unsaved changes. Are you sure you want to exit edit mode?')) {
                      return
                    }
                  }
                  // Exiting bulk edit mode - cancel any unsaved edits
                  setEditingLineItem(null)
                  setLineItemEdits({})
                  setBulkEditMode(false)
                } else {
                  // Entering bulk edit mode
                  setBulkEditMode(true)
                  // If there are no line items, automatically add one
                  if (!lineItems || lineItems.length === 0) {
                    handleAddLineItem()
                  }
                }
              }}
              style={{
                ...styles.editBtn,
                background: bulkEditMode ? '#dc3545' : '#f0f0f0',
                color: bulkEditMode ? 'white' : '#333',
                border: bulkEditMode ? 'none' : '1px solid #ddd',
                padding: '0.5rem 1rem',
                fontSize: '0.85rem'
              }}
            >
              {bulkEditMode ? '✕ Exit Edit Mode' : '✏️ Edit Line Items'}
            </button>
          </div>
          {lineItems && lineItems.length > 0 && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Search by code or description..."
                value={lineItemSearchText}
                onChange={(e) => setLineItemSearchText(e.target.value)}
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: '1px solid #d1d5db',
                  fontSize: '0.9rem'
                }}
              />
              <label style={{ fontSize: '0.9rem', color: '#6b7280' }}>
                Price:
                <select
                  value={lineItemPriceFilter}
                  onChange={(e) => setLineItemPriceFilter(e.target.value)}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                >
                  <option value="">All</option>
                  <option value="consistent" disabled={filterOptionCounts.consistent === 0}>✓ Consistent</option>
                  <option value="amber" disabled={filterOptionCounts.amber === 0}>? Changed</option>
                  <option value="red" disabled={filterOptionCounts.red === 0}>! Large change</option>
                  <option value="no_history" disabled={filterOptionCounts.no_history === 0}>No history</option>
                </select>
              </label>
              <label style={{ fontSize: '0.9rem', color: '#6b7280' }}>
                Portions:
                <select
                  value={lineItemPortionsFilter}
                  onChange={(e) => setLineItemPortionsFilter(e.target.value)}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                >
                  <option value="">All</option>
                  <option value="yes" disabled={filterOptionCounts.withPortions === 0}>📦 Yes</option>
                  <option value="no" disabled={filterOptionCounts.withoutPortions === 0}>○ No</option>
                </select>
              </label>
              <label style={{ fontSize: '0.9rem', color: '#6b7280' }}>
                Data:
                <select
                  value={lineItemMissingDataFilter}
                  onChange={(e) => setLineItemMissingDataFilter(e.target.value)}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                >
                  <option value="">All</option>
                  <option value="missing" disabled={filterOptionCounts.missingData === 0}>⚠ Missing key data</option>
                </select>
              </label>
              {(lineItemSortColumn || lineItemPriceFilter || lineItemSearchText || lineItemPortionsFilter || lineItemMissingDataFilter) && (
                <button
                  onClick={() => {
                    setLineItemSortColumn('')
                    setLineItemPriceFilter('')
                    setLineItemSearchText('')
                    setLineItemPortionsFilter('')
                    setLineItemMissingDataFilter('')
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
        {(lineItems && lineItems.length > 0) || bulkEditMode ? (
          <div style={styles.lineItemsTableContainer} ref={lineItemsTableRef}>
          <table style={styles.lineItemsTable}>
            <thead style={styles.stickyThead}>
              <tr>
                <th style={{ ...styles.th, width: '30px' }}></th>
                <th
                  style={{ ...styles.th, width: '80px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('code')}
                >
                  Code {lineItemSortColumn === 'code' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  style={{ ...styles.th, minWidth: '240px', cursor: 'pointer', userSelect: 'none' }}
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
                  style={{ ...styles.th, width: '110px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('unit_price')}
                >
                  Price {lineItemSortColumn === 'unit_price' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th style={{ ...styles.th, width: '50px' }}>Tax</th>
                <th
                  style={{ ...styles.th, width: '70px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleLineItemSort('amount')}
                >
                  Total {lineItemSortColumn === 'amount' && (lineItemSortDirection === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  style={{ ...styles.th, textAlign: 'center', width: '60px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setShowBulkStockModal(true)}
                  title="Click to mark all items as stock or non-stock"
                >
                  Stock
                </th>
                <th style={{ ...styles.th, textAlign: 'center', width: '40px' }} title="Cost Breakdown"></th>
                <th style={{ ...styles.th, width: '70px' }}></th>
              </tr>
              {/* Sticky page indicator row for multi-page invoices */}
              {invoice && invoice.total_pages && invoice.total_pages > 1 && !lineItemSortColumn && !lineItemSearchText && !lineItemPriceFilter && !lineItemPortionsFilter && !lineItemMissingDataFilter && (
                <tr>
                  <th colSpan={11} style={styles.stickyPageIndicatorCell}>
                    Page {currentVisiblePage} of {invoice.total_pages}
                  </th>
                </tr>
              )}
            </thead>
            <tbody>
              {[...filteredAndSortedLineItems, ...(editingLineItem === -1 ? [{
                id: -1,
                product_code: lineItemEdits.product_code || '',
                description: lineItemEdits.description || '',
                description_alt: null,
                unit: lineItemEdits.unit || '',
                quantity: lineItemEdits.quantity ?? null,
                order_quantity: null,
                unit_price: lineItemEdits.unit_price ?? null,
                tax_rate: lineItemEdits.tax_rate || '',
                tax_amount: null,
                amount: lineItemEdits.amount ?? null,
                line_number: lineItemEdits.line_number || 0,
                is_non_stock: lineItemEdits.is_non_stock || false,
                raw_content: null,
                pack_quantity: null,
                unit_size: null,
                unit_size_type: null,
                portions_per_unit: null,
                cost_per_item: null,
                cost_per_portion: null,
                ocr_warnings: null,
                price_change_status: null,
                price_change_percent: null,
                previous_price: null,
                future_price: null,
                future_change_percent: null,
                page_number: null,
                _originalIndex: -1
              }] : [])].map((item, index, allItems) => {
                const bbox = getLineItemBoundingBox(item._originalIndex)
                const highQtyThreshold = settings?.high_quantity_threshold ?? 100
                const isHighQuantity = item.quantity !== null && item.quantity > highQtyThreshold

                // Check for stock status conflict
                const itemStockHistory = stockHistory?.[item.id.toString()]
                const hasStockConflict = itemStockHistory?.has_history &&
                  itemStockHistory.previously_non_stock &&
                  !item.is_non_stock // Current item is marked as stock, but was previously non-stock

                // Check for price calculation errors
                // Valid cases: qty only (free item), or all three values with correct calculation
                // For credit notes, totals are negative but qty/price are positive
                const hasQty = item.quantity != null && item.quantity > 0
                const hasPrice = item.unit_price != null && item.unit_price > 0
                const hasTotal = item.amount != null && item.amount !== 0  // Changed to allow negative amounts (credit notes)

                // For credit notes, check if absolute values match (qty * price = |total|)
                const isCreditNote = invoice?.document_type === 'credit_note'
                const expectedTotal = (item.quantity || 0) * (item.unit_price || 0)
                const actualTotal = item.amount || 0
                const calculationMismatch = isCreditNote
                  ? Math.abs(Math.abs(expectedTotal) - Math.abs(actualTotal)) > 0.02  // Compare absolute values for credit notes
                  : Math.abs(expectedTotal - actualTotal) > 0.02  // Normal comparison for invoices

                const hasPriceCalcError =
                  (hasPrice && (!hasQty || !hasTotal)) ||  // price requires both qty and total
                  (hasTotal && (!hasQty || !hasPrice)) ||  // total requires both qty and price
                  (hasQty && hasPrice && hasTotal && calculationMismatch) // calculation mismatch (2p tolerance)

                // Check if this line item is disputed
                const isDisputed = invoice.disputed_line_item_ids?.includes(item.id)

                // Check if this is the last item on its page (for page break indicator)
                const isLastOnPage = invoice && invoice.total_pages && invoice.total_pages > 1 &&
                  !lineItemSortColumn && !lineItemSearchText && !lineItemPriceFilter && !lineItemPortionsFilter && !lineItemMissingDataFilter &&
                  item.page_number && index < allItems.length - 1 &&
                  allItems[index + 1]?.page_number !== item.page_number

                // High quantity is lighter amber, disputed is pale pink (OCR warning now shown on product code cell only)
                const rowBackground = isHighQuantity ? '#fff8e1' : isDisputed ? '#fff0f3' : undefined
                const rowStyle: React.CSSProperties | undefined = rowBackground ? { backgroundColor: rowBackground } : undefined
                // Add amber border for stock conflicts, or dashed border for page breaks
                let rowStyleWithBorder: React.CSSProperties | undefined = hasStockConflict
                  ? { ...rowStyle, border: '2px solid #ffc107' }
                  : rowStyle
                if (isLastOnPage && !hasStockConflict) {
                  rowStyleWithBorder = { ...rowStyleWithBorder, borderBottom: '2px dashed #adb5bd' }
                }

                // Style for cells with price calculation errors - create a single box spanning qty to total
                const errorCellStyleLeft = hasPriceCalcError
                  ? { borderLeft: '2px solid #dc3545', borderTop: '2px solid #dc3545', borderBottom: '2px solid #dc3545', backgroundColor: '#ffe6e6' }
                  : {}
                const errorCellStyleMiddle = hasPriceCalcError
                  ? { borderTop: '2px solid #dc3545', borderBottom: '2px solid #dc3545', backgroundColor: '#ffe6e6' }
                  : {}
                const errorCellStyleRight = hasPriceCalcError
                  ? { borderRight: '2px solid #dc3545', borderTop: '2px solid #dc3545', borderBottom: '2px solid #dc3545', backgroundColor: '#ffe6e6' }
                  : {}

                return (
                  <React.Fragment key={item.id}>
                    <tr style={rowStyleWithBorder} data-page={item.page_number || 1}>
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
                              value={editingLineItem === item.id ? (lineItemEdits.product_code || '') : (item.product_code || '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, product_code: e.target.value }); }}
                              style={{ ...styles.tableInput, width: '70px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="text"
                              value={editingLineItem === item.id ? (lineItemEdits.description || '') : (item.description || '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, description: e.target.value }); }}
                              style={styles.tableInput}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="text"
                              value={editingLineItem === item.id ? (lineItemEdits.unit || '') : (item.unit || '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, unit: e.target.value }); }}
                              style={{ ...styles.tableInput, width: '50px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              value={editingLineItem === item.id ? (lineItemEdits.quantity ?? '') : (item.quantity ?? '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, quantity: parseFloat(e.target.value) }); }}
                              style={{ ...styles.tableInput, width: '50px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              value={editingLineItem === item.id ? (lineItemEdits.unit_price ?? '') : (item.unit_price ?? '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, unit_price: parseFloat(e.target.value) }); }}
                              style={{ ...styles.tableInput, width: '70px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="text"
                              value={editingLineItem === item.id ? (lineItemEdits.tax_rate || '') : (item.tax_rate || '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, tax_rate: e.target.value }); }}
                              style={{ ...styles.tableInput, width: '50px' }}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              value={editingLineItem === item.id ? (lineItemEdits.amount ?? '') : (item.amount ?? '')}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, amount: parseFloat(e.target.value) }); }}
                              style={{ ...styles.tableInput, width: '60px' }}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={editingLineItem === item.id ? !lineItemEdits.is_non_stock : !item.is_non_stock}
                              onChange={(e) => { ensureEditing(item); setLineItemEdits({ ...lineItemEdits, is_non_stock: !e.target.checked }); }}
                              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            {/* Scale icon disabled during edit */}
                          </td>
                          <td style={styles.td}>
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <button
                                onClick={() => saveLineItemEdit(item.id)}
                                style={{
                                  padding: '0.35rem 0.5rem',
                                  background: '#f0f0f0',
                                  border: '1px solid #ddd',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '1rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  minWidth: '32px',
                                  height: '32px'
                                }}
                                title="Save changes"
                              >
                                ✅
                              </button>
                              <button
                                onClick={cancelEditLineItem}
                                style={{
                                  padding: '0.35rem 0.5rem',
                                  background: '#f0f0f0',
                                  border: '1px solid #ddd',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '1rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  minWidth: '32px',
                                  height: '32px'
                                }}
                                title="Cancel editing"
                              >
                                ❌
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{ ...styles.td, fontSize: '0.85rem', color: '#666' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <span
                                style={item.ocr_warnings ? {
                                  background: '#fff3cd',
                                  padding: '2px 6px',
                                  borderRadius: '3px',
                                  border: '1px solid #ffc107'
                                } : undefined}
                              >
                                {item.product_code || '—'}
                              </span>
                              {item.ocr_warnings && (
                                <span
                                  title={item.ocr_warnings}
                                  style={{
                                    cursor: 'help',
                                    fontSize: '1rem'
                                  }}
                                >
                                  ⚠️
                                </span>
                              )}
                            </span>
                          </td>
                          <td style={{ ...styles.td, ...(item.is_non_stock ? { color: '#856404', fontStyle: 'italic' } : {}) }}>
                            <div>
                              {getFirstLineOfDescription(item.description) || '—'}
                              {item.description_alt && item.description !== item.description_alt && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setDescSwapItem(item); }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '2px 6px',
                                    fontSize: '0.9rem',
                                    color: '#e94560',
                                    marginLeft: '6px'
                                  }}
                                  title="OCR detected alternative description - click to compare"
                                >
                                  🔄
                                </button>
                              )}
                              {invoice.disputed_line_item_ids?.includes(item.id) && (
                                <span style={{
                                  marginLeft: '8px',
                                  color: '#e94560',
                                  fontSize: '0.7rem',
                                  fontWeight: 'bold',
                                  padding: '2px 6px',
                                  background: '#ffe0e6',
                                  borderRadius: '3px'
                                }}>
                                  [DISPUTED]
                                </span>
                              )}
                            </div>
                            {hasStockConflict && (
                              <div style={{
                                fontSize: '0.75rem',
                                color: '#856404',
                                fontStyle: 'italic',
                                marginTop: '4px',
                                lineHeight: '1.2'
                              }}>
                                ⚠️ This item has previously been marked as not a stock item
                              </div>
                            )}
                            {hasPriceCalcError && (
                              <div style={{
                                fontSize: '0.75rem',
                                color: '#dc3545',
                                fontWeight: 'bold',
                                marginTop: '4px',
                                lineHeight: '1.3'
                              }}>
                                ! QTY x Price = Total Check Failed<br />
                                {item.quantity?.toFixed(2)} × £{item.unit_price?.toFixed(2)} ≠ £{item.amount?.toFixed(2)}
                              </div>
                            )}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem' }}>{item.unit || '—'}</td>
                          <td style={{ ...styles.td, ...errorCellStyleLeft }}>{item.quantity?.toFixed(2) || '—'}</td>
                          <td style={{ ...styles.td, ...errorCellStyleMiddle, position: 'relative' }}>
                            {/* Price value - inline-block to align with other cells */}
                            <div style={{ display: 'inline-block', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                              {item.unit_price != null ? `£${item.unit_price.toFixed(2)}` : '—'}
                              {/* Show green tick inline for consistent prices */}
                              {item.price_change_status === 'consistent' && (
                                <span style={{ marginLeft: '6px', color: '#22c55e', fontWeight: 'bold' }}>
                                  ✓
                                </span>
                              )}
                              {/* Show green document icon inline for new items (no history) */}
                              {item.price_change_status === 'no_history' && (
                                <span style={{ marginLeft: '6px', color: '#22c55e' }}>
                                  📄⁺
                                </span>
                              )}
                              {/* Show amber coin icon inline for items with price changes */}
                              {item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_status !== 'consistent' && (
                                <span style={{ marginLeft: '6px', color: '#f59e0b' }}>
                                  🪙
                                </span>
                              )}
                            </div>
                            {/* Show arrow and percentage below for price changes - absolutely positioned */}
                            {item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_status !== 'consistent' && item.price_change_percent !== null && item.price_change_percent !== 0 && (() => {
                              const isIncrease = item.price_change_percent > 0
                              const arrow = isIncrease ? '▲' : '▼'
                              const color = isIncrease ? '#ef4444' : '#22c55e'
                              return (
                                <div
                                  onClick={() => openPriceHistoryModal(item)}
                                  style={{
                                    position: 'absolute',
                                    bottom: '0.2rem',
                                    left: '0.5rem',
                                    fontSize: '0.65rem',
                                    lineHeight: '1',
                                    color,
                                    cursor: 'pointer'
                                  }}
                                  title="View price history"
                                >
                                  <span style={{ fontWeight: 'bold' }}>{arrow}</span>{' '}
                                  {Math.abs(item.price_change_percent).toFixed(1)}%
                                </div>
                              )
                            })()}
                            {/* Show future price change in brackets and grey for old invoices */}
                            {item.future_change_percent !== null && item.future_change_percent !== 0 && (() => {
                              const isIncrease = item.future_change_percent > 0
                              const arrow = isIncrease ? '▲' : '▼'
                              return (
                                <div
                                  onClick={() => openPriceHistoryModal(item)}
                                  style={{
                                    position: 'absolute',
                                    bottom: '0.2rem',
                                    left: '0.5rem',
                                    fontSize: '0.75rem',
                                    color: '#9ca3af',
                                    cursor: 'pointer'
                                  }}
                                  title="Price changed after this invoice"
                                >
                                  (<span style={{ fontWeight: 'bold' }}>{arrow}</span>{' '}
                                  {Math.abs(item.future_change_percent).toFixed(1)}%)
                                </div>
                              )
                            })()}
                          </td>
                          <td style={{ ...styles.td, fontSize: '0.85rem', ...errorCellStyleMiddle }}>{item.tax_rate || '—'}</td>
                          <td style={{ ...styles.td, ...errorCellStyleRight }}>{item.amount ? `£${item.amount.toFixed(2)}` : '—'}</td>
                          <td style={{ ...styles.td, textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={!item.is_non_stock}
                              onChange={(e) => {
                                updateLineItemMutation.mutate({
                                  itemId: item.id,
                                  data: { is_non_stock: !e.target.checked }
                                })
                              }}
                              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                              title={!item.is_non_stock ? 'Mark as non-stock item' : 'Mark as stock item'}
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
                          <td style={{ ...styles.td, minWidth: '135px', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              {bulkEditMode ? (
                                <>
                                  <button onClick={() => startEditLineItem(item)} style={styles.iconBtn} title="Edit line item">
                                    ✏️
                                  </button>
                                  <button
                                    onClick={() => handleDeleteLineItem(item.id)}
                                    style={{
                                      ...styles.iconBtn,
                                      color: '#dc3545'
                                    }}
                                    title="Delete line item"
                                  >
                                    🗑️
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button onClick={() => openSearchModal(item)} style={styles.iconBtn} title="Search similar items">
                                    🔍
                                  </button>
                                  <button
                                    onClick={() => item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_percent !== null && openPriceHistoryModal(item)}
                                    style={{
                                      ...styles.iconBtn,
                                      opacity: (item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_percent !== null) ? 1 : 0.5,
                                      cursor: (item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_percent !== null) ? 'pointer' : 'not-allowed'
                                    }}
                                    title={
                                      (item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_percent !== null)
                                        ? "View price history"
                                        : "No price history available"
                                    }
                                    disabled={!(item.price_change_status && item.price_change_status !== 'no_history' && item.price_change_percent !== null)}
                                  >
                                    📊
                                  </button>
                                </>
                              )}
                            </div>
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
                            <div style={{ ...styles.costBreakdownGrid, gap: '1rem' }}>
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
                              <div style={{ ...styles.costBreakdownField, gridColumn: 'span 2' }}>
                                <label>Portion Desc</label>
                                <input
                                  type="text"
                                  value={portionDescription}
                                  onChange={(e) => setPortionDescription(e.target.value)}
                                  style={{ ...styles.costBreakdownInput, width: '100%' }}
                                  placeholder="e.g., 250ml glass or 1 slice"
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
                              <div style={styles.costBreakdownField}>
                                <label>Total Portions</label>
                                <span style={{ ...styles.costBreakdownValue, color: '#007bff', fontWeight: '600' }}>
                                  {item.quantity && costBreakdownEdits.pack_quantity && costBreakdownEdits.portions_per_unit
                                    ? Math.round(item.quantity * costBreakdownEdits.pack_quantity * costBreakdownEdits.portions_per_unit)
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

                              // Calculate bounding box coordinates in high-res canvas pixels
                              const bboxX = (bbox.x / 100) * pageData.width
                              const bboxY = (bbox.y / 100) * pageData.height
                              const bboxW = (bbox.width / 100) * pageData.width
                              const bboxH = (bbox.height / 100) * pageData.height

                              // Small padding around OCR text so box doesn't cover the text
                              const boxPadding = 15 // 15px breathing room around detected text
                              const expandedBboxX = Math.max(0, bboxX - boxPadding)
                              const expandedBboxY = Math.max(0, bboxY - boxPadding)
                              const expandedBboxW = bboxW + (boxPadding * 2)
                              const expandedBboxH = bboxH + (boxPadding * 2)

                              // Crop tightly to the expanded box - minimal extra space
                              const cropPadding = 5 // Very tight crop so box fills container
                              const startX = Math.max(0, expandedBboxX - cropPadding)
                              const startY = Math.max(0, expandedBboxY - cropPadding)
                              const endX = Math.min(pageData.width, expandedBboxX + expandedBboxW + cropPadding)
                              const endY = Math.min(pageData.height, expandedBboxY + expandedBboxH + cropPadding)
                              const cropW = endX - startX
                              const cropH = endY - startY

                              // Calculate expanded bounding box position relative to cropped area
                              const relBboxX = expandedBboxX - startX
                              const relBboxY = expandedBboxY - startY

                              // Create a cropped canvas
                              const croppedCanvas = document.createElement('canvas')
                              croppedCanvas.width = cropW
                              croppedCanvas.height = cropH
                              const ctx = croppedCanvas.getContext('2d')
                              if (ctx) {
                                ctx.drawImage(
                                  pageData.canvas,
                                  startX, startY, cropW, cropH,
                                  0, 0, cropW, cropH
                                )
                              }

                              return (
                                <div style={styles.lineItemPreviewContainer}>
                                  <div style={{
                                    position: 'relative',
                                    display: 'block',
                                    width: '100%',
                                  }}>
                                    <img
                                      src={croppedCanvas.toDataURL()}
                                      alt="Line item from invoice"
                                      style={{
                                        width: '100%',
                                        height: 'auto',
                                        display: 'block',
                                      }}
                                    />
                                    {/* Bounding box overlay */}
                                    <div
                                      style={{
                                        position: 'absolute',
                                        left: `${(relBboxX / cropW) * 100}%`,
                                        top: `${(relBboxY / cropH) * 100}%`,
                                        width: `${(expandedBboxW / cropW) * 100}%`,
                                        height: `${(expandedBboxH / cropH) * 100}%`,
                                        border: '2px solid #ffc107',
                                        borderRadius: '2px',
                                        pointerEvents: 'none',
                                        boxShadow: '0 0 8px rgba(255, 193, 7, 0.5)',
                                      }}
                                    />
                                  </div>
                                </div>
                              )
                            })()
                          ) : imageUrl ? (
                            (() => {
                              // Expand bounding box for better visibility (percentage-based)
                              const expansionPercent = 2 // Expand by 2% in each direction
                              const expandedX = Math.max(0, bbox.x - expansionPercent)
                              const expandedY = Math.max(0, bbox.y - expansionPercent)
                              const expandedWidth = Math.min(100 - expandedX, bbox.width + (expansionPercent * 2))
                              const expandedHeight = Math.min(100 - expandedY, bbox.height + (expansionPercent * 2))

                              return (
                                <div style={styles.lineItemPreviewContainer}>
                                  <div style={{
                                    position: 'relative',
                                    display: 'block',
                                    width: '100%',
                                  }}>
                                    <img
                                      src={`${imageUrl.split('?')[0]}?token=${encodeURIComponent(token || '')}`}
                                      alt="Line item location"
                                      style={{
                                        width: '100%',
                                        height: 'auto',
                                        display: 'block',
                                      }}
                                    />
                                    {/* Bounding box overlay */}
                                    <div
                                      style={{
                                        position: 'absolute',
                                        left: `${expandedX}%`,
                                        top: `${expandedY}%`,
                                        width: `${expandedWidth}%`,
                                        height: `${expandedHeight}%`,
                                        border: '2px solid #ffc107',
                                        borderRadius: '2px',
                                        pointerEvents: 'none',
                                        boxShadow: '0 0 8px rgba(255, 193, 7, 0.5)',
                                      }}
                                    />
                                  </div>
                                </div>
                              )
                            })()
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
              {bulkEditMode && (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: '1.5rem', background: '#f9fafb' }}>
                    <button
                      onClick={handleAddLineItem}
                      style={{
                        ...styles.confirmBtn,
                        padding: '0.75rem 2rem',
                        fontSize: '0.95rem'
                      }}
                    >
                      + Add Line Item
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        ) : (
          <p style={styles.noItems}>No line items extracted</p>
        )}

        {/* Line Items Total Validation */}
        <LineItemsValidation
          lineItems={lineItems || []}
          invoiceTotal={parseFloat(total) || 0}
          netTotal={netTotal ? parseFloat(netTotal) : null}
        />
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

      {/* Date Picker Modal - select date from parsed dates */}
      {showDatePickerModal && (
        <div style={styles.modalOverlay} onClick={() => setShowDatePickerModal(false)}>
          <div style={{ ...styles.rawOcrModal, maxWidth: '500px' }} onClick={(e) => e.stopPropagation()}>
            <h3>Select Invoice Date</h3>
            <p style={{ color: '#666', marginBottom: '1rem' }}>
              Dates found in the document. Click to select.
            </p>

            {parsedDatesLoading ? (
              <p style={{ color: '#999', textAlign: 'center', padding: '2rem' }}>Searching for dates...</p>
            ) : parsedDates.length === 0 ? (
              <p style={{ color: '#999', textAlign: 'center', padding: '2rem' }}>No dates found in document text.</p>
            ) : (
              <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                {parsedDates.map((dateInfo, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleSelectParsedDate(dateInfo.date)}
                    style={{
                      padding: '0.75rem 1rem',
                      marginBottom: '0.5rem',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      background: '#fff',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#f0f7ff'
                      e.currentTarget.style.borderColor = '#007bff'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#fff'
                      e.currentTarget.style.borderColor = '#ddd'
                    }}
                  >
                    <div style={{ fontWeight: '600', fontSize: '1.1rem', marginBottom: '0.25rem' }}>
                      {new Date(dateInfo.date).toLocaleDateString('en-GB', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric'
                      })}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#666' }}>
                      Original: {dateInfo.original}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.25rem', fontStyle: 'italic' }}>
                      ...{dateInfo.context}...
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button onClick={() => setShowDatePickerModal(false)} style={styles.closeBtn}>Cancel</button>
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
                                {item.unit_price != null ? `£${item.unit_price.toFixed(2)}` : '—'}
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

      {/* Bulk Stock Modal */}
      {showBulkStockModal && (
        <div style={styles.modalOverlay} onClick={() => setShowBulkStockModal(false)}>
          <div style={{ ...styles.modal, maxWidth: '400px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '1rem' }}>Bulk Stock Update</h3>
            <p style={{ marginBottom: '1.5rem', color: '#666' }}>
              Mark all line items on this invoice as:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <button
                onClick={() => handleBulkStockUpdate(true)}
                style={{
                  ...styles.saveBtn,
                  padding: '1rem',
                  background: '#28a745',
                  fontSize: '0.95rem'
                }}
              >
                Mark All as Stock
              </button>
              <button
                onClick={() => handleBulkStockUpdate(false)}
                style={{
                  ...styles.saveBtn,
                  padding: '1rem',
                  background: '#dc3545',
                  fontSize: '0.95rem'
                }}
              >
                Mark All as Non-Stock
              </button>
              <button
                onClick={() => setShowBulkStockModal(false)}
                style={{
                  ...styles.backBtn,
                  padding: '0.75rem',
                  marginTop: '0.5rem'
                }}
              >
                Cancel
              </button>
            </div>
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

      {/* Create Dispute Modal */}
      {showDisputeModal && invoice && (
        <CreateDisputeModal
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          supplierId={invoice.supplier_id || null}
          supplierName={invoice.supplier_name || null}
          lineItems={lineItems || []}
          onClose={() => setShowDisputeModal(false)}
          onSuccess={() => {
            refetchInvoice() // Refresh invoice to update dispute count
          }}
        />
      )}

      {/* Link Credit Note to Dispute Modal */}
      {showLinkDisputeModal && invoice && invoice.supplier_id && (
        <LinkDisputeModal
          supplierId={invoice.supplier_id}
          supplierName={invoice.supplier_name || null}
          creditNoteInvoiceId={invoice.id}
          creditNoteNumber={invoice.invoice_number}
          creditNoteAmount={invoice.total}
          onClose={() => setShowLinkDisputeModal(false)}
          onSuccess={() => {
            setShowLinkDisputeModal(false)
            refetchInvoice() // Refresh to show "Resolved Dispute" button
          }}
        />
      )}

      {/* View Dispute Detail Modal */}
      {viewingDisputeId && (
        <DisputeDetailModal
          disputeId={viewingDisputeId}
          onClose={() => setViewingDisputeId(null)}
          onUpdate={() => {
            refetchInvoice() // Refresh invoice to update dispute data
          }}
        />
      )}

      {/* Description Swap Modal */}
      {descSwapItem && (
        <div style={styles.modalOverlay} onClick={() => setDescSwapItem(null)}>
          <div style={styles.descSwapModal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '0.5rem' }}>Choose Description</h3>
            <p style={styles.modalHint}>
              OCR extracted two different descriptions. Select the correct one:
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
              {/* Current Description */}
              <div
                style={styles.descriptionOption}
                onClick={() => {
                  // Keep current - just close
                  setDescSwapItem(null)
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: '0.5rem', color: '#666' }}>
                  Current (Value)
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  {descSwapItem.description || '(empty)'}
                </div>
              </div>

              {/* Alternative Description */}
              <div
                style={{ ...styles.descriptionOption, borderColor: '#e94560' }}
                onClick={async () => {
                  // Update to alternative
                  await updateLineItemMutation.mutateAsync({
                    itemId: descSwapItem.id,
                    data: {
                      description: descSwapItem.description_alt,
                      description_alt: null  // Clear alt after swap
                    }
                  })
                  setDescSwapItem(null)
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: '0.5rem', color: '#e94560' }}>
                  Alternative (Content) ✓ Select
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  {descSwapItem.description_alt || '(empty)'}
                </div>
              </div>
            </div>

            <button
              onClick={() => setDescSwapItem(null)}
              style={{ ...styles.backBtn, marginTop: '1rem', padding: '0.75rem' }}
            >
              Cancel
            </button>
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
  lineItemsTableContainer: { maxHeight: '60vh', overflowY: 'auto', overflowX: 'auto', border: '1px solid #eee', borderRadius: '8px', position: 'relative' } as React.CSSProperties,
  stickyThead: { position: 'sticky', top: 0, zIndex: 2, borderBottom: '2px solid #ddd' } as React.CSSProperties,
  stickyPageIndicatorCell: { background: '#e9ecef', padding: '0.3rem 1rem', textAlign: 'center', fontSize: '0.85rem', fontWeight: '500', color: '#495057' } as React.CSSProperties,
  lineItemsTable: { width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' },
  th: { textAlign: 'left', padding: '0.75rem 0.5rem', fontWeight: '600', background: '#f8f9fa' } as React.CSSProperties,
  pageBreakRow: { background: '#f8f9fa' },
  pageBreakCell: { textAlign: 'center', padding: '0.5rem', color: '#6c757d', fontSize: '0.85rem', fontStyle: 'italic', borderBottom: '1px dashed #dee2e6', borderTop: '1px dashed #dee2e6' } as React.CSSProperties,
  td: { padding: '0.75rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'middle' },
  tableInput: { padding: '0.35rem', borderRadius: '4px', border: '1px solid #ddd', fontSize: '0.9rem', width: '100%' },
  smallBtn: { padding: '0.35rem 0.75rem', background: '#5cb85c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginRight: '0.25rem', fontSize: '0.8rem' },
  smallBtnCancel: { padding: '0.35rem 0.75rem', background: '#999', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' },
  editBtn: { padding: '0.35rem 0.75rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' },
  iconBtn: { padding: '0.35rem 0.5rem', background: '#f0f0f0', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '32px', height: '32px' },
  noItems: { color: '#999', fontStyle: 'italic', marginTop: '0.5rem' },
  status: { marginTop: '1rem', padding: '0.75rem', background: '#f5f5f5', borderRadius: '6px', color: '#666', fontSize: '0.9rem' },
  docTypeBadge: { marginLeft: '1rem', padding: '0.25rem 0.5rem', background: '#17a2b8', color: 'white', borderRadius: '4px', fontSize: '0.75rem' },
  actions: { display: 'flex', gap: '0.75rem', marginTop: '1rem' },
  saveBtn: { flex: 1, padding: '1.25rem', background: '#1a1a2e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem' },
  confirmBtn: { flex: 1, padding: '1.25rem', background: '#5cb85c', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem' },
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
  lineItemPreviewCell: { padding: '0.5rem', background: '#f8f9fa', borderBottom: '1px solid #eee', textAlign: 'center' },
  lineItemPreviewContainer: { width: '100%', overflow: 'hidden', display: 'inline-block' },
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
  // Description swap modal styles
  descSwapModal: { background: 'white', padding: '2rem', borderRadius: '12px', maxWidth: '600px', width: '90%', maxHeight: '80vh', overflowY: 'auto' },
  descriptionOption: { padding: '1rem', borderRadius: '8px', background: '#f9f9f9', border: '2px solid #ccc', cursor: 'pointer', transition: 'background 0.2s' },
  modalHint: { color: '#666', fontSize: '0.9rem', margin: 0 },
}
