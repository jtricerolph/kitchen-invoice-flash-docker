# Plan 1: Newbook Room-Level Occupancy Sync

## Current State

The ResidentsTableChart feature has:
- ✅ Database schema with room-level fields (room_number, booking_id, guest_name, is_dbb, is_package)
- ✅ API endpoint to serve room-level data
- ✅ Frontend chart to display room occupancy
- ❌ Sync service only fetches aggregated daily totals, not individual room details

**Current database state:**
```sql
room_number | booking_id | guest_name | is_dbb
------------|------------|------------|-------
    NULL    |    NULL    |    NULL    | false
```

## Problem Statement

The Newbook API sync (`backend/services/newbook.py`) currently only fetches:
- Daily aggregated occupancy (total_rooms, occupied_rooms, occupancy_percentage)
- Meal allocations (breakfast/dinner counts and revenue)
- Arrival tracking (booking IDs and details for arrivals)

It does NOT fetch:
- Individual room numbers
- Which rooms are occupied on which dates
- Guest names per room
- Booking IDs per occupied room
- Meal plan details per booking (DBB, package deals)

## Goal

Update the Newbook sync service to fetch and store room-level occupancy data so the ResidentsTableChart displays actual rooms instead of "Unknown Room".

## Investigation Required

Before implementation, we need to verify what data is available from the Newbook API:

### 1. Review Newbook API Documentation
- What endpoint provides room-level occupancy?
- Does it return individual room statuses?
- Is guest name available (privacy concerns)?
- How are meal plans (DBB, packages) represented?

### 2. Examine Existing Sync Code
**File:** `backend/services/newbook.py`

Current occupancy sync likely uses:
- `/api/occupancy` or similar endpoint
- Returns aggregated daily statistics
- May need different endpoint for room-level details

### 3. Check Existing Arrival Tracking
The code already populates `arrival_booking_details` (JSONB) which might contain:
- Booking reference numbers
- Room assignments
- Guest names
- Meal plan flags

**SQL to check existing arrival data:**
```sql
SELECT date, arrival_booking_details
FROM newbook_daily_occupancy
WHERE arrival_booking_details IS NOT NULL
LIMIT 5;
```

## Potential Approaches

### Option A: Expand Arrival Tracking to All Stays
If `arrival_booking_details` contains room information, extend this to track:
- Not just arrivals, but all bookings staying on each date
- Store as `active_bookings_details` JSONB field
- Parse and populate room_number, booking_id, guest_name from this JSON

**Pros:**
- Minimal API changes if data already available
- Leverages existing JSON structure

**Cons:**
- JSONB storage plus denormalized columns (redundancy)
- May not scale well with many rooms

### Option B: New Endpoint for Room Status
Use a Newbook API endpoint that returns room-by-room status:

**Expected API response:**
```json
{
  "date": "2026-01-22",
  "rooms": [
    {
      "room_number": "101",
      "status": "occupied",
      "booking_id": "NB-12345",
      "guest_name": "John Smith",
      "check_in": "2026-01-22",
      "check_out": "2026-01-25",
      "meal_plan": "DBB",
      "is_package": false
    },
    {
      "room_number": "102",
      "status": "vacant"
    }
  ]
}
```

**Pros:**
- Clean, structured data
- All room details in one call
- Easier to maintain

**Cons:**
- May require different API endpoint
- More data to fetch/store

### Option C: Hybrid Approach (RECOMMENDED)
1. Use existing occupancy endpoint for aggregated stats
2. Fetch booking details separately (may already be happening for arrivals)
3. Match bookings to dates they span (check_in to check_out)
4. Create separate row per room per night

**Storage strategy:**
```
Current: 1 row per date (aggregated)
New: 1 row per room per night (denormalized)

Example for date 2026-01-22:
OLD:
- date: 2026-01-22, occupied_rooms: 6

NEW:
- date: 2026-01-22, room: 101, booking_id: NB-12345, guest: Smith
- date: 2026-01-22, room: 102, booking_id: NB-12346, guest: Jones
- date: 2026-01-22, room: 103, booking_id: NB-12347, guest: Brown
...
```

