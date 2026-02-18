import { Routes, Route, Navigate, useLocation, Link } from 'react-router-dom'
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
import ResidentsTableChart from './pages/ResidentsTableChart'
import BookingsStats from './pages/BookingsStats'
import WastageLogbook from './pages/WastageLogbook'
import KDS from './pages/KDS'
import PurchaseOrderList from './components/PurchaseOrderList'
import Ingredients from './components/Ingredients'
import RecipeList from './components/RecipeList'
import RecipeEditor from './components/RecipeEditor'
import EventOrders from './components/EventOrders'
import EventOrderEditor from './components/EventOrderEditor'
import DishList from './components/DishList'
import DishEditor from './components/DishEditor'
import MenuList from './components/MenuList'
import MenuEditor from './components/MenuEditor'
import BulkAllergens from './components/BulkAllergens'
import PriceImpact from './components/PriceImpact'
import UploadApp from './pages/UploadApp'
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
  const isFullscreenPage = location.pathname === '/kds' || location.pathname === '/upload-app'

  // Register service worker for PWA
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

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
                token ? (isPageAccessible('/invoices') ? <SearchInvoices /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/search/line-items"
              element={
                token ? (isPageAccessible('/invoices') ? <SearchLineItems /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/purchase-orders"
              element={
                token ? (isPageAccessible('/invoices') ? <PurchaseOrderList /> : <Navigate to="/" />) : <Navigate to="/login" />
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
            <Route
              path="/ingredients"
              element={
                token ? (isPageAccessible('/recipes') ? <Ingredients /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/recipes"
              element={
                token ? (isPageAccessible('/recipes') ? <RecipeList /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/recipes/:id"
              element={
                token ? (isPageAccessible('/recipes') ? <RecipeEditor /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/dishes"
              element={
                token ? (isPageAccessible('/recipes') ? <DishList /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/dishes/:id"
              element={
                token ? (isPageAccessible('/recipes') ? <DishEditor /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/menus"
              element={
                token ? (isPageAccessible('/recipes') ? <MenuList /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/menus/:id"
              element={
                token ? (isPageAccessible('/recipes') ? <MenuEditor /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/allergens"
              element={
                token ? (isPageAccessible('/recipes') ? <BulkAllergens /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/price-impact"
              element={
                token ? (isPageAccessible('/recipes') ? <PriceImpact /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/event-orders"
              element={
                token ? (isPageAccessible('/recipes') ? <EventOrders /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/event-orders/:id"
              element={
                token ? (isPageAccessible('/recipes') ? <EventOrderEditor /> : <Navigate to="/" />) : <Navigate to="/login" />
              }
            />
            <Route
              path="/upload-app"
              element={<UploadApp />}
            />
          </Routes>
        </main>
        {token && user && !isFullscreenPage && <SupportButton />}
      </div>
    </AuthContext.Provider>
  )
}

function Header({ user, restrictedPages }: { user: User; restrictedPages: string[] }) {
  const location = useLocation()
  const [reportsOpen, setReportsOpen] = useState(false)
  const [invoicesOpen, setInvoicesOpen] = useState(false)
  const [bookingsOpen, setBookingsOpen] = useState(false)
  const [recipesOpen, setRecipesOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Close mobile menu and all dropdowns on navigation
  useEffect(() => {
    setMobileMenuOpen(false)
    setInvoicesOpen(false)
    setBookingsOpen(false)
    setRecipesOpen(false)
    setReportsOpen(false)
  }, [location.pathname])

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

  // Check if recipes dropdown should be shown
  const showRecipes = showNavItem('/recipes')

  // Toggle dropdown on click (for mobile touch support)
  const toggleDropdown = (setter: React.Dispatch<React.SetStateAction<boolean>>, current: boolean) => {
    // Close all other dropdowns first
    setInvoicesOpen(false)
    setBookingsOpen(false)
    setRecipesOpen(false)
    setReportsOpen(false)
    setter(!current)
  }

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
          <Link to="/" style={styles.navLink}>Dashboard</Link>
          {showNavItem('/upload') && <Link to="/upload" style={styles.navLink}>Upload</Link>}
          {showInvoices && (
            <div
              style={styles.dropdownContainer}
              onMouseEnter={() => setInvoicesOpen(true)}
              onMouseLeave={() => setInvoicesOpen(false)}
            >
              <span style={styles.navLink} onClick={() => toggleDropdown(setInvoicesOpen, invoicesOpen)}>Invoices ▾</span>
              {invoicesOpen && (
                <div style={styles.dropdown}>
                  <div style={styles.dropdownContent}>
                    {showNavItem('/invoices') && <Link to="/invoices" style={styles.dropdownLink}>Uploaded Invoices</Link>}
                    {showNavItem('/purchases') && <Link to="/purchases" style={styles.dropdownLink}>Purchase Chart</Link>}
                    {showNavItem('/budget') && <Link to="/budget" style={styles.dropdownLink}>Spend Budget</Link>}
                    {showNavItem('/invoices') && <Link to="/search/invoices" style={styles.dropdownLink}>All Invoices</Link>}
                    {showNavItem('/invoices') && <Link to="/search/line-items" style={styles.dropdownLink}>Line Items</Link>}
                    {showNavItem('/invoices') && <Link to="/disputes" style={styles.dropdownLink}>Disputes</Link>}
                    {showNavItem('/invoices') && <Link to="/purchase-orders" style={styles.dropdownLink}>Purchase Orders</Link>}
                    {showNavItem('/logbook') && <Link to="/logbook" style={styles.dropdownLink}>Allowance Logbook</Link>}
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
              <span style={styles.navLink} onClick={() => toggleDropdown(setBookingsOpen, bookingsOpen)}>Bookings ▾</span>
              {bookingsOpen && (
                <div style={styles.dropdown}>
                  <div style={styles.dropdownContent}>
                    {showNavItem('/resos') && <Link to="/resos" style={styles.dropdownLink}>Restaurant Calendar</Link>}
                    {showNavItem('/resos') && <Link to="/resos-stats" style={styles.dropdownLink}>Restaurant Stats</Link>}
                    {showNavItem('/resos') && <Link to="/residents-table-chart" style={styles.dropdownLink}>Residents Table Chart</Link>}
                  </div>
                </div>
              )}
            </div>
          )}
          {showRecipes && (
            <div
              style={styles.dropdownContainer}
              onMouseEnter={() => setRecipesOpen(true)}
              onMouseLeave={() => setRecipesOpen(false)}
            >
              <span style={styles.navLink} onClick={() => toggleDropdown(setRecipesOpen, recipesOpen)}>Recipes ▾</span>
              {recipesOpen && (
                <div style={styles.dropdown}>
                  <div style={styles.dropdownContent}>
                    <Link to="/ingredients" style={styles.dropdownLink}>Ingredients</Link>
                    <Link to="/recipes" style={styles.dropdownLink}>Recipes</Link>
                    <Link to="/dishes" style={styles.dropdownLink}>Dishes</Link>
                    <Link to="/menus" style={styles.dropdownLink}>Menus</Link>
                    <Link to="/allergens" style={styles.dropdownLink}>Allergens</Link>
                    <Link to="/event-orders" style={styles.dropdownLink}>Event Orders</Link>
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
              <span style={styles.navLink} onClick={() => toggleDropdown(setReportsOpen, reportsOpen)}>Reports ▾</span>
              {reportsOpen && (
                <div style={styles.dropdown}>
                  <div style={styles.dropdownContent}>
                    {showNavItem('/gp-report') && <Link to="/gp" style={styles.dropdownLink}>Kitchen Flash Report</Link>}
                    {showNavItem('/gp-report') && <Link to="/purchases-report" style={styles.dropdownLink}>Purchases Report</Link>}
                    {showNavItem('/gp-report') && <Link to="/allowances-report" style={styles.dropdownLink}>Allowances Report</Link>}
                  </div>
                </div>
              )}
            </div>
          )}
          {showNavItem('/kds') && <Link to="/kds" style={styles.navLink}>KDS</Link>}
          {showNavItem('/settings') && <Link to="/settings" style={styles.navLink}>Settings</Link>}
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
    zIndex: 10,
    minWidth: '44px',
    minHeight: '44px',
    touchAction: 'manipulation' as const,
  },
  nav: {
    display: 'flex',
    gap: '0.25rem',
    marginLeft: 'auto',
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  navLink: {
    color: 'white',
    textDecoration: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    padding: '0.75rem 1rem',
    display: 'block',
    borderRadius: '4px',
  },
  dropdownContainer: {
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
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
    padding: '0.75rem 1.25rem',
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
  nav a:hover, nav > div > span:hover, nav > button:hover {
    background: rgba(255,255,255,0.1);
    border-radius: 4px;
    color: white;
  }

  nav > div > div a:hover {
    background: rgba(255,255,255,0.1);
  }

  @media (max-width: 768px) {
    button[aria-label="Toggle menu"] {
      display: block !important;
      order: 2;
      z-index: 10;
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

    nav.mobile-open {
      display: flex !important;
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
      margin-top: 0.25rem;
      padding-top: 0 !important;
    }

    nav > div > div > div {
      background: #3d3d5c !important;
      border-radius: 4px;
    }

    nav > div > div > div a {
      padding: 0.5rem 1rem !important;
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
