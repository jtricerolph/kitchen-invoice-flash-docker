# Plan 5: Database Backup Verification & Enhancement

## Current State

### Existing Backup System
**File:** `backend/services/backup.py`

Current backup functionality:
- Manual trigger via `/api/backup/create` endpoint
- Backs up to Nextcloud using WebDAV
- Includes PDF files from Dext processing
- Creates compressed archives

**What's Currently Backed Up:**
- PDF files in `/app/pdfs/` directory
- (Unclear if PostgreSQL database is included)

### Backup Settings
**File:** `backend/api/settings.py`

Settings stored in `kitchens` table:
- `nextcloud_url`
- `nextcloud_username`
- `nextcloud_password`
- `backup_enabled`

## Problem Statement

User concern: "just double check the backup works and the backup includes the database not just pdf's"

**Critical Questions:**
1. Does current backup include PostgreSQL database?
2. Is the manual backup button backing up complete system?
3. How to verify backups are complete and restorable?
4. What happens if database grows large?
5. Are backups tested/validated?

**Goals:**
1. **Verify** database is included in backups
2. **Enhance** backup to guarantee complete system backup
3. **Add** backup verification/testing mechanism
4. **Implement** backup health monitoring
5. **Document** restore procedure

## Investigation Required

### 1. Review Current Backup Implementation

**File:** `backend/services/backup.py`

Need to examine:
```python
async def create_backup(kitchen_id: int) -> dict:
    # What does this function actually back up?
    # Does it call pg_dump?
    # Or only tars PDF directory?
```

**Check for:**
- [ ] `pg_dump` command execution
- [ ] PostgreSQL connection for backup
- [ ] Database credentials in environment
- [ ] Backup file contents verification

### 2. Test Current Backup

**Manual verification steps:**
1. Trigger manual backup via UI
2. Download backup file from Nextcloud
3. Extract archive
4. Check contents:
   - [ ] PDF files present?
   - [ ] SQL dump file present?
   - [ ] File sizes reasonable?

### 3. Identify Gaps

Based on investigation, determine:
- Missing PostgreSQL backup
- Missing backup verification
- No restore testing
- No backup rotation policy
- No size/integrity checks

## Architecture

### Enhanced Backup System

```
┌─────────────────────────────────────────────────────┐
│              Backup Orchestrator                    │
│                                                     │
│  1. Collect all backup artifacts                    │
│  2. Verify integrity                                │
│  3. Compress and upload                             │
│  4. Test restore (optional)                         │
│  5. Log results                                     │
└─────────────────────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
        ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │  PDF Files   │ │ Application  │ │   Metadata   │
│   Database   │ │              │ │    Configs   │ │              │
│              │ │              │ │              │ │              │
│ - pg_dump    │ │ - Dext PDFs  │ │ - .env       │ │ - manifest   │
│ - compressed │ │ - Compressed │ │ - Settings   │ │ - checksums  │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│            Nextcloud (WebDAV)                       │
│                                                     │
│  /Kitchen_Invoice_Flash_Backups/                    │
│    kitchen_1/                                       │
│      2026-01-22_140530/                             │
│        database.sql.gz                              │
│        pdfs.tar.gz                                  │
│        manifest.json                                │
│        verification.json                            │
└─────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Audit Current System

#### 1.1 Read Backup Service

Read and analyze `backend/services/backup.py` to understand:
- What is currently backed up
- How backup process works
- What's missing

#### 1.2 Test Existing Backup

Manual steps:
```bash
# In Docker container
docker exec -it kitchen-invoice-flash-docker-backend-1 bash

# Check if pg_dump is available
which pg_dump

# Check environment variables
env | grep POSTGRES

# Manually create test backup
pg_dump -h db -U kitchen -d kitchen_gp > /tmp/test_backup.sql

# Check file size
ls -lh /tmp/test_backup.sql
```

### Phase 2: Enhance Backup Service

#### 2.1 Complete Backup Function

**File:** `backend/services/backup.py` (UPDATE)

```python
import os
import subprocess
import tarfile
import hashlib
import json
from datetime import datetime
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


