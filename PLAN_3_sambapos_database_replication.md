# Plan 3: SambaPOS Database Replication & Backup

## Current State

### Existing SambaPOS Integration
**File:** `backend/services/sambapos.py`

Current implementation:
- Direct SQL queries to live SambaPOS SQL Server database
- Connection via SQLAlchemy engine with pymssql driver
- Real-time queries for:
  - Transaction data (sales, payments)
  - Product menu items
  - Customer accounts
  - Daily reports

**Connection details:**
```python
# backend/models/user.py - Kitchen model
sambapos_server: str  # SQL Server hostname/IP
sambapos_database: str  # Database name
sambapos_username: str  # SQL auth username
sambapos_password: str  # Encrypted password
```

### Current Limitations

1. **Direct Live Database Queries**
   - Queries hit production EPOS system
   - Risk of locking tables during busy service
   - Network dependency (VPN/direct connection required)
   - No offline access

2. **Data Loss Risk**
   - SambaPOS databases cleared periodically (weekly/monthly)
   - Historical data lost after clear
   - No local archive of cleared data
   - Reporting limited to current period

3. **Performance Issues**
   - Network latency for remote queries
   - Large table scans on busy EPOS database
   - No indexing optimized for reporting queries

4. **Backup Gaps**
   - Current backup system (backend/services/backup.py) backs up:
     - Kitchen Invoice Flash database
     - PDF files from Dext
   - Does NOT backup SambaPOS data
   - Critical historical data not preserved

## Problem Statement

**Primary Goals:**
1. **Reduce EPOS Load:** Stop querying live production database
2. **Preserve History:** Keep SambaPOS data after database clears
3. **Improve Performance:** Query local copy with optimized indexes
4. **Backup Integration:** Include SambaPOS data in Nextcloud backups
5. **Offline Access:** Enable reporting without VPN connection

**User Request Context:**
"pull a copy of the sambapos db into the docker so we query our own copy and include it in the backups to nextcloud"

## Architecture Options

### Option A: Full Database Replication (PostgreSQL Copy)

**Concept:** Replicate entire SambaPOS database schema into PostgreSQL

```
┌─────────────────────────────────────────────────────┐
│         SambaPOS SQL Server (Production)            │
│                                                     │
│  - Live transaction data                            │
│  - Menu items, customers, accounts                  │
│  - Cleared periodically                             │
└─────────────────────────────────────────────────────┘
                       │
                       ▼ (Sync every 5-15 min)
┌─────────────────────────────────────────────────────┐
│     Kitchen Invoice Flash PostgreSQL Database       │
│                                                     │
│  ┌──────────────────────────────────────────┐    │
│  │  sambapos_transactions                    │    │
│  │  sambapos_payments                        │    │
│  │  sambapos_menu_items                      │    │
│  │  sambapos_accounts                        │    │
│  │  sambapos_order_tags                      │    │
│  │  sambapos_tickets                         │    │
│  └──────────────────────────────────────────┘    │
│                                                     │
│  Retention: Keep all historical data                │
│  Indexed for reporting queries                      │
└─────────────────────────────────────────────────────┘
                       │
                       ▼ (Backup daily)
┌─────────────────────────────────────────────────────┐
│              Nextcloud Backup                       │
│  - PostgreSQL dump (includes SambaPOS data)         │
│  - PDF files                                        │
│  - Full system restore capability                   │
└─────────────────────────────────────────────────────┘
```

**Pros:**
- Complete data preservation
- Optimized indexes for reporting
- PostgreSQL benefits (JSON, full-text search)
- Single backup process for all data

**Cons:**
- Schema mapping complexity (SQL Server → PostgreSQL)
- Data type conversions needed
- Large initial migration
- Ongoing schema sync if SambaPOS updates

### Option B: Selective Data Extract (Recommended)

**Concept:** Extract only essential tables/data needed for reporting

**Tables to replicate:**
1. **Transactions** - Sales, refunds, voids
2. **Payments** - Payment types, amounts
3. **Tickets** - Order headers
4. **Ticket Items** - Line items (products, quantities, prices)
5. **Accounts** - Customer accounts (hotel rooms, etc.)
6. **Menu Items** - Product catalog
7. **Order Tags** - Modifiers, notes

