import { useState, useRef, useEffect, useCallback, CSSProperties } from 'react'

interface Props {
  imageFile: File
  onCropped: (croppedFile: File) => void
  onCancel: () => void
}

export default function ImageCropModal({ imageFile, onCropped, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [rotation, setRotation] = useState(0) // 0, 90, 180, 270

  // Load image
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      setImgLoaded(true)
    }
    img.src = URL.createObjectURL(imageFile)
    return () => URL.revokeObjectURL(img.src)
  }, [imageFile])

  // Recalculate canvas size when image loads or rotation changes
  useEffect(() => {
    const img = imgRef.current
    if (!img || !imgLoaded) return
    const isRotated = rotation === 90 || rotation === 270
    const srcW = isRotated ? img.height : img.width
    const srcH = isRotated ? img.width : img.height
    const maxW = 700, maxH = 500
    const scale = Math.min(maxW / srcW, maxH / srcH, 1)
    setCanvasSize({ width: srcW * scale, height: srcH * scale })
    setRect(null)
  }, [imgLoaded, rotation])

  // Draw rotated image onto canvas
  const drawRotatedImage = useCallback((ctx: CanvasRenderingContext2D, img: HTMLImageElement, cw: number, ch: number) => {
    ctx.save()
    ctx.translate(cw / 2, ch / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    const isRotated = rotation === 90 || rotation === 270
    const dw = isRotated ? ch : cw
    const dh = isRotated ? cw : ch
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
    ctx.restore()
  }, [rotation])

  // Draw canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawRotatedImage(ctx, img, canvas.width, canvas.height)

    if (rect) {
      // Darken outside selection
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // Clear selection area
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h)
      drawRotatedImage(ctx, img, canvas.width, canvas.height)
      // Draw border
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.setLineDash([])
      // Re-apply overlay outside
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      // Top
      ctx.fillRect(0, 0, canvas.width, rect.y)
      // Bottom
      ctx.fillRect(0, rect.y + rect.h, canvas.width, canvas.height - rect.y - rect.h)
      // Left
      ctx.fillRect(0, rect.y, rect.x, rect.h)
      // Right
      ctx.fillRect(rect.x + rect.w, rect.y, canvas.width - rect.x - rect.w, rect.h)
    }
  }, [rect, drawRotatedImage])

  useEffect(() => {
    if (imgLoaded && canvasSize.width > 0) drawCanvas()
  }, [imgLoaded, drawCanvas, canvasSize])

  const getCanvasPos = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const bounds = canvas.getBoundingClientRect()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    return {
      x: clientX - bounds.left,
      y: clientY - bounds.top,
    }
  }

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    const pos = getCanvasPos(e)
    setStartPos(pos)
    setRect(null)
    setDrawing(true)
  }

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing || !startPos) return
    e.preventDefault()
    const pos = getCanvasPos(e)
    setRect({
      x: Math.min(startPos.x, pos.x),
      y: Math.min(startPos.y, pos.y),
      w: Math.abs(pos.x - startPos.x),
      h: Math.abs(pos.y - startPos.y),
    })
  }

  const handlePointerUp = () => {
    setDrawing(false)
  }

  const handleRotate = () => {
    setRotation(prev => (prev + 90) % 360)
  }

  const handleCrop = () => {
    const img = imgRef.current
    if (!img || !rect || rect.w < 10 || rect.h < 10) return

    const isRotated = rotation === 90 || rotation === 270
    const fullW = isRotated ? img.height : img.width
    const fullH = isRotated ? img.width : img.height

    // Scale rect back to original (rotated) image coordinates
    const scaleX = fullW / canvasSize.width
    const scaleY = fullH / canvasSize.height
    const sx = rect.x * scaleX
    const sy = rect.y * scaleY
    const sw = rect.w * scaleX
    const sh = rect.h * scaleY

    // First render the full rotated image, then crop from it
    const fullCanvas = document.createElement('canvas')
    fullCanvas.width = fullW
    fullCanvas.height = fullH
    const fCtx = fullCanvas.getContext('2d')!
    fCtx.translate(fullW / 2, fullH / 2)
    fCtx.rotate((rotation * Math.PI) / 180)
    const dw = isRotated ? fullH : fullW
    const dh = isRotated ? fullW : fullH
    fCtx.drawImage(img, -dw / 2, -dh / 2, dw, dh)

    // Now crop from the rotated full image
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = sw
    cropCanvas.height = sh
    const ctx = cropCanvas.getContext('2d')!
    ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh)

    cropCanvas.toBlob((blob) => {
      if (blob) {
        const croppedFile = new File([blob], imageFile.name, { type: 'image/jpeg' })
        onCropped(croppedFile)
      }
    }, 'image/jpeg', 0.92)
  }

  const handleSkip = () => {
    if (rotation === 0) {
      onCropped(imageFile)
      return
    }
    // Export full rotated image
    const img = imgRef.current
    if (!img) { onCropped(imageFile); return }
    const isRotated = rotation === 90 || rotation === 270
    const fullW = isRotated ? img.height : img.width
    const fullH = isRotated ? img.width : img.height
    const fullCanvas = document.createElement('canvas')
    fullCanvas.width = fullW
    fullCanvas.height = fullH
    const fCtx = fullCanvas.getContext('2d')!
    fCtx.translate(fullW / 2, fullH / 2)
    fCtx.rotate((rotation * Math.PI) / 180)
    const dw = isRotated ? fullH : fullW
    const dh = isRotated ? fullW : fullH
    fCtx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
    fullCanvas.toBlob((blob) => {
      if (blob) {
        onCropped(new File([blob], imageFile.name, { type: 'image/jpeg' }))
      }
    }, 'image/jpeg', 0.92)
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Select Ingredients Area</h3>
          <button onClick={onCancel} style={styles.closeBtn}>{'\u2715'}</button>
        </div>
        <div style={{ padding: '0.5rem', fontSize: '0.8rem', color: '#666', textAlign: 'center' as const, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}>
          <span>Draw a rectangle around the ingredients list</span>
          <button onClick={handleRotate} style={styles.rotateBtn} title="Rotate 90°">
            {'\u21BB'} Rotate
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0.5rem', background: '#f0f0f0' }}>
          {imgLoaded ? (
            <canvas
              ref={canvasRef}
              width={canvasSize.width}
              height={canvasSize.height}
              style={{ cursor: 'crosshair', touchAction: 'none', borderRadius: '4px' }}
              onMouseDown={handlePointerDown}
              onMouseMove={handlePointerMove}
              onMouseUp={handlePointerUp}
              onMouseLeave={handlePointerUp}
              onTouchStart={handlePointerDown}
              onTouchMove={handlePointerMove}
              onTouchEnd={handlePointerUp}
            />
          ) : (
            <div style={{ padding: '2rem', color: '#888' }}>Loading image...</div>
          )}
        </div>
        <div style={styles.footer}>
          <button onClick={handleSkip} style={styles.skipBtn}>
            Use Full Image
          </button>
          <button
            onClick={handleCrop}
            disabled={!rect || rect.w < 10 || rect.h < 10}
            style={{
              ...styles.cropBtn,
              opacity: rect && rect.w >= 10 && rect.h >= 10 ? 1 : 0.4,
              cursor: rect && rect.w >= 10 && rect.h >= 10 ? 'pointer' : 'default',
            }}
          >
            Crop & Scan
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 },
  modal: { background: 'white', borderRadius: '10px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: '1px solid #eee' },
  closeBtn: { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#888' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '0.75rem 1rem', borderTop: '1px solid #eee' },
  skipBtn: { padding: '0.5rem 1rem', background: '#f0f0f0', color: '#333', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem' },
  cropBtn: { padding: '0.5rem 1rem', background: '#6366f1', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 600, fontSize: '0.85rem' },
  rotateBtn: { padding: '0.3rem 0.6rem', background: 'white', color: '#555', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' as const },
}