async def create_complete_backup(kitchen_id: int) -> dict:
    """
    Create complete system backup including database and files

    Returns:
        dict with backup details: path, size, checksums, verification status
    """

    backup_timestamp = datetime.utcnow().strftime("%Y-%m-%d_%H%M%S")
    backup_name = f"kitchen_{kitchen_id}_{backup_timestamp}"
    backup_dir = f"/tmp/backups/{backup_name}"

    # Create backup directory
    os.makedirs(backup_dir, exist_ok=True)

    logger.info(f"Starting complete backup for kitchen {kitchen_id}")

    try:
        # 1. Backup PostgreSQL Database
        logger.info("Backing up PostgreSQL database...")
        db_backup_path = f"{backup_dir}/database.sql"
        db_compressed_path = f"{db_backup_path}.gz"

        # Run pg_dump
        db_host = os.getenv("POSTGRES_HOST", "db")
        db_port = os.getenv("POSTGRES_PORT", "5432")
        db_name = os.getenv("POSTGRES_DB", "kitchen_gp")
        db_user = os.getenv("POSTGRES_USER", "kitchen")
        db_password = os.getenv("POSTGRES_PASSWORD", "kitchen")

        # Set PGPASSWORD environment variable for pg_dump
        env = os.environ.copy()
        env["PGPASSWORD"] = db_password

        pg_dump_command = [
            "pg_dump",
            "-h", db_host,
            "-p", db_port,
            "-U", db_user,
            "-d", db_name,
            "--no-owner",  # Don't dump ownership commands
            "--no-acl",    # Don't dump access privileges
            "-f", db_backup_path
        ]

        result = subprocess.run(
            pg_dump_command,
            env=env,
            capture_output=True,
            text=True,
            timeout=600  # 10 minute timeout
        )

        if result.returncode != 0:
            raise Exception(f"pg_dump failed: {result.stderr}")

        # Compress database dump
        subprocess.run(["gzip", "-9", db_backup_path], check=True)

        db_size_mb = os.path.getsize(db_compressed_path) / (1024 * 1024)
        logger.info(f"Database backup completed: {db_size_mb:.2f} MB")

        # 2. Backup PDF Files
        logger.info("Backing up PDF files...")
        pdf_source_dir = f"/app/pdfs/kitchen_{kitchen_id}"
        pdf_backup_path = f"{backup_dir}/pdfs.tar.gz"

        if os.path.exists(pdf_source_dir):
            with tarfile.open(pdf_backup_path, "w:gz") as tar:
                tar.add(pdf_source_dir, arcname="pdfs")

            pdf_size_mb = os.path.getsize(pdf_backup_path) / (1024 * 1024)
            logger.info(f"PDF backup completed: {pdf_size_mb:.2f} MB")
        else:
            logger.warning(f"PDF directory not found: {pdf_source_dir}")
            pdf_size_mb = 0

        # 3. Backup Application Configuration (optional)
        logger.info("Backing up configuration...")
        config_backup_path = f"{backup_dir}/config.json"

        # Export kitchen-specific settings (without sensitive data)
        from database import get_db_context
        from models.user import Kitchen
        from sqlalchemy import select

        async with get_db_context() as db:
            result = await db.execute(
                select(Kitchen).where(Kitchen.id == kitchen_id)
            )
            kitchen = result.scalar_one_or_none()

            if kitchen:
                config_data = {
                    "kitchen_id": kitchen.id,
                    "kitchen_name": kitchen.name,
                    "backup_timestamp": backup_timestamp,
                    "features_enabled": {
                        "dext": kitchen.dext_integration_id is not None,
                        "sambapos": kitchen.sambapos_server is not None,
                        "newbook": kitchen.newbook_api_key is not None,
                        "resos": kitchen.resos_api_key is not None
                    }
                }

                with open(config_backup_path, "w") as f:
                    json.dump(config_data, f, indent=2)

        # 4. Generate Manifest
        logger.info("Generating backup manifest...")
        manifest_path = f"{backup_dir}/manifest.json"

        manifest = {
            "backup_version": "2.0",
            "backup_timestamp": backup_timestamp,
            "kitchen_id": kitchen_id,
            "components": {
                "database": {
                    "file": "database.sql.gz",
                    "size_mb": db_size_mb,
                    "checksum": _calculate_checksum(db_compressed_path)
                },
                "pdfs": {
                    "file": "pdfs.tar.gz",
                    "size_mb": pdf_size_mb,
                    "checksum": _calculate_checksum(pdf_backup_path) if os.path.exists(pdf_backup_path) else None
                },
                "config": {
                    "file": "config.json",
                    "checksum": _calculate_checksum(config_backup_path)
                }
            },
            "total_size_mb": db_size_mb + pdf_size_mb,
            "created_at": datetime.utcnow().isoformat()
        }

        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        # 5. Create Final Archive
        logger.info("Creating final backup archive...")
        final_archive_path = f"/tmp/backups/{backup_name}.tar.gz"

        with tarfile.open(final_archive_path, "w:gz") as tar:
            tar.add(backup_dir, arcname=backup_name)

        final_size_mb = os.path.getsize(final_archive_path) / (1024 * 1024)
        final_checksum = _calculate_checksum(final_archive_path)

        logger.info(f"Final archive created: {final_size_mb:.2f} MB, checksum: {final_checksum}")

        # 6. Upload to Nextcloud
        logger.info("Uploading to Nextcloud...")
        upload_result = await upload_to_nextcloud(
            kitchen_id=kitchen_id,
            local_path=final_archive_path,
            remote_path=f"{backup_name}.tar.gz"
        )

        # 7. Cleanup local files
        import shutil
        shutil.rmtree(backup_dir)
        os.remove(final_archive_path)

        logger.info(f"Backup completed successfully for kitchen {kitchen_id}")

        return {
            "status": "success",
            "backup_name": backup_name,
            "size_mb": final_size_mb,
            "checksum": final_checksum,
            "components": manifest["components"],
            "nextcloud_path": upload_result["remote_path"],
            "created_at": backup_timestamp
        }

    except Exception as e:
        logger.error(f"Backup failed for kitchen {kitchen_id}: {e}", exc_info=True)

        # Cleanup on failure
        if os.path.exists(backup_dir):
            shutil.rmtree(backup_dir, ignore_errors=True)

        raise


