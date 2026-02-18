import { useState, useEffect } from 'react'
import { useAuth } from '../App'
import KDS from './KDS'

export default function KDSApp() {
  const { token, user, login } = useAuth()

  // Mini login state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // Override viewport for mobile-friendly layout and swap manifest for PWA install
  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]')
    const originalViewport = viewport?.getAttribute('content') || ''
    if (viewport) {
      viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    }
    const link = document.querySelector('link[rel="manifest"]')
    const originalManifest = link?.getAttribute('href') || ''
    if (link) {
      link.setAttribute('href', '/kds-manifest.json')
    }
    document.title = 'Kitchen Display System'
    return () => {
      if (viewport && originalViewport) viewport.setAttribute('content', originalViewport)
      if (link && originalManifest) link.setAttribute('href', originalManifest)
      document.title = 'Kitchen Invoice Flash'
    }
  }, [])

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
          <h1 style={styles.brand}>Kitchen Display</h1>
          <p style={styles.subtitle}>Sign in to access KDS</p>
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

  return <KDS />
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
}
