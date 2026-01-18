import { Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect, createContext, useContext } from 'react'
import Login from './pages/Login'
import Settings from './pages/Settings'
import NewbookData from './pages/NewbookData'
import Dashboard from './components/Dashboard'
import Upload from './components/Upload'
import InvoiceList from './components/InvoiceList'
import Review from './components/Review'
import Purchases from './components/Purchases'
import GPReport from './components/GPReport'
import SearchInvoices from './components/SearchInvoices'
import SearchLineItems from './components/SearchLineItems'
import SearchDefinitions from './components/SearchDefinitions'

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
  restrictedPages: string[]
  login: (token: string) => void
  logout: () => void
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  restrictedPages: [],
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
  const [restrictedPages, setRestrictedPages] = useState<string[]>([])

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

  // Fetch page restrictions
  useEffect(() => {
    if (token) {
      fetch('/api/settings/page-restrictions', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => {
          if (res.ok) return res.json()
          return { restricted_pages: [] }
        })
        .then((data) => setRestrictedPages(data.restricted_pages || []))
        .catch(() => setRestrictedPages([]))
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

  // Helper to check if a page is accessible
  const isPageAccessible = (path: string) => {
    if (user?.is_admin) return true // Admin has access to everything
    return !restrictedPages.includes(path)
  }

  return (
    <AuthContext.Provider value={{ user, token, restrictedPages, login, logout }}>
      <div style={styles.app}>
        {token && user && <Header user={user} restrictedPages={restrictedPages} />}
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
                token ? (isPageAccessible('/upload') ? <Upload /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/invoices"
              element={
                token ? (isPageAccessible('/invoices') ? <InvoiceList /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/invoice/:id"
              element={
                token ? (isPageAccessible('/invoices') ? <Review /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/settings"
              element={
                token ? (isPageAccessible('/settings') ? <Settings /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/purchases"
              element={
                token ? (isPageAccessible('/purchases') ? <Purchases /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/gp"
              element={
                token ? (isPageAccessible('/gp-report') ? <GPReport /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/newbook"
              element={
                token ? (isPageAccessible('/newbook') ? <NewbookData /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/search/invoices"
              element={
                token ? (isPageAccessible('/search') ? <SearchInvoices /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/search/line-items"
              element={
                token ? (isPageAccessible('/search') ? <SearchLineItems /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/search/definitions"
              element={
                token ? (isPageAccessible('/search') ? <SearchDefinitions /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
          </Routes>
        </main>
      </div>
    </AuthContext.Provider>
  )
}

function Header({ user, restrictedPages }: { user: User; restrictedPages: string[] }) {
  const [reportsOpen, setReportsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [invoicesOpen, setInvoicesOpen] = useState(false)

  // Check if a page should be shown in nav
  const showNavItem = (path: string) => {
    if (user.is_admin) return true
    return !restrictedPages.includes(path)
  }

  // Check if invoices dropdown should be shown
  const showInvoices = showNavItem('/invoices') || showNavItem('/purchases')

  // Check if reports dropdown should be shown (at least one report accessible)
  const showReports = showNavItem('/gp-report')

  // Check if search dropdown should be shown
  const showSearch = showNavItem('/search')

  return (
    <header style={styles.header}>
      <div style={styles.headerContent}>
        <h1 style={styles.logo}>Kitchen Flash App</h1>
        <nav style={styles.nav}>
          <a href="/" style={styles.navLink}>Dashboard</a>
          {showNavItem('/upload') && <a href="/upload" style={styles.navLink}>Upload</a>}
          {showInvoices && (
            <div
              style={styles.dropdownContainer}
              onMouseEnter={() => setInvoicesOpen(true)}
              onMouseLeave={() => setInvoicesOpen(false)}
            >
              <span style={styles.navLink}>Invoices ▾</span>
              {invoicesOpen && (
                <div style={styles.dropdown}>
                  {showNavItem('/invoices') && <a href="/invoices" style={styles.dropdownLink}>Incoming/Processing</a>}
                  {showNavItem('/purchases') && <a href="/purchases" style={styles.dropdownLink}>Weekly Tables</a>}
                  {showNavItem('/search') && <a href="/search/invoices" style={styles.dropdownLink}>All Invoices</a>}
                </div>
              )}
            </div>
          )}
          {showSearch && (
            <div
              style={styles.dropdownContainer}
              onMouseEnter={() => setSearchOpen(true)}
              onMouseLeave={() => setSearchOpen(false)}
            >
              <span style={styles.navLink}>Search ▾</span>
              {searchOpen && (
                <div style={styles.dropdown}>
                  <a href="/search/invoices" style={styles.dropdownLink}>Search Invoices</a>
                  <a href="/search/line-items" style={styles.dropdownLink}>Search Line Items</a>
                  <a href="/search/definitions" style={styles.dropdownLink}>Product Definitions</a>
                </div>
              )}
            </div>
          )}
          {showReports && (
            <div
              style={styles.dropdownContainer}
              onMouseEnter={() => setReportsOpen(true)}
              onMouseLeave={() => setReportsOpen(false)}
            >
              <span style={styles.navLink}>Reports ▾</span>
              {reportsOpen && (
                <div style={styles.dropdown}>
                  {showNavItem('/gp-report') && <a href="/gp" style={styles.dropdownLink}>Kitchen Flash Report</a>}
                </div>
              )}
            </div>
          )}
          {showNavItem('/settings') && <a href="/settings" style={styles.navLink}>Settings</a>}
        </nav>
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
    gap: '2rem',
  },
  logo: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
  },
  nav: {
    display: 'flex',
    gap: '1.5rem',
    marginLeft: 'auto',
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
    minWidth: '180px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    zIndex: 100,
  },
  dropdownLink: {
    display: 'block',
    padding: '0.5rem 1rem',
    color: 'white',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  main: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '2rem',
  },
}

export default App
