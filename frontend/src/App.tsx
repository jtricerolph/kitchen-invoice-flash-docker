import { Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect, createContext, useContext } from 'react'
import Login from './pages/Login'
import Settings from './pages/Settings'
import Dashboard from './components/Dashboard'
import Upload from './components/Upload'
import InvoiceList from './components/InvoiceList'
import Review from './components/Review'
import Suppliers from './components/Suppliers'
import Purchases from './components/Purchases'

interface User {
  id: number
  email: string
  name: string | null
  kitchen_id: number
  kitchen_name: string
  is_admin: boolean
}

interface AuthContextType {
  user: User | null
  token: string | null
  login: (token: string) => void
  logout: () => void
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  login: () => {},
  logout: () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

function App() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem('token')
  )
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    if (token) {
      fetch('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => {
          if (res.ok) return res.json()
          throw new Error('Unauthorized')
        })
        .then(setUser)
        .catch(() => {
          localStorage.removeItem('token')
          setToken(null)
        })
    }
  }, [token])

  const login = (newToken: string) => {
    localStorage.setItem('token', newToken)
    setToken(newToken)
  }

  const logout = () => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      <div style={styles.app}>
        {token && user && <Header user={user} onLogout={logout} />}
        <main style={styles.main}>
          <Routes>
            <Route
              path="/login"
              element={token ? <Navigate to="/" /> : <Login />}
            />
            <Route
              path="/"
              element={
                token ? <Dashboard /> : <Navigate to="/login" />
              }
            />
            <Route
              path="/upload"
              element={
                token ? <Upload /> : <Navigate to="/login" />
              }
            />
            <Route
              path="/invoices"
              element={
                token ? <InvoiceList /> : <Navigate to="/login" />
              }
            />
            <Route
              path="/invoice/:id"
              element={
                token ? <Review /> : <Navigate to="/login" />
              }
            />
            <Route
              path="/settings"
              element={
                token ? <Settings /> : <Navigate to="/login" />
              }
            />
            <Route
              path="/suppliers"
              element={
                token ? <Suppliers /> : <Navigate to="/login" />
              }
            />
            <Route
              path="/purchases"
              element={
                token ? <Purchases /> : <Navigate to="/login" />
              }
            />
          </Routes>
        </main>
      </div>
    </AuthContext.Provider>
  )
}

function Header({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [reportsOpen, setReportsOpen] = useState(false)

  return (
    <header style={styles.header}>
      <div style={styles.headerContent}>
        <h1 style={styles.logo}>Kitchen Invoice Flash</h1>
        <nav style={styles.nav}>
          <a href="/" style={styles.navLink}>Dashboard</a>
          <a href="/upload" style={styles.navLink}>Upload</a>
          <a href="/invoices" style={styles.navLink}>Invoices</a>
          <div
            style={styles.dropdownContainer}
            onMouseEnter={() => setReportsOpen(true)}
            onMouseLeave={() => setReportsOpen(false)}
          >
            <span style={styles.navLink}>Reports ▾</span>
            {reportsOpen && (
              <div style={styles.dropdown}>
                <a href="/purchases" style={styles.dropdownLink}>Weekly Purchases</a>
              </div>
            )}
          </div>
          <a href="/suppliers" style={styles.navLink}>Suppliers</a>
          <a href="/settings" style={styles.navLink}>Settings</a>
        </nav>
        <div style={styles.userInfo}>
          <span>{user.kitchen_name}</span>
          <button onClick={onLogout} style={styles.logoutBtn}>
            Logout
          </button>
        </div>
      </div>
    </header>
  )
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    minHeight: '100vh',
    background: '#f5f5f5',
  },
  header: {
    background: '#1a1a2e',
    color: 'white',
    padding: '1rem',
  },
  headerContent: {
    maxWidth: '1200px',
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
  },
  nav: {
    display: 'flex',
    gap: '1.5rem',
  },
  navLink: {
    color: 'white',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  dropdownContainer: {
    position: 'relative',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    background: '#2d2d44',
    borderRadius: '4px',
    padding: '0.5rem 0',
    minWidth: '160px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    zIndex: 100,
  },
  dropdownLink: {
    display: 'block',
    padding: '0.5rem 1rem',
    color: 'white',
    textDecoration: 'none',
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  logoutBtn: {
    background: '#e94560',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  main: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '2rem',
  },
}

export default App
