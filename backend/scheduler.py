"""
Background Scheduler for Daily Sync Jobs

Uses APScheduler for reliable scheduled task execution.
"""
import asyncio
import logging
from datetime import datetime
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select

from database import AsyncSessionLocal
from models.settings import KitchenSettings
from services.newbook_sync import NewbookSyncService
from services.resos_sync import ResosSyncService
from services.imap_sync import ImapSyncService

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def run_daily_newbook_sync():
    """
    Daily sync job that runs for all kitchens with auto-sync enabled.
    Scheduled to run at 4:00 AM server time.
    """
    logger.info("Starting daily Newbook sync job")

    async with AsyncSessionLocal() as db:
        # Get all kitchens with auto-sync enabled
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.newbook_auto_sync_enabled == True,
                KitchenSettings.newbook_api_key.isnot(None)
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with auto-sync enabled")

        for settings in settings_list:
            try:
                sync_service = NewbookSyncService(db, settings.kitchen_id)
                results = await sync_service.run_daily_sync()
                logger.info(f"Kitchen {settings.kitchen_id} sync completed: {results}")
            except Exception as e:
                logger.error(f"Kitchen {settings.kitchen_id} sync failed: {e}")
                # Continue with other kitchens


async def run_daily_resos_sync():
    """
    Daily Resos sync job that runs for all kitchens with auto-sync enabled.
    Scheduled to run at 4:30 AM server time.
    """
    logger.info("Starting daily Resos sync job")

    async with AsyncSessionLocal() as db:
        # Get all kitchens with Resos auto-sync enabled
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.resos_auto_sync_enabled == True,
                KitchenSettings.resos_api_key.isnot(None)
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with Resos auto-sync enabled")

        for settings in settings_list:
            try:
                sync_service = ResosSyncService(settings.kitchen_id, db)
                results = await sync_service.run_daily_sync()
                logger.info(f"Kitchen {settings.kitchen_id} Resos sync completed: {results}")
            except Exception as e:
                logger.error(f"Kitchen {settings.kitchen_id} Resos sync failed: {e}")
                # Continue with other kitchens


async def run_upcoming_newbook_sync():
    """
    Upcoming Newbook sync job (next 7 days) that runs more frequently.
    Interval configured per kitchen in settings (default 15 minutes).
    Keeps ResidentsTableChart and forecast data fresh.
    """
    logger.info("Starting upcoming Newbook sync job")

    async with AsyncSessionLocal() as db:
        # First, log all kitchens and their sync status for debugging
        all_settings = await db.execute(select(KitchenSettings))
        all_list = all_settings.scalars().all()
        for s in all_list:
            logger.debug(f"Kitchen {s.kitchen_id}: upcoming_sync_enabled={s.newbook_upcoming_sync_enabled}, api_key_set={bool(s.newbook_api_key)}")

        # Get all kitchens with upcoming sync enabled
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.newbook_upcoming_sync_enabled == True,
                KitchenSettings.newbook_api_key.isnot(None)
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with upcoming Newbook sync enabled")

        for settings in settings_list:
            try:
                sync_service = NewbookSyncService(db, settings.kitchen_id)
                results = await sync_service.run_upcoming_sync()
                logger.info(f"Kitchen {settings.kitchen_id} upcoming Newbook sync completed: {results}")
            except Exception as e:
                logger.error(f"Kitchen {settings.kitchen_id} upcoming Newbook sync failed: {e}")
                # Continue with other kitchens


async def run_upcoming_resos_sync():
    """
    Upcoming Resos sync job (next 7 days) that runs more frequently.
    Interval configured per kitchen in settings (default 15 minutes).
    """
    logger.info("Starting upcoming Resos sync job")

    async with AsyncSessionLocal() as db:
        # Get all kitchens with upcoming sync enabled
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.resos_upcoming_sync_enabled == True,
                KitchenSettings.resos_api_key.isnot(None)
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with upcoming Resos sync enabled")

        for settings in settings_list:
            try:
                sync_service = ResosSyncService(settings.kitchen_id, db)
                results = await sync_service.run_upcoming_sync()
                logger.info(f"Kitchen {settings.kitchen_id} upcoming Resos sync completed: {results}")
            except Exception as e:
                logger.error(f"Kitchen {settings.kitchen_id} upcoming Resos sync failed: {e}")
                # Continue with other kitchens


async def run_imap_inbox_sync():
    """
    IMAP email inbox sync job that runs for all kitchens with IMAP enabled.
    Runs every 15 minutes by default - polls configured email accounts for
    invoice attachments and processes them through the OCR pipeline.
    """
    logger.info("Starting IMAP inbox sync job")

    async with AsyncSessionLocal() as db:
        # Get all kitchens with IMAP enabled
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.imap_enabled == True,
                KitchenSettings.imap_host.isnot(None),
                KitchenSettings.imap_password.isnot(None)
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with IMAP enabled")

        for settings in settings_list:
            try:
                sync_service = ImapSyncService(settings.kitchen_id, db)
                results = await sync_service.process_inbox()
                logger.info(
                    f"Kitchen {settings.kitchen_id} IMAP sync completed: "
                    f"{results['emails_processed']} emails, "
                    f"{results['invoices_created']} invoices created"
                )
            except Exception as e:
                logger.error(f"Kitchen {settings.kitchen_id} IMAP sync failed: {e}")
                # Continue with other kitchens


