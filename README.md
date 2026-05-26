# Library of Leng MTG Scanner

React + Express + PostgreSQL staging pipeline for scanning Magic cards with `mtgscan`.

## Run With Docker

1. Create `.env` from `.env.example`.
2. Start the stack:

```sh
docker compose up --build
```

Open the UI at `http://localhost:8080`.

The default OCR provider is local PaddleOCR on CPU. To use Azure instead, set:

```sh
OCR_PROVIDER=azure
AZURE_VISION_KEY=...
AZURE_VISION_ENDPOINT=...
```

## GPU PaddleOCR

The GPU path assumes the Docker host is Linux with a working NVIDIA driver and NVIDIA Container Toolkit. First verify this on the host:

```sh
nvidia-smi
docker run --rm --gpus all nvidia/cuda:11.8.0-base-ubuntu22.04 nvidia-smi
```

Then run the GPU server image:

```sh
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

The GPU image uses CUDA 11.8 and installs `paddlepaddle-gpu` from PaddlePaddle's CUDA 11.8 package index. This is a good fit for a GTX 1080-era host while keeping the normal CPU image simpler.

Relevant OCR settings:

- `OCR_PROVIDER=paddle` or `azure`
- `PADDLE_DEVICE=cpu` or `gpu:0`
- `PADDLE_USE_GPU=false` or `true`
- `PADDLE_OCR_LANG=en`

Services:

- `frontend`: React app served by nginx.
- `server`: Express API plus Python `mtgscan` wrapper.
- `postgres`: PostgreSQL 18 database initialized from `schema.sql`.

## API Surface

- `POST /api/scan`: async upload, returns `202` with `scanId`.
- `POST /api/scan/sync`: upload and wait for OCR completion.
- `POST /api/scans/:id/retry`: synchronous retry for a failed scan.
- `GET /api/scans/:id`: scan detail.
- `GET /api/failures`: failed scans with warehouse locations.
- `GET /api/search?q=NAME`: completed or approved scans by card name.
- `GET /api/library`: completed or approved scans with filters.

Library filters:

- `q`
- `type`
- `set`
- `rarity`
- `colors`, comma-separated color identity like `W,U`

## Local Development

### Dev Container

Open this folder in VS Code and choose `Dev Containers: Reopen in Container`.

The dev container starts a workspace container plus PostgreSQL 18, installs Node and Python dependencies, and forwards:

- `3000`: Express API
- `5173`: Vite React UI
- `5432`: PostgreSQL

Inside the dev container, start the API:

```sh
npm run dev
```

In another terminal, start the frontend:

```sh
npm run dev --prefix frontend
```

Open the dev UI at `http://localhost:5173`.

## Troubleshooting

If OCR fails with `libGL.so.1: cannot open shared object file`, rebuild the server image after pulling the latest Dockerfile changes:

```sh
docker compose -f docker-compose.yml -f docker-compose.gpu.yml build server
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

### Host Machine

The root package runs the API. The `frontend/` package runs Vite.

```sh
npm install
pip3 install -r requirements.txt
npm run dev
```

In another shell:

```sh
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:3000`.
