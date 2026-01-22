# Plan 2: Newbook Frequent Updates (15-Minute Intervals)

## Current State

### Existing Newbook Sync Mechanism
**File:** `backend/services/newbook.py`

Current sync behavior:
- Manual trigger via API endpoint
- Full historical sync on demand
- No automatic scheduling
- Fetches data from date range (date_from to date_to)
- Updates:
  - Daily occupancy (aggregated)
  - Meal allocations
  - Arrival tracking
  - GL account revenue

### Existing Resos Sync for Comparison
**Files:**
- `backend/services/resos.py` - Sync service
- `backend/models/resos.py` - `ResosUpcomingSyncSettings` model
- Database table: `resos_upcoming_sync_settings`

Resos already implements automatic frequent updates:
- Configurable sync interval (default 60 minutes)
- Automatic scheduling via background task
- Separate settings for upcoming bookings vs historical
- Settings page UI for interval configuration

## Problem Statement

Hotel managers need **near-real-time occupancy data** for the next 7 days to:
- Coordinate restaurant table assignments
- Plan staffing levels
- Monitor arrivals throughout the day
- React to last-minute bookings/cancellations
- Track meal plan changes

Current manual sync requires:
1. User remembers to trigger sync
2. User waits for completion
3. No automatic updates when bookings change

**Goal:** Implement automatic 15-minute sync for next 7 days, similar to Resos upcoming bookings feature.

## Requirements

### Functional Requirements
1. **Automatic Sync Scheduling**
   - Default interval: 15 minutes
   - Configurable via settings page
   - Target date range: Today to Today + 7 days
   - Run continuously while app is running

2. **Settings Management**
   - Add "Newbook Frequent Update Interval" to settings page
   - Dropdown options: 5, 10, 15, 30, 60 minutes
   - Enable/disable toggle
   - Per-kitchen configuration

3. **Background Task**
   - Non-blocking execution
   - Error handling and retry logic
   - Logging for monitoring
   - Graceful shutdown on app restart

4. **Scope Limitation**
   - ONLY sync next 7 days (not full history)
   - Keep existing manual full-sync functionality
   - Frequent updates don't replace historical sync

### Non-Functional Requirements
1. **Performance**
   - Sync completes within 30 seconds
   - No impact on API response times
   - Rate limit compliance with Newbook API

2. **Reliability**
   - Failed sync doesn't stop scheduler
   - Exponential backoff on API errors
   - Alert on repeated failures

3. **Observability**
   - Log each sync start/completion
   - Track sync duration
   - Record API error rates
   - Dashboard widget showing last sync time

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────┐
│                   Frontend                          │
│                                                     │
│  ┌──────────────────────────────────────────┐    │
│  │  Settings Page                            │    │
│  │  - Newbook Frequent Update Interval       │    │
│  │  - Enable/Disable Toggle                  │    │
│  │  - Last Sync Time Display                 │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                 Backend API                         │
│                                                     │
│  ┌──────────────────────────────────────────┐    │
│  │  POST /api/settings/newbook-sync          │    │
│  │  GET /api/settings/newbook-sync           │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│            Background Scheduler                     │
│                                                     │
│  ┌──────────────────────────────────────────┐    │
│  │  newbook_frequent_sync_loop()             │    │
│  │  - Runs every N minutes                   │    │
│  │  - Queries active kitchens                │    │
│  │  - Calls sync_occupancy(today, today+7)   │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Newbook Service                        │
│                                                     │
│  ┌──────────────────────────────────────────┐    │
│  │  sync_occupancy(kitchen_id, from, to)     │    │
│  │  - Existing sync logic                    │    │
│  │  - Fetches occupancy data                 │    │
│  │  - Updates database                       │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Database Schema

#### 1.1 Create Settings Table

**File:** `backend/models/newbook.py`

Add new model after `NewbookSyncLog`:

```python
class NewbookFrequentSyncSettings(Base):
    """Settings for automatic frequent Newbook occupancy sync"""
    __tablename__ = "newbook_frequent_sync_settings"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, unique=True)

    # Sync configuration
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_interval_minutes: Mapped[int] = mapped_column(Integer, default=15)  # Default 15 minutes

    # Sync scope
    days_ahead: Mapped[int] = mapped_column(Integer, default=7)  # Sync next N days

    # Status tracking
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_sync_status: Mapped[str | None] = mapped_column(String(20), nullable=True)  # success, failed, running
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="newbook_frequent_sync_settings")
```

#### 1.2 Create Migration