**Trade-off:** More database rows, but enables room-level reporting.

## Schema Considerations

### Current Schema Issue
`newbook_daily_occupancy` has unique constraint:
```sql
CONSTRAINT uq_newbook_occupancy_per_day
UNIQUE(kitchen_id, date)
```

This **prevents** multiple rows per date!

### Solution 1: Change Unique Constraint
```sql
-- Drop old constraint
ALTER TABLE newbook_daily_occupancy
DROP CONSTRAINT uq_newbook_occupancy_per_day;

-- Add new constraint for room-level uniqueness
ALTER TABLE newbook_daily_occupancy
ADD CONSTRAINT uq_newbook_occupancy_per_room_per_day
UNIQUE(kitchen_id, date, room_number);
```

**Impact:**
- Breaking change to schema
- Need migration to handle existing aggregated rows
- Backward compatibility: API endpoint must handle both aggregated and room-level rows

### Solution 2: Separate Table (Alternative)
Create `newbook_room_occupancy` table:
```sql
CREATE TABLE newbook_room_occupancy (
    id SERIAL PRIMARY KEY,
    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
    date DATE NOT NULL,
    room_number VARCHAR(50) NOT NULL,
    booking_id VARCHAR(100),
    guest_name VARCHAR(255),
    check_in DATE,
    check_out DATE,
    is_dbb BOOLEAN DEFAULT FALSE,
    is_package BOOLEAN DEFAULT FALSE,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_room_occupancy_per_day
    UNIQUE(kitchen_id, date, room_number)
);
```

Keep `newbook_daily_occupancy` for aggregated stats.

**Pros:**
- No breaking changes
- Clean separation of concerns
- Can keep both aggregated and room-level data

**Cons:**
- Two tables to maintain
- API endpoint needs to join data or use new table

## Recommended Implementation Plan

### Phase 1: Investigate Newbook API
1. Review Newbook API documentation for room-level endpoints
2. Test API calls to see what data is available
3. Check if current `arrival_booking_details` contains room info
4. Determine if guest names are available (privacy/GDPR)

### Phase 2: Database Migration
**Option A (if room data is sparse/optional):**
- Keep current schema
- Allow room_number, booking_id to be NULL
- Populate when available
- Current unique constraint stays

**Option B (if room data is always available):**
- Change unique constraint to (kitchen_id, date, room_number)
- Migrate existing aggregated rows (need strategy)
- Update sync to create multiple rows per date

**Option C (cleanest):**
- Create new `newbook_room_occupancy` table
- Keep existing table for aggregated stats
- Update API endpoint to use new table

### Phase 3: Update Sync Service
**File:** `backend/services/newbook.py`

**Current sync logic:**
```python
async def sync_occupancy(kitchen_id, date_from, date_to):
    # Fetch aggregated occupancy
    data = await newbook_api.get_occupancy(date_from, date_to)

    # Store one row per date
    for day in data:
        occupancy = NewbookDailyOccupancy(
            kitchen_id=kitchen_id,
            date=day['date'],
            total_rooms=day['total_rooms'],
            occupied_rooms=day['occupied_rooms'],
            # ...
        )
```

**New sync logic (Option B - room-level):**
```python
async def sync_occupancy(kitchen_id, date_from, date_to):
    # Fetch room-level occupancy
    data = await newbook_api.get_room_status(date_from, date_to)

    # Delete existing rows for this date range (full refresh)
    await db.execute(
        delete(NewbookDailyOccupancy).where(
            and_(
                NewbookDailyOccupancy.kitchen_id == kitchen_id,
                NewbookDailyOccupancy.date >= date_from,
                NewbookDailyOccupancy.date <= date_to
            )
        )
    )

    # Store one row per room per date
    for day in data:
        for room in day['rooms']:
            if room['status'] == 'occupied':
                occupancy = NewbookDailyOccupancy(
                    kitchen_id=kitchen_id,
                    date=day['date'],
                    room_number=room['room_number'],
                    booking_id=room['booking_id'],
                    guest_name=room.get('guest_name'),  # May be NULL for privacy
                    is_dbb=room.get('meal_plan') == 'DBB',
                    is_package=room.get('is_package', False),
                    # Aggregated stats on each row (redundant but simple)
                    total_rooms=day['total_rooms'],
                    occupied_rooms=day['occupied_rooms'],
                    # ...
                )
                db.add(occupancy)
```

