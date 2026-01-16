import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { useQueryClient } from '@tanstack/react-query'
import { PDFDocument } from 'pdf-lib'
import imageCompression from 'browser-image-compression'

interface PageImage {
  id: string
  file: File
  preview: string
  compressed?: Blob
}

interface QueueItem {
  id: string
  filename: string
  status: 'uploading' | 'processing' | 'complete' | 'error'
  error?: string
  invoiceId?: number
}

export default function Upload() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const addMoreInputRef = useRef<HTMLInputElement>(null)

  const [pages, setPages] = useState<PageImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [queue, setQueue] = useState<QueueItem[]>([])

  // Compression options - balance quality vs size
  const compressionOptions = {
    maxSizeMB: 1,           // Target max 1MB per image
    maxWidthOrHeight: 2000, // Good for OCR
    useWebWorker: true,
    fileType: 'image/jpeg' as const,
    initialQuality: 0.85,   // 85% JPEG quality
  }

  const generateId = () => Math.random().toString(36).substr(2, 9)

  const handleFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const newPages: PageImage[] = []

    for (const file of fileArray) {
      const isImage = file.type.startsWith('image/')
      const isPDF = file.type === 'application/pdf'

      if (!isImage && !isPDF) {
        setError('Please upload image or PDF files only')
        continue
      }

      if (isPDF) {
        // For PDFs, upload directly without conversion (don't wait)
        uploadFile(file)
        continue
      }

      // Create preview for image
      const preview = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = (e) => resolve(e.target?.result as string)
        reader.readAsDataURL(file)
      })

      newPages.push({
        id: generateId(),
        file,
        preview,
      })
    }

    if (newPages.length > 0) {
      setPages(prev => [...prev, ...newPages])
    }
    setError('')
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
    }
    // Reset input so same file can be selected again
    e.target.value = ''
  }

  const removePage = (id: string) => {
    setPages(prev => prev.filter(p => p.id !== id))
  }

  const movePage = (id: string, direction: 'up' | 'down') => {
    setPages(prev => {
      const idx = prev.findIndex(p => p.id === id)
      if (idx === -1) return prev
      if (direction === 'up' && idx === 0) return prev
      if (direction === 'down' && idx === prev.length - 1) return prev

      const newPages = [...prev]
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1
      ;[newPages[idx], newPages[swapIdx]] = [newPages[swapIdx], newPages[idx]]
      return newPages
    })
  }

  const generateQueueId = () => Math.random().toString(36).substr(2, 9)

  const uploadFile = async (file: File, fromPages: boolean = false) => {
    const queueId = generateQueueId()
    const filename = file.name || 'invoice.pdf'

    // Add to queue as uploading
    setQueue(prev => [...prev, {
      id: queueId,
      filename,
      status: 'uploading'
    }])

    // Clear pages if this was from multi-page upload
    if (fromPages) {
      setPages([])
      setProcessing(false)
      setStatus('')
    }

    try {
      const formData = new FormData()
      formData.append('file', file)

      // Update to processing (upload complete, OCR starting)
      setQueue(prev => prev.map(item =>
        item.id === queueId ? { ...item, status: 'processing' as const } : item
      ))

      const res = await fetch('/api/invoices/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Upload failed')
      }

      const result = await res.json()

      // Update to complete
      setQueue(prev => prev.map(item =>
        item.id === queueId ? { ...item, status: 'complete' as const, invoiceId: result.id } : item
      ))

      // Refresh invoice list
      queryClient.invalidateQueries({ queryKey: ['invoices'] })

    } catch (err) {
      // Update to error
      setQueue(prev => prev.map(item =>
        item.id === queueId ? {
          ...item,
          status: 'error' as const,
          error: err instanceof Error ? err.message : 'Upload failed'
        } : item
      ))
    }
  }

  const removeFromQueue = (id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id))
  }

  const clearCompletedFromQueue = () => {
    setQueue(prev => prev.filter(item => item.status !== 'complete' && item.status !== 'error'))
  }

  const processAndUpload = async () => {
    if (pages.length === 0) {
      setError('Please add at least one page')
      return
    }

    setProcessing(true)
    setError('')

    try {
      // Step 1: Compress images
      setStatus(`Compressing ${pages.length} image(s)...`)
      const compressedImages: { data: ArrayBuffer; width: number; height: number }[] = []

      for (let i = 0; i < pages.length; i++) {
        setStatus(`Compressing page ${i + 1} of ${pages.length}...`)

        const compressed = await imageCompression(pages[i].file, compressionOptions)

        // Get image dimensions
        const img = new Image()
        const imgUrl = URL.createObjectURL(compressed)
        await new Promise<void>((resolve) => {
          img.onload = () => {
            URL.revokeObjectURL(imgUrl)
            resolve()
          }
          img.src = imgUrl
        })

        const arrayBuffer = await compressed.arrayBuffer()
        compressedImages.push({
          data: arrayBuffer,
          width: img.width,
          height: img.height,
        })
      }

      // Step 2: Create PDF
      setStatus('Creating PDF...')
      const pdfDoc = await PDFDocument.create()

      for (let i = 0; i < compressedImages.length; i++) {
        setStatus(`Adding page ${i + 1} to PDF...`)

        const { data, width, height } = compressedImages[i]

        // Embed the JPEG image
        const jpegImage = await pdfDoc.embedJpg(data)

        // Create page with image dimensions (or scale to fit)
        const page = pdfDoc.addPage([width, height])

        page.drawImage(jpegImage, {
          x: 0,
          y: 0,
          width: width,
          height: height,
        })
      }

      // Step 3: Save PDF
      setStatus('Finalizing PDF...')
      const pdfBytes = await pdfDoc.save()
      const pdfBlob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
      const pdfFile = new File([pdfBlob], `invoice-${pages.length}pages.pdf`, { type: 'application/pdf' })

      // Step 4: Upload (don't wait - let it run in background)
      uploadFile(pdfFile, true)

    } catch (err) {
      console.error('Processing error:', err)
      setError(err instanceof Error ? err.message : 'Failed to process images')
      setProcessing(false)
      setStatus('')
    }
  }

  const clearAll = () => {
    setPages([])
    setError('')
    setStatus('')
  }

  const isWorking = processing || uploading

  return (
    <div>
      <h2 style={styles.title}>Upload Invoice</h2>

      {error && <div style={styles.error}>{error}</div>}

      {/* Processing Queue */}
      {queue.length > 0 && (
        <div style={styles.queueSection}>
          <div style={styles.queueHeader}>
            <h3 style={styles.queueTitle}>Processing Queue</h3>
            {queue.some(item => item.status === 'complete' || item.status === 'error') && (
              <button onClick={clearCompletedFromQueue} style={styles.clearQueueBtn}>
                Clear Completed
              </button>
            )}
          </div>
          <div style={styles.queueList}>
            {queue.map(item => (
              <div key={item.id} style={{
                ...styles.queueItem,
                ...(item.status === 'complete' ? styles.queueItemComplete : {}),
                ...(item.status === 'error' ? styles.queueItemError : {}),
              }}>
                <div style={styles.queueItemInfo}>
                  <span style={styles.queueItemName}>{item.filename}</span>
                  <span style={{
                    ...styles.queueItemStatus,
                    color: item.status === 'complete' ? '#28a745' :
                           item.status === 'error' ? '#dc3545' :
                           item.status === 'processing' ? '#0066cc' : '#666'
                  }}>
                    {item.status === 'uploading' && '⬆️ Uploading...'}
                    {item.status === 'processing' && '⏳ Processing OCR...'}
                    {item.status === 'complete' && '✓ Complete'}
                    {item.status === 'error' && `✗ ${item.error || 'Failed'}`}
                  </span>
                </div>
                <div style={styles.queueItemActions}>
                  {item.status === 'complete' && item.invoiceId && (
                    <button
                      onClick={() => navigate(`/invoice/${item.invoiceId}`)}
                      style={styles.queueViewBtn}
                    >
                      View
                    </button>
                  )}
                  {(item.status === 'complete' || item.status === 'error') && (
                    <button
                      onClick={() => removeFromQueue(item.id)}
                      style={styles.queueRemoveBtn}
                    >
                      ×
                    </button>
                  )}
                  {(item.status === 'uploading' || item.status === 'processing') && (
                    <div style={styles.queueSpinner}></div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {pages.length === 0 ? (
        // Initial drop zone
        <div
          style={{
            ...styles.dropzone,
            ...(isDragging ? styles.dropzoneActive : {}),
          }}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div style={styles.uploadPrompt}>
            <div style={styles.uploadIcon}>📄</div>
            <p>Drag and drop invoice images</p>
            <p style={styles.subtext}>or click to select files</p>
            <p style={styles.formats}>Supports: JPG, PNG, WebP, HEIC, PDF</p>
            <p style={styles.multiPageHint}>
              Add multiple images for multi-page invoices
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>
      ) : (
        // Pages preview
        <div style={styles.pagesContainer}>
          <div style={styles.pagesHeader}>
            <h3>{pages.length} Page{pages.length !== 1 ? 's' : ''} Ready</h3>
            <div style={styles.headerActions}>
              <button
                onClick={() => addMoreInputRef.current?.click()}
                style={styles.addMoreBtn}
                disabled={isWorking}
              >
                + Add More Pages
              </button>
              <button
                onClick={clearAll}
                style={styles.clearBtn}
                disabled={isWorking}
              >
                Clear All
              </button>
            </div>
            <input
              ref={addMoreInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </div>

          <div style={styles.pagesGrid}>
            {pages.map((page, idx) => (
              <div key={page.id} style={styles.pageCard}>
                <div style={styles.pageNumber}>Page {idx + 1}</div>
                <img src={page.preview} alt={`Page ${idx + 1}`} style={styles.pagePreview} />
                <div style={styles.pageActions}>
                  <button
                    onClick={() => movePage(page.id, 'up')}
                    disabled={idx === 0 || isWorking}
                    style={styles.moveBtn}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => movePage(page.id, 'down')}
                    disabled={idx === pages.length - 1 || isWorking}
                    style={styles.moveBtn}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => removePage(page.id)}
                    disabled={isWorking}
                    style={styles.removeBtn}
                    title="Remove page"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>

          {(processing || uploading) && (
            <div style={styles.processingOverlay}>
              <div style={styles.spinner}></div>
              <p>{status || 'Processing...'}</p>
            </div>
          )}

          <button
            onClick={processAndUpload}
            disabled={isWorking}
            style={{
              ...styles.uploadBtn,
              ...(isWorking ? styles.uploadBtnDisabled : {}),
            }}
          >
            {isWorking ? status || 'Processing...' : `Create PDF & Upload (${pages.length} page${pages.length !== 1 ? 's' : ''})`}
          </button>
        </div>
      )}

      <div style={styles.cameraSection}>
        <p><strong>Take photos with camera:</strong></p>
        <p style={styles.cameraHint}>
          For multi-page invoices, take each page separately then click "Add More Pages"
        </p>
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileSelect}
          style={styles.cameraInput}
        />
      </div>

      <div style={styles.infoSection}>
        <h4>How it works:</h4>
        <ol style={styles.infoList}>
          <li>Add one or more invoice page images</li>
          <li>Reorder pages if needed using the arrows</li>
          <li>Click "Create PDF & Upload" to combine and process</li>
          <li>Images are compressed to save space while maintaining OCR quality</li>
        </ol>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  title: {
    marginBottom: '1.5rem',
    color: '#1a1a2e',
  },
  error: {
    background: '#fee',
    color: '#c00',
    padding: '1rem',
    borderRadius: '8px',
    marginBottom: '1rem',
  },
  dropzone: {
    background: 'white',
    border: '3px dashed #ddd',
    borderRadius: '12px',
    padding: '3rem',
    textAlign: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s',
    minHeight: '300px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropzoneActive: {
    borderColor: '#e94560',
    background: '#fff5f7',
  },
  uploadPrompt: {
    color: '#666',
  },
  uploadIcon: {
    fontSize: '4rem',
    marginBottom: '1rem',
  },
  subtext: {
    color: '#999',
    fontSize: '0.9rem',
    marginTop: '0.5rem',
  },
  formats: {
    marginTop: '1rem',
    fontSize: '0.8rem',
    color: '#999',
  },
  multiPageHint: {
    marginTop: '1.5rem',
    padding: '0.5rem 1rem',
    background: '#e8f4fd',
    borderRadius: '6px',
    fontSize: '0.85rem',
    color: '#0066cc',
  },
  pagesContainer: {
    background: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    position: 'relative',
  },
  pagesHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  headerActions: {
    display: 'flex',
    gap: '0.5rem',
  },
  addMoreBtn: {
    padding: '0.5rem 1rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  clearBtn: {
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    color: '#666',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  pagesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: '1rem',
    marginBottom: '1.5rem',
  },
  pageCard: {
    background: '#f8f9fa',
    borderRadius: '8px',
    padding: '0.5rem',
    position: 'relative',
  },
  pageNumber: {
    position: 'absolute',
    top: '0.75rem',
    left: '0.75rem',
    background: 'rgba(0,0,0,0.7)',
    color: 'white',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: 'bold',
  },
  pagePreview: {
    width: '100%',
    height: '180px',
    objectFit: 'cover',
    borderRadius: '6px',
  },
  pageActions: {
    display: 'flex',
    justifyContent: 'center',
    gap: '0.5rem',
    marginTop: '0.5rem',
  },
  moveBtn: {
    width: '32px',
    height: '32px',
    background: '#f0f0f0',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  removeBtn: {
    width: '32px',
    height: '32px',
    background: '#fee',
    border: '1px solid #fcc',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '1.2rem',
    color: '#c00',
  },
  processingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(255,255,255,0.9)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '12px',
    zIndex: 10,
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid #ddd',
    borderTopColor: '#e94560',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    marginBottom: '1rem',
  },
  uploadBtn: {
    width: '100%',
    padding: '1rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: 'bold',
  },
  uploadBtnDisabled: {
    background: '#999',
    cursor: 'wait',
  },
  cameraSection: {
    marginTop: '2rem',
    padding: '1.5rem',
    background: 'white',
    borderRadius: '12px',
    textAlign: 'center',
  },
  cameraHint: {
    fontSize: '0.85rem',
    color: '#666',
    marginTop: '0.5rem',
    marginBottom: '1rem',
  },
  cameraInput: {
    marginTop: '0.5rem',
  },
  infoSection: {
    marginTop: '1.5rem',
    padding: '1.5rem',
    background: '#f8f9fa',
    borderRadius: '12px',
  },
  infoList: {
    margin: '0.5rem 0 0 1.5rem',
    color: '#666',
    lineHeight: '1.8',
  },
  queueSection: {
    background: 'white',
    borderRadius: '12px',
    padding: '1rem 1.5rem',
    marginBottom: '1.5rem',
  },
  queueHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.75rem',
  },
  queueTitle: {
    margin: 0,
    fontSize: '1rem',
    color: '#1a1a2e',
  },
  clearQueueBtn: {
    padding: '0.35rem 0.75rem',
    background: '#f0f0f0',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    color: '#666',
  },
  queueList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  queueItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
    borderLeft: '4px solid #0066cc',
  },
  queueItemComplete: {
    borderLeftColor: '#28a745',
    background: '#f0fff4',
  },
  queueItemError: {
    borderLeftColor: '#dc3545',
    background: '#fff5f5',
  },
  queueItemInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  queueItemName: {
    fontWeight: '500',
    fontSize: '0.9rem',
  },
  queueItemStatus: {
    fontSize: '0.8rem',
  },
  queueItemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  queueViewBtn: {
    padding: '0.35rem 0.75rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  queueRemoveBtn: {
    width: '24px',
    height: '24px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: '1.2rem',
    color: '#999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueSpinner: {
    width: '20px',
    height: '20px',
    border: '2px solid #ddd',
    borderTopColor: '#0066cc',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
}