**File:** `backend/migrations/add_newbook_frequent_sync.py` (NEW)

```python
import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)

async def run_migration():
    """Create newbook_frequent_sync_settings table"""

    create_table_sql = """
    CREATE TABLE IF NOT EXISTS newbook_frequent_sync_settings (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id) UNIQUE,
        is_enabled BOOLEAN DEFAULT TRUE,
        sync_interval_minutes INTEGER DEFAULT 15,
        days_ahead INTEGER DEFAULT 7,
        last_sync_at TIMESTAMP,
        last_sync_status VARCHAR(20),
        last_error_message TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """

    create_index_sql = """
    CREATE INDEX IF NOT EXISTS idx_newbook_frequent_sync_kitchen
    ON newbook_frequent_sync_settings(kitchen_id);
    """

    # Initialize settings for all existing kitchens
    initialize_settings_sql = """
    INSERT INTO newbook_frequent_sync_settings (kitchen_id, is_enabled, sync_interval_minutes, days_ahead)
    SELECT id, TRUE, 15, 7
    FROM kitchens
    WHERE id NOT IN (SELECT kitchen_id FROM newbook_frequent_sync_settings)
    ON CONFLICT (kitchen_id) DO NOTHING;
    """

    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_table_sql))
            logger.info("Created newbook_frequent_sync_settings table")

            await conn.execute(text(create_index_sql))
            logger.info("Created newbook_frequent_sync_settings indexes")

            await conn.execute(text(initialize_settings_sql))
            logger.info("Initialized newbook frequent sync settings for existing kitchens")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Newbook frequent sync migration: {e}")

if __name__ == "__main__":
    asyncio.run(run_migration())
```

#### 1.3 Update Kitchen Model

**File:** `backend/models/user.py`

Add relationship to Kitchen class:

```python
# In Kitchen class, add to relationships section:
newbook_frequent_sync_settings: Mapped["NewbookFrequentSyncSettings"] = relationship(
    "NewbookFrequentSyncSettings", back_populates="kitchen", uselist=False
)
```

### Phase 2: Background Scheduler

#### 2.1 Create Scheduler Service

**File:** `backend/services/newbook_scheduler.py` (NEW)

```python
import asyncio
import logging
from datetime import datetime, date, timedelta
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_db_context
from models.newbook import NewbookFrequentSyncSettings
from models.user import Kitchen
from services.newbook import sync_occupancy_for_kitchen

logger = logging.getLogger(__name__)

class NewbookScheduler:
    """Background scheduler for frequent Newbook occupancy sync"""

    def __init__(self):
        self.is_running = False
        self.task = None

    async def start(self):
        """Start the background scheduler"""
        if self.is_running:
            logger.warning("Newbook scheduler already running")
            return

        self.is_running = True
        self.task = asyncio.create_task(self._run_loop())
        logger.info("Newbook frequent sync scheduler started")

    async def stop(self):
        """Stop the background scheduler"""
        self.is_running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        logger.info("Newbook frequent sync scheduler stopped")

    async def _run_loop(self):
        """Main scheduler loop"""
        while self.is_running:
            try:
                await self._sync_all_kitchens()
            except Exception as e:
                logger.error(f"Error in Newbook scheduler loop: {e}", exc_info=True)

            # Wait for next cycle (check every minute, actual sync based on interval)
            await asyncio.sleep(60)

    async def _sync_all_kitchens(self):
        """Sync occupancy for all enabled kitchens"""
        async with get_db_context() as db:
            # Get all kitchens with frequent sync enabled
            result = await db.execute(
                select(NewbookFrequentSyncSettings, Kitchen).join(
                    Kitchen, NewbookFrequentSyncSettings.kitchen_id == Kitchen.id
                ).where(
                    and_(
                        NewbookFrequentSyncSettings.is_enabled == True,
                        Kitchen.newbook_api_key.isnot(None)  # Only kitchens with Newbook configured
                    )
                )
            )
            settings_and_kitchens = result.all()

            for settings, kitchen in settings_and_kitchens:
                # Check if enough time has passed since last sync
                if settings.last_sync_at:
                    minutes_since_sync = (datetime.utcnow() - settings.last_sync_at).total_seconds() / 60
                    if minutes_since_sync < settings.sync_interval_minutes:
                        continue  # Too soon, skip

                # Perform sync
                await self._sync_kitchen(db, settings, kitchen)

    async def _sync_kitchen(self, db: AsyncSession, settings: NewbookFrequentSyncSettings, kitchen: Kitchen):
        """Sync occupancy for a single kitchen"""
        logger.info(f"Starting Newbook frequent sync for kitchen {kitchen.id} ({kitchen.name})")

        # Update status to running
        settings.last_sync_status = "running"
        await db.commit()

        try:
            # Calculate date range: today to today + N days
            date_from = date.today()
            date_to = date_from + timedelta(days=settings.days_ahead)

            # Call existing sync service
            await sync_occupancy_for_kitchen(kitchen.id, date_from, date_to, db)

            # Update success status
            settings.last_sync_at = datetime.utcnow()
            settings.last_sync_status = "success"
            settings.last_error_message = None
            settings.consecutive_failures = 0

            logger.info(f"Newbook frequent sync completed for kitchen {kitchen.id}")

        except Exception as e:
            # Update failure status
            settings.last_sync_status = "failed"
            settings.last_error_message = str(e)[:500]  # Truncate long errors
            settings.consecutive_failures += 1

            logger.error(f"Newbook frequent sync failed for kitchen {kitchen.id}: {e}", exc_info=True)

            # Alert if repeated failures
            if settings.consecutive_failures >= 5:
                logger.critical(f"Newbook sync has failed {settings.consecutive_failures} times for kitchen {kitchen.id}")

        finally:
            await db.commit()

# Global scheduler instance
newbook_scheduler = NewbookScheduler()
```

