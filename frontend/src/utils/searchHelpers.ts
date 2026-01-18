/**
 * Search utilities for session storage persistence and debouncing.
 */
import { useState, useEffect } from 'react'

// Session storage keys for search state persistence
export const SEARCH_STORAGE_KEYS = {
  invoices: {
    query: 'search-invoices-query',
    includeLineItems: 'search-invoices-include-line-items',
    supplier: 'search-invoices-supplier',
    status: 'search-invoices-status',
    dateFrom: 'search-invoices-from',
    dateTo: 'search-invoices-to',
    groupBy: 'search-invoices-group',
    sortColumn: 'search-invoices-sort-column',
    sortDirection: 'search-invoices-sort-direction',
  },
  lineItems: {
    query: 'search-line-items-query',
    supplier: 'search-line-items-supplier',
    dateFrom: 'search-line-items-from',
    dateTo: 'search-line-items-to',
    groupBy: 'search-line-items-group',
    priceChangeFilter: 'search-line-items-price-change',
    sortColumn: 'search-line-items-sort-column',
    sortDirection: 'search-line-items-sort-direction',
  },
  definitions: {
    query: 'search-definitions-query',
    supplier: 'search-definitions-supplier',
    hasPortions: 'search-definitions-has-portions',
    sortColumn: 'search-definitions-sort-column',
    sortDirection: 'search-definitions-sort-direction',
  },
}

/**
 * Custom hook for debouncing a value.
 * Used for live search to delay API calls while user is typing.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}

/**
 * Get default date range for searches (last 30 days).
 */
export function getDefaultDateRange(): { from: string; to: string } {
  const today = new Date()
  const threeMonthsAgo = new Date(today)
  threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90)

  return {
    from: threeMonthsAgo.toISOString().split('T')[0],
    to: today.toISOString().split('T')[0],
  }
}

/**
 * Format a date string for display (DD/MM/YYYY format).
 */
export function formatDateForDisplay(dateString: string | null | undefined): string {
  if (!dateString) return '-'
  try {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return dateString
  }
}

/**
 * Format currency for display.
 */
export function formatCurrency(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return '-'
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) return '-'
  return `£${num.toFixed(2)}`
}

/**
 * Format percentage for display.
 */
export function formatPercent(percent: number | string | null | undefined): string {
  if (percent === null || percent === undefined) return '-'
  const num = typeof percent === 'string' ? parseFloat(percent) : percent
  if (isNaN(num)) return '-'
  const sign = num >= 0 ? '+' : ''
  return `${sign}${num.toFixed(1)}%`
}

/**
 * Format quantity for display.
 */
export function formatQuantity(qty: number | string | null | undefined, decimals: number = 1): string {
  if (qty === null || qty === undefined) return '-'
  const num = typeof qty === 'string' ? parseFloat(qty) : qty
  if (isNaN(num)) return '-'
  return num.toFixed(decimals)
}

/**
 * Get stored value from session storage with fallback.
 */
export function getStoredValue<T>(key: string, fallback: T): T {
  try {
    const stored = sessionStorage.getItem(key)
    if (stored === null) return fallback
    return JSON.parse(stored) as T
  } catch {
    return fallback
  }
}

/**
 * Store value in session storage.
 */
export function setStoredValue<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage errors
  }
}

/**
 * Custom hook for persisted state in session storage.
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => getStoredValue(key, initialValue))

  useEffect(() => {
    setStoredValue(key, state)
  }, [key, state])

  return [state, setState]
}

/**
 * Price status icon and color mapping.
 */
export const PRICE_STATUS_CONFIG = {
  consistent: {
    icon: '✓',
    color: '#22c55e', // green
    label: 'Price consistent',
  },
  amber: {
    icon: '?',
    color: '#f59e0b', // amber
    label: 'Small price change',
  },
  red: {
    icon: '!',
    color: '#ef4444', // red
    label: 'Large price change',
  },
  acknowledged: {
    icon: '✓',
    color: '#22c55e', // green (acknowledged = now consistent)
    label: 'Price acknowledged',
  },
  no_history: {
    icon: null,
    color: '#9ca3af', // gray
    label: 'No price history',
  },
}

/**
 * Get price status display config.
 */
export function getPriceStatusConfig(status: string | null | undefined) {
  if (!status) return PRICE_STATUS_CONFIG.no_history
  return PRICE_STATUS_CONFIG[status as keyof typeof PRICE_STATUS_CONFIG] || PRICE_STATUS_CONFIG.no_history
}
