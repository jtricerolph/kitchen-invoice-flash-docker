import { useState, useRef, useCallback, Fragment } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useAuth } from '../App'

// ============ Types ============

interface MatchedItem {
  date: string
  supplier: string
  ref: string
  amount: string
  flash_id: number | null
  match_source?: string  // "rule" or "ai"
}

interface DiscrepancyItem {
  date: string
  supplier: string
  ref: string
  flash_amount: string
  xero_amount: string
  difference: string
  differs: string[]
  flash_id: number | null
  flash_date: string | null
  xero_date: string | null
  flash_ref: string | null
  xero_ref: string | null
  flash_supplier: string | null
  xero_description: string | null
  match_source?: string  // "rule" or "ai"
  amount_insight: string | null
}

interface FlashOnlyItem {
  date: string
  supplier: string
  ref: string
  net_stock: string
  flash_id: number
}

interface XeroOnlyItem {
  date: string
  description: string
  ref: string
  net: string
  is_expected_external: boolean
}

interface ReconcileResult {
  period_start: string
  period_end: string
  flash_total: string
  xero_total: string
  difference: string
  matched_count: number
  discrepancy_count: number
  flash_only_count: number
  xero_only_count: number
  non_stock_excluded_count: number
  non_stock_excluded_total: string
  matched: MatchedItem[]
  discrepancies: DiscrepancyItem[]
  flash_only: FlashOnlyItem[]
  xero_only: XeroOnlyItem[]
  llm_matches_attempted: boolean
}

// ============ Component ============

