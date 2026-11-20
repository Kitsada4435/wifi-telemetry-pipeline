// RSSI Web Logger - 100% Mobile-Optimized Telemetry Controller
document.addEventListener('DOMContentLoaded', () => {

  // 1. Deterministic Hardware-Tied Device Fingerprint (Never changes on the same phone)
  function getHardwareFingerprint() {
    const screenInfo = `${screen.width}x${screen.height}x${screen.colorDepth}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Bangkok';
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isAndroid = /android/i.test(ua);
    const prefix = isIOS ? 'IOS' : (isAndroid ? 'AND' : 'DEV');

    // Deterministic 32-bit hash based strictly on hardware specs
    const raw = `${screenInfo}|${tz}|${navigator.hardwareConcurrency || 4}|${isIOS ? 'apple' : 'generic'}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash) + raw.charCodeAt(i);
      hash |= 0;
    }
    const hex = Math.abs(hash).toString(36).toUpperCase().padStart(4, '0').slice(-4);
    return `${prefix}-${hex}`;
  }

  // Helper: Haversine Great-Circle Distance (in meters)
  function calcHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // Student ID / UserID Validation Helper
  function isStudentIdValid(id) {
    if (!id) return false;
    const clean = String(id).trim();
    if (clean.length < 4) return false;
    const lower = clean.toLowerCase();
    if (lower === 'unknown' || lower === 'usr-anon') return false;
    if (/^(ios|and|dev)-[0-9a-z]{4}$/i.test(clean)) return false;
    return true;
  }

  // Cookie helpers for 10-year persistence
  function setCookie(name, val) {
    document.cookie = `${name}=${encodeURIComponent(val)}; path=/; max-age=315360000; SameSite=Lax`;
  }

  function getCookie(name) {
    const matches = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
    return matches ? decodeURIComponent(matches[1]) : null;
  }

  // 2. Initialize Permanent Participant UserID
  function initParticipantId() {
    // 1. Check URL query parameters (?id=... or ?participant_id=...)
    const urlParams = new URLSearchParams(window.location.search);
    const urlId = urlParams.get('id') || urlParams.get('participant_id');
    if (urlId && urlId.trim()) {
      const clean = urlId.trim();
      localStorage.setItem('rssi_participant_id', clean);
      if (isStudentIdValid(clean)) {
        localStorage.setItem('rssi_student_id_configured', 'true');
      }
      setCookie('rssi_participant_id', clean);
      return clean;
    }

    // 2. Check localStorage
    const savedLocal = localStorage.getItem('rssi_participant_id');
    if (savedLocal && savedLocal.trim() && isStudentIdValid(savedLocal.trim())) {
      return savedLocal.trim();
    }

    // 3. Check Cookie
    const savedCookie = getCookie('rssi_participant_id');
    if (savedCookie && savedCookie.trim() && isStudentIdValid(savedCookie.trim())) {
      localStorage.setItem('rssi_participant_id', savedCookie.trim());
      return savedCookie.trim();
    }

    // 4. Fallback if previously saved non-student ID
    if (savedLocal && savedLocal.trim()) {
      return savedLocal.trim();
    }

    return '';
  }

  // Application State
  const state = {
    isRecording: false,
    startTime: null,
    timerInterval: null,
    tripId: 'IDLE',
    participantId: initParticipantId(),
    tripNote: localStorage.getItem('rssi_trip_note') || '',
    gdriveWebhook: localStorage.getItem('rssi_gdrive_webhook') || 'https://script.google.com/macros/s/AKfycbzvkcibz8OjhTj8pgQE2BhkNy3S6cSEt9OlDFdfJ261-CFzpHX6pSU66IeEtqkh9Q7e/exec',
    autoSyncGdrive: localStorage.getItem('rssi_autosync_gdrive') !== 'false',
    selectedMode: 'walk',
    phonePosition: 'pocket',
    predictedMode: 'still',
    platform: 'ios',
    deviceModel: 'Apple iPhone',
    osVersion: 'iOS 18.1',
    imu: { accelX: '', accelY: '', accelZ: '', gyroX: '', gyroY: '', gyroZ: '' },
    currentLocation: null,
    lastGeoTime: 0,
    watchId: null,
    wakeLock: null,
    lastTelemetryTime: null,
    watchdogInterval: null,
    offlineHeartbeatInterval: null,
    logs: []
  };

  const ACTIVE_TRIP_KEY = 'rssi_active_trip_v2';
  const PENDING_QUEUE_KEY = 'rssi_pending_uploads_v1';
  const LAST_COMPLETED_NOTE_KEY = 'rssi_last_completed_note';
  const GPS_STALE_MS = 10000; // 10s max age for valid live GPS

  function isGpsFresh() {
    return Boolean(state.currentLocation && state.lastGeoTime > 0 && (Date.now() - state.lastGeoTime) <= GPS_STALE_MS);
  }

  function playModeTone(mode) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = mode === 'moto' ? 990 : 660;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); ctx.close(); } catch (e) {} }, 140);
    } catch (e) {}
    if ('vibrate' in navigator) {
      try { navigator.vibrate(mode === 'moto' ? [45, 30, 45] : 40); } catch (e) {}
    }
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function saveActiveTrip() {
    if (!state.isRecording) return;
    try {
      localStorage.setItem(ACTIVE_TRIP_KEY, JSON.stringify({
        isRecording: state.isRecording,
        tripId: state.tripId,
        startTime: state.startTime,
        selectedMode: state.selectedMode,
        phonePosition: state.phonePosition,
        tripNote: state.tripNote,
        lastProcessedTime: lastProcessedTime,
        logs: state.logs
      }));
    } catch (e) {
      console.warn('localStorage save warning:', e.message);
    }
  }

  function clearActiveTripStorage() {
    try { localStorage.removeItem(ACTIVE_TRIP_KEY); } catch (e) {}
  }

  // Offline Pending-Upload Queue (Zero lost trips when stopping in weak-Wi-Fi parking lots)
  function getPendingQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_QUEUE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function setPendingQueue(queue) {
    try {
      localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(queue));
      updatePendingQueueUI();
      return true;
    } catch (e) {
      console.warn('Pending queue quota error:', e.message);
      showSyncToast('error', 'พื้นที่เครื่องเต็ม! กรุณากด "โหลด CSV" สำรองไว้ทันที');
      return false;
    }
  }

  function enqueuePendingTrip(tripObj) {
    const q = getPendingQueue().filter(item => item.tripId !== tripObj.tripId);
    q.push(tripObj);
    return setPendingQueue(q);
  }

  function removePendingTrip(tripId) {
    const q = getPendingQueue().filter(item => item.tripId !== tripId);
    setPendingQueue(q);
  }

  function updatePendingQueueUI() {
    const q = getPendingQueue();
    if (!el.pendingQueueBanner || !el.pendingQueueText) return;
    if (q.length > 0) {
      el.pendingQueueBanner.style.display = 'flex';
      el.pendingQueueText.textContent = `ค้างส่ง ${q.length} ทริป (${q.map(x => x.note || x.tripId).join(', ')}) — แตะส่งเข้า Drive`;
    } else {
      el.pendingQueueBanner.style.display = 'none';
    }
  }

  // DOM Elements
  const el = {
    connPill: document.getElementById('connection-pill'),
    connText: document.getElementById('connection-text'),
    wakelockPill: document.getElementById('wakelock-pill'),
    wakelockText: document.getElementById('wakelock-text'),
    healthWifi: document.getElementById('health-wifi'),
    healthGps: document.getElementById('health-gps'),
    healthMode: document.getElementById('health-mode'),
    pendingQueueBanner: document.getElementById('pending-queue-banner'),
    pendingQueueText: document.getElementById('pending-queue-text'),
    noteStatusBadge: document.getElementById('note-status-badge'),
    tripTimer: document.getElementById('trip-timer'),
    tripIdBadge: document.getElementById('trip-id-badge'),
    btnStart: document.getElementById('btn-start-trip'),
    btnStop: document.getElementById('btn-stop-trip'),
    btnExport: document.getElementById('btn-export-csv'),
    btnSyncGdrive: document.getElementById('btn-sync-gdrive'),
    btnSimulate: document.getElementById('btn-simulate-ping'),
    btnClear: document.getElementById('btn-clear-data'),
    currentRssi: document.getElementById('current-rssi'),
    signalTag: document.getElementById('signal-level-tag'),
    currentSsid: document.getElementById('current-ssid'),
    currentBssid: document.getElementById('current-bssid'),
    gpsCoords: document.getElementById('gps-coords'),
    gpsSpeed: document.getElementById('gps-speed'),
    predictedModeVal: document.getElementById('predicted-mode-val'),
    totalSamples: document.getElementById('total-samples'),
    avgRssi: document.getElementById('avg-rssi'),
    participantInput: document.getElementById('participant-id-input'),
    tripNoteInput: document.getElementById('trip-note-input'),
    idSavedBadge: document.getElementById('id-saved-badge'),
    btnCopyId: document.getElementById('btn-copy-id'),
    btnResetHwId: document.getElementById('btn-reset-hw-id'),
    gdriveWebhookInput: document.getElementById('gdrive-webhook-input'),
    gdriveStatusBadge: document.getElementById('gdrive-status-badge'),
    gdriveAutoSyncChk: document.getElementById('gdrive-autosync-chk'),
    serverUrlDisplay: document.getElementById('server-url-display'),
    btnCopyUrl: document.getElementById('btn-copy-url'),
    syncToast: document.getElementById('sync-toast'),
    syncToastIcon: document.getElementById('sync-toast-icon'),
    syncToastText: document.getElementById('sync-toast-text'),
    watchdogAlert: document.getElementById('watchdog-alert'),
    modeBtns: document.querySelectorAll('.mode-chip'),
    posBtns: document.querySelectorAll('.pos-chip')
  };

  function updateHealthStrip() {
    const now = Date.now();
    // 1. Wi-Fi freshness
    if (el.healthWifi) {
      if (!state.lastTelemetryTime) {
        el.healthWifi.textContent = '📶 Wi-Fi: รอ...';
        el.healthWifi.className = 'health-pill';
      } else {
        const wAge = Math.floor((now - state.lastTelemetryTime) / 1000);
        if (wAge <= 6) {
          el.healthWifi.textContent = `📶 Wi-Fi: ${wAge}s`;
          el.healthWifi.className = 'health-pill health-ok';
        } else if (wAge <= 20) {
          el.healthWifi.textContent = `📶 Wi-Fi: ${wAge}s`;
          el.healthWifi.className = 'health-pill health-warn';
        } else {
          el.healthWifi.textContent = `📶 หลุด ${wAge}s`;
          el.healthWifi.className = 'health-pill health-bad';
        }
      }
    }
    // 2. GPS freshness (tappable to wake GPS!)
    if (el.healthGps) {
      if (!state.lastGeoTime) {
        el.healthGps.textContent = '📍 GPS: รอ...';
        el.healthGps.className = 'health-pill health-btn health-warn';
      } else {
        const gAge = Math.floor((now - state.lastGeoTime) / 1000);
        if (gAge <= 6) {
          el.healthGps.textContent = `📍 GPS: ${gAge}s`;
          el.healthGps.className = 'health-pill health-btn health-ok';
        } else if (gAge <= 10) {
          el.healthGps.textContent = `📍 GPS: ${gAge}s`;
          el.healthGps.className = 'health-pill health-btn health-warn';
        } else {
          el.healthGps.textContent = `🔄 GPS ค้าง ${gAge}s`;
          el.healthGps.className = 'health-pill health-btn health-bad';
        }
      }
    }
    // 3. Active Mode badge
    if (el.healthMode) {
      if (state.selectedMode === 'moto') {
        el.healthMode.textContent = '🛵 MOTO';
        el.healthMode.className = 'health-pill health-mode-moto';
      } else {
        el.healthMode.textContent = '🚶 WALK';
        el.healthMode.className = 'health-pill health-mode-walk';
      }
    }
  }

  function updateNoteStatusBadge() {
    if (!el.noteStatusBadge) return;
    const note = (state.tripNote || '').trim();
    const lastNote = localStorage.getItem(LAST_COMPLETED_NOTE_KEY) || '';
    if (!note) {
      el.noteStatusBadge.textContent = '⚠️ ยังไม่ได้ใส่รหัสทริป';
      el.noteStatusBadge.style.color = '#f59e0b';
    } else if (lastNote && note === lastNote) {
      el.noteStatusBadge.textContent = '⚠️ ซ้ำกับทริปล่าสุด!';
      el.noteStatusBadge.style.color = '#f43f5e';
    } else {
      el.noteStatusBadge.textContent = '✓ พร้อมบันทึก';
      el.noteStatusBadge.style.color = '#10b981';
    }
  }

  // 3. Screen Keep-Awake (WakeLock API for iOS & Android)
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        if (el.wakelockPill) {
          el.wakelockPill.style.display = 'inline-flex';
          el.wakelockText.textContent = 'Awake';
        }
      } catch (err) {
        console.warn('Wake Lock error:', err.message);
      }
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock !== null) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  // Auto-restore WakeLock + Wake GPS + Poll on returning to Safari tab!
  async function handleResumeForeground() {
    if (document.visibilityState === 'visible') {
      if (state.isRecording) {
        await requestWakeLock();
      }
      if (!isGpsFresh()) {
        startGeoTracking(true);
      }
      pollTelemetry();
    }
  }
  document.addEventListener('visibilitychange', handleResumeForeground);
  window.addEventListener('pageshow', handleResumeForeground);

  // Warn before accidentally closing/reloading Safari tab mid-trip
  window.addEventListener('beforeunload', (e) => {
    if (state.isRecording) {
      saveActiveTrip();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // 4. Motion / Activity Recognition UI
  function updatePredictedModeUI() {
    if (el.predictedModeVal) {
      const modeIcons = {
        still: '🛑 นิ่ง (STILL)',
        walk: '🚶 เดิน (WALK)',
        run: '🏃 วิ่ง (RUN)',
        vehicle: '🚗 รถ (VEHICLE)'
      };
      el.predictedModeVal.textContent = modeIcons[state.predictedMode] || state.predictedMode || '--';
    }
  }

  // 4.1 Real-Time IMU Accelerometer / Gyroscope Listener
  function startImuTracking() {
    if (typeof window !== 'undefined' && 'DeviceMotionEvent' in window) {
      window.addEventListener('devicemotion', (e) => {
        if (e.accelerationIncludingGravity) {
          state.imu.accelX = e.accelerationIncludingGravity.x != null ? e.accelerationIncludingGravity.x.toFixed(4) : '';
          state.imu.accelY = e.accelerationIncludingGravity.y != null ? e.accelerationIncludingGravity.y.toFixed(4) : '';
          state.imu.accelZ = e.accelerationIncludingGravity.z != null ? e.accelerationIncludingGravity.z.toFixed(4) : '';
        }
        if (e.rotationRate) {
          state.imu.gyroX = e.rotationRate.alpha != null ? e.rotationRate.alpha.toFixed(4) : '';
          state.imu.gyroY = e.rotationRate.beta != null ? e.rotationRate.beta.toFixed(4) : '';
          state.imu.gyroZ = e.rotationRate.gamma != null ? e.rotationRate.gamma.toFixed(4) : '';
        }
      }, { passive: true });
    }
  }

  // Geolocation Tracker (Pure Satellite Hardware - 0 MB Cellular Data Used)
  let geoHistory = []; // Sliding window buffer for stable kinematic speed calculation
  let geoRetryTimer = null;

  function handleGeoFix(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const now = Date.now();
    // Prevent fake speed spike across GPS resume gaps > 8s
    if (geoHistory.length > 0 && (now - geoHistory[geoHistory.length - 1].time) > 8000) {
      geoHistory = [];
    }
    state.lastGeoTime = now;
    let speedNum = 0.0;

    // Maintain rolling history of recent GPS coordinates (last 10 fixes)
    geoHistory.push({ lat, lng, time: now });
    if (geoHistory.length > 10) geoHistory.shift();

    // 1. Native hardware speed if provided by OS (works on vehicles or Android)
    if (pos.coords.speed !== null && !isNaN(pos.coords.speed) && pos.coords.speed > 0) {
      speedNum = pos.coords.speed * 3.6;
    } else if (geoHistory.length >= 2) {
      // 2. Pure Kinematic Speed from physical movement using 1.2 - 3.0s window
      const targetPoint = geoHistory.find(p => (now - p.time) >= 1200) || geoHistory[0];
      const dt = (now - targetPoint.time) / 1000;
      if (dt >= 1.0 && dt <= 8.0) {
        const dist = calcHaversineDistance(targetPoint.lat, targetPoint.lng, lat, lng);
        if (dist >= 0.7) {
          speedNum = (dist / dt) * 3.6;
        }
      }
    }

    if (speedNum > 150) speedNum = 0.0; // Filter invalid GPS jumps
    const speed = speedNum.toFixed(2);
    const acc = pos.coords.accuracy ? Math.round(pos.coords.accuracy) : 5;

    // Automatic Mode Prediction based on kinematics
    if (speedNum < 1.0) state.predictedMode = 'still';
    else if (speedNum <= 6.5) state.predictedMode = 'walk';
    else if (speedNum <= 18.0) state.predictedMode = 'run';
    else state.predictedMode = 'vehicle';

    state.currentLocation = { lat, lng, speed, accuracy: acc };
    el.gpsCoords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    el.gpsSpeed.textContent = `${speed} km/h (±${acc}m)`;
    updatePredictedModeUI();
    updateHealthStrip();
  }

  function startGeoTracking(forceImmediateFix = false) {
    if (!('geolocation' in navigator)) {
      el.gpsCoords.textContent = 'เบราว์เซอร์ไม่รองรับ GPS';
      return;
    }
    if (geoRetryTimer) { clearTimeout(geoRetryTimer); geoRetryTimer = null; }
    if (state.watchId !== null) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (e) {}
      state.watchId = null;
    }
    if (forceImmediateFix) {
      navigator.geolocation.getCurrentPosition(handleGeoFix, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
    }
    state.watchId = navigator.geolocation.watchPosition(
      handleGeoFix,
      (err) => {
        console.warn('Geolocation notice:', err.code, err.message);
        if (err.code === 1) {
          el.gpsCoords.textContent = 'กรุณากดเปิดสิทธิ์ GPS';
        } else {
          // Timeout or transient unavailable: do NOT lock permanently; schedule clean restart
          el.gpsCoords.textContent = 'กำลังค้นหาสัญญาณ GPS...';
          if (!geoRetryTimer) {
            geoRetryTimer = setTimeout(() => { geoRetryTimer = null; startGeoTracking(true); }, 3000);
          }
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }

  if (el.healthGps) {
    el.healthGps.addEventListener('click', () => {
      geoHistory = [];
      startGeoTracking(true);
      showSyncToast('loading', 'กำลังปลุกสัญญาณ GPS ใหม่...');
      setTimeout(() => { if (isGpsFresh()) showSyncToast('success', 'GPS กลับมาทำงานปกติแล้ว'); }, 2500);
    });
  }

  // 5. Ingest Telemetry Entry (Text-First Display)
  function ingestEntry(entry) {
    // Multi-User Security: Accept matching participant or iPhone/iOS Shortcut
    if (entry.participant_id && state.participantId) {
      const entryPid = String(entry.participant_id).toLowerCase().trim();
      const currentPid = String(state.participantId).toLowerCase().trim();
      if (entryPid !== currentPid && entryPid !== 'usr-anon' && entryPid !== 'iphone') {
        if (!entryPid.startsWith('ios-')) return;
      }
    }

    // Always stamp the user's active Student ID from the input box!
    entry.participant_id = state.participantId || entry.participant_id || 'USR-ANON';
    const activeTrip = (state.tripId && state.tripId !== 'IDLE') ? state.tripId : ('TRIP-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).substring(2, 6).toUpperCase());
    if (!entry.trip_id || entry.trip_id === 'TRIP-DEFAULT') {
      entry.trip_id = activeTrip;
    }
    if (!entry.session_id || entry.session_id === 'TRIP-DEFAULT') {
      entry.session_id = activeTrip;
    }

    if (!entry.note && state.tripNote) {
      entry.note = state.tripNote;
    }

    // Platform and model fallback
    entry.platform = entry.platform || state.platform || 'ios';
    entry.device_model = entry.device_model || state.deviceModel || 'Apple iPhone';

    // Timing (UTC Milliseconds)
    if (!entry.t_utc_ms) {
      entry.t_utc_ms = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    }
    entry.timestamp = entry.timestamp || new Date(entry.t_utc_ms).toISOString();

    // Prevent stale packets from previous trips leaking into an active trip (5s clock-skew margin)
    if (state.isRecording && state.startTime && entry.t_utc_ms < (state.startTime + serverClockOffsetMs - 5000)) {
      return;
    }

    // Lat / Lon normalization (STALE GPS GUARD: never stamp frozen GPS older than 10s!)
    const freshGps = isGpsFresh() ? state.currentLocation : null;
    if (entry.lat !== undefined && entry.lat !== null && entry.lat !== '') {
      entry.latitude = entry.lat;
    } else if (entry.latitude !== undefined && entry.latitude !== null && entry.latitude !== '') {
      entry.lat = entry.latitude;
    } else if (freshGps) {
      entry.lat = freshGps.lat;
      entry.latitude = freshGps.lat;
    } else {
      entry.lat = '';
      entry.latitude = '';
    }

    if (entry.lon !== undefined && entry.lon !== null && entry.lon !== '') {
      entry.longitude = entry.lon;
    } else if (entry.longitude !== undefined && entry.longitude !== null && entry.longitude !== '') {
      entry.lon = entry.longitude;
    } else if (freshGps) {
      entry.lon = freshGps.lng;
      entry.longitude = freshGps.lng;
    } else {
      entry.lon = '';
      entry.longitude = '';
    }

    // Speed & Accuracy (Adopt kinematic speed ONLY if GPS is fresh — prevents frozen 27.8 km/h bug!)
    if (entry.speed === undefined || entry.speed === null || entry.speed === '' || Number(entry.speed) === 0) {
      if (freshGps && Number(freshGps.speed) > 0) {
        entry.speed = freshGps.speed;
      } else if (freshGps) {
        entry.speed = '0.00';
      } else {
        entry.speed = (entry.speed !== undefined && entry.speed !== null && Number(entry.speed) > 0) ? entry.speed : '';
      }
    }
    if (entry.accuracy === undefined || entry.accuracy === null || entry.accuracy === '') {
      entry.accuracy = freshGps ? freshGps.accuracy : '';
    }

    // Activity Recognition
    if (entry.activity_recognition_mode) {
      state.predictedMode = entry.activity_recognition_mode;
    } else if (entry.predicted_mode) {
      state.predictedMode = entry.predicted_mode;
      entry.activity_recognition_mode = entry.predicted_mode;
    } else {
      entry.activity_recognition_mode = state.predictedMode;
    }

    // RSSI
    entry.rssi_raw = entry.rssi_raw !== undefined ? entry.rssi_raw : entry.rssi;
    entry.rssi = Math.round(entry.rssi_raw !== undefined ? entry.rssi_raw : -99);

    // CRITICAL FIX: On iOS Web Logger, the active UI mode/position/note MUST ALWAYS stamp incoming Shortcut packets
    // (Previously api/log.js defaulted mode='walk' which overwrote moto clicks!)
    const isLocalUiControlled = (entry.platform === 'ios' || entry.rssi_source === 'shortcut' || entry.rssi_source === 'browser_offline' || !entry.user_label_mode);
    entry.user_label_mode = isLocalUiControlled ? state.selectedMode : (entry.user_label_mode || state.selectedMode);
    entry.phone_position = isLocalUiControlled ? state.phonePosition : (entry.phone_position || state.phonePosition);
    entry.note = state.tripNote || entry.note || '';

    updatePredictedModeUI();

    // Update live display even when idle, but ONLY record to state.logs when actively recording!
    const rssi = entry.rssi;
    el.currentRssi.textContent = rssi;
    el.currentSsid.textContent = entry.ssid || (entry.bssid === 'disconnected' ? 'Disconnected (GPS)' : 'Unknown');
    el.currentBssid.textContent = entry.bssid || 'Unknown';

    // Color & Classification Tag
    if (rssi >= -50) {
      el.currentRssi.style.color = '#10b981';
      el.signalTag.textContent = 'ดีเยี่ยม (EXCELLENT)';
      el.signalTag.className = 'rssi-status-tag tag-excellent';
    } else if (rssi >= -65) {
      el.currentRssi.style.color = '#06b6d4';
      el.signalTag.textContent = 'ดี (GOOD)';
      el.signalTag.className = 'rssi-status-tag tag-good';
    } else if (rssi >= -75) {
      el.currentRssi.style.color = '#f59e0b';
      el.signalTag.textContent = 'ปานกลาง (FAIR)';
      el.signalTag.className = 'rssi-status-tag tag-fair';
    } else {
      el.currentRssi.style.color = '#f43f5e';
      el.signalTag.textContent = entry.rssi_source === 'browser_offline' ? 'ออฟไลน์ (GPS)' : 'อ่อน (POOR)';
      el.signalTag.className = 'rssi-status-tag tag-poor';
    }

    if (state.isRecording) {
      state.logs.push(entry);
      saveActiveTrip();

      // Update Stats Summary
      el.totalSamples.textContent = `${state.logs.length} จุด [${state.selectedMode}]`;
      const validRssiLogs = state.logs.filter(cur => (cur.rssi || -99) > -98);
      if (validRssiLogs.length > 0) {
        const totalRssi = validRssiLogs.reduce((acc, cur) => acc + (cur.rssi || 0), 0);
        el.avgRssi.textContent = Math.round(totalRssi / validRssiLogs.length) + ' dBm';
      } else {
        el.avgRssi.textContent = '-99 dBm';
      }

      // Pulse connection status
      el.connText.textContent = entry.rssi_source === 'browser_offline'
        ? `GPS #${state.logs.length}`
        : `รับ #${state.logs.length}`;
      el.connPill.classList.add('recording');
    }

    // Telemetry Watchdog Ping (only real Wi-Fi/shortcut pings reset Shortcut watchdog)
    if (entry.rssi_source !== 'browser_offline') {
      state.lastTelemetryTime = Date.now();
      hideWatchdogAlert();
    }
  }

  // 6. Resilient Real-Time Telemetry Polling (Timestamp Cursor + 4s Abort Timeout + Clock-Skew Sync)
  let lastProcessedTime = Date.now() - 5000;
  let serverClockOffsetMs = 0;
  let isPolling = false;

  async function pollTelemetry() {
    if (isPolling) return;
    isPolling = true;
    try {
      const pId = encodeURIComponent(state.participantId || '');
      const plat = encodeURIComponent(state.platform || 'ios');
      const url = `/api/log?action=get&participant_id=${pId}&platform=${plat}&after_t=${lastProcessedTime}&t=${Date.now()}`;
      const res = await fetchWithTimeout(url, { cache: 'no-store' }, 4000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      if (data && typeof data.server_time_ms === 'number') {
        serverClockOffsetMs = data.server_time_ms - Date.now();
        if (!state.isRecording && (!data.logs || data.logs.length === 0)) {
          lastProcessedTime = data.server_time_ms;
        }
      }

      if (el.connPill) {
        el.connPill.classList.add('connected');
        el.connText.textContent = state.logs.length > 0 ? `รับ #${state.logs.length}` : 'ออนไลน์';
      }

      if (data && Array.isArray(data.logs)) {
        // Sort by timestamp ascending to guarantee monotonic cursor
        data.logs.sort((a, b) => (a.t_utc_ms || 0) - (b.t_utc_ms || 0));
        for (const entry of data.logs) {
          const entryT = entry.t_utc_ms || Date.now();
          if (entryT > lastProcessedTime) {
            lastProcessedTime = entryT;
            ingestEntry(entry);
          }
        }
      }
    } catch (err) {
      if (el.connPill) {
        el.connPill.classList.remove('connected');
        el.connText.textContent = state.isRecording ? `ออฟไลน์ #${state.logs.length}` : 'พร้อมรับข้อมูล';
      }
    } finally {
      isPolling = false;
    }

    // Auto-recover GPS watchPosition if frozen > 15s during recording
    if (state.isRecording && state.lastGeoTime > 0 && (Date.now() - state.lastGeoTime) > 15000) {
      state.lastGeoTime = Date.now();
      startGeoTracking();
    }
  }

  // 6.1 Offline GPS + Disconnected Heartbeat (Fills Wi-Fi blackouts while riding motorcycle!)
  function runOfflineHeartbeat() {
    if (!state.isRecording) return;
    const now = Date.now();
    const lastWiFi = state.lastTelemetryTime || state.startTime || now;
    // If no Shortcut Wi-Fi packet received for >= 5.0s (avoids false -99 during normal 1.8-3.5s Wi-Fi jitter),
    // log live fresh GPS + disconnected RSSI (-99) every ~2s
    if ((now - lastWiFi) >= 5000) {
      const lastLogged = state.logs.length > 0 ? (state.logs[state.logs.length - 1].t_utc_ms || 0) : 0;
      if ((now - lastLogged) >= 1800) {
        const freshGps = isGpsFresh() ? state.currentLocation : null;
        ingestEntry({
          t_utc_ms: now,
          timestamp: new Date(now).toISOString(),
          participant_id: state.participantId,
          platform: state.platform || 'ios',
          device_model: state.deviceModel || 'Apple iPhone',
          os_version: state.osVersion || 'iOS 18.1',
          lat: freshGps ? freshGps.lat : '',
          lon: freshGps ? freshGps.lng : '',
          speed: freshGps ? freshGps.speed : '',
          accuracy: freshGps ? freshGps.accuracy : '',
          bssid: 'disconnected',
          ssid: '',
          rssi_raw: -99,
          rssi_source: 'browser_offline',
          user_label_mode: state.selectedMode,
          phone_position: state.phonePosition,
          note: state.tripNote
        });
      }
    }
  }

  function startTelemetryEngine() {
    pollTelemetry();
    setInterval(pollTelemetry, 2000); // Poll every 2s with strict 4s AbortController timeout
    setInterval(updateHealthStrip, 1000); // Live 3-sensor health strip refresh
  }

  // 7. Reset Data
  function resetData() {
    state.logs = [];
    el.totalSamples.textContent = '0 จุด';
    el.avgRssi.textContent = '-- dBm';
    el.currentRssi.textContent = '--';
    el.currentRssi.style.color = 'var(--accent-cyan)';
    el.signalTag.textContent = 'รอสัญญาณ';
    el.signalTag.className = 'rssi-status-tag';
    el.currentSsid.textContent = '--';
    el.currentBssid.textContent = '--';
  }

  // 8. Timer Controller
  function startTimer(existingStartTime = null) {
    state.startTime = existingStartTime || Date.now();
    state.lastTelemetryTime = Date.now();
    hideWatchdogAlert();

    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      const delta = Math.floor((Date.now() - state.startTime) / 1000);
      const h = String(Math.floor(delta / 3600)).padStart(2, '0');
      const m = String(Math.floor((delta % 3600) / 60)).padStart(2, '0');
      const s = String(delta % 60).padStart(2, '0');
      el.tripTimer.textContent = `${h}:${m}:${s}`;
    }, 1000);

    if (!state.watchdogInterval) {
      state.watchdogInterval = setInterval(checkWatchdog, 4000);
    }
    if (!state.offlineHeartbeatInterval) {
      state.offlineHeartbeatInterval = setInterval(runOfflineHeartbeat, 2000);
    }
  }

  function stopTimer() {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    if (state.watchdogInterval) {
      clearInterval(state.watchdogInterval);
      state.watchdogInterval = null;
    }
    if (state.offlineHeartbeatInterval) {
      clearInterval(state.offlineHeartbeatInterval);
      state.offlineHeartbeatInterval = null;
    }
    hideWatchdogAlert();
  }

  // 8.1 iOS Shortcuts Web Watchdog (1-Minute Sweet Spot)
  const WATCHDOG_TIMEOUT_MS = 60000; // 60s timeout

  function checkWatchdog() {
    if (!state.isRecording) {
      hideWatchdogAlert();
      return;
    }
    const now = Date.now();
    const lastTime = state.lastTelemetryTime || state.startTime || now;
    const elapsed = now - lastTime;
    if (elapsed >= WATCHDOG_TIMEOUT_MS) {
      showWatchdogAlert();
    } else {
      hideWatchdogAlert();
    }
  }

  function showWatchdogAlert() {
    if (!el.watchdogAlert) return;
    if (el.watchdogAlert.style.display !== 'flex') {
      el.watchdogAlert.style.display = 'flex';
      if ('vibrate' in navigator) {
        try { navigator.vibrate([200, 100, 200]); } catch (e) {}
      }
    }
  }

  function hideWatchdogAlert() {
    if (!el.watchdogAlert) return;
    if (el.watchdogAlert.style.display !== 'none') {
      el.watchdogAlert.style.display = 'none';
    }
  }

  // Helper: Live Google Drive Sync Toast (Non-overlapping timer)
  function showSyncToast(type, message) {
    if (!el.syncToast) return;
    clearTimeout(window._syncToastTimer);
    el.syncToast.style.display = 'flex';
    el.syncToast.className = 'sync-toast-banner ' + (type === 'success' ? 'toast-success' : (type === 'error' ? 'toast-error' : ''));
    if (el.syncToastIcon) {
      el.syncToastIcon.textContent = type === 'success' ? '✅' : (type === 'error' ? '❌' : '⏳');
    }
    if (el.syncToastText) {
      el.syncToastText.textContent = message;
    }
    if (type === 'success' || type === 'error') {
      window._syncToastTimer = setTimeout(() => {
        if (el.syncToast) el.syncToast.style.display = 'none';
      }, 4500);
    }
  }

  // 9. Google Drive Sync Engine + Offline Pending Queue
  function buildCleanPayloadLogs(rawLogs, tripId, participantId, defaultPlatform, defaultModel, defaultOs, defaultMode, defaultPos, defaultNote) {
    // Sort chronologically & deduplicate identical t_utc_ms (never backfill stale GPS!)
    const sorted = [...rawLogs].sort((a, b) => (a.t_utc_ms || 0) - (b.t_utc_ms || 0));
    const seenT = new Set();
    const clean = [];
    for (const row of sorted) {
      let tUtc = row.t_utc_ms || (row.timestamp ? Date.parse(row.timestamp) : Date.now());
      while (seenT.has(tUtc)) tUtc += 1;
      seenT.add(tUtc);
      let spd = (row.speed !== null && row.speed !== undefined && row.speed !== '') ? row.speed : '';
      if (typeof spd === 'number') spd = spd.toFixed(2);
      const rowSession = (row.session_id && row.session_id !== 'TRIP-DEFAULT') ? row.session_id : ((row.trip_id && row.trip_id !== 'TRIP-DEFAULT') ? row.trip_id : tripId);
      clean.push({
        t_utc_ms: tUtc,
        timestamp: new Date(tUtc).toISOString(),
        session_id: rowSession,
        participant_id: row.participant_id || participantId,
        platform: row.platform || defaultPlatform || 'ios',
        device_model: row.device_model || defaultModel || 'Apple iPhone',
        os_version: row.os_version || defaultOs || 'iOS 18.1',
        lat: (row.lat !== null && row.lat !== undefined) ? row.lat : '',
        lon: (row.lon !== null && row.lon !== undefined) ? row.lon : '',
        speed: spd,
        accuracy: (row.accuracy !== null && row.accuracy !== undefined) ? row.accuracy : '',
        bssid: row.bssid || '',
        ssid: row.ssid || '',
        rssi_raw: (row.rssi_raw !== null && row.rssi_raw !== undefined) ? row.rssi_raw : ((row.rssi !== null && row.rssi !== undefined) ? row.rssi : -99),
        rssi_source: row.rssi_source || (row.platform === 'android' ? 'wifimanager' : 'shortcut'),
        user_label_mode: row.user_label_mode || defaultMode || 'walk',
        phone_position: row.phone_position || defaultPos || 'pocket',
        note: row.note || defaultNote || ''
      });
    }
    return clean;
  }

  async function uploadTripRecord(tripRec) {
    if (!navigator.onLine) {
      return { ok: false, reason: 'offline' };
    }
    try {
      const res = await fetchWithTimeout('/api/sync-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook_url: state.gdriveWebhook,
          trip_id: tripRec.tripId,
          participant_id: tripRec.participantId,
          os: tripRec.platform || 'ios',
          device_model: tripRec.deviceModel || 'Apple iPhone',
          logs: tripRec.logs
        })
      }, 20000);
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        return { ok: true };
      }
      return { ok: false, reason: data.message || ('HTTP ' + res.status) };
    } catch (err) {
      return { ok: false, reason: err.message || 'network error' };
    }
  }

  let isFlushingQueue = false;
  async function flushPendingQueue(isSilent = false) {
    if (isFlushingQueue) return;
    const queue = getPendingQueue();
    if (queue.length === 0) return;
    if (!navigator.onLine) {
      if (!isSilent) showSyncToast('error', `ยังไม่มีอินเทอร์เน็ต (เก็บไว้ในเครื่องแล้ว ${queue.length} ทริป)`);
      return;
    }
    isFlushingQueue = true;
    let uploaded = 0;
    try {
      for (const item of queue) {
        showSyncToast('loading', `กำลังส่งทริปค้าง ${item.note || item.tripId} (${item.logs.length} จุด)...`);
        const res = await uploadTripRecord(item);
        if (res.ok) {
          removePendingTrip(item.tripId);
          uploaded += 1;
        } else {
          break; // Stop retrying if network dropped again
        }
      }
      const rem = getPendingQueue().length;
      if (uploaded > 0 && rem === 0) {
        showSyncToast('success', `ส่งทริปค้างขึ้น Google Drive ครบแล้ว (${uploaded} ทริป) ✅`);
      } else if (rem > 0) {
        showSyncToast('error', `ส่งได้ ${uploaded} ทริป — ยังค้างในเครื่อง ${rem} ทริป (ปลอดภัยไม่หาย)`);
      }
    } finally {
      isFlushingQueue = false;
      updatePendingQueueUI();
    }
  }

  if (el.pendingQueueBanner) {
    el.pendingQueueBanner.addEventListener('click', () => flushPendingQueue(false));
  }
  window.addEventListener('online', () => {
    if (getPendingQueue().length > 0) flushPendingQueue(true);
  });

  async function syncToGoogleDrive(isSilent = false) {
    if (!state.gdriveWebhook) {
      showSyncToast('error', 'ไม่ได้ตั้งค่า Webhook URL');
      if (!isSilent) alert('กรุณาระบุ Google Apps Script Webhook URL ในส่วนตั้งค่าก่อน');
      return;
    }

    if (state.logs.length === 0) {
      if (getPendingQueue().length > 0) {
        await flushPendingQueue(isSilent);
        return;
      }
      if (!isSilent) alert('ไม่มีข้อมูลในรอบนี้ให้ส่งขึ้น Google Drive');
      return;
    }

    if (el.btnSyncGdrive) {
      el.btnSyncGdrive.disabled = true;
      el.btnSyncGdrive.innerHTML = '<span class="icon">⏳</span><span>กำลังส่ง...</span>';
    }

    const activeTrip = (state.tripId && state.tripId !== 'IDLE') ? state.tripId : ('TRIP-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    const payloadLogs = buildCleanPayloadLogs(
      state.logs, activeTrip, state.participantId,
      state.platform, state.deviceModel, state.osVersion,
      state.selectedMode, state.phonePosition, state.tripNote
    );

    const tripRec = {
      tripId: activeTrip,
      participantId: state.participantId,
      platform: state.platform || 'ios',
      deviceModel: state.deviceModel || 'Apple iPhone',
      note: state.tripNote || '',
      createdAt: Date.now(),
      logs: payloadLogs
    };

    // Always persist into local pending queue FIRST so trip can NEVER be lost offline!
    enqueuePendingTrip(tripRec);

    if (!navigator.onLine) {
      showSyncToast('error', `ออฟไลน์: เก็บ ${payloadLogs.length} จุดไว้ในเครื่องแล้ว — กดแถบเหลืองเมื่อมีเน็ต`);
      if (el.btnSyncGdrive) {
        el.btnSyncGdrive.disabled = false;
        el.btnSyncGdrive.innerHTML = '<span class="icon">☁️</span><span>ซิงค์ Drive</span>';
      }
      return;
    }

    showSyncToast('loading', `กำลังอัปโหลด ${payloadLogs.length} จุดเข้า Google Drive...`);
    try {
      const res = await uploadTripRecord(tripRec);
      if (res.ok) {
        removePendingTrip(activeTrip);
        clearActiveTripStorage();
        showSyncToast('success', `บันทึกเข้า Google Drive สำเร็จแล้ว (${payloadLogs.length} จุด)`);
        if (!isSilent) {
          alert(`✅ บันทึกสำเร็จ! ข้อมูล ${payloadLogs.length} จุดถูกส่งเข้า Google Drive เรียบร้อยแล้ว`);
        }
        // Also flush any older pending trips if online!
        if (getPendingQueue().length > 0) {
          await flushPendingQueue(true);
        }
      } else {
        showSyncToast('error', `เน็ตขัดข้อง: เซฟไว้ในคิวเครื่องแล้ว (${getPendingQueue().length} ทริป) แตะแถบเหลืองส่งใหม่ได้`);
        if (!isSilent) {
          alert(`⚠️ ส่งไม่สำเร็จ (${res.reason}) แต่ระบบบันทึกไว้ในคิวเครื่องแล้ว แตะแถบเหลืองเพื่อส่งใหม่เมื่อมีเน็ต`);
        }
      }
    } finally {
      if (el.btnSyncGdrive) {
        el.btnSyncGdrive.disabled = false;
        el.btnSyncGdrive.innerHTML = '<span class="icon">☁️</span><span>ซิงค์ Drive</span>';
      }
      updatePendingQueueUI();
    }
  }

  // 10. UserID Management & Validation (Red = Empty/Invalid, Green = Valid Student ID)
  function updateServerUrlDisplay() {
    const url = `${window.location.origin}/api/log?participant_id=${encodeURIComponent(state.participantId)}&rssi=[ความแรงสัญญาณ]&bssid=[BSSID]&ssid=[ชื่อ Wi-Fi]`;
    if (el.serverUrlDisplay) el.serverUrlDisplay.textContent = url;
  }

  function updateUserIdValidationUI(val) {
    const isValid = isStudentIdValid(val);
    if (el.participantInput) {
      if (isValid) {
        el.participantInput.classList.remove('input-invalid');
        el.participantInput.classList.add('input-valid');
        if (el.idSavedBadge) {
          el.idSavedBadge.textContent = '✓ บันทึกถาวร';
          el.idSavedBadge.style.color = '#10b981';
        }
      } else {
        el.participantInput.classList.remove('input-valid');
        el.participantInput.classList.add('input-invalid');
        if (el.idSavedBadge) {
          el.idSavedBadge.textContent = '⚠️ ระบุรหัสนักศึกษา';
          el.idSavedBadge.style.color = '#ef4444';
        }
      }
    }
  }

  // First-Time Student ID Onboarding Modal Handler
  function checkFirstTimeStudentId() {
    const isConfigured = localStorage.getItem('rssi_student_id_configured') === 'true';
    const currentId = state.participantId;
    const modal = document.getElementById('first-time-modal');
    const modalInput = document.getElementById('modal-student-id-input');
    const modalBtn = document.getElementById('modal-btn-save');
    const modalErr = document.getElementById('modal-error-msg');

    if (!isConfigured || !isStudentIdValid(currentId)) {
      if (modal && modalInput && modalBtn) {
        modal.style.display = 'flex';
        modalInput.value = isStudentIdValid(currentId) ? currentId : '';

        const validateModalInput = () => {
          const val = modalInput.value.trim();
          const valid = isStudentIdValid(val);
          modalBtn.disabled = !valid;
          if (valid) {
            modalInput.classList.remove('input-invalid');
            modalInput.classList.add('input-valid');
            if (modalErr) modalErr.style.display = 'none';
          } else {
            modalInput.classList.remove('input-valid');
            modalInput.classList.add('input-invalid');
            if (modalErr && val.length > 0) modalErr.style.display = 'block';
          }
        };

        modalInput.addEventListener('input', validateModalInput);
        validateModalInput();

        const saveStudentId = () => {
          const val = modalInput.value.trim();
          if (isStudentIdValid(val)) {
            state.participantId = val;
            localStorage.setItem('rssi_participant_id', val);
            localStorage.setItem('rssi_student_id_configured', 'true');
            setCookie('rssi_participant_id', val);
            if (el.participantInput) el.participantInput.value = val;
            updateUserIdValidationUI(val);
            updateServerUrlDisplay();
            modal.style.display = 'none';
          }
        };

        modalBtn.addEventListener('click', saveStudentId);
        modalInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') saveStudentId();
        });
        setTimeout(() => modalInput.focus(), 300);
      }
    } else {
      updateUserIdValidationUI(currentId);
    }
  }

  if (el.participantInput) {
    el.participantInput.value = state.participantId;
    updateUserIdValidationUI(state.participantId);
    updateServerUrlDisplay();

    el.participantInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      state.participantId = val;
      if (isStudentIdValid(val)) {
        localStorage.setItem('rssi_participant_id', val);
        localStorage.setItem('rssi_student_id_configured', 'true');
        setCookie('rssi_participant_id', val);
      }
      updateUserIdValidationUI(val);
      lastProcessedTime = Date.now();
      resetData();
      updateServerUrlDisplay();
    });

    if (el.btnCopyId) {
      el.btnCopyId.addEventListener('click', () => {
        navigator.clipboard.writeText(state.participantId).then(() => {
          el.btnCopyId.textContent = '✓';
          setTimeout(() => el.btnCopyId.textContent = '📋', 1200);
        });
      });
    }

    if (el.btnResetHwId) {
      el.btnResetHwId.addEventListener('click', () => {
        const modal = document.getElementById('first-time-modal');
        const modalInput = document.getElementById('modal-student-id-input');
        if (modal && modalInput) {
          modal.style.display = 'flex';
          modalInput.value = state.participantId || '';
          modalInput.focus();
        }
      });
    }
  }

  // 10.5 Note & Location Description Setup
  if (el.tripNoteInput) {
    el.tripNoteInput.value = state.tripNote;
    updateNoteStatusBadge();
    el.tripNoteInput.addEventListener('input', (e) => {
      state.tripNote = e.target.value.trim();
      localStorage.setItem('rssi_trip_note', state.tripNote);
      updateNoteStatusBadge();
      if (state.isRecording) saveActiveTrip();
    });
  }

  function setSelectedMode(mode, withFeedback = false) {
    const cleanMode = (mode === 'moto') ? 'moto' : 'walk';
    state.selectedMode = cleanMode;
    el.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === cleanMode));
    updateHealthStrip();
    if (withFeedback) {
      playModeTone(cleanMode);
      showSyncToast('success', cleanMode === 'moto' ? 'สลับโหมด → 🛵 มอไซค์ (MOTO)' : 'สลับโหมด → 🚶 เดิน (WALK)');
    }
    if (state.isRecording) {
      el.totalSamples.textContent = `${state.logs.length} จุด [${state.selectedMode}]`;
      saveActiveTrip();
    }
  }

  // 11. Mode Chips Selection (Oversized Walk / Moto Toggle with Audio + Haptic Confirmation)
  el.modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setSelectedMode(btn.dataset.mode, true);
    });
  });

  // Phone Position Chips Selection
  if (el.posBtns) {
    el.posBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        el.posBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.phonePosition = btn.dataset.pos;
        if (state.isRecording) saveActiveTrip();
      });
    });
  }

  // 12. Start Trip Action (With Empty / Duplicate Note Guard)
  el.btnStart.addEventListener('click', () => {
    const note = (state.tripNote || '').trim();
    const lastNote = localStorage.getItem(LAST_COMPLETED_NOTE_KEY) || '';
    if (!note) {
      if (!confirm('⚠️ ยังไม่ได้กรอกรหัสทริป (note เช่น T08_R1_back)\nต้องการเริ่มบันทึกโดยไม่ใส่รหัสทริปหรือไม่?')) {
        if (el.tripNoteInput) el.tripNoteInput.focus();
        return;
      }
    } else if (lastNote && note === lastNote) {
      if (!confirm(`⚠️ รหัสทริป "${note}" ซ้ำกับทริปที่เพิ่งเก็บเสร็จ!\nกด Cancel เพื่อเปลี่ยนรหัส หรือกด OK หากต้องการเก็บซ้ำ`)) {
        if (el.tripNoteInput) el.tripNoteInput.focus();
        return;
      }
    }

    const now = Date.now();
    state.isRecording = true;
    state.tripId = 'TRIP-' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    lastProcessedTime = now + serverClockOffsetMs - 2000;

    el.tripIdBadge.textContent = state.tripId;
    el.tripIdBadge.style.color = '#10b981';

    // Switch buttons
    el.btnStart.style.display = 'none';
    el.btnStop.style.display = 'flex';

    resetData();
    el.totalSamples.textContent = `0 จุด [${state.selectedMode}]`;
    startTimer(now);
    saveActiveTrip();
    requestWakeLock();
    if (!isGpsFresh()) startGeoTracking(true);
    playModeTone(state.selectedMode);

    // Clear old server buffer non-blocking so previous trips never bleed in
    const pId = encodeURIComponent(state.participantId || '');
    fetchWithTimeout(`/api/log?action=clear&participant_id=${pId}`, { method: 'DELETE' }, 3000).catch(() => {});
  });

  // 13. Stop Trip Action (With Accidental Pocket-Tap Confirmation + Pending Queue Safety)
  el.btnStop.addEventListener('click', async () => {
    const elapsedSec = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
    if (elapsedSec > 15) {
      const label = state.tripNote || state.tripId;
      if (!confirm(`🛑 ยืนยันหยุดบันทึกทริป ${label} (${state.logs.length} จุด, ${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')} น.)?`)) {
        return;
      }
    }

    state.isRecording = false;
    el.tripIdBadge.textContent = 'FINISHED';
    el.tripIdBadge.style.color = '#94a3b8';

    // Switch buttons
    el.btnStop.style.display = 'none';
    el.btnStart.style.display = 'flex';

    stopTimer();
    releaseWakeLock();
    el.connPill.classList.remove('recording');

    if (state.tripNote) {
      localStorage.setItem(LAST_COMPLETED_NOTE_KEY, state.tripNote);
      updateNoteStatusBadge();
    }

    // Persist finished trip into pending queue BEFORE clearing active trip storage (zero-loss guarantee!)
    if (state.logs.length > 0) {
      const cleanLogs = buildCleanPayloadLogs(
        state.logs, state.tripId, state.participantId,
        state.platform, state.deviceModel, state.osVersion,
        state.selectedMode, state.phonePosition, state.tripNote
      );
      enqueuePendingTrip({
        tripId: state.tripId,
        participantId: state.participantId,
        platform: state.platform || 'ios',
        deviceModel: state.deviceModel || 'Apple iPhone',
        note: state.tripNote || '',
        createdAt: Date.now(),
        logs: cleanLogs
      });
    }
    clearActiveTripStorage();

    // Auto-sync to Google Drive
    if (state.autoSyncGdrive && state.gdriveWebhook && state.logs.length > 0) {
      await syncToGoogleDrive(true);
    }
  });

  // Watchdog Alert Tap Action (Immediate Reset & Resume)
  if (el.watchdogAlert) {
    el.watchdogAlert.addEventListener('click', () => {
      state.lastTelemetryTime = Date.now();
      hideWatchdogAlert();
    });
  }

  // 14. Export CSV (Instant Local Download - Clean 18 Core Research Columns)
  el.btnExport.addEventListener('click', () => {
    if (state.logs.length === 0) {
      alert('ไม่มีข้อมูลในรอบนี้ กรุณากด START TRIP หรือกดทดสอบสัญญาณก่อน');
      return;
    }
    const headers = [
      't_utc_ms',
      'timestamp',
      'session_id',
      'participant_id',
      'platform',
      'device_model',
      'os_version',
      'lat',
      'lon',
      'speed',
      'accuracy',
      'bssid',
      'ssid',
      'rssi_raw',
      'rssi_source',
      'user_label_mode',
      'phone_position',
      'note'
    ];
    let csv = headers.join(',') + '\n';
    const activeTrip = (state.tripId && state.tripId !== 'IDLE') ? state.tripId : ('TRIP-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    const cleanRows = buildCleanPayloadLogs(
      state.logs, activeTrip, state.participantId,
      state.platform, state.deviceModel, state.osVersion,
      state.selectedMode, state.phonePosition, state.tripNote
    );
    cleanRows.forEach(row => {
      const line = [
        row.t_utc_ms,
        row.timestamp,
        row.session_id,
        row.participant_id,
        row.platform,
        `"${String(row.device_model).replace(/"/g, '""')}"`,
        `"${String(row.os_version).replace(/"/g, '""')}"`,
        row.lat,
        row.lon,
        row.speed,
        row.accuracy,
        row.bssid,
        `"${String(row.ssid).replace(/"/g, '""')}"`,
        row.rssi_raw,
        row.rssi_source,
        row.user_label_mode,
        row.phone_position,
        `"${String(row.note).replace(/"/g, '""')}"`
      ];
      csv += line.join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.participantId}_${state.tripId}_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });

  // 15. Simulate Ping (Test without moving)
  el.btnSimulate.addEventListener('click', async () => {
    const randomRssi = Math.floor(Math.random() * 45) - 85; // -85 to -40 dBm
    const simulatedBssid = '00:1A:2B:3C:4D:' + Math.floor(Math.random() * 89 + 10);
    const simulatedPayload = {
      bssid: simulatedBssid,
      ssid: 'Campus-WiFi',
      rssi: randomRssi,
      lat: state.currentLocation ? state.currentLocation.lat : 13.7563,
      lng: state.currentLocation ? state.currentLocation.lng : 100.5018,
      speed: state.currentLocation ? state.currentLocation.speed : 1.2,
      accuracy: 4,
      mode: state.selectedMode,
      note: state.tripNote,
      participant_id: state.participantId,
      trip_id: state.tripId
    };

    try {
      const res = await fetchWithTimeout('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simulatedPayload)
      }, 4000);
      const data = await res.json();
      if (data && data.entry) {
        lastProcessedTime = data.entry.t_utc_ms || Date.now();
        ingestEntry(data.entry);
      }
    } catch (e) {
      const nowT = Date.now();
      lastProcessedTime = nowT;
      ingestEntry({
        id: nowT,
        t_utc_ms: nowT,
        timestamp: new Date(nowT).toISOString(),
        ...simulatedPayload
      });
    }
  });

  // 16. Clear Data (Isolated to this participant)
  el.btnClear.addEventListener('click', async () => {
    if (confirm('ต้องการล้างข้อมูลทั้งหมดในรอบนี้หรือไม่?')) {
      try {
        const pId = encodeURIComponent(state.participantId || '');
        await fetchWithTimeout(`/api/log?action=clear&participant_id=${pId}`, { method: 'DELETE' }, 4000);
      } catch (e) {}
      lastProcessedTime = Date.now();
      clearActiveTripStorage();
      resetData();
    }
  });

  // 17. Google Drive Settings Setup
  if (el.gdriveWebhookInput) {
    el.gdriveWebhookInput.value = state.gdriveWebhook;
    el.gdriveWebhookInput.addEventListener('change', (e) => {
      state.gdriveWebhook = e.target.value.trim();
      localStorage.setItem('rssi_gdrive_webhook', state.gdriveWebhook);
    });
  }

  if (el.gdriveAutoSyncChk) {
    el.gdriveAutoSyncChk.checked = state.autoSyncGdrive;
    el.gdriveAutoSyncChk.addEventListener('change', (e) => {
      state.autoSyncGdrive = e.target.checked;
      localStorage.setItem('rssi_autosync_gdrive', state.autoSyncGdrive);
    });
  }

  if (el.btnSyncGdrive) {
    el.btnSyncGdrive.addEventListener('click', () => syncToGoogleDrive(false));
  }

  // 18. Copy Server Ingest URL (Bound to this device)
  function getIngestUrl() {
    return `${window.location.origin}/api/log?participant_id=${encodeURIComponent(state.participantId)}&rssi=`;
  }
  if (el.serverUrlDisplay) {
    el.serverUrlDisplay.textContent = `${window.location.origin}/api/log?participant_id=${encodeURIComponent(state.participantId)}&rssi=[ความแรงสัญญาณ]&bssid=[BSSID]&ssid=[ชื่อ Wi-Fi]`;
  }
  if (el.btnCopyUrl) {
    el.btnCopyUrl.addEventListener('click', () => {
      navigator.clipboard.writeText(getIngestUrl()).then(() => {
        el.btnCopyUrl.textContent = 'คัดลอกแล้ว ✓';
        setTimeout(() => el.btnCopyUrl.textContent = 'คัดลอก', 1500);
      });
    });
  }

  // 19. OS Detection & Adaptive Download Highlighting
  function detectOS() {
    const ua = navigator.userAgent || navigator.vendor || window.opera || '';
    const platformStr = navigator.platform || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (platformStr === 'MacIntel' && navigator.maxTouchPoints > 1) || /iPhone|iPad/.test(platformStr);
    const isAndroid = /android/i.test(ua);

    const osIcon = document.getElementById('os-icon');
    const osTitle = document.getElementById('os-title');
    const osDesc = document.getElementById('os-desc');
    const btnIos = document.getElementById('btn-dl-ios');
    const btnAndroid = document.getElementById('btn-dl-android');

    if (isIOS) {
      state.platform = 'ios';
      state.deviceModel = /iPad/.test(ua) ? 'Apple iPad' : 'Apple iPhone';
      const iosVer = ua.match(/OS (\d+[_.]\d+)/);
      state.osVersion = iosVer ? `iOS ${iosVer[1].replace(/_/g, '.')}` : 'iOS 18.1';

      if (osIcon) osIcon.textContent = '🍎';
      if (osTitle) osTitle.textContent = 'อุปกรณ์ Apple iOS (iPhone/iPad)';
      if (osDesc) osDesc.textContent = 'แตะโหลดคำสั่งลัดเพื่อเริ่มส่งค่า Wi-Fi เข้าเว็บ';
      if (btnIos) btnIos.classList.add('highlight');
      if (btnAndroid) btnAndroid.style.opacity = '0.45';
    } else if (isAndroid) {
      state.platform = 'android';
      const modelMatch = ua.match(/;\s*([^;]+)\s+Build\//);
      state.deviceModel = modelMatch ? modelMatch[1].trim() : 'Android Device';
      const androidVer = ua.match(/Android\s+([\d.]+)/);
      state.osVersion = androidVer ? `Android ${androidVer[1]}` : 'Android';

      if (osIcon) osIcon.textContent = '🤖';
      if (osTitle) osTitle.textContent = 'อุปกรณ์ Android';
      if (osDesc) osDesc.textContent = 'แตะติดตั้ง APK เพื่อบันทึกข้อมูลในแอปได้ทันที (จบในแอปเดียว)';
      if (btnAndroid) btnAndroid.classList.add('highlight');
      if (btnIos) btnIos.style.opacity = '0.45';
    } else {
      state.platform = 'ios';
      state.deviceModel = 'Apple iPhone';
      state.osVersion = 'iOS 18';

      if (osIcon) osIcon.textContent = '🍎';
      if (osTitle) osTitle.textContent = 'เว็บแดชบอร์ดสำหรับ iOS';
      if (osDesc) osDesc.textContent = 'เชื่อมต่อคำสั่งลัดบน iPhone เพื่อบันทึกข้อมูลเข้าสู่ระบบ';
    }
  }

  // 20. Auto-Restore Active Trip after accidental Safari reload (Zero Split Files!)
  function restoreActiveTrip() {
    try {
      const raw = localStorage.getItem(ACTIVE_TRIP_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.isRecording || !saved.startTime) return;
      // Only restore trips started within the last 3 hours
      if ((Date.now() - saved.startTime) > 3 * 60 * 60 * 1000) {
        clearActiveTripStorage();
        return;
      }
      state.isRecording = true;
      state.tripId = saved.tripId;
      state.startTime = saved.startTime;
      state.selectedMode = saved.selectedMode || 'walk';
      state.phonePosition = saved.phonePosition || 'pocket';
      state.tripNote = saved.tripNote || state.tripNote;
      state.logs = Array.isArray(saved.logs) ? saved.logs : [];
      lastProcessedTime = saved.lastProcessedTime || Date.now();

      // Sync UI elements
      el.tripIdBadge.textContent = state.tripId;
      el.tripIdBadge.style.color = '#10b981';
      el.btnStart.style.display = 'none';
      el.btnStop.style.display = 'flex';
      if (el.tripNoteInput) el.tripNoteInput.value = state.tripNote;
      el.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === state.selectedMode));
      if (el.posBtns) el.posBtns.forEach(b => b.classList.toggle('active', b.dataset.pos === state.phonePosition));
      el.totalSamples.textContent = `${state.logs.length} จุด [${state.selectedMode}]`;
      el.connPill.classList.add('recording');
      startTimer(state.startTime);
      requestWakeLock();
      showSyncToast('success', `กู้คืนทริปเดิมอัตโนมัติ (${state.logs.length} จุด)`);
    } catch (e) {
      clearActiveTripStorage();
    }
  }

  // 21. 1-Click Launch Params from Checklist (?note=T08_R1_back&mode=moto)
  function applyUrlLaunchParams() {
    const params = new URLSearchParams(window.location.search);
    const urlNote = params.get('note');
    const urlMode = params.get('mode');
    if (!urlNote && !urlMode) return;

    // Protect an active recording from being accidentally overwritten by clicking a checklist link!
    if (state.isRecording) {
      showSyncToast('error', `⚠️ กำลังอัดทริป ${state.tripNote || state.tripId} อยู่ — กด STOP ก่อนเริ่มทริปใหม่`);
      return;
    }

    if (urlNote && urlNote.trim()) {
      state.tripNote = urlNote.trim();
      localStorage.setItem('rssi_trip_note', state.tripNote);
      if (el.tripNoteInput) el.tripNoteInput.value = state.tripNote;
      updateNoteStatusBadge();
    }
    if (urlMode && (urlMode === 'walk' || urlMode === 'moto')) {
      setSelectedMode(urlMode, false);
    }
    showSyncToast('success', `ตั้งค่าทริป ${state.tripNote} [${state.selectedMode}] พร้อมกด START`);
    // Clean URL query params so future reloads don't overwrite manual changes
    try {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    } catch (e) {}
  }

  // Boot Application
  detectOS();
  checkFirstTimeStudentId();
  startGeoTracking(true);
  startImuTracking();
  restoreActiveTrip();
  applyUrlLaunchParams();
  updatePendingQueueUI();
  updateNoteStatusBadge();
  updateHealthStrip();
  startTelemetryEngine();
});
