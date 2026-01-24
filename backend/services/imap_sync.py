"""
IMAP Email Inbox Sync Service

Monitors email inbox for invoice attachments and processes them through
the existing Azure OCR pipeline.
"""
import asyncio
import email
import imaplib
import logging
import os
import uuid
from datetime import datetime
from email.header import decode_header
from email.utils import parsedate_to_datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.settings import KitchenSettings
from models.invoice import Invoice, InvoiceStatus
from models.email_processing import EmailProcessingLog

logger = logging.getLogger(__name__)


class ImapSyncService:
    """Service for syncing invoice emails from IMAP inbox"""

    # Only process PDFs to avoid logos and other images getting mixed in
    SUPPORTED_EXTENSIONS = {'.pdf'}
    SUPPORTED_CONTENT_TYPES = {
        'application/pdf'
    }

    def __init__(self, kitchen_id: int, db: AsyncSession):
        self.kitchen_id = kitchen_id
        self.db = db
        self._settings: Optional[KitchenSettings] = None

    async def _get_settings(self) -> KitchenSettings:
        """Fetch and cache kitchen settings"""
        if self._settings is None:
            result = await self.db.execute(
                select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
            )
            self._settings = result.scalar_one_or_none()
            if not self._settings:
                raise ValueError(f"No settings found for kitchen {self.kitchen_id}")
        return self._settings

    def _connect_imap(self, settings: KitchenSettings) -> imaplib.IMAP4_SSL | imaplib.IMAP4:
        """Create authenticated IMAP connection"""
        if settings.imap_use_ssl:
            conn = imaplib.IMAP4_SSL(settings.imap_host, settings.imap_port or 993)
        else:
            conn = imaplib.IMAP4(settings.imap_host, settings.imap_port or 143)
            conn.starttls()

        conn.login(settings.imap_username, settings.imap_password)
        return conn

    def _decode_header_value(self, value: str) -> str:
        """Decode email header value"""
        if value is None:
            return ""
        decoded_parts = decode_header(value)
        result = []
        for part, encoding in decoded_parts:
            if isinstance(part, bytes):
                result.append(part.decode(encoding or 'utf-8', errors='replace'))
            else:
                result.append(part)
        return ''.join(result)

    def _get_message_id(self, msg: email.message.Message) -> str:
        """Extract Message-ID from email"""
        message_id = msg.get('Message-ID', '')
        if not message_id:
            # Generate a fallback ID using date and subject
            date = msg.get('Date', '')
            subject = msg.get('Subject', '')
            message_id = f"<fallback-{hash(date + subject)}>"
        return message_id.strip()

    def _is_supported_attachment(self, filename: str, content_type: str) -> bool:
        """Check if attachment is a supported invoice format"""
        if not filename:
            return False

        ext = os.path.splitext(filename.lower())[1]
        if ext in self.SUPPORTED_EXTENSIONS:
            return True

        content_type_lower = content_type.lower() if content_type else ''
        return content_type_lower in self.SUPPORTED_CONTENT_TYPES

    def _extract_attachments(self, msg: email.message.Message) -> list[tuple[str, bytes, str]]:
        """
        Extract supported attachments from email.
        Returns list of (filename, content, content_type)
        """
        attachments = []

        if msg.is_multipart():
            for part in msg.walk():
                content_disposition = str(part.get("Content-Disposition", ""))

                if "attachment" in content_disposition or part.get_filename():
                    filename = part.get_filename()
                    if filename:
                        filename = self._decode_header_value(filename)
                    content_type = part.get_content_type()

                    if self._is_supported_attachment(filename, content_type):
                        content = part.get_payload(decode=True)
                        if content:
                            attachments.append((filename, content, content_type))
        else:
            # Single part email - unlikely to have attachment but check anyway
            filename = msg.get_filename()
            if filename:
                filename = self._decode_header_value(filename)
                content_type = msg.get_content_type()
                if self._is_supported_attachment(filename, content_type):
                    content = msg.get_payload(decode=True)
                    if content:
                        attachments.append((filename, content, content_type))

        return attachments

    async def _save_attachment(self, content: bytes, filename: str) -> str:
        """Save attachment to filesystem and return the path"""
        # Get file extension
        ext = os.path.splitext(filename)[1].lower()
        if not ext:
            ext = '.pdf'  # Default to PDF if no extension

        # Generate unique filename
        unique_filename = f"{uuid.uuid4()}{ext}"
        data_dir = f"/app/data/{self.kitchen_id}"
        os.makedirs(data_dir, exist_ok=True)
        file_path = os.path.join(data_dir, unique_filename)

        # Write file asynchronously
        await asyncio.to_thread(self._write_file, file_path, content)

        return file_path

    def _write_file(self, path: str, content: bytes):
        """Write content to file (blocking operation)"""
        with open(path, 'wb') as f:
            f.write(content)

    async def _process_attachment(
        self,
        file_path: str,
        email_subject: str
    ) -> tuple[int, float]:
        """
        Process attachment through the same pipeline as manual uploads.
        Creates invoice record, then runs full OCR processing including
        line items, product definitions, and duplicate detection.
        Returns (invoice_id, confidence)
        """
        from api.invoices import process_invoice_background

        # Create invoice record with source tracking
        invoice = Invoice(
            kitchen_id=self.kitchen_id,
            image_path=file_path,
            status=InvoiceStatus.PENDING,
            source="email",
            source_reference=email_subject[:255] if email_subject else None
        )
        self.db.add(invoice)
        await self.db.commit()
        await self.db.refresh(invoice)
        invoice_id = invoice.id

        try:
            # Process through the same flow as manual uploads
            # This handles OCR, line items, product definitions, and duplicate detection
            await process_invoice_background(invoice_id, file_path, self.kitchen_id)

            # Use a fresh session to fetch updated invoice data
            # (process_invoice_background uses its own session, so we need fresh data)
            from database import AsyncSessionLocal
            async with AsyncSessionLocal() as fresh_db:
                result = await fresh_db.execute(
                    select(Invoice).where(Invoice.id == invoice_id)
                )
                processed_invoice = result.scalar_one_or_none()

                if processed_invoice:
                    confidence = float(processed_invoice.ocr_confidence) if processed_invoice.ocr_confidence else 0.0
                    logger.info(f"Invoice {invoice_id} processed with confidence {confidence}")
                    return invoice_id, confidence
                else:
                    logger.warning(f"Invoice {invoice_id} not found after processing")
                    return invoice_id, 0.0

        except Exception as e:
            logger.error(f"Processing failed for invoice {invoice_id}: {e}")
            # Update the invoice to mark it as having an error using fresh session
            from database import AsyncSessionLocal
            async with AsyncSessionLocal() as error_db:
                result = await error_db.execute(
                    select(Invoice).where(Invoice.id == invoice_id)
                )
                invoice = result.scalar_one_or_none()
                if invoice:
                    invoice.status = InvoiceStatus.PROCESSED
                    invoice.ocr_raw_text = f"Processing Error: {str(e)}"
                    await error_db.commit()
            return invoice_id, 0.0

    async def _should_mark_read(self, attachment_results: list[tuple[int, float]]) -> bool:
        """
        Determine if email should be marked as read.
        Returns True if ANY attachment has confidence >= threshold.
        """
        settings = await self._get_settings()
        threshold = float(settings.imap_confidence_threshold or 0.5)

        logger.info(f"Checking mark-as-read: threshold={threshold}, results={attachment_results}")

        for invoice_id, confidence in attachment_results:
            if confidence is not None and confidence >= threshold:
                logger.info(f"Invoice {invoice_id} meets threshold ({confidence} >= {threshold}), will mark as read")
                return True
        logger.info(f"No invoices met threshold, will NOT mark as read")
        return False

    def _mark_email_read(self, conn: imaplib.IMAP4, uid: bytes):
        """Mark email as read (add SEEN flag)"""
        logger.info(f"Marking email UID {uid} as read")
        result = conn.uid('STORE', uid, '+FLAGS', '\\Seen')
        logger.info(f"Mark as read result: {result}")

    async def _is_already_processed(self, message_id: str) -> bool:
        """Check if email was already processed"""
        result = await self.db.execute(
            select(EmailProcessingLog).where(
                EmailProcessingLog.kitchen_id == self.kitchen_id,
                EmailProcessingLog.message_id == message_id
            )
        )
        return result.scalar_one_or_none() is not None

    async def _log_processing(
        self,
        message_id: str,
        email_subject: str,
        email_from: str,
        email_date: datetime,
        attachments_count: int,
        invoices_created: int,
        confident_invoices: int,
        marked_as_read: bool,
        invoice_ids: list[int],
        status: str = "success",
        error: str = None
    ) -> EmailProcessingLog:
        """Create processing log entry"""
        # Convert timezone-aware datetime to naive UTC datetime for database storage
        naive_email_date = None
        if email_date:
            if email_date.tzinfo is not None:
                # Convert to UTC and remove timezone info
                from datetime import timezone
                naive_email_date = email_date.astimezone(timezone.utc).replace(tzinfo=None)
            else:
                naive_email_date = email_date

        log = EmailProcessingLog(
            kitchen_id=self.kitchen_id,
            message_id=message_id,
            email_subject=email_subject[:500] if email_subject else None,
            email_from=email_from[:255] if email_from else None,
            email_date=naive_email_date,
            attachments_count=attachments_count,
            invoices_created=invoices_created,
            confident_invoices=confident_invoices,
            marked_as_read=marked_as_read,
            processing_status=status,
            error_message=error,
            invoice_ids=invoice_ids if invoice_ids else None
        )
        self.db.add(log)
        await self.db.commit()
        return log

    async def process_inbox(self) -> dict:
        """
        Main sync method - process all unread emails.

        Returns:
            dict with:
            - emails_checked: int
            - emails_processed: int
            - emails_skipped: int
            - attachments_processed: int
            - invoices_created: int
            - confident_invoices: int
            - emails_marked_read: int
            - errors: list[str]
        """
        settings = await self._get_settings()

        if not settings.imap_host or not settings.imap_password:
            raise ValueError("IMAP settings not configured")

        results = {
            "emails_checked": 0,
            "emails_processed": 0,
            "emails_skipped": 0,
            "attachments_processed": 0,
            "invoices_created": 0,
            "confident_invoices": 0,
            "emails_marked_read": 0,
            "errors": []
        }

        conn = None
        try:
            # Connect to IMAP in thread pool (blocking operation)
            conn = await asyncio.to_thread(self._connect_imap, settings)

            # Select folder
            folder = settings.imap_folder or "INBOX"
            status, _ = await asyncio.to_thread(conn.select, folder)
            if status != "OK":
                raise ValueError(f"Could not select folder: {folder}")

            # Search for unread emails
            status, messages = await asyncio.to_thread(conn.uid, 'SEARCH', None, 'UNSEEN')
            if status != "OK":
                raise ValueError("Could not search for unread emails")

            email_uids = messages[0].split()
            results["emails_checked"] = len(email_uids)

            for uid in email_uids:
                try:
                    # Fetch email
                    status, msg_data = await asyncio.to_thread(
                        conn.uid, 'FETCH', uid, '(RFC822)'
                    )
                    if status != "OK":
                        continue

                    raw_email = msg_data[0][1]
                    msg = email.message_from_bytes(raw_email)

                    # Extract metadata
                    message_id = self._get_message_id(msg)
                    email_subject = self._decode_header_value(msg.get('Subject', ''))
                    email_from = self._decode_header_value(msg.get('From', ''))

                    # Parse date
                    date_str = msg.get('Date')
                    email_date = None
                    if date_str:
                        try:
                            email_date = parsedate_to_datetime(date_str)
                        except Exception:
                            pass

                    # Check if already processed
                    if await self._is_already_processed(message_id):
                        results["emails_skipped"] += 1
                        continue

                    # Extract attachments
                    attachments = self._extract_attachments(msg)
                    if not attachments:
                        # No supported attachments - log and skip
                        await self._log_processing(
                            message_id=message_id,
                            email_subject=email_subject,
                            email_from=email_from,
                            email_date=email_date,
                            attachments_count=0,
                            invoices_created=0,
                            confident_invoices=0,
                            marked_as_read=False,
                            invoice_ids=[],
                            status="skipped",
                            error="No supported attachments found"
                        )
                        results["emails_skipped"] += 1
                        continue

                    # Process each attachment
                    attachment_results = []
                    invoice_ids = []

                    for filename, content, content_type in attachments:
                        try:
                            # Save attachment
                            file_path = await self._save_attachment(content, filename)

                            # Process through OCR
                            invoice_id, confidence = await self._process_attachment(
                                file_path, email_subject
                            )

                            attachment_results.append((invoice_id, confidence))
                            invoice_ids.append(invoice_id)
                            results["attachments_processed"] += 1
                            results["invoices_created"] += 1

                            # Count confident invoices
                            threshold = float(settings.imap_confidence_threshold or 0.5)
                            if confidence >= threshold:
                                results["confident_invoices"] += 1

                        except Exception as e:
                            logger.error(f"Failed to process attachment {filename}: {e}")
                            results["errors"].append(f"Attachment {filename}: {str(e)}")

                    # Determine if email should be marked as read
                    should_mark_read = await self._should_mark_read(attachment_results)
                    if should_mark_read:
                        await asyncio.to_thread(self._mark_email_read, conn, uid)
                        results["emails_marked_read"] += 1

                    # Log processing
                    await self._log_processing(
                        message_id=message_id,
                        email_subject=email_subject,
                        email_from=email_from,
                        email_date=email_date,
                        attachments_count=len(attachments),
                        invoices_created=len(invoice_ids),
                        confident_invoices=sum(1 for _, c in attachment_results if c >= float(settings.imap_confidence_threshold or 0.5)),
                        marked_as_read=should_mark_read,
                        invoice_ids=invoice_ids,
                        status="success"
                    )

                    results["emails_processed"] += 1

                except Exception as e:
                    logger.error(f"Failed to process email UID {uid}: {e}")
                    results["errors"].append(f"Email UID {uid}: {str(e)}")

            # Update last sync timestamp
            settings.imap_last_sync = datetime.utcnow()
            await self.db.commit()

        finally:
            if conn:
                try:
                    await asyncio.to_thread(conn.close)
                    await asyncio.to_thread(conn.logout)
                except Exception:
                    pass

        return results

    async def test_connection(self) -> dict:
        """
        Test IMAP connection and return folder list.
        Returns: {"success": True, "folders": [...]} or {"success": False, "error": "..."}
        """
        settings = await self._get_settings()

        if not settings.imap_host or not settings.imap_password:
            return {"success": False, "error": "IMAP settings not configured"}

        conn = None
        try:
            conn = await asyncio.to_thread(self._connect_imap, settings)

            # List folders
            status, folders_data = await asyncio.to_thread(conn.list)
            if status != "OK":
                return {"success": False, "error": "Could not list folders"}

            folders = []
            for folder_data in folders_data:
                if isinstance(folder_data, bytes):
                    # Parse folder name from response like: (\HasNoChildren) "/" "INBOX"
                    parts = folder_data.decode().split(' "')
                    if len(parts) >= 2:
                        folder_name = parts[-1].strip('"')
                        folders.append(folder_name)

            return {"success": True, "folders": folders}

        except imaplib.IMAP4.error as e:
            return {"success": False, "error": f"IMAP error: {str(e)}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
        finally:
            if conn:
                try:
                    await asyncio.to_thread(conn.logout)
                except Exception:
                    pass
