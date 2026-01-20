import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../App'

interface DailyStats {
  date: string
  total_bookings: number
  total_covers: number
  service_breakdown: Array<{
    period: string
    bookings: number
    covers: number
  }>
  flagged_booking_count: number
  unique_flag_types: string[] | null
  is_forecast: boolean
}

interface Booking {
  id: number
  resos_booking_id: string
  booking_date: string
  booking_time: string
  people: number
  status: string
  seating_area: string | null
  table_name: string | null
  hotel_booking_number: string | null
  is_hotel_guest: boolean | null
  is_dbb: boolean | null
  is_package: boolean | null
  allergies: string | null
  notes: string | null
  opening_hour_name: string | null
  is_flagged: boolean
  flag_reasons: string | null
}

interface OpeningHour {
  name: string
  service_type: string
  open: number  // HHMM format (e.g., 1800)
  close: number // HHMM format (e.g., 2200)
  is_special: boolean
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface ResosSettings {
  resos_opening_hours_mapping: Array<{
    resos_id: string
    display_name: string
    actual_end: string
    service_type: string
  }> | null
  resos_flag_icon_mapping: Record<string, string> | null
  resos_note_keywords: string | null
  resos_large_group_threshold: number
}

export default function ResosData() {
  const { token } = useAuth()
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set())
  const [selectedServiceType, setSelectedServiceType] = useState<string>('all')

  // Reset expanded notes when changing dates
  useEffect(() => {
    setExpandedNotes(new Set())
  }, [selectedDate])