#### 2.2 Update Newbook Service

**File:** `backend/services/newbook.py`

Extract existing sync logic into a reusable function:

```python
async def sync_occupancy_for_kitchen(
    kitchen_id: int,
    date_from: date,
    date_to: date,
    db: AsyncSession
) -> dict:
    """
    Sync occupancy data for a kitchen (reusable by scheduler and manual API)

    Returns:
        dict with sync stats (records_fetched, errors, etc.)
    """
    # Extract existing logic from current sync endpoint
    # This is the core sync logic that both manual and automatic sync will use

    # Get kitchen and API credentials
    kitchen = await db.get(Kitchen, kitchen_id)
    if not kitchen or not kitchen.newbook_api_key:
        raise ValueError(f"Kitchen {kitchen_id} not found or Newbook not configured")

    # Create Newbook API client
    client = NewbookAPIClient(
        api_key=kitchen.newbook_api_key,
        api_secret=kitchen.newbook_api_secret,
        property_id=kitchen.newbook_property_id
    )

    # Fetch occupancy data
    occupancy_data = await client.get_occupancy(date_from, date_to)

    # Update database (existing logic)
    records_fetched = 0
    for day_data in occupancy_data:
        # Existing upsert logic
        records_fetched += 1

    return {
        "records_fetched": records_fetched,
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "status": "success"
    }
```

#### 2.3 Register Scheduler in main.py

**File:** `backend/main.py`

Update lifespan function to start/stop scheduler:

```python
from services.newbook_scheduler import newbook_scheduler

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle manager"""
    # ... existing startup code ...

    # Run migrations
    await run_migrations()

    # Start background schedulers
    await newbook_scheduler.start()
    logger.info("Background schedulers started")

    yield

    # Shutdown
    await newbook_scheduler.stop()
    logger.info("Background schedulers stopped")
```

### Phase 3: API Endpoints

#### 3.1 Settings API

**File:** `backend/api/settings.py` (UPDATE)

Add endpoints for Newbook frequent sync settings:

```python
from models.newbook import NewbookFrequentSyncSettings
from pydantic import BaseModel

class NewbookFrequentSyncSettingsUpdate(BaseModel):
    is_enabled: bool
    sync_interval_minutes: int
    days_ahead: int

class NewbookFrequentSyncSettingsResponse(BaseModel):
    is_enabled: bool
    sync_interval_minutes: int
    days_ahead: int
    last_sync_at: Optional[datetime]
    last_sync_status: Optional[str]
    last_error_message: Optional[str]
    consecutive_failures: int

@router.get("/newbook-frequent-sync")
async def get_newbook_frequent_sync_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> NewbookFrequentSyncSettingsResponse:
    """Get Newbook frequent sync settings for current kitchen"""

    result = await db.execute(
        select(NewbookFrequentSyncSettings).where(
            NewbookFrequentSyncSettings.kitchen_id == current_user.kitchen_id
        )
    )
    settings = result.scalar_one_or_none()

    if not settings:
        # Create default settings
        settings = NewbookFrequentSyncSettings(
            kitchen_id=current_user.kitchen_id,
            is_enabled=True,
            sync_interval_minutes=15,
            days_ahead=7
        )
        db.add(settings)
        await db.commit()
        await db.refresh(settings)

    return NewbookFrequentSyncSettingsResponse(
        is_enabled=settings.is_enabled,
        sync_interval_minutes=settings.sync_interval_minutes,
        days_ahead=settings.days_ahead,
        last_sync_at=settings.last_sync_at,
        last_sync_status=settings.last_sync_status,
        last_error_message=settings.last_error_message,
        consecutive_failures=settings.consecutive_failures
    )

@router.post("/newbook-frequent-sync")
async def update_newbook_frequent_sync_settings(
    settings_update: NewbookFrequentSyncSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> NewbookFrequentSyncSettingsResponse:
    """Update Newbook frequent sync settings"""

    # Validate interval
    valid_intervals = [5, 10, 15, 30, 60]
    if settings_update.sync_interval_minutes not in valid_intervals:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid sync interval. Must be one of: {valid_intervals}"
        )

    # Validate days_ahead
    if settings_update.days_ahead < 1 or settings_update.days_ahead > 30:
        raise HTTPException(
            status_code=400,
            detail="days_ahead must be between 1 and 30"
        )

    result = await db.execute(
        select(NewbookFrequentSyncSettings).where(
            NewbookFrequentSyncSettings.kitchen_id == current_user.kitchen_id
        )
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = NewbookFrequentSyncSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    settings.is_enabled = settings_update.is_enabled
    settings.sync_interval_minutes = settings_update.sync_interval_minutes
    settings.days_ahead = settings_update.days_ahead
    settings.updated_at = datetime.utcnow()

    await db.commit()
    await db.refresh(settings)

    return NewbookFrequentSyncSettingsResponse(
        is_enabled=settings.is_enabled,
        sync_interval_minutes=settings.sync_interval_minutes,
        days_ahead=settings.days_ahead,
        last_sync_at=settings.last_sync_at,
        last_sync_status=settings.last_sync_status,
        last_error_message=settings.last_error_message,
        consecutive_failures=settings.consecutive_failures
    )
```

### Phase 4: Frontend Implementation

#### 4.1 Settings Page Section

**File:** `frontend/src/pages/Settings.tsx` (UPDATE)

Add Newbook frequent sync settings section:

```typescript
interface NewbookFrequentSyncSettings {
  is_enabled: boolean
  sync_interval_minutes: number
  days_ahead: number
  last_sync_at: string | null
  last_sync_status: string | null
  last_error_message: string | null
  consecutive_failures: number
}

// Add query hook
const { data: newbookSyncSettings, isLoading: isLoadingNewbookSync } = useQuery<NewbookFrequentSyncSettings>({
  queryKey: ['newbook-frequent-sync-settings'],
  queryFn: async () => {
    const res = await fetch('/api/settings/newbook-frequent-sync', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) throw new Error('Failed to fetch Newbook sync settings')
    return res.json()
  }
})

// Add mutation hook
const updateNewbookSyncMutation = useMutation({
  mutationFn: async (settings: Partial<NewbookFrequentSyncSettings>) => {
    const res = await fetch('/api/settings/newbook-frequent-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(settings)
    })
    if (!res.ok) throw new Error('Failed to update settings')
    return res.json()
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['newbook-frequent-sync-settings'] })
  }
})

// Add UI section (after Resos settings):
<div style={styles.section}>
  <h2>Newbook Frequent Updates</h2>
  <p style={{ color: '#666', marginBottom: '1rem' }}>
    Automatically sync hotel occupancy data for the next 7 days at regular intervals.
    Keeps ResidentsTableChart and forecasts up-to-date with last-minute bookings.
  </p>

  {isLoadingNewbookSync ? (
    <div>Loading...</div>
  ) : newbookSyncSettings ? (
    <>
      <div style={styles.formGroup}>
        <label style={styles.label}>
          <input
            type="checkbox"
            checked={newbookSyncSettings.is_enabled}
            onChange={(e) => updateNewbookSyncMutation.mutate({
              ...newbookSyncSettings,
              is_enabled: e.target.checked
            })}
          />
          Enable automatic frequent sync
        </label>
      </div>

      {newbookSyncSettings.is_enabled && (
        <>
          <div style={styles.formGroup}>
            <label style={styles.label}>Sync Interval</label>
            <select
              value={newbookSyncSettings.sync_interval_minutes}
              onChange={(e) => updateNewbookSyncMutation.mutate({
                ...newbookSyncSettings,
                sync_interval_minutes: parseInt(e.target.value)
              })}
              style={styles.input}
            >
              <option value={5}>Every 5 minutes</option>
              <option value={10}>Every 10 minutes</option>
              <option value={15}>Every 15 minutes (Recommended)</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 60 minutes</option>
            </select>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Days Ahead</label>
            <input
              type="number"
              min={1}
              max={30}
              value={newbookSyncSettings.days_ahead}
              onChange={(e) => updateNewbookSyncMutation.mutate({
                ...newbookSyncSettings,
                days_ahead: parseInt(e.target.value)
              })}
              style={styles.input}
            />
            <small style={{ color: '#666' }}>
              Number of days to sync ahead (default: 7)
            </small>
          </div>

          {newbookSyncSettings.last_sync_at && (
            <div style={styles.statusBox}>
              <div style={styles.statusRow}>
                <strong>Last Sync:</strong>
                <span>{new Date(newbookSyncSettings.last_sync_at).toLocaleString()}</span>
              </div>
              <div style={styles.statusRow}>
                <strong>Status:</strong>
                <span style={{
                  color: newbookSyncSettings.last_sync_status === 'success' ? 'green' :
                         newbookSyncSettings.last_sync_status === 'failed' ? 'red' : 'orange'
                }}>
                  {newbookSyncSettings.last_sync_status?.toUpperCase()}
                </span>
              </div>
              {newbookSyncSettings.last_error_message && (
                <div style={styles.errorMessage}>
                  <strong>Error:</strong> {newbookSyncSettings.last_error_message}
                </div>
              )}
              {newbookSyncSettings.consecutive_failures > 0 && (
                <div style={{ color: 'orange', marginTop: '0.5rem' }}>
                  ⚠️ {newbookSyncSettings.consecutive_failures} consecutive failures
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  ) : null}
</div>
```

