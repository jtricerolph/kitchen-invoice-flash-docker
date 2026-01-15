import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

export default function Upload() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    const isImage = file.type.startsWith('image/')
    const isPDF = file.type === 'application/pdf'
    if (!isImage && !isPDF) {
      setError('Please upload an image or PDF file')
      return
    }

    // Show preview for images, PDF icon for PDFs
    if (isImage) {
      const reader = new FileReader()
      reader.onload = (e) => setPreview(e.target?.result as string)
      reader.readAsDataURL(file)
    } else {
      setPreview('pdf')  // Special marker for PDF
    }

    // Upload
    setUploading(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/invoices/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Upload failed')
      }

      await res.json()
      navigate('/invoices')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setPreview(null)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div>
      <h2 style={styles.title}>Upload Invoice</h2>

      {error && <div style={styles.error}>{error}</div>}

      <div
        style={{
          ...styles.dropzone,
          ...(isDragging ? styles.dropzoneActive : {}),
          ...(uploading ? styles.dropzoneUploading : {}),
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
      >
        {preview ? (
          preview === 'pdf' ? (
            <div style={styles.pdfPreview}>
              <div style={styles.pdfIcon}>📄</div>
              <p>PDF ready to upload</p>
            </div>
          ) : (
            <img src={preview} alt="Preview" style={styles.preview} />
          )
        ) : uploading ? (
          <div style={styles.uploadingText}>
            <div style={styles.spinner}></div>
            <p>Processing invoice...</p>
            <p style={styles.subtext}>Running OCR extraction</p>
          </div>
        ) : (
          <div style={styles.uploadPrompt}>
            <div style={styles.uploadIcon}>📄</div>
            <p>Drag and drop an invoice image</p>
            <p style={styles.subtext}>or click to select a file</p>
            <p style={styles.formats}>Supports: JPG, PNG, WebP, HEIC, PDF</p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      <div style={styles.cameraSection}>
        <p>Or take a photo:</p>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileSelect}
          style={styles.cameraInput}
        />
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
  dropzoneUploading: {
    cursor: 'wait',
    opacity: 0.8,
  },
  preview: {
    maxWidth: '100%',
    maxHeight: '400px',
    borderRadius: '8px',
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
  uploadingText: {
    color: '#1a1a2e',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid #ddd',
    borderTopColor: '#e94560',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    margin: '0 auto 1rem',
  },
  cameraSection: {
    marginTop: '2rem',
    padding: '1.5rem',
    background: 'white',
    borderRadius: '12px',
    textAlign: 'center',
  },
  cameraInput: {
    marginTop: '1rem',
  },
  pdfPreview: {
    textAlign: 'center',
    color: '#1a1a2e',
  },
  pdfIcon: {
    fontSize: '4rem',
    marginBottom: '0.5rem',
  },
}
