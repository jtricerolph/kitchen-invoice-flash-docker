"""
Email service for sending invoices to Dext via SMTP.

This service handles:
- SMTP connection and authentication
- Sending HTML emails with attachments
- Testing SMTP configuration
- Generating formatted HTML emails for Dext submission
"""
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
import logging

logger = logging.getLogger(__name__)


class EmailService:
    """Service for sending emails via SMTP"""

    def __init__(self, settings):
        """Initialize email service with kitchen settings

        Args:
            settings: KitchenSettings object with SMTP configuration
        """
        self.host = settings.smtp_host
        self.port = settings.smtp_port
        self.username = settings.smtp_username
        self.password = settings.smtp_password
        self.use_tls = settings.smtp_use_tls
        self.from_email = settings.smtp_from_email
        self.from_name = settings.smtp_from_name or "Kitchen Invoice System"

    def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        attachments: list[tuple[str, bytes]] = None
    ) -> bool:
        """Send HTML email with optional attachments

        Args:
            to_email: Recipient email address
            subject: Email subject line
            html_body: HTML email body
            attachments: List of (filename, file_bytes) tuples

        Returns:
            True if sent successfully, False otherwise
        """
        try:
            msg = MIMEMultipart('mixed')
            msg['From'] = f"{self.from_name} <{self.from_email}>"
            msg['To'] = to_email
            msg['Subject'] = subject

            # Attach HTML body
            html_part = MIMEText(html_body, 'html')
            msg.attach(html_part)

            # Attach files
            if attachments:
                for filename, file_bytes in attachments:
                    attachment = MIMEApplication(file_bytes)
                    attachment.add_header(
                        'Content-Disposition',
                        'attachment',
                        filename=filename
                    )
                    msg.attach(attachment)

            # Connect and send
            # Port 465 uses implicit SSL, port 587 uses STARTTLS
            if self.port == 465:
                # Use SMTP_SSL for implicit SSL/TLS (port 465)
                with smtplib.SMTP_SSL(self.host, self.port, timeout=30) as server:
                    if self.username and self.password:
                        server.login(self.username, self.password)
                    server.send_message(msg)
            else:
                # Use SMTP with STARTTLS for port 587 or others
                with smtplib.SMTP(self.host, self.port, timeout=30) as server:
                    if self.use_tls:
                        server.starttls()
                    if self.username and self.password:
                        server.login(self.username, self.password)
                    server.send_message(msg)

            logger.info(f"Email sent to {to_email}: {subject}")
            return True

        except Exception as e:
            logger.error(f"Failed to send email: {e}")
            return False

    def test_connection(self) -> tuple[bool, str]:
        """Test SMTP connection and authentication

        Returns:
            (success, message) tuple
        """
        try:
            # Port 465 uses implicit SSL, port 587 uses STARTTLS
            if self.port == 465:
                # Use SMTP_SSL for implicit SSL/TLS (port 465)
                with smtplib.SMTP_SSL(self.host, self.port, timeout=10) as server:
                    server.ehlo()
                    if self.username and self.password:
                        server.login(self.username, self.password)
            else:
                # Use SMTP with STARTTLS for port 587 or others
                with smtplib.SMTP(self.host, self.port, timeout=10) as server:
                    server.ehlo()
                    if self.use_tls:
                        server.starttls()
                        server.ehlo()
                    if self.username and self.password:
                        server.login(self.username, self.password)
            return (True, "SMTP connection successful")
        except smtplib.SMTPAuthenticationError:
            return (False, "Authentication failed - check username/password")
        except smtplib.SMTPException as e:
            return (False, f"SMTP error: {str(e)}")
        except Exception as e:
            return (False, f"Connection error: {str(e)}")


def generate_dext_email_html(
    invoice,
    supplier_name: str,
    line_items: list,
    notes: str | None,
    include_notes: bool,
    include_non_stock: bool
) -> str:
    """Generate HTML email body for Dext submission

    Args:
        invoice: Invoice object with invoice_number, invoice_date, total
        supplier_name: Supplier name
        line_items: List of LineItem objects
        notes: Invoice notes
        include_notes: Whether to include notes section
        include_non_stock: Whether to include non-stock items table

    Returns:
        HTML string
    """
    # Invoice metadata
    html = f"""
    <html>
    <head>
        <style>
            body {{ font-family: Arial, sans-serif; color: #333; }}
            .header {{ background-color: #1a1a2e; color: white; padding: 20px; }}
            .content {{ padding: 20px; }}
            table {{ border-collapse: collapse; width: 100%; margin-top: 10px; }}
            th {{ background-color: #f2f2f2; padding: 8px; text-align: left; border: 1px solid #ddd; }}
            td {{ padding: 8px; border: 1px solid #ddd; }}
            .label {{ font-weight: bold; }}
            .notes {{ background-color: #fffbcc; padding: 10px; margin: 10px 0; border-left: 4px solid #ffcc00; }}
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Invoice Submission to Dext</h2>
        </div>
        <div class="content">
            <h3>Invoice Details</h3>
            <p><span class="label">Invoice Number:</span> {invoice.invoice_number or 'N/A'}</p>
            <p><span class="label">Supplier:</span> {supplier_name or 'Unknown'}</p>
            <p><span class="label">Date:</span> {invoice.invoice_date.strftime('%d/%m/%Y') if invoice.invoice_date else 'N/A'}</p>
            <p><span class="label">Total Amount:</span> £{(invoice.total if invoice.total else 0.0):.2f}</p>
    """

    # Notes section (if enabled and notes exist)
    if include_notes and notes:
        # Escape HTML in notes and convert newlines to <br>
        escaped_notes = notes.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        escaped_notes = escaped_notes.replace('\n', '<br>')
        html += f"""
            <div class="notes">
                <h4>Invoice Notes:</h4>
                <p>{escaped_notes}</p>
            </div>
        """

    # Non-stock items table (if enabled and non-stock items exist)
    if include_non_stock:
        non_stock_items = [item for item in line_items if item.is_non_stock]
        if non_stock_items:
            html += """
            <h4>Non-Stock Items:</h4>
            <table>
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Description</th>
                        <th>Qty</th>
                        <th>Unit Price</th>
                        <th>Amount</th>
                    </tr>
                </thead>
                <tbody>
            """
            for item in non_stock_items:
                html += f"""
                <tr>
                    <td>{item.product_code or ''}</td>
                    <td>{item.description or ''}</td>
                    <td>{item.quantity or ''}</td>
                    <td>£{(item.unit_price if item.unit_price else 0.0):.2f}</td>
                    <td>£{(item.amount if item.amount else 0.0):.2f}</td>
                </tr>
                """
            html += """
                </tbody>
            </table>
            """

    html += """
        </div>
    </body>
    </html>
    """
    return html