**Not replicated:**
- System configuration tables
- User accounts/permissions
- Terminal/printer settings
- Low-value operational data

```
┌─────────────────────────────────────────────────────┐
│         SambaPOS SQL Server (Production)            │
│                                                     │
│  SELECT * FROM [Transactions]                       │
│  SELECT * FROM [Payments]                           │
│  SELECT * FROM [Tickets]                            │
│  WHERE Date >= last_sync_date                       │
└─────────────────────────────────────────────────────┘
                       │
                       ▼ (Incremental sync)
┌─────────────────────────────────────────────────────┐
│    PostgreSQL: sambapos_replica schema              │
│                                                     │
│  sambapos_replica.transactions                      │
│  sambapos_replica.payments                          │
│  sambapos_replica.tickets                           │
│  sambapos_replica.ticket_items                      │
│  sambapos_replica.accounts                          │
│  sambapos_replica.menu_items                        │
│                                                     │
│  kitchen_id | original_id | synced_at | data (JSONB)│
└─────────────────────────────────────────────────────┘
```

**Pros:**
- Simpler implementation
- Faster sync
- Only data we actually use
- JSONB storage flexible for schema changes

**Cons:**
- Need to identify all required tables
- May miss edge case data needs

### Option C: Hybrid Approach with Archival

**Concept:** Combination of live queries + periodic full archives

- Continue live queries for current period
- Before each SambaPOS clear, take full snapshot
- Store snapshot in compressed archive
- Query current from live, historical from archive

**Pros:**
- Minimal changes to existing code
- Preserves complete history
- No ongoing sync overhead

**Cons:**
- Still dependent on live connection for current data
- Archive queries slower
- Doesn't solve performance issues

## Recommended Approach: Option B (Selective Extract)

Selective data replication provides the best balance of:
- Data preservation (history retained)
- Performance (local queries, optimized indexes)
- Simplicity (only replicate what we need)
- Flexibility (JSONB handles schema changes)

## Implementation Plan

### Phase 1: Database Schema

#### 1.1 Create Replication Schema

**File:** `backend/models/sambapos_replica.py` (NEW)

```python
from datetime import datetime, date
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Boolean, Text, Integer, UniqueConstraint, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base

class SambaposReplicationSettings(Base):
    """Settings for SambaPOS database replication"""
    __tablename__ = "sambapos_replication_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, unique=True)

    # Sync configuration
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_interval_minutes: Mapped[int] = mapped_column(Integer, default=15)  # Every 15 minutes
    full_sync_on_clear: Mapped[bool] = mapped_column(Boolean, default=True)  # Full sync before clears

    # Sync tracking
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_transaction_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # Latest transaction synced
    last_sync_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    records_synced_total: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="sambapos_replication_settings")


class SambaposTransaction(Base):
    """Replicated SambaPOS transaction data"""
    __tablename__ = "sambapos_transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # Original SambaPOS identifiers
    source_id: Mapped[int] = mapped_column(Integer, nullable=False)  # Original transaction ID
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)  # SambaPOS DB name

    # Transaction core data
    transaction_date: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    transaction_type: Mapped[str] = mapped_column(String(50), nullable=True)  # Sale, Refund, Void
    ticket_number: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)

    # Amounts
    amount_net: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    amount_tax: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    amount_total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    # Complete record as JSON (flexible for schema changes)
    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)

    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'source_id', 'source_database', name='uq_sambapos_transaction'),
        Index('idx_sambapos_trans_date_kitchen', 'kitchen_id', 'transaction_date'),
    )


class SambaposPayment(Base):
    """Replicated SambaPOS payment data"""
    __tablename__ = "sambapos_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)

    payment_date: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    ticket_number: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)

    payment_type: Mapped[str] = mapped_column(String(100), nullable=False)  # Cash, Card, Account
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'source_id', 'source_database', name='uq_sambapos_payment'),
    )


class SambaposTicket(Base):
    """Replicated SambaPOS ticket (order) data"""
    __tablename__ = "sambapos_tickets"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)

    ticket_number: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    ticket_date: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    # Ticket details
    table_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    customer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    account_name: Mapped[str | None] = mapped_column(String(255), nullable=True)  # Hotel room, etc.

    total_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    ticket_state: Mapped[str | None] = mapped_column(String(50), nullable=True)  # Open, Closed, Void

    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'source_id', 'source_database', name='uq_sambapos_ticket'),
        Index('idx_sambapos_ticket_number', 'kitchen_id', 'ticket_number'),
    )


class SambaposTicketItem(Base):
    """Replicated SambaPOS ticket line items"""
    __tablename__ = "sambapos_ticket_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)

    ticket_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # Link to sambapos_tickets.source_id
    ticket_number: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)

    # Line item details
    menu_item_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    menu_item_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    # Order tags (modifiers, special requests)
    order_tags: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'source_id', 'source_database', name='uq_sambapos_ticket_item'),
    )


class SambaposMenuItem(Base):
    """Replicated SambaPOS menu items (product catalog)"""
    __tablename__ = "sambapos_menu_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)

    item_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    item_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)

    price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'source_id', 'source_database', name='uq_sambapos_menu_item'),
    )


class SambaposAccount(Base):
    """Replicated SambaPOS accounts (customer accounts, hotel rooms)"""
    __tablename__ = "sambapos_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    source_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)

    account_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    account_type: Mapped[str | None] = mapped_column(String(100), nullable=True)  # Customer Account, Hotel Room
    account_number: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)

    balance: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'source_id', 'source_database', name='uq_sambapos_account'),
    )


class SambaposArchive(Base):
    """Full database snapshots before SambaPOS clears"""
    __tablename__ = "sambapos_archives"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    archive_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    source_database: Mapped[str] = mapped_column(String(100), nullable=False)

    # Snapshot metadata
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    transaction_count: Mapped[int] = mapped_column(Integer, default=0)
    ticket_count: Mapped[int] = mapped_column(Integer, default=0)

    # Archive storage
    archive_path: Mapped[str] = mapped_column(String(500), nullable=False)  # Path to backup file
    archive_size_mb: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    compression_type: Mapped[str] = mapped_column(String(20), default="gzip")  # gzip, zip, none

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'archive_date', name='uq_sambapos_archive'),
    )
```