  // Fetch Resos settings to get display name mapping
  const { data: settings } = useQuery<ResosSettings>({
    queryKey: ['resos-settings'],
    queryFn: async () => {
      const res = await fetch('/api/resos/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch daily stats for the month
  const { data: dailyStats, isLoading } = useQuery<DailyStats[]>({
    queryKey: ['resos-daily-stats', year, month],
    queryFn: async () => {
      const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
      const lastDay = new Date(year, month, 0)
      const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`

      const res = await fetch(`/api/resos/daily-stats?from_date=${firstDay}&to_date=${toDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch daily stats')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch previous month's stats for comparison
  const { data: prevMonthStats } = useQuery<DailyStats[]>({
    queryKey: ['resos-stats-prev', year, month],
    queryFn: async () => {
      const prevMonth = month === 1 ? 12 : month - 1
      const prevYear = month === 1 ? year - 1 : year
      const firstDay = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`
      const lastDay = new Date(prevYear, prevMonth, 0)
      const toDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`

      const res = await fetch(`/api/resos/daily-stats?from_date=${firstDay}&to_date=${toDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch previous month stats')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch bookings for selected date
  const { data: bookings } = useQuery<Booking[]>({
    queryKey: ['resos-bookings', selectedDate],
    queryFn: async () => {
      if (!selectedDate) return []
      const res = await fetch(`/api/resos/bookings/${selectedDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch bookings')
      return res.json()
    },
    enabled: !!token && !!selectedDate,
  })

  // Fetch ALL opening hours (for consistent time range across all days)
  const { data: allOpeningHoursData } = useQuery<{ opening_hours: any[] }>({
    queryKey: ['resos-all-opening-hours'],
    queryFn: async () => {
      const res = await fetch(`/api/resos/opening-hours`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch opening hours')
      return res.json()
    },
    enabled: !!token
  })

  // Calculate global time range from ALL opening hours
  const globalTimeRange = allOpeningHoursData?.opening_hours ? (() => {
    const hours = allOpeningHoursData.opening_hours.filter((h: any) => !h.special)
    if (hours.length === 0) return null

    let earliestOpen = 2400
    let latestClose = 0

    hours.forEach((h: any) => {
      const open = h.open || 0
      const close = h.close || 0
      if (open < earliestOpen) earliestOpen = open
      if (close > latestClose) latestClose = close
    })

    const startHour = Math.floor(earliestOpen / 100)
    let endHour = Math.floor(latestClose / 100)
    if (latestClose % 100 > 0) endHour++

    return { startHour, endHour }
  })() : null

  // Fetch day-specific opening hours for closed blocks
  const { data: dayOpeningHours } = useQuery<OpeningHour[]>({
    queryKey: ['resos-opening-hours', selectedDate],
    queryFn: async () => {
      if (!selectedDate) return []
      const res = await fetch(`/api/resos/opening-hours/${selectedDate}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch opening hours')
      return res.json()
    },
    enabled: !!selectedDate && !!token
  })

  const goToPrevMonth = () => {
    if (month === 1) {
      setMonth(12)
      setYear(year - 1)
    } else {
      setMonth(month - 1)
    }
  }

  const goToNextMonth = () => {
    if (month === 12) {
      setMonth(1)
      setYear(year + 1)
    } else {
      setMonth(month + 1)
    }
  }

  const goToToday = () => {
    setYear(today.getFullYear())
    setMonth(today.getMonth() + 1)
  }

  // Helper function to get service type name for a period
  const getDisplayName = (periodName: string): string => {
    if (!settings?.resos_opening_hours_mapping) return periodName

    // Find mapping by matching period name (case-insensitive)
    const mapping = settings.resos_opening_hours_mapping.find(
      m => m.display_name?.toLowerCase() === periodName.toLowerCase()
    )

    // Return capitalized service type if found, otherwise return the period name
    if (mapping?.service_type) {
      return mapping.service_type.charAt(0).toUpperCase() + mapping.service_type.slice(1)
    }

    return periodName
  }

  // Helper function to get icon for a single flag type
  const getIconForFlag = (flag: string): string => {
    const iconMapping = settings?.resos_flag_icon_mapping || {}

    // Default icons if not customized
    const defaultIcons: Record<string, string> = {
      'allergies': '🦀',
      'large_group': '👥',
      'note_keyword_birthday': '🎂',
      'note_keyword_anniversary': '💍',
    }

    // First check custom mapping
    if (iconMapping[flag]) {
      return iconMapping[flag]
    }

    // Check if it's a note_keyword flag and extract the keyword
    if (flag.startsWith('note_keyword_')) {
      const keyword = flag.replace('note_keyword_', '')
      if (iconMapping[keyword]) {
        return iconMapping[keyword]
      }
    }

    // Fall back to default icons
    if (defaultIcons[flag]) {
      return defaultIcons[flag]
    }

    return '⚠️'  // Generic warning if no match found
  }

  // Helper function to get icon for a booking's flags (returns first icon)
  const getFlagIcon = (flagReasons: string | null): string => {
    if (!flagReasons) return '⚠️'
    const flags = flagReasons.split(',').map(f => f.trim())
    return getIconForFlag(flags[0])
  }

  // Check if notes are flagged as important
  const isNoteFlagged = (flagReasons: string | null): boolean => {
    if (!flagReasons) return false
    const flags = flagReasons.split(',').map(f => f.trim().toLowerCase())
    return flags.includes('notes')
  }

  // Check if notes contain any keywords from settings
  const notesContainKeywords = (notes: string | null): { hasKeywords: boolean; matchedKeyword: string | null } => {
    if (!notes || !settings?.resos_note_keywords) {
      return { hasKeywords: false, matchedKeyword: null }
    }

    const keywords = settings.resos_note_keywords.split(',').map(k => k.trim().toLowerCase())
    const notesLower = notes.toLowerCase()

    for (const keyword of keywords) {
      if (notesLower.includes(keyword)) {
        return { hasKeywords: true, matchedKeyword: keyword }
      }
    }

    return { hasKeywords: false, matchedKeyword: null }
  }

  // Check if booking is a large group
  const isLargeGroup = (people: number): boolean => {
    const threshold = settings?.resos_large_group_threshold || 8
    return people >= threshold
  }

  // Get large group icon
  const getLargeGroupIcon = (): string => {
    return getIconForFlag('large_group')
  }

  // Toggle note expansion
  const toggleNoteExpansion = (bookingId: number) => {
    setExpandedNotes(prev => {
      const newSet = new Set(prev)
      if (newSet.has(bookingId)) {
        newSet.delete(bookingId)
      } else {
        newSet.add(bookingId)
      }
      return newSet
    })
  }

  // Helper function to get multiple unique icons for flag types
  const getFlagIcons = (flagTypes: string[] | null): string[] => {
    if (!flagTypes || flagTypes.length === 0) return []

    // Map flags to icons and deduplicate
    const iconSet = new Set<string>()
    for (const flag of flagTypes) {
      const icon = getIconForFlag(flag)
      iconSet.add(icon)
    }

    return Array.from(iconSet)
  }

  // Build stats map
  const statsMap = new Map<string, DailyStats>()
  dailyStats?.forEach(stat => {
    statsMap.set(stat.date, stat)
  })

  // Calculate calendar grid
  const firstDayOfMonth = new Date(year, month - 1, 1)
  const lastDayOfMonth = new Date(year, month, 0)
  // Adjust day of week to make Monday = 0, Sunday = 6
  const startingDayOfWeek = (firstDayOfMonth.getDay() + 6) % 7
  const daysInMonth = lastDayOfMonth.getDate()

  const calendarDays: (Date | null)[] = []

  // Add empty cells for days before the month starts
  for (let i = 0; i < startingDayOfWeek; i++) {
    calendarDays.push(null)
  }

  // Add all days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(new Date(year, month - 1, day))
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Resos Booking Data</h1>
      <p style={styles.subtitle}>View synced booking data, covers, and flagged reservations from Resos</p>

      {/* Month Navigation */}
      <div style={styles.navBar}>
        <button onClick={goToPrevMonth} style={styles.navButton}>← Previous</button>
        <div style={styles.monthYearDisplay}>
          {MONTH_NAMES[month - 1]} {year}
        </div>
        <button onClick={goToToday} style={styles.todayButton}>Today</button>
        <button onClick={goToNextMonth} style={styles.navButton}>Next →</button>
      </div>

      {isLoading ? (
        <div style={styles.loading}>Loading calendar data...</div>
      ) : (
        <div style={styles.calendar}>
          {/* Day Headers */}
          <div style={styles.calendarHeader}>
            {DAY_NAMES.map(day => (
              <div key={day} style={styles.dayHeader}>{day}</div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div style={styles.calendarGrid}>
            {calendarDays.map((day, idx) => {
              if (!day) {
                return <div key={`empty-${idx}`} style={styles.emptyCell} />
              }

              const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
              const stat = statsMap.get(dateStr)
              const isToday = dateStr === today.toISOString().split('T')[0]
              const hasFlaggedBookings = (stat?.flagged_booking_count || 0) > 0

              return (
                <div
                  key={dateStr}
                  style={{
                    ...styles.dayCell,
                    ...(stat ? styles.dayCellWithData : {}),
                    ...(isToday ? styles.dayCellToday : {}),
                    ...(hasFlaggedBookings ? styles.dayCellFlagged : {}),
                    ...(stat?.is_forecast ? styles.dayCellForecast : {})
                  }}
                  onClick={() => stat && setSelectedDate(dateStr)}
                >
                  <div style={styles.dayNumber}>
                    {day.getDate()}
                    {hasFlaggedBookings && (
                      <span style={styles.flagIcon}>
                        {getFlagIcons(stat?.unique_flag_types || null).map((icon, idx) => (
                          <span key={idx}>{icon}</span>
                        ))}
                      </span>
                    )}
                  </div>
                  {stat && (
                    <div style={styles.dayStats}>
                      <div style={styles.statLine}>
                        <strong>{stat.total_bookings}</strong> bookings
                      </div>
                      <div style={styles.statLine}>
                        <strong>{stat.total_covers}</strong> covers
                      </div>
                      {stat.service_breakdown.length > 0 && (
                        <div style={styles.serviceBreakdown}>
                          {stat.service_breakdown.map(service => (
                            <div key={service.period} style={styles.serviceLine}>
                              {getDisplayName(service.period)}: {service.bookings} : {service.covers}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Comparison Graph */}
          {dailyStats && prevMonthStats && (
            <div style={styles.chartContainer}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={styles.chartTitle}>Current vs Previous Month</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <label htmlFor="serviceTypeFilter" style={{ fontSize: '0.9rem', fontWeight: '600' }}>
                    Service Type:
                  </label>
                  <select
                    id="serviceTypeFilter"
                    value={selectedServiceType}
                    onChange={(e) => setSelectedServiceType(e.target.value)}
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid #ccc',
                      fontSize: '0.9rem',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="all">All Services</option>
                    <option value="breakfast">Breakfast</option>
                    <option value="lunch">Lunch</option>
                    <option value="dinner">Dinner</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              {(() => {
                const currentDaysInMonth = new Date(year, month, 0).getDate()
                const prevMonth = month === 1 ? 12 : month - 1
                const prevYear = month === 1 ? year - 1 : year

                // Helper to filter service breakdown
                const getServiceData = (stat: DailyStats) => {
                  if (selectedServiceType === 'all') {
                    return { bookings: stat.total_bookings, covers: stat.total_covers }
                  }
                  const serviceData = stat.service_breakdown.find(s => s.period.toLowerCase() === selectedServiceType)
                  return serviceData ? { bookings: serviceData.bookings, covers: serviceData.covers } : { bookings: 0, covers: 0 }
                }

                // Create data arrays for each day
                const currentBookings = new Array(currentDaysInMonth).fill(0)
                const currentCovers = new Array(currentDaysInMonth).fill(0)
                const prevBookings = new Array(currentDaysInMonth).fill(0)
                const prevCovers = new Array(currentDaysInMonth).fill(0)

                // Populate current month data
                dailyStats.forEach((stat: DailyStats) => {
                  const day = new Date(stat.date).getDate()
                  const { bookings, covers } = getServiceData(stat)
                  currentBookings[day - 1] = bookings
                  currentCovers[day - 1] = covers
                })

                // Create a map of previous month data by date
                const prevMonthDataByDate = new Map<string, { bookings: number; covers: number }>()
                prevMonthStats.forEach((stat: DailyStats) => {
                  const { bookings, covers } = getServiceData(stat)
                  prevMonthDataByDate.set(stat.date, { bookings, covers })
                })

                // Find first matching day of week in previous month and offset from there
                const firstDayOfCurrentMonth = new Date(year, month - 1, 1)
                const firstDayOfWeek = firstDayOfCurrentMonth.getDay() // 0-6

                // Find the first occurrence of that day of week in previous month
                let prevMonthStartDate = new Date(prevYear, prevMonth - 1, 1)
                while (prevMonthStartDate.getDay() !== firstDayOfWeek) {
                  prevMonthStartDate.setDate(prevMonthStartDate.getDate() + 1)
                }

                // Map previous month data with offset
                for (let day = 1; day <= currentDaysInMonth; day++) {
                  const offset = day - 1
                  const prevDate = new Date(prevMonthStartDate)
                  prevDate.setDate(prevMonthStartDate.getDate() + offset)

                  const prevDateStr = prevDate.toISOString().split('T')[0]
                  const prevData = prevMonthDataByDate.get(prevDateStr)

                  if (prevData) {
                    prevBookings[day - 1] = prevData.bookings
                    prevCovers[day - 1] = prevData.covers
                  }
                }

                // Calculate day-of-week averages from previous month (for 5th line)
                const prevDataByDayOfWeek: Record<number, { bookings: number[]; covers: number[] }> = {}
                for (let dow = 0; dow < 7; dow++) {
                  prevDataByDayOfWeek[dow] = { bookings: [], covers: [] }
                }

                prevMonthStats.forEach((stat: DailyStats) => {
                  const date = new Date(stat.date)
                  const dayOfWeek = date.getDay()
                  const { bookings, covers } = getServiceData(stat)
                  prevDataByDayOfWeek[dayOfWeek].bookings.push(bookings)
                  prevDataByDayOfWeek[dayOfWeek].covers.push(covers)
                })

                const prevAvgByDayOfWeek: Record<number, { bookings: number; covers: number }> = {}
                for (let dow = 0; dow < 7; dow++) {
                  const bookingsData = prevDataByDayOfWeek[dow].bookings
                  const coversData = prevDataByDayOfWeek[dow].covers
                  prevAvgByDayOfWeek[dow] = {
                    bookings: bookingsData.length > 0 ? bookingsData.reduce((a, b) => a + b, 0) / bookingsData.length : 0,
                    covers: coversData.length > 0 ? coversData.reduce((a, b) => a + b, 0) / coversData.length : 0
                  }
                }

                // Create array for day-of-week average line
                const avgCoversLine = new Array(currentDaysInMonth).fill(0)
                for (let day = 1; day <= currentDaysInMonth; day++) {
                  const currentDate = new Date(year, month - 1, day)
                  const dayOfWeek = currentDate.getDay()
                  avgCoversLine[day - 1] = prevAvgByDayOfWeek[dayOfWeek].covers
                }

                // Combined max value for all data
                const maxValue = Math.max(
                  ...currentBookings,
                  ...prevBookings,
                  ...currentCovers,
                  ...prevCovers,
                  ...avgCoversLine,
                  10
                )
                const chartHeight = 300
                const chartWidth = '100%'
                const padding = 50
                const viewBoxWidth = 1200

                return (
                  <>
                    <svg width={chartWidth} height={chartHeight} viewBox={`0 0 ${viewBoxWidth} ${chartHeight}`} preserveAspectRatio="xMidYMid meet" style={styles.chart}>
                      {/* Grid lines */}
                      {[0, 0.25, 0.5, 0.75, 1].map(fraction => (
                        <line
                          key={fraction}
                          x1={padding}
                          y1={padding + (chartHeight - 2 * padding) * fraction}
                          x2={viewBoxWidth - padding}
                          y2={padding + (chartHeight - 2 * padding) * fraction}
                          stroke="#e0e0e0"
                          strokeWidth="1"
                        />
                      ))}

                      {/* Sunday markers - vertical dotted lines */}
                      {Array.from({ length: currentDaysInMonth }, (_, i) => {
                        const day = i + 1
                        const currentDate = new Date(year, month - 1, day)
                        const dayOfWeek = currentDate.getDay()
                        if (dayOfWeek === 0) { // Sunday
                          const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                          return (
                            <line
                              key={`sunday-${day}`}
                              x1={x}
                              y1={padding}
                              x2={x}
                              y2={chartHeight - padding}
                              stroke="#999"
                              strokeWidth="1"
                              strokeDasharray="3,3"
                            />
                          )
                        }
                        return null
                      })}

                      {/* Previous month bookings - dotted blue */}
                      <polyline
                        points={currentBookings.map((_, i) => {
                          const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                          const y = padding + (chartHeight - 2 * padding) * (1 - prevBookings[i] / maxValue)
                          return `${x},${y}`
                        }).join(' ')}
                        fill="none"
                        stroke="#93c5fd"
                        strokeWidth="2"
                        strokeDasharray="5,5"
                      />

                      {/* Current month bookings - solid blue */}
                      <polyline
                        points={currentBookings.map((value, i) => {
                          const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                          const y = padding + (chartHeight - 2 * padding) * (1 - value / maxValue)
                          return `${x},${y}`
                        }).join(' ')}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="3"
                      />

                      {/* Data point circles for current bookings */}
                      {currentBookings.map((value, i) => {
                        const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                        const y = padding + (chartHeight - 2 * padding) * (1 - value / maxValue)
                        return (
                          <circle
                            key={`booking-point-${i}`}
                            cx={x}
                            cy={y}
                            r="3"
                            fill="#3b82f6"
                            stroke="white"
                            strokeWidth="1"
                          />
                        )
                      })}

                      {/* Previous month covers - dotted green */}
                      <polyline
                        points={currentCovers.map((_, i) => {
                          const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                          const y = padding + (chartHeight - 2 * padding) * (1 - prevCovers[i] / maxValue)
                          return `${x},${y}`
                        }).join(' ')}
                        fill="none"
                        stroke="#86efac"
                        strokeWidth="2"
                        strokeDasharray="5,5"
                      />

                      {/* Current month covers - solid green */}
                      <polyline
                        points={currentCovers.map((value, i) => {
                          const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                          const y = padding + (chartHeight - 2 * padding) * (1 - value / maxValue)
                          return `${x},${y}`
                        }).join(' ')}
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="3"
                      />

                      {/* Data point circles for current covers */}
                      {currentCovers.map((value, i) => {
                        const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                        const y = padding + (chartHeight - 2 * padding) * (1 - value / maxValue)
                        return (
                          <circle
                            key={`cover-point-${i}`}
                            cx={x}
                            cy={y}
                            r="3"
                            fill="#10b981"
                            stroke="white"
                            strokeWidth="1"
                          />
                        )
                      })}

                      {/* Day-of-week average covers line - orange */}
                      <polyline
                        points={avgCoversLine.map((value, i) => {
                          const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * i
                          const y = padding + (chartHeight - 2 * padding) * (1 - value / maxValue)
                          return `${x},${y}`
                        }).join(' ')}
                        fill="none"
                        stroke="#f97316"
                        strokeWidth="2"
                        strokeDasharray="3,3"
                      />

                      {/* Y-axis labels */}
                      <text x={padding - 10} y={padding} textAnchor="end" fontSize="12" fill="#666">{maxValue}</text>
                      <text x={padding - 10} y={padding + (chartHeight - 2 * padding) * 0.5} textAnchor="end" fontSize="12" fill="#666">{Math.round(maxValue / 2)}</text>
                      <text x={padding - 10} y={chartHeight - padding} textAnchor="end" fontSize="12" fill="#666">0</text>

                      {/* X-axis labels (every 5 days) */}
                      {Array.from({ length: Math.ceil(currentDaysInMonth / 5) }, (_, i) => {
                        const day = (i * 5) + 1
                        if (day > currentDaysInMonth) return null
                        const x = padding + ((viewBoxWidth - 2 * padding) / (currentDaysInMonth - 1)) * (day - 1)
                        return (
                          <text
                            key={day}
                            x={x}
                            y={chartHeight - padding + 20}
                            textAnchor="middle"
                            fontSize="11"
                            fill="#666"
                          >
                            {day}
                          </text>
                        )
                      })}
                    </svg>

                    <div style={styles.chartLegend}>
                      <span style={styles.legendItem}>
                        <span style={{ ...styles.legendLine, background: '#3b82f6' }}></span>
                        Current Bookings
                      </span>
                      <span style={styles.legendItem}>
                        <span style={{ ...styles.legendLine, height: '2px', borderTop: '2px dashed #93c5fd', background: 'transparent' }}></span>
                        Previous Bookings
                      </span>
                      <span style={styles.legendItem}>
                        <span style={{ ...styles.legendLine, background: '#10b981' }}></span>
                        Current Covers
                      </span>
                      <span style={styles.legendItem}>
                        <span style={{ ...styles.legendLine, height: '2px', borderTop: '2px dashed #86efac', background: 'transparent' }}></span>
                        Previous Covers
                      </span>
                      <span style={styles.legendItem}>
                        <span style={{ ...styles.legendLine, height: '2px', borderTop: '2px dashed #f97316', background: 'transparent' }}></span>
                        Avg Day-of-Week Covers
                      </span>
                    </div>
                  </>
                )
              })()}
            </div>
          )}
        </div>
      )}

      {/* Day Detail Modal */}
      {selectedDate && bookings && (
        <div style={styles.modalOverlay} onClick={() => setSelectedDate(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2>Bookings for {selectedDate}</h2>
              <button onClick={() => setSelectedDate(null)} style={styles.closeBtn}>×</button>
            </div>

            <div style={styles.modalContent}>
              {/* Gantt Timeline Chart */}
              {(() => {
                // Use GLOBAL time range for consistent chart size across all days
                let startHour = 18  // Default
                let endHour = 22

                if (globalTimeRange) {
                  startHour = globalTimeRange.startHour
                  endHour = globalTimeRange.endHour
                } else if (bookings.length > 0) {
                  // Fallback to booking times if no opening hours
                  const times = bookings.map(b => {
                    const [h, m] = b.booking_time.split(':').map(Number)
                    return h * 60 + m
                  })
                  const minTime = Math.min(...times)
                  const maxTime = Math.max(...times) + 120
                  startHour = Math.floor(minTime / 60)
                  endHour = Math.ceil(maxTime / 60)
                }

                const totalMinutes = (endHour - startHour) * 60

                // Position bookings on grid to avoid overlap
                const sortedBookings = [...bookings].sort((a, b) => {
                  const aTime = parseInt(a.booking_time.replace(/:/g, ''))
                  const bTime = parseInt(b.booking_time.replace(/:/g, ''))
                  return aTime - bTime
                })

                const gridRows: any[][] = []
                const positionedBookings = sortedBookings.map(booking => {
                  const [h, m] = booking.booking_time.split(':').map(Number)
                  const bookingStart = (h - startHour) * 60 + m
                  const bookingEnd = bookingStart + 120 // 2 hour duration
                  const partySize = booking.people
                  const rowSpan = Math.max(1, Math.floor(partySize / 4) + 1)

                  // Find first available row
                  let gridRow = 0
                  let placed = false
                  while (!placed) {
                    // Ensure enough grid rows exist
                    while (gridRows.length < gridRow + rowSpan) {
                      gridRows.push([])
                    }

                    // Check if all required rows are free
                    let canPlace = true
                    for (let r = gridRow; r < gridRow + rowSpan; r++) {
                      for (const seg of gridRows[r]) {
                        if (!(bookingEnd + 5 <= seg.start || bookingStart >= seg.end + 5)) {
                          canPlace = false
                          break
                        }
                      }
                      if (!canPlace) break
                    }

                    if (canPlace) {
                      for (let r = gridRow; r < gridRow + rowSpan; r++) {
                        gridRows[r].push({ start: bookingStart, end: bookingEnd })
                      }
                      placed = true
                    } else {
                      gridRow++
                    }
                  }

                  return { ...booking, gridRow, rowSpan, bookingStart, bookingEnd }
                })

                const gridRowHeight = 24
                const totalHeight = gridRows.length * gridRowHeight + 20

                // Build closed blocks (grey overlays)
                const buildClosedBlocks = () => {
                  const blocks: JSX.Element[] = []

                  // If no opening hours for this specific day, grey out entire chart
                  if (!dayOpeningHours || dayOpeningHours.length === 0) {
                    blocks.push(
                      <div
                        key="full-closed"
                        style={{
                          ...styles.ganttClosedBlock,
                          left: '0%',
                          width: '100%',
                          height: totalHeight
                        }}
                      />
                    )
                    return blocks
                  }

                  // Sort opening hours by start time
                  const sorted = [...dayOpeningHours].sort((a, b) => a.open - b.open)

                  // 1. Block from chart start to FIRST opening
                  const firstOpen = sorted[0].open
                  const firstOpenMinutes = Math.floor(firstOpen / 100) * 60 + (firstOpen % 100)
                  const minutesFromChartStart = firstOpenMinutes - (startHour * 60)

                  if (minutesFromChartStart > 0) {
                    const widthPercent = (minutesFromChartStart / totalMinutes) * 100
                    blocks.push(
                      <div
                        key="before-open"
                        style={{
                          ...styles.ganttClosedBlock,
                          left: '0%',
                          width: `${widthPercent}%`,
                          height: totalHeight
                        }}
                      />
                    )
                  }

                  // 2. Blocks BETWEEN opening periods (gaps between lunch and dinner)
                  for (let i = 0; i < sorted.length - 1; i++) {
                    const currentClose = sorted[i].close
                    const nextOpen = sorted[i + 1].open

                    const closeMinutes = Math.floor(currentClose / 100) * 60 + (currentClose % 100)
                    const openMinutes = Math.floor(nextOpen / 100) * 60 + (nextOpen % 100)

                    const gapStart = closeMinutes - (startHour * 60)
                    const gapEnd = openMinutes - (startHour * 60)
                    const gapDuration = gapEnd - gapStart

                    if (gapDuration > 0) {
                      const leftPercent = (gapStart / totalMinutes) * 100
                      const widthPercent = (gapDuration / totalMinutes) * 100
                      blocks.push(
                        <div
                          key={`gap-${i}`}
                          style={{
                            ...styles.ganttClosedBlock,
                            left: `${leftPercent}%`,
                            width: `${widthPercent}%`,
                            height: totalHeight
                          }}
                        />
                      )
                    }
                  }

                  // 3. Block from LAST close to chart end
                  const lastClose = sorted[sorted.length - 1].close
                  const lastCloseMinutes = Math.floor(lastClose / 100) * 60 + (lastClose % 100)
                  const minutesFromClose = (endHour * 60) - lastCloseMinutes

                  if (minutesFromClose > 0) {
                    const leftPercent = ((lastCloseMinutes - (startHour * 60)) / totalMinutes) * 100
                    const widthPercent = (minutesFromClose / totalMinutes) * 100
                    blocks.push(
                      <div
                        key="after-close"
                        style={{
                          ...styles.ganttClosedBlock,
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                          height: totalHeight
                        }}
                      />
                    )
                  }

                  return blocks
                }

                return (
                  <div style={styles.ganttContainer}>
                    <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>Timeline</h3>
                    <div style={styles.ganttTimeAxis}>
                      {Array.from({ length: endHour - startHour }, (_, i) => startHour + i).flatMap(h => [
                        <div key={`${h}-00`} style={{ ...styles.ganttTimeLabel, left: `${((h - startHour) * 60 / totalMinutes) * 100}%` }}>
                          {h}:00
                        </div>,
                        <div key={`${h}-30`} style={{ ...styles.ganttTimeLabel, left: `${((h - startHour) * 60 + 30) / totalMinutes * 100}%` }}>
                          {h}:30
                        </div>
                      ])}
                    </div>
                    <div style={{ ...styles.ganttBookings, height: totalHeight }}>
                      {/* CLOSED BLOCKS FIRST (background layer) */}
                      {buildClosedBlocks()}

                      {/* Interval lines every 15 min */}
                      {Array.from({ length: Math.floor(totalMinutes / 15) }, (_, i) => (i + 1) * 15).map(m => (
                        <div key={m} style={{ ...styles.ganttIntervalLine, left: `${(m / totalMinutes) * 100}%`, height: totalHeight }} />
                      ))}
                      {/* Booking bars */}
                      {positionedBookings.map(booking => {
                        const leftPercent = (booking.bookingStart / totalMinutes) * 100
                        const widthPercent = (Math.min(booking.bookingEnd, totalMinutes) - booking.bookingStart) / totalMinutes * 100
                        const top = 10 + (booking.gridRow * gridRowHeight)
                        const height = (booking.rowSpan * gridRowHeight) - 4

                        const displayText = booking.table_name || ''
                        const isLarge = isLargeGroup(booking.people)
                        const flagIcons = booking.is_flagged ? getFlagIcon(booking.flag_reasons) : (isLarge ? getLargeGroupIcon() : '')

                        return (
                          <div
                            key={booking.id}
                            style={{
                              ...styles.ganttBookingBar,
                              left: `${leftPercent}%`,
                              width: `${widthPercent}%`,
                              top,
                              height
                            }}
                            title={`${booking.booking_time} - ${getDisplayName(booking.opening_hour_name || '')} - ${booking.people} covers${booking.table_name ? ` - Table ${booking.table_name}` : ''}${booking.allergies ? `\n🦀 ${booking.allergies}` : ''}${booking.notes ? `\n📝 ${booking.notes}` : ''}`}
                          >
                            <span style={styles.ganttPartySize}>{booking.people}</span>
                            {flagIcons && <span>{flagIcons}</span>}
                            {displayText && <span style={styles.ganttBarText}>{displayText}</span>}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              <h3>All Bookings ({bookings.length})</h3>
              <div style={styles.tableContainer}>
                {(() => {
                  // Group bookings by service period
                  const grouped = bookings.reduce((acc, booking) => {
                    const period = getDisplayName(booking.opening_hour_name || 'Unknown')
                    if (!acc[period]) {
                      acc[period] = []
                    }
                    acc[period].push(booking)
                    return acc
                  }, {} as Record<string, Booking[]>)

                  // Sort groups by first booking time, then sort bookings within each group
                  const sortedGroups = Object.entries(grouped)
                    .map(([period, bookings]) => ({
                      period,
                      bookings: bookings.sort((a, b) => a.booking_time.localeCompare(b.booking_time)),
                      firstTime: bookings[0]?.booking_time || ''
                    }))
                    .sort((a, b) => a.firstTime.localeCompare(b.firstTime))

                  return sortedGroups.map(({ period, bookings }) => (
                    <div key={period} style={styles.serviceGroup}>
                      <h4 style={styles.serviceGroupTitle}>{period}</h4>
                      <table style={styles.bookingsTable}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Time</th>
                            <th style={styles.th}>Area</th>
                            <th style={styles.th}>Table</th>
                            <th style={styles.th}>Covers</th>
                            <th style={styles.th}>Hotel Guest</th>
                            <th style={styles.th}>DBB/Package</th>
                            <th style={styles.th}>Allergies</th>
                            <th style={styles.th}>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bookings.map(booking => {
                            const allergyIcon = booking.allergies && booking.flag_reasons?.includes('allergies') ? getFlagIcon('allergies') : ''
                            const noteIcon = booking.notes ? '📝' : ''
                            const noteFlagged = isNoteFlagged(booking.flag_reasons)
                            const isExpanded = expandedNotes.has(booking.id)
                            const shouldShowNotes = booking.notes && (isExpanded || noteFlagged)
                            const isLarge = isLargeGroup(booking.people)
                            const largeGroupIcon = isLarge ? getLargeGroupIcon() : ''
                            const { hasKeywords, matchedKeyword } = notesContainKeywords(booking.notes)
                            const keywordIcon = hasKeywords && matchedKeyword ? getIconForFlag(`note_keyword_${matchedKeyword}`) : ''

                            return (
                              <>
                                <tr key={booking.id}>
                                  <td style={styles.td}>{booking.booking_time}</td>
                                  <td style={styles.td}>{booking.seating_area || '-'}</td>
                                  <td style={styles.td}>{booking.table_name || '-'}</td>
                                  <td style={isLarge ? styles.highlightCell : styles.td}>
                                    {booking.people}
                                    {largeGroupIcon && <span style={{ marginLeft: '0.25rem' }}>{largeGroupIcon}</span>}
                                  </td>
                                  <td style={styles.td}>
                                    {booking.is_hotel_guest ? '✓' : '-'}
                                  </td>
                                  <td style={styles.td}>
                                    {booking.is_dbb && booking.is_package ? 'DBB + Pkg' :
                                     booking.is_dbb ? 'DBB' :
                                     booking.is_package ? 'Package' : '-'}
                                  </td>
                                  <td style={booking.allergies ? styles.highlightCell : styles.td}>
                                    {allergyIcon && <span style={{ marginRight: '0.25rem' }}>{allergyIcon}</span>}
                                    {booking.allergies || '-'}
                                  </td>
                                  <td
                                    style={(noteFlagged || hasKeywords) ? styles.highlightCell : styles.td}
                                    onClick={() => booking.notes && toggleNoteExpansion(booking.id)}
                                  >
                                    {noteIcon && <span style={styles.clickableIcon}>{noteIcon}</span>}
                                    {keywordIcon && <span style={{ ...styles.clickableIcon, marginLeft: '0.25rem' }}>{keywordIcon}</span>}
                                    {!booking.notes && '-'}
                                  </td>
                                </tr>
                                {shouldShowNotes && (
                                  <tr key={`${booking.id}-notes`}>
                                    <td colSpan={4} style={styles.emptyIndentCell}></td>
                                    <td colSpan={4} style={styles.notesRow}>
                                      <strong>Notes:</strong> {booking.notes}
                                    </td>
                                  </tr>
                                )}
                                {booking.allergies && (
                                  <tr key={`${booking.id}-allergies`}>
                                    <td colSpan={4} style={styles.emptyIndentCell}></td>
                                    <td colSpan={4} style={styles.allergiesRow}>
                                      <strong>Allergies:</strong> {booking.allergies}
                                    </td>
                                  </tr>
                                )}
                              </>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    maxWidth: '1400px',
    margin: '0 auto',
  },
  title: {
    fontSize: '2rem',
    fontWeight: 'bold',
    marginBottom: '0.5rem',
  },
  subtitle: {
    color: '#666',
    marginBottom: '2rem',
  },
  navBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '2rem',
    padding: '1rem',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  navButton: {
    padding: '0.5rem 1rem',
    background: '#f0f0f0',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  todayButton: {
    padding: '0.5rem 1rem',
    background: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  monthYearDisplay: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  loading: {
    padding: '2rem',
    textAlign: 'center',
    background: 'white',
    borderRadius: '8px',
  },
  calendar: {
    background: 'white',
    borderRadius: '8px',
    padding: '1rem',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  calendarHeader: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  dayHeader: {
    padding: '0.5rem',
    textAlign: 'center',
    fontWeight: 'bold',
    color: '#666',
  },
  calendarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0.5rem',
  },
  emptyCell: {
    minHeight: '100px',
  },
  dayCell: {
    minHeight: '100px',
    padding: '0.5rem',
    border: '1px solid #e0e0e0',
    borderRadius: '4px',
    cursor: 'default',
    background: '#fafafa',
  },
  dayCellWithData: {
    background: 'white',
    cursor: 'pointer',
    transition: 'transform 0.2s, box-shadow 0.2s',
  },
  dayCellToday: {
    borderColor: '#0066cc',
    borderWidth: '2px',
  },
  dayCellFlagged: {
    borderLeftColor: '#e94560',
    borderLeftWidth: '4px',
  },
  dayCellForecast: {
    background: '#f0f8ff',
  },
  dayNumber: {
    fontSize: '1.1rem',
    fontWeight: 'bold',
    marginBottom: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.25rem',
  },
  flagIcon: {
    fontSize: '1rem',
  },
  dayStats: {
    fontSize: '0.85rem',
    color: '#333',
  },
  statLine: {
    marginBottom: '0.25rem',
  },
  serviceBreakdown: {
    marginTop: '0.5rem',
    fontSize: '0.75rem',
    color: '#666',
  },
  serviceLine: {
    marginBottom: '0.2rem',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'white',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '1000px',
    maxHeight: '90vh',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    padding: '2rem',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    paddingBottom: '1rem',
    borderBottom: '2px solid #e0e0e0',
    flexShrink: 0,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: '2rem',
    cursor: 'pointer',
    color: '#666',
    lineHeight: 1,
  },
  modalContent: {
    marginTop: '1rem',
    flex: 1,
    overflowY: 'scroll',
    scrollbarGutter: 'stable',
    paddingRight: '0.5rem',
  },
  flaggedSection: {
    background: '#fffbcc',
    borderLeft: '4px solid #e94560',
    padding: '1rem',
    marginBottom: '2rem',
    borderRadius: '4px',
  },
  flaggedTitle: {
    marginTop: 0,
    marginBottom: '1rem',
    color: '#c82333',
  },
  flaggedBooking: {
    marginBottom: '1rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid #f0d000',
  },
  bookingHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  bookingIcon: {
    marginRight: '0.5rem',
    fontSize: '1.2rem',
  },
  partySize: {
    background: '#fff',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    fontWeight: 'bold',
  },
  allergyBadge: {
    background: '#f8d7da',
    color: '#721c24',
    padding: '0.5rem',
    borderRadius: '4px',
    marginTop: '0.5rem',
    fontSize: '0.9rem',
  },
  noteText: {
    fontStyle: 'italic',
    color: '#666',
    marginTop: '0.5rem',
    fontSize: '0.9rem',
  },
  flagReasons: {
    fontSize: '0.85rem',
    color: '#666',
    marginTop: '0.5rem',
  },
  hotelInfo: {
    fontSize: '0.9rem',
    color: '#666',
    marginTop: '0.5rem',
  },
  tableContainer: {
    overflowX: 'auto',
    marginTop: '1rem',
  },
  bookingsTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  th: {
    padding: '0.75rem',
    textAlign: 'left',
    borderBottom: '2px solid #ddd',
    fontWeight: 'bold',
    background: '#f8f9fa',
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
  },
  flaggedRow: {
    background: '#fffbcc',
  },
  serviceGroup: {
    marginBottom: '1.5rem',
  },
  serviceGroupTitle: {
    fontSize: '1.1rem',
    fontWeight: 'bold',
    marginBottom: '0.5rem',
    padding: '0.5rem',
    background: '#f0f0f0',
    borderRadius: '4px',
  },
  highlightCell: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
    background: '#fffbcc',
  },
  clickableIcon: {
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: '1.2rem',
  },
  emptyIndentCell: {
    padding: 0,
    borderTop: 'none',
    borderBottom: '2px solid #ddd',
    background: 'transparent',
  },
  notesRow: {
    padding: '0.75rem',
    background: '#f8f9fa',
    borderTop: 'none',
    borderBottom: '2px solid #ddd',
    fontSize: '0.9rem',
    fontStyle: 'italic',
    color: '#555',
  },
  allergiesRow: {
    padding: '0.75rem',
    background: '#fff3cd',
    borderTop: 'none',
    borderBottom: '2px solid #ddd',
    fontSize: '0.9rem',
    color: '#856404',
  },
  ganttContainer: {
    marginBottom: '1.5rem',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    overflow: 'hidden',
    padding: '0.75rem',
    background: '#f9fafb',
  },
  ganttTimeAxis: {
    position: 'relative',
    height: '30px',
    borderBottom: '1px solid #ddd',
    background: '#f9f9f9',
    marginBottom: '0.5rem',
  },
  ganttTimeLabel: {
    position: 'absolute',
    top: '8px',
    transform: 'translateX(-50%)',
    fontSize: '11px',
    color: '#666',
    whiteSpace: 'nowrap',
  },
  ganttBookings: {
    position: 'relative',
    background: 'white',
  },
  ganttBookingBar: {
    position: 'absolute',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderRadius: '4px',
    border: '2px solid #5568d3',
    padding: '4px 8px',
    color: 'white',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'transform 0.2s',
    zIndex: 2,  // In front of closed blocks
  },
  ganttPartySize: {
    background: 'rgba(255,255,255,0.3)',
    borderRadius: '3px',
    padding: '2px 6px',
    fontSize: '11px',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  ganttBarText: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontSize: '11px',
  },
  ganttIntervalLine: {
    position: 'absolute',
    width: '1px',
    background: '#e5e5e5',
    top: 0,
    pointerEvents: 'none',
    zIndex: 1,  // Between closed blocks and bookings
  },
  ganttClosedBlock: {
    position: 'absolute',
    background: 'rgba(100, 100, 100, 0.1)',  // Darker grey for outside hours
    top: 0,
    pointerEvents: 'none',
    zIndex: 0,  // Behind booking bars
  },
  chartContainer: {
    background: 'white',
    borderRadius: '8px',
    padding: '1.5rem',
    marginTop: '2rem',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  chartTitle: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    marginBottom: '1rem',
  },
  chartSubtitle: {
    fontSize: '1.1rem',
    fontWeight: '600',
    marginBottom: '0.5rem',
  },
  chartGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '2rem',
    marginBottom: '1rem',
  },
  chart: {
    border: '1px solid #e5e7eb',
    borderRadius: '4px',
  },
  chartLegend: {
    display: 'flex',
    gap: '2rem',
    justifyContent: 'center',
    marginTop: '1rem',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.9rem',
  },
  legendLine: {
    width: '30px',
    height: '3px',
    display: 'inline-block',
  },
}