export default function ReconcilePurchases() {
  const { token } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [dragOver, setDragOver] = useState(false)
  const [result, setResult] = useState<ReconcileResult | null>(null)
  const [matchedCollapsed, setMatchedCollapsed] = useState(false)
  const [externalCollapsed, setExternalCollapsed] = useState(true)
  const [expandedDisc, setExpandedDisc] = useState<Set<number>>(new Set())

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/reports/purchases/reconcile', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Upload failed' }))
        throw new Error(err.detail || 'Upload failed')
      }
      return res.json() as Promise<ReconcileResult>
    },
    onSuccess: (data) => {
      setResult(data)
      // Auto-collapse matched if >20 items
      setMatchedCollapsed(data.matched_count > 20)
    },
  })

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      alert('Please upload an XLSX file')
      return
    }
    uploadMutation.mutate(file)
  }, [uploadMutation])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = '' // reset for re-upload
  }, [handleFile])

  // CSV download helper
  const downloadCSV = (filename: string, headers: string[], rows: string[][]) => {
    const csvContent = [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  const r = result

  // Split xero-only into expected external vs real exceptions
  const xeroExternal = r?.xero_only.filter(x => x.is_expected_external) || []
  const xeroExceptions = r?.xero_only.filter(x => !x.is_expected_external) || []

  return (
    <div style={styles.container}>
      <h2 style={styles.pageTitle}>Xero Reconciliation</h2>

      {/* Upload area */}
      {!uploadMutation.isPending && (
        <div
          style={{ ...styles.dropZone, ...(dragOver ? styles.dropZoneActive : {}) }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
          <div style={styles.dropIcon}>📄</div>
          <div style={styles.dropText}>
            {r ? 'Drop a new Xero XLSX to re-run' : 'Drop Xero Account Transactions XLSX here'}
          </div>
          <div style={styles.dropSubtext}>or click to browse</div>
        </div>
      )}

      {uploadMutation.isPending && (
        <div style={styles.loading}>Parsing XLSX and reconciling against Flash invoices...</div>
      )}

      {uploadMutation.isError && (
        <div style={styles.error}>{(uploadMutation.error as Error).message}</div>
      )}

      {r && (
        <>
          {/* Summary header bar */}
          <div style={styles.summaryBar}>
            <div style={styles.summaryPeriod}>
              Period: {formatDate(r.period_start)} – {formatDate(r.period_end)}
            </div>
            <div style={styles.summaryGrid}>
              <div style={styles.summaryItem}>
                <div style={styles.summaryLabel}>Flash Total (net stock)</div>
                <div style={styles.summaryValue}>{r.flash_total}</div>
              </div>
              <div style={styles.summaryItem}>
                <div style={styles.summaryLabel}>Xero Total (net)</div>
                <div style={styles.summaryValue}>{r.xero_total}</div>
              </div>
              <div style={styles.summaryItem}>
                <div style={styles.summaryLabel}>Difference</div>
                <div style={{ ...styles.summaryValue, color: r.difference === '£0.00' ? '#16a34a' : '#dc2626' }}>
                  {r.difference}
                </div>
              </div>
            </div>
            <div style={styles.summaryCounts}>
              <span style={styles.countBadgeGreen}>✅ {r.matched_count} matched</span>
              <span style={styles.countBadgeAmber}>⚠️ {r.discrepancy_count} discrepancies</span>
              <span style={styles.countBadgeBlue}>❓ {r.flash_only_count} Flash-only</span>
              <span style={styles.countBadgeBlue}>❓ {r.xero_only_count} Xero-only</span>
            </div>
            {r.non_stock_excluded_count > 0 && (
              <div style={styles.footnote}>
                {r.non_stock_excluded_count} non-stock Flash entries excluded ({r.non_stock_excluded_total}) — these post to other Xero accounts
              </div>
            )}
            {r.llm_matches_attempted && (
              <div style={styles.footnote}>
                AI-assisted matching was used for some discrepancies
              </div>
            )}
          </div>

          {/* Section 1: Matched */}
          <div style={styles.section}>
            <div style={styles.sectionHeader} onClick={() => setMatchedCollapsed(!matchedCollapsed)}>
              <span>
                <span style={styles.collapseIcon}>{matchedCollapsed ? '▸' : '▾'}</span>
                ✅ Matched ({r.matched_count})
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  downloadCSV(
                    'reconciliation_matched.csv',
                    ['Date', 'Supplier', 'Ref', 'Amount'],
                    r.matched.map(m => [m.date, m.supplier, m.ref, m.amount])
                  )
                }}
                style={styles.csvBtn}
              >Download CSV</button>
            </div>
            {!matchedCollapsed && r.matched.length > 0 && (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Supplier</th>
                    <th style={styles.th}>Ref</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
                    <th style={{ ...styles.th, textAlign: 'center', width: '40px' }}>✓</th>
                  </tr>
                </thead>
                <tbody>
                  {r.matched.map((m, idx) => (
                    <tr key={idx} style={styles.tr}>
                      <td style={styles.td}>{formatDate(m.date)}</td>
                      <td style={styles.td}>{m.supplier}</td>
                      <td style={styles.td}>{m.ref}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{m.amount}</td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <span style={{ color: '#16a34a' }}>✓</span>
                        {m.match_source === 'ai' && <span style={styles.aiBadge}>AI</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!matchedCollapsed && r.matched.length === 0 && (
              <div style={styles.emptyMsg}>No exact matches found.</div>
            )}
          </div>

          {/* Section 2: Discrepancies — always expanded */}
          <div style={{ ...styles.section, borderColor: '#f59e0b' }}>
            <div style={styles.sectionHeaderAmber}>
              <span>⚠️ Discrepancies ({r.discrepancy_count})</span>
              <button
                onClick={() => downloadCSV(
                  'reconciliation_discrepancies.csv',
                  ['Date', 'Supplier', 'Ref', 'Flash Amount', 'Xero Amount', 'Difference', 'Differs'],
                  r.discrepancies.map(d => [d.date, d.supplier, d.ref, d.flash_amount, d.xero_amount, d.difference, d.differs.join('; ')])
                )}
                style={styles.csvBtn}
              >Download CSV</button>
            </div>
            {r.discrepancies.length > 0 ? (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, width: '30px' }}></th>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Supplier</th>
                    <th style={styles.th}>Ref</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Flash</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Xero</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Diff</th>
                    <th style={styles.th}>What differs</th>
                  </tr>
                </thead>
                <tbody>
                  {r.discrepancies.map((d, idx) => {
                    const isExpanded = expandedDisc.has(idx)
                    return (
                      <Fragment key={idx}>
                        <tr
                          style={{ ...styles.tr, cursor: 'pointer' }}
                          onClick={() => setExpandedDisc(prev => {
                            const next = new Set(prev)
                            if (next.has(idx)) next.delete(idx); else next.add(idx)
                            return next
                          })}
                        >
                          <td style={{ ...styles.td, color: '#999', fontSize: '0.75rem' }}>{isExpanded ? '▾' : '▸'}</td>
                          <td style={styles.td}>
                            {d.differs.includes('date') ? (
                              <span>
                                <span style={styles.amberHighlight}>{d.flash_date ? formatDate(d.flash_date) : '—'}</span>
                                <span style={{ color: '#999', margin: '0 0.25rem' }}>/</span>
                                <span style={styles.amberHighlight}>{d.xero_date ? formatDate(d.xero_date) : '—'}</span>
                              </span>
                            ) : formatDate(d.date)}
                          </td>
                          <td style={styles.td}>
                            {d.flash_id ? (
                              <span
                                title="Open invoice"
                                onClick={(e) => { e.stopPropagation(); window.open(`/invoice/${d.flash_id}`, '_blank') }}
                                style={{ cursor: 'pointer', color: '#3b82f6', textDecoration: 'underline dotted', textUnderlineOffset: '3px' }}
                              >{d.supplier}</span>
                            ) : d.supplier}
                          </td>
                          <td style={styles.td}>
                            {d.differs.includes('ref') ? (
                              <span>
                                <span style={styles.amberHighlight}>{d.flash_ref || '—'}</span>
                                <span style={{ color: '#999', margin: '0 0.25rem' }}>/</span>
                                <span style={styles.amberHighlight}>{d.xero_ref || '—'}</span>
                              </span>
                            ) : d.ref}
                          </td>
                          <td style={{ ...styles.td, textAlign: 'right', ...(d.differs.includes('amount') ? { background: '#fef3c7' } : {}) }}>
                            {d.flash_amount}
                          </td>
                          <td style={{ ...styles.td, textAlign: 'right', ...(d.differs.includes('amount') ? { background: '#fef3c7' } : {}) }}>
                            {d.xero_amount}
                          </td>
                          <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>
                            {d.difference}
                          </td>
                          <td style={styles.td}>
                            {d.differs.map(f => (
                              <span key={f} style={styles.differBadge}>{f}</span>
                            ))}
                            {d.match_source === 'ai' && <span style={styles.aiBadge}>AI</span>}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr style={{ background: '#f8f9fa' }}>
                            <td colSpan={8} style={{ padding: 0 }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                <thead>
                                  <tr>
                                    <th style={styles.detailTh}>Source</th>
                                    <th style={styles.detailTh}>Date</th>
                                    <th style={styles.detailTh}>Supplier / Description</th>
                                    <th style={styles.detailTh}>Ref</th>
                                    <th style={{ ...styles.detailTh, textAlign: 'right' }}>Net Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr style={styles.detailRow}>
                                    <td style={styles.detailTd}><span style={styles.flashBadge}>Flash</span></td>
                                    <td style={{ ...styles.detailTd, ...(d.differs.includes('date') ? { background: '#fef3c7' } : {}) }}>
                                      {d.flash_date ? formatDate(d.flash_date) : '—'}
                                    </td>
                                    <td style={styles.detailTd}>{d.flash_supplier || d.supplier}</td>
                                    <td style={{ ...styles.detailTd, ...(d.differs.includes('ref') ? { background: '#fef3c7' } : {}) }}>
                                      {d.flash_ref || '—'}
                                    </td>
                                    <td style={{ ...styles.detailTd, textAlign: 'right', ...(d.differs.includes('amount') ? { background: '#fef3c7' } : {}) }}>
                                      {d.flash_amount}
                                    </td>
                                  </tr>
                                  <tr style={styles.detailRow}>
                                    <td style={styles.detailTd}><span style={styles.xeroBadge}>Xero</span></td>
                                    <td style={{ ...styles.detailTd, ...(d.differs.includes('date') ? { background: '#fef3c7' } : {}) }}>
                                      {d.xero_date ? formatDate(d.xero_date) : '—'}
                                    </td>
                                    <td style={styles.detailTd}>{d.xero_description || d.supplier}</td>
                                    <td style={{ ...styles.detailTd, ...(d.differs.includes('ref') ? { background: '#fef3c7' } : {}) }}>
                                      {d.xero_ref || '—'}
                                    </td>
                                    <td style={{ ...styles.detailTd, textAlign: 'right', ...(d.differs.includes('amount') ? { background: '#fef3c7' } : {}) }}>
                                      {d.xero_amount}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                              {d.amount_insight && (
                                <div style={styles.insightBar}>
                                  <span style={styles.insightIcon}>💡</span>
                                  {d.amount_insight}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <div style={styles.emptyMsg}>No discrepancies found — all matches are exact.</div>
            )}
          </div>

          {/* Section 3: Flash-only */}
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span>❓ In Flash but not in Xero ({r.flash_only_count})</span>
              <button
                onClick={() => downloadCSV(
                  'reconciliation_flash_only.csv',
                  ['Date', 'Supplier', 'Ref', 'Net Stock'],
                  r.flash_only.map(f => [f.date, f.supplier, f.ref, f.net_stock])
                )}
                style={styles.csvBtn}
              >Download CSV</button>
            </div>
            {r.flash_only.length > 0 ? (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Supplier</th>
                    <th style={styles.th}>Ref</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Flash Net Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {r.flash_only.map((f, idx) => (
                    <tr key={idx} style={styles.tr}>
                      <td style={styles.td}>{formatDate(f.date)}</td>
                      <td style={styles.td}>
                        <span
                          title="Open invoice"
                          onClick={() => window.open(`/invoice/${f.flash_id}`, '_blank')}
                          style={{ cursor: 'pointer', color: '#3b82f6', textDecoration: 'underline dotted', textUnderlineOffset: '3px' }}
                        >{f.supplier}</span>
                      </td>
                      <td style={styles.td}>{f.ref}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{f.net_stock}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={styles.emptyMsg}>All Flash invoices matched.</div>
            )}
          </div>

          {/* Section 4: Xero-only */}
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span>❓ In Xero but not in Flash ({xeroExceptions.length}{xeroExternal.length > 0 ? ` + ${xeroExternal.length} expected` : ''})</span>
              <button
                onClick={() => downloadCSV(
                  'reconciliation_xero_only.csv',
                  ['Date', 'Description', 'Ref', 'Net', 'Expected External'],
                  r.xero_only.map(x => [x.date, x.description, x.ref, x.net, x.is_expected_external ? 'Yes' : 'No'])
                )}
                style={styles.csvBtn}
              >Download CSV</button>
            </div>
            {xeroExceptions.length > 0 ? (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    <th style={styles.th}>Description</th>
                    <th style={styles.th}>Ref</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Xero Net</th>
                  </tr>
                </thead>
                <tbody>
                  {xeroExceptions.map((x, idx) => (
                    <tr key={idx} style={styles.tr}>
                      <td style={styles.td}>{formatDate(x.date)}</td>
                      <td style={styles.td}>{x.description}</td>
                      <td style={styles.td}>{x.ref}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{x.net}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={styles.emptyMsg}>No unexpected Xero-only entries.</div>
            )}

            {/* Expected external sub-section */}
            {xeroExternal.length > 0 && (
              <div style={styles.externalSection}>
                <div
                  style={styles.externalHeader}
                  onClick={() => setExternalCollapsed(!externalCollapsed)}
                >
                  <span style={styles.collapseIcon}>{externalCollapsed ? '▸' : '▾'}</span>
                  Expected external ({xeroExternal.length}) — Tesco, JVs, petty cash etc.
                </div>
                {!externalCollapsed && (
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Description</th>
                        <th style={styles.th}>Ref</th>
                        <th style={{ ...styles.th, textAlign: 'right' }}>Xero Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {xeroExternal.map((x, idx) => (
                        <tr key={idx} style={{ ...styles.tr, opacity: 0.6 }}>
                          <td style={styles.td}>{formatDate(x.date)}</td>
                          <td style={styles.td}>{x.description}</td>
                          <td style={styles.td}>{x.ref}</td>
                          <td style={{ ...styles.td, textAlign: 'right' }}>{x.net}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ============ Styles ============

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' },
  pageTitle: { fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' },

  // Upload
  dropZone: {
    border: '2px dashed #ddd',
    borderRadius: '12px',
    padding: '2.5rem',
    textAlign: 'center',
    cursor: 'pointer',
    marginBottom: '1.5rem',
    background: '#fafafa',
    transition: 'all 0.2s',
  },
  dropZoneActive: {
    borderColor: '#e94560',
    background: '#fff5f7',
  },
  dropIcon: { fontSize: '2.5rem', marginBottom: '0.5rem' },
  dropText: { fontSize: '1rem', fontWeight: 600, color: '#333' },
  dropSubtext: { fontSize: '0.8rem', color: '#999', marginTop: '0.3rem' },
  loading: { padding: '2rem', textAlign: 'center', color: '#888' },
  error: { padding: '1rem', color: '#dc3545', background: '#fde8e8', borderRadius: '6px', marginBottom: '1rem' },

  // Summary bar
  summaryBar: {
    background: '#1a1a2e',
    color: 'white',
    padding: '1.25rem',
    borderRadius: '10px',
    marginBottom: '1.5rem',
  },
  summaryPeriod: { fontSize: '0.85rem', color: '#aaa', marginBottom: '0.75rem' },
  summaryGrid: { display: 'flex', gap: '2rem', marginBottom: '0.75rem', flexWrap: 'wrap' as const },
  summaryItem: {},
  summaryLabel: { fontSize: '0.7rem', textTransform: 'uppercase' as const, color: '#888', fontWeight: 600 },
  summaryValue: { fontSize: '1.3rem', fontWeight: 700 },
  summaryCounts: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap' as const, marginTop: '0.5rem' },
  countBadgeGreen: { fontSize: '0.8rem', background: 'rgba(22,163,74,0.2)', color: '#4ade80', padding: '0.2rem 0.6rem', borderRadius: '4px' },
  countBadgeAmber: { fontSize: '0.8rem', background: 'rgba(245,158,11,0.2)', color: '#fbbf24', padding: '0.2rem 0.6rem', borderRadius: '4px' },
  countBadgeBlue: { fontSize: '0.8rem', background: 'rgba(59,130,246,0.2)', color: '#60a5fa', padding: '0.2rem 0.6rem', borderRadius: '4px' },
  footnote: { fontSize: '0.75rem', color: '#888', marginTop: '0.5rem', fontStyle: 'italic' as const },

  // Sections
  section: {
    marginBottom: '1rem',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    background: '#f8f9fa',
    cursor: 'pointer',
    fontWeight: 700,
    fontSize: '0.95rem',
  },
  sectionHeaderAmber: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    background: '#fffbeb',
    fontWeight: 700,
    fontSize: '0.95rem',
  },
  collapseIcon: { marginRight: '0.5rem', fontSize: '0.85rem' },
  csvBtn: {
    padding: '0.25rem 0.65rem',
    background: 'transparent',
    border: '1px solid #ccc',
    borderRadius: '4px',
    fontSize: '0.75rem',
    cursor: 'pointer',
    color: '#666',
  },
  emptyMsg: { padding: '1rem', textAlign: 'center', color: '#999', fontSize: '0.85rem' },

  // Tables
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: {
    padding: '0.5rem 0.75rem',
    textAlign: 'left' as const,
    borderBottom: '2px solid #e0e0e0',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#666',
    background: '#fafafa',
  },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '0.4rem 0.75rem', fontSize: '0.85rem' },

  // Discrepancy highlights
  amberHighlight: { background: '#fef3c7', padding: '0.1rem 0.3rem', borderRadius: '3px' },
  differBadge: {
    display: 'inline-block',
    background: '#fef3c7',
    color: '#92400e',
    padding: '0.1rem 0.4rem',
    borderRadius: '3px',
    fontSize: '0.7rem',
    fontWeight: 600,
    marginRight: '0.3rem',
  },

  // External sub-section
  externalSection: { borderTop: '1px solid #e0e0e0', marginTop: '0.5rem' },
  externalHeader: {
    padding: '0.6rem 1rem',
    fontSize: '0.8rem',
    color: '#888',
    cursor: 'pointer',
    fontStyle: 'italic' as const,
  },

  // Detail comparison rows
  detailTh: {
    padding: '0.35rem 0.75rem',
    textAlign: 'left' as const,
    fontSize: '0.7rem',
    fontWeight: 600,
    color: '#888',
    borderBottom: '1px solid #e0e0e0',
    background: '#f0f0f0',
  },
  detailRow: { borderBottom: '1px solid #eee' },
  detailTd: { padding: '0.35rem 0.75rem', fontSize: '0.8rem' },
  flashBadge: {
    display: 'inline-block',
    background: '#dbeafe',
    color: '#1d4ed8',
    padding: '0.1rem 0.4rem',
    borderRadius: '3px',
    fontSize: '0.65rem',
    fontWeight: 700,
  },
  xeroBadge: {
    display: 'inline-block',
    background: '#e0e7ff',
    color: '#4338ca',
    padding: '0.1rem 0.4rem',
    borderRadius: '3px',
    fontSize: '0.65rem',
    fontWeight: 700,
  },
  insightBar: {
    padding: '0.5rem 0.75rem',
    background: '#f0fdf4',
    borderTop: '1px solid #bbf7d0',
    fontSize: '0.8rem',
    color: '#166534',
    lineHeight: 1.4,
  },
  insightIcon: {
    marginRight: '0.4rem',
  },
  aiBadge: {
    display: 'inline-block',
    background: '#f3e8ff',
    color: '#7c3aed',
    padding: '0.1rem 0.35rem',
    borderRadius: '3px',
    fontSize: '0.6rem',
    fontWeight: 700,
    marginLeft: '0.3rem',
    verticalAlign: 'middle',
  },
}