### Phase 4: Update API Endpoint
**File:** `backend/api/residents_table_chart.py`

**Current logic:**
- Groups by (room_number, booking_id)
- Expects rows already grouped

**Updated logic (if using room-level rows):**
- No changes needed! Already groups correctly
- Just needs room_number and booking_id to be populated

**Alternative (if keeping aggregated + separate table):**
- Query `newbook_room_occupancy` instead
- Join with `newbook_daily_occupancy` for aggregated stats

### Phase 5: Testing
1. Run sync for a test date range
2. Verify database populated:
   ```sql
   SELECT date, room_number, booking_id, guest_name
   FROM newbook_daily_occupancy
   WHERE date = '2026-01-22'
   ORDER BY room_number;
   ```
3. Test ResidentsTableChart page
4. Verify rooms display with actual names
5. Check restaurant booking linkage (hotel_booking_number)

## Privacy & GDPR Considerations

**Guest Names:**
- May need to be masked/hashed for privacy
- Consider: "Guest in Room 101" instead of actual name
- Add setting: "Show guest names" (admin only)
- Log access to guest PII

**Data Retention:**
- How long to keep room-level data?
- May need purge policy for old bookings
- Aggregate historical data, delete room details

## Performance Considerations

**Database Size:**
- Current: ~365 rows per year (1 per day)
- New: ~365 × 25 rooms = 9,125 rows per year
- 10 years: ~91,000 rows (still manageable)

**Indexing:**
- Existing: (kitchen_id, date)
- New: (kitchen_id, date, room_number) - already created
- Consider: (kitchen_id, booking_id) for linking to Resos

**Query Performance:**
- ResidentsTableChart queries 7-day window
- Fetching 7 × 25 = 175 rows max
- Indexes should handle this easily

## Migration Strategy

**For Existing Aggregated Rows:**

**Option 1:** Delete and re-sync
```sql
DELETE FROM newbook_daily_occupancy;
-- Then run sync to repopulate with room-level data
```

**Option 2:** Keep aggregated rows, add room-level
- Set room_number = NULL for aggregated rows
- Add new room-level rows alongside
- API filters WHERE room_number IS NOT NULL

**Option 3:** Backfill from booking history (if available)
- Query Newbook API for historical bookings
- Reconstruct room occupancy for past dates
- May be slow/rate-limited

## Next Steps

1. **Immediate:** Check Newbook API docs for room-level endpoint
2. **Investigate:** Review current `arrival_booking_details` structure
3. **Decide:** Choose schema approach (modify existing vs new table)
4. **Prototype:** Test API calls to fetch room data
5. **Implement:** Update sync service based on findings
6. **Test:** Verify ResidentsTableChart shows real rooms

## Unknown/Questions

- [ ] Does Newbook API provide room-level occupancy?
- [ ] What endpoint? (e.g., `/api/room_status`, `/api/bookings`)
- [ ] Are guest names available?
- [ ] How are meal plans represented in API?
- [ ] Is booking ID always available?
- [ ] Rate limits for room-level sync?
- [ ] Historical data availability?

## Success Criteria

✅ ResidentsTableChart shows actual room numbers (e.g., "101", "102") instead of "Unknown Room"
✅ Guest names populated (if available and permitted)
✅ Booking IDs linked correctly
✅ DBB/package flags set correctly
✅ Restaurant bookings link via hotel_booking_number
✅ Data refreshes daily (or more frequently)
✅ Performance remains acceptable (<500ms API response)
