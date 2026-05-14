// ===== Constants =====
const DB_NAME = 'HanashiteManabuDB';
const DB_VERSION = 1;
const STORE_NAME = 'expressions';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const FALLBACK_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

// ===== Supabase Global Ranking Defaults =====
const DEFAULT_SUPABASE_URL = 'https://trvihedkasxejrtfdnlp.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRydmloZWRrYXN4ZWpydGZkbmxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Njg4MzQsImV4cCI6MjA5NDM0NDgzNH0.xjt_D4E3ROOZ7-CFgTDDd4iGjdtqDbcpaWHaX1Ce9Ck';

// ===== App State =====
const state = {
  isListening: false,
  transcript: '',
  interimTranscript: '',
  apiKey: localStorage.getItem('gemini_api_key') || '',
  model: localStorage.getItem('gemini_model') || 'gemini-2.0-flash-lite',
  supabaseUrl: localStorage.getItem('supabase_url') || DEFAULT_SUPABASE_URL,
  supabaseKey: localStorage.getItem('supabase_key') || DEFAULT_SUPABASE_KEY,
  db: null,
};

let recognition = null;
let restartTimer = null;
let lastCommittedSegment = '';  // For deduplication
let restartCount = 0;
const MAX_RESTARTS = 2000;
const MAX_LISTEN_MS = 30 * 60 * 1000; // 30분 제한
const CHUNK_CHAR_THRESHOLD = 2000;    // 이 이상이면 분할 분석

// Audio processing for noise gate
let audioContext = null;
let audioStream = null;
let analyserNode = null;
let noiseGateActive = false;
const NOISE_THRESHOLD = 0.015; // Min volume to consider as speech
let lastConfidence = 0;
let confidenceHistory = [];
let listenStartTime = null;
let listenTimerInterval = null;
let wakeLock = null;
let lowConfidenceStreak = 0;

// ===== DOM Elements =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {};
function cacheDom() {
  els.micBtn = $('#mic-toggle');
  els.micStatus = $('#mic-status');
  els.waveform = $('#waveform');
  els.transcriptBox = $('#transcript-box');
  els.transcriptText = $('#transcript-text');
  els.transcriptPlaceholder = $('#transcript-placeholder');
  els.convertBtn = $('#convert-btn');
  els.clearTranscriptBtn = $('#clear-transcript-btn');
  els.resultsArea = $('#results-area');
  els.resultsList = $('#results-list');
  els.loadingArea = $('#loading-area');
  els.searchInput = $('#search-input');
  els.sortSelect = $('#sort-select');
  els.notesCount = $('#notes-count');
  els.notesList = $('#notes-list');
  els.notesEmpty = $('#notes-empty');
  els.apiKeyInput = $('#api-key-input');
  els.saveApiBtn = $('#save-api-btn');
  els.modelSelect = $('#model-select');
  els.apiStatus = $('#api-status');
  els.apiStatusText = $('#api-status-text');
  els.exportBtn = $('#export-btn');
  els.importBtn = $('#import-btn');
  els.importFile = $('#import-file');
  els.clearAllBtn = $('#clear-all-btn');
  els.apiModal = $('#api-modal');
  els.modalApiInput = $('#modal-api-input');
  els.modalSaveBtn = $('#modal-save-btn');
  els.toastContainer = $('#toast-container');
  els.settingsInstallBtn = $('#settings-install-btn');
  els.installGuideAndroid = $('#install-guide-android');
  els.installGuideIos = $('#install-guide-ios');
  els.installGuideDesktop = $('#install-guide-desktop');
  els.installStatus = $('#install-status');
  els.confidenceIndicator = $('#confidence-indicator');
  els.confidenceBar = $('#confidence-bar');
  els.confidenceText = $('#confidence-text');
  els.listenTimer = $('#listen-timer');
  els.listenElapsed = $('#listen-elapsed');
}

