import { useState, useRef } from 'react'
import { useAuth } from '../App'
import { PDFDocument } from 'pdf-lib'
import imageCompression from 'browser-image-compression'

interface QueueItem {
  id: string
  status: 'compressing' | 'uploading' | 'processing' | 'complete' | 'error'
  preview?: string
  error?: string
}

export default function UploadApp() {
  const { token, user, login, logout } = useAuth()
  const cameraRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Mini login state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // Upload state
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [captures, setCaptures] = useState<{ id: string; file: File; preview: string }[]>([])


  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError('')
    setLoginLoading(true)
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Login failed')
      }
      const data = await res.json()
      login(data.access_token)
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoginLoading(false)
    }
  }

  if (!token || !user) {
    return (
      <div style={styles.container}>
        <div style={styles.loginCard}>
          <h1 style={styles.brand}>Invoice Upload</h1>
          <p style={styles.subtitle}>Sign in to upload invoices</p>
          {loginError && <div style={styles.error}>{loginError}</div>}
          <form onSubmit={handleLogin} style={styles.form}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={styles.input}
              required
              autoFocus
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={styles.input}
              required
            />
            <button type="submit" style={styles.loginBtn} disabled={loginLoading}>
              {loginLoading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  const generateId = () => Math.random().toString(36).substr(2, 9)

  const handleCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return
    const files = Array.from(e.target.files)

    for (const file of files) {
      if (file.type === 'application/pdf') {
        // PDF: upload directly
        uploadFile(file)
        continue
      }
      if (!file.type.startsWith('image/')) continue

      const preview = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = (ev) => resolve(ev.target?.result as string)
        reader.readAsDataURL(file)
      })

      setCaptures(prev => [...prev, { id: generateId(), file, preview }])
    }
    e.target.value = ''
  }

  const removeCapture = (id: string) => {
    setCaptures(prev => prev.filter(c => c.id !== id))
  }

  const uploadFile = async (file: File) => {
    const queueId = generateId()
    setQueue(prev => [...prev, { id: queueId, status: 'uploading' }])

    try {
      const formData = new FormData()
      formData.append('file', file)

      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: 'processing' as const } : q
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

      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: 'complete' as const } : q
      ))

      // Auto-remove completed after 3 seconds
      setTimeout(() => {
        setQueue(prev => prev.filter(q => q.id !== queueId))
      }, 3000)
    } catch (err) {
      setQueue(prev => prev.map(q =>
        q.id === queueId ? {
          ...q,
          status: 'error' as const,
          error: err instanceof Error ? err.message : 'Upload failed',
        } : q
      ))
    }
  }

  const processAndUpload = async () => {
    if (captures.length === 0) return

    const queueId = generateId()
    const preview = captures[0]?.preview
    const pageCount = captures.length

    setQueue(prev => [...prev, { id: queueId, status: 'compressing', preview }])
    setCaptures([])

    try {
      // Compress images
      const compressed: { data: ArrayBuffer; width: number; height: number }[] = []
      for (const cap of captures) {
        const blob = await imageCompression(cap.file, {
          maxSizeMB: 1,
          maxWidthOrHeight: 2000,
          useWebWorker: true,
          fileType: 'image/jpeg' as const,
          initialQuality: 0.85,
        })
        const img = new Image()
        const url = URL.createObjectURL(blob)
        await new Promise<void>((resolve) => {
          img.onload = () => { URL.revokeObjectURL(url); resolve() }
          img.src = url
        })
        compressed.push({ data: await blob.arrayBuffer(), width: img.width, height: img.height })
      }

      // Create PDF
      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: 'uploading' as const } : q
      ))

      const pdfDoc = await PDFDocument.create()
      for (const { data, width, height } of compressed) {
        const jpegImage = await pdfDoc.embedJpg(data)
        const page = pdfDoc.addPage([width, height])
        page.drawImage(jpegImage, { x: 0, y: 0, width, height })
      }
      const pdfBytes = await pdfDoc.save()
      const pdfFile = new File(
        [new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })],
        `invoice-${pageCount}pages.pdf`,
        { type: 'application/pdf' }
      )

      // Upload
      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: 'processing' as const } : q
      ))

      const formData = new FormData()
      formData.append('file', pdfFile)
      const res = await fetch('/api/invoices/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Upload failed')
      }

      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: 'complete' as const } : q
      ))
      setTimeout(() => {
        setQueue(prev => prev.filter(q => q.id !== queueId))
      }, 3000)
    } catch (err) {
      setQueue(prev => prev.map(q =>
        q.id === queueId ? {
          ...q,
          status: 'error' as const,
          error: err instanceof Error ? err.message : 'Failed',
        } : q
      ))
    }
  }

  const isWorking = queue.some(q => q.status === 'compressing' || q.status === 'uploading' || q.status === 'processing')

  return (
    <div style={styles.container}>
      <div style={styles.app}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <div style={styles.brandSmall}>Invoice Upload</div>
            <div style={styles.kitchenName}>{user.kitchen_name}</div>
          </div>
          <button onClick={logout} style={styles.logoutBtn}>Sign Out</button>
        </div>

        {/* Queue status */}
        {queue.length > 0 && (
          <div style={styles.queueArea}>
            {queue.map(q => (
              <div key={q.id} style={{
                ...styles.queueItem,
                borderLeftColor: q.status === 'complete' ? '#4caf50'
                  : q.status === 'error' ? '#f44336' : '#2196f3',
              }}>
                <span style={styles.queueText}>
                  {q.status === 'compressing' && 'Compressing...'}
                  {q.status === 'uploading' && 'Uploading...'}
                  {q.status === 'processing' && 'Processing OCR...'}
                  {q.status === 'complete' && 'Uploaded successfully'}
                  {q.status === 'error' && (q.error || 'Upload failed')}
                </span>
                {(q.status === 'compressing' || q.status === 'uploading' || q.status === 'processing') && (
                  <div style={styles.spinner} />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Main area */}
        {captures.length === 0 ? (
          <div style={styles.captureArea}>
            <button
              onClick={() => cameraRef.current?.click()}
              style={styles.cameraBtn}
              disabled={isWorking}
            >
              <span style={styles.cameraIcon}>📷</span>
              <span>Take Photo</span>
            </button>

            <button
              onClick={() => fileRef.current?.click()}
              style={styles.fileBtn}
              disabled={isWorking}
            >
              Choose File / PDF
            </button>

            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleCapture}
              style={{ display: 'none' }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              onChange={handleCapture}
              style={{ display: 'none' }}
            />
          </div>
        ) : (
          <div style={styles.reviewArea}>
            {/* Preview grid */}
            <div style={styles.previewGrid}>
              {captures.map((cap, idx) => (
                <div key={cap.id} style={styles.previewCard}>
                  <img src={cap.preview} alt={`Page ${idx + 1}`} style={styles.previewImg} />
                  <button
                    onClick={() => removeCapture(cap.id)}
                    style={styles.removeBtn}
                    disabled={isWorking}
                  >
                    ×
                  </button>
                  <div style={styles.pageLabel}>Page {idx + 1}</div>
                </div>
              ))}
              {/* Add Page card in grid */}
              <button
                onClick={() => cameraRef.current?.click()}
                style={styles.addPageCard}
                disabled={isWorking}
              >
                <span style={{ fontSize: '2.5rem' }}>📷</span>
                <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>Add Page</span>
              </button>
            </div>

            {/* Actions */}
            <div style={styles.actionBar}>
              <button
                onClick={() => setCaptures([])}
                style={styles.clearBtn}
                disabled={isWorking}
              >
                Clear All
              </button>
            </div>

            <button
              onClick={processAndUpload}
              style={{
                ...styles.uploadBtn,
                ...(isWorking ? { opacity: 0.6, cursor: 'wait' } : {}),
              }}
              disabled={isWorking}
            >
              {isWorking ? 'Processing...' : `Upload ${captures.length} Page${captures.length !== 1 ? 's' : ''}`}
            </button>

            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleCapture}
              style={{ display: 'none' }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              onChange={handleCapture}
              style={{ display: 'none' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: '#1a1a2e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  app: {
    width: '100%',
    maxWidth: '500px',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#16213e',
    overflow: 'auto',
  },
  // Login
  loginCard: {
    background: 'white',
    padding: '2rem',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '360px',
    textAlign: 'center',
  },
  brand: {
    color: '#1a1a2e',
    marginBottom: '0.25rem',
    fontSize: '1.4rem',
  },
  subtitle: {
    color: '#666',
    marginBottom: '1.5rem',
    fontSize: '0.9rem',
  },
  error: {
    background: '#fee',
    color: '#c00',
    padding: '0.6rem',
    borderRadius: '6px',
    marginBottom: '1rem',
    fontSize: '0.85rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  input: {
    padding: '0.75rem 1rem',
    borderRadius: '8px',
    border: '1px solid #ddd',
    fontSize: '1rem',
    outline: 'none',
  },
  loginBtn: {
    padding: '0.75rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    background: '#1a1a2e',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },
  brandSmall: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: '1rem',
  },
  kitchenName: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: '0.75rem',
  },
  logoutBtn: {
    padding: '0.4rem 0.75rem',
    background: 'rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.7)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '6px',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  // Queue
  queueArea: {
    padding: '0.5rem 1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  },
  queueItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.6rem 0.75rem',
    background: 'rgba(255,255,255,0.05)',
    borderRadius: '8px',
    borderLeft: '3px solid #2196f3',
  },
  queueText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: '0.85rem',
  },
  spinner: {
    width: '16px',
    height: '16px',
    border: '2px solid rgba(255,255,255,0.2)',
    borderTopColor: 'white',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  // Capture area (no images yet)
  captureArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1.5rem',
    padding: '2rem',
  },
  cameraBtn: {
    width: '200px',
    height: '200px',
    borderRadius: '50%',
    background: '#e94560',
    border: 'none',
    color: 'white',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    fontSize: '1.2rem',
    fontWeight: 'bold',
    boxShadow: '0 8px 32px rgba(233,69,96,0.4)',
  },
  cameraIcon: {
    fontSize: '3rem',
  },
  fileBtn: {
    padding: '0.75rem 2rem',
    background: 'transparent',
    border: '2px solid rgba(255,255,255,0.3)',
    borderRadius: '8px',
    color: 'rgba(255,255,255,0.7)',
    fontSize: '1rem',
    cursor: 'pointer',
  },
  // Review area (has images)
  reviewArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '1rem',
    gap: '1rem',
    overflow: 'auto',
  },
  previewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: '0.75rem',
    alignContent: 'start',
  },
  previewCard: {
    position: 'relative',
    borderRadius: '8px',
    overflow: 'hidden',
    background: '#0f0f23',
    height: '180px',
  },
  previewImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  addPageCard: {
    height: '180px',
    borderRadius: '8px',
    border: '2px dashed rgba(255,255,255,0.25)',
    background: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.7)',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
  },
  removeBtn: {
    position: 'absolute',
    top: '4px',
    right: '4px',
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.6)',
    color: 'white',
    border: 'none',
    fontSize: '1.2rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageLabel: {
    position: 'absolute',
    bottom: '4px',
    left: '4px',
    background: 'rgba(0,0,0,0.6)',
    color: 'white',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: 'bold',
  },
  actionBar: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  clearBtn: {
    padding: '0.5rem 1rem',
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    color: 'rgba(255,255,255,0.5)',
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  uploadBtn: {
    padding: '1rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '10px',
    fontSize: '1.1rem',
    fontWeight: 'bold',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(233,69,96,0.3)',
  },
}
