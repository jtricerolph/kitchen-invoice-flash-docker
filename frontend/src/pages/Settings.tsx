import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'
import Suppliers from '../components/Suppliers'

interface SettingsData {
  azure_endpoint: string | null
  azure_key_set: boolean
  currency_symbol: string
  date_format: string
  high_quantity_threshold: number
  // SMTP settings
  smtp_host: string | null
  smtp_port: number | null
  smtp_username: string | null
  smtp_password_set: boolean
  smtp_use_tls: boolean
  smtp_from_email: string | null
  smtp_from_name: string | null
  support_email: string | null
  // Dext integration
  dext_email: string | null
  dext_include_notes: boolean
  dext_include_non_stock: boolean
  dext_auto_send_enabled: boolean
  dext_manual_send_enabled: boolean
  dext_include_annotations: boolean
  // PDF annotation settings
  pdf_annotations_enabled: boolean
  pdf_preview_show_annotations: boolean
  // OCR post-processing options
  ocr_clean_product_codes: boolean
  ocr_filter_subtotal_rows: boolean
  ocr_use_weight_as_quantity: boolean
}

interface NewbookSettingsData {
  newbook_api_username: string | null
  newbook_api_password_set: boolean
  newbook_api_key_set: boolean
  newbook_api_region: string | null
  newbook_instance_id: string | null
  newbook_last_sync: string | null
  newbook_auto_sync_enabled: boolean
  newbook_upcoming_sync_enabled: boolean
  newbook_upcoming_sync_interval: number
  newbook_last_upcoming_sync: string | null
  newbook_breakfast_gl_codes: string | null
  newbook_dinner_gl_codes: string | null
  newbook_breakfast_vat_rate: string | null
  newbook_dinner_vat_rate: string | null
}

interface ResosSettingsData {
  resos_api_key_set: boolean
  resos_last_sync: string | null
  resos_auto_sync_enabled: boolean
  resos_upcoming_sync_enabled: boolean
  resos_upcoming_sync_interval: number
  resos_last_upcoming_sync: string | null
  resos_large_group_threshold: number
  resos_note_keywords: string | null
  resos_allergy_keywords: string | null
  resos_custom_field_mapping: Record<string, string> | null
  resos_opening_hours_mapping: Array<{resos_id: string; display_name: string; actual_end: string}> | null
  resos_restaurant_table_entities: string | null
  resos_arrival_widget_service_filter: string | null
  resos_enable_manual_breakfast: boolean
  resos_manual_breakfast_periods: Array<{day: number; start: string; end: string}> | null
  sambapos_food_gl_codes: string | null  // Phase 8.1
  sambapos_beverage_gl_codes: string | null  // Phase 8.1
}

interface GLAccount {
  id: number
  gl_account_id: string
  gl_code: string | null
  gl_name: string
  gl_type: string | null
  gl_group_id: string | null
  gl_group_name: string | null
  is_tracked: boolean
  display_order: number
}

interface RoomCategory {
  id: number
  site_id: string
  site_name: string
  site_type: string | null
  room_count: number
  is_included: boolean
  display_order: number
}

interface UserData {
  id: number
  email: string
  name: string | null
  is_active: boolean
  is_admin: boolean
  created_at: string
}

type SettingsSection = 'account' | 'users' | 'access' | 'display' | 'azure' | 'email' | 'inbox' | 'dext' | 'newbook' | 'resos' | 'sambapos' | 'kds' | 'suppliers' | 'search' | 'nextcloud' | 'backup' | 'data'

interface SambaPOSSettingsData {
  sambapos_db_host: string | null
  sambapos_db_port: number | null
  sambapos_db_name: string | null
  sambapos_db_username: string | null
  sambapos_db_password_set: boolean
  sambapos_tracked_categories: string[]
  sambapos_excluded_items: string[]
}

interface SambaPOSCategory {
  id: number
  name: string
}

interface SambaPOSGroupCode {
  name: string
}

interface SambaPOSGLCode {
  code: string
}

interface KDSSettingsData {
  kds_enabled: boolean
  kds_graphql_url: string | null
  kds_graphql_username: string | null
  kds_graphql_password_set?: boolean
  kds_graphql_client_id: string | null
  kds_poll_interval_seconds: number
  kds_timer_green_seconds: number
  kds_timer_amber_seconds: number
  kds_timer_red_seconds: number
  kds_course_order: string[]
  kds_show_completed_for_seconds: number
}

interface NextcloudSettingsData {
  nextcloud_host: string | null
  nextcloud_username: string | null
  nextcloud_password_set: boolean
  nextcloud_base_path: string | null
  nextcloud_enabled: boolean
  nextcloud_delete_local: boolean
}

interface NextcloudStatsData {
  pending_count: number
  archived_count: number
  local_count: number
  nextcloud_enabled: boolean
  nextcloud_configured: boolean
}

interface BackupSettingsData {
  backup_frequency: string | null
  backup_retention_count: number
  backup_destination: string | null
  backup_time: string | null
  backup_nextcloud_path: string | null
  backup_smb_host: string | null
  backup_smb_share: string | null
  backup_smb_username: string | null
  backup_smb_password_set: boolean
  backup_smb_path: string | null
  backup_last_run_at: string | null
  backup_last_status: string | null
  backup_last_error: string | null
}

interface BackupHistoryEntry {
  id: number
  backup_type: string
  destination: string
  status: string
  filename: string
  file_size_bytes: number | null
  invoice_count: number | null
  file_count: number | null
  started_at: string
  completed_at: string | null
  error_message: string | null
  triggered_by_username: string | null
}

interface SearchSettingsData {
  price_change_lookback_days: number
  price_change_amber_threshold: number
  price_change_red_threshold: number
}

interface ImapSettingsData {
  imap_host: string | null
  imap_port: number | null
  imap_use_ssl: boolean
  imap_username: string | null
  imap_password_set: boolean
  imap_folder: string | null
  imap_poll_interval: number
  imap_enabled: boolean
  imap_confidence_threshold: number | null
  imap_last_sync: string | null
}

interface ImapLogEntry {
  id: number
  message_id: string
  email_subject: string | null
  email_from: string | null
  email_date: string | null
  attachments_count: number
  invoices_created: number
  confident_invoices: number
  marked_as_read: boolean
  processing_status: string
  error_message: string | null
  invoice_ids: number[] | null
  processed_at: string
}

interface ImapSyncStats {
  last_24h: { emails_processed: number; invoices_created: number; confident_invoices: number }
  last_7d: { emails_processed: number; invoices_created: number; confident_invoices: number }
  last_30d: { emails_processed: number; invoices_created: number; confident_invoices: number }
}