def _calculate_checksum(file_path: str) -> str:
    """Calculate SHA256 checksum of file"""
    sha256_hash = hashlib.sha256()

    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)

    return sha256_hash.hexdigest()


async def upload_to_nextcloud(kitchen_id: int, local_path: str, remote_path: str) -> dict:
    """Upload backup file to Nextcloud via WebDAV"""

    from database import get_db_context
    from models.user import Kitchen
    from sqlalchemy import select
    import httpx

    async with get_db_context() as db:
        result = await db.execute(
            select(Kitchen).where(Kitchen.id == kitchen_id)
        )
        kitchen = result.scalar_one_or_none()

        if not kitchen or not kitchen.nextcloud_url:
            raise ValueError(f"Nextcloud not configured for kitchen {kitchen_id}")

        # WebDAV URL
        webdav_url = f"{kitchen.nextcloud_url}/remote.php/dav/files/{kitchen.nextcloud_username}/Kitchen_Invoice_Flash_Backups/{remote_path}"

        # Upload file
        with open(local_path, "rb") as f:
            async with httpx.AsyncClient(timeout=300.0) as client:
                response = await client.put(
                    webdav_url,
                    auth=(kitchen.nextcloud_username, kitchen.nextcloud_password),
                    content=f,
                    headers={"Content-Type": "application/gzip"}
                )

                if response.status_code not in [200, 201, 204]:
                    raise Exception(f"Nextcloud upload failed: {response.status_code} {response.text}")

        return {
            "remote_path": webdav_url,
            "status": "uploaded"
        }