#### 4.2 Add Status Indicator to Dashboard

**File:** `frontend/src/pages/Dashboard.tsx` (UPDATE)

Add widget showing Newbook sync status:

```typescript
<div style={styles.widget}>
  <h3>Newbook Sync Status</h3>
  {newbookSyncSettings && (
    <>
      <div>
        <strong>Interval:</strong> Every {newbookSyncSettings.sync_interval_minutes} minutes
      </div>
      {newbookSyncSettings.last_sync_at && (
        <div>
          <strong>Last Sync:</strong> {formatTimeAgo(newbookSyncSettings.last_sync_at)}
        </div>
      )}
      <div style={{
        padding: '0.5rem',
        marginTop: '0.5rem',
        borderRadius: '4px',
        background: newbookSyncSettings.last_sync_status === 'success' ? '#e7f5e7' :
                   newbookSyncSettings.last_sync_status === 'failed' ? '#ffe7e7' : '#fff3cd',
        color: newbookSyncSettings.last_sync_status === 'success' ? 'green' :
               newbookSyncSettings.last_sync_status === 'failed' ? 'red' : 'orange'
      }}>
        {newbookSyncSettings.last_sync_status === 'success' ? '✓ Syncing' :
         newbookSyncSettings.last_sync_status === 'failed' ? '✗ Sync Failed' : '⟳ Running'}
      </div>
    </>
  )}
</div>
```

### Phase 5: Testing

#### 5.1 Unit Tests

**File:** `backend/tests/test_newbook_scheduler.py` (NEW)

```python
import pytest
from datetime import datetime, date, timedelta
from services.newbook_scheduler import NewbookScheduler
from models.newbook import NewbookFrequentSyncSettings

@pytest.mark.asyncio
async def test_scheduler_starts_and_stops():
    scheduler = NewbookScheduler()
    assert not scheduler.is_running

    await scheduler.start()
    assert scheduler.is_running

    await scheduler.stop()
    assert not scheduler.is_running

@pytest.mark.asyncio
async def test_sync_respects_interval(db_session):
    # Create settings with 15-minute interval
    settings = NewbookFrequentSyncSettings(
        kitchen_id=1,
        is_enabled=True,
        sync_interval_minutes=15,
        last_sync_at=datetime.utcnow() - timedelta(minutes=10)  # 10 minutes ago
    )
    db_session.add(settings)
    await db_session.commit()

    scheduler = NewbookScheduler()
    # Should skip sync (only 10 minutes passed, need 15)
    await scheduler._sync_all_kitchens()

    # Verify sync was not performed
    await db_session.refresh(settings)
    assert settings.last_sync_status != "running"

@pytest.mark.asyncio
async def test_sync_handles_errors(db_session, mock_newbook_api_error):
    settings = NewbookFrequentSyncSettings(
        kitchen_id=1,
        is_enabled=True,
        sync_interval_minutes=15,
        consecutive_failures=0
    )
    db_session.add(settings)
    await db_session.commit()

    scheduler = NewbookScheduler()
    await scheduler._sync_all_kitchens()

    await db_session.refresh(settings)
    assert settings.last_sync_status == "failed"
    assert settings.consecutive_failures == 1
    assert settings.last_error_message is not None
```

