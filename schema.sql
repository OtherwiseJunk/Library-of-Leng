CREATE TABLE IF NOT EXISTS scans (
  id BIGSERIAL PRIMARY KEY,
  image_path TEXT NOT NULL,
  target_location TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'approved')),
  detected_card_name TEXT,
  confidence_score DOUBLE PRECISION,
  error_message TEXT,
  scryfall_id TEXT,
  set_code TEXT,
  set_name TEXT,
  collector_number TEXT,
  rarity TEXT,
  mana_cost TEXT,
  card_type TEXT,
  oracle_text TEXT,
  colors TEXT[] NOT NULL DEFAULT '{}',
  color_identity TEXT[] NOT NULL DEFAULT '{}',
  image_url TEXT,
  scryfall_uri TEXT,
  card_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS scans_status_idx ON scans (status);
CREATE INDEX IF NOT EXISTS scans_target_location_idx ON scans (target_location);
CREATE INDEX IF NOT EXISTS scans_detected_card_name_idx ON scans USING GIN (to_tsvector('english', COALESCE(detected_card_name, '')));
CREATE INDEX IF NOT EXISTS scans_card_type_idx ON scans USING GIN (to_tsvector('english', COALESCE(card_type, '')));
CREATE INDEX IF NOT EXISTS scans_colors_idx ON scans USING GIN (colors);
CREATE INDEX IF NOT EXISTS scans_color_identity_idx ON scans USING GIN (color_identity);
CREATE INDEX IF NOT EXISTS scans_set_code_idx ON scans (set_code);
