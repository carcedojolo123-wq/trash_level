/* =========================================================================
   SMARTBIN CONFIG — edit these three lines to connect your Supabase project
   ========================================================================= */
const SUPABASE_URL      = "https://dxmamdzmvyorettjxtjz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4bWFtZHptdnlvcmV0dGp4dGp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3NDA1MzEsImV4cCI6MjEwMTMxNjUzMX0.kLMCXl39XoqJzxcm83c8rW_tr0mlsNE2QpjA7AxAIjY";
const TABLE_NAME        = "trash_level";   // table created by the SQL in setup

// --- timing knobs -----------------------------------------------------
const POLL_FALLBACK_MS       = 3000;   // used only if realtime can't connect
const REALTIME_GRACE_MS      = 3000;   // how long to wait for "SUBSCRIBED" before polling
const RECONNECT_RETRY_MS     = 8000;   // while polling, how often to retry the realtime channel
/* ========================================================================= */

const isConfigured = !SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
                      !SUPABASE_ANON_KEY.includes("YOUR-PUBLIC-ANON-KEY");

const els = {
  connDot: document.getElementById('connDot'),
  connText: document.getElementById('connText'),
  ring: document.getElementById('ringValue'),
  pctNum: document.getElementById('pctNum'),
  statusBadge: document.getElementById('statusBadge'),
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

/* ---------------------------------------------------------------------- */

let supabaseClient = null;
let pollTimer = null;
let reconnectTimer = null;
let realtimeChannel = null;
let isLive = false;

function applyRow(row){
  if (!row){
    renderGauge(null);
    return;
  }
  renderGauge(Number(row.trash_level));
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
  isLive = false;
  if (!pollTimer){
    setConnection('polling');
    pollTimer = setInterval(fetchLatest, POLL_FALLBACK_MS);
  }
  // keep trying to get back onto realtime instead of being stuck polling forever
  if (!reconnectTimer){
    reconnectTimer = setInterval(() => {
      if (!isLive) subscribeRealtime();
    }, RECONNECT_RETRY_MS);
  }
}

function stopPollingFallback(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  if (reconnectTimer){ clearInterval(reconnectTimer); reconnectTimer = null; }
}

function subscribeRealtime(){
  // avoid stacking duplicate channels on retry
  if (realtimeChannel){
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  realtimeChannel = supabaseClient
    .channel('smartbin-live-' + Date.now())
    .on('postgres_changes',
      // listen for INSERT (new reading rows) and UPDATE (in case the device
      // upserts a single row instead of inserting a new one each time)
      { event: '*', schema: 'public', table: TABLE_NAME },
      (payload) => applyRow(payload.new)
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED'){
        isLive = true;
        setConnection('live');
        stopPollingFallback();
        fetchLatest(); // catch up on anything missed while reconnecting
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
        isLive = false;
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
    return;
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  setConnection('connecting');
  await fetchLatest();
  subscribeRealtime();

  // safety net: if realtime never confirms quickly, fall back to polling
  setTimeout(() => {
    if (!isLive) startPollingFallback();
  }, REALTIME_GRACE_MS);

  // if the tab/phone was backgrounded, browsers throttle timers/sockets —
  // force an immediate refetch the moment it's foregrounded again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible'){
      fetchLatest();
      if (!isLive) subscribeRealtime();
    }
  });
}

init();