#### 1.2 Create Migration

**File:** `backend/migrations/add_sambapos_replication.py` (NEW)

```python
import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)

async def run_migration():
    """Create SambaPOS replication tables"""

    # Create all replication tables
    # (Schema handled by SQLAlchemy models, this ensures indexes and constraints)

    create_replication_settings_sql = """
    CREATE TABLE IF NOT EXISTS sambapos_replication_settings (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id) UNIQUE,
        is_enabled BOOLEAN DEFAULT TRUE,
        sync_interval_minutes INTEGER DEFAULT 15,
        full_sync_on_clear BOOLEAN DEFAULT TRUE,
        last_sync_at TIMESTAMP,
        last_transaction_date TIMESTAMP,
        last_sync_status VARCHAR(20),
        last_error_message TEXT,
        records_synced_total INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """

    # Initialize replication settings for existing kitchens with SambaPOS
    initialize_settings_sql = """
    INSERT INTO sambapos_replication_settings (kitchen_id, is_enabled, sync_interval_minutes)
    SELECT id, TRUE, 15
    FROM kitchens
    WHERE sambapos_server IS NOT NULL
      AND id NOT IN (SELECT kitchen_id FROM sambapos_replication_settings)
    ON CONFLICT (kitchen_id) DO NOTHING;
    """

    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_replication_settings_sql))
            logger.info("Created sambapos_replication_settings table")

            # Other tables created by SQLAlchemy Base.metadata.create_all()

            await conn.execute(text(initialize_settings_sql))
            logger.info("Initialized SambaPOS replication settings for existing kitchens")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"SambaPOS replication migration: {e}")

if __name__ == "__main__":
    asyncio.run(run_migration())
```

### Phase 2: Replication Service

#### 2.1 Create Sync Service

**File:** `backend/services/sambapos_replicator.py` (NEW)