#### 5.2 Integration Tests

**Test Scenarios:**

1. **Enable sync via UI**
   - Navigate to Settings page
   - Enable Newbook frequent sync
   - Set interval to 5 minutes (for faster testing)
   - Verify settings saved

2. **Verify automatic sync**
   - Wait 5 minutes
   - Check backend logs for sync execution
   - Verify database updated with recent dates
   - Check settings show last_sync_at updated

3. **Test error handling**
   - Temporarily break Newbook API credentials
   - Wait for next sync
   - Verify error message displayed in UI
   - Fix credentials
   - Verify sync recovers

4. **Test disable sync**
   - Disable sync in Settings
   - Wait past interval
   - Verify no sync occurs
   - Check logs confirm scheduler skips disabled kitchens

#### 5.3 Performance Tests

**Test:** Measure sync duration for 7-day window
- Expected: <30 seconds for typical hotel
- Alert if exceeds 60 seconds

**Test:** Verify no API response impact during sync
- Make API calls while sync running
- Measure latency
- Ensure <200ms response times

### Phase 6: Monitoring & Alerting

#### 6.1 Logging

Add structured logging:

```python
logger.info(
    "Newbook frequent sync completed",
    extra={
        "kitchen_id": kitchen.id,
        "records_fetched": result["records_fetched"],
        "duration_seconds": duration,
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat()
    }
)
```

#### 6.2 Metrics

Track key metrics:
- Sync success rate (%)
- Average sync duration (seconds)
- API error rate
- Consecutive failure count per kitchen

#### 6.3 Alerts

Configure alerts for:
- **Critical:** 5+ consecutive failures
- **Warning:** Sync duration >60 seconds
- **Warning:** No sync in 2x expected interval

## Rollout Plan

### Phase 1: Backend Only (Week 1)
- Deploy database migration
- Deploy scheduler service
- Test with single kitchen
- Monitor logs and performance

### Phase 2: Settings UI (Week 2)
- Deploy settings API endpoints
- Deploy settings page UI
- Enable for pilot customers
- Gather feedback

### Phase 3: Dashboard Integration (Week 3)
- Add dashboard widget
- Add sync status indicators
- Document feature for users
- Enable for all customers

### Phase 4: Optimization (Week 4)
- Tune sync intervals based on usage
- Optimize API calls
- Add caching if needed
- Performance monitoring

## Configuration Options

### Recommended Intervals by Property Size

- **Small (<10 rooms):** 30 minutes
- **Medium (10-25 rooms):** 15 minutes (default)
- **Large (25+ rooms):** 10 minutes
- **High churn properties:** 5 minutes

### Advanced Settings (Future)

- **Smart intervals:** Increase frequency during check-in hours
- **Selective sync:** Only sync rooms with changes
- **Webhook integration:** Real-time updates on booking changes
- **Batch optimization:** Group multiple kitchens in single API call

## Success Criteria

✅ Scheduler runs continuously without crashes
✅ Sync completes within 30 seconds for 7-day window
✅ Settings UI allows enable/disable and interval configuration
✅ Dashboard shows last sync time and status
✅ Failed syncs logged with error details
✅ Consecutive failures trigger alerts
✅ No impact on API response times
✅ ResidentsTableChart shows up-to-date data

## Future Enhancements

1. **Predictive Sync**
   - Increase frequency during peak booking hours
   - Reduce frequency overnight

2. **Differential Sync**
   - Only fetch changed bookings
   - Reduce API load and sync time

3. **Multi-Property Optimization**
   - Batch requests for properties with same owner
   - Share rate limits across properties

4. **Webhook Integration**
   - Real-time push updates from Newbook
   - Eliminate polling entirely

5. **Sync History Dashboard**
   - Chart showing sync frequency and success rate
   - Identify patterns in failures
   - Performance trends over time