```

#### 2.2 Backup Verification Function

**File:** `backend/services/backup.py` (ADD)

```python
async def verify_backup(backup_path: str) -> dict:
    """
    Verify backup integrity by:
    1. Extracting archive
    2. Checking manifest
    3. Verifying checksums
    4. Testing database restore (optional, in test environment)

    Returns:
        dict with verification results
    """

    logger.info(f"Verifying backup: {backup_path}")

    verification_results = {
        "archive_valid": False,
        "manifest_found": False,
        "database_valid": False,
        "pdfs_valid": False,
        "checksums_match": False,
        "errors": []
    }

    temp_extract_dir = "/tmp/backup_verification"
    os.makedirs(temp_extract_dir, exist_ok=True)

    try:
        # 1. Extract archive
        with tarfile.open(backup_path, "r:gz") as tar:
            tar.extractall(temp_extract_dir)

        verification_results["archive_valid"] = True

        # Find backup directory (should be single top-level dir)
        backup_dirs = [d for d in os.listdir(temp_extract_dir) if os.path.isdir(os.path.join(temp_extract_dir, d))]

        if len(backup_dirs) != 1:
            verification_results["errors"].append("Expected single backup directory in archive")
            return verification_results

        backup_dir = os.path.join(temp_extract_dir, backup_dirs[0])

        # 2. Read manifest
        manifest_path = os.path.join(backup_dir, "manifest.json")

        if not os.path.exists(manifest_path):
            verification_results["errors"].append("Manifest file not found")
            return verification_results

        with open(manifest_path, "r") as f:
            manifest = json.load(f)

        verification_results["manifest_found"] = True
        verification_results["manifest"] = manifest

        # 3. Verify database file
        db_file = os.path.join(backup_dir, manifest["components"]["database"]["file"])

        if not os.path.exists(db_file):
            verification_results["errors"].append("Database file not found")
        else:
            # Check checksum
            actual_checksum = _calculate_checksum(db_file)
            expected_checksum = manifest["components"]["database"]["checksum"]

            if actual_checksum == expected_checksum:
                verification_results["database_valid"] = True
            else:
                verification_results["errors"].append(f"Database checksum mismatch: {actual_checksum} != {expected_checksum}")

        # 4. Verify PDF file
        pdf_file = os.path.join(backup_dir, manifest["components"]["pdfs"]["file"])

        if os.path.exists(pdf_file):
            actual_checksum = _calculate_checksum(pdf_file)
            expected_checksum = manifest["components"]["pdfs"]["checksum"]

            if actual_checksum == expected_checksum:
                verification_results["pdfs_valid"] = True
            else:
                verification_results["errors"].append(f"PDFs checksum mismatch")

        # 5. Overall status
        verification_results["checksums_match"] = (
            verification_results["database_valid"] and
            verification_results["pdfs_valid"]
        )

        verification_results["status"] = "valid" if verification_results["checksums_match"] else "invalid"

        logger.info(f"Backup verification completed: {verification_results['status']}")

    except Exception as e:
        logger.error(f"Backup verification failed: {e}", exc_info=True)
        verification_results["errors"].append(str(e))
        verification_results["status"] = "error"

    finally:
        # Cleanup
        import shutil
        shutil.rmtree(temp_extract_dir, ignore_errors=True)

    return verification_results
```

### Phase 3: Database Model for Backup Tracking

#### 3.1 Create Backup Log Model

**File:** `backend/models/backup.py` (NEW)

```python
from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, DateTime, ForeignKey, Numeric, Boolean, Text, Integer
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class BackupLog(Base):
    """Log of all backup operations"""
    __tablename__ = "backup_logs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # Backup metadata
    backup_name: Mapped[str] = mapped_column(String(255), nullable=False)
    backup_timestamp: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    backup_type: Mapped[str] = mapped_column(String(50), default="manual")  # manual, scheduled, pre-restore

    # Status
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # success, failed, in_progress
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Size and location
    size_mb: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)  # SHA256
    nextcloud_path: Mapped[str] = mapped_column(String(500), nullable=False)

    # Components included
    components: Mapped[dict] = mapped_column(JSONB, nullable=False)  # Details from manifest

    # Verification
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    verification_status: Mapped[str | None] = mapped_column(String(20), nullable=True)  # valid, invalid, not_verified
    verification_details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Audit
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="backup_logs")
    created_by_user: Mapped["User"] = relationship("User")