async def run_scheduled_backup():
    """
    Run scheduled backups for all kitchens with auto-backup enabled.
    Scheduled to run at 3:00 AM server time.
    """
    from services.backup_service import BackupService

    logger.info("Starting scheduled backup job")

    async with AsyncSessionLocal() as db:
        # Get all kitchens with backup frequency set
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.backup_frequency.in_(["daily", "weekly"])
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with scheduled backup")

        for settings in settings_list:
            # Check if it's time to run based on frequency
            should_run = False

            if settings.backup_frequency == "daily":
                should_run = True
            elif settings.backup_frequency == "weekly":
                # Run on Sundays (weekday 6)
                should_run = datetime.utcnow().weekday() == 6

            if should_run:
                try:
                    backup_service = BackupService(db, settings.kitchen_id)
                    success, msg, _ = await backup_service.create_backup(
                        backup_type="scheduled"
                    )
                    logger.info(f"Kitchen {settings.kitchen_id} backup: {msg}")
                except Exception as e:
                    logger.error(f"Kitchen {settings.kitchen_id} backup failed: {e}")


async def run_file_archival():
    """
    Archive eligible invoice files to Nextcloud.
    Runs at 3:30 AM, after backups to ensure local files are backed up first.
    """
    from services.file_archival_service import FileArchivalService
    from models.invoice import Invoice, InvoiceStatus

    logger.info("Starting file archival job")

    async with AsyncSessionLocal() as db:
        # Get kitchens with Nextcloud enabled
        result = await db.execute(
            select(KitchenSettings).where(
                KitchenSettings.nextcloud_enabled == True
            )
        )
        settings_list = result.scalars().all()

        logger.info(f"Found {len(settings_list)} kitchens with Nextcloud enabled")

        for settings in settings_list:
            try:
                archival_service = FileArchivalService(db, settings.kitchen_id)

                # Get confirmed invoices still local
                result = await db.execute(
                    select(Invoice).where(
                        Invoice.kitchen_id == settings.kitchen_id,
                        Invoice.status == InvoiceStatus.CONFIRMED,
                        Invoice.file_storage_location == "local"
                    )
                )
                invoices = result.scalars().all()

                archived_count = 0
                for invoice in invoices:
                    if await archival_service.is_ready_for_archival(invoice):
                        try:
                            success, msg = await archival_service.archive_invoice_file(invoice)
                            if success:
                                archived_count += 1
                        except Exception as e:
                            logger.warning(f"Failed to archive invoice {invoice.id}: {e}")

                if archived_count > 0:
                    logger.info(f"Kitchen {settings.kitchen_id}: Archived {archived_count} invoices to Nextcloud")

            except Exception as e:
                logger.error(f"Kitchen {settings.kitchen_id} archival failed: {e}")


def start_scheduler():
    """Initialize and start the scheduler"""
    # Backup at 3:00 AM
    scheduler.add_job(
        run_scheduled_backup,
        CronTrigger(hour=3, minute=0),
        id="daily_backup",
        name="Daily Backup",
        replace_existing=True
    )

    # File archival at 3:30 AM (after backup to ensure local files are backed up first)
    scheduler.add_job(
        run_file_archival,
        CronTrigger(hour=3, minute=30),
        id="file_archival",
        name="File Archival to Nextcloud",
        replace_existing=True
    )

    # Daily sync at 4:00 AM
    scheduler.add_job(
        run_daily_newbook_sync,
        CronTrigger(hour=4, minute=0),
        id="daily_newbook_sync",
        name="Daily Newbook Data Sync",
        replace_existing=True
    )

    # Daily Resos sync at 4:30 AM
    scheduler.add_job(
        run_daily_resos_sync,
        CronTrigger(hour=4, minute=30),
        id="daily_resos_sync",
        name="Daily Resos Booking Data Sync",
        replace_existing=True
    )

    # Upcoming Newbook sync (next 7 days) - runs every 15 minutes by default
    # Note: The interval is configured per kitchen in settings
    scheduler.add_job(
        run_upcoming_newbook_sync,
        IntervalTrigger(minutes=15),
        id="upcoming_newbook_sync",
        name="Upcoming Newbook Sync (Next 7 Days)",
        replace_existing=True
    )

    # Upcoming Resos sync (next 7 days) - runs every 15 minutes by default
    # Note: The interval is configured per kitchen in settings
    scheduler.add_job(
        run_upcoming_resos_sync,
        IntervalTrigger(minutes=15),
        id="upcoming_resos_sync",
        name="Upcoming Resos Sync (Next 7 Days)",
        replace_existing=True
    )

    # IMAP email inbox sync - runs every 15 minutes
    # Polls configured email accounts for invoice attachments
    scheduler.add_job(
        run_imap_inbox_sync,
        IntervalTrigger(minutes=15),
        id="imap_inbox_sync",
        name="IMAP Email Inbox Sync",
        replace_existing=True
    )

    scheduler.start()
    logger.info("Scheduler started - backup at 3:00 AM, archival at 3:30 AM, Newbook sync at 4:00 AM, Resos sync at 4:30 AM, Upcoming syncs every 15 min, IMAP sync every 15 min")


def stop_scheduler():
    """Shutdown the scheduler"""
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
