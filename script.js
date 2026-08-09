/* =========================================================================
   SMARTBIN CONFIG — edit these three lines to connect your Supabase project
   ========================================================================= */
const SUPABASE_URL      = "https://dxmamdzmvyorettjxtjz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4bWFtZHptdnlvcmV0dGp4dGp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3NDA1MzEsImV4cCI6MjEwMTMxNjUzMX0.kLMCXl39XoqJzxcm83c8rW_tr0mlsNE2QpjA7AxAIjY";
const TABLE_NAME        = "trash_level";   // table created by the SQL in setup
const POLL_FALLBACK_MS   = 15000;                 // used only if realtime can't connect
const BIN_OFFLINE_AFTER_MS = 30000;               // no new reading in this window = bin considered offline
/* ========================================================================= */

const isConfigured = !SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
                      !SUPABASE_ANON_KEY.includes("YOUR-PUBLIC-ANON-KEY");

const els = {
  connDot: document.getElementById('connDot'),
  connText: document.getElementById('connText'),
  ring: document.getElementById('ringValue'),
  pctNum: document.getElementById('pctNum'),
  statusBadge: document.getElementById('statusBadge'),
  lidDot: document.getElementById('lidDot'),
  lidVal: document.getElementById('lidVal'),
  linkDot: document.getElementById('linkDot'),
  linkVal: document.getElementById('linkVal'),
  linkSub: document.getElementById('linkSub'),
  configBanner: document.getElementById('configBanner'),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 108;

function levelColor(pct){
  if (pct === null || pct === undefined) return 'var(--c-offline)';
  if (pct < 25) return 'var(--c-empty)';
  if (pct < 60) return 'var(--c-normal)';
  if (pct < 85) return 'var(--c-almost)';
  return 'var(--c-full)';
}

function levelStatus(pct){
  if (pct === null || pct === undefined) return 'waiting';
  if (pct < 10)  return 'empty';
  if (pct < 60)  return 'normal';
  if (pct < 85)  return 'almost full';
  return 'full';
}

function fmtTime(iso){
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month:'short', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
}

function setConnection(state){
  // state: 'connecting' | 'live' | 'polling' | 'error'
  els.connDot.className = 'conn-dot' + (state === 'live' ? ' live' : state === 'error' ? ' error' : '');
  els.connText.textContent = state;
}

function renderGauge(pct){
  const color = levelColor(pct);
  const clamped = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);

  els.ring.style.stroke = color;
  els.ring.style.strokeDashoffset = pct === null || pct === undefined ? RING_CIRCUMFERENCE : offset;

  els.pctNum.textContent = (pct === null || pct === undefined) ? '— —' : Math.round(pct);

  const status = levelStatus(pct);
  els.statusBadge.textContent = status;
  els.statusBadge.style.color = color;
  els.statusBadge.style.borderColor = color;
}

function renderLid(lidOpen){
  // lidOpen: true | false | null (unknown)
  if (lidOpen === null || lidOpen === undefined){
    els.lidDot.style.background = 'var(--c-offline)';
    els.lidVal.textContent = '—';
    els.lidVal.style.color = 'var(--text-muted)';
    return;
  }
  const color = lidOpen ? 'var(--c-almost)' : 'var(--c-empty)';
  els.lidDot.style.background = color;
  els.lidVal.textContent = lidOpen ? 'open' : 'closed';
  els.lidVal.style.color = color;
}

function renderBinLink(online, lastSeenAt){
  // online: true | false | null (no data yet)
  if (online === null){
    els.linkDot.className = 'status-tile-dot';
    els.linkDot.style.background = 'var(--c-offline)';
    els.linkVal.textContent = '—';
    els.linkVal.style.color = 'var(--text-muted)';
    els.linkSub.textContent = 'waiting for data';
    return;
  }
  const color = online ? 'var(--c-empty)' : 'var(--c-full)';
  els.linkDot.className = 'status-tile-dot' + (online ? ' pulse' : '');
  els.linkDot.style.background = color;
  els.linkVal.textContent = online ? 'online' : 'offline';
  els.linkVal.style.color = color;
  els.linkSub.textContent = lastSeenAt ? `last seen ${fmtRelative(lastSeenAt)}` : '';
}

function fmtRelative(iso){
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

/* ---------------------------------------------------------------------- */

let supabaseClient = null;
let pollTimer = null;
let lastSeenAt = null;

function isLidOpen(row){
  if (!row) return null;
  if (typeof row.lid_open === 'boolean') return row.lid_open;
  if (typeof row.lid_status === 'string') return row.lid_status.toLowerCase() === 'open';
  return null;
}

function applyRow(row){
  if (!row){
    renderGauge(null);
    renderLid(null);
    return;
  }
  renderGauge(Number(row.trash_level));
  renderLid(isLidOpen(row));
  lastSeenAt = row.created_at;
  refreshBinLink();
}

function refreshBinLink(){
  if (!lastSeenAt){
    renderBinLink(null, null);
    return;
  }
  const elapsed = Date.now() - new Date(lastSeenAt).getTime();
  renderBinLink(elapsed <= BIN_OFFLINE_AFTER_MS, lastSeenAt);
}

async function fetchLatest(){
  const { data, error } = await supabaseClient
    .from(TABLE_NAME)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error){
    console.error('Supabase fetch error:', error);
    setConnection('error');
    return;
  }

  applyRow(data[0] || null);
}

function startPollingFallback(){
  if (pollTimer) return;
  setConnection('polling');
  pollTimer = setInterval(fetchLatest, POLL_FALLBACK_MS);
}

function subscribeRealtime(){
  const channel = supabaseClient
    .channel('smartbin-live')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: TABLE_NAME },
      (payload) => applyRow(payload.new)
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED'){
        setConnection('live');
        if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
        startPollingFallback();
      }
    });
}

async function init(){
  if (!isConfigured){
    els.configBanner.style.display = 'block';
    setConnection('error');
    els.connText.textContent = 'not configured';
    renderGauge(null);
    renderLid(null);
    renderBinLink(null, null);
    return;
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  setConnection('connecting');
  await fetchLatest();
  subscribeRealtime();

  // safety net: if realtime never confirms within 6s, fall back to polling
  setTimeout(() => {
    if (els.connText.textContent === 'connecting') startPollingFallback();
  }, 6000);

  // re-evaluate bin online/offline continuously, since it's time-based
  setInterval(refreshBinLink, 5000);
}

init();
