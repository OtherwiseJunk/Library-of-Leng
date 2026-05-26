import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Archive,
  Camera,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  Search,
  Upload,
  XCircle
} from 'lucide-react';
import './styles.css';

const TABS = [
  { id: 'scan', label: 'Scan', icon: Camera },
  { id: 'failures', label: 'Fail Queue', icon: AlertTriangle },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'library', label: 'Library', icon: Archive }
];

const COLOR_OPTIONS = ['W', 'U', 'B', 'R', 'G'];
const BATCH_LOCATION_STORAGE_KEY = 'library-of-leng.batch-location';

function App() {
  const [activeTab, setActiveTab] = useState('scan');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">LoL</span>
          <div>
            <strong>Library of Leng</strong>
            <span>Inventory Scanner</span>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Main views">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={activeTab === tab.id ? 'active' : ''}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                title={tab.label}
              >
                <Icon size={19} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="main-panel">
        {activeTab === 'scan' && <ScanView />}
        {activeTab === 'failures' && <FailQueue />}
        {activeTab === 'search' && <SearchView />}
        {activeTab === 'library' && <LibraryView />}
      </main>
    </div>
  );
}

function ScanView() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [location, setLocation] = useState(() => localStorage.getItem(BATCH_LOCATION_STORAGE_KEY) || '');
  const [pending, setPending] = useState(false);
  const [recentScans, setRecentScans] = useState([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  useEffect(() => {
    localStorage.setItem(BATCH_LOCATION_STORAGE_KEY, location);
  }, [location]);

  useEffect(() => {
    const processingIds = recentScans
      .filter(scan => scan.status === 'processing')
      .map(scan => scan.id);

    if (processingIds.length === 0) {
      return undefined;
    }

    const timer = window.setInterval(async () => {
      const updated = await Promise.all(processingIds.map(id => api(`/api/scans/${id}`).catch(() => null)));
      setRecentScans(current =>
        current.map(scan => updated.find(item => item?.id === scan.id) || scan)
      );
    }, 1800);

    return () => window.clearInterval(timer);
  }, [recentScans]);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      setCameraReady(true);
    } catch (error) {
      setMessage(`Camera unavailable: ${error.message}`);
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach(track => track.stop());
  }

  async function captureAndUpload() {
    if (!videoRef.current || !location.trim()) {
      setMessage('Set a batch location before scanning.');
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
      if (!blob) {
        setMessage('Could not capture image.');
        return;
      }

      uploadImage(new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  }

  async function uploadImage(file) {
    const form = new FormData();
    form.append('image', file);
    form.append('target_location', location.trim());

    setPending(true);
    setMessage('');

    try {
      const response = await api('/api/scan', {
        method: 'POST',
        body: form
      });

      setRecentScans(current => [{ id: response.scanId, status: response.status }, ...current].slice(0, 8));
      setMessage(`Queued scan ${response.scanId}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="view">
      <Header title="Scan" subtitle="Capture cards quickly; OCR finishes in the background." />

      <div className="scan-grid">
        <div className="camera-panel">
          <video ref={videoRef} autoPlay muted playsInline className="camera-feed" />
          {!cameraReady && <div className="camera-placeholder">Camera preview</div>}
          <canvas ref={canvasRef} hidden />
        </div>

        <div className="control-panel">
          <label>
            Batch location
            <input
              value={location}
              onChange={event => setLocation(event.target.value)}
              placeholder="Box A, Row 1"
            />
          </label>
          <p className="field-hint">
            This exact string is saved with every card in the current batch.
          </p>

          <div className="button-row">
            <button className="primary" type="button" onClick={captureAndUpload} disabled={pending}>
              {pending ? <Loader2 className="spin" size={18} /> : <Camera size={18} />}
              Capture
            </button>

            <label className="file-button">
              <Upload size={18} />
              Upload
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={event => event.target.files?.[0] && uploadImage(event.target.files[0])}
              />
            </label>
          </div>

          {message && <p className="status-note">{message}</p>}

          <RecentScans scans={recentScans} />
        </div>
      </div>
    </section>
  );
}

function FailQueue() {
  const [failures, setFailures] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState('');

  async function loadFailures() {
    const response = await api('/api/failures');
    setFailures(response.scans || []);
  }

  useEffect(() => {
    loadFailures().catch(error => setMessage(error.message));
  }, []);

  async function retryFailure(scan, file) {
    const form = new FormData();
    form.append('image', file);
    form.append('target_location', scan.target_location);

    setBusyId(scan.id);
    setMessage(`Retrying scan ${scan.id} synchronously.`);

    try {
      const updated = await api(`/api/scans/${scan.id}/retry`, {
        method: 'POST',
        body: form
      });

      setFailures(current => current.filter(item => item.id !== updated.id));
      setMessage(updated.status === 'failed' ? updated.error_message : `Recovered ${updated.detected_card_name}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="view">
      <Header title="Fail Queue" subtitle="Find failed cards by location and rescan them with a blocking retry." />

      <div className="toolbar">
        <button type="button" onClick={() => loadFailures()} title="Refresh fail queue">
          <RefreshCcw size={18} />
          Refresh
        </button>
        {message && <span>{message}</span>}
      </div>

      <div className="list">
        {failures.map(scan => (
          <article className="row-card" key={scan.id}>
            <UploadedScanImage scan={scan} />
            <div>
              <span className="eyebrow">Scan {scan.id}</span>
              <h3>{scan.target_location}</h3>
              <p>{scan.error_message || 'OCR failed.'}</p>
            </div>
            <label className="file-button compact">
              {busyId === scan.id ? <Loader2 className="spin" size={17} /> : <Camera size={17} />}
              Rescan
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busyId === scan.id}
                onChange={event => event.target.files?.[0] && retryFailure(scan, event.target.files[0])}
              />
            </label>
          </article>
        ))}

        {failures.length === 0 && <EmptyState icon={CheckCircle2} text="No failed scans waiting." />}
      </div>
    </section>
  );
}

function SearchView() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const response = await api(`/api/search?q=${encodeURIComponent(query)}`);
    setResults(response.results || []);
    setSearched(true);
  }

  return (
    <section className="view">
      <Header title="Search" subtitle="Look up a card and jump straight to its warehouse location." />

      <form className="search-form" onSubmit={submit}>
        <Search size={19} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Lightning Bolt" />
        <button className="primary" type="submit">Search</button>
      </form>

      <div className="list">
        {results.map(card => <CardRow key={card.id} card={card} />)}
        {searched && results.length === 0 && <EmptyState icon={XCircle} text="No scanned cards matched that name." />}
      </div>
    </section>
  );
}

function LibraryView() {
  const [filters, setFilters] = useState({
    q: '',
    type: '',
    set: '',
    rarity: '',
    colors: []
  });
  const [cards, setCards] = useState([]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (Array.isArray(value) && value.length) params.set(key, value.join(','));
      if (!Array.isArray(value) && value) params.set(key, value);
    });
    return params.toString();
  }, [filters]);

  useEffect(() => {
    api(`/api/library?${queryString}`).then(response => setCards(response.cards || []));
  }, [queryString]);

  function toggleColor(color) {
    setFilters(current => ({
      ...current,
      colors: current.colors.includes(color)
        ? current.colors.filter(item => item !== color)
        : [...current.colors, color]
    }));
  }

  return (
    <section className="view">
      <Header title="Library" subtitle="Browse scanned cards with Scryfall-enriched fields." />

      <div className="filters">
        <input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} placeholder="Name" />
        <input value={filters.type} onChange={event => setFilters({ ...filters, type: event.target.value })} placeholder="Type line" />
        <input value={filters.set} onChange={event => setFilters({ ...filters, set: event.target.value })} placeholder="Set code" />
        <select value={filters.rarity} onChange={event => setFilters({ ...filters, rarity: event.target.value })}>
          <option value="">Any rarity</option>
          <option value="common">Common</option>
          <option value="uncommon">Uncommon</option>
          <option value="rare">Rare</option>
          <option value="mythic">Mythic</option>
        </select>
        <div className="color-filter" aria-label="Color identity">
          {COLOR_OPTIONS.map(color => (
            <button
              key={color}
              className={filters.colors.includes(color) ? 'selected' : ''}
              type="button"
              onClick={() => toggleColor(color)}
              title={`Filter ${color}`}
            >
              {color}
            </button>
          ))}
        </div>
      </div>

      <div className="card-grid">
        {cards.map(card => <LibraryCard key={card.id} card={card} />)}
      </div>
    </section>
  );
}