// ===== IndexedDB =====
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('savedAt', 'savedAt', { unique: false });
        store.createIndex('korean', 'korean', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbTransaction(mode = 'readonly') {
  const tx = state.db.transaction(STORE_NAME, mode);
  return tx.objectStore(STORE_NAME);
}

async function saveExpression(expr) {
  return new Promise((resolve, reject) => {
    const store = dbTransaction('readwrite');
    const data = { ...expr, savedAt: new Date().toISOString() };
    const req = store.add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllExpressions() {
  return new Promise((resolve, reject) => {
    const store = dbTransaction('readonly');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteExpression(id) {
  return new Promise((resolve, reject) => {
    const store = dbTransaction('readwrite');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function clearAllExpressions() {
  return new Promise((resolve, reject) => {
    const store = dbTransaction('readwrite');
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ===== Speech Recognition =====
function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function checkSecureContext() {
  if (window.isSecureContext) return true;
  // Show a persistent warning
  const currentUrl = window.location.href;
  const httpsUrl = currentUrl.replace('http://', 'https://');
  showToast('⚠️ HTTPS 연결이 필요합니다');
  showSecurityBanner(httpsUrl);
  return false;
}

function showSecurityBanner(httpsUrl) {
  // Don't show duplicate banners
  if (document.getElementById('security-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'security-banner';
  banner.className = 'security-banner';
  banner.innerHTML = `
    <div class="security-banner-content">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M12 9v4"/><path d="M12 17h.01"/>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      </svg>
      <div>
        <strong>마이크 사용을 위해 HTTPS 연결이 필요합니다</strong>
        <p>보안 연결(HTTPS)에서만 마이크 권한을 요청할 수 있습니다.</p>
        <a href="${httpsUrl}" class="security-banner-link">🔒 HTTPS로 접속하기</a>
      </div>
    </div>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('이 브라우저에서는 음성 인식이 지원되지 않습니다');
    return false;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = false;   // KEY FIX: one utterance at a time
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;  // Get multiple candidates for better accuracy

  recognition.onresult = (e) => {
    // With continuous:false, e.results usually has just 1 entry
    const result = e.results[e.results.length - 1];

    if (result.isFinal) {
      // Pick best alternative by confidence
      const best = pickBestAlternative(result);
      const trimmed = best.transcript.trim();
      lastConfidence = best.confidence;

      // Track confidence history
      confidenceHistory.push(lastConfidence);
      if (confidenceHistory.length > 20) confidenceHistory.shift();

      updateConfidenceUI(lastConfidence);

      // Dedup: check if this text is substantially the same as the last committed segment
      if (trimmed && !isDuplicate(trimmed, lastCommittedSegment)) {
        // Accept results with reasonable confidence (> 0.15)
        if (lastConfidence > 0.15) {
          state.transcript += trimmed + ' ';
          lastCommittedSegment = trimmed;
        } else {
          // Very low confidence — show warning to user
          console.warn(`Low confidence result skipped (${(lastConfidence * 100).toFixed(0)}%): "${trimmed}"`);
          lowConfidenceStreak = (lowConfidenceStreak || 0) + 1;
          if (lowConfidenceStreak >= 3) {
            showToast('🔇 소리가 잘 들리지 않습니다. 마이크에 가까이 대고 말해주세요.');
            lowConfidenceStreak = 0;
          }
        }
      }
      state.interimTranscript = '';
    } else {
      // Show interim text as preview (use first alternative)
      state.interimTranscript = result[0].transcript;
    }
    updateTranscriptUI();
  };

  // Track whether the last recognition cycle had actual speech
  let lastCycleHadSpeech = false;
  let consecutiveSilence = 0;
  const MAX_CONSECUTIVE_SILENCE = 60; // ~60 silence cycles ≈ ~3-5 min of silence

  recognition.onresult = (function(originalOnResult) {
    return function(e) {
      lastCycleHadSpeech = true;
      consecutiveSilence = 0;
      originalOnResult(e);
    };
  })(recognition.onresult);

  recognition.onend = () => {
    state.interimTranscript = '';

    // Auto-restart for continuous listening (30-min timer handles the time limit)
    if (state.isListening) {
      // Only count restarts that actually processed speech
      if (lastCycleHadSpeech) {
        restartCount++;
      } else {
        consecutiveSilence++;
      }
      lastCycleHadSpeech = false;

      // Warn if prolonged silence detected
      if (consecutiveSilence === 30) {
        showToast('🔇 주변 소리가 감지되지 않습니다. 마이크를 확인해주세요.');
      }

      // Stop if silence is too long (microphone likely disconnected)
      if (consecutiveSilence >= MAX_CONSECUTIVE_SILENCE) {
        stopListening();
        showToast('⏸ 장시간 무음 상태로 수집이 일시정지되었습니다.');
        return;
      }

      clearTimeout(restartTimer);
      // Use longer delay on mobile to avoid rapid restart issues
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const restartDelay = isMobile ? 300 : 150;
      restartTimer = setTimeout(() => {
        if (state.isListening) {
          try { recognition.start(); } catch (e) {
            // On mobile, recognition.start() can fail if mic is busy
            // Retry once after a longer delay
            if (isMobile) {
              setTimeout(() => {
                if (state.isListening) {
                  try { recognition.start(); } catch (e2) {
                    console.warn('Recognition restart retry failed:', e2);
                  }
                }
              }, 500);
            }
          }
        }
      }, restartDelay);
    }
  };

  recognition.onerror = (e) => {
    console.warn('Speech recognition error:', e.error, e);
    if (e.error === 'not-allowed') {
      if (!window.isSecureContext) {
        showToast('⚠️ HTTPS 연결에서만 마이크를 사용할 수 있습니다');
        showSecurityBanner(window.location.href.replace('http://', 'https://'));
      } else if (isStandalonePWA()) {
        // In standalone PWA mode, permissions are often blocked
        showToast('⚠️ 마이크 권한이 차단되었습니다. 브라우저 앱 설정에서 마이크를 허용해주세요.');
        showMicPermissionGuide();
      } else {
        showToast('마이크 권한이 필요합니다. 브라우저 설정에서 마이크를 허용해주세요.');
      }
      state.isListening = false;
      stopListening();
    } else if (e.error === 'no-speech') {
      // Silence — mark this cycle as no speech (don't consume restart budget)
      lastCycleHadSpeech = false;
    } else if (e.error === 'aborted') {
      // Aborted by user or system — don't restart
    } else if (e.error === 'network') {
      showToast('네트워크 오류가 발생했습니다');
      stopListening();
    } else if (e.error === 'service-not-allowed') {
      // Speech recognition service not available (common in some PWA contexts)
      showToast('⚠️ 음성 인식 서비스를 사용할 수 없습니다. 브라우저에서 다시 시도해주세요.');
      state.isListening = false;
      stopListening();
    } else {
      console.warn('Speech error:', e.error);
    }
  };

  return true;
}

// Pick the best alternative from speech result based on confidence
function pickBestAlternative(result) {
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    if (result[i].confidence > best.confidence) {
      best = result[i];
    }
  }
  return best;
}

// Check if newText is a duplicate of lastText
function isDuplicate(newText, lastText) {
  if (!lastText) return false;
  const a = newText.replace(/\s+/g, '');
  const b = lastText.replace(/\s+/g, '');
  // Exact match
  if (a === b) return true;
  // One contains the other (partial repeat)
  if (a.length > 3 && b.length > 3) {
    if (a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

// Show microphone permission guide for standalone PWA users
function showMicPermissionGuide() {
  if (document.getElementById('mic-permission-guide')) return;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  let guideHtml = '';
  if (isIOS) {
    guideHtml = `
      <p><strong>🍎 iPhone/iPad 마이크 권한 설정:</strong></p>
      <ol>
        <li>Safari 브라우저에서 이 사이트를 열어주세요</li>
        <li>Safari에서 마이크 권한을 허용한 후 사용해주세요</li>
        <li>iOS PWA에서는 음성 인식이 제한될 수 있습니다</li>
      </ol>
    `;
  } else if (isAndroid) {
    guideHtml = `
      <p><strong>📱 Android 마이크 권한 설정:</strong></p>
      <ol>
        <li><strong>설정 → 앱 → Chrome</strong>에서 마이크 권한을 "허용"으로 변경</li>
        <li>Chrome 브라우저에서 이 사이트의 마이크 권한을 확인</li>
        <li>앱을 삭제 후 다시 설치해보세요</li>
      </ol>
    `;
  } else {
    guideHtml = `
      <p><strong>🖥️ 마이크 권한 설정:</strong></p>
      <ol>
        <li>브라우저 주소창의 자물쇠 아이콘 클릭</li>
        <li>사이트 설정에서 마이크를 "허용"으로 변경</li>
        <li>페이지를 새로고침하세요</li>
      </ol>
    `;
  }

  const guide = document.createElement('div');
  guide.id = 'mic-permission-guide';
  guide.className = 'mic-permission-guide';
  guide.innerHTML = `
    <div class="mic-permission-guide-content">
      <div class="mic-permission-guide-header">
        <span>🎤 마이크 권한 안내</span>
        <button class="mic-permission-guide-close" aria-label="닫기">✕</button>
      </div>
      ${guideHtml}
    </div>
  `;
  document.body.appendChild(guide);
  requestAnimationFrame(() => guide.classList.add('show'));

  guide.querySelector('.mic-permission-guide-close').addEventListener('click', () => {
    guide.classList.remove('show');
    setTimeout(() => guide.remove(), 300);
  });
}

// Pre-check and request microphone permission (critical for PWA standalone mode)
async function ensureMicrophonePermission() {
  try {
    // Check if permissions API is available
    if (navigator.permissions) {
      try {
        const permStatus = await navigator.permissions.query({ name: 'microphone' });
        if (permStatus.state === 'denied') {
          showToast('⚠️ 마이크 권한이 차단되어 있습니다.');
          showMicPermissionGuide();
          return false;
        }
        // If already granted, skip getUserMedia to avoid holding the mic
        if (permStatus.state === 'granted') {
          return true;
        }
      } catch (permErr) {
        // permissions.query may not support 'microphone' on all browsers
        console.warn('permissions.query not supported for microphone:', permErr);
      }
    }

    // Permission state is 'prompt' or unknown — trigger the permission dialog
    // via getUserMedia, then IMMEDIATELY release the stream so SpeechRecognition
    // can get exclusive mic access (critical on mobile)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // Release mic immediately
    return true;
  } catch (err) {
    console.error('Microphone permission request failed:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showToast('⚠️ 마이크 권한이 거부되었습니다.');
      showMicPermissionGuide();
    } else if (err.name === 'NotFoundError') {
      showToast('⚠️ 마이크 장치를 찾을 수 없습니다.');
    } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
      showToast('⚠️ 마이크가 다른 앱에서 사용 중입니다.');
    } else {
      showToast('⚠️ 마이크 접근에 실패했습니다: ' + err.message);
    }
    return false;
  }
}

// Initialize AudioContext for noise gate processing
// NOTE: On mobile, getUserMedia can conflict with SpeechRecognition for mic access.
// Only call this on desktop where mic sharing is supported.
async function initAudioProcessing() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // Resume AudioContext if suspended (required by mobile browsers after user gesture)
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const source = audioContext.createMediaStreamSource(audioStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.8;
    source.connect(analyserNode);

    noiseGateActive = true;
    monitorAudioLevel();
  } catch (err) {
    console.warn('Audio processing init failed:', err);
    // Continue without noise gate — speech recognition still works
  }
}

// Monitor audio level for visual feedback and noise gate
function monitorAudioLevel() {
  if (!noiseGateActive || !analyserNode) return;

  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(dataArray);

  // Calculate RMS volume
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const normalized = dataArray[i] / 255;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / dataArray.length);

  // Update waveform visualization intensity based on actual audio
  if (state.isListening && els.waveform) {
    const bars = els.waveform.querySelectorAll('span');
    const scale = Math.min(rms * 8, 1); // Amplify for visual
    bars.forEach((bar, i) => {
      const variance = 0.5 + Math.random() * 0.5;
      bar.style.transform = `scaleY(${0.3 + scale * variance})`;
    });
  }

  if (state.isListening) {
    requestAnimationFrame(monitorAudioLevel);
  }
}

function stopAudioProcessing() {
  noiseGateActive = false;
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  analyserNode = null;
}

async function startListening() {
  if (!checkSecureContext()) {
    showToast('⚠️ HTTPS 연결이 필요합니다. 보안 URL로 접속해주세요.');
    return;
  }

  // Step 1: Ensure microphone permission is granted
  // This triggers the permission prompt if needed, then immediately releases the mic
  const permGranted = await ensureMicrophonePermission();
  if (!permGranted) {
    return;
  }

  // Step 2: Initialize SpeechRecognition object
  if (!recognition && !initSpeechRecognition()) {
    showToast('⚠️ 이 브라우저에서는 음성 인식이 지원되지 않습니다.');
    return;
  }

  // Request wake lock to prevent screen sleep during recording
  await requestWakeLock();

  state.isListening = true;
  restartCount = 0;
  lastCommittedSegment = '';
  confidenceHistory = [];
  listenStartTime = Date.now();

  // Start timer display
  if (els.listenTimer) els.listenTimer.classList.remove('hidden');
  updateListenTimer();
  listenTimerInterval = setInterval(updateListenTimer, 1000);

  // Step 3: Start SpeechRecognition FIRST — it needs exclusive mic access on mobile
  try {
    recognition.start();
  } catch (e) {
    console.error('Recognition start failed:', e);
    try {
      recognition.stop();
      await new Promise(r => setTimeout(r, 300));
      recognition.start();
    } catch (e2) {
      showToast('⚠️ 음성 인식 시작에 실패했습니다. 페이지를 새로고침해주세요.');
      state.isListening = false;
      return;
    }
  }

  // Step 4: Audio visualization (desktop only)
  // On mobile, getUserMedia conflicts with SpeechRecognition for mic access.
  // Sharing the mic between getUserMedia and SpeechRecognition causes
  // SpeechRecognition to receive no audio on mobile Chrome/Safari.
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isMobile) {
    try {
      await initAudioProcessing();
    } catch (err) {
      console.warn('Audio processing init skipped:', err);
    }
  }

  els.micBtn.classList.add('listening');
  els.waveform.classList.add('active');
  els.micStatus.textContent = '대화를 듣고 있습니다... (최대 30분)';
  els.micStatus.classList.add('active');
  if (els.confidenceIndicator) els.confidenceIndicator.classList.remove('hidden');
  showToast('🎤 마이크가 활성화되었습니다. 한국어로 말해주세요.');
}

function stopListening() {
  state.isListening = false;
  clearTimeout(restartTimer);
  state.interimTranscript = '';

  // Clear timer
  if (listenTimerInterval) {
    clearInterval(listenTimerInterval);
    listenTimerInterval = null;
  }
  const elapsed = listenStartTime ? Date.now() - listenStartTime : 0;
  listenStartTime = null;

  // Release wake lock
  releaseWakeLock();

  if (recognition) {
    try { recognition.stop(); } catch (e) { /* ignore */ }
  }
  stopAudioProcessing();
  els.micBtn.classList.remove('listening');
  els.waveform.classList.remove('active');
  els.micStatus.textContent = '탭하여 대화 수집 시작';
  els.micStatus.classList.remove('active');
  if (els.confidenceIndicator) els.confidenceIndicator.classList.add('hidden');
  if (els.listenTimer) els.listenTimer.classList.add('hidden');

  // Show session summary
  if (confidenceHistory.length > 0) {
    const avg = confidenceHistory.reduce((a, b) => a + b, 0) / confidenceHistory.length;
    const avgPct = (avg * 100).toFixed(0);
    const elapsedMin = Math.floor(elapsed / 60000);
    const elapsedSec = Math.floor((elapsed % 60000) / 1000);
    const timeStr = elapsedMin > 0 ? `${elapsedMin}분 ${elapsedSec}초` : `${elapsedSec}초`;
    if (avg < 0.7) {
      showToast(`⏱ ${timeStr} 수집 완료 (신뢰도 ${avgPct}%) — 조용한 환경에서 또렷하게 말해보세요`);
    } else {
      showToast(`⏱ ${timeStr} 대화 수집 완료`);
    }
  }
}

// Update confidence indicator UI
function updateConfidenceUI(confidence) {
  if (!els.confidenceBar || !els.confidenceText) return;
  const pct = (confidence * 100).toFixed(0);
  els.confidenceBar.style.width = `${pct}%`;
  els.confidenceText.textContent = `${pct}%`;

  // Color based on confidence level
  if (confidence >= 0.85) {
    els.confidenceBar.className = 'confidence-bar high';
  } else if (confidence >= 0.6) {
    els.confidenceBar.className = 'confidence-bar medium';
  } else {
    els.confidenceBar.className = 'confidence-bar low';
  }
}

// ===== Timer & Wake Lock =====
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateListenTimer() {
  if (!listenStartTime) return;
  const elapsed = Date.now() - listenStartTime;
  if (els.listenElapsed) {
    els.listenElapsed.textContent = formatElapsed(elapsed);
  }
  // Update remaining time in status
  const remaining = MAX_LISTEN_MS - elapsed;
  if (remaining <= 60000 && remaining > 0) {
    els.micStatus.textContent = `⏰ 남은 시간: ${Math.ceil(remaining / 1000)}초`;
  }
  // Auto-stop at 30 minutes
  if (elapsed >= MAX_LISTEN_MS) {
    stopListening();
    showToast('⏰ 30분 최대 수집 시간에 도달했습니다. 학습 정리를 만들어보세요!');
  }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.warn('Wake Lock not available:', e);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function updateTranscriptUI() {
  const full = state.transcript + state.interimTranscript;
  if (full.trim()) {
    els.transcriptPlaceholder.classList.add('hidden');
    els.transcriptText.classList.remove('hidden');
    els.transcriptText.textContent = full;
    els.convertBtn.disabled = false;
    els.transcriptBox.scrollTop = els.transcriptBox.scrollHeight;
  } else {
    els.transcriptPlaceholder.classList.remove('hidden');
    els.transcriptText.classList.add('hidden');
    els.convertBtn.disabled = true;
  }
}

// ===== Gemini API =====
const SYSTEM_PROMPT = `당신은 한국어-일본어 전문 번역가이자 일본어 교사입니다.
사용자가 마이크로 수집한 한국어 대화 내용 전체를 분석하고, 그 중에서 일본어 학습에 가장 유용하고 핵심적인 표현들만 엄선하여 학습 자료로 정리해주세요.

중요 규칙:
1. 대화 전체를 분석한 뒤, 자주 등장하거나 일본어 학습에 꼭 필요한 핵심 표현만 5~10개 선별하세요
2. 모든 문장을 번역하지 마세요. 중복되거나 사소한 표현은 제외하세요
3. 각 표현의 중요도를 판단하세요:
   - "필수": 일상 대화에서 매우 자주 쓰이며 반드시 알아야 하는 표현
   - "자주사용": 자연스러운 대화를 위해 알아두면 좋은 표현
   - "유용": 특정 상황에서 유용한 표현
4. 한국어 표현의 어감을 감지하세요:
   - 반말(~해, ~야, ~어 등)이면 일본어도 캐주얼(タメ口)로 번역하고 detected_style을 "반말"로 설정
   - 존댓말(~요, ~습니다, ~세요 등)이면 일본어도 정중체(丁寧語)로 번역하고 detected_style을 "존댓말"로 설정
5. 메인 번역은 감지된 스타일로, 대안 번역은 반대 스타일로 제공
6. 한자에는 반드시 히라가나 읽기를 포함
7. 각 표현에 실제 사용 가능한 일본어 예문을 포함하세요
8. 대화 전체의 맥락을 요약하고, 학습 팁도 제공하세요
9. 해설은 한국어로 작성
10. 발음 표기는 로마자(romaji)가 아닌 한글로 작성하세요 (예: "오하요 고자이마스", "와타시와", "이쿠요")
11. 예문의 발음도 한글로 표기하세요
12. 반대 스타일 번역의 발음도 한글로 표기하세요

반드시 아래 JSON 형식으로만 응답하세요:
{
  "conversation_summary": "수집된 대화의 전체 맥락과 주제를 2~3문장으로 요약 (한국어)",
  "expressions": [
    {
      "korean": "원래 한국어 표현",
      "importance": "필수" 또는 "자주사용" 또는 "유용",
      "detected_style": "반말" 또는 "존댓말",
      "japanese": "메인 일본어 번역",
      "reading": "히라가나 읽기",
      "pronunciation": "한글 발음 표기 (예: 오하요 고자이마스)",
      "alt_style": "반대 스타일 이름",
      "alt_japanese": "반대 스타일 번역",
      "alt_reading": "반대 스타일 히라가나",
      "alt_pronunciation": "반대 스타일 한글 발음",
      "explanation": "간단한 문법/표현 해설 (한국어)",
      "example": "이 표현을 활용한 자연스러운 일본어 예문 1개",
      "example_pronunciation": "예문의 한글 발음 표기"
    }
  ],
  "study_tips": ["이 대화에서 배울 수 있는 학습 포인트나 팁 (한국어, 2~4개)"]
}`;

async function callGemini(model, koreanText) {
  const url = `${GEMINI_BASE}${model}:generateContent?key=${state.apiKey}`;
  const body = {
    contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n한국어 대화 내용:\n${koreanText}` }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `API 오류 (${res.status})`;
    const isQuota = res.status === 429 || msg.toLowerCase().includes('quota');
    const error = new Error(msg);
    error.isQuota = isQuota;
    throw error;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('API 응답이 비어있습니다');

  return JSON.parse(text);
}

async function translateToJapanese(koreanText) {
  if (!state.apiKey) {
    showToast('API 키를 먼저 설정해주세요');
    return null;
  }

  // Build model try order: selected model first, then others as fallback
  const modelsToTry = [state.model, ...FALLBACK_MODELS.filter(m => m !== state.model)];

  for (const model of modelsToTry) {
    try {
      showToast(`${model} 모델로 변환 중...`);
      const result = await callGemini(model, koreanText);
      // If fallback model succeeded, update preference
      if (model !== state.model) {
        state.model = model;
        localStorage.setItem('gemini_model', model);
        if (els.modelSelect) els.modelSelect.value = model;
        showToast(`${model} 모델로 자동 전환되었습니다`);
      }
      return result;
    } catch (err) {
      if (err.isQuota) {
        console.warn(`${model} 할당량 초과, 다음 모델 시도...`);
        continue;
      }
      throw err; // Non-quota error, don't retry
    }
  }

  throw new Error('모든 모델의 무료 할당량이 초과되었습니다. 잠시 후 다시 시도하거나 API 키의 유료 결제를 확인하세요.');
}

// ===== Chunked Analysis for Long Conversations =====
function splitTranscriptIntoChunks(text) {
  if (text.length <= CHUNK_CHAR_THRESHOLD) return [text];

  const chunks = [];
  const words = text.split(/\s+/);
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > CHUNK_CHAR_THRESHOLD && current.length > 0) {
      chunks.push(current.trim());
      current = word;
    } else {
      current += (current ? ' ' : '') + word;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

function mergeAnalysisResults(results) {
  const merged = {
    conversation_summary: results.map(r => r.conversation_summary).filter(Boolean).join(' '),
    expressions: [],
    study_tips: [],
  };

  const seenKorean = new Set();
  for (const result of results) {
    for (const expr of (result.expressions || [])) {
      const key = expr.korean?.replace(/\s+/g, '');
      if (key && !seenKorean.has(key)) {
        seenKorean.add(key);
        merged.expressions.push(expr);
      }
    }
    for (const tip of (result.study_tips || [])) {
      if (!merged.study_tips.includes(tip)) {
        merged.study_tips.push(tip);
      }
    }
  }

  merged.study_tips = merged.study_tips.slice(0, 5);
  return merged;
}

async function analyzeTranscript(text) {
  const chunks = splitTranscriptIntoChunks(text);

  if (chunks.length === 1) {
    return await translateToJapanese(chunks[0]);
  }

  // Long conversation — chunked analysis with progress
  const loadingLabel = els.loadingArea.querySelector('.section-label');
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    if (loadingLabel) {
      loadingLabel.textContent = `대화 분석 중... (${i + 1}/${chunks.length})`;
    }
    try {
      const result = await translateToJapanese(chunks[i]);
      if (result) results.push(result);
    } catch (err) {
      console.warn(`Chunk ${i + 1} failed:`, err.message);
    }
  }

  if (results.length === 0) {
    throw new Error('모든 구간의 분석에 실패했습니다');
  }

  if (loadingLabel) loadingLabel.textContent = '결과 정리 중...';
  return mergeAnalysisResults(results);
}

// ===== UI Rendering =====
function getImportanceClass(importance) {
  switch (importance) {
    case '필수': return 'importance-essential';
    case '자주사용': return 'importance-frequent';
    case '유용': return 'importance-useful';
    default: return 'importance-useful';
  }
}

function getImportanceIcon(importance) {
  switch (importance) {
    case '필수': return '🔴';
    case '자주사용': return '🟡';
    case '유용': return '🟢';
    default: return '🟢';
  }
}

function renderExpressionCard(expr, isSaved = false) {
  const styleClass = expr.detected_style === '반말' ? 'casual' : 'polite';
  const altLabel = expr.alt_style === '반말' ? '반말 버전' : '존댓말 버전';
  const importanceClass = getImportanceClass(expr.importance);
  const importanceIcon = getImportanceIcon(expr.importance);
  // Support both old field (romaji) and new field (pronunciation) for backward compatibility
  const pronunciation = expr.pronunciation || expr.romaji || '';
  const altPronunciation = expr.alt_pronunciation || '';
  const examplePronunciation = expr.example_pronunciation || '';

  const card = document.createElement('div');
  card.className = 'expr-card expr-card-collapsed';
  card.innerHTML = `
    <div class="card-summary" role="button" tabindex="0" aria-expanded="false">
      <div class="card-summary-content">
        <span class="card-summary-jp">${escHtml(expr.japanese)}</span>
        <span class="card-summary-kr">${escHtml(expr.korean)}</span>
      </div>
      <div class="card-summary-right">
        <span class="importance-badge ${importanceClass}">${importanceIcon}</span>
        <svg class="card-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="card-detail">
      <div class="card-top">
        <span class="importance-badge ${importanceClass}">${importanceIcon} ${escHtml(expr.importance || '유용')}</span>
        <span class="style-badge ${styleClass}">${expr.detected_style}</span>
      </div>
      <div class="card-korean">"${escHtml(expr.korean)}"</div>
      <div class="card-japanese">${escHtml(expr.japanese)}</div>
      <div class="card-reading">${escHtml(expr.reading)}</div>
      <div class="card-pronunciation">${escHtml(pronunciation)}</div>
      ${expr.example ? `
      <div class="card-example">
        <div class="label">📝 예문</div>
        <div class="example-jp">${escHtml(expr.example)}</div>
        ${examplePronunciation ? `<div class="example-pronunciation">${escHtml(examplePronunciation)}</div>` : ''}
      </div>
      ` : ''}
      <div class="card-explanation">
        <div class="label">💡 해설</div>
        ${escHtml(expr.explanation)}
      </div>
      <div class="card-alt">
        <div class="alt-label">${altLabel}</div>
        <div class="alt-jp">${escHtml(expr.alt_japanese)}</div>
        <div class="alt-reading">${escHtml(expr.alt_reading)}</div>
        ${altPronunciation ? `<div class="alt-pronunciation">${escHtml(altPronunciation)}</div>` : ''}
      </div>
      ${isSaved ? `
        <div class="card-date">${formatDate(expr.savedAt)}</div>
        <div class="card-actions">
          <button class="delete-btn" data-id="${expr.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6"/></svg>
            삭제
          </button>
        </div>
      ` : `
        <div class="card-actions">
          <button class="save-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            저장
          </button>
        </div>
      `}
    </div>
  `;

  // Toggle expand/collapse on summary click
  const summaryEl = card.querySelector('.card-summary');
  summaryEl.addEventListener('click', (e) => {
    // Don't toggle if clicking a button inside
    if (e.target.closest('.card-actions')) return;
    card.classList.toggle('expr-card-collapsed');
    card.classList.toggle('expr-card-expanded');
    const isExpanded = card.classList.contains('expr-card-expanded');
    summaryEl.setAttribute('aria-expanded', isExpanded);
  });
  summaryEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      summaryEl.click();
    }
  });

  // Event listeners
  if (isSaved) {
    card.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteExpression(expr.id);
      card.style.opacity = '0';
      card.style.transform = 'translateX(40px)';
      card.style.transition = 'all .3s ease';
      setTimeout(() => { card.remove(); renderNotes(); }, 300);
      showToast('표현이 삭제되었습니다');
    });
  } else {
    card.querySelector('.save-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const exprToSave = {
        korean: expr.korean,
        importance: expr.importance,
        detected_style: expr.detected_style,
        japanese: expr.japanese,
        reading: expr.reading,
        pronunciation: pronunciation,
        alt_style: expr.alt_style,
        alt_japanese: expr.alt_japanese,
        alt_reading: expr.alt_reading,
        alt_pronunciation: altPronunciation,
        explanation: expr.explanation,
        example: expr.example,
        example_pronunciation: examplePronunciation,
      };
      await saveExpression(exprToSave);
      trackSavedExpression(exprToSave); // Global ranking
      const btn = card.querySelector('.save-btn');
      btn.innerHTML = '✓ 저장됨';
      btn.disabled = true;
      btn.style.opacity = '.5';
      showToast('표현이 저장되었습니다');
    });
  }

  return card;
}

function renderStudyPaper(result) {
  els.resultsList.innerHTML = '';

  // Conversation summary section
  if (result.conversation_summary) {
    const summaryEl = document.createElement('div');
    summaryEl.className = 'study-summary';
    summaryEl.innerHTML = `
      <div class="study-summary-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        <span>대화 분석 요약</span>
      </div>
      <p>${escHtml(result.conversation_summary)}</p>
    `;
    els.resultsList.appendChild(summaryEl);
  }

  // Importance legend
  const legendEl = document.createElement('div');
  legendEl.className = 'importance-legend';
  legendEl.innerHTML = `
    <span class="legend-item"><span class="legend-dot essential"></span>필수</span>
    <span class="legend-item"><span class="legend-dot frequent"></span>자주사용</span>
    <span class="legend-item"><span class="legend-dot useful"></span>유용</span>
  `;
  els.resultsList.appendChild(legendEl);

  // Expression cards sorted by importance
  const importanceOrder = { '필수': 0, '자주사용': 1, '유용': 2 };
  const sorted = [...(result.expressions || [])].sort((a, b) =>
    (importanceOrder[a.importance] ?? 2) - (importanceOrder[b.importance] ?? 2)
  );
  sorted.forEach(expr => {
    els.resultsList.appendChild(renderExpressionCard(expr, false));
  });

  // Study tips section
  if (result.study_tips?.length) {
    const tipsEl = document.createElement('div');
    tipsEl.className = 'study-tips';
    tipsEl.innerHTML = `
      <div class="study-tips-header">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/><line x1="9" y1="21" x2="15" y2="21"/></svg>
        <span>학습 팁</span>
      </div>
      <ul>${result.study_tips.map(tip => `<li>${escHtml(tip)}</li>`).join('')}</ul>
    `;
    els.resultsList.appendChild(tipsEl);
  }
}

async function renderNotes() {
  let expressions = await getAllExpressions();
  const query = els.searchInput.value.trim().toLowerCase();

  if (query) {
    expressions = expressions.filter(e =>
      e.korean.toLowerCase().includes(query) ||
      e.japanese.toLowerCase().includes(query) ||
      e.reading.toLowerCase().includes(query)
    );
  }

  const sort = els.sortSelect.value;
  expressions.sort((a, b) => {
    const da = new Date(a.savedAt), db2 = new Date(b.savedAt);
    return sort === 'newest' ? db2 - da : da - db2;
  });

  els.notesCount.textContent = `저장된 표현 ${expressions.length}개`;
  els.notesList.innerHTML = '';

  if (expressions.length === 0) {
    els.notesEmpty.classList.remove('hidden');
  } else {
    els.notesEmpty.classList.add('hidden');
    expressions.forEach(expr => {
      els.notesList.appendChild(renderExpressionCard(expr, true));
    });
  }
}

// ===== Ranking System (Supabase Global) =====
const STATS_KEY = 'expression_analysis_stats';

function isSupabaseConfigured() {
  return state.supabaseUrl && state.supabaseKey;
}

function supabaseHeaders() {
  return {
    'apikey': state.supabaseKey,
    'Authorization': `Bearer ${state.supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };
}

// --- Supabase API: Read global rankings ---
async function getGlobalRankings(orderBy = 'analyze_count', limit = 10) {
  if (!isSupabaseConfigured()) return null;
  try {
    const url = `${state.supabaseUrl}/rest/v1/expression_rankings?select=*&order=${orderBy}.desc&limit=${limit}`;
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('Global ranking fetch failed:', err.message);
    return null;
  }
}

// --- Supabase API: Increment expression stats via RPC ---
async function incrementGlobalStat(expr, countType = 'analyze') {
  if (!isSupabaseConfigured()) return;
  try {
    const url = `${state.supabaseUrl}/rest/v1/rpc/increment_expression_stat`;
    await fetch(url, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        p_korean: expr.korean?.trim() || '',
        p_japanese: expr.japanese || '',
        p_reading: expr.reading || '',
        p_pronunciation: expr.pronunciation || '',
        p_count_type: countType,
      }),
    });
  } catch (err) {
    console.warn('Global stat increment failed:', err.message);
  }
}

// --- Local stats (fallback) ---
function getAnalysisStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
  } catch {
    return {};
  }
}

function trackAnalyzedExpressions(expressions) {
  // Local tracking
  const stats = getAnalysisStats();
  for (const expr of expressions) {
    const key = expr.korean?.trim();
    if (!key) continue;
    if (stats[key]) {
      stats[key].count++;
      stats[key].lastSeen = Date.now();
    } else {
      stats[key] = {
        count: 1,
        japanese: expr.japanese,
        reading: expr.reading,
        pronunciation: expr.pronunciation || '',
        importance: expr.importance || '유용',
        lastSeen: Date.now(),
      };
    }
  }
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));

  // Global tracking (fire-and-forget)
  if (isSupabaseConfigured()) {
    for (const expr of expressions) {
      incrementGlobalStat(expr, 'analyze');
    }
  }
}

function trackSavedExpression(expr) {
  if (isSupabaseConfigured()) {
    incrementGlobalStat(expr, 'save');
  }
}

function getTopAnalyzed(limit = 10) {
  const stats = getAnalysisStats();
  return Object.entries(stats)
    .map(([korean, data]) => ({ korean, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function renderRankingCard(item, rank, maxCount, type) {
  const count = type === 'analyzed' ? (item.analyze_count || item.count || 0) : (item.save_count || item.count || 0);
  const percent = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  const medals = ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'];
  const rankDisplay = rank <= 3 ? medals[rank - 1] : `<span class="rank-num">${rank}</span>`;

  const card = document.createElement('div');
  card.className = 'ranking-card';
  card.innerHTML = `
    <div class="ranking-card-rank">${rankDisplay}</div>
    <div class="ranking-card-content">
      <div class="ranking-card-jp">${item.japanese || ''}</div>
      <div class="ranking-card-kr">${item.korean || ''}</div>
      ${item.pronunciation ? `<div class="ranking-card-pron">${item.pronunciation}</div>` : ''}
    </div>
    <div class="ranking-card-stat">
      <span class="ranking-card-count">${count}${type === 'analyzed' ? '\ud68c' : '\ubc88'}</span>
      <div class="ranking-bar-track">
        <div class="ranking-bar-fill" style="width:${percent}%"></div>
      </div>
    </div>
  `;
  return card;
}

function updateConnectionStatus(online) {
  const el = $('#ranking-connection-status');
  if (!el) return;
  if (online) {
    el.innerHTML = `
      <span class="ranking-status-dot online"></span>
      <span>\uae00\ub85c\ubc8c \ub7ad\ud0b9 \uc5f0\uacb0\ub428 \u2014 \ubaa8\ub4e0 \uc0ac\uc6a9\uc790\uc758 \ub370\uc774\ud130\ub97c \ud45c\uc2dc\ud569\ub2c8\ub2e4</span>
    `;
  } else {
    el.innerHTML = `
      <span class="ranking-status-dot offline"></span>
      <span>\uc624\ud504\ub77c\uc778 \ubaa8\ub4dc \u2014 \uc124\uc815\uc5d0\uc11c Supabase\ub97c \uc5f0\uacb0\ud558\uba74 \uae00\ub85c\ubc8c \ub7ad\ud0b9\uc744 \ubcfc \uc218 \uc788\uc2b5\ub2c8\ub2e4</span>
    `;
  }
}

async function renderRanking() {
  const analyzedList = $('#ranking-analyzed-list');
  const analyzedEmpty = $('#ranking-analyzed-empty');
  const savedList = $('#ranking-saved-list');
  const savedEmpty = $('#ranking-saved-empty');

  const useGlobal = isSupabaseConfigured();

  // --- Top Analyzed ---
  analyzedList.innerHTML = '';
  if (useGlobal) {
    const globalAnalyzed = await getGlobalRankings('analyze_count', 10);
    if (globalAnalyzed && globalAnalyzed.length > 0) {
      updateConnectionStatus(true);
      analyzedEmpty.classList.add('hidden');
      const maxCount = globalAnalyzed[0].analyze_count || 1;
      globalAnalyzed.forEach((item, i) => {
        analyzedList.appendChild(renderRankingCard(item, i + 1, maxCount, 'analyzed'));
      });
    } else if (globalAnalyzed) {
      updateConnectionStatus(true);
      analyzedEmpty.classList.remove('hidden');
    } else {
      // Fetch failed — fall back to local
      updateConnectionStatus(false);
      renderLocalAnalyzed(analyzedList, analyzedEmpty);
    }
  } else {
    updateConnectionStatus(false);
    renderLocalAnalyzed(analyzedList, analyzedEmpty);
  }

  // --- Top Saved ---
  savedList.innerHTML = '';
  if (useGlobal) {
    const globalSaved = await getGlobalRankings('save_count', 10);
    if (globalSaved && globalSaved.length > 0) {
      savedEmpty.classList.add('hidden');
      const maxCount = globalSaved[0].save_count || 1;
      globalSaved.forEach((item, i) => {
        savedList.appendChild(renderRankingCard(item, i + 1, maxCount, 'saved'));
      });
    } else if (globalSaved) {
      savedEmpty.classList.remove('hidden');
    } else {
      renderLocalSaved(savedList, savedEmpty);
    }
  } else {
    renderLocalSaved(savedList, savedEmpty);
  }
}

function renderLocalAnalyzed(listEl, emptyEl) {
  const topAnalyzed = getTopAnalyzed(10);
  if (topAnalyzed.length === 0) {
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    const maxCount = topAnalyzed[0].count;
    topAnalyzed.forEach((item, i) => {
      listEl.appendChild(renderRankingCard(item, i + 1, maxCount, 'analyzed'));
    });
  }
}

async function renderLocalSaved(listEl, emptyEl) {
  const allSaved = await getAllExpressions();
  if (allSaved.length === 0) {
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    const savedCounts = {};
    for (const expr of allSaved) {
      const key = expr.korean?.trim();
      if (!key) continue;
      if (savedCounts[key]) {
        savedCounts[key].count++;
      } else {
        savedCounts[key] = {
          count: 1, korean: key, japanese: expr.japanese,
          reading: expr.reading, pronunciation: expr.pronunciation || '',
          savedAt: expr.savedAt,
        };
      }
    }
    const topSaved = Object.values(savedCounts)
      .sort((a, b) => b.count - a.count || new Date(b.savedAt) - new Date(a.savedAt))
      .slice(0, 10);
    const maxSaved = topSaved[0]?.count || 1;
    topSaved.forEach((item, i) => {
      listEl.appendChild(renderRankingCard(item, i + 1, maxSaved, 'saved'));
    });
  }
}

// ===== Event Handlers =====
function initEvents() {
  // Tab navigation
  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $$('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-content').forEach(tc => tc.classList.remove('active'));
      $(`#tab-${tab}`).classList.add('active');
      if (tab === 'notes') renderNotes();
      if (tab === 'ranking') renderRanking();
    });
  });

  // Mic toggle
  els.micBtn.addEventListener('click', () => {
    if (state.isListening) {
      stopListening();
    } else {
      if (!state.apiKey) {
        els.apiModal.classList.add('active');
        return;
      }
      startListening();
    }
  });

  // Convert button — generate study paper from collected conversation
  els.convertBtn.addEventListener('click', async () => {
    const text = state.transcript.trim();
    if (!text) return;

    if (state.isListening) stopListening();

    els.resultsArea.classList.add('hidden');
    els.loadingArea.classList.remove('hidden');
    // Reset loading label
    const loadingLabel = els.loadingArea.querySelector('.section-label');
    if (loadingLabel) loadingLabel.textContent = '대화 분석 중...';
    els.convertBtn.disabled = true;

    try {
      const result = await analyzeTranscript(text);
      els.loadingArea.classList.add('hidden');

      if (result?.expressions?.length) {
        // Track analysis stats for ranking
        trackAnalyzedExpressions(result.expressions);
        renderStudyPaper(result);
        els.resultsArea.classList.remove('hidden');
        showToast(`✨ ${result.expressions.length}개 핵심 표현을 찾았습니다`);
      } else {
        showToast('핵심 표현을 찾지 못했습니다');
      }
    } catch (err) {
      els.loadingArea.classList.add('hidden');
      showToast('분석 오류: ' + err.message);
      console.error(err);
    }

    els.convertBtn.disabled = false;
  });

  // Clear transcript
  els.clearTranscriptBtn.addEventListener('click', () => {
    state.transcript = '';
    lastCommittedSegment = '';
    state.interimTranscript = '';
    updateTranscriptUI();
    els.resultsArea.classList.add('hidden');
    els.resultsList.innerHTML = '';
  });

  // API key & model - settings tab
  els.saveApiBtn.addEventListener('click', () => {
    const key = els.apiKeyInput.value.trim();
    if (key) {
      state.apiKey = key;
      localStorage.setItem('gemini_api_key', key);
    }
    const model = els.modelSelect.value;
    state.model = model;
    localStorage.setItem('gemini_model', model);
    updateApiStatus();
    showToast('설정이 저장되었습니다');
  });

  // API key - modal
  els.modalSaveBtn.addEventListener('click', () => {
    const key = els.modalApiInput.value.trim();
    if (key) {
      state.apiKey = key;
      localStorage.setItem('gemini_api_key', key);
      els.apiKeyInput.value = key;
      els.apiModal.classList.remove('active');
      updateApiStatus();
      showToast('설정 완료! 대화를 시작해보세요');
    } else {
      showToast('API 키를 입력해주세요');
    }
  });

  // Search
  els.searchInput.addEventListener('input', debounce(() => renderNotes(), 300));

  // Sort
  els.sortSelect.addEventListener('change', () => renderNotes());

  // Export
  els.exportBtn.addEventListener('click', async () => {
    const data = await getAllExpressions();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hanashite-manabu-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('데이터가 내보내기되었습니다');
  });

  // Import
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Invalid format');
      for (const expr of data) {
        const { id, ...rest } = expr;
        await saveExpression(rest);
      }
      showToast(`${data.length}개의 표현을 가져왔습니다`);
      renderNotes();
    } catch (err) {
      showToast('가져오기 오류: 올바른 JSON 파일인지 확인하세요');
    }
    els.importFile.value = '';
  });

  // Clear all
  els.clearAllBtn.addEventListener('click', async () => {
    if (confirm('저장된 모든 표현을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) {
      await clearAllExpressions();
      renderNotes();
      showToast('모든 데이터가 삭제되었습니다');
    }
  });

  // Ranking reset
  const rankingResetBtn = $('#ranking-reset-btn');
  if (rankingResetBtn) {
    rankingResetBtn.addEventListener('click', () => {
      if (confirm('로컬 분석 통계를 초기화하시겠습니까?\n저장된 표현은 유지됩니다.')) {
        localStorage.removeItem(STATS_KEY);
        renderRanking();
        showToast('로컬 분석 통계가 초기화되었습니다');
      }
    });
  }

  // Supabase config save
  const saveSupabaseBtn = $('#save-supabase-btn');
  if (saveSupabaseBtn) {
    saveSupabaseBtn.addEventListener('click', async () => {
      const url = $('#supabase-url')?.value.trim().replace(/\/$/, '');
      const key = $('#supabase-key')?.value.trim();
      state.supabaseUrl = url;
      state.supabaseKey = key;
      if (url) localStorage.setItem('supabase_url', url);
      else localStorage.removeItem('supabase_url');
      if (key) localStorage.setItem('supabase_key', key);
      else localStorage.removeItem('supabase_key');
      updateSupabaseStatus();
      if (url && key) {
        // Test connection
        try {
          const test = await getGlobalRankings('analyze_count', 1);
          if (test !== null) {
            showToast('✅ Supabase 연결 성공! 글로벌 랭킹이 활성화되었습니다');
          } else {
            showToast('⚠️ Supabase 연결에 실패했습니다. URL과 키를 확인하세요');
          }
        } catch {
          showToast('⚠️ Supabase 연결에 실패했습니다');
        }
      } else {
        showToast('Supabase 설정이 제거되었습니다 (로컬 모드)');
      }
    });
  }
}

// ===== Helpers =====
function updateApiStatus() {
  if (state.apiKey) {
    els.apiStatus.className = 'api-status connected';
    els.apiStatusText.textContent = '연결됨';
    els.apiKeyInput.value = state.apiKey;
  } else {
    els.apiStatus.className = 'api-status disconnected';
    els.apiStatusText.textContent = '연결되지 않음';
  }
}

function updateSupabaseStatus() {
  const statusEl = $('#supabase-status');
  const statusText = $('#supabase-status-text');
  const urlInput = $('#supabase-url');
  const keyInput = $('#supabase-key');
  if (urlInput) urlInput.value = state.supabaseUrl;
  if (keyInput) keyInput.value = state.supabaseKey;
  if (statusEl && statusText) {
    if (isSupabaseConfigured()) {
      statusEl.className = 'api-status connected';
      statusText.textContent = '연결됨';
    } else {
      statusEl.className = 'api-status disconnected';
      statusText.textContent = '연결되지 않음';
    }
  }
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  els.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function escHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ===== Init =====
async function init() {
  cacheDom();
  state.db = await openDB();
  initEvents();
  updateApiStatus();
  updateSupabaseStatus();

  // Restore model selection
  if (els.modelSelect) {
    els.modelSelect.value = state.model;
  }

  // Show modal if no API key
  if (!state.apiKey) {
    els.apiModal.classList.add('active');
  }

  // Register service worker with update banner (required for PWA install)
  if ('serviceWorker' in navigator) {
    let newWorkerWaiting = null;

    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Check for updates on every page load
      reg.update();

      // Check for updates periodically (every 2 minutes)
      setInterval(() => reg.update(), 2 * 60 * 1000);

      // When a new SW is found, show update banner instead of auto-reloading
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          // New SW is installed and waiting to activate
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            newWorkerWaiting = newWorker;
            showUpdateBanner();
          }
        });
      });

      // Also check if there's already a waiting SW (from a previous visit)
      if (reg.waiting) {
        newWorkerWaiting = reg.waiting;
        showUpdateBanner();
      }

      // Handle controller change (when user accepts the update)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    }).catch((err) => console.warn('SW registration failed:', err));

    function showUpdateBanner() {
      const banner = document.getElementById('update-banner');
      if (!banner) return;
      requestAnimationFrame(() => banner.classList.add('show'));

      const acceptBtn = document.getElementById('update-btn-accept');
      const dismissBtn = document.getElementById('update-btn-dismiss');

      if (acceptBtn) {
        acceptBtn.onclick = () => {
          acceptBtn.textContent = '적용 중...';
          acceptBtn.disabled = true;
          // Tell the waiting SW to activate
          if (newWorkerWaiting) {
            newWorkerWaiting.postMessage('skipWaiting');
          }
        };
      }

      if (dismissBtn) {
        dismissBtn.onclick = () => {
          banner.classList.remove('show');
        };
      }
    }
  }

  // PWA Install Prompt
  let deferredPrompt = null;

  // Detect platform
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);
  const isMobile = isIOS || isAndroid;

  function showPlatformGuide() {
    // Hide all guides first
    if (els.installGuideAndroid) els.installGuideAndroid.classList.add('hidden');
    if (els.installGuideIos) els.installGuideIos.classList.add('hidden');
    if (els.installGuideDesktop) els.installGuideDesktop.classList.add('hidden');

    // Show the relevant guide
    if (isIOS && els.installGuideIos) {
      els.installGuideIos.classList.remove('hidden');
    } else if (isAndroid && els.installGuideAndroid) {
      els.installGuideAndroid.classList.remove('hidden');
    } else if (els.installGuideDesktop) {
      els.installGuideDesktop.classList.remove('hidden');
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
    // Update settings tab install button
    if (els.settingsInstallBtn) {
      els.settingsInstallBtn.disabled = false;
      els.settingsInstallBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        📲 바로 설치하기
      `;
    }
    if (els.installStatus) {
      els.installStatus.textContent = '✅ 설치 가능한 상태입니다. 위 버튼을 눌러주세요!';
      els.installStatus.className = 'install-status ready';
    }
  });

  // Settings tab install button handler
  if (els.settingsInstallBtn) {
    els.settingsInstallBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        // Auto-install available!
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        if (result.outcome === 'accepted') {
          showToast('🎉 앱이 설치되었습니다!');
          els.settingsInstallBtn.disabled = true;
          els.settingsInstallBtn.textContent = '✅ 설치됨';
          if (els.installStatus) {
            els.installStatus.textContent = '앱이 설치되었습니다!';
            els.installStatus.className = 'install-status installed';
          }
        }
        deferredPrompt = null;
      } else {
        // No auto-install — show manual guide for current platform
        showPlatformGuide();
        showToast('아래 안내를 따라 수동으로 설치해주세요 👇');
      }
    });
  }

  // On iOS, always show install guide (no beforeinstallprompt support)
  if (isIOS) {
    showPlatformGuide();
    if (els.settingsInstallBtn) {
      els.settingsInstallBtn.textContent = '📋 설치 방법 보기';
    }
  }

  function showInstallBanner() {
    // Don't show if already installed or dismissed recently
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (localStorage.getItem('install_dismissed') === 'true') return;

    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.innerHTML = `
      <div class="install-banner-content">
        <div class="install-banner-text">
          <strong>📱 앱으로 설치하기</strong>
          <span>홈 화면에 추가하면 더 편리하게 사용할 수 있어요!</span>
        </div>
        <div class="install-banner-actions">
          <button id="install-accept-btn" class="install-btn-accept">설치</button>
          <button id="install-dismiss-btn" class="install-btn-dismiss">나중에</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);

    // Animate in
    requestAnimationFrame(() => banner.classList.add('show'));

    document.getElementById('install-accept-btn').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        if (result.outcome === 'accepted') {
          showToast('🎉 앱이 설치되었습니다!');
          if (els.settingsInstallBtn) {
            els.settingsInstallBtn.disabled = true;
            els.settingsInstallBtn.textContent = '✅ 설치됨';
          }
        }
        deferredPrompt = null;
      }
      banner.remove();
    });

    document.getElementById('install-dismiss-btn').addEventListener('click', () => {
      localStorage.setItem('install_dismissed', 'true');
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 300);
    });
  }

  // Detect if already running as installed PWA
  if (window.matchMedia('(display-mode: standalone)').matches) {
    document.body.classList.add('pwa-standalone');
    if (els.settingsInstallBtn) {
      els.settingsInstallBtn.disabled = true;
      els.settingsInstallBtn.textContent = '✅ 이미 앱으로 실행 중';
    }
    if (els.installStatus) {
      els.installStatus.textContent = '현재 앱 모드로 실행 중입니다';
      els.installStatus.className = 'install-status installed';
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
