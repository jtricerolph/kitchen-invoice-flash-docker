# Kitchen Invoice Flash

OCR-powered invoice processing for kitchen GP (Gross Profit) estimation.

## Features

- **Invoice OCR**: Upload invoice photos, extract date, invoice number, total, and line items automatically
- **Azure Document Intelligence**: Uses Microsoft's pre-trained invoice model for accurate extraction
- **Multi-page Support**: Combine multiple photos into a single PDF with automatic compression
- **Supplier Management**: Track and manage suppliers with alias matching
- **Duplicate Detection**: Automatic detection of duplicate invoices
- **GP Calculator**: Track costs vs revenue to calculate gross profit
- **Multi-user**: Support for multiple kitchens with user authentication

## Requirements

- Docker
- Azure Document Intelligence resource (for OCR)

## Quick Start

1. Clone the repository:
```bash
git clone https://github.com/jtricerolph/kitchen-invoice-flash-docker.git
cd kitchen-invoice-flash-docker
```

2. Start the services:
```bash
docker-compose up -d
```

3. Access the app at `http://localhost`

4. Configure Azure credentials in Settings

## Configuration

Edit `docker-compose.yml` to configure:

- `JWT_SECRET`: Change to a secure random string for production
- `DATABASE_URL`: PostgreSQL connection string

Configure in the app Settings page:
- Azure Document Intelligence endpoint and API key

## Architecture

```
├── backend/          # FastAPI + Azure OCR
│   ├── api/          # REST endpoints
│   ├── auth/         # JWT authentication
│   ├── models/       # SQLAlchemy models
│   ├── ocr/          # Azure Document Intelligence
│   └── services/     # Business logic
├── frontend/         # React SPA
└── docker-compose.yml
```

## API Endpoints

- `POST /auth/register` - Create account
- `POST /auth/login` - Login
- `POST /api/invoices/upload` - Upload invoice image/PDF
- `GET /api/invoices/` - List invoices
- `PATCH /api/invoices/{id}` - Update invoice data
- `GET /api/invoices/{id}/ocr-data` - Get raw OCR data
- `POST /api/reports/gp` - Calculate GP for date range
- `GET /api/reports/dashboard` - Dashboard summary

## Development

### Backend (Python)
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

### Frontend (React)
```bash
cd frontend
npm install
npm run dev
```

## License

MIT