export default function Settings() {
  const { user, token, logout, restrictedPages: authRestrictedPages } = useAuth()
  const queryClient = useQueryClient()
  const [activeSection, setActiveSection] = useState<SettingsSection>('account')

  // Azure state
  const [azureEndpoint, setAzureEndpoint] = useState('')
  const [azureKey, setAzureKey] = useState('')
  const [azureTestStatus, setAzureTestStatus] = useState<string | null>(null)
  // OCR post-processing options
  const [ocrCleanProductCodes, setOcrCleanProductCodes] = useState(false)
  const [ocrFilterSubtotalRows, setOcrFilterSubtotalRows] = useState(false)
  const [ocrUseWeightAsQuantity, setOcrUseWeightAsQuantity] = useState(false)

  // SMTP Email state
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [smtpUseTls, setSmtpUseTls] = useState(true)
  const [smtpFromEmail, setSmtpFromEmail] = useState('')
  const [smtpFromName, setSmtpFromName] = useState('Kitchen Invoice System')
  const [supportEmail, setSupportEmail] = useState('')
  const [smtpTestStatus, setSmtpTestStatus] = useState<string | null>(null)
  const [smtpSaveMessage, setSmtpSaveMessage] = useState<string | null>(null)

  // Dext integration state
  const [dextEmail, setDextEmail] = useState('')
  const [dextIncludeNotes, setDextIncludeNotes] = useState(true)
  const [dextIncludeNonStock, setDextIncludeNonStock] = useState(true)
  const [dextAutoSendEnabled, setDextAutoSendEnabled] = useState(false)
  const [dextManualSendEnabled, setDextManualSendEnabled] = useState(true)
  const [dextIncludeAnnotations, setDextIncludeAnnotations] = useState(true)
  const [dextSaveMessage, setDextSaveMessage] = useState<string | null>(null)

  // Display state
  const [currencySymbol, setCurrencySymbol] = useState('£')
  const [dateFormat, setDateFormat] = useState('DD/MM/YYYY')
  const [highQuantityThreshold, setHighQuantityThreshold] = useState(100)
  const [pdfAnnotationsEnabled, setPdfAnnotationsEnabled] = useState(true)
  const [pdfPreviewShowAnnotations, setPdfPreviewShowAnnotations] = useState(true)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Password state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null)

  // Data management state
  const [dataMessage, setDataMessage] = useState<string | null>(null)

  // Newbook state
  const [newbookUsername, setNewbookUsername] = useState('')
  const [newbookPassword, setNewbookPassword] = useState('')
  const [newbookApiKey, setNewbookApiKey] = useState('')
  const [newbookRegion, setNewbookRegion] = useState('au')
  const [newbookInstanceId, setNewbookInstanceId] = useState('')
  const [newbookBreakfastGLCodes, setNewbookBreakfastGLCodes] = useState('')
  const [newbookDinnerGLCodes, setNewbookDinnerGLCodes] = useState('')
  const [newbookBreakfastVatRate, setNewbookBreakfastVatRate] = useState('10')
  const [newbookDinnerVatRate, setNewbookDinnerVatRate] = useState('10')
  const [newbookTestStatus, setNewbookTestStatus] = useState<string | null>(null)
  const [newbookSaveMessage, setNewbookSaveMessage] = useState<string | null>(null)
  const [showGLModal, setShowGLModal] = useState(false)
  const [showRoomCategoryModal, setShowRoomCategoryModal] = useState(false)
  const [showHistoricalModal, setShowHistoricalModal] = useState(false)
  // Default to yesterday only for testing (reduces API load)
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]
  const [historicalDateFrom, setHistoricalDateFrom] = useState(yesterdayStr)
  const [historicalDateTo, setHistoricalDateTo] = useState(yesterdayStr)

  // Resos state
  const [resosApiKey, setResosApiKey] = useState('')
  // Note: resosAutoSyncEnabled, resosUpcomingSyncEnabled, resosUpcomingSyncInterval
  // are read directly from resosSettings and saved immediately via updateResosSyncMutation
  const [resosLargeGroupThreshold, setResosLargeGroupThreshold] = useState(8)
  const [resosNoteKeywords, setResosNoteKeywords] = useState('')
  const [resosAllergyKeywords, setResosAllergyKeywords] = useState('')
  const [resosTestStatus, setResosTestStatus] = useState<string | null>(null)
  const [resosSaveMessage, setResosSaveMessage] = useState<string | null>(null)
  const [customFields, setCustomFields] = useState<Array<{_id: string; name: string}>>([])
  const [openingHours, setOpeningHours] = useState<Array<{_id: string; name: string; startTime: string; endTime: string}>>([])
  const [customFieldMapping, setCustomFieldMapping] = useState<Record<string, string>>({})
  const [openingHoursMapping, setOpeningHoursMapping] = useState<Array<{resos_id: string; display_name: string; actual_end: string; service_type: string}>>([])
  const [resosArrivalWidgetServiceFilter, setResosArrivalWidgetServiceFilter] = useState<string | null>(null)
  const [resosEnableManualBreakfast, setResosEnableManualBreakfast] = useState(false)
  const [resosManualBreakfastPeriods, setResosManualBreakfastPeriods] = useState<Array<{day: number; start: string; end: string}>>([])
  const [showHistoricalResosModal, setShowHistoricalResosModal] = useState(false)
  const [historicalResosDateFrom, setHistoricalResosDateFrom] = useState(yesterdayStr)
  const [historicalResosDateTo, setHistoricalResosDateTo] = useState(yesterdayStr)

  // SambaPOS state
  const [sambaDbHost, setSambaDbHost] = useState('')
  const [sambaDbPort, setSambaDbPort] = useState('1433')
  const [sambaDbName, setSambaDbName] = useState('')
  const [sambaDbUsername, setSambaDbUsername] = useState('')
  const [sambaDbPassword, setSambaDbPassword] = useState('')
  const [sambaTestStatus, setSambaTestStatus] = useState<string | null>(null)
  const [sambaSaveMessage, setSambaSaveMessage] = useState<string | null>(null)
  // Courses stored as array to preserve order
  const [sambaSelectedCourses, setSambaSelectedCourses] = useState<string[]>([])
  // Excluded menu items
  const [sambaExcludedItems, setSambaExcludedItems] = useState<Set<string>>(new Set())
  // GL codes for food/beverage classification (Phase 8)
  const [sambaFoodGLCodes, setSambaFoodGLCodes] = useState<Set<string>>(new Set())
  const [sambaBeverageGLCodes, setSambaBeverageGLCodes] = useState<Set<string>>(new Set())
  const [sambaGLCodesSaveMessage, setSambaGLCodesSaveMessage] = useState<string | null>(null)

  // KDS state
  const [kdsGraphqlUrl, setKdsGraphqlUrl] = useState('')
  const [kdsGraphqlUsername, setKdsGraphqlUsername] = useState('')
  const [kdsGraphqlPassword, setKdsGraphqlPassword] = useState('')
  const [kdsGraphqlClientId, setKdsGraphqlClientId] = useState('')
  const [kdsPollInterval, setKdsPollInterval] = useState(5)
  const [kdsTimerGreen, setKdsTimerGreen] = useState(300)
  const [kdsTimerAmber, setKdsTimerAmber] = useState(600)
  const [kdsTimerRed, setKdsTimerRed] = useState(900)
  const [kdsCourseOrder, setKdsCourseOrder] = useState('Starters, Mains, Desserts')
  const [kdsShowCompleted, setKdsShowCompleted] = useState(30)
  const [kdsTestStatus, setKdsTestStatus] = useState<string | null>(null)
  const [kdsSaveMessage, setKdsSaveMessage] = useState<string | null>(null)

  // Nextcloud state
  const [nextcloudHost, setNextcloudHost] = useState('')
  const [nextcloudUsername, setNextcloudUsername] = useState('')
  const [nextcloudPassword, setNextcloudPassword] = useState('')
  const [nextcloudBasePath, setNextcloudBasePath] = useState('/Kitchen Invoices')
  const [nextcloudEnabled, setNextcloudEnabled] = useState(false)
  const [nextcloudDeleteLocal, setNextcloudDeleteLocal] = useState(false)
  const [nextcloudTestStatus, setNextcloudTestStatus] = useState<string | null>(null)
  const [nextcloudSaveMessage, setNextcloudSaveMessage] = useState<string | null>(null)
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null)

  // Backup state
  const [backupFrequency, setBackupFrequency] = useState('manual')
  const [backupRetentionCount, setBackupRetentionCount] = useState(7)
  const [backupDestination, setBackupDestination] = useState('local')
  const [backupTime, setBackupTime] = useState('03:00')
  const [backupNextcloudPath, setBackupNextcloudPath] = useState('/Backups')
  const [backupSmbHost, setBackupSmbHost] = useState('')
  const [backupSmbShare, setBackupSmbShare] = useState('')
  const [backupSmbUsername, setBackupSmbUsername] = useState('')
  const [backupSmbPassword, setBackupSmbPassword] = useState('')
  const [backupSmbPath, setBackupSmbPath] = useState('/backups')
  const [backupSaveMessage, setBackupSaveMessage] = useState<string | null>(null)
  const [backupCreateMessage, setBackupCreateMessage] = useState<string | null>(null)

  // Search settings state
  const [priceLookbackDays, setPriceLookbackDays] = useState(30)
  const [priceAmberThreshold, setPriceAmberThreshold] = useState(10)
  const [priceRedThreshold, setPriceRedThreshold] = useState(20)
  const [searchSaveMessage, setSearchSaveMessage] = useState<string | null>(null)

  // IMAP Email Inbox state
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [imapUseSsl, setImapUseSsl] = useState(true)
  const [imapUsername, setImapUsername] = useState('')
  const [imapPassword, setImapPassword] = useState('')
  const [imapFolder, setImapFolder] = useState('INBOX')
  const [imapPollInterval, setImapPollInterval] = useState(15)
  const [imapEnabled, setImapEnabled] = useState(false)
  const [imapConfidenceThreshold, setImapConfidenceThreshold] = useState(50)
  const [imapTestStatus, setImapTestStatus] = useState<string | null>(null)
  const [imapSaveMessage, setImapSaveMessage] = useState<string | null>(null)
  const [imapSyncMessage, setImapSyncMessage] = useState<string | null>(null)

  // Fetch settings
  const { data: settings, isLoading } = useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    },
  })

  // Fetch Newbook settings
  const { data: newbookSettings, error: newbookError, isLoading: newbookLoading } = useQuery<NewbookSettingsData>({
    queryKey: ['newbook-settings'],
    queryFn: async () => {
      const res = await fetch('/api/newbook/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const errorText = await res.text()
        console.error('Newbook settings fetch failed:', res.status, errorText)
        throw new Error(`Failed to fetch: ${res.status}`)
      }
      const data = await res.json()
      console.log('[Newbook] GET settings response:', { upcoming_sync_enabled: data.newbook_upcoming_sync_enabled })
      return data
    },
    staleTime: 0, // Always fetch fresh data
  })

  // Fetch Resos settings
  const { data: resosSettings, error: resosError, isLoading: resosLoading } = useQuery<ResosSettingsData>({
    queryKey: ['resos-settings'],
    queryFn: async () => {
      const res = await fetch('/api/resos/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const errorText = await res.text()
        console.error('Resos settings fetch failed:', res.status, errorText)
        throw new Error(`Failed to fetch: ${res.status}`)
      }
      const data = await res.json()
      return data
    },
    staleTime: 0,
  })

  // Fetch GL accounts
  const { data: glAccounts, refetch: refetchGLAccounts } = useQuery<GLAccount[]>({
    queryKey: ['gl-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/newbook/gl-accounts', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
  })

  // Fetch room categories
  const { data: roomCategories, refetch: refetchRoomCategories } = useQuery<RoomCategory[]>({
    queryKey: ['room-categories'],
    queryFn: async () => {
      const res = await fetch('/api/newbook/room-categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return res.json()
    },
  })

  // Fetch users (admin only)
  const { data: users } = useQuery<UserData[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/auth/users', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        if (res.status === 403) return []
        throw new Error('Failed to fetch users')
      }
      return res.json()
    },
    enabled: !!user?.is_admin,
  })

  // Fetch SambaPOS settings
  const { data: sambaSettings } = useQuery<SambaPOSSettingsData>({
    queryKey: ['sambapos-settings'],
    queryFn: async () => {
      const res = await fetch('/api/sambapos/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch SambaPOS settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch SambaPOS categories (only when connection is configured)
  const { data: sambaCategories, refetch: refetchSambaCategories, isLoading: sambaCategoriesLoading, error: sambaCategoriesError } = useQuery<SambaPOSCategory[]>({
    queryKey: ['sambapos-categories'],
    queryFn: async () => {
      const res = await fetch('/api/sambapos/categories', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to fetch categories')
      }
      return res.json()
    },
    enabled: !!token && !!sambaSettings?.sambapos_db_host && !!sambaSettings?.sambapos_db_password_set,
    retry: false,
  })

  // Fetch SambaPOS group codes for exclusion (only when connection is configured)
  const { data: sambaGroupCodes, refetch: refetchSambaGroupCodes, isLoading: sambaGroupCodesLoading } = useQuery<SambaPOSGroupCode[]>({
    queryKey: ['sambapos-group-codes'],
    queryFn: async () => {
      const res = await fetch('/api/sambapos/group-codes', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to fetch group codes')
      }
      return res.json()
    },
    enabled: !!token && !!sambaSettings?.sambapos_db_host && !!sambaSettings?.sambapos_db_password_set,
    retry: false,
  })

  // Fetch SambaPOS GL codes for food/beverage classification (Phase 8)
  const { data: sambaGLCodes, refetch: refetchSambaGLCodes, isLoading: sambaGLCodesLoading } = useQuery<SambaPOSGLCode[]>({
    queryKey: ['sambapos-gl-codes'],
    queryFn: async () => {
      const res = await fetch('/api/sambapos/gl-codes', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to fetch GL codes')
      }
      return res.json()
    },
    enabled: !!token && !!sambaSettings?.sambapos_db_host && !!sambaSettings?.sambapos_db_password_set,
    retry: false,
  })

  // Fetch selected GL codes
  const { data: selectedGLCodes } = useQuery<{ food_codes: string[]; beverage_codes: string[] }>({
    queryKey: ['sambapos-selected-gl-codes'],
    queryFn: async () => {
      const res = await fetch('/api/sambapos/gl-codes/selected', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch selected GL codes')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch KDS settings
  const { data: kdsSettings } = useQuery<KDSSettingsData>({
    queryKey: ['kds-settings'],
    queryFn: async () => {
      const res = await fetch('/api/kds/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch KDS settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch page restrictions
  const { data: pageRestrictions } = useQuery<{ restricted_pages: string[] }>({
    queryKey: ['page-restrictions'],
    queryFn: async () => {
      const res = await fetch('/api/settings/page-restrictions', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch page restrictions')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch Nextcloud settings
  const { data: nextcloudSettings } = useQuery<NextcloudSettingsData>({
    queryKey: ['nextcloud-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/nextcloud', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch Nextcloud settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch Nextcloud archive stats
  const { data: nextcloudStats } = useQuery<NextcloudStatsData>({
    queryKey: ['nextcloud-stats'],
    queryFn: async () => {
      const res = await fetch('/api/settings/nextcloud/stats', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch Nextcloud stats')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch Backup settings
  const { data: backupSettings } = useQuery<BackupSettingsData>({
    queryKey: ['backup-settings'],
    queryFn: async () => {
      const res = await fetch('/api/backup/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch backup settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch Backup history
  const { data: backupHistory } = useQuery<BackupHistoryEntry[]>({
    queryKey: ['backup-history'],
    queryFn: async () => {
      const res = await fetch('/api/backup/history', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch backup history')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch Search settings
  const { data: searchSettings } = useQuery<SearchSettingsData>({
    queryKey: ['search-settings'],
    queryFn: async () => {
      const res = await fetch('/api/search/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch search settings')
      return res.json()
    },
    enabled: !!token,
  })

  // Fetch IMAP settings
  const { data: imapSettings } = useQuery<ImapSettingsData>({
    queryKey: ['imap-settings'],
    queryFn: async () => {
      const res = await fetch('/api/imap/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch IMAP settings')
      return res.json()
    },
    enabled: !!token && !!user?.is_admin,
  })

  // Fetch IMAP logs
  const { data: imapLogs } = useQuery<ImapLogEntry[]>({
    queryKey: ['imap-logs'],
    queryFn: async () => {
      const res = await fetch('/api/imap/logs?limit=20', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch IMAP logs')
      return res.json()
    },
    enabled: !!token && !!user?.is_admin && activeSection === 'inbox',
  })

  // Fetch IMAP sync stats
  const { data: imapStats } = useQuery<ImapSyncStats>({
    queryKey: ['imap-stats'],
    queryFn: async () => {
      const res = await fetch('/api/imap/logs/stats', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to fetch IMAP stats')
      return res.json()
    },
    enabled: !!token && !!user?.is_admin && activeSection === 'inbox',
  })

  // State for page restrictions
  const [restrictedPages, setRestrictedPages] = useState<Set<string>>(new Set())
  const [accessSaveMessage, setAccessSaveMessage] = useState<string | null>(null)

  // Populate restricted pages from settings
  useEffect(() => {
    if (pageRestrictions?.restricted_pages) {
      setRestrictedPages(new Set(pageRestrictions.restricted_pages))
    }
  }, [pageRestrictions])

  useEffect(() => {
    if (settings) {
      setAzureEndpoint(settings.azure_endpoint || '')
      setCurrencySymbol(settings.currency_symbol)
      setDateFormat(settings.date_format)
      setHighQuantityThreshold(settings.high_quantity_threshold)
      // SMTP settings
      setSmtpHost(settings.smtp_host || '')
      setSmtpPort(String(settings.smtp_port || 587))
      setSmtpUsername(settings.smtp_username || '')
      setSmtpUseTls(settings.smtp_use_tls)
      setSmtpFromEmail(settings.smtp_from_email || '')
      setSmtpFromName(settings.smtp_from_name || 'Kitchen Invoice System')
      setSupportEmail(settings.support_email || '')
      // Dext settings
      setDextEmail(settings.dext_email || '')
      setDextIncludeNotes(settings.dext_include_notes)
      setDextIncludeNonStock(settings.dext_include_non_stock)
      setDextAutoSendEnabled(settings.dext_auto_send_enabled)
      setDextManualSendEnabled(settings.dext_manual_send_enabled)
      setDextIncludeAnnotations(settings.dext_include_annotations)
      // PDF annotation settings
      setPdfAnnotationsEnabled(settings.pdf_annotations_enabled)
      setPdfPreviewShowAnnotations(settings.pdf_preview_show_annotations)
      // OCR post-processing options
      setOcrCleanProductCodes(settings.ocr_clean_product_codes || false)
      setOcrFilterSubtotalRows(settings.ocr_filter_subtotal_rows || false)
      setOcrUseWeightAsQuantity(settings.ocr_use_weight_as_quantity || false)
    }
  }, [settings])

  // Populate Nextcloud settings
  useEffect(() => {
    if (nextcloudSettings) {
      setNextcloudHost(nextcloudSettings.nextcloud_host || '')
      setNextcloudUsername(nextcloudSettings.nextcloud_username || '')
      setNextcloudBasePath(nextcloudSettings.nextcloud_base_path || '/Kitchen Invoices')
      setNextcloudEnabled(nextcloudSettings.nextcloud_enabled)
      setNextcloudDeleteLocal(nextcloudSettings.nextcloud_delete_local)
    }
  }, [nextcloudSettings])

  // Populate Backup settings
  useEffect(() => {
    if (backupSettings) {
      setBackupFrequency(backupSettings.backup_frequency || 'manual')
      setBackupRetentionCount(backupSettings.backup_retention_count || 7)
      setBackupDestination(backupSettings.backup_destination || 'local')
      setBackupTime(backupSettings.backup_time || '03:00')
      setBackupNextcloudPath(backupSettings.backup_nextcloud_path || '/Backups')
      setBackupSmbHost(backupSettings.backup_smb_host || '')
      setBackupSmbShare(backupSettings.backup_smb_share || '')
      setBackupSmbUsername(backupSettings.backup_smb_username || '')
      setBackupSmbPath(backupSettings.backup_smb_path || '/backups')
    }
  }, [backupSettings])

  // Populate Search settings
  useEffect(() => {
    if (searchSettings) {
      setPriceLookbackDays(searchSettings.price_change_lookback_days || 30)
      setPriceAmberThreshold(searchSettings.price_change_amber_threshold || 10)
      setPriceRedThreshold(searchSettings.price_change_red_threshold || 20)
    }
  }, [searchSettings])

  // Populate IMAP settings
  useEffect(() => {
    if (imapSettings) {
      setImapHost(imapSettings.imap_host || '')
      setImapPort(String(imapSettings.imap_port || 993))
      setImapUseSsl(imapSettings.imap_use_ssl)
      setImapUsername(imapSettings.imap_username || '')
      setImapFolder(imapSettings.imap_folder || 'INBOX')
      setImapPollInterval(imapSettings.imap_poll_interval || 15)
      setImapEnabled(imapSettings.imap_enabled)
      setImapConfidenceThreshold((imapSettings.imap_confidence_threshold || 0.5) * 100)
    }
  }, [imapSettings])

  useEffect(() => {
    if (newbookSettings) {
      setNewbookUsername(newbookSettings.newbook_api_username || '')
      setNewbookRegion(newbookSettings.newbook_api_region || 'au')
      setNewbookInstanceId(newbookSettings.newbook_instance_id || '')
      setNewbookBreakfastGLCodes(newbookSettings.newbook_breakfast_gl_codes || '')
      setNewbookDinnerGLCodes(newbookSettings.newbook_dinner_gl_codes || '')
      // Convert decimal rate to percentage for display (e.g., 0.10 -> 10)
      setNewbookBreakfastVatRate(newbookSettings.newbook_breakfast_vat_rate ? String(parseFloat(newbookSettings.newbook_breakfast_vat_rate) * 100) : '10')
      setNewbookDinnerVatRate(newbookSettings.newbook_dinner_vat_rate ? String(parseFloat(newbookSettings.newbook_dinner_vat_rate) * 100) : '10')
    }
  }, [newbookSettings])

  // Populate SambaPOS form from settings
  useEffect(() => {
    if (sambaSettings) {
      setSambaDbHost(sambaSettings.sambapos_db_host || '')
      setSambaDbPort(String(sambaSettings.sambapos_db_port || 1433))
      setSambaDbName(sambaSettings.sambapos_db_name || '')
      setSambaDbUsername(sambaSettings.sambapos_db_username || '')
      // Use array to preserve order
      setSambaSelectedCourses(sambaSettings.sambapos_tracked_categories || [])
      setSambaExcludedItems(new Set(sambaSettings.sambapos_excluded_items || []))
    }
  }, [sambaSettings])

  // Populate GL codes from selected GL codes query (Phase 8)
  useEffect(() => {
    if (selectedGLCodes) {
      setSambaFoodGLCodes(new Set(selectedGLCodes.food_codes || []))
      setSambaBeverageGLCodes(new Set(selectedGLCodes.beverage_codes || []))
    }
  }, [selectedGLCodes])

  // Populate KDS form from settings
  useEffect(() => {
    if (kdsSettings) {
      setKdsGraphqlUrl(kdsSettings.kds_graphql_url || '')
      setKdsGraphqlUsername(kdsSettings.kds_graphql_username || '')
      setKdsGraphqlClientId(kdsSettings.kds_graphql_client_id || '')
      setKdsPollInterval(kdsSettings.kds_poll_interval_seconds || 5)
      setKdsTimerGreen(kdsSettings.kds_timer_green_seconds || 300)
      setKdsTimerAmber(kdsSettings.kds_timer_amber_seconds || 600)
      setKdsTimerRed(kdsSettings.kds_timer_red_seconds || 900)
      setKdsCourseOrder((kdsSettings.kds_course_order || ['Starters', 'Mains', 'Desserts']).join(', '))
      setKdsShowCompleted(kdsSettings.kds_show_completed_for_seconds || 30)
    }
  }, [kdsSettings])

  useEffect(() => {
    if (resosSettings) {
      // Note: sync settings (auto_sync_enabled, upcoming_sync_enabled, upcoming_sync_interval)
      // are now read directly from resosSettings, not local state
      setResosLargeGroupThreshold(resosSettings.resos_large_group_threshold || 8)
      setResosNoteKeywords(resosSettings.resos_note_keywords || '')
      setResosAllergyKeywords(resosSettings.resos_allergy_keywords || '')
      setCustomFieldMapping(resosSettings.resos_custom_field_mapping || {})
      setResosArrivalWidgetServiceFilter(resosSettings.resos_arrival_widget_service_filter || null)
      setResosEnableManualBreakfast(resosSettings.resos_enable_manual_breakfast || false)
      setResosManualBreakfastPeriods(resosSettings.resos_manual_breakfast_periods || [])
      // Ensure all mapping items have service_type property
      const mapping = (resosSettings.resos_opening_hours_mapping || []).map(m => ({
        resos_id: m.resos_id,
        display_name: m.display_name,
        actual_end: m.actual_end,
        service_type: (m as any).service_type || ''
      }))
      setOpeningHoursMapping(mapping)

      // Auto-fetch custom fields if mapping exists but fields list is empty
      if (resosSettings.resos_custom_field_mapping && Object.keys(resosSettings.resos_custom_field_mapping).length > 0 && customFields.length === 0) {
        fetch('/api/resos/custom-fields', {
          headers: { Authorization: `Bearer ${token}` }
        })
          .then(res => res.json())
          .then(data => setCustomFields(data.custom_fields || []))
          .catch(err => console.error('Failed to auto-fetch custom fields:', err))
      }

      // Auto-fetch opening hours if mapping exists but hours list is empty
      if (resosSettings.resos_opening_hours_mapping && resosSettings.resos_opening_hours_mapping.length > 0 && openingHours.length === 0) {
        fetch('/api/resos/opening-hours', {
          headers: { Authorization: `Bearer ${token}` }
        })
          .then(res => res.json())
          .then(data => setOpeningHours(data.opening_hours || []))
          .catch(err => console.error('Failed to auto-fetch opening hours:', err))
      }
    }
  }, [resosSettings])

  // Mutations
  const updateMutation = useMutation({
    mutationFn: async (data: Partial<SettingsData & { azure_key?: string }>) => {
      const res = await fetch('/api/settings/', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update settings')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setSaveMessage('Settings saved successfully')
      setAzureKey('')
      setTimeout(() => setSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSaveMessage(`Error: ${error.message}`)
    },
  })

  const azureTestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/test-azure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Connection test failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setAzureTestStatus(data.message)
      setTimeout(() => setAzureTestStatus(null), 5000)
    },
    onError: (error) => {
      setAzureTestStatus(`Error: ${error.message}`)
    },
  })

  const passwordMutation = useMutation({
    mutationFn: async (data: { current_password: string; new_password: string }) => {
      const res = await fetch('/auth/change-password', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.detail || 'Failed to change password')
      }
      return res.json()
    },
    onSuccess: () => {
      setPasswordMessage('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setPasswordMessage(null), 5000)
    },
    onError: (error) => {
      setPasswordMessage(`Error: ${error.message}`)
    },
  })

  const toggleUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      const res = await fetch(`/auth/users/${userId}/toggle-active`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to toggle user')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      const res = await fetch(`/auth/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to delete user')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const toggleAdminMutation = useMutation({
    mutationFn: async (userId: number) => {
      const res = await fetch(`/auth/users/${userId}/toggle-admin`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to toggle admin status')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const savePageRestrictionsMutation = useMutation({
    mutationFn: async (pages: string[]) => {
      const res = await fetch('/api/settings/page-restrictions', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ restricted_pages: pages }),
      })
      if (!res.ok) throw new Error('Failed to save page restrictions')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page-restrictions'] })
      setAccessSaveMessage('Page restrictions saved successfully')
      setTimeout(() => setAccessSaveMessage(null), 3000)
    },
    onError: (error) => {
      setAccessSaveMessage(`Error: ${error.message}`)
    },
  })

  const reprocessMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/invoices/reprocess-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to reprocess invoices')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setDataMessage(data.message)
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setTimeout(() => setDataMessage(null), 5000)
    },
    onError: (error) => {
      setDataMessage(`Error: ${error.message}`)
    },
  })

  const rematchFuzzyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/suppliers/rematch-fuzzy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to rematch invoices')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setDataMessage(data.message)
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setTimeout(() => setDataMessage(null), 5000)
    },
    onError: (error) => {
      setDataMessage(`Error: ${error.message}`)
    },
  })

  // Newbook mutations
  const updateNewbookMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      console.log('[Newbook] Sending PATCH with data:', data)
      const res = await fetch('/api/newbook/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const errorText = await res.text()
        console.error('[Newbook] PATCH failed:', res.status, errorText)
        throw new Error('Failed to update Newbook settings')
      }
      const result = await res.json()
      console.log('[Newbook] PATCH response:', result)
      return result
    },
    onSuccess: (data) => {
      console.log('[Newbook] Mutation success, response data:', data)
      queryClient.invalidateQueries({ queryKey: ['newbook-settings'] })
      setNewbookSaveMessage('Newbook settings saved')
      setNewbookPassword('')
      setNewbookApiKey('')
      setTimeout(() => setNewbookSaveMessage(null), 3000)
    },
    onError: (error) => {
      setNewbookSaveMessage(`Error: ${error.message}`)
    },
  })

  const newbookTestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/newbook/test-connection', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Connection test failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setNewbookTestStatus(data.message)
      setTimeout(() => setNewbookTestStatus(null), 5000)
    },
    onError: (error) => {
      setNewbookTestStatus(`Error: ${error.message}`)
    },
  })

  // Resos sync settings mutation (for immediate save on checkbox toggle)
  const updateResosSyncMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      console.log('[Resos] Sending PATCH with data:', data)
      const res = await fetch('/api/resos/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const errorText = await res.text()
        console.error('[Resos] PATCH failed:', res.status, errorText)
        throw new Error('Failed to update Resos settings')
      }
      const result = await res.json()
      console.log('[Resos] PATCH response:', result)
      return result
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resos-settings'] })
      setResosSaveMessage('✓ Sync settings saved')
      setTimeout(() => setResosSaveMessage(null), 3000)
    },
    onError: (error) => {
      setResosSaveMessage(`✗ Error: ${error.message}`)
      setTimeout(() => setResosSaveMessage(null), 5000)
    },
  })

  const fetchGLAccountsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/newbook/gl-accounts/fetch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to fetch GL accounts')
      }
      return res.json()
    },
    onSuccess: () => {
      refetchGLAccounts()
      setNewbookSaveMessage('GL accounts fetched successfully')
      setTimeout(() => setNewbookSaveMessage(null), 3000)
    },
    onError: (error) => {
      setNewbookSaveMessage(`Error: ${error.message}`)
    },
  })

  const syncForecastMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/newbook/sync/forecast', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Sync failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setNewbookSaveMessage(`Forecast sync complete: ${JSON.stringify(data.results)}`)
      queryClient.invalidateQueries({ queryKey: ['newbook-settings'] })
      setTimeout(() => setNewbookSaveMessage(null), 5000)
    },
    onError: (error) => {
      setNewbookSaveMessage(`Error: ${error.message}`)
    },
  })

  const syncHistoricalMutation = useMutation({
    mutationFn: async (dates: { date_from: string; date_to: string }) => {
      const res = await fetch('/api/newbook/sync/historical', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dates),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Sync failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setNewbookSaveMessage(`Historical sync complete: ${JSON.stringify(data.results)}`)
      setShowHistoricalModal(false)
      queryClient.invalidateQueries({ queryKey: ['newbook-settings'] })
      setTimeout(() => setNewbookSaveMessage(null), 5000)
    },
    onError: (error) => {
      setNewbookSaveMessage(`Error: ${error.message}`)
    },
  })

  const updateGLAccountMutation = useMutation({
    mutationFn: async ({ id, is_tracked }: { id: number; is_tracked: boolean }) => {
      const res = await fetch(`/api/newbook/gl-accounts/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_tracked }),
      })
      if (!res.ok) throw new Error('Failed to update GL account')
      return res.json()
    },
    onSuccess: () => {
      refetchGLAccounts()
    },
  })

  const bulkUpdateGLAccountsMutation = useMutation({
    mutationFn: async (updates: { id: number; is_tracked: boolean }[]) => {
      const res = await fetch('/api/newbook/gl-accounts/bulk-update', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ updates }),
      })
      if (!res.ok) throw new Error('Failed to update GL accounts')
      return res.json()
    },
    onSuccess: () => {
      refetchGLAccounts()
    },
  })

  // Room category mutations
  const fetchRoomCategoriesMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/newbook/room-categories/fetch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Failed to fetch room categories')
      }
      return res.json()
    },
    onSuccess: () => {
      refetchRoomCategories()
      setNewbookSaveMessage('Room categories fetched successfully')
      setTimeout(() => setNewbookSaveMessage(null), 3000)
    },
    onError: (error) => {
      setNewbookSaveMessage(`Error: ${error.message}`)
    },
  })

  const bulkUpdateRoomCategoriesMutation = useMutation({
    mutationFn: async (updates: { id: number; is_included: boolean }[]) => {
      const res = await fetch('/api/newbook/room-categories/bulk-update', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ updates }),
      })
      if (!res.ok) throw new Error('Failed to update room categories')
      return res.json()
    },
    onSuccess: () => {
      refetchRoomCategories()
    },
  })

  // SambaPOS mutations
  const updateSambaMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/sambapos/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to save SambaPOS settings')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sambapos-settings'] })
      setSambaSaveMessage('Settings saved successfully')
      setSambaDbPassword('')
      setTimeout(() => setSambaSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSambaSaveMessage(`Error: ${error.message}`)
    },
  })

  const sambaTestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/sambapos/test-connection', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || 'Connection test failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setSambaTestStatus(data.message)
      refetchSambaCategories()
      setTimeout(() => setSambaTestStatus(null), 5000)
    },
    onError: (error) => {
      setSambaTestStatus(`Error: ${error.message}`)
    },
  })

  const saveSambaCoursesMutation = useMutation({
    mutationFn: async (courses: string[]) => {
      const res = await fetch('/api/sambapos/tracked-categories', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ categories: courses }),
      })
      if (!res.ok) throw new Error('Failed to save courses')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sambapos-settings'] })
      setSambaSaveMessage('Courses saved successfully')
      setTimeout(() => setSambaSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSambaSaveMessage(`Error: ${error.message}`)
    },
  })

  const saveExcludedItemsMutation = useMutation({
    mutationFn: async (items: string[]) => {
      const res = await fetch('/api/sambapos/excluded-items', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error('Failed to save excluded categories')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sambapos-settings'] })
      setSambaSaveMessage('Excluded categories saved successfully')
      setTimeout(() => setSambaSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSambaSaveMessage(`Error: ${error.message}`)
    },
  })

  const saveGLCodesMutation = useMutation({
    mutationFn: async (data: { food_codes: string[]; beverage_codes: string[] }) => {
      const res = await fetch('/api/sambapos/gl-codes', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to save GL codes')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sambapos-selected-gl-codes'] })
      setSambaGLCodesSaveMessage('GL codes saved successfully')
      setTimeout(() => setSambaGLCodesSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSambaGLCodesSaveMessage(`Error: ${error.message}`)
    },
  })

  // KDS mutations
  const updateKdsMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/kds/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to save KDS settings')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kds-settings'] })
      setKdsSaveMessage('Settings saved successfully')
      setKdsGraphqlPassword('')
      setTimeout(() => setKdsSaveMessage(null), 3000)
    },
    onError: (error) => {
      setKdsSaveMessage(`Error: ${error.message}`)
    },
  })

  const kdsTestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/kds/test-connection', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!data.success) {
        throw new Error(data.error || 'Connection test failed')
      }
      return data
    },
    onSuccess: (data) => {
      setKdsTestStatus(data.message)
      setTimeout(() => setKdsTestStatus(null), 5000)
    },
    onError: (error) => {
      setKdsTestStatus(`Error: ${error.message}`)
    },
  })

  // Nextcloud mutations
  const saveNextcloudMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/settings/nextcloud', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to save Nextcloud settings')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nextcloud-settings'] })
      queryClient.invalidateQueries({ queryKey: ['nextcloud-stats'] })
      setNextcloudSaveMessage('Nextcloud settings saved successfully')
      setTimeout(() => setNextcloudSaveMessage(null), 3000)
    },
    onError: (error) => {
      setNextcloudSaveMessage(`Error: ${error.message}`)
    },
  })

  const nextcloudTestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/nextcloud/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Connection test failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setNextcloudTestStatus('Connection successful')
      setTimeout(() => setNextcloudTestStatus(null), 5000)
    },
    onError: (error) => {
      setNextcloudTestStatus(`Error: ${error.message}`)
    },
  })

  const archiveAllMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/nextcloud/archive-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Archive failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['nextcloud-stats'] })
      setArchiveMessage(`Archived ${data.success_count} invoices${data.failed_count > 0 ? `, ${data.failed_count} failed` : ''}`)
      setTimeout(() => setArchiveMessage(null), 5000)
    },
    onError: (error) => {
      setArchiveMessage(`Error: ${error.message}`)
    },
  })

  // Backup mutations
  const saveBackupMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/backup/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to save backup settings')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
      setBackupSaveMessage('Backup settings saved successfully')
      setTimeout(() => setBackupSaveMessage(null), 3000)
    },
    onError: (error) => {
      setBackupSaveMessage(`Error: ${error.message}`)
    },
  })

  const createBackupMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/backup/create', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Backup creation failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['backup-history'] })
      queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
      setBackupCreateMessage(data.message)
      setTimeout(() => setBackupCreateMessage(null), 5000)
    },
    onError: (error) => {
      setBackupCreateMessage(`Error: ${error.message}`)
    },
  })

  const restoreBackupMutation = useMutation({
    mutationFn: async (backupId: number) => {
      const res = await fetch(`/api/backup/${backupId}/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Restore failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setBackupCreateMessage(data.message)
      setTimeout(() => setBackupCreateMessage(null), 5000)
      // Refresh all data after restore
      queryClient.invalidateQueries()
    },
    onError: (error) => {
      setBackupCreateMessage(`Error: ${error.message}`)
    },
  })

  const deleteBackupMutation = useMutation({
    mutationFn: async (backupId: number) => {
      const res = await fetch(`/api/backup/${backupId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Delete failed')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backup-history'] })
      setBackupCreateMessage('Backup deleted')
      setTimeout(() => setBackupCreateMessage(null), 3000)
    },
    onError: (error) => {
      setBackupCreateMessage(`Error: ${error.message}`)
    },
  })

  const uploadBackupMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/backup/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Upload failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['backup-history'] })
      setBackupCreateMessage(data.message)
      setTimeout(() => setBackupCreateMessage(null), 5000)
    },
    onError: (error) => {
      setBackupCreateMessage(`Error: ${error.message}`)
    },
  })

  // Search settings mutation
  const saveSearchSettingsMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch('/api/search/settings', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.detail || 'Failed to save search settings')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['search-settings'] })
      setSearchSaveMessage('Search settings saved successfully')
      setTimeout(() => setSearchSaveMessage(null), 3000)
    },
    onError: (error) => {
      setSearchSaveMessage(`Error: ${error.message}`)
    },
  })

  const handlePasswordChange = () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordMessage('Error: Please fill in all password fields')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage('Error: New passwords do not match')
      return
    }
    if (newPassword.length < 6) {
      setPasswordMessage('Error: Password must be at least 6 characters')
      return
    }
    passwordMutation.mutate({
      current_password: currentPassword,
      new_password: newPassword,
    })
  }

  const handleSaveSettings = () => {
    const data: Record<string, string | number | boolean> = {
      azure_endpoint: azureEndpoint,
      currency_symbol: currencySymbol,
      date_format: dateFormat,
      high_quantity_threshold: highQuantityThreshold,
      pdf_annotations_enabled: pdfAnnotationsEnabled,
      pdf_preview_show_annotations: pdfPreviewShowAnnotations,
      ocr_clean_product_codes: ocrCleanProductCodes,
      ocr_filter_subtotal_rows: ocrFilterSubtotalRows,
      ocr_use_weight_as_quantity: ocrUseWeightAsQuantity,
    }
    if (azureKey) {
      data.azure_key = azureKey
    }
    updateMutation.mutate(data)
  }

  const handleSaveNewbook = () => {
    const data: Record<string, unknown> = {
      newbook_api_username: newbookUsername,
      newbook_api_region: newbookRegion,
      newbook_instance_id: newbookInstanceId,
    }
    if (newbookPassword) data.newbook_api_password = newbookPassword
    if (newbookApiKey) data.newbook_api_key = newbookApiKey
    updateNewbookMutation.mutate(data)
  }

  // SambaPOS handlers
  const handleSaveSambaConnection = () => {
    const data: Record<string, unknown> = {
      sambapos_db_host: sambaDbHost,
      sambapos_db_port: parseInt(sambaDbPort) || 1433,
      sambapos_db_name: sambaDbName,
      sambapos_db_username: sambaDbUsername,
    }
    if (sambaDbPassword) {
      data.sambapos_db_password = sambaDbPassword
    }
    updateSambaMutation.mutate(data)
  }

  // Toggle a course on/off - adds to end if not present, removes if present
  const toggleSambaCourse = (name: string) => {
    if (sambaSelectedCourses.includes(name)) {
      setSambaSelectedCourses(sambaSelectedCourses.filter(c => c !== name))
    } else {
      setSambaSelectedCourses([...sambaSelectedCourses, name])
    }
  }

  // Move a course up in the order
  const moveCourseUp = (index: number) => {
    if (index <= 0) return
    const newCourses = [...sambaSelectedCourses]
    ;[newCourses[index - 1], newCourses[index]] = [newCourses[index], newCourses[index - 1]]
    setSambaSelectedCourses(newCourses)
  }

  // Move a course down in the order
  const moveCourseDown = (index: number) => {
    if (index >= sambaSelectedCourses.length - 1) return
    const newCourses = [...sambaSelectedCourses]
    ;[newCourses[index], newCourses[index + 1]] = [newCourses[index + 1], newCourses[index]]
    setSambaSelectedCourses(newCourses)
  }

  const handleSaveSambaCourses = () => {
    saveSambaCoursesMutation.mutate(sambaSelectedCourses)
  }

  // Toggle excluded item
  const toggleExcludedItem = (name: string) => {
    const newSet = new Set(sambaExcludedItems)
    if (newSet.has(name)) {
      newSet.delete(name)
    } else {
      newSet.add(name)
    }
    setSambaExcludedItems(newSet)
  }

  const handleSaveExcludedItems = () => {
    saveExcludedItemsMutation.mutate(Array.from(sambaExcludedItems))
  }

  // Toggle GL codes (Phase 8)
  const toggleFoodGLCode = (code: string) => {
    const newSet = new Set(sambaFoodGLCodes)
    if (newSet.has(code)) {
      newSet.delete(code)
    } else {
      newSet.add(code)
      // Remove from beverage if it was there
      if (sambaBeverageGLCodes.has(code)) {
        const newBevSet = new Set(sambaBeverageGLCodes)
        newBevSet.delete(code)
        setSambaBeverageGLCodes(newBevSet)
      }
    }
    setSambaFoodGLCodes(newSet)
  }

  const toggleBeverageGLCode = (code: string) => {
    const newSet = new Set(sambaBeverageGLCodes)
    if (newSet.has(code)) {
      newSet.delete(code)
    } else {
      newSet.add(code)
      // Remove from food if it was there
      if (sambaFoodGLCodes.has(code)) {
        const newFoodSet = new Set(sambaFoodGLCodes)
        newFoodSet.delete(code)
        setSambaFoodGLCodes(newFoodSet)
      }
    }
    setSambaBeverageGLCodes(newSet)
  }

  const handleSaveGLCodes = () => {
    saveGLCodesMutation.mutate({
      food_codes: Array.from(sambaFoodGLCodes),
      beverage_codes: Array.from(sambaBeverageGLCodes)
    })
  }

  const sambaConnectionConfigured = sambaSettings?.sambapos_db_host && sambaSettings?.sambapos_db_password_set

  // KDS handlers
  const handleSaveKdsConnection = () => {
    const data: Record<string, unknown> = {
      kds_graphql_url: kdsGraphqlUrl,
      kds_graphql_username: kdsGraphqlUsername,
      kds_graphql_client_id: kdsGraphqlClientId,
    }
    if (kdsGraphqlPassword) {
      data.kds_graphql_password = kdsGraphqlPassword
    }
    updateKdsMutation.mutate(data)
  }

  const handleSaveKdsDisplay = () => {
    const courseArray = kdsCourseOrder.split(',').map(s => s.trim()).filter(Boolean)
    updateKdsMutation.mutate({
      kds_poll_interval_seconds: kdsPollInterval,
      kds_timer_green_seconds: kdsTimerGreen,
      kds_timer_amber_seconds: kdsTimerAmber,
      kds_timer_red_seconds: kdsTimerRed,
      kds_course_order: courseArray,
      kds_show_completed_for_seconds: kdsShowCompleted,
    })
  }

  if (isLoading) {
    return <div style={styles.loading}>Loading settings...</div>
  }

  // Helper to check if a settings section is accessible
  const isSectionAccessible = (restrictPath?: string) => {
    if (!restrictPath) return true
    if (user?.is_admin) return true
    return !authRestrictedPages.includes(restrictPath)
  }

  const sidebarItems: { id: SettingsSection; label: string; adminOnly?: boolean; href?: string; restrictPath?: string }[] = [
    { id: 'account', label: 'Account' },
    { id: 'users', label: 'Users', adminOnly: true, restrictPath: '/settings-users' },
    { id: 'access', label: 'Access Control', adminOnly: true, restrictPath: '/settings-access' },
    { id: 'display', label: 'Display', restrictPath: '/settings-display' },
    { id: 'azure', label: 'Azure OCR', restrictPath: '/settings-azure' },
    { id: 'email', label: 'Email Configuration', restrictPath: '/settings-email' },
    { id: 'inbox', label: 'Email Inbox', adminOnly: true, restrictPath: '/settings-inbox' },
    { id: 'dext', label: 'Dext Integration', restrictPath: '/settings-dext' },
    { id: 'newbook', label: 'Newbook PMS', restrictPath: '/settings-newbook' },
    { id: 'resos', label: 'Resos Bookings', restrictPath: '/settings-resos' },
    { id: 'sambapos', label: 'SambaPOS EPOS', restrictPath: '/settings-sambapos' },
    { id: 'kds', label: 'Kitchen Display', restrictPath: '/settings-kds' },
    { id: 'suppliers', label: 'Suppliers', restrictPath: '/settings-suppliers' },
    { id: 'search', label: 'Search & Pricing', restrictPath: '/settings-search' },
    { id: 'nextcloud', label: 'Nextcloud Storage', restrictPath: '/settings-nextcloud' },
    { id: 'backup', label: 'Backup & Restore', restrictPath: '/settings-backup' },
    { id: 'data', label: 'Data Management', restrictPath: '/settings-data' },
  ]

  return (
    <div style={styles.layout}>
      {/* Sidebar */}
      <div style={styles.sidebar}>
        <h3 style={styles.sidebarTitle}>Settings</h3>
        <nav style={styles.nav}>
          {sidebarItems.map((item) => {
            if (item.adminOnly && !user?.is_admin) return null
            if (!isSectionAccessible(item.restrictPath)) return null
            if (item.href) {
              return (
                <a
                  key={item.id}
                  href={item.href}
                  style={styles.navItem}
                >
                  {item.label}
                </a>
              )
            }
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                style={{
                  ...styles.navItem,
                  ...(activeSection === item.id ? styles.navItemActive : {}),
                }}
              >
                {item.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Content */}
      <div style={styles.content}>
        {/* Account Section */}
        {activeSection === 'account' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Account</h2>

            {/* Account Information Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Account Information</h3>
              <div style={styles.infoGrid}>
                <p><strong>Email:</strong> {user?.email}</p>
                <p><strong>Name:</strong> {user?.name}</p>
                <p><strong>Kitchen:</strong> {user?.kitchen_name}</p>
                {user?.is_admin && <p><strong>Role:</strong> Admin</p>}
              </div>
            </div>

            {/* Change Password Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Change Password</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  Current Password
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  New Password
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Confirm New Password
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    style={styles.input}
                  />
                </label>
              </div>
            </div>

            {/* Actions - outside blocks */}
            <div style={{ marginBottom: '1rem' }}>
              <button onClick={handlePasswordChange} style={styles.btn} disabled={passwordMutation.isPending}>
                {passwordMutation.isPending ? 'Changing...' : 'Change Password'}
              </button>
              {passwordMessage && (
                <div style={{ ...styles.statusMessage, background: passwordMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '0.5rem' }}>
                  {passwordMessage}
                </div>
              )}
            </div>

            <div>
              <button onClick={() => {
                if (window.confirm('Are you sure you want to logout?')) {
                  logout()
                  window.location.href = '/login'
                }
              }} style={{
                background: '#e94560',
                color: 'white',
                border: 'none',
                padding: '0.75rem 1.5rem',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '16px',
                fontWeight: 'bold',
              }}>
                Logout
              </button>
            </div>
          </div>
        )}

        {/* Users Section (Admin Only) */}
        {activeSection === 'users' && user?.is_admin && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>User Management</h2>
            <p style={styles.hint}>Manage users who have access to this kitchen.</p>

            {/* Users List Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Users</h3>
              {users && users.length > 0 && (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Email</th>
                      <th style={styles.th}>Name</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>Role</th>
                      <th style={styles.th}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} style={!u.is_active ? styles.disabledRow : undefined}>
                        <td style={styles.td}>{u.email}</td>
                        <td style={styles.td}>{u.name || '-'}</td>
                        <td style={styles.td}>
                          <span style={u.is_active ? styles.activeStatus : styles.inactiveStatus}>
                            {u.is_active ? 'Active' : 'Disabled'}
                          </span>
                        </td>
                        <td style={styles.td}>{u.is_admin ? 'Admin' : 'User'}</td>
                        <td style={styles.td}>
                          {u.id !== user.id ? (
                            <div style={styles.actionButtons}>
                              <button
                                onClick={() => toggleUserMutation.mutate(u.id)}
                                style={u.is_active ? styles.disableBtn : styles.enableBtn}
                              >
                                {u.is_active ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`${u.is_admin ? 'Remove admin rights from' : 'Make admin'} ${u.email}?`)) {
                                    toggleAdminMutation.mutate(u.id)
                                  }
                                }}
                                style={u.is_admin ? styles.demoteBtn : styles.promoteBtn}
                              >
                                {u.is_admin ? 'Demote' : 'Make Admin'}
                              </button>
                              {!u.is_admin && (
                                <button
                                  onClick={() => {
                                    if (confirm(`Delete user ${u.email}?`)) {
                                      deleteUserMutation.mutate(u.id)
                                    }
                                  }}
                                  style={styles.deleteBtn}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          ) : (
                            <span style={styles.youLabel}>(You)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Access Control Section (Admin Only) */}
        {activeSection === 'access' && user?.is_admin && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Access Control</h2>
            <p style={styles.hint}>
              Restrict pages to admin users only. Non-admin users will not see restricted pages in the navigation.
            </p>

            {/* Invoice & Data Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Invoice & Data</h3>
              <div style={styles.checkboxGroup}>
                {[
                  { path: '/upload', label: 'Upload Invoices' },
                  { path: '/invoices', label: 'Invoice List & Disputes' },
                  { path: '/purchases', label: 'Purchase Chart' },
                  { path: '/logbook', label: 'Allowance Logbook' },
                ].map(({ path, label }) => (
                  <label key={path} style={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={restrictedPages.has(path)}
                      onChange={() => {
                        const newSet = new Set(restrictedPages)
                        if (newSet.has(path)) {
                          newSet.delete(path)
                        } else {
                          newSet.add(path)
                        }
                        setRestrictedPages(newSet)
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Reports Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Reports</h3>
              <div style={styles.checkboxGroup}>
                {[
                  { path: '/gp-report', label: 'Kitchen Flash & Purchase Reports' },
                  { path: '/newbook', label: 'Newbook Data' },
                  { path: '/resos', label: 'Resos Bookings & Stats' },
                ].map(({ path, label }) => (
                  <label key={path} style={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={restrictedPages.has(path)}
                      onChange={() => {
                        const newSet = new Set(restrictedPages)
                        if (newSet.has(path)) {
                          newSet.delete(path)
                        } else {
                          newSet.add(path)
                        }
                        setRestrictedPages(newSet)
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Search & Tools Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Search & Tools</h3>
              <div style={styles.checkboxGroup}>
                {[
                  { path: '/search', label: 'Search (Invoices, Line Items, Definitions)' },
                  { path: '/kds', label: 'Kitchen Display System (KDS)' },
                ].map(({ path, label }) => (
                  <label key={path} style={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={restrictedPages.has(path)}
                      onChange={() => {
                        const newSet = new Set(restrictedPages)
                        if (newSet.has(path)) {
                          newSet.delete(path)
                        } else {
                          newSet.add(path)
                        }
                        setRestrictedPages(newSet)
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Settings Sections Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Settings Sections</h3>
              <div style={styles.checkboxGroup}>
                {[
                  { path: '/settings', label: 'Settings Page (entire page)' },
                  { path: '/settings-users', label: 'Users Management' },
                  { path: '/settings-access', label: 'Access Control' },
                  { path: '/settings-display', label: 'Display Settings' },
                  { path: '/settings-azure', label: 'Azure OCR' },
                  { path: '/settings-email', label: 'Email Configuration' },
                  { path: '/settings-inbox', label: 'Email Inbox' },
                  { path: '/settings-dext', label: 'Dext Integration' },
                  { path: '/settings-newbook', label: 'Newbook PMS' },
                  { path: '/settings-resos', label: 'Resos Bookings' },
                  { path: '/settings-sambapos', label: 'SambaPOS EPOS' },
                  { path: '/settings-kds', label: 'Kitchen Display' },
                  { path: '/settings-suppliers', label: 'Suppliers' },
                  { path: '/settings-search', label: 'Search & Pricing' },
                  { path: '/settings-nextcloud', label: 'Nextcloud Storage' },
                  { path: '/settings-backup', label: 'Backup & Restore' },
                  { path: '/settings-data', label: 'Data Management' },
                ].map(({ path, label }) => (
                  <label key={path} style={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={restrictedPages.has(path)}
                      onChange={() => {
                        const newSet = new Set(restrictedPages)
                        if (newSet.has(path)) {
                          newSet.delete(path)
                        } else {
                          newSet.add(path)
                        }
                        setRestrictedPages(newSet)
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Save Button - outside blocks */}
            <div style={{ marginTop: '1.5rem' }}>
              <button
                onClick={() => savePageRestrictionsMutation.mutate(Array.from(restrictedPages))}
                style={styles.saveBtn}
                disabled={savePageRestrictionsMutation.isPending}
              >
                {savePageRestrictionsMutation.isPending ? 'Saving...' : 'Save Restrictions'}
              </button>
            </div>

            {accessSaveMessage && (
              <div style={{ ...styles.statusMessage, background: accessSaveMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '1rem' }}>
                {accessSaveMessage}
              </div>
            )}

            <div style={{ marginTop: '1.5rem', padding: '1rem', background: '#f8f9fa', borderRadius: '8px' }}>
              <strong>Note:</strong> Restricting a page will hide it from non-admin users. Admin users always have access to all pages.
              The Dashboard is always accessible to all users.
            </div>
          </div>
        )}

        {/* Display Section */}
        {activeSection === 'display' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Display Settings</h2>

            {/* Display Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Display Configuration</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  Currency Symbol
                  <select value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} style={styles.input}>
                    <option value="£">£ (GBP)</option>
                    <option value="$">$ (USD)</option>
                    <option value="€">€ (EUR)</option>
                  </select>
                </label>
                <label style={styles.label}>
                  Date Format
                  <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} style={styles.input}>
                    <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  </select>
                </label>
                <label style={styles.label}>
                  High Quantity Warning Threshold
                  <input
                    type="number"
                    min="1"
                    value={highQuantityThreshold}
                    onChange={(e) => setHighQuantityThreshold(parseInt(e.target.value) || 100)}
                    style={styles.input}
                  />
                  <span style={{ fontSize: '0.85rem', color: '#666' }}>
                    Line items with quantity above this value will be highlighted amber
                  </span>
                </label>
              </div>
            </div>

            {/* PDF Annotation Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>PDF Annotations</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={pdfAnnotationsEnabled}
                    onChange={(e) => setPdfAnnotationsEnabled(e.target.checked)}
                  />
                  Enable PDF annotations
                  <small style={{ color: '#666', fontSize: '0.9em', display: 'block', marginTop: '0.25rem' }}>
                    When enabled, the system will add visual annotations (highlights, labels) to PDFs
                  </small>
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={pdfPreviewShowAnnotations}
                    onChange={(e) => setPdfPreviewShowAnnotations(e.target.checked)}
                  />
                  Show annotations in PDF preview
                  <small style={{ color: '#666', fontSize: '0.9em', display: 'block', marginTop: '0.25rem' }}>
                    When enabled, annotations will be visible in the preview window on the review page
                  </small>
                </label>
              </div>
            </div>

            {/* Save Button - outside blocks */}
            <button onClick={handleSaveSettings} style={styles.saveBtn} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Settings'}
            </button>
            {saveMessage && (
              <div style={{ ...styles.statusMessage, background: saveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {saveMessage}
              </div>
            )}
          </div>
        )}

        {/* Azure OCR Section */}
        {activeSection === 'azure' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Azure Document Intelligence</h2>
            <p style={styles.hint}>Configure Azure credentials for invoice OCR processing.</p>

            {/* API Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>API Configuration</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  Endpoint URL
                  <input
                    type="text"
                    value={azureEndpoint}
                    onChange={(e) => setAzureEndpoint(e.target.value)}
                    style={styles.input}
                    placeholder="https://your-resource.cognitiveservices.azure.com/"
                  />
                </label>
                <label style={styles.label}>
                  API Key
                  <input
                    type="password"
                    value={azureKey}
                    onChange={(e) => setAzureKey(e.target.value)}
                    style={styles.input}
                    placeholder={settings?.azure_key_set ? '••••••••••••••••' : 'Enter your API key'}
                  />
                  {settings?.azure_key_set && !azureKey && <span style={styles.keyStatus}>Key is configured</span>}
                </label>
              </div>
            </div>

            {/* OCR Post-Processing Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Post-Processing Options</h3>
              <p style={styles.hint}>Optional cleanup of OCR results for common invoice quirks.</p>

              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={ocrCleanProductCodes}
                  onChange={(e) => setOcrCleanProductCodes(e.target.checked)}
                  style={styles.checkbox}
                />
                Clean product codes (strip section headers like "CHILL/AMBIENT")
              </label>

              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={ocrFilterSubtotalRows}
                  onChange={(e) => setOcrFilterSubtotalRows(e.target.checked)}
                  style={styles.checkbox}
                />
                Filter subtotal rows (remove "Sub Total" lines from line items)
              </label>

              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={ocrUseWeightAsQuantity}
                  onChange={(e) => setOcrUseWeightAsQuantity(e.target.checked)}
                  style={styles.checkbox}
                />
                Use weight as quantity for KG items (when weight × price matches total)
              </label>
            </div>

            {/* Actions - outside blocks */}
            <div style={styles.buttonRow}>
              <button onClick={() => azureTestMutation.mutate()} style={styles.testBtn} disabled={!settings?.azure_key_set}>
                Test Connection
              </button>
              <button onClick={handleSaveSettings} style={styles.saveBtn} disabled={updateMutation.isPending}>
                Save
              </button>
            </div>
            {azureTestStatus && (
              <div style={{ ...styles.statusMessage, background: azureTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                {azureTestStatus}
              </div>
            )}
          </div>
        )}

        {/* Email Configuration Section */}
        {activeSection === 'email' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Email Configuration (SMTP)</h2>
            <p style={styles.hint}>Configure SMTP settings for sending emails.</p>

            {/* SMTP Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>SMTP Settings</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  SMTP Server
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    style={styles.input}
                    placeholder="smtp.gmail.com"
                  />
                </label>
                <label style={styles.label}>
                  SMTP Port
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    style={styles.input}
                    placeholder="587"
                  />
                </label>
                <label style={styles.label}>
                  Username
                  <input
                    type="text"
                    value={smtpUsername}
                    onChange={(e) => setSmtpUsername(e.target.value)}
                    style={styles.input}
                    placeholder="your-email@example.com"
                  />
                </label>
                <label style={styles.label}>
                  Password
                  <input
                    type="password"
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                    style={styles.input}
                    placeholder={settings?.smtp_password_set ? '••••••••••••••••' : 'Enter password'}
                  />
                  {settings?.smtp_password_set && !smtpPassword && <span style={styles.keyStatus}>Password is configured</span>}
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={smtpUseTls}
                    onChange={(e) => setSmtpUseTls(e.target.checked)}
                  />
                  Use TLS/STARTTLS
                </label>
                <label style={styles.label}>
                  From Email
                  <input
                    type="email"
                    value={smtpFromEmail}
                    onChange={(e) => setSmtpFromEmail(e.target.value)}
                    style={styles.input}
                    placeholder="invoices@yourcompany.com"
                  />
                </label>
                <label style={styles.label}>
                  From Name
                  <input
                    type="text"
                    value={smtpFromName}
                    onChange={(e) => setSmtpFromName(e.target.value)}
                    style={styles.input}
                    placeholder="Kitchen Invoice System"
                  />
                </label>
              </div>
            </div>

            {/* Support Request Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Support Request Settings</h3>
              <p style={styles.hint}>Configure where user support requests (with screenshots) are sent.</p>
              <div style={styles.form}>
                <label style={styles.label}>
                  Support Email
                  <input
                    type="email"
                    value={supportEmail}
                    onChange={(e) => setSupportEmail(e.target.value)}
                    style={styles.input}
                    placeholder="support@yourcompany.com"
                  />
                  <small style={{ color: '#666', fontSize: '0.9em' }}>
                    Users can report issues with a screenshot using the ? button (visible when configured)
                  </small>
                </label>
              </div>
            </div>

            {/* Actions - outside blocks */}
            <div style={styles.buttonRow}>
                <button
                  onClick={async () => {
                    // Save settings first, then test
                    setSmtpTestStatus('Saving settings...')
                    try {
                      const savePayload = {
                        smtp_host: smtpHost || null,
                        smtp_port: parseInt(smtpPort) || 587,
                        smtp_username: smtpUsername || null,
                        smtp_password: smtpPassword || undefined,
                        smtp_use_tls: smtpUseTls,
                        smtp_from_email: smtpFromEmail || null,
                        smtp_from_name: smtpFromName || null,
                        support_email: supportEmail || null
                      }

                      const saveRes = await fetch('/api/settings/', {
                        method: 'PATCH',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`
                        },
                        body: JSON.stringify(savePayload)
                      })

                      if (!saveRes.ok) {
                        setSmtpTestStatus('Error: Failed to save settings')
                        return
                      }

                      await queryClient.invalidateQueries({ queryKey: ['settings'] })

                      // Now test the connection
                      setSmtpTestStatus('Testing connection...')
                      const res = await fetch('/api/settings/test-smtp', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` }
                      })
                      if (res.ok) {
                        const data = await res.json()
                        setSmtpTestStatus(`✓ ${data.message}`)
                      } else {
                        const error = await res.json()
                        console.error('SMTP test error:', error)
                        setSmtpTestStatus(`Error: ${error.detail}`)
                      }
                    } catch (err) {
                      console.error('SMTP test exception:', err)
                      setSmtpTestStatus(`Error: ${err}`)
                    }
                  }}
                  style={styles.testBtn}
                  disabled={!smtpHost || !smtpFromEmail}
                >
                  Test Connection
                </button>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/settings/', {
                        method: 'PATCH',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`
                        },
                        body: JSON.stringify({
                          smtp_host: smtpHost || null,
                          smtp_port: parseInt(smtpPort) || 587,
                          smtp_username: smtpUsername || null,
                          smtp_password: smtpPassword || undefined,
                          smtp_use_tls: smtpUseTls,
                          smtp_from_email: smtpFromEmail || null,
                          smtp_from_name: smtpFromName || null,
                          support_email: supportEmail || null
                        })
                      })
                      if (res.ok) {
                        setSmtpSaveMessage('✓ Saved successfully')
                        queryClient.invalidateQueries({ queryKey: ['settings'] })
                        setTimeout(() => setSmtpSaveMessage(null), 3000)
                      } else {
                        setSmtpSaveMessage('Error: Failed to save')
                      }
                    } catch (err) {
                      setSmtpSaveMessage(`Error: ${err}`)
                    }
                  }}
                  style={styles.saveBtn}
                >
                  Save
                </button>
              </div>
            {smtpTestStatus && (
              <div style={{ ...styles.statusMessage, background: smtpTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                {smtpTestStatus}
              </div>
            )}
            {smtpSaveMessage && (
              <div style={{ ...styles.statusMessage, background: smtpSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {smtpSaveMessage}
              </div>
            )}
          </div>
        )}

        {/* Email Inbox (IMAP) Section */}
        {activeSection === 'inbox' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Email Inbox (IMAP)</h2>
            <p style={styles.hint}>
              Configure an email inbox to automatically process invoice attachments.
              Emails with confident invoice attachments will be marked as read.
            </p>

            {/* IMAP Connection Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>IMAP Connection</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  IMAP Server
                  <input
                    type="text"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    style={styles.input}
                    placeholder="imap.gmail.com"
                  />
                </label>
                <label style={styles.label}>
                  Port
                  <input
                    type="number"
                    value={imapPort}
                    onChange={(e) => setImapPort(e.target.value)}
                    style={styles.input}
                    placeholder="993"
                  />
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={imapUseSsl}
                    onChange={(e) => setImapUseSsl(e.target.checked)}
                  />
                  Use SSL
                </label>
                <label style={styles.label}>
                  Username / Email
                  <input
                    type="text"
                    value={imapUsername}
                    onChange={(e) => setImapUsername(e.target.value)}
                    style={styles.input}
                    placeholder="invoices@yourcompany.com"
                  />
                </label>
                <label style={styles.label}>
                  Password
                  <input
                    type="password"
                    value={imapPassword}
                    onChange={(e) => setImapPassword(e.target.value)}
                    style={styles.input}
                    placeholder={imapSettings?.imap_password_set ? '••••••••••••••••' : 'Enter password'}
                  />
                  {imapSettings?.imap_password_set && !imapPassword && <span style={styles.keyStatus}>Password is configured</span>}
                </label>
                <label style={styles.label}>
                  Folder
                  <input
                    type="text"
                    value={imapFolder}
                    onChange={(e) => setImapFolder(e.target.value)}
                    style={styles.input}
                    placeholder="INBOX"
                  />
                </label>
              </div>
            </div>

            {/* Processing Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Processing Settings</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  Poll Interval
                  <select
                    value={imapPollInterval}
                    onChange={(e) => setImapPollInterval(parseInt(e.target.value))}
                    style={styles.input}
                  >
                    <option value={5}>Every 5 minutes</option>
                    <option value={10}>Every 10 minutes</option>
                    <option value={15}>Every 15 minutes</option>
                    <option value={30}>Every 30 minutes</option>
                    <option value={60}>Every hour</option>
                  </select>
                </label>
                <label style={styles.label}>
                  Confidence Threshold: {imapConfidenceThreshold}%
                  <input
                    type="range"
                    min={30}
                    max={90}
                    value={imapConfidenceThreshold}
                    onChange={(e) => setImapConfidenceThreshold(parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <span style={styles.hint}>
                    Emails are marked as read when any attachment has confidence above this threshold
                  </span>
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={imapEnabled}
                    onChange={(e) => setImapEnabled(e.target.checked)}
                  />
                  Enable Automatic Polling
                </label>
              </div>
            </div>

            {/* Last Sync Info */}
            {imapSettings?.imap_last_sync && (
              <div style={{ ...styles.hint, marginBottom: '1rem' }}>
                Last sync: {new Date(imapSettings.imap_last_sync).toLocaleString()}
              </div>
            )}

            {/* Actions */}
            <div style={styles.buttonRow}>
              <button
                onClick={async () => {
                  setImapTestStatus('Testing connection...')
                  try {
                    const res = await fetch('/api/imap/test-connection', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                      },
                      body: JSON.stringify({
                        imap_host: imapHost || undefined,
                        imap_port: parseInt(imapPort) || undefined,
                        imap_use_ssl: imapUseSsl,
                        imap_username: imapUsername || undefined,
                        imap_password: imapPassword || undefined
                      })
                    })
                    const data = await res.json()
                    if (data.success) {
                      setImapTestStatus(`✓ Connected! Available folders: ${data.folders?.join(', ') || 'INBOX'}`)
                    } else {
                      setImapTestStatus(`Error: ${data.error}`)
                    }
                  } catch (err) {
                    setImapTestStatus(`Error: ${err}`)
                  }
                }}
                style={styles.testBtn}
                disabled={!imapHost}
              >
                Test Connection
              </button>
              <button
                onClick={async () => {
                  setImapSyncMessage('Syncing...')
                  try {
                    const res = await fetch('/api/imap/sync-now', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` }
                    })
                    const data = await res.json()
                    if (data.success) {
                      const r = data.results
                      setImapSyncMessage(
                        `✓ Sync complete: ${r.emails_processed} emails processed, ` +
                        `${r.invoices_created} invoices created, ${r.emails_marked_read} marked as read`
                      )
                      queryClient.invalidateQueries({ queryKey: ['imap-settings'] })
                      queryClient.invalidateQueries({ queryKey: ['imap-logs'] })
                      queryClient.invalidateQueries({ queryKey: ['imap-stats'] })
                    } else {
                      setImapSyncMessage(`Error: ${data.error}`)
                    }
                  } catch (err) {
                    setImapSyncMessage(`Error: ${err}`)
                  }
                }}
                style={styles.testBtn}
                disabled={!imapSettings?.imap_password_set && !imapPassword}
              >
                Sync Now
              </button>
              <button
                onClick={async () => {
                  setImapSaveMessage('Saving...')
                  try {
                    const res = await fetch('/api/imap/settings', {
                      method: 'PATCH',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                      },
                      body: JSON.stringify({
                        imap_host: imapHost || null,
                        imap_port: parseInt(imapPort) || 993,
                        imap_use_ssl: imapUseSsl,
                        imap_username: imapUsername || null,
                        imap_password: imapPassword || undefined,
                        imap_folder: imapFolder || 'INBOX',
                        imap_poll_interval: imapPollInterval,
                        imap_enabled: imapEnabled,
                        imap_confidence_threshold: imapConfidenceThreshold / 100
                      })
                    })
                    if (res.ok) {
                      setImapSaveMessage('✓ Settings saved')
                      setImapPassword('')
                      queryClient.invalidateQueries({ queryKey: ['imap-settings'] })
                    } else {
                      const err = await res.json()
                      setImapSaveMessage(`Error: ${err.detail}`)
                    }
                  } catch (err) {
                    setImapSaveMessage(`Error: ${err}`)
                  }
                }}
                style={styles.saveBtn}
              >
                Save Settings
              </button>
            </div>

            {imapTestStatus && (
              <div style={{ ...styles.statusMessage, background: imapTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                {imapTestStatus}
              </div>
            )}
            {imapSyncMessage && (
              <div style={{ ...styles.statusMessage, background: imapSyncMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {imapSyncMessage}
              </div>
            )}
            {imapSaveMessage && (
              <div style={{ ...styles.statusMessage, background: imapSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {imapSaveMessage}
              </div>
            )}

            {/* Stats Block */}
            {imapStats && (
              <div style={styles.settingsBlock}>
                <h3 style={styles.blockTitle}>Sync Statistics</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                  <div>
                    <strong>Last 24 Hours</strong>
                    <p>{imapStats.last_24h.emails_processed} emails</p>
                    <p>{imapStats.last_24h.invoices_created} invoices</p>
                    <p>{imapStats.last_24h.confident_invoices} confident</p>
                  </div>
                  <div>
                    <strong>Last 7 Days</strong>
                    <p>{imapStats.last_7d.emails_processed} emails</p>
                    <p>{imapStats.last_7d.invoices_created} invoices</p>
                    <p>{imapStats.last_7d.confident_invoices} confident</p>
                  </div>
                  <div>
                    <strong>Last 30 Days</strong>
                    <p>{imapStats.last_30d.emails_processed} emails</p>
                    <p>{imapStats.last_30d.invoices_created} invoices</p>
                    <p>{imapStats.last_30d.confident_invoices} confident</p>
                  </div>
                </div>
              </div>
            )}

            {/* Recent Logs Block */}
            {imapLogs && imapLogs.length > 0 && (
              <div style={styles.settingsBlock}>
                <h3 style={styles.blockTitle}>Recent Processing Logs</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #ddd' }}>
                      <th style={{ textAlign: 'left', padding: '0.5rem' }}>Date</th>
                      <th style={{ textAlign: 'left', padding: '0.5rem' }}>Subject</th>
                      <th style={{ textAlign: 'center', padding: '0.5rem' }}>Attachments</th>
                      <th style={{ textAlign: 'center', padding: '0.5rem' }}>Invoices</th>
                      <th style={{ textAlign: 'center', padding: '0.5rem' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imapLogs.map((log) => (
                      <tr key={log.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '0.5rem' }}>
                          {new Date(log.processed_at).toLocaleString()}
                        </td>
                        <td style={{ padding: '0.5rem', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {log.email_subject || '(no subject)'}
                        </td>
                        <td style={{ textAlign: 'center', padding: '0.5rem' }}>
                          {log.attachments_count}
                        </td>
                        <td style={{ textAlign: 'center', padding: '0.5rem' }}>
                          {log.invoices_created}
                          {log.confident_invoices > 0 && (
                            <span style={{ color: '#27ae60' }}> ({log.confident_invoices} confident)</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'center', padding: '0.5rem' }}>
                          {log.marked_as_read ? (
                            <span style={{ color: '#27ae60' }}>Read</span>
                          ) : log.processing_status === 'skipped' ? (
                            <span style={{ color: '#95a5a6' }}>Skipped</span>
                          ) : (
                            <span style={{ color: '#e67e22' }}>Unread</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Dext Integration Section */}
        {activeSection === 'dext' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Dext Integration</h2>
            <p style={styles.hint}>Configure automatic invoice submission to Dext.</p>

            {/* Dext Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Dext Settings</h3>
              <div style={styles.form}>
                <label style={styles.label}>
                  Dext Email Address
                  <input
                    type="email"
                    value={dextEmail}
                    onChange={(e) => setDextEmail(e.target.value)}
                    style={styles.input}
                    placeholder="yourcompany@dext.com"
                  />
                  <small style={{ color: '#666', fontSize: '0.9em' }}>Invoices will be sent to this email address</small>
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={dextIncludeNotes}
                    onChange={(e) => setDextIncludeNotes(e.target.checked)}
                  />
                  Include invoice notes in email body
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={dextIncludeNonStock}
                    onChange={(e) => setDextIncludeNonStock(e.target.checked)}
                  />
                  Include non-stock items table in email body
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={dextAutoSendEnabled}
                    onChange={(e) => setDextAutoSendEnabled(e.target.checked)}
                  />
                  Automatically send to Dext when invoice is confirmed
                  <small style={{ color: '#e67e22', fontSize: '0.9em', display: 'block', marginTop: '0.25rem' }}>
                    ⚠️ Leave disabled for testing. Enable only when ready for production.
                  </small>
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={dextManualSendEnabled}
                    onChange={(e) => setDextManualSendEnabled(e.target.checked)}
                  />
                  Enable manual "Send to Dext" button on invoice review page
                  <small style={{ color: '#666', fontSize: '0.9em', display: 'block', marginTop: '0.25rem' }}>
                    When disabled, only the send status will be displayed (without send/resend buttons)
                  </small>
                </label>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={dextIncludeAnnotations}
                    onChange={(e) => setDextIncludeAnnotations(e.target.checked)}
                  />
                  Include PDF annotations (highlights) when sending to Dext
                  <small style={{ color: '#666', fontSize: '0.9em', display: 'block', marginTop: '0.25rem' }}>
                    When enabled, non-stock items will be highlighted in yellow on the PDF attachment
                  </small>
                </label>
              </div>
            </div>

            {/* Save Button - outside blocks */}
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/settings/', {
                    method: 'PATCH',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify({
                      dext_email: dextEmail || null,
                      dext_include_notes: dextIncludeNotes,
                      dext_include_non_stock: dextIncludeNonStock,
                      dext_auto_send_enabled: dextAutoSendEnabled,
                      dext_manual_send_enabled: dextManualSendEnabled,
                      dext_include_annotations: dextIncludeAnnotations
                    })
                  })
                  if (res.ok) {
                    setDextSaveMessage('✓ Saved successfully')
                    queryClient.invalidateQueries({ queryKey: ['settings'] })
                    setTimeout(() => setDextSaveMessage(null), 3000)
                  } else {
                    setDextSaveMessage('Error: Failed to save')
                  }
                } catch (err) {
                  setDextSaveMessage(`Error: ${err}`)
                }
              }}
              style={styles.saveBtn}
            >
              Save Settings
            </button>
            {dextSaveMessage && (
              <div style={{ ...styles.statusMessage, background: dextSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {dextSaveMessage}
              </div>
            )}
          </div>
        )}

        {/* Newbook PMS Section */}
        {activeSection === 'newbook' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Newbook PMS Integration</h2>
            <p style={styles.hint}>Connect to Newbook to fetch revenue and occupancy data for GP calculations.</p>

            {newbookLoading && <div style={{ padding: '0.5rem', background: '#fff3cd', borderRadius: '4px', marginBottom: '1rem' }}>Loading Newbook settings...</div>}
            {newbookError && <div style={{ padding: '0.5rem', background: '#f8d7da', borderRadius: '4px', marginBottom: '1rem' }}>Error loading settings: {(newbookError as Error).message}</div>}

            {/* API Credentials Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>API Credentials</h3>
              <div style={styles.form}>
              <label style={styles.label}>
                Username
                <input
                  type="text"
                  value={newbookUsername}
                  onChange={(e) => setNewbookUsername(e.target.value)}
                  style={styles.input}
                />
              </label>
              <label style={styles.label}>
                Password
                <input
                  type="password"
                  value={newbookPassword}
                  onChange={(e) => setNewbookPassword(e.target.value)}
                  style={styles.input}
                  placeholder={newbookSettings?.newbook_api_password_set ? '••••••••' : 'Enter password'}
                />
              </label>
              <label style={styles.label}>
                API Key
                <input
                  type="password"
                  value={newbookApiKey}
                  onChange={(e) => setNewbookApiKey(e.target.value)}
                  style={styles.input}
                  placeholder={newbookSettings?.newbook_api_key_set ? '••••••••' : 'Enter API key'}
                />
              </label>
              <label style={styles.label}>
                Region
                <select value={newbookRegion} onChange={(e) => setNewbookRegion(e.target.value)} style={styles.input}>
                  <option value="au">Australia (au)</option>
                  <option value="ap">Asia Pacific (ap)</option>
                  <option value="eu">Europe (eu)</option>
                  <option value="us">United States (us)</option>
                </select>
              </label>
              <label style={styles.label}>
                Instance ID (optional)
                <input
                  type="text"
                  value={newbookInstanceId}
                  onChange={(e) => setNewbookInstanceId(e.target.value)}
                  style={styles.input}
                  placeholder="Property/Hotel ID"
                />
              </label>
                <div style={styles.buttonRow}>
                  <button onClick={() => newbookTestMutation.mutate()} style={styles.testBtn} disabled={newbookTestMutation.isPending}>
                    Test Connection
                  </button>
                  <button onClick={handleSaveNewbook} style={styles.saveBtn} disabled={updateNewbookMutation.isPending}>
                    Save Credentials
                  </button>
                </div>
                {newbookTestStatus && (
                  <div style={{ ...styles.statusMessage, background: newbookTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                    {newbookTestStatus}
                  </div>
                )}
              </div>
            </div>

            {/* GL Account Tracking Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>GL Account Tracking (for Revenue)</h3>
              <div style={styles.buttonRow}>
              <button onClick={() => fetchGLAccountsMutation.mutate()} style={styles.actionBtn} disabled={fetchGLAccountsMutation.isPending}>
                {fetchGLAccountsMutation.isPending ? 'Fetching...' : 'Fetch GL Accounts'}
              </button>
              <button onClick={() => setShowGLModal(true)} style={styles.actionBtn} disabled={!glAccounts?.length}>
                Select Accounts ({glAccounts?.filter((a) => a.is_tracked).length || 0} selected)
              </button>
              </div>
            </div>

            {/* Meal Allocation GL Mapping Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Meal Allocation GL Mapping</h3>
              <p style={styles.hint}>Select from tracked GL accounts above to map meal allocations.</p>
            {(() => {
              const trackedAccounts = glAccounts?.filter((a) => a.is_tracked) || []
              const breakfastCodes = newbookBreakfastGLCodes ? newbookBreakfastGLCodes.split(',').map((c) => c.trim()) : []
              const dinnerCodes = newbookDinnerGLCodes ? newbookDinnerGLCodes.split(',').map((c) => c.trim()) : []

              const toggleBreakfast = (code: string) => {
                const codes = new Set(breakfastCodes)
                if (codes.has(code)) codes.delete(code)
                else codes.add(code)
                const newCodes = Array.from(codes).join(',')
                setNewbookBreakfastGLCodes(newCodes)
                updateNewbookMutation.mutate({ newbook_breakfast_gl_codes: newCodes })
              }

              const toggleDinner = (code: string) => {
                const codes = new Set(dinnerCodes)
                if (codes.has(code)) codes.delete(code)
                else codes.add(code)
                const newCodes = Array.from(codes).join(',')
                setNewbookDinnerGLCodes(newCodes)
                updateNewbookMutation.mutate({ newbook_dinner_gl_codes: newCodes })
              }

              return (
                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <strong>Breakfast Allocations</strong>
                    <div style={styles.mealMappingList}>
                      {trackedAccounts.length === 0 ? (
                        <span style={styles.mealMappingEmpty}>No tracked accounts - select GL accounts above first</span>
                      ) : (
                        trackedAccounts.map((acc) => (
                          <label key={acc.id} style={styles.mealMappingItem}>
                            <input
                              type="checkbox"
                              checked={breakfastCodes.includes(acc.gl_code || '')}
                              onChange={() => toggleBreakfast(acc.gl_code || '')}
                            />
                            <span>{acc.gl_name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <strong>Dinner Allocations</strong>
                    <div style={styles.mealMappingList}>
                      {trackedAccounts.length === 0 ? (
                        <span style={styles.mealMappingEmpty}>No tracked accounts - select GL accounts above first</span>
                      ) : (
                        trackedAccounts.map((acc) => (
                          <label key={acc.id} style={styles.mealMappingItem}>
                            <input
                              type="checkbox"
                              checked={dinnerCodes.includes(acc.gl_code || '')}
                              onChange={() => toggleDinner(acc.gl_code || '')}
                            />
                            <span>{acc.gl_name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )
            })()}
            </div>

            {/* VAT Rates Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>VAT Rates</h3>
              <p style={styles.hint}>Set VAT rates to calculate net values from gross amounts in Newbook inventory items.</p>
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              <label style={{ ...styles.label, flex: 1, minWidth: '150px' }}>
                Breakfast VAT Rate (%)
                <input
                  type="number"
                  value={newbookBreakfastVatRate}
                  onChange={(e) => setNewbookBreakfastVatRate(e.target.value)}
                  onBlur={() => {
                    const rate = parseFloat(newbookBreakfastVatRate) / 100
                    if (!isNaN(rate) && rate >= 0 && rate <= 1) {
                      updateNewbookMutation.mutate({ newbook_breakfast_vat_rate: rate.toString() })
                    }
                  }}
                  style={styles.input}
                  min="0"
                  max="100"
                  step="0.1"
                />
              </label>
              <label style={{ ...styles.label, flex: 1, minWidth: '150px' }}>
                Dinner VAT Rate (%)
                <input
                  type="number"
                  value={newbookDinnerVatRate}
                  onChange={(e) => setNewbookDinnerVatRate(e.target.value)}
                  onBlur={() => {
                    const rate = parseFloat(newbookDinnerVatRate) / 100
                    if (!isNaN(rate) && rate >= 0 && rate <= 1) {
                      updateNewbookMutation.mutate({ newbook_dinner_vat_rate: rate.toString() })
                    }
                  }}
                  style={styles.input}
                  min="0"
                  max="100"
                  step="0.1"
                />
              </label>
            </div>
            </div>

            {/* Room Categories Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Room Categories (for Occupancy)</h3>
              <p style={styles.hint}>Select which room types to include in occupancy and guest calculations. Exclude overflow rooms etc.</p>
            <div style={styles.buttonRow}>
              <button onClick={() => fetchRoomCategoriesMutation.mutate()} style={styles.actionBtn} disabled={fetchRoomCategoriesMutation.isPending}>
                {fetchRoomCategoriesMutation.isPending ? 'Fetching...' : 'Fetch Room Categories'}
              </button>
              <button onClick={() => setShowRoomCategoryModal(true)} style={styles.actionBtn} disabled={!roomCategories?.length}>
                Select Types ({roomCategories?.filter((c) => c.is_included).reduce((sum, c) => sum + (c.room_count || 0), 0) || 0} rooms in {roomCategories?.filter((c) => c.is_included).length || 0} types)
              </button>
            </div>
            </div>

            {/* Data Sync Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Data Sync</h3>
            <p style={styles.hint}>
              Last sync: {newbookSettings?.newbook_last_sync ? new Date(newbookSettings.newbook_last_sync).toLocaleString() : 'Never'}
            </p>
            <div style={styles.buttonRow}>
              <button onClick={() => syncForecastMutation.mutate()} style={styles.actionBtn} disabled={syncForecastMutation.isPending}>
                {syncForecastMutation.isPending ? 'Syncing...' : 'Update Forecast Data'}
              </button>
              <button onClick={() => setShowHistoricalModal(true)} style={styles.actionBtn}>
                Fetch Historical Data
              </button>
            </div>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={newbookSettings?.newbook_auto_sync_enabled || false}
                onChange={(e) => updateNewbookMutation.mutate({ newbook_auto_sync_enabled: e.target.checked })}
              />
              Enable automatic daily sync (4:00 AM)
            </label>

            {/* Frequent Upcoming Sync */}
            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #eee' }}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={newbookSettings?.newbook_upcoming_sync_enabled || false}
                  onChange={(e) => {
                    const newValue = e.target.checked
                    console.log('[DEBUG] Checkbox onChange fired, newValue:', newValue)
                    updateNewbookMutation.mutate({ newbook_upcoming_sync_enabled: newValue })
                  }}
                />
                Enable frequent upcoming sync (next 7 days)
              </label>
              <small style={styles.hint}>Keeps ResidentsTableChart fresh with more frequent updates</small>
            </div>

            {newbookSettings?.newbook_upcoming_sync_enabled && (
              <div style={styles.formGroup}>
                <label>Sync interval (minutes)</label>
                <input
                  type="number"
                  value={newbookSettings?.newbook_upcoming_sync_interval || 15}
                  onChange={(e) => updateNewbookMutation.mutate({ newbook_upcoming_sync_interval: parseInt(e.target.value) || 15 })}
                  min={5}
                  max={60}
                  style={{ ...styles.input, width: '100px' }}
                />
                <small style={styles.hint}>Recommended: 15 minutes</small>
              </div>
            )}

            {newbookSettings?.newbook_last_upcoming_sync && (
              <div style={styles.formGroup}>
                <small style={styles.hint}>Last frequent sync: {new Date(newbookSettings.newbook_last_upcoming_sync).toLocaleString()}</small>
              </div>
            )}
            </div>

            {/* Status Message - outside blocks */}
            {newbookSaveMessage && (
              <div style={{ ...styles.statusMessage, background: newbookSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {newbookSaveMessage}
              </div>
            )}

            {/* View Newbook Data Link - outside blocks */}
            <div style={{ marginTop: '1rem', paddingTop: '1.5rem', borderTop: '1px solid #e0e0e0' }}>
              <a
                href="/newbook"
                style={{
                  display: 'inline-block',
                  padding: '0.75rem 1.5rem',
                  background: '#4a90d9',
                  color: 'white',
                  textDecoration: 'none',
                  borderRadius: '6px',
                  fontWeight: 500,
                }}
              >
                View Newbook Data
              </a>
              <p style={{ ...styles.hint, marginTop: '0.5rem' }}>View synced revenue, charges, and occupancy data from Newbook.</p>
            </div>
          </div>
        )}

        {/* Resos Bookings Section */}
        {activeSection === 'resos' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Resos Restaurant Bookings Integration</h2>
            <p style={styles.hint}>Connect to Resos to fetch booking data, flag notable reservations, and track covers.</p>

            {resosLoading && <div style={{ padding: '0.5rem', background: '#fff3cd', borderRadius: '4px', marginBottom: '1rem' }}>Loading Resos settings...</div>}
            {resosError && <div style={{ padding: '0.5rem', background: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '1rem' }}>Failed to load Resos settings</div>}

            {/* API Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>API Configuration</h3>

              <div style={styles.formGroup}>
                <label style={styles.label}>Resos API Key *</label>
                <input
                  type="password"
                  value={resosApiKey}
                  onChange={(e) => setResosApiKey(e.target.value)}
                  placeholder={resosSettings?.resos_api_key_set ? '••••••••••••' : 'Enter API key'}
                  style={styles.input}
                />
                {resosSettings?.resos_api_key_set && <small style={styles.hint}>API key is configured (enter new value to update)</small>}
              </div>

              <button
                onClick={async () => {
                  try {
                    setResosTestStatus('Testing...')
                    const res = await fetch('/api/resos/test-connection', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` }
                    })
                    if (res.ok) {
                      setResosTestStatus('✓ Connection successful')
                    } else {
                      const data = await res.json()
                      setResosTestStatus(`✗ Connection failed: ${data.detail || 'Unknown error'}`)
                    }
                  } catch (error) {
                    setResosTestStatus(`✗ Connection failed: ${error}`)
                  }
                  setTimeout(() => setResosTestStatus(null), 5000)
                }}
                style={styles.secondaryButton}
              >
                Test Connection
              </button>
              {resosTestStatus && <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>{resosTestStatus}</div>}
            </div>

            {/* Flagging Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Flagging Configuration</h3>

            <div style={{ ...styles.formGroup, marginBottom: '1.5rem' }}>
              <label style={styles.label}>Large Group Threshold</label>
              <input
                type="number"
                value={resosLargeGroupThreshold}
                onChange={(e) => setResosLargeGroupThreshold(parseInt(e.target.value) || 8)}
                style={{ ...styles.input, maxWidth: '150px' }}
              />
              <small style={{ ...styles.hint, display: 'block', marginTop: '0.5rem' }}>Flag bookings with this many people or more (default: 8)</small>
            </div>

            <div style={{ ...styles.formGroup, marginBottom: '1.5rem' }}>
              <label style={styles.label}>Note Keywords (pipe-separated)</label>
              <input
                type="text"
                value={resosNoteKeywords}
                onChange={(e) => setResosNoteKeywords(e.target.value)}
                placeholder="birthday|anniversary|proposal|vip"
                style={{ ...styles.input, maxWidth: '600px' }}
              />
              <small style={{ ...styles.hint, display: 'block', marginTop: '0.5rem' }}>Flag bookings with these keywords in notes</small>
            </div>

            <div style={{ ...styles.formGroup, marginBottom: '1.5rem' }}>
              <label style={styles.label}>Allergy Keywords (pipe-separated)</label>
              <input
                type="text"
                value={resosAllergyKeywords}
                onChange={(e) => setResosAllergyKeywords(e.target.value)}
                placeholder="gluten|dairy|nut|shellfish|vegan"
                style={{ ...styles.input, maxWidth: '600px' }}
              />
              <small style={{ ...styles.hint, display: 'block', marginTop: '0.5rem' }}>Additional allergy terms to detect in notes (for "Other Allergies" free-text field)</small>
            </div>
            </div>

            {/* Custom Field Mapping Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Custom Field Mapping</h3>
              <p style={styles.hint}>Map Resos custom fields to system fields. Fetch from API to populate available fields.</p>

            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/resos/custom-fields', {
                    headers: { Authorization: `Bearer ${token}` }
                  })
                  if (res.ok) {
                    const data = await res.json()
                    setCustomFields(data.custom_fields || [])
                    setResosSaveMessage('Custom fields fetched successfully')
                  } else {
                    setResosSaveMessage('Failed to fetch custom fields')
                  }
                } catch (error) {
                  setResosSaveMessage(`Error: ${error}`)
                }
                setTimeout(() => setResosSaveMessage(null), 5000)
              }}
              style={styles.secondaryButton}
            >
              Fetch Custom Fields from Resos
            </button>

            {customFields.length > 0 && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {[
                  { key: 'booking_number', label: 'Hotel Booking #', hint: 'Newbook/hotel booking reference number from Resos custom field' },
                  { key: 'hotel_guest', label: 'Hotel Guest', hint: 'Yes/No field indicating if diner is a hotel guest' },
                  { key: 'dbb', label: 'DBB (Dinner B&B)', hint: 'Yes/No field indicating Dinner Bed & Breakfast package guests' },
                  { key: 'package', label: 'Package', hint: 'Yes/No field indicating package deal bookings (e.g., special offers)' },
                  { key: 'exclude', label: 'Group/Exclude', hint: 'Free-text field for group codes and exclusions (e.g., "G#123" for groups)' },
                  { key: 'allergies', label: 'Allergies (Predefined)', hint: 'Multi-select field with predefined allergy options (e.g., Gluten, Dairy, Nuts)' },
                  { key: 'allergies_other', label: 'Other Allergies', hint: 'Free-text field for custom allergy notes not in predefined list' },
                ].map((field) => (
                  <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontWeight: '500', color: '#333', fontSize: '0.9rem' }}>{field.label}</label>
                    <select
                      value={customFieldMapping[field.key] || ''}
                      onChange={(e) => setCustomFieldMapping({...customFieldMapping, [field.key]: e.target.value})}
                      style={{ ...styles.input, maxWidth: '400px', fontSize: '0.85rem' }}
                    >
                      <option value="">-- Select Field --</option>
                      {customFields.map((customField) => (
                        <option key={customField._id} value={customField._id}>
                          {customField.name}
                        </option>
                      ))}
                    </select>
                    <small style={{ ...styles.hint, marginTop: 0, fontSize: '0.75rem' }}>{field.hint}</small>
                  </div>
                ))}
              </div>
            )}
            </div>

            {/* Opening Hours Mapping Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Opening Hours Mapping</h3>
              <p style={styles.hint}>
                Map regular service periods (excludes special/one-off periods). Resos extends closing times by the default booking length
                to allow late bookings - the Actual End field shows the calculated time when kitchen closes for new arrivals.
              </p>

            <button
              onClick={async () => {
                try {
                  // First, sync opening hours to database (POST endpoint)
                  const syncRes = await fetch('/api/resos/sync/opening-hours', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                  })

                  if (!syncRes.ok) {
                    setResosSaveMessage('Failed to sync opening hours to database')
                    setTimeout(() => setResosSaveMessage(null), 5000)
                    return
                  }

                  const syncData = await syncRes.json()

                  // Then, fetch opening hours for display (GET endpoint)
                  const res = await fetch('/api/resos/opening-hours', {
                    headers: { Authorization: `Bearer ${token}` }
                  })
                  if (res.ok) {
                    const data = await res.json()
                    // Backend API already filters special periods with onlySpecial=false parameter
                    setOpeningHours(data.opening_hours || [])
                    setResosSaveMessage(`Opening hours synced to database: ${syncData.count} service periods`)
                  } else {
                    setResosSaveMessage('Synced to database but failed to fetch for display')
                  }
                } catch (error) {
                  setResosSaveMessage(`Error: ${error}`)
                }
                setTimeout(() => setResosSaveMessage(null), 5000)
              }}
              style={styles.secondaryButton}
            >
              Fetch Opening Hours from Resos
            </button>

            {openingHours.length > 0 && (
              <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #ddd' }}>
                      <th style={{ padding: '0.5rem', textAlign: 'left' }}>Period Name</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left' }}>Start Time</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left' }}>End Time (Resos)</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left' }}>Actual End</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left' }}>Display Name</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left' }}>Service Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openingHours.map((hour) => {
                      const mapping = openingHoursMapping.find(m => m.resos_id === hour._id)

                      return (
                        <tr key={hour._id} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.5rem' }}>{hour.name}</td>
                          <td style={{ padding: '0.5rem' }}>{hour.startTime || '-'}</td>
                          <td style={{ padding: '0.5rem' }}>{hour.endTime || '-'}</td>
                          <td style={{ padding: '0.5rem' }}>
                            <input
                              type="time"
                              value={mapping?.actual_end || ''}
                              onChange={(e) => {
                                const newMapping = openingHoursMapping.filter(m => m.resos_id !== hour._id)
                                newMapping.push({
                                  resos_id: hour._id,
                                  display_name: mapping?.display_name || hour.name,
                                  actual_end: e.target.value,
                                  service_type: mapping?.service_type || ''
                                })
                                setOpeningHoursMapping(newMapping)
                              }}
                              style={{ padding: '0.25rem', border: '1px solid #ddd', borderRadius: '4px' }}
                              placeholder="Enter actual end time"
                            />
                          </td>
                          <td style={{ padding: '0.5rem' }}>
                            <input
                              type="text"
                              value={mapping?.display_name || ''}
                              onChange={(e) => {
                                const newMapping = openingHoursMapping.filter(m => m.resos_id !== hour._id)
                                newMapping.push({
                                  resos_id: hour._id,
                                  display_name: e.target.value,
                                  actual_end: mapping?.actual_end || '',
                                  service_type: mapping?.service_type || ''
                                })
                                setOpeningHoursMapping(newMapping)
                              }}
                              placeholder={hour.name}
                              style={{ padding: '0.25rem', border: '1px solid #ddd', borderRadius: '4px', width: '100%' }}
                            />
                          </td>
                          <td style={{ padding: '0.5rem' }}>
                            <select
                              value={mapping?.service_type || ''}
                              onChange={(e) => {
                                const newMapping = openingHoursMapping.filter(m => m.resos_id !== hour._id)
                                newMapping.push({
                                  resos_id: hour._id,
                                  display_name: mapping?.display_name || hour.name,
                                  actual_end: mapping?.actual_end || '',
                                  service_type: e.target.value
                                })
                                setOpeningHoursMapping(newMapping)
                              }}
                              style={{ padding: '0.25rem', border: '1px solid #ddd', borderRadius: '4px', width: '120px' }}
                            >
                              <option value="">-- Select --</option>
                              <option value="breakfast">Breakfast</option>
                              <option value="lunch">Lunch</option>
                              <option value="afternoon">Afternoon</option>
                              <option value="dinner">Dinner</option>
                              <option value="other">Other</option>
                            </select>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            </div>

            {/* Manual Breakfast Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Manual Breakfast Configuration</h3>
              <p style={styles.hint}>
                Since breakfast bookings are not taken through Resos, you can define manual breakfast periods
                to properly categorize early morning restaurant tickets. Configure different times for each day of the week.
              </p>

              <div style={styles.formGroup}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={resosEnableManualBreakfast}
                    onChange={(e) => setResosEnableManualBreakfast(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontWeight: 'bold' }}>Enable Manual Breakfast Periods</span>
                </label>
              </div>

              {resosEnableManualBreakfast && (
                <div style={{ marginTop: '1rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #ddd', background: '#f9f9f9' }}>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>Day</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>Start Time</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>End Time</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((dayName, idx) => {
                        const dayNumber = idx + 1
                        const period = resosManualBreakfastPeriods.find(p => p.day === dayNumber)

                        return (
                          <tr key={dayNumber} style={{ borderBottom: '1px solid #eee' }}>
                            <td style={{ padding: '0.5rem', fontWeight: 'bold' }}>{dayName}</td>
                            <td style={{ padding: '0.5rem' }}>
                              <input
                                type="time"
                                value={period?.start || ''}
                                onChange={(e) => {
                                  const newPeriods = resosManualBreakfastPeriods.filter(p => p.day !== dayNumber)
                                  if (e.target.value || period?.end) {
                                    newPeriods.push({
                                      day: dayNumber,
                                      start: e.target.value,
                                      end: period?.end || ''
                                    })
                                  }
                                  setResosManualBreakfastPeriods(newPeriods)
                                }}
                                style={{ padding: '0.25rem', border: '1px solid #ddd', borderRadius: '4px' }}
                              />
                            </td>
                            <td style={{ padding: '0.5rem' }}>
                              <input
                                type="time"
                                value={period?.end || ''}
                                onChange={(e) => {
                                  const newPeriods = resosManualBreakfastPeriods.filter(p => p.day !== dayNumber)
                                  if (e.target.value || period?.start) {
                                    newPeriods.push({
                                      day: dayNumber,
                                      start: period?.start || '',
                                      end: e.target.value
                                    })
                                  }
                                  setResosManualBreakfastPeriods(newPeriods)
                                }}
                                style={{ padding: '0.25rem', border: '1px solid #ddd', borderRadius: '4px' }}
                              />
                            </td>
                            <td style={{ padding: '0.5rem' }}>
                              {period && (
                                <button
                                  onClick={() => {
                                    setResosManualBreakfastPeriods(
                                      resosManualBreakfastPeriods.filter(p => p.day !== dayNumber)
                                    )
                                  }}
                                  style={{
                                    padding: '0.25rem 0.5rem',
                                    background: '#dc3545',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem'
                                  }}
                                >
                                  Clear
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <small style={{ ...styles.hint, display: 'block', marginTop: '0.5rem' }}>
                    Leave times blank for days without breakfast service. Times are in 24-hour format (e.g., 07:00 - 11:00).
                  </small>
                </div>
              )}
            </div>

            {/* Hotel Arrivals Widget Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Hotel Arrivals Widget Configuration</h3>

              <div style={styles.formGroup}>
                <label style={{ fontWeight: 'bold', display: 'block', marginBottom: '0.5rem' }}>
                  Service Filter for Arrivals Widget
                </label>
                <select
                  value={resosArrivalWidgetServiceFilter || ''}
                  onChange={(e) => setResosArrivalWidgetServiceFilter(e.target.value || null)}
                  style={{ padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px', width: '300px' }}
                >
                  <option value="">All Services</option>
                  {/* Extract unique service types from opening hours mapping */}
                  {Array.from(new Set(openingHoursMapping.map(m => m.service_type).filter(st => st)))
                    .sort()
                    .map((serviceType) => (
                      <option key={serviceType} value={serviceType}>
                        {serviceType.charAt(0).toUpperCase() + serviceType.slice(1)}
                      </option>
                    ))}
                </select>
                <small style={{ ...styles.hint, display: 'block', marginTop: '0.5rem' }}>
                  Filter the "Hotel Arrivals & Restaurant Bookings" dashboard widget to show only bookings for a specific service type (e.g., Dinner only). This filter spans all opening hours mapped to the selected service type across different days/times.
                </small>
              </div>
            </div>

            {/* Sync Configuration Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Sync Configuration</h3>

              <div style={styles.formGroup}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={resosSettings?.resos_auto_sync_enabled || false}
                    onChange={(e) => updateResosSyncMutation.mutate({ resos_auto_sync_enabled: e.target.checked })}
                  />
                  Enable automatic daily sync (4:30 AM)
                </label>
                <small style={styles.hint}>Syncs all historical and forecast data (past 30 days + next 60 days)</small>
              </div>

              {resosSettings?.resos_last_sync && (
                <div style={styles.formGroup}>
                  <small style={styles.hint}>Last full sync: {new Date(resosSettings.resos_last_sync).toLocaleString()}</small>
                </div>
              )}

              <div style={styles.formGroup}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={resosSettings?.resos_upcoming_sync_enabled || false}
                    onChange={(e) => updateResosSyncMutation.mutate({ resos_upcoming_sync_enabled: e.target.checked })}
                  />
                  Enable frequent upcoming sync (next 7 days)
                </label>
                <small style={styles.hint}>Keeps upcoming bookings fresh with more frequent updates</small>
              </div>

              {resosSettings?.resos_upcoming_sync_enabled && (
                <div style={styles.formGroup}>
                  <label>Sync interval (minutes)</label>
                  <input
                    type="number"
                    value={resosSettings?.resos_upcoming_sync_interval || 15}
                    onChange={(e) => updateResosSyncMutation.mutate({ resos_upcoming_sync_interval: parseInt(e.target.value) || 15 })}
                    min={5}
                    max={60}
                    style={styles.textInput}
                  />
                  <small style={styles.hint}>How often to sync upcoming bookings (5-60 minutes, default 15)</small>
                </div>
              )}

              {resosSettings?.resos_last_upcoming_sync && (
                <div style={styles.formGroup}>
                  <small style={styles.hint}>Last frequent sync: {new Date(resosSettings.resos_last_upcoming_sync).toLocaleString()}</small>
                </div>
              )}

              {resosSettings?.resos_upcoming_sync_enabled && (
                <div style={styles.formGroup}>
                  <button
                    onClick={async () => {
                      try {
                        setResosSaveMessage('Syncing upcoming bookings...')
                        const res = await fetch('/api/resos/sync/upcoming', {
                          method: 'POST',
                          headers: { Authorization: `Bearer ${token}` }
                        })
                        if (res.ok) {
                          const data = await res.json()
                          setResosSaveMessage(`✓ Upcoming sync complete: ${data.upcoming?.bookings_fetched || 0} bookings`)
                          queryClient.invalidateQueries({ queryKey: ['resos-settings'] })
                        } else {
                          setResosSaveMessage('✗ Upcoming sync failed')
                        }
                      } catch (error) {
                        setResosSaveMessage(`✗ Error: ${error}`)
                      }
                      setTimeout(() => setResosSaveMessage(null), 10000)
                    }}
                    style={styles.secondaryButton}
                  >
                    Sync Now (Next 7 Days)
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                <button
                  onClick={async () => {
                    try {
                      setResosSaveMessage('Syncing forecast...')
                      const res = await fetch('/api/resos/sync/forecast', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` }
                      })
                      if (res.ok) {
                        const data = await res.json()
                        setResosSaveMessage(`✓ Forecast synced: ${data.bookings_fetched} bookings`)
                        queryClient.invalidateQueries({ queryKey: ['resos-settings'] })
                      } else {
                        setResosSaveMessage('✗ Forecast sync failed')
                      }
                    } catch (error) {
                      setResosSaveMessage(`✗ Error: ${error}`)
                    }
                    setTimeout(() => setResosSaveMessage(null), 10000)
                  }}
                  style={styles.secondaryButton}
                >
                  Sync Forecast (Next 60 Days)
                </button>

                <button
                  onClick={() => setShowHistoricalResosModal(true)}
                  style={styles.secondaryButton}
                >
                  Sync Historical (Custom Range)
                </button>
              </div>

              {resosSaveMessage && (
                <div style={{ marginTop: '1rem', padding: '0.75rem', background: resosSaveMessage.includes('✓') ? '#d4edda' : '#f8d7da', borderRadius: '4px' }}>
                  {resosSaveMessage}
                </div>
              )}
            </div>

            {/* Save Button */}
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/resos/settings', {
                    method: 'PATCH',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      resos_api_key: resosApiKey || undefined,
                      // Note: sync settings (auto_sync_enabled, upcoming_sync_enabled, upcoming_sync_interval)
                      // are saved immediately on checkbox/input change, not with this Save button
                      resos_large_group_threshold: resosLargeGroupThreshold,
                      resos_note_keywords: resosNoteKeywords,
                      resos_allergy_keywords: resosAllergyKeywords,
                      resos_custom_field_mapping: customFieldMapping,
                      resos_opening_hours_mapping: openingHoursMapping,
                      resos_arrival_widget_service_filter: resosArrivalWidgetServiceFilter || null,
                      resos_enable_manual_breakfast: resosEnableManualBreakfast,
                      resos_manual_breakfast_periods: resosManualBreakfastPeriods
                    })
                  })
                  if (res.ok) {
                    setResosSaveMessage('✓ Settings saved successfully')
                    queryClient.invalidateQueries({ queryKey: ['resos-settings'] })
                  } else {
                    setResosSaveMessage('✗ Failed to save settings')
                  }
                } catch (error) {
                  setResosSaveMessage(`✗ Error: ${error}`)
                }
                setTimeout(() => setResosSaveMessage(null), 5000)
              }}
              style={{ ...styles.button, marginTop: '2rem' }}
            >
              Save Resos Settings
            </button>

            {/* View Resos Data Link */}
            <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid #e0e0e0' }}>
              <a
                href="/resos"
                style={{
                  display: 'inline-block',
                  padding: '0.75rem 1.5rem',
                  background: '#0066cc',
                  color: 'white',
                  textDecoration: 'none',
                  borderRadius: '6px',
                  fontWeight: 500,
                }}
              >
                View Resos Booking Data
              </a>
              <p style={{ ...styles.hint, marginTop: '0.5rem' }}>View synced booking data, covers, and flagged reservations from Resos.</p>
            </div>

            {showHistoricalResosModal && (
              <div style={styles.modal}>
                <div style={styles.modalContent}>
                  <h3>Sync Historical Bookings</h3>
                  <div style={styles.formGroup}>
                    <label>From Date:</label>
                    <input
                      type="date"
                      value={historicalResosDateFrom}
                      onChange={(e) => setHistoricalResosDateFrom(e.target.value)}
                      style={styles.input}
                    />
                  </div>
                  <div style={styles.formGroup}>
                    <label>To Date:</label>
                    <input
                      type="date"
                      value={historicalResosDateTo}
                      onChange={(e) => setHistoricalResosDateTo(e.target.value)}
                      style={styles.input}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                    <button
                      onClick={async () => {
                        try {
                          setResosSaveMessage('Syncing historical data...')
                          const res = await fetch(`/api/resos/sync/historical?from_date=${historicalResosDateFrom}&to_date=${historicalResosDateTo}`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` }
                          })
                          if (res.ok) {
                            const data = await res.json()
                            setResosSaveMessage(`✓ Historical synced: ${data.bookings_fetched} bookings`)
                            setShowHistoricalResosModal(false)
                            queryClient.invalidateQueries({ queryKey: ['resos-settings'] })
                          } else {
                            setResosSaveMessage('✗ Historical sync failed')
                          }
                        } catch (error) {
                          setResosSaveMessage(`✗ Error: ${error}`)
                        }
                        setTimeout(() => setResosSaveMessage(null), 10000)
                      }}
                      style={styles.button}
                    >
                      Start Sync
                    </button>
                    <button
                      onClick={() => setShowHistoricalResosModal(false)}
                      style={styles.secondaryButton}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SambaPOS EPOS Section */}
        {activeSection === 'sambapos' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>SambaPOS EPOS Settings</h2>
            <p style={styles.hint}>Connect to your SambaPOS MSSQL database to fetch kitchen courses and sales data for Top Sellers reports.</p>

            {/* Database Connection Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Database Connection</h3>
              <div style={styles.form}>
              <label style={styles.label}>
                Server Host
                <input
                  type="text"
                  value={sambaDbHost}
                  onChange={(e) => setSambaDbHost(e.target.value)}
                  style={styles.input}
                  placeholder="localhost\SQLEXPRESS17"
                />
                <span style={{ fontSize: '0.8rem', color: '#888' }}>For named instances, use format: hostname\instancename</span>
              </label>
              <label style={styles.label}>
                Port
                <input
                  type="number"
                  value={sambaDbPort}
                  onChange={(e) => setSambaDbPort(e.target.value)}
                  style={styles.input}
                  placeholder="1433"
                />
                <span style={{ fontSize: '0.8rem', color: '#888' }}>Default SQL Server port is 1433 (ignored for named instances)</span>
              </label>
              <label style={styles.label}>
                Database Name
                <input
                  type="text"
                  value={sambaDbName}
                  onChange={(e) => setSambaDbName(e.target.value)}
                  style={styles.input}
                  placeholder="SambaPOS5"
                />
              </label>
              <label style={styles.label}>
                Username
                <input
                  type="text"
                  value={sambaDbUsername}
                  onChange={(e) => setSambaDbUsername(e.target.value)}
                  style={styles.input}
                  placeholder="sa"
                />
              </label>
              <label style={styles.label}>
                Password
                <input
                  type="password"
                  value={sambaDbPassword}
                  onChange={(e) => setSambaDbPassword(e.target.value)}
                  style={styles.input}
                  placeholder={sambaSettings?.sambapos_db_password_set ? '********' : 'Enter password'}
                />
                {sambaSettings?.sambapos_db_password_set && !sambaDbPassword && (
                  <span style={styles.keyStatus}>Password is configured</span>
                )}
              </label>

              <div style={styles.buttonRow}>
                <button
                  onClick={() => sambaTestMutation.mutate()}
                  style={styles.testBtn}
                  disabled={sambaTestMutation.isPending || !sambaDbHost || !sambaDbName || !sambaDbUsername}
                >
                  {sambaTestMutation.isPending ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  onClick={handleSaveSambaConnection}
                  style={styles.saveBtn}
                  disabled={updateSambaMutation.isPending}
                >
                  {updateSambaMutation.isPending ? 'Saving...' : 'Save Connection'}
                </button>
              </div>

                {sambaTestStatus && (
                  <div style={{ ...styles.statusMessage, background: sambaTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                    {sambaTestStatus}
                  </div>
                )}
              </div>
            </div>

            {/* Kitchen Courses Selection Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Kitchen Courses for Top Sellers</h3>
            <p style={styles.hint}>
              Select and order kitchen courses for the Top Sellers report. Use arrows to change the display order in reports.
            </p>

            {!sambaConnectionConfigured ? (
              <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', color: '#666', textAlign: 'center' }}>
                Configure and test your database connection above to load courses.
              </div>
            ) : sambaCategoriesLoading ? (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#666' }}>Loading courses...</div>
            ) : sambaCategoriesError ? (
              <div style={{ padding: '1rem', background: '#fee', borderRadius: '6px', color: '#c00' }}>
                Failed to load courses: {(sambaCategoriesError as Error).message}
                <button onClick={() => refetchSambaCategories()} style={{ ...styles.actionBtn, marginLeft: '1rem' }}>
                  Retry
                </button>
              </div>
            ) : sambaCategories && sambaCategories.length > 0 ? (
              <>
                {/* Selected courses with ordering */}
                <div style={{ marginBottom: '1rem' }}>
                  <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Selected Courses (in report order):</strong>
                  {sambaSelectedCourses.length === 0 ? (
                    <div style={{ padding: '1rem', background: '#f8f9fa', borderRadius: '6px', color: '#666', fontStyle: 'italic' }}>
                      No courses selected. Add courses from the list below.
                    </div>
                  ) : (
                    <div style={styles.sortableList}>
                      {sambaSelectedCourses.map((course, index) => (
                        <div key={course} style={styles.sortableItem}>
                          <span style={styles.sortableOrder}>{index + 1}</span>
                          <span style={styles.sortableName}>{course}</span>
                          <div style={styles.sortableButtons}>
                            <button
                              onClick={() => moveCourseUp(index)}
                              disabled={index === 0}
                              style={styles.arrowBtn}
                              title="Move up"
                            >
                              ▲
                            </button>
                            <button
                              onClick={() => moveCourseDown(index)}
                              disabled={index === sambaSelectedCourses.length - 1}
                              style={styles.arrowBtn}
                              title="Move down"
                            >
                              ▼
                            </button>
                            <button
                              onClick={() => toggleSambaCourse(course)}
                              style={styles.removeBtn}
                              title="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Available courses to add */}
                <div style={{ marginBottom: '1rem' }}>
                  <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Available Courses:</strong>
                  <div style={styles.sambaCategoryGrid}>
                    {sambaCategories
                      .filter(cat => !sambaSelectedCourses.includes(cat.name))
                      .map((cat) => (
                        <button
                          key={cat.id}
                          onClick={() => toggleSambaCourse(cat.name)}
                          style={styles.addCourseBtn}
                        >
                          + {cat.name}
                        </button>
                      ))}
                    {sambaCategories.filter(cat => !sambaSelectedCourses.includes(cat.name)).length === 0 && (
                      <span style={{ color: '#666', fontStyle: 'italic' }}>All courses selected</span>
                    )}
                  </div>
                </div>

                <div style={styles.buttonRow}>
                  <button
                    onClick={() => {
                      if (sambaCategories) {
                        setSambaSelectedCourses(sambaCategories.map(c => c.name))
                      }
                    }}
                    style={styles.actionBtn}
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setSambaSelectedCourses([])}
                    style={styles.actionBtn}
                  >
                    Clear All
                  </button>
                  <button
                    onClick={handleSaveSambaCourses}
                    style={styles.saveBtn}
                    disabled={saveSambaCoursesMutation.isPending}
                  >
                    {saveSambaCoursesMutation.isPending ? 'Saving...' : 'Save Courses'}
                  </button>
                </div>

                <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#e8f4fd', borderRadius: '6px', textAlign: 'center', fontWeight: 500 }}>
                  {sambaSelectedCourses.length} of {sambaCategories.length} courses selected
                </div>
              </>
            ) : (
              <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', color: '#666', textAlign: 'center' }}>
                No courses found. Please verify your SambaPOS menu items have the "Kitchen Course" product tag configured.
              </div>
            )}
            </div>

            {/* Excluded Menu Categories Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Excluded Menu Categories</h3>
            <p style={styles.hint}>
              Select menu categories (GroupCode) to exclude from the Top Sellers report (e.g., "Drinks", "Extras").
            </p>

            {!sambaConnectionConfigured ? (
              <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', color: '#666', textAlign: 'center' }}>
                Configure your database connection above first.
              </div>
            ) : sambaGroupCodesLoading ? (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#666' }}>Loading menu categories...</div>
            ) : sambaGroupCodes && sambaGroupCodes.length > 0 ? (
              <>
                <div style={styles.buttonRow}>
                  <button
                    onClick={() => setSambaExcludedItems(new Set())}
                    style={styles.actionBtn}
                  >
                    Clear Exclusions
                  </button>
                  <button
                    onClick={handleSaveExcludedItems}
                    style={styles.saveBtn}
                    disabled={saveExcludedItemsMutation.isPending}
                  >
                    {saveExcludedItemsMutation.isPending ? 'Saving...' : 'Save Exclusions'}
                  </button>
                </div>

                <div style={styles.excludedItemsGrid}>
                  {sambaGroupCodes.map((groupCode) => (
                    <label key={groupCode.name} style={styles.excludedItem}>
                      <input
                        type="checkbox"
                        checked={sambaExcludedItems.has(groupCode.name)}
                        onChange={() => toggleExcludedItem(groupCode.name)}
                      />
                      <span style={{ flex: 1 }}>{groupCode.name}</span>
                    </label>
                  ))}
                </div>

                <div style={{ marginTop: '1rem', padding: '0.75rem', background: sambaExcludedItems.size > 0 ? '#fef3c7' : '#e8f4fd', borderRadius: '6px', textAlign: 'center', fontWeight: 500 }}>
                  {sambaExcludedItems.size} categories excluded from reports
                </div>
              </>
            ) : (
              <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', color: '#666', textAlign: 'center' }}>
                No menu categories found.
                <button onClick={() => refetchSambaGroupCodes()} style={{ ...styles.actionBtn, marginLeft: '1rem' }}>
                  Retry
                </button>
              </div>
            )}

            </div>

            {/* Status Message - outside blocks */}
            {sambaSaveMessage && (
              <div style={{ ...styles.statusMessage, background: sambaSaveMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '1rem' }}>
                {sambaSaveMessage}
              </div>
            )}

            {/* GL Code Classification Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>GL Code Classification for Spend Analysis</h3>
            <p style={styles.hint}>
              Fetch unique GL codes from "NewBook GLA" custom tags and classify them as food or beverage.
              Used to calculate average spend per cover and food/beverage split in the Bookings Stats Report.
            </p>

            {!sambaConnectionConfigured ? (
              <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', color: '#666', textAlign: 'center' }}>
                Configure your database connection above first.
              </div>
            ) : sambaGLCodesLoading ? (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#666' }}>Loading GL codes...</div>
            ) : sambaGLCodes && sambaGLCodes.length > 0 ? (
              <>
                <div style={styles.buttonRow}>
                  <button
                    onClick={() => {
                      setSambaFoodGLCodes(new Set())
                      setSambaBeverageGLCodes(new Set())
                    }}
                    style={styles.actionBtn}
                  >
                    Clear Selections
                  </button>
                  <button
                    onClick={handleSaveGLCodes}
                    style={styles.saveBtn}
                    disabled={saveGLCodesMutation.isPending}
                  >
                    {saveGLCodesMutation.isPending ? 'Saving...' : 'Save GL Codes'}
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginTop: '1.5rem' }}>
                  {/* Food GL Codes */}
                  <div>
                    <h4 style={{ marginBottom: '1rem', color: '#374151', fontSize: '1rem' }}>
                      Food GL Codes ({sambaFoodGLCodes.size} selected)
                    </h4>
                    <div style={{ ...styles.excludedItemsGrid, maxHeight: '400px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem' }}>
                      {sambaGLCodes.map((glCode) => (
                        <label key={glCode.code} style={styles.excludedItem}>
                          <input
                            type="checkbox"
                            checked={sambaFoodGLCodes.has(glCode.code)}
                            onChange={() => toggleFoodGLCode(glCode.code)}
                            disabled={sambaBeverageGLCodes.has(glCode.code)}
                          />
                          <span style={{ flex: 1, color: sambaBeverageGLCodes.has(glCode.code) ? '#999' : '#000' }}>
                            {glCode.code}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Beverage GL Codes */}
                  <div>
                    <h4 style={{ marginBottom: '1rem', color: '#374151', fontSize: '1rem' }}>
                      Beverage GL Codes ({sambaBeverageGLCodes.size} selected)
                    </h4>
                    <div style={{ ...styles.excludedItemsGrid, maxHeight: '400px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem' }}>
                      {sambaGLCodes.map((glCode) => (
                        <label key={glCode.code} style={styles.excludedItem}>
                          <input
                            type="checkbox"
                            checked={sambaBeverageGLCodes.has(glCode.code)}
                            onChange={() => toggleBeverageGLCode(glCode.code)}
                            disabled={sambaFoodGLCodes.has(glCode.code)}
                          />
                          <span style={{ flex: 1, color: sambaFoodGLCodes.has(glCode.code) ? '#999' : '#000' }}>
                            {glCode.code}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: '1rem', padding: '0.75rem', background: (sambaFoodGLCodes.size > 0 || sambaBeverageGLCodes.size > 0) ? '#dcfce7' : '#e8f4fd', borderRadius: '6px', textAlign: 'center', fontWeight: 500 }}>
                  {sambaFoodGLCodes.size} food codes, {sambaBeverageGLCodes.size} beverage codes selected
                </div>
              </>
            ) : (
              <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', color: '#666', textAlign: 'center' }}>
                No GL codes found in ProductTag custom tags.
                <button onClick={() => refetchSambaGLCodes()} style={{ ...styles.actionBtn, marginLeft: '1rem' }}>
                  Retry
                </button>
              </div>
            )}

            </div>

            {/* GL Codes Status Message - outside blocks */}
            {sambaGLCodesSaveMessage && (
              <div style={{ ...styles.statusMessage, background: sambaGLCodesSaveMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '1rem' }}>
                {sambaGLCodesSaveMessage}
              </div>
            )}
          </div>
        )}

        {/* KDS (Kitchen Display System) Section */}
        {activeSection === 'kds' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Kitchen Display System Settings</h2>
            <p style={styles.hint}>Configure the KDS to display orders from SambaPOS GraphQL API for kitchen staff.</p>

            {/* Connection Settings */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>SambaPOS GraphQL Connection</h3>
              <p style={styles.blockHint}>Connect to SambaPOS Message Server to fetch kitchen orders in real-time.</p>

              <label style={styles.label}>
                GraphQL URL
                <input
                  type="text"
                  value={kdsGraphqlUrl}
                  onChange={(e) => setKdsGraphqlUrl(e.target.value)}
                  style={styles.input}
                  placeholder="http://localhost:9000"
                />
              </label>

              <label style={styles.label}>
                Username
                <input
                  type="text"
                  value={kdsGraphqlUsername}
                  onChange={(e) => setKdsGraphqlUsername(e.target.value)}
                  style={styles.input}
                  placeholder="Admin"
                />
              </label>

              <label style={styles.label}>
                Password
                <input
                  type="password"
                  value={kdsGraphqlPassword}
                  onChange={(e) => setKdsGraphqlPassword(e.target.value)}
                  style={styles.input}
                  placeholder={kdsSettings?.kds_graphql_password_set ? '••••••••' : 'Enter password'}
                />
              </label>

              <label style={styles.label}>
                Client ID (Application Key)
                <input
                  type="text"
                  value={kdsGraphqlClientId}
                  onChange={(e) => setKdsGraphqlClientId(e.target.value)}
                  style={styles.input}
                  placeholder="graphiql"
                />
              </label>

              <div style={styles.buttonRow}>
                <button
                  onClick={() => kdsTestMutation.mutate()}
                  style={styles.testBtn}
                  disabled={kdsTestMutation.isPending || !kdsGraphqlUrl}
                >
                  {kdsTestMutation.isPending ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  onClick={handleSaveKdsConnection}
                  style={styles.saveBtn}
                  disabled={updateKdsMutation.isPending}
                >
                  {updateKdsMutation.isPending ? 'Saving...' : 'Save Connection'}
                </button>
              </div>

              {kdsTestStatus && (
                <div style={{ ...styles.statusMessage, background: kdsTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                  {kdsTestStatus}
                </div>
              )}
            </div>

            {/* Display Settings */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Display Settings</h3>
              <p style={styles.blockHint}>Configure how tickets and timers are displayed on the KDS screen.</p>

              <label style={styles.label}>
                Poll Interval (seconds)
                <input
                  type="number"
                  value={kdsPollInterval}
                  onChange={(e) => setKdsPollInterval(parseInt(e.target.value) || 5)}
                  style={styles.input}
                  min="1"
                  max="60"
                />
              </label>

              <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Timer Thresholds (seconds)</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                <label style={styles.label}>
                  <span style={{ color: '#27ae60' }}>Green until</span>
                  <input
                    type="number"
                    value={kdsTimerGreen}
                    onChange={(e) => setKdsTimerGreen(parseInt(e.target.value) || 300)}
                    style={styles.input}
                    min="0"
                  />
                </label>
                <label style={styles.label}>
                  <span style={{ color: '#f39c12' }}>Amber until</span>
                  <input
                    type="number"
                    value={kdsTimerAmber}
                    onChange={(e) => setKdsTimerAmber(parseInt(e.target.value) || 600)}
                    style={styles.input}
                    min="0"
                  />
                </label>
                <label style={styles.label}>
                  <span style={{ color: '#e94560' }}>Red after</span>
                  <input
                    type="number"
                    value={kdsTimerRed}
                    onChange={(e) => setKdsTimerRed(parseInt(e.target.value) || 900)}
                    style={styles.input}
                    min="0"
                  />
                </label>
              </div>

              <label style={styles.label}>
                Course Order (comma-separated)
                <input
                  type="text"
                  value={kdsCourseOrder}
                  onChange={(e) => setKdsCourseOrder(e.target.value)}
                  style={styles.input}
                  placeholder="Starters, Mains, Desserts"
                />
              </label>

              <label style={styles.label}>
                Show Completed Tickets For (seconds)
                <input
                  type="number"
                  value={kdsShowCompleted}
                  onChange={(e) => setKdsShowCompleted(parseInt(e.target.value) || 30)}
                  style={styles.input}
                  min="0"
                  max="300"
                />
              </label>

              <div style={styles.buttonRow}>
                <button
                  onClick={handleSaveKdsDisplay}
                  style={styles.saveBtn}
                  disabled={updateKdsMutation.isPending}
                >
                  {updateKdsMutation.isPending ? 'Saving...' : 'Save Display Settings'}
                </button>
              </div>

              {kdsSaveMessage && (
                <div style={{ ...styles.statusMessage, background: kdsSaveMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '1rem' }}>
                  {kdsSaveMessage}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Suppliers Section */}
        {activeSection === 'suppliers' && (
          <div style={styles.section}>
            <Suppliers />
          </div>
        )}

        {/* Nextcloud Storage Section */}
        {activeSection === 'nextcloud' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Nextcloud File Storage</h2>
            <p style={styles.hint}>
              Archive confirmed invoices to Nextcloud to reduce local storage. Files are organized by supplier, year, and month.
            </p>

            {/* Nextcloud Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Nextcloud Settings</h3>
              <div style={styles.form}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={nextcloudEnabled}
                  onChange={(e) => setNextcloudEnabled(e.target.checked)}
                />
                Enable Nextcloud archival
              </label>

              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={nextcloudDeleteLocal}
                  onChange={(e) => setNextcloudDeleteLocal(e.target.checked)}
                  disabled={!nextcloudEnabled}
                />
                Delete local files after successful archive
              </label>
              <p style={{ ...styles.hint, marginLeft: '1.5rem', marginTop: '-0.5rem', marginBottom: '1rem' }}>
                Frees up Docker storage after files are safely archived to Nextcloud
              </p>

              <label style={styles.label}>
                Nextcloud Host URL
                <input
                  type="text"
                  value={nextcloudHost}
                  onChange={(e) => setNextcloudHost(e.target.value)}
                  placeholder="https://cloud.example.com"
                  style={styles.input}
                />
              </label>

              <label style={styles.label}>
                Username
                <input
                  type="text"
                  value={nextcloudUsername}
                  onChange={(e) => setNextcloudUsername(e.target.value)}
                  style={styles.input}
                />
              </label>

              <label style={styles.label}>
                Password
                <input
                  type="password"
                  value={nextcloudPassword}
                  onChange={(e) => setNextcloudPassword(e.target.value)}
                  placeholder={nextcloudSettings?.nextcloud_password_set ? '••••••••' : 'Enter password'}
                  style={styles.input}
                />
                {nextcloudSettings?.nextcloud_password_set && (
                  <span style={styles.keyStatus}>Password is set</span>
                )}
              </label>

              <label style={styles.label}>
                Base Directory
                <input
                  type="text"
                  value={nextcloudBasePath}
                  onChange={(e) => setNextcloudBasePath(e.target.value)}
                  placeholder="/Kitchen Invoices"
                  style={styles.input}
                />
              </label>

              <p style={{ ...styles.hint, marginTop: '0.5rem' }}>
                Files organized as: {nextcloudBasePath || '/Kitchen Invoices'}/Supplier/Year/Month/
              </p>

              <div style={styles.buttonRow}>
                <button
                  onClick={() => {
                    const data: Record<string, unknown> = {
                      nextcloud_host: nextcloudHost,
                      nextcloud_username: nextcloudUsername,
                      nextcloud_base_path: nextcloudBasePath,
                      nextcloud_enabled: nextcloudEnabled,
                      nextcloud_delete_local: nextcloudDeleteLocal,
                    }
                    if (nextcloudPassword) {
                      data.nextcloud_password = nextcloudPassword
                    }
                    saveNextcloudMutation.mutate(data)
                  }}
                  style={styles.saveBtn}
                  disabled={saveNextcloudMutation.isPending}
                >
                  {saveNextcloudMutation.isPending ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  onClick={() => nextcloudTestMutation.mutate()}
                  style={styles.testBtn}
                  disabled={nextcloudTestMutation.isPending}
                >
                  {nextcloudTestMutation.isPending ? 'Testing...' : 'Test Connection'}
                </button>
              </div>

              {nextcloudSaveMessage && (
                <div style={{ ...styles.statusMessage, background: nextcloudSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                  {nextcloudSaveMessage}
                </div>
              )}

                {nextcloudTestStatus && (
                  <div style={{ ...styles.statusMessage, background: nextcloudTestStatus.startsWith('Error') ? '#fee' : '#efe' }}>
                    {nextcloudTestStatus}
                  </div>
                )}
              </div>
            </div>

            {/* Manual Archive Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Manual Archive</h3>
            <p style={styles.hint}>
              Manually archive completed invoices that haven't been transferred to Nextcloud yet.
            </p>

            {nextcloudStats && (
              <div style={styles.dataActions}>
                <div style={styles.dataAction}>
                  <div>
                    <strong>Total local files:</strong> {nextcloudStats.local_count} invoices
                    <p style={styles.actionDesc}>All invoices stored in Docker container</p>
                  </div>
                </div>
                <div style={styles.dataAction}>
                  <div>
                    <strong>Ready for archival:</strong> {nextcloudStats.pending_count}
                    <p style={styles.actionDesc}>Confirmed invoices that can be archived</p>
                  </div>
                </div>
                <div style={styles.dataAction}>
                  <div>
                    <strong>Already archived:</strong> {nextcloudStats.archived_count} invoices
                  </div>
                </div>
                <div style={styles.dataAction}>
                  <div>
                    <strong>Archive All Pending</strong>
                    <p style={styles.actionDesc}>Transfer all eligible invoices to Nextcloud now</p>
                  </div>
                  <button
                    onClick={() => {
                      if (confirm(`Archive ${nextcloudStats.pending_count} invoices to Nextcloud?`)) {
                        archiveAllMutation.mutate()
                      }
                    }}
                    style={styles.actionBtn}
                    disabled={archiveAllMutation.isPending || nextcloudStats.pending_count === 0 || !nextcloudStats.nextcloud_configured}
                  >
                    {archiveAllMutation.isPending ? 'Archiving...' : 'Archive All'}
                  </button>
                </div>
              </div>
            )}

            </div>

            {/* Archive Status Message - outside blocks */}
            {archiveMessage && (
              <div style={{ ...styles.statusMessage, background: archiveMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '1rem' }}>
                {archiveMessage}
              </div>
            )}
          </div>
        )}

        {/* Search & Pricing Section */}
        {activeSection === 'search' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Search & Pricing</h2>

            {/* Price Change Detection Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Price Change Detection</h3>
              <p style={{ marginBottom: '1rem', color: '#666' }}>
                Configure how price changes are detected and flagged on invoices.
                When a line item's price differs from historical prices, it will be marked with a warning indicator.
              </p>

              <div style={styles.form}>
              <label style={styles.label}>
                Lookback Period (days)
                <input
                  type="number"
                  value={priceLookbackDays}
                  onChange={(e) => setPriceLookbackDays(parseInt(e.target.value) || 30)}
                  min="1"
                  max="365"
                  style={styles.input}
                />
                <span style={{ fontSize: '0.85rem', color: '#666' }}>
                  How far back to check for price history (default: 30 days)
                </span>
              </label>

              <label style={styles.label}>
                Amber Warning Threshold (%)
                <input
                  type="number"
                  value={priceAmberThreshold}
                  onChange={(e) => setPriceAmberThreshold(parseInt(e.target.value) || 10)}
                  min="1"
                  max="100"
                  style={styles.input}
                />
                <span style={{ fontSize: '0.85rem', color: '#666' }}>
                  Price changes above this % show amber warning (default: 10%)
                </span>
              </label>

              <label style={styles.label}>
                Red Warning Threshold (%)
                <input
                  type="number"
                  value={priceRedThreshold}
                  onChange={(e) => setPriceRedThreshold(parseInt(e.target.value) || 20)}
                  min="1"
                  max="100"
                  style={styles.input}
                />
                <span style={{ fontSize: '0.85rem', color: '#666' }}>
                  Price changes above this % show red warning (default: 20%)
                </span>
              </label>

              <button
                onClick={() => {
                  saveSearchSettingsMutation.mutate({
                    price_change_lookback_days: priceLookbackDays,
                    price_change_amber_threshold: priceAmberThreshold,
                    price_change_red_threshold: priceRedThreshold,
                  })
                }}
                style={styles.btn}
                disabled={saveSearchSettingsMutation.isPending}
              >
                {saveSearchSettingsMutation.isPending ? 'Saving...' : 'Save Settings'}
              </button>

                {searchSaveMessage && (
                  <div style={{ ...styles.statusMessage, background: searchSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                    {searchSaveMessage}
                  </div>
                )}
              </div>
            </div>

            {/* Price Status Legend - read-only info, can stay outside blocks or in its own block */}
            <h3 style={{ ...styles.subsectionTitle, marginTop: '2rem' }}>Price Status Legend</h3>
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#22c55e', fontWeight: 'bold', fontSize: '1.2rem' }}>✓</span>
                <span>Price consistent (no significant change)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '1.2rem' }}>?</span>
                <span>Small price change (amber threshold)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#ef4444', fontWeight: 'bold', fontSize: '1.2rem' }}>!</span>
                <span>Large price change (red threshold)</span>
              </div>
            </div>
            <p style={{ color: '#666', fontSize: '0.9rem' }}>
              Click on a price status icon to view the full price history and acknowledge the change.
            </p>
          </div>
        )}

        {/* Backup & Restore Section */}
        {activeSection === 'backup' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Backup & Restore</h2>

            {/* Backup Settings Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Backup Settings</h3>
              <div style={styles.form}>
              <label style={styles.label}>
                Frequency
                <select
                  value={backupFrequency}
                  onChange={(e) => setBackupFrequency(e.target.value)}
                  style={styles.input}
                >
                  <option value="manual">Manual Only</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly (Sundays)</option>
                </select>
              </label>

              <label style={styles.label}>
                Time (for scheduled backups)
                <input
                  type="time"
                  value={backupTime}
                  onChange={(e) => setBackupTime(e.target.value)}
                  style={styles.input}
                />
              </label>

              <label style={styles.label}>
                Retention (number of backups to keep)
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={backupRetentionCount}
                  onChange={(e) => setBackupRetentionCount(parseInt(e.target.value) || 7)}
                  style={styles.input}
                />
              </label>

              <label style={styles.label}>
                Destination
                <select
                  value={backupDestination}
                  onChange={(e) => setBackupDestination(e.target.value)}
                  style={styles.input}
                >
                  <option value="local">Local Storage</option>
                  <option value="nextcloud">Nextcloud</option>
                  <option value="smb">SMB Network Share</option>
                </select>
              </label>

              {backupDestination === 'nextcloud' && (
                <>
                  {!nextcloudStats?.nextcloud_configured && (
                    <div style={{ ...styles.statusMessage, background: '#fee', marginTop: '0.5rem' }}>
                      ⚠️ Nextcloud is not configured. Please set up Nextcloud credentials in the Nextcloud Storage settings first.
                    </div>
                  )}
                  <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Nextcloud Backup Settings</h4>
                  <label style={styles.label}>
                    Backup Directory Path
                    <input
                      type="text"
                      value={backupNextcloudPath}
                      onChange={(e) => setBackupNextcloudPath(e.target.value)}
                      placeholder="/Backups"
                      style={styles.input}
                      disabled={!nextcloudStats?.nextcloud_configured}
                    />
                  </label>
                  <p style={styles.hint}>
                    Path on Nextcloud where backups will be stored (separate from invoice archives)
                  </p>
                </>
              )}

              {backupDestination === 'smb' && (
                <>
                  <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>SMB Network Share Settings</h4>
                  <label style={styles.label}>
                    SMB Host
                    <input
                      type="text"
                      value={backupSmbHost}
                      onChange={(e) => setBackupSmbHost(e.target.value)}
                      placeholder="192.168.1.100"
                      style={styles.input}
                    />
                  </label>
                  <label style={styles.label}>
                    Share Name
                    <input
                      type="text"
                      value={backupSmbShare}
                      onChange={(e) => setBackupSmbShare(e.target.value)}
                      placeholder="backups"
                      style={styles.input}
                    />
                  </label>
                  <label style={styles.label}>
                    Username
                    <input
                      type="text"
                      value={backupSmbUsername}
                      onChange={(e) => setBackupSmbUsername(e.target.value)}
                      style={styles.input}
                    />
                  </label>
                  <label style={styles.label}>
                    Password
                    <input
                      type="password"
                      value={backupSmbPassword}
                      onChange={(e) => setBackupSmbPassword(e.target.value)}
                      placeholder={backupSettings?.backup_smb_password_set ? '••••••••' : 'Enter password'}
                      style={styles.input}
                    />
                    {backupSettings?.backup_smb_password_set && (
                      <span style={styles.keyStatus}>Password is set</span>
                    )}
                  </label>
                  <label style={styles.label}>
                    Path on Share
                    <input
                      type="text"
                      value={backupSmbPath}
                      onChange={(e) => setBackupSmbPath(e.target.value)}
                      placeholder="/kitchen-backups"
                      style={styles.input}
                    />
                  </label>
                </>
              )}

              <div style={styles.buttonRow}>
                <button
                  onClick={() => {
                    const data: Record<string, unknown> = {
                      backup_frequency: backupFrequency,
                      backup_retention_count: backupRetentionCount,
                      backup_destination: backupDestination,
                      backup_time: backupTime,
                    }
                    if (backupDestination === 'nextcloud') {
                      data.backup_nextcloud_path = backupNextcloudPath
                    }
                    if (backupDestination === 'smb') {
                      data.backup_smb_host = backupSmbHost
                      data.backup_smb_share = backupSmbShare
                      data.backup_smb_username = backupSmbUsername
                      data.backup_smb_path = backupSmbPath
                      if (backupSmbPassword) {
                        data.backup_smb_password = backupSmbPassword
                      }
                    }
                    saveBackupMutation.mutate(data)
                  }}
                  style={styles.saveBtn}
                  disabled={saveBackupMutation.isPending || (backupDestination === 'nextcloud' && !nextcloudStats?.nextcloud_configured)}
                >
                  {saveBackupMutation.isPending ? 'Saving...' : 'Save Backup Settings'}
                </button>
              </div>

                {backupSaveMessage && (
                  <div style={{ ...styles.statusMessage, background: backupSaveMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                    {backupSaveMessage}
                  </div>
                )}
              </div>
            </div>

            {/* Manual Backup Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Manual Backup</h3>
            <div style={styles.dataActions}>
              <div style={styles.dataAction}>
                <div>
                  <strong>Last Backup:</strong>{' '}
                  {backupSettings?.backup_last_run_at
                    ? new Date(backupSettings.backup_last_run_at).toLocaleString()
                    : 'Never'}
                  {backupSettings?.backup_last_status && (
                    <span style={{ marginLeft: '1rem', color: backupSettings.backup_last_status === 'success' ? '#28a745' : '#dc3545' }}>
                      {backupSettings.backup_last_status === 'success' ? 'Success' : 'Failed'}
                    </span>
                  )}
                  {backupSettings?.backup_last_error && (
                    <p style={{ ...styles.actionDesc, color: '#dc3545' }}>{backupSettings.backup_last_error}</p>
                  )}
                </div>
                <button
                  onClick={() => createBackupMutation.mutate()}
                  style={styles.saveBtn}
                  disabled={createBackupMutation.isPending}
                >
                  {createBackupMutation.isPending ? 'Creating...' : 'Create Backup Now'}
                </button>
              </div>
            </div>
            </div>

            {/* Backup Create Status - outside blocks */}
            {backupCreateMessage && (
              <div style={{ ...styles.statusMessage, background: backupCreateMessage.startsWith('Error') ? '#fee' : '#efe', marginTop: '1rem' }}>
                {backupCreateMessage}
              </div>
            )}

            {/* Restore from File Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Restore from File</h3>
            <div style={styles.dataActions}>
              <div style={styles.dataAction}>
                <div>
                  <strong>Upload Backup File</strong>
                  <p style={styles.actionDesc}>
                    Restore invoice files from a previously downloaded backup ZIP file.
                    Only missing files will be restored (existing files are not overwritten).
                  </p>
                </div>
                <input
                  type="file"
                  accept=".zip"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      if (confirm('Restore from this backup file? Only missing files will be restored.')) {
                        uploadBackupMutation.mutate(file)
                      }
                      e.target.value = ''
                    }
                  }}
                  style={{ display: 'none' }}
                  id="backup-upload-input"
                />
                <label
                  htmlFor="backup-upload-input"
                  style={{
                    ...styles.saveBtn,
                    cursor: uploadBackupMutation.isPending ? 'not-allowed' : 'pointer',
                    opacity: uploadBackupMutation.isPending ? 0.6 : 1,
                    display: 'inline-block',
                  }}
                >
                  {uploadBackupMutation.isPending ? 'Uploading...' : 'Upload & Restore'}
                </label>
              </div>
            </div>
            </div>

            {/* Backup History Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Backup History</h3>
            {backupHistory && backupHistory.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Date</th>
                      <th style={styles.th}>Type</th>
                      <th style={styles.th}>Destination</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>Size</th>
                      <th style={styles.th}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupHistory.map((backup) => (
                      <tr key={backup.id}>
                        <td style={styles.td}>{new Date(backup.started_at).toLocaleString()}</td>
                        <td style={styles.td}>{backup.backup_type}</td>
                        <td style={styles.td}>{backup.destination}</td>
                        <td style={styles.td}>
                          <span style={{ color: backup.status === 'success' ? '#28a745' : backup.status === 'running' ? '#ffc107' : '#dc3545' }}>
                            {backup.status}
                          </span>
                        </td>
                        <td style={styles.td}>
                          {backup.file_size_bytes ? `${(backup.file_size_bytes / 1024 / 1024).toFixed(1)} MB` : '-'}
                        </td>
                        <td style={styles.td}>
                          <div style={styles.actionButtons}>
                            <button
                              onClick={async () => {
                                try {
                                  const res = await fetch(`/api/backup/${backup.id}/download`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                  })
                                  if (!res.ok) throw new Error('Download failed')
                                  const blob = await res.blob()
                                  const url = window.URL.createObjectURL(blob)
                                  const a = document.createElement('a')
                                  a.href = url
                                  a.download = backup.filename
                                  document.body.appendChild(a)
                                  a.click()
                                  window.URL.revokeObjectURL(url)
                                  document.body.removeChild(a)
                                } catch (err) {
                                  setBackupCreateMessage(`Error: Download failed`)
                                }
                              }}
                              style={styles.actionBtn}
                              disabled={backup.status !== 'success'}
                              title="Download"
                            >
                              Download
                            </button>
                            <button
                              onClick={() => {
                                if (confirm('Restore from this backup? This will restore files that are missing locally.')) {
                                  restoreBackupMutation.mutate(backup.id)
                                }
                              }}
                              style={styles.actionBtn}
                              disabled={backup.status !== 'success' || restoreBackupMutation.isPending}
                              title="Restore"
                            >
                              Restore
                            </button>
                            <button
                              onClick={() => {
                                if (confirm('Delete this backup?')) {
                                  deleteBackupMutation.mutate(backup.id)
                                }
                              }}
                              style={styles.deleteBtn}
                              disabled={deleteBackupMutation.isPending}
                              title="Delete"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={styles.hint}>No backups yet. Create your first backup above.</p>
            )}
            </div>
          </div>
        )}

        {/* Data Management Section */}
        {activeSection === 'data' && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Data Management</h2>
            <p style={styles.hint}>Tools for reprocessing invoices and fixing supplier matching issues.</p>

            {/* Data Actions Block */}
            <div style={styles.settingsBlock}>
              <h3 style={styles.blockTitle}>Data Actions</h3>
              <div style={styles.dataActions}>
              <div style={styles.dataAction}>
                <div>
                  <strong>Reprocess All Invoices</strong>
                  <p style={styles.actionDesc}>Re-run OCR processing on all non-confirmed invoices.</p>
                </div>
                <button
                  onClick={() => {
                    if (confirm('Reprocess all non-confirmed invoices?')) {
                      reprocessMutation.mutate()
                    }
                  }}
                  style={styles.actionBtn}
                  disabled={reprocessMutation.isPending}
                >
                  {reprocessMutation.isPending ? 'Reprocessing...' : 'Reprocess'}
                </button>
              </div>
              <div style={styles.dataAction}>
                <div>
                  <strong>Clear Fuzzy Matches</strong>
                  <p style={styles.actionDesc}>Clear all fuzzy supplier matches and re-run matching.</p>
                </div>
                <button
                  onClick={() => {
                    if (confirm('Clear all fuzzy supplier matches?')) {
                      rematchFuzzyMutation.mutate()
                    }
                  }}
                  style={styles.actionBtn}
                  disabled={rematchFuzzyMutation.isPending}
                >
                  {rematchFuzzyMutation.isPending ? 'Clearing...' : 'Clear Matches'}
                </button>
              </div>
              </div>
            </div>

            {/* Data Status Message - outside blocks */}
            {dataMessage && (
              <div style={{ ...styles.statusMessage, background: dataMessage.startsWith('Error') ? '#fee' : '#efe' }}>
                {dataMessage}
              </div>
            )}
          </div>
        )}
      </div>

      {/* GL Account Modal */}
      {showGLModal && glAccounts && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3>Select GL Accounts for Revenue Tracking</h3>
            <div style={styles.glList}>
              {(() => {
                // Group accounts by gl_group_name
                const grouped: Record<string, GLAccount[]> = {}
                glAccounts.forEach((acc) => {
                  const groupName = acc.gl_group_name || 'Ungrouped'
                  if (!grouped[groupName]) grouped[groupName] = []
                  grouped[groupName].push(acc)
                })
                // Sort group names alphabetically
                const sortedGroups = Object.keys(grouped).sort()
                return sortedGroups.map((groupName) => {
                  const groupAccounts = grouped[groupName]
                  const allSelected = groupAccounts.every((acc) => acc.is_tracked)
                  const someSelected = groupAccounts.some((acc) => acc.is_tracked)
                  const handleGroupToggle = () => {
                    const newState = !allSelected
                    bulkUpdateGLAccountsMutation.mutate(
                      groupAccounts.map((acc) => ({ id: acc.id, is_tracked: newState }))
                    )
                  }
                  return (
                    <div key={groupName} style={styles.glGroup}>
                      <label style={styles.glGroupHeader}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
                          onChange={handleGroupToggle}
                          style={{ marginRight: '0.5rem' }}
                        />
                        {groupName}
                        <span style={styles.glGroupCount}>({groupAccounts.filter((a) => a.is_tracked).length}/{groupAccounts.length})</span>
                      </label>
                      <div style={styles.glGroupItems}>
                        {groupAccounts.map((acc) => (
                          <label key={acc.id} style={styles.glItem}>
                            <input
                              type="checkbox"
                              checked={acc.is_tracked}
                              onChange={(e) => updateGLAccountMutation.mutate({ id: acc.id, is_tracked: e.target.checked })}
                            />
                            <span>{acc.gl_name}</span>
                            {acc.gl_code && <span style={styles.glCode}>({acc.gl_code})</span>}
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
            <button onClick={() => setShowGLModal(false)} style={styles.btn}>Close</button>
          </div>
        </div>
      )}

      {/* Room Category Modal */}
      {showRoomCategoryModal && roomCategories && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3>Select Room Categories for Occupancy</h3>
            <p style={{ color: '#666', fontSize: '0.9rem', marginBottom: '1rem' }}>
              Select which room types to include in occupancy and guest calculations.
            </p>
            <div style={styles.glList}>
              {roomCategories.map((cat) => (
                <label key={cat.id} style={styles.glItem}>
                  <input
                    type="checkbox"
                    checked={cat.is_included}
                    onChange={(e) => {
                      bulkUpdateRoomCategoriesMutation.mutate([{ id: cat.id, is_included: e.target.checked }])
                    }}
                  />
                  <span>{cat.site_name}</span>
                  <span style={styles.glCode}>({cat.room_count} rooms)</span>
                </label>
              ))}
            </div>
            <div style={styles.buttonRow}>
              <button
                onClick={() => {
                  // Select all
                  bulkUpdateRoomCategoriesMutation.mutate(roomCategories.map((c) => ({ id: c.id, is_included: true })))
                }}
                style={styles.actionBtn}
              >
                Select All
              </button>
              <button
                onClick={() => {
                  // Deselect all
                  bulkUpdateRoomCategoriesMutation.mutate(roomCategories.map((c) => ({ id: c.id, is_included: false })))
                }}
                style={styles.actionBtn}
              >
                Deselect All
              </button>
              <button onClick={() => setShowRoomCategoryModal(false)} style={styles.btn}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Historical Sync Modal */}
      {showHistoricalModal && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3>Fetch Historical Data</h3>
            <div style={styles.form}>
              <label style={styles.label}>
                From Date
                <input
                  type="date"
                  value={historicalDateFrom}
                  onChange={(e) => setHistoricalDateFrom(e.target.value)}
                  style={styles.input}
                />
              </label>
              <label style={styles.label}>
                To Date
                <input
                  type="date"
                  value={historicalDateTo}
                  onChange={(e) => setHistoricalDateTo(e.target.value)}
                  style={styles.input}
                />
              </label>
              <div style={styles.buttonRow}>
                <button
                  onClick={() => syncHistoricalMutation.mutate({ date_from: historicalDateFrom, date_to: historicalDateTo })}
                  style={styles.saveBtn}
                  disabled={!historicalDateFrom || !historicalDateTo || syncHistoricalMutation.isPending}
                >
                  {syncHistoricalMutation.isPending ? 'Syncing...' : 'Sync'}
                </button>
                <button onClick={() => setShowHistoricalModal(false)} style={styles.btn}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    gap: '2rem',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  sidebar: {
    width: '200px',
    flexShrink: 0,
    background: 'white',
    borderRadius: '12px',
    padding: '1rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    height: 'fit-content',
    position: 'sticky',
    top: '1rem',
  },
  sidebarTitle: {
    margin: '0 0 1rem 0',
    fontSize: '1.1rem',
    color: '#1a1a2e',
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  navItem: {
    padding: '0.75rem 1rem',
    border: 'none',
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: '6px',
    fontSize: '0.95rem',
    color: '#333',
  },
  navItemActive: {
    background: '#e94560',
    color: 'white',
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  section: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  sectionTitle: {
    color: '#1a1a2e',
    marginTop: 0,
    marginBottom: '1rem',
  },
  subsectionTitle: {
    color: '#1a1a2e',
    marginTop: '1.5rem',
    marginBottom: '0.75rem',
    fontSize: '1rem',
  },
  hint: {
    color: '#666',
    marginBottom: '1rem',
    fontSize: '0.9rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '500px',
  },
  infoGrid: {
    display: 'grid',
    gap: '0.5rem',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    color: '#333',
    fontWeight: '500',
  },
  input: {
    padding: '0.75rem',
    borderRadius: '6px',
    border: '1px solid #ddd',
    fontSize: '1rem',
  },
  keyStatus: {
    fontSize: '0.8rem',
    color: '#5cb85c',
  },
  buttonRow: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
  },
  btn: {
    padding: '0.5rem 1rem',
    background: '#1a1a2e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  testBtn: {
    padding: '0.5rem 1rem',
    background: '#5bc0de',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  saveBtn: {
    padding: '0.5rem 1rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  actionBtn: {
    padding: '0.5rem 1rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '0.5rem 1rem',
    background: '#5bc0de',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  button: {
    padding: '0.75rem 1.5rem',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: '500',
    fontSize: '1rem',
  },
  statusMessage: {
    padding: '0.75rem',
    borderRadius: '6px',
    marginTop: '0.5rem',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginTop: '1rem',
    cursor: 'pointer',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '0.75rem',
    borderBottom: '2px solid #eee',
    color: '#666',
    fontSize: '0.85rem',
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid #eee',
  },
  disabledRow: {
    opacity: 0.6,
    background: '#f9f9f9',
  },
  activeStatus: {
    color: '#28a745',
    fontWeight: '500',
  },
  inactiveStatus: {
    color: '#dc3545',
    fontWeight: '500',
  },
  actionButtons: {
    display: 'flex',
    gap: '0.5rem',
  },
  disableBtn: {
    padding: '0.35rem 0.75rem',
    background: '#ffc107',
    color: '#212529',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  enableBtn: {
    padding: '0.35rem 0.75rem',
    background: '#28a745',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  deleteBtn: {
    padding: '0.35rem 0.75rem',
    background: '#dc3545',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  promoteBtn: {
    padding: '0.35rem 0.75rem',
    background: '#6f42c1',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  demoteBtn: {
    padding: '0.35rem 0.75rem',
    background: '#6c757d',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  checkboxGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    marginBottom: '1rem',
  },
  youLabel: {
    color: '#666',
    fontSize: '0.85rem',
    fontStyle: 'italic',
  },
  dataActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  dataAction: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '1rem',
    padding: '1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
  },
  actionDesc: {
    margin: '0.25rem 0 0 0',
    fontSize: '0.85rem',
    color: '#666',
  },
  loading: {
    padding: '2rem',
    textAlign: 'center',
    color: '#666',
  },
  modal: {
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
  modalContent: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '12px',
    maxWidth: '500px',
    width: '90%',
    maxHeight: '80vh',
    overflow: 'auto',
  },
  glList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    margin: '1rem 0',
    maxHeight: '300px',
    overflow: 'auto',
  },
  glItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem',
    background: '#f8f9fa',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  glCode: {
    color: '#666',
    fontSize: '0.85rem',
  },
  glGroup: {
    marginBottom: '1.25rem',
  },
  glGroupHeader: {
    display: 'flex',
    alignItems: 'center',
    fontWeight: 'bold',
    fontSize: '0.95rem',
    color: '#1a1a2e',
    padding: '0.5rem 0.75rem',
    background: '#f0f0f5',
    borderLeft: '3px solid #e94560',
    marginBottom: '0.5rem',
    cursor: 'pointer',
  },
  glGroupItems: {
    paddingLeft: '1.25rem',
    borderLeft: '1px solid #e0e0e0',
    marginLeft: '0.5rem',
  },
  glGroupCount: {
    marginLeft: 'auto',
    fontSize: '0.8rem',
    color: '#666',
    fontWeight: 'normal',
  },
  mealMappingList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    maxHeight: '150px',
    overflow: 'auto',
    padding: '0.5rem',
    background: '#f8f9fa',
    borderRadius: '6px',
    marginTop: '0.5rem',
  },
  mealMappingItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.9rem',
    cursor: 'pointer',
  },
  mealMappingEmpty: {
    color: '#999',
    fontSize: '0.85rem',
    fontStyle: 'italic',
  },
  sambaCategoryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '0.5rem',
    marginTop: '1rem',
    padding: '1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
    maxHeight: '300px',
    overflowY: 'auto',
  },
  sambaCategoryItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem',
    background: 'white',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.95rem',
  },
  sortableList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    background: '#f8f9fa',
    borderRadius: '8px',
    padding: '0.5rem',
  },
  sortableItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.5rem 0.75rem',
    background: 'white',
    borderRadius: '6px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  sortableOrder: {
    width: '24px',
    height: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#e94560',
    color: 'white',
    borderRadius: '50%',
    fontSize: '0.8rem',
    fontWeight: 'bold',
  },
  sortableName: {
    flex: 1,
    fontWeight: 500,
  },
  sortableButtons: {
    display: 'flex',
    gap: '0.25rem',
  },
  arrowBtn: {
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #ddd',
    background: 'white',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  removeBtn: {
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: '#fee',
    color: '#c00',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  addCourseBtn: {
    padding: '0.5rem 0.75rem',
    background: '#e8f4fd',
    border: '1px dashed #0077cc',
    borderRadius: '6px',
    color: '#0077cc',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  excludedItemsGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginTop: '1rem',
    padding: '1rem',
    background: '#f8f9fa',
    borderRadius: '8px',
    maxHeight: '300px',
    overflowY: 'auto',
  },
  excludedItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.75rem',
    background: 'white',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  excludedItemCategory: {
    fontSize: '0.75rem',
    color: '#666',
    background: '#eee',
    padding: '0.15rem 0.5rem',
    borderRadius: '10px',
  },
  settingsBlock: {
    background: '#f8f9fa',
    padding: '1.5rem',
    borderRadius: '8px',
    marginBottom: '1.5rem',
    border: '1px solid #e0e0e0',
  },
  blockTitle: {
    color: '#1a1a2e',
    marginTop: 0,
    marginBottom: '0.75rem',
    fontSize: '1.1rem',
    fontWeight: '600',
    borderBottom: '2px solid #e94560',
    paddingBottom: '0.5rem',
  },
  blockDivider: {
    height: '2px',
    background: 'linear-gradient(to right, #e94560, transparent)',
    margin: '1.5rem 0',
    border: 'none',
  },
}
