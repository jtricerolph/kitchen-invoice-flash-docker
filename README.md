# Kitchen Invoice Flash

OCR-powered invoice processing for kitchen GP (Gross Profit) estimation.

## Features

- **Invoice OCR**: Upload invoice photos, extract date, invoice number, and total automatically
- **GPU Accelerated**: Uses PaddleOCR with NVIDIA GPU support for fast processing
- **Supplier Templates**: Configure extraction patterns for regular suppliers
- **GP Calculator**: Track costs vs revenue to calculate gross profit
- **Multi-user**: Support for multiple kitchens with user authentication

## Requirements

- Docker with NVIDIA GPU support (nvidia-docker2)
- NVIDIA GPU with CUDA support (tested on P4000)

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

## Configuration

Edit `docker-compose.yml` to configure:

- `JWT_SECRET`: Change to a secure random string for production
- `DATABASE_URL`: PostgreSQL connection string
- GPU memory limits in the backend service

## Architecture

```
├── backend/          # FastAPI + PaddleOCR
│   ├── api/          # REST endpoints
│   ├── auth/         # JWT authentication
│   ├── models/       # SQLAlchemy models
│   ├── ocr/          # OCR engine & parsing
│   └── services/     # Business logic
├── frontend/         # React SPA
└── docker-compose.yml
```

## API Endpoints

- `POST /auth/register` - Create account
- `POST /auth/login` - Login
- `POST /api/invoices/upload` - Upload invoice image
- `GET /api/invoices/` - List invoices
- `PATCH /api/invoices/{id}` - Update invoice data
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