```python
import logging
from datetime import datetime, timedelta
from decimal import Decimal
from sqlalchemy import select, and_, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.engine import create_engine as create_sync_engine
from models.sambapos_replica import (
    SambaposReplicationSettings,
    SambaposTransaction,
    SambaposPayment,
    SambaposTicket,
    SambaposTicketItem,
    SambaposMenuItem,
    SambaposAccount
)
from models.user import Kitchen

logger = logging.getLogger(__name__)

class SambaPOSReplicator:
    """Service for replicating SambaPOS data to local PostgreSQL"""

    def __init__(self, kitchen: Kitchen, db: AsyncSession):
        self.kitchen = kitchen
        self.db = db
        self.source_db_name = kitchen.sambapos_database

        # Create sync connection to SQL Server
        connection_string = (
            f"mssql+pymssql://{kitchen.sambapos_username}:{kitchen.sambapos_password}"
            f"@{kitchen.sambapos_server}/{kitchen.sambapos_database}"
        )
        self.source_engine = create_sync_engine(connection_string, pool_pre_ping=True)

    async def sync_all_tables(self) -> dict:
        """Sync all SambaPOS tables (full or incremental)"""

        stats = {
            "transactions": 0,
            "payments": 0,
            "tickets": 0,
            "ticket_items": 0,
            "menu_items": 0,
            "accounts": 0,
            "errors": []
        }

        try:
            # Get replication settings
            result = await self.db.execute(
                select(SambaposReplicationSettings).where(
                    SambaposReplicationSettings.kitchen_id == self.kitchen.id
                )
            )
            settings = result.scalar_one_or_none()

            if not settings:
                raise ValueError(f"No replication settings found for kitchen {self.kitchen.id}")

            # Determine sync mode: full or incremental
            if settings.last_transaction_date:
                # Incremental: sync from last transaction date
                sync_from = settings.last_transaction_date
                logger.info(f"Incremental sync from {sync_from}")
            else:
                # Full sync: get all data
                sync_from = datetime(2020, 1, 1)  # Far enough back to catch all data
                logger.info("Full sync (first time)")

            # Sync each table
            stats["transactions"] = await self._sync_transactions(sync_from)
            stats["payments"] = await self._sync_payments(sync_from)
            stats["tickets"] = await self._sync_tickets(sync_from)
            stats["ticket_items"] = await self._sync_ticket_items(sync_from)
            stats["menu_items"] = await self._sync_menu_items()
            stats["accounts"] = await self._sync_accounts()

            # Update settings
            settings.last_sync_at = datetime.utcnow()
            settings.last_transaction_date = datetime.utcnow()
            settings.last_sync_status = "success"
            settings.records_synced_total += sum([
                stats["transactions"],
                stats["payments"],
                stats["tickets"],
                stats["ticket_items"],
                stats["menu_items"],
                stats["accounts"]
            ])

            await self.db.commit()

            logger.info(f"Sync completed: {stats}")
            return stats

        except Exception as e:
            logger.error(f"Sync failed: {e}", exc_info=True)
            stats["errors"].append(str(e))

            # Update error status
            if settings:
                settings.last_sync_status = "failed"
                settings.last_error_message = str(e)[:500]
                await self.db.commit()

            raise

    async def _sync_transactions(self, since: datetime) -> int:
        """Sync transactions from SambaPOS"""

        query = """
        SELECT
            Id, Date, [Type], TicketNumber,
            Amount, TaxAmount, TotalAmount,
            AccountName, UserName
        FROM [Transactions]
        WHERE Date >= ?
        ORDER BY Date
        """

        with self.source_engine.connect() as conn:
            result = conn.execute(text(query), (since,))
            rows = result.fetchall()

        count = 0
        for row in rows:
            # Upsert transaction
            transaction = SambaposTransaction(
                kitchen_id=self.kitchen.id,
                source_id=row.Id,
                source_database=self.source_db_name,
                transaction_date=row.Date,
                transaction_type=row.Type,
                ticket_number=row.TicketNumber,
                amount_net=Decimal(str(row.Amount or 0)),
                amount_tax=Decimal(str(row.TaxAmount or 0)) if row.TaxAmount else None,
                amount_total=Decimal(str(row.TotalAmount or 0)),
                raw_data={
                    "account_name": row.AccountName,
                    "user_name": row.UserName
                }
            )

            # Use merge to handle duplicates
            await self.db.merge(transaction)
            count += 1

        await self.db.commit()
        return count

    async def _sync_payments(self, since: datetime) -> int:
        """Sync payments from SambaPOS"""

        query = """
        SELECT
            Id, Date, PaymentType, Amount, TicketNumber
        FROM [Payments]
        WHERE Date >= ?
        ORDER BY Date
        """

        with self.source_engine.connect() as conn:
            result = conn.execute(text(query), (since,))
            rows = result.fetchall()

        count = 0
        for row in rows:
            payment = SambaposPayment(
                kitchen_id=self.kitchen.id,
                source_id=row.Id,
                source_database=self.source_db_name,
                payment_date=row.Date,
                ticket_number=row.TicketNumber,
                payment_type=row.PaymentType,
                amount=Decimal(str(row.Amount or 0)),
                raw_data={}
            )

            await self.db.merge(payment)
            count += 1

        await self.db.commit()
        return count

    async def _sync_tickets(self, since: datetime) -> int:
        """Sync tickets (orders) from SambaPOS"""

        query = """
        SELECT
            Id, TicketNumber, Date, TotalAmount,
            TableName, CustomerName, AccountName, TicketState
        FROM [Tickets]
        WHERE Date >= ?
        ORDER BY Date
        """

        with self.source_engine.connect() as conn:
            result = conn.execute(text(query), (since,))
            rows = result.fetchall()

        count = 0
        for row in rows:
            ticket = SambaposTicket(
                kitchen_id=self.kitchen.id,
                source_id=row.Id,
                source_database=self.source_db_name,
                ticket_number=row.TicketNumber,
                ticket_date=row.Date,
                table_name=row.TableName,
                customer_name=row.CustomerName,
                account_name=row.AccountName,
                total_amount=Decimal(str(row.TotalAmount or 0)),
                ticket_state=row.TicketState,
                raw_data={}
            )

            await self.db.merge(ticket)
            count += 1

        await self.db.commit()
        return count

    async def _sync_ticket_items(self, since: datetime) -> int:
        """Sync ticket line items from SambaPOS"""

        query = """
        SELECT
            ti.Id, ti.TicketId, t.TicketNumber,
            ti.MenuItemName, ti.MenuItemId,
            ti.Quantity, ti.Price, ti.Total,
            ti.OrderTags
        FROM [TicketItems] ti
        LEFT JOIN [Tickets] t ON ti.TicketId = t.Id
        WHERE t.Date >= ?
        ORDER BY t.Date
        """

        with self.source_engine.connect() as conn:
            result = conn.execute(text(query), (since,))
            rows = result.fetchall()

        count = 0
        for row in rows:
            # Parse order tags if present
            order_tags = None
            if row.OrderTags:
                try:
                    import json
                    order_tags = json.loads(row.OrderTags)
                except:
                    order_tags = [row.OrderTags]

            ticket_item = SambaposTicketItem(
                kitchen_id=self.kitchen.id,
                source_id=row.Id,
                source_database=self.source_db_name,
                ticket_id=row.TicketId,
                ticket_number=row.TicketNumber,
                menu_item_name=row.MenuItemName,
                menu_item_id=row.MenuItemId,
                quantity=Decimal(str(row.Quantity or 0)),
                price=Decimal(str(row.Price or 0)),
                total=Decimal(str(row.Total or 0)),
                order_tags=order_tags,
                raw_data={}
            )

            await self.db.merge(ticket_item)
            count += 1

        await self.db.commit()
        return count

    async def _sync_menu_items(self) -> int:
        """Sync menu items (full sync, no incremental)"""

        query = """
        SELECT
            Id, Name, Code, GroupCode, Price, IsActive
        FROM [MenuItems]
        """

        with self.source_engine.connect() as conn:
            result = conn.execute(text(query))
            rows = result.fetchall()

        count = 0
        for row in rows:
            menu_item = SambaposMenuItem(
                kitchen_id=self.kitchen.id,
                source_id=row.Id,
                source_database=self.source_db_name,
                item_name=row.Name,
                item_code=row.Code,
                category=row.GroupCode,
                price=Decimal(str(row.Price or 0)) if row.Price else None,
                is_active=row.IsActive if hasattr(row, 'IsActive') else True,
                raw_data={}
            )

            await self.db.merge(menu_item)
            count += 1

        await self.db.commit()
        return count

    async def _sync_accounts(self) -> int:
        """Sync accounts (customer accounts, hotel rooms)"""

        query = """
        SELECT
            Id, Name, AccountType, AccountNumber, Balance
        FROM [Accounts]
        """

        with self.source_engine.connect() as conn:
            result = conn.execute(text(query))
            rows = result.fetchall()

        count = 0
        for row in rows:
            account = SambaposAccount(
                kitchen_id=self.kitchen.id,
                source_id=row.Id,
                source_database=self.source_db_name,
                account_name=row.Name,
                account_type=row.AccountType if hasattr(row, 'AccountType') else None,
                account_number=row.AccountNumber if hasattr(row, 'AccountNumber') else None,
                balance=Decimal(str(row.Balance or 0)) if hasattr(row, 'Balance') else None,
                raw_data={}
            )

            await self.db.merge(account)
            count += 1

        await self.db.commit()
        return count

    async def create_archive(self) -> str:
        """Create full database snapshot before clear"""

        # TODO: Implement full database dump
        # - Export all tables to compressed file
        # - Store in archives directory
        # - Record in sambapos_archives table
        # - Upload to Nextcloud backup

        pass
```

