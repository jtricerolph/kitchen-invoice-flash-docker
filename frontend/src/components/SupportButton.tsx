import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import html2canvas from 'html2canvas'
import { useAuth } from '../App'

interface SupportEnabledResponse {
  enabled: boolean
}

export default function SupportButton() {
  const { token } = useAuth()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)

  // Check if support is enabled
  const { data: supportStatus } = useQuery<SupportEnabledResponse>({
    queryKey: ['support-enabled'],
    queryFn: async () => {
      const res = await fetch('/api/support/enabled', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return { enabled: false }
      return res.json()
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  })

  // Submit support request
  const submitMutation = useMutation({
    mutationFn: async (data: { description: string; screenshot: string }) => {
      const res = await fetch('/api/support/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          description: data.description,
          screenshot: data.screenshot,
          page_url: window.location.href,
          browser_info: navigator.userAgent,
        }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to submit request')
      }
      return res.json()
    },
    onSuccess: () => {
      setIsModalOpen(false)
      setDescription('')
      setScreenshot(null)
      alert('Support request sent successfully!')
    },
    onError: (error: Error) => {
      alert(`Failed to send: ${error.message}`)
    },
  })

  // Capture screenshot when modal opens
  const captureScreenshot = async () => {
    setIsCapturing(true)
    try {
      // Small delay to ensure modal is hidden
      await new Promise(resolve => setTimeout(resolve, 100))

      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#f0f2f5',
        scale: 1, // Lower scale to reduce file size
        logging: false,
        ignoreElements: (element: Element) => {
          // Ignore the support button and modal
          return element.classList.contains('support-button-container') ||
                 element.classList.contains('support-modal-overlay')
        },
      } as Parameters<typeof html2canvas>[1])

      const dataUrl = canvas.toDataURL('image/png', 0.8)
      setScreenshot(dataUrl)
    } catch (error) {
      console.error('Failed to capture screenshot:', error)
    } finally {
      setIsCapturing(false)
    }
  }

  const handleOpenModal = () => {
    setIsModalOpen(true)
  }

  // Capture screenshot after modal state updates
  useEffect(() => {
    if (isModalOpen && !screenshot && !isCapturing) {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        captureScreenshot()
      })
    }
  }, [isModalOpen])

  const handleSubmit = () => {
    if (!description.trim()) {
      alert('Please describe the issue')
      return
    }
    if (!screenshot) {
      alert('Screenshot not ready, please wait')
      return
    }
    submitMutation.mutate({ description, screenshot })
  }

  const handleClose = () => {
    setIsModalOpen(false)
    setDescription('')
    setScreenshot(null)
  }

  // Don't render if support is not enabled
  if (!supportStatus?.enabled) {
    return null
  }

  return (
    <>
      {/* Floating button */}
      <div className="support-button-container" style={styles.buttonContainer}>
        <button
          onClick={handleOpenModal}
          style={styles.floatingButton}
          title="Report an issue"
        >
          ?
        </button>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="support-modal-overlay" style={styles.overlay}>
          <div style={styles.modal}>
            <div style={styles.header}>
              <h3 style={styles.title}>Report an Issue</h3>
              <button onClick={handleClose} style={styles.closeButton}>
                X
              </button>
            </div>

            <div style={styles.content}>
              {/* Screenshot preview */}
              <div style={styles.screenshotSection}>
                <label style={styles.label}>Page Screenshot</label>
                {isCapturing ? (
                  <div style={styles.screenshotPlaceholder}>
                    Capturing screenshot...
                  </div>
                ) : screenshot ? (
                  <img
                    src={screenshot}
                    alt="Page screenshot"
                    style={styles.screenshotPreview}
                  />
                ) : (
                  <div style={styles.screenshotPlaceholder}>
                    Screenshot failed - please try again
                  </div>
                )}
              </div>

              {/* Description field */}
              <div style={styles.field}>
                <label style={styles.label}>Describe the issue *</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What went wrong? What were you trying to do?"
                  style={styles.textarea}
                  rows={4}
                />
              </div>

              <p style={styles.hint}>
                This will send the screenshot and your description to the support team.
              </p>
            </div>

            <div style={styles.footer}>
              <button onClick={handleClose} style={styles.cancelButton}>
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                style={styles.submitButton}
                disabled={submitMutation.isPending || !screenshot || !description.trim()}
              >
                {submitMutation.isPending ? 'Sending...' : 'Send Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  buttonContainer: {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: 9998,
  },
  floatingButton: {
    width: '50px',
    height: '50px',
    borderRadius: '50%',
    background: '#e94560',
    color: 'white',
    border: 'none',
    fontSize: '1.5rem',
    fontWeight: 'bold',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(233, 69, 96, 0.4)',
    transition: 'transform 0.2s, box-shadow 0.2s',
  },
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '600px',
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 1.5rem',
    borderBottom: '1px solid #eee',
  },
  title: {
    margin: 0,
    color: '#1a1a2e',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '1.2rem',
    cursor: 'pointer',
    color: '#666',
    padding: '0.5rem',
  },
  content: {
    padding: '1.5rem',
  },
  screenshotSection: {
    marginBottom: '1.5rem',
  },
  label: {
    display: 'block',
    fontWeight: '600',
    marginBottom: '0.5rem',
    color: '#333',
  },
  screenshotPreview: {
    width: '100%',
    maxHeight: '200px',
    objectFit: 'contain',
    border: '1px solid #ddd',
    borderRadius: '6px',
    background: '#f5f5f5',
  },
  screenshotPlaceholder: {
    width: '100%',
    height: '150px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: '6px',
    color: '#666',
  },
  field: {
    marginBottom: '1rem',
  },
  textarea: {
    width: '100%',
    padding: '0.75rem',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '1rem',
    resize: 'vertical',
    fontFamily: 'inherit',
  },
  hint: {
    fontSize: '0.85rem',
    color: '#666',
    margin: 0,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    padding: '1rem 1.5rem',
    borderTop: '1px solid #eee',
  },
  cancelButton: {
    padding: '0.75rem 1.5rem',
    background: '#f0f0f0',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  submitButton: {
    padding: '0.75rem 1.5rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: '600',
  },
}
