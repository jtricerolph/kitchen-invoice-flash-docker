import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface FlagDef {
  id: number
  name: string
  code: string | null
  icon: string | null
  category_id: number
  category_name: string
}

interface MatrixItem {
  id: number
  display_name: string
  flags: Record<string, boolean>
}

interface MatrixDivision {
  name: string
  items: MatrixItem[]
}

interface MatrixData {
  menu_name: string
  all_flags: FlagDef[]
  divisions: MatrixDivision[]
}

interface Props {
  menuId: number
  menuName: string
  onClose: () => void
}

export default function MenuFlagMatrix({ menuId, menuName, onClose }: Props) {
  const { token } = useAuth()

  const { data, isLoading } = useQuery<MatrixData>({
    queryKey: ['menu-flag-matrix', menuId],
    queryFn: async () => {
      const res = await fetch(`/api/menus/${menuId}/flags`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    enabled: !!token,
  })

  if (isLoading) return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>Loading...</div>
    </div>
  )

  if (!data) return null

  // Group flags by category
  const categories: Array<{ name: string; flags: FlagDef[] }> = []
  const catMap = new Map<string, FlagDef[]>()
  for (const f of data.all_flags) {
    if (!catMap.has(f.category_name)) catMap.set(f.category_name, [])
    catMap.get(f.category_name)!.push(f)
  }
  for (const [name, flags] of catMap) {
    categories.push({ name, flags })
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.printHeader}>
          <h3 style={{ margin: 0 }}>{menuName} — Allergen Matrix</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }} className="no-print">
            <button onClick={() => window.print()} style={styles.btnPrimary}>Print</button>
            <button onClick={onClose} style={styles.btn}>Close</button>
          </div>
        </div>

        {data.divisions.length === 0 && <p style={{ color: '#666' }}>No items on this menu.</p>}

        {data.divisions.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, minWidth: '180px' }}>Dish</th>
                  {data.all_flags.map(f => (
                    <th key={f.id} style={{ ...styles.th, writingMode: 'vertical-lr', textAlign: 'center', fontSize: '0.7rem', padding: '4px 2px', maxWidth: '30px' }}>
                      {f.code || f.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.divisions.map(div => (
                  <>
                    <tr key={`div-${div.name}`}>
                      <td colSpan={data.all_flags.length + 1} style={styles.sectionRow}>
                        {div.name}
                      </td>
                    </tr>
                    {div.items.map(item => (
                      <tr key={item.id}>
                        <td style={styles.td}>{item.display_name}</td>
                        {data.all_flags.map(f => (
                          <td key={f.id} style={{
                            ...styles.td,
                            textAlign: 'center',
                            background: item.flags[String(f.id)] ? '#fee2e2' : 'transparent',
                            color: item.flags[String(f.id)] ? '#dc2626' : '#ccc',
                            fontWeight: item.flags[String(f.id)] ? 700 : 400,
                          }}>
                            {item.flags[String(f.id)] ? 'Y' : '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <style>{`
          @media print {
            .no-print { display: none !important; }
            body > * { display: none !important; }
            body > div:last-child { display: block !important; }
          }
        `}</style>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: '8px', padding: '1.5rem', width: '95%', maxWidth: '1000px', maxHeight: '90vh', overflow: 'auto' },
  printHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: { padding: '0.4rem', borderBottom: '2px solid #e5e7eb', fontWeight: 600, textAlign: 'left', fontSize: '0.8rem' },
  td: { padding: '0.35rem 0.4rem', borderBottom: '1px solid #f3f4f6', fontSize: '0.8rem' },
  sectionRow: { padding: '0.5rem', fontWeight: 700, background: '#f9fafb', fontSize: '0.85rem', borderBottom: '1px solid #e5e7eb' },
  btn: { padding: '0.4rem 0.75rem', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
  btnPrimary: { padding: '0.4rem 0.75rem', border: 'none', borderRadius: '4px', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' },
}