#### 2.2 Create Scheduler

**File:** `backend/services/sambapos_scheduler.py` (NEW)

```python
import asyncio
import logging
from datetime import datetime
from sqlalchemy import select, and_
from database import get_db_context
from models.sambapos_replica import SambaposReplicationSettings
from models.user import Kitchen
from services.sambapos_replicator import SambaPOSReplicator

logger = logging.getLogger(__name__)

class SambaPOSScheduler:
    """Background scheduler for SambaPOS replication"""

    def __init__(self):
        self.is_running = False
        self.task = None

    async def start(self):
        if self.is_running:
            return

        self.is_running = True
        self.task = asyncio.create_task(self._run_loop())
        logger.info("SambaPOS replication scheduler started")

    async def stop(self):
        self.is_running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        logger.info("SambaPOS replication scheduler stopped")

    async def _run_loop(self):
        while self.is_running:
            try:
                await self._sync_all_kitchens()
            except Exception as e:
                logger.error(f"Error in SambaPOS scheduler: {e}", exc_info=True)

            await asyncio.sleep(60)  # Check every minute

    async def _sync_all_kitchens(self):
        async with get_db_context() as db:
            result = await db.execute(
                select(SambaposReplicationSettings, Kitchen).join(
                    Kitchen, SambaposReplicationSettings.kitchen_id == Kitchen.id
                ).where(
                    and_(
                        SambaposReplicationSettings.is_enabled == True,
                        Kitchen.sambapos_server.isnot(None)
                    )
                )
            )
            settings_and_kitchens = result.all()

            for settings, kitchen in settings_and_kitchens:
                # Check if interval elapsed
                if settings.last_sync_at:
                    minutes_since = (datetime.utcnow() - settings.last_sync_at).total_seconds() / 60
                    if minutes_since < settings.sync_interval_minutes:
                        continue

                # Perform sync
                try:
                    replicator = SambaPOSReplicator(kitchen, db)
                    await replicator.sync_all_tables()
                    logger.info(f"SambaPOS sync completed for kitchen {kitchen.id}")
                except Exception as e:
                    logger.error(f"SambaPOS sync failed for kitchen {kitchen.id}: {e}")

sambapos_scheduler = SambaPOSScheduler()
```

