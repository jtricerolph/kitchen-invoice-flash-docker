import { CSSProperties } from 'react'

interface FlagInfo {
  name?: string | null
  code?: string | null
  icon?: string | null
  category?: string | null
  propagation?: string | null
  active?: boolean | null
  excludable?: boolean | null
  food_flag_id?: number | null
  flag_name?: string | null
  flag_code?: string | null
  flag_icon?: string | null
  category_name?: string | null
  propagation_type?: string | null
  is_active?: boolean | null
  excludable_on_request?: boolean | null
}

interface Props {
  flags: FlagInfo[]
  size?: 'small' | 'medium'
}

export default function FoodFlagBadges({ flags, size = 'small' }: Props) {
  const activeFlags = flags.filter(f => (f.active ?? f.is_active) !== false)
  if (!activeFlags.length) return null

  const fontSize = size === 'small' ? '0.7rem' : '0.8rem'
  const padding = size === 'small' ? '1px 5px' : '2px 8px'

  return (
    <div style={styles.container}>
      {activeFlags.map((f, i) => {
        const name = f.name || f.flag_name || ''
        const code = f.code || f.flag_code || ''
        const icon = f.icon || f.flag_icon || ''
        const propagation = f.propagation || f.propagation_type || 'contains'
        const excludable = f.excludable ?? f.excludable_on_request ?? false

        const bg = propagation === 'contains' ? '#dc3545' : '#28a745'

        return (
          <span
            key={i}
            title={`${name}${excludable ? ' (excludable on request)' : ''}`}
            style={{
              ...styles.badge,
              background: bg,
              fontSize,
              padding,
              border: excludable ? '1.5px dashed rgba(255,255,255,0.6)' : 'none',
              opacity: excludable ? 0.85 : 1,
            }}
          >
            {icon ? `${icon} ` : ''}{code || name.substring(0, 3)}
          </span>
        )
      })}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '3px',
    alignItems: 'center',
  },
  badge: {
    display: 'inline-block',
    borderRadius: '10px',
    color: 'white',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    lineHeight: 1.4,
  },
}
