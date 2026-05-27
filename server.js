require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const pythonBin = process.env.PYTHON_BIN || 'python3';
const scanScriptPath = path.resolve(process.env.SCAN_SCRIPT_PATH || 'scan.py');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
}

fs.mkdirSync(uploadDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname || '').toLowerCase();
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed.'));
    }

    cb(null, true);
  }
});

app.use(express.json());
app.use('/uploads', express.static(uploadDir));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/scan', upload.single('image'), async (req, res, next) => {
  try {
    const scan = await createProcessingScan(req);

    res.status(202).json({
      scanId: scan.id,
      status: scan.status
    });

    runScan(scan.id, scan.image_path).catch(error => {
      console.error(`Background scan ${scan.id} crashed:`, error);
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan/sync', upload.single('image'), async (req, res, next) => {
  try {
    const scan = await createProcessingScan(req);
    const completed = await runScan(scan.id, scan.image_path);

    res.status(201).json(completed);
  } catch (error) {
    next(error);
  }
});

app.post('/api/scans/:id/retry', upload.single('image'), async (req, res, next) => {
  const targetLocation = req.body.location || req.body.target_location;

  if (!req.file) {
    return res.status(400).json({ error: 'Missing image file field named "image".' });
  }

  try {
    const existing = await pool.query('SELECT * FROM scans WHERE id = $1', [req.params.id]);

    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Scan not found.' });
    }

    const imagePath = path.resolve(req.file.path);

    await pool.query(
      `UPDATE scans
       SET image_path = $1,
           target_location = COALESCE($2, target_location),
           status = 'processing',
           detected_card_name = NULL,
           confidence_score = NULL,
           error_message = NULL,
           scryfall_id = NULL,
           set_code = NULL,
           set_name = NULL,
           collector_number = NULL,
           rarity = NULL,
           mana_cost = NULL,
           card_type = NULL,
           oracle_text = NULL,
           colors = '{}',
           color_identity = '{}',
           image_url = NULL,
           scryfall_uri = NULL,
           card_metadata = NULL,
           updated_at = NOW()
       WHERE id = $3`,
      [imagePath, targetLocation || null, req.params.id]
    );

    const completed = await runScan(req.params.id, imagePath);
    res.status(200).json(completed);
  } catch (error) {
    next(error);
  }
});

app.get('/api/scan/:id', getScanById);
app.get('/api/scans/:id', getScanById);