### Phase 3: Update Existing Services

#### 3.1 Modify SambaPOS Service to Query Replicas

**File:** `backend/services/sambapos.py`

Update all query methods to use replicated data:

```python
async def get_transactions(kitchen_id: int, date_from: date, date_to: date, db: AsyncSession):
    """Get transactions from replicated data (not live database)"""

    result = await db.execute(
        select(SambaposTransaction).where(
            and_(
                SambaposTransaction.kitchen_id == kitchen_id,
                SambaposTransaction.transaction_date >= date_from,
                SambaposTransaction.transaction_date <= date_to
            )
        ).order_by(SambaposTransaction.transaction_date)
    )
    transactions = result.scalars().all()

    return [
        {
            "id": t.source_id,
            "date": t.transaction_date,
            "type": t.transaction_type,
            "ticket_number": t.ticket_number,
            "amount": float(t.amount_total),
            **t.raw_data  # Include all original fields
        }
        for t in transactions
    ]
```

Add fallback to live database if replica empty:

```python
# Try replica first
transactions = await get_transactions_from_replica(kitchen_id, date_from, date_to, db)

# Fallback to live if no replica data
if not transactions:
    logger.warning(f"No replica data for kitchen {kitchen_id}, querying live database")
    transactions = await get_transactions_from_live(kitchen)

return transactions
```

