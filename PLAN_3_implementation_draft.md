# Plan 3: SambaPOS Database Replication - Implementation Plan (Draft)

**Status:** On hold - needs further consideration on approach

## Overview

Implement selective data replication from SambaPOS SQL Server to local PostgreSQL following Option B from PLAN_3. This reduces EPOS load, preserves historical data after clears, enables offline access, and includes SambaPOS data in Nextcloud backups.

## Current State

**Existing Implementation:** `backend/services/sambapos_api.py`
- `SambaPOSClient` class with direct MSSQL queries via aioodbc
- Real-time queries for categories, top sellers, GL codes, restaurant spend
- No local caching or replication
- Data lost when SambaPOS clears database periodically

**Connection Settings:** `backend/models/settings.py:76-88`
- `sambapos_db_host`, `sambapos_db_port`, `sambapos_db_name`, `sambapos_db_username`, `sambapos_db_password`

## Open Question

Should we:
1. Create new PostgreSQL tables with normalized schema (PLAN_3 Option B)
2. Mirror exact SambaPOS schema to reuse existing queries
3. Add local SQL Server container (zero query changes)
4. Just do periodic archives for backup (simplest)

## Implementation Phases (if proceeding with Option B)

### Phase 1: Database Models

**New File:** `backend/models/sambapos_replica.py`

Create 8 SQLAlchemy models:
1. `SambaposReplicationSettings` - Sync config and tracking
2. `SambaposTransaction` - Sales, refunds, voids
3. `SambaposPayment` - Payment types and amounts
4. `SambaposTicket` - Order headers
5. `SambaposTicketItem` - Line items with order tags
6. `SambaposMenuItem` - Product catalog
7. `SambaposAccount` - Customer accounts, hotel rooms
8. `SambaposArchive` - Full database snapshot metadata

### Phase 2: Replication Service

**New File:** `backend/services/sambapos_replicator.py`

### Phase 3: Background Scheduler

**New File:** `backend/services/sambapos_scheduler.py`

### Phase 4: Update SambaPOS API Service

### Phase 5: Backup Integration

### Phase 6: Frontend Settings UI

## Success Criteria

- [ ] SambaPOS data replicated to local PostgreSQL
- [ ] Automatic sync every 15 minutes (configurable)
- [ ] Reports can query replica instead of live database
- [ ] Historical data preserved after SambaPOS clears
- [ ] Backups include all replicated data
- [ ] Settings UI shows sync status and allows manual trigger
- [ ] Fallback to live database if replica empty