app.get('/api/failures', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM scans
       WHERE status = 'failed'
       ORDER BY updated_at DESC
       LIMIT 100`
    );

    res.json({ scans: result.rows.map(serializeScan) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || req.query.name || '').trim();

    if (!q) {
      return res.status(400).json({ error: 'Missing q query parameter.' });
    }

    const result = await pool.query(
      `SELECT *
       FROM scans
       WHERE status IN ('completed', 'approved')
         AND detected_card_name ILIKE $1
       ORDER BY detected_card_name ASC, updated_at DESC
       LIMIT 50`,
      [`%${q}%`]
    );

    res.json({ results: result.rows.map(serializeScan) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/library', async (req, res, next) => {
  try {
    const filters = buildLibraryFilters(req.query);
    const requestedLimit = Number(req.query.limit || 200);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 200;
    const result = await pool.query(
      `SELECT *
       FROM scans
       WHERE status IN ('completed', 'approved')
       ${filters.where}
       ORDER BY detected_card_name ASC, updated_at DESC
       LIMIT $${filters.values.length + 1}`,
      [...filters.values, limit]
    );

    res.json({ cards: result.rows.map(serializeScan) });
  } catch (error) {
    next(error);
  }
});

async function createProcessingScan(req) {
  const targetLocation = req.body.location || req.body.target_location;

  if (!req.file) {
    const error = new Error('Missing image file field named "image".');
    error.statusCode = 400;
    throw error;
  }

  if (!targetLocation) {
    const error = new Error('Missing target location.');
    error.statusCode = 400;
    throw error;
  }

  const imagePath = path.resolve(req.file.path);
  const result = await pool.query(
    `INSERT INTO scans (image_path, target_location, status)
     VALUES ($1, $2, 'processing')
     RETURNING *`,
    [imagePath, targetLocation]
  );

  return result.rows[0];
}

async function getScanById(req, res, next) {
  try {
    const scan = await loadScan(req.params.id);

    if (!scan) {
      return res.status(404).json({ error: 'Scan not found.' });
    }

    res.json(serializeScan(scan));
  } catch (error) {
    next(error);
  }
}

function buildLibraryFilters(query) {
  const clauses = [];
  const values = [];

  if (query.q) {
    values.push(`%${query.q}%`);
    clauses.push(`detected_card_name ILIKE $${values.length}`);
  }

  if (query.type) {
    values.push(`%${query.type}%`);
    clauses.push(`card_type ILIKE $${values.length}`);
  }

  if (query.set) {
    values.push(String(query.set).toLowerCase());
    clauses.push(`LOWER(set_code) = $${values.length}`);
  }

  if (query.rarity) {
    values.push(String(query.rarity).toLowerCase());
    clauses.push(`LOWER(rarity) = $${values.length}`);
  }

  const colors = normalizeList(query.colors);
  if (colors.length > 0) {
    values.push(colors);
    clauses.push(`color_identity @> $${values.length}::text[]`);
  }

  return {
    where: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '',
    values
  };
}

function normalizeList(value) {
  if (!value) {
    return [];
  }

  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(item => item.trim().toUpperCase()).filter(Boolean);
}

async function runScan(scanId, imagePath) {
  try {
    const parsed = await runPythonScan(imagePath);

    if (parsed.error) {
      return markScanFailed(scanId, parsed.error);
    }

    const card = parsed.detected_card_name || null;
    const scryfall = card ? await fetchScryfallCard(card) : null;
    const metadata = mapScryfallCard(scryfall);

    await pool.query(
      `UPDATE scans
       SET status = 'completed',
           detected_card_name = $1,
           confidence_score = $2,
           error_message = NULL,
           scryfall_id = $3,
           set_code = $4,
           set_name = $5,
           collector_number = $6,
           rarity = $7,
           mana_cost = $8,
           card_type = $9,
           oracle_text = $10,
           colors = $11,
           color_identity = $12,
           image_url = $13,
           scryfall_uri = $14,
           card_metadata = $15,
           updated_at = NOW()
       WHERE id = $16`,
      [
        metadata.name || card,
        parsed.confidence_score ?? null,
        metadata.id,
        metadata.set,
        metadata.set_name,
        metadata.collector_number,
        metadata.rarity,
        metadata.mana_cost,
        metadata.type_line,
        metadata.oracle_text,
        metadata.colors,
        metadata.color_identity,
        metadata.image_url,
        metadata.scryfall_uri,
        metadata.raw,
        scanId
      ]
    );

    return loadScan(scanId);
  } catch (error) {
    return markScanFailed(scanId, error.message);
  }
}

function runPythonScan(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scanScriptPath, imagePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', code => {
      let parsed = null;

      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        const lastStderrLine = stderr
          .split('\n')
          .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
          .filter(Boolean)
          .pop() || '';
        const message = lastStderrLine || stdout.trim() || error.message;
        reject(new Error(`scan.py failed: ${message}`));
        return;
      }

      if (code !== 0 && !parsed.error) {
        reject(new Error(stderr.trim() || `scan.py exited with code ${code}`));
        return;
      }

      resolve(parsed);
    });
  });
}

async function fetchScryfallCard(cardName) {
  try {
    const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cardName)}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'mtg-inventory-scanner/1.0'
      }
    });

    if (!response.ok) {
      console.warn(`Scryfall lookup failed for "${cardName}" with ${response.status}`);
      return null;
    }

    return response.json();
  } catch (error) {
    console.warn(`Scryfall lookup failed for "${cardName}": ${error.message}`);
    return null;
  }
}

function mapScryfallCard(card) {
  if (!card) {
    return {
      id: null,
      name: null,
      set: null,
      set_name: null,
      collector_number: null,
      rarity: null,
      mana_cost: null,
      type_line: null,
      oracle_text: null,
      colors: [],
      color_identity: [],
      image_url: null,
      scryfall_uri: null,
      raw: null
    };
  }

  const face = card.card_faces?.[0] || {};

  return {
    id: card.id || null,
    name: card.name || null,
    set: card.set || null,
    set_name: card.set_name || null,
    collector_number: card.collector_number || null,
    rarity: card.rarity || null,
    mana_cost: card.mana_cost || face.mana_cost || null,
    type_line: card.type_line || face.type_line || null,
    oracle_text: card.oracle_text || face.oracle_text || null,
    colors: card.colors || face.colors || [],
    color_identity: card.color_identity || [],
    image_url: card.image_uris?.normal || face.image_uris?.normal || null,
    scryfall_uri: card.scryfall_uri || null,
    raw: card
  };
}

async function loadScan(scanId) {
  const result = await pool.query('SELECT * FROM scans WHERE id = $1', [scanId]);
  return result.rows[0] || null;
}

function serializeScan(scan) {
  if (!scan) {
    return scan;
  }

  return {
    ...scan,
    image_url: scan.image_url,
    uploaded_image_url: uploadedImageUrl(scan.image_path)
  };
}

function uploadedImageUrl(imagePath) {
  if (!imagePath) {
    return null;
  }

  const resolvedPath = path.resolve(imagePath);
  const relativePath = path.relative(uploadDir, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return `/uploads/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

async function markScanFailed(scanId, message) {
  const errorMessage = String(message || 'Unknown scan failure').slice(0, 8000);

  console.error(`Scan ${scanId} failed: ${errorMessage}`);

  await pool.query(
    `UPDATE scans
     SET status = 'failed',
         error_message = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [errorMessage, scanId]
  );

  return loadScan(scanId);
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error.' });
});

app.listen(port, () => {
  console.log(`MTG scanner API listening on port ${port}`);
});
