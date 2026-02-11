import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useState, useEffect, createContext, useContext } from 'react'
import Login from './pages/Login'
import Settings from './pages/Settings'
import NewbookData from './pages/NewbookData'
import ResosData from './pages/ResosData'
import Dashboard from './components/Dashboard'
import Upload from './components/Upload'
import InvoiceList from './components/InvoiceList'
import Review from './components/Review'
import Disputes from './components/Disputes'
import Purchases from './components/Purchases'
import Budget from './components/Budget'
import GPReport from './components/GPReport'
import PurchasesReport from './components/PurchasesReport'
import AllowancesReport from './components/AllowancesReport'
import SearchInvoices from './components/SearchInvoices'
import SearchLineItems from './components/SearchLineItems'
import SearchDefinitions from './components/SearchDefinitions'
import ResidentsTableChart from './pages/ResidentsTableChart'
import BookingsStats from './pages/BookingsStats'
import WastageLogbook from './pages/WastageLogbook'
import KDS from './pages/KDS'
import SupportButton from './components/SupportButton'

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

  const location = useLocation()
  const isFullscreenPage = location.pathname === '/kds'

  return (
    <AuthContext.Provider value={{ user, token, restrictedPages, login, logout }}>
      <div style={isFullscreenPage ? styles.appFullscreen : styles.app}>
        {token && user && !isFullscreenPage && <Header user={user} restrictedPages={restrictedPages} />}
        <main style={isFullscreenPage ? styles.mainFullscreen : styles.main}>
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
              path="/disputes"
              element={
                token ? (isPageAccessible('/invoices') ? <Disputes /> : <Navigate to="/" />) : <Navigate to="/login" />
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
              path="/budget"
              element={
                token ? (isPageAccessible('/budget') ? <Budget /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/gp"
              element={
                token ? (isPageAccessible('/gp-report') ? <GPReport /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/purchases-report"
              element={
                token ? (isPageAccessible('/gp-report') ? <PurchasesReport /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/allowances-report"
              element={
                token ? (isPageAccessible('/gp-report') ? <AllowancesReport /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/newbook"
              element={
                token ? (isPageAccessible('/newbook') ? <NewbookData /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/resos"
              element={
                token ? (isPageAccessible('/resos') ? <ResosData /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/resos-stats"
              element={
                token ? (isPageAccessible('/resos') ? <BookingsStats /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/residents-table-chart"
              element={
                token ? (isPageAccessible('/resos') ? <ResidentsTableChart /> : <Navigate to="/" />) : <Navigate to="/login" />
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
            <Route
              path="/logbook"
              element={
                token ? (isPageAccessible('/logbook') ? <WastageLogbook /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/kds"
              element={
                token ? (isPageAccessible('/kds') ? <KDS /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
          </Routes>
        </main>
        {token && user && !isFullscreenPage && <SupportButton />}
      </div>
    </AuthContext.Provider>
  )
}

function Header({ user, restrictedPages }: { user: User; restrictedPages: string[] }) {
  const [reportsOpen, setReportsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [invoicesOpen, setInvoicesOpen] = useState(false)
  const [bookingsOpen, setBookingsOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Check if a page should be shown in nav
  const showNavItem = (path: string) => {
    if (user.is_admin) return true
    return !restrictedPages.includes(path)
  }

  // Check if invoices dropdown should be shown
  const showInvoices = showNavItem('/invoices') || showNavItem('/purchases') || showNavItem('/budget') || showNavItem('/logbook')

  // Check if bookings dropdown should be shown
  const showBookings = showNavItem('/resos')

  // Check if reports dropdown should be shown (at least one report accessible)
  const showReports = showNavItem('/gp-report')

  // Check if search dropdown should be shown
  const showSearch = showNavItem('/search')

  return (
    <header style={styles.header}>
      <div style={styles.headerContent}>
        <h1 style={styles.logo}>Kitchen Flash App</h1>
        <button
          style={styles.hamburger}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          ☰
        </button>
        <nav
          className={mobileMenuOpen ? 'mobile-open' : 'mobile-closed'}
          style={styles.nav}
        >
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
                  <div style={styles.dropdownContent}>
                    {showNavItem('/invoices') && <a href="/invoices" style={styles.dropdownLink}>Uploaded Invoices</a>}
                    {showNavItem('/purchases') && <a href="/purchases" style={styles.dropdownLink}>Purchase Chart</a>}
                    {showNavItem('/budget') && <a href="/budget" style={styles.dropdownLink}>Spend Budget</a>}
                    {showNavItem('/search') && <a href="/search/invoices" style={styles.dropdownLink}>All Invoices</a>}
                    {showNavItem('/invoices') && <a href="/disputes" style={styles.dropdownLink}>Disputes</a>}
                    {showNavItem('/logbook') && <a href="/logbook" style={styles.dropdownLink}>Allowance Logbook</a>}
                  </div>
                </div>
              )}
            </div>
          )}
          {showBookings && (
            <div
              style={styles.dropdownContainer}
              onMouseEnter={() => setBookingsOpen(true)}
              onMouseLeave={() => setBookingsOpen(false)}
            >
              <span style={styles.navLink}>Bookings ▾</span>
              {bookingsOpen && (
                <div style={styles.dropdown}>
                  <div style={styles.dropdownContent}>
                    {showNavItem('/resos') && <a href="/resos" style={styles.dropdownLink}>Restaurant Calendar</a>}
                    {showNavItem('/resos') && <a href="/resos-stats" style={styles.dropdownLink}>Restaurant Stats</a>}
                    {showNavItem('/resos') && <a href="/residents-table-chart" style={styles.dropdownLink}>Residents Table Chart</a>}
                  </div>
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
                  <div style={styles.dropdownContent}>
                    <a href="/search/invoices" style={styles.dropdownLink}>Invoices</a>
                    <a href="/search/line-items" style={styles.dropdownLink}>Line Items</a>
                    <a href="/search/definitions" style={styles.dropdownLink}>Product Definitions</a>
                  </div>
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
                  <div style={styles.dropdownContent}>
                    {showNavItem('/gp-report') && <a href="/gp" style={styles.dropdownLink}>Kitchen Flash Report</a>}
                    {showNavItem('/gp-report') && <a href="/purchases-report" style={styles.dropdownLink}>Purchases Report</a>}
                    {showNavItem('/gp-report') && <a href="/allowances-report" style={styles.dropdownLink}>Allowances Report</a>}
                  </div>
                </div>
              )}
            </div>
          )}
          {showNavItem('/kds') && <a href="/kds" style={styles.navLink}>KDS</a>}
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
  appFullscreen: {
    height: '100vh',
    overflow: 'hidden',
    background: '#1a1a2e',
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
    gap: '1rem',
    flexWrap: 'wrap',
    position: 'relative',
  },
  logo: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    flex: '1 1 auto',
  },
  hamburger: {
    display: 'none',
    background: 'none',
    border: 'none',
    color: 'white',
    fontSize: '1.5rem',
    cursor: 'pointer',
    padding: '0.5rem',
  },
  nav: {
    display: 'flex',
    gap: '1.5rem',
    marginLeft: 'auto',
    flexWrap: 'wrap',
  },
  navLink: {
    color: 'white',
    textDecoration: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  dropdownContainer: {
    position: 'relative',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    paddingTop: '0.5rem',
    background: 'transparent',
    minWidth: '180px',
    zIndex: 100,
  },
  dropdownContent: {
    background: '#2d2d44',
    borderRadius: '4px',
    padding: '0.5rem 0',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
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
  mainFullscreen: {
    height: '100vh',
    margin: 0,
    padding: 0,
    maxWidth: 'none',
  },
}

// Add global styles for responsive behavior
const styleTag = document.createElement('style')
styleTag.innerHTML = `
  @media (max-width: 768px) {
    button[aria-label="Toggle menu"] {
      display: block !important;
      order: 2;
    }

    nav {
      order: 3;
      width: 100%;
      flex-direction: column !important;
      background: #2d2d44;
      padding: 1rem;
      border-radius: 4px;
      margin-top: 0.5rem;
      gap: 0.5rem !important;
    }

    nav.mobile-closed {
      display: none !important;
    }

    nav a, nav > div {
      width: 100%;
      padding: 0.5rem;
    }

    nav > div[style*="position: relative"] {
      position: static !important;
    }

    nav > div > div {
      position: static !important;
      margin-top: 0.5rem;
      padding-top: 0 !important;
    }
  }

  @media (max-width: 480px) {
    h1 {
      font-size: 1.2rem !important;
    }

    nav {
      gap: 0.25rem !important;
    }

    main {
      padding: 1rem !important;
    }
  }
`
if (!document.head.querySelector('style[data-mobile-nav]')) {
  styleTag.setAttribute('data-mobile-nav', 'true')
  document.head.appendChild(styleTag)
}

export default App