# Add to Kitchen model in backend/models/user.py:
# backup_logs: Mapped[list["BackupLog"]] = relationship("BackupLog", back_populates="kitchen")
```

### Phase 4: API Endpoints

#### 4.1 Enhanced Backup API

**File:** `backend/api/backup.py` (UPDATE)

```python
@router.post("/create")
async def create_backup_endpoint(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create complete system backup (database + files)"""

    # Create backup log entry
    backup_log = BackupLog(
        kitchen_id=current_user.kitchen_id,
        backup_name=f"kitchen_{current_user.kitchen_id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}",
        backup_timestamp=datetime.utcnow(),
        backup_type="manual",
        status="in_progress",
        size_mb=0,
        checksum="",
        nextcloud_path="",
        components={},
        created_by=current_user.id
    )
    db.add(backup_log)
    await db.commit()

    try:
        # Perform backup
        result = await create_complete_backup(current_user.kitchen_id)

        # Update log
        backup_log.status = "success"
        backup_log.size_mb = Decimal(str(result["size_mb"]))
        backup_log.checksum = result["checksum"]
        backup_log.nextcloud_path = result["nextcloud_path"]
        backup_log.components = result["components"]

        await db.commit()

        return {
            "status": "success",
            "backup_id": backup_log.id,
            **result
        }

    except Exception as e:
        logger.error(f"Backup creation failed: {e}", exc_info=True)

        backup_log.status = "failed"
        backup_log.error_message = str(e)
        await db.commit()

        raise HTTPException(status_code=500, detail=f"Backup failed: {str(e)}")


@router.post("/verify/{backup_id}")
async def verify_backup_endpoint(
    backup_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Verify backup integrity"""

    # Get backup log
    result = await db.execute(
        select(BackupLog).where(
            and_(
                BackupLog.id == backup_id,
                BackupLog.kitchen_id == current_user.kitchen_id
            )
        )
    )
    backup_log = result.scalar_one_or_none()

    if not backup_log:
        raise HTTPException(status_code=404, detail="Backup not found")

    # Download from Nextcloud
    local_path = f"/tmp/verify_{backup_id}.tar.gz"

    # TODO: Download from Nextcloud
    # await download_from_nextcloud(backup_log.nextcloud_path, local_path)

    # Verify
    verification = await verify_backup(local_path)

    # Update log
    backup_log.verified_at = datetime.utcnow()
    backup_log.verification_status = verification["status"]
    backup_log.verification_details = verification

    await db.commit()

    # Cleanup
    if os.path.exists(local_path):
        os.remove(local_path)

    return verification


@router.get("/history")
async def get_backup_history(
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get backup history for current kitchen"""

    result = await db.execute(
        select(BackupLog).where(
            BackupLog.kitchen_id == current_user.kitchen_id
        ).order_by(BackupLog.backup_timestamp.desc()).limit(limit)
    )
    backups = result.scalars().all()

    return [
        {
            "id": b.id,
            "backup_name": b.backup_name,
            "backup_timestamp": b.backup_timestamp.isoformat(),
            "status": b.status,
            "size_mb": float(b.size_mb),
            "verified": b.verification_status == "valid",
            "components": b.components
        }
        for b in backups
    ]
```

### Phase 5: Frontend Integration

#### 5.1 Backup Dashboard Widget

**File:** `frontend/src/pages/Dashboard.tsx` (UPDATE)

Add backup status widget:

```typescript
<div style={styles.widget}>
  <h3>Backup Status</h3>
  {lastBackup && (
    <>
      <div>
        <strong>Last Backup:</strong> {formatTimeAgo(lastBackup.backup_timestamp)}
      </div>
      <div>
        <strong>Size:</strong> {lastBackup.size_mb.toFixed(2)} MB
      </div>
      <div>
        <strong>Status:</strong>
        <span style={{
          color: lastBackup.status === 'success' ? 'green' : 'red',
          marginLeft: '0.5rem'
        }}>
          {lastBackup.status === 'success' ? '✓ Complete' : '✗ Failed'}
        </span>
      </div>
      {lastBackup.verified && (
        <div style={{ color: 'green', marginTop: '0.5rem' }}>
          ✓ Verified
        </div>
      )}
    </>
  )}
  <button onClick={handleCreateBackup} style={styles.backupButton}>
    Create Backup Now
  </button>
</div>
```

#### 5.2 Settings Page - Backup Section

**File:** `frontend/src/pages/Settings.tsx` (UPDATE)

Add backup history and manual trigger:

```typescript
<div style={styles.section}>
  <h2>Backups</h2>

  <button onClick={handleManualBackup} style={styles.button}>
    🔒 Create Manual Backup Now
  </button>

  <h3 style={{ marginTop: '2rem' }}>Backup History</h3>
  <table style={styles.table}>
    <thead>
      <tr>
        <th>Date</th>
        <th>Size</th>
        <th>Status</th>
        <th>Verified</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {backupHistory.map((backup) => (
        <tr key={backup.id}>
          <td>{new Date(backup.backup_timestamp).toLocaleString()}</td>
          <td>{backup.size_mb.toFixed(2)} MB</td>
          <td>
            <span style={{
              color: backup.status === 'success' ? 'green' : 'red'
            }}>
              {backup.status}
            </span>
          </td>
          <td>
            {backup.verified ? '✓' : '—'}
          </td>
          <td>
            <button onClick={() => handleVerifyBackup(backup.id)}>
              Verify
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

### Phase 6: Automated Backup Schedule

#### 6.1 Add Scheduled Backup Service

**File:** `backend/services/backup_scheduler.py` (NEW)

```python
import asyncio
import logging
from datetime import datetime, time
from sqlalchemy import select
from database import get_db_context
from models.user import Kitchen
from services.backup import create_complete_backup

logger = logging.getLogger(__name__)

class BackupScheduler:
    """Automated daily backup scheduler"""

    def __init__(self):
        self.is_running = False
        self.task = None

    async def start(self):
        if self.is_running:
            return

        self.is_running = True
        self.task = asyncio.create_task(self._run_loop())
        logger.info("Backup scheduler started")

    async def stop(self):
        self.is_running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        logger.info("Backup scheduler stopped")

    async def _run_loop(self):
        """Run backups daily at configured time"""
        while self.is_running:
            try:
                now = datetime.now()
                target_time = time(hour=2, minute=0)  # 2 AM daily

                # Check if it's time for backup
                if now.hour == target_time.hour and now.minute == target_time.minute:
                    await self._backup_all_kitchens()
                    await asyncio.sleep(3600)  # Sleep 1 hour to avoid duplicate

            except Exception as e:
                logger.error(f"Backup scheduler error: {e}", exc_info=True)

            await asyncio.sleep(60)  # Check every minute

    async def _backup_all_kitchens(self):
        """Create backups for all kitchens with backups enabled"""
        async with get_db_context() as db:
            result = await db.execute(
                select(Kitchen).where(Kitchen.backup_enabled == True)
            )
            kitchens = result.scalars().all()

            for kitchen in kitchens:
                try:
                    logger.info(f"Starting scheduled backup for kitchen {kitchen.id}")
                    await create_complete_backup(kitchen.id)
                except Exception as e:
                    logger.error(f"Scheduled backup failed for kitchen {kitchen.id}: {e}")

backup_scheduler = BackupScheduler()
```

#### 6.2 Register Scheduler in main.py

**File:** `backend/main.py` (UPDATE)

```python
from services.backup_scheduler import backup_scheduler

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... existing startup ...

    # Start backup scheduler
    await backup_scheduler.start()

    yield

    # Shutdown
    await backup_scheduler.stop()
```

### Phase 7: Documentation

#### 7.1 Restore Procedure Document

**File:** `RESTORE_PROCEDURE.md` (NEW)

```markdown
# Backup Restore Procedure

## Prerequisites

- Access to Nextcloud backup storage
- Docker and Docker Compose installed
- PostgreSQL client tools

## Steps

### 1. Download Backup

```bash
# Download latest backup from Nextcloud
# Location: /Kitchen_Invoice_Flash_Backups/kitchen_X/YYYY-MM-DD_HHMMSS.tar.gz
```

### 2. Extract Backup

```bash
tar -xzf kitchen_X_YYYY-MM-DD_HHMMSS.tar.gz
cd kitchen_X_YYYY-MM-DD_HHMMSS
```

### 3. Verify Backup Contents

```bash
# Check manifest
cat manifest.json

# Verify checksums match
sha256sum -c checksums.txt
```

### 4. Restore Database

```bash
# Stop running containers
docker-compose -f docker-compose.dev.yml down

# Start only database
docker-compose -f docker-compose.dev.yml up -d db

# Wait for database to be ready
sleep 10

# Restore database
gunzip -c database.sql.gz | docker exec -i kitchen-invoice-flash-docker-db-1 psql -U kitchen -d kitchen_gp
```

### 5. Restore PDF Files

```bash
# Extract PDFs
tar -xzf pdfs.tar.gz

# Copy to container volume
docker cp pdfs/. kitchen-invoice-flash-docker-backend-1:/app/pdfs/
```

### 6. Restart Application

```bash
docker-compose -f docker-compose.dev.yml up -d
```

### 7. Verify Restore

- Log in to application
- Check dashboard loads
- Verify invoices visible
- Check PDF files accessible
- Run test queries

## Troubleshooting

**Database restore fails:**
- Check PostgreSQL logs: `docker logs kitchen-invoice-flash-docker-db-1`
- Verify database name matches
- Ensure database user has permissions

**PDF files not accessible:**
- Check file permissions: `docker exec kitchen-invoice-flash-docker-backend-1 ls -la /app/pdfs`
- Verify path matches configuration

## Backup Validation

Before relying on backups, test restore procedure in development environment quarterly.
```

## Success Criteria

✅ PostgreSQL database included in all backups
✅ Manual backup button creates complete system backup
✅ Backup includes: database, PDFs, configuration, manifest
✅ Backup verification function validates integrity
✅ Backup history visible in settings page
✅ Checksums calculated and stored for all components
✅ Automated daily backups at 2 AM
✅ Restore procedure documented and tested
✅ Backup logs stored in database for audit trail

## Testing Plan

### Test 1: Manual Backup
1. Click "Create Backup Now" button
2. Wait for completion
3. Download from Nextcloud
4. Extract and verify contents
5. Check database.sql.gz exists and is >1MB
6. Check pdfs.tar.gz exists
7. Verify manifest.json has correct checksums

### Test 2: Backup Verification
1. Trigger backup verification via API
2. Check verification passes
3. Verify checksums match
4. Confirm verification status in UI

### Test 3: Restore Test (Development Environment)
1. Create test data in development
2. Create backup
3. Wipe development database
4. Restore from backup
5. Verify all data recovered

### Test 4: Large Backup
1. Add >10GB of PDF files
2. Create backup
3. Verify upload completes
4. Check performance acceptable

## Future Enhancements

1. **Incremental Backups** - Only backup changes since last backup
2. **Backup Rotation** - Automatically delete backups older than X days
3. **Multi-Site Backups** - Centralized backup for all properties
4. **Backup Encryption** - Encrypt backups before upload
5. **Restore UI** - Web interface for restore operations
6. **Backup Alerts** - Email notifications on backup success/failure
7. **Cloud Storage Options** - Support AWS S3, Google Drive, etc.
