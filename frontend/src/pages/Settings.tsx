import { useAuth } from '../App'

export default function Settings() {
  const { user } = useAuth()

  return (
    <div>
      <h2 style={styles.title}>Settings</h2>

      <div style={styles.section}>
        <h3>Account</h3>
        <p><strong>Email:</strong> {user?.email}</p>
        <p><strong>Name:</strong> {user?.name}</p>
        <p><strong>Kitchen:</strong> {user?.kitchen_name}</p>
      </div>

      <div style={styles.section}>
        <h3>Suppliers</h3>
        <p>Manage supplier templates for improved OCR accuracy.</p>
        <button style={styles.btn}>Manage Suppliers</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  title: {
    marginBottom: '1.5rem',
    color: '#1a1a2e',
  },
  section: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    marginBottom: '1rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  btn: {
    marginTop: '1rem',
    padding: '0.75rem 1.5rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
}