### Phase 4: Backup Integration

#### 4.1 Update Backup Service

**File:** `backend/services/backup.py`

Update to include SambaPOS replicated data:

```python
async def create_full_backup(kitchen_id: int) -> str:
    """Create full system backup including SambaPOS replica"""

    backup_dir = f"/backups/kitchen_{kitchen_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    os.makedirs(backup_dir, exist_ok=True)

    # 1. Backup PostgreSQL database (includes SambaPOS replicas)
    db_backup_path = f"{backup_dir}/database.sql.gz"
    subprocess.run([
        "pg_dump",
        "-h", "db",
        "-U", "kitchen",
        "-d", "kitchen_gp",
        "-Z9",  # gzip compression
        "-f", db_backup_path
    ])

    # 2. Backup PDF files
    pdf_backup_path = f"{backup_dir}/pdfs.tar.gz"
    subprocess.run([
        "tar", "-czf", pdf_backup_path,
        f"/app/pdfs/kitchen_{kitchen_id}/"
    ])

    # 3. Create manifest
    manifest = {
        "backup_date": datetime.utcnow().isoformat(),
        "kitchen_id": kitchen_id,
        "database_backup": "database.sql.gz",
        "pdf_backup": "pdfs.tar.gz",
        "sambapos_replica_included": True,
        "tables": [
            "sambapos_transactions",
            "sambapos_payments",
            "sambapos_tickets",
            "sambapos_ticket_items",
            "sambapos_menu_items",
            "sambapos_accounts"
        ]
    }

    with open(f"{backup_dir}/manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    # 4. Upload to Nextcloud
    await upload_to_nextcloud(backup_dir, kitchen_id)

    return backup_dir
```

### Phase 5: Frontend Integration

#### 5.1 Settings Page

**File:** `frontend/src/pages/Settings.tsx`

Add SambaPOS replication settings section (similar to Newbook frequent sync).

#### 5.2 Reports Page Updates

Update reports to show source of data:

```typescript
<div style={styles.dataSourceBadge}>
  Data source: {usingReplicaData ? "Local (Replicated)" : "Live Database"}
  {lastSyncTime && <span>Last sync: {formatTimeAgo(lastSyncTime)}</span>}
</div>
```

### Phase 6: Testing & Rollout

#### Test Plan

1. **Initial Sync Test**
   - Enable replication for test kitchen
   - Trigger full sync
   - Verify all tables populated
   - Compare counts with live database

2. **Incremental Sync Test**
   - Wait for next sync interval
   - Add new transaction in SambaPOS
   - Verify transaction appears in replica

3. **Report Accuracy Test**
   - Generate reports from replica
   - Generate same reports from live
   - Compare results (should match)

4. **Backup Test**
   - Create full backup
   - Verify SambaPOS data included
   - Restore to test environment
   - Verify replicated data restored

5. **Performance Test**
   - Compare query times: replica vs live
   - Measure sync duration
   - Monitor database size growth

## Success Criteria

✅ SambaPOS replicated data stored locally in PostgreSQL
✅ Automatic sync every 15 minutes (configurable)
✅ All reports query replica instead of live database
✅ Historical data preserved after SambaPOS clears
✅ Full backups include SambaPOS replica
✅ Restore process recovers all SambaPOS data
✅ No performance degradation vs live queries
✅ Settings UI for enable/disable and interval

## Future Enhancements

1. **Archive Viewer**
   - UI to browse archived periods
   - Query historical data from archives

2. **Data Retention Policies**
   - Configurable retention periods
   - Automatic archival of old data
   - Compression of historical records

3. **Real-time Sync**
   - Webhook from SambaPOS on transaction
   - Near-instant replication (<1 second)

4. **Multi-Site Consolidation**
   - Aggregate data from multiple properties
   - Cross-site reporting
   - Centralized backup for all sites