function RecentScans({ scans }) {
  if (scans.length === 0) {
    return null;
  }

  return (
    <div className="recent">
      <h2>Recent scans</h2>
      {scans.map(scan => (
        <div className="recent-row" key={scan.id}>
          <StatusIcon status={scan.status} />
          <span>#{scan.id}</span>
          <strong>{scan.detected_card_name || scan.status}</strong>
        </div>
      ))}
    </div>
  );
}

function CardRow({ card }) {
  return (
    <article className="row-card">
      <CardImage card={card} />
      <div>
        <span className="eyebrow">{card.set_code || 'unknown set'} {card.collector_number || ''}</span>
        <h3>{card.detected_card_name}</h3>
        <p>{card.card_type || 'No type metadata'} - {card.target_location}</p>
      </div>
    </article>
  );
}

function UploadedScanImage({ scan }) {
  return scan.uploaded_image_url
    ? <img className="scan-thumb" src={scan.uploaded_image_url} alt={`Failed scan ${scan.id}`} />
    : <div className="scan-thumb missing" aria-hidden="true" />;
}

function LibraryCard({ card }) {
  return (
    <article className="library-card">
      <CardImage card={card} />
      <div>
        <h3>{card.detected_card_name}</h3>
        <p>{card.card_type || 'Unknown type'}</p>
        <span>{card.target_location}</span>
      </div>
    </article>
  );
}

function CardImage({ card }) {
  return card.image_url
    ? <img className="card-thumb" src={card.image_url} alt={card.detected_card_name} />
    : <div className="card-thumb missing" aria-hidden="true" />;
}

function StatusIcon({ status }) {
  if (status === 'completed' || status === 'approved') return <CheckCircle2 className="ok" size={18} />;
  if (status === 'failed') return <XCircle className="bad" size={18} />;
  return <Loader2 className="spin" size={18} />;
}

function Header({ title, subtitle }) {
  return (
    <header className="view-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

function EmptyState({ icon: Icon, text }) {
  return (
    <div className="empty-state">
      <Icon size={28} />
      <span>{text}</span>
    </div>
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }

  return data;
}

createRoot(document.getElementById('root')).render(<App />);
