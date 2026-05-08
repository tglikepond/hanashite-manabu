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

// ===== App State =====
const state = {
  isListening: false,
  transcript: '',
  interimTranscript: '',
  apiKey: localStorage.getItem('gemini_api_key') || '',
  model: localStorage.getItem('gemini_model') || 'gemini-2.0-flash-lite',
  db: null,
};

let recognition = null;
let restartTimer = null;
let currentSessionText = '';  // Current session's recognized text (replaced, not appended)
let restartCount = 0;
const MAX_RESTARTS = 50;

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
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    let finalText = '';
    let interim = '';

    // Rebuild ALL final results for this session (replace, not append)
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalText += e.results[i][0].transcript + ' ';
      } else {
        interim = e.results[i][0].transcript;
      }
    }

    // REPLACE session text (not append) — this prevents duplication
    currentSessionText = finalText;
    state.interimTranscript = interim;
    updateTranscriptUI();
  };

  recognition.onend = () => {
    // Commit current session text to permanent transcript before restart
    if (currentSessionText.trim()) {
      state.transcript += currentSessionText;
      currentSessionText = '';
    }
    state.interimTranscript = '';

    // Auto-restart with delay
    if (state.isListening && restartCount < MAX_RESTARTS) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (state.isListening) {
          restartCount++;
          try { recognition.start(); } catch (e) { /* ignore */ }
        }
      }, 500);
    } else if (restartCount >= MAX_RESTARTS) {
      stopListening();
      showToast('장시간 대화 수집이 종료되었습니다. 다시 시작해주세요.');
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      if (!window.isSecureContext) {
        showToast('⚠️ HTTPS 연결에서만 마이크를 사용할 수 있습니다');
        showSecurityBanner(window.location.href.replace('http://', 'https://'));
      } else {
        showToast('마이크 권한이 필요합니다. 브라우저 설정에서 마이크를 허용해주세요.');
      }
      // Stop completely on permission error to prevent popup loop
      state.isListening = false;
      stopListening();
    } else if (e.error === 'no-speech') {
      // Silence — don't log, don't stop
    } else if (e.error === 'aborted') {
      // Aborted by user or system — don't restart
    } else if (e.error === 'network') {
      showToast('네트워크 오류가 발생했습니다');
      stopListening();
    } else {
      console.warn('Speech error:', e.error);
    }
  };

  return true;
}

function startListening() {
  // Check for secure context (HTTPS) first
  if (!checkSecureContext()) return;
  if (!recognition && !initSpeechRecognition()) return;
  state.isListening = true;
  restartCount = 0;
  try { recognition.start(); } catch (e) { /* already started */ }
  els.micBtn.classList.add('listening');
  els.waveform.classList.add('active');
  els.micStatus.textContent = '대화를 듣고 있습니다...';
  els.micStatus.classList.add('active');
}

function stopListening() {
  state.isListening = false;
  clearTimeout(restartTimer);
  // Commit any remaining session text
  if (currentSessionText.trim()) {
    state.transcript += currentSessionText;
    currentSessionText = '';
  }
  state.interimTranscript = '';
  if (recognition) {
    try { recognition.stop(); } catch (e) { /* ignore */ }
  }
  els.micBtn.classList.remove('listening');
  els.waveform.classList.remove('active');
  els.micStatus.textContent = '탭하여 대화 수집 시작';
  els.micStatus.classList.remove('active');
}

function updateTranscriptUI() {
  // Full text = committed sessions + current session + interim
  const full = state.transcript + currentSessionText + state.interimTranscript;
  if (full.trim()) {
    els.transcriptPlaceholder.classList.add('hidden');
    els.transcriptText.classList.remove('hidden');
    els.transcriptText.textContent = full;
    els.convertBtn.disabled = false;
    // Auto-scroll to bottom
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
      "romaji": "로마자 발음",
      "alt_style": "반대 스타일 이름",
      "alt_japanese": "반대 스타일 번역",
      "alt_reading": "반대 스타일 히라가나",
      "explanation": "간단한 문법/표현 해설 (한국어)",
      "example": "이 표현을 활용한 자연스러운 일본어 예문 1개"
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

  const card = document.createElement('div');
  card.className = 'expr-card';
  card.innerHTML = `
    <div class="card-top">
      <span class="importance-badge ${importanceClass}">${importanceIcon} ${escHtml(expr.importance || '유용')}</span>
      <span class="style-badge ${styleClass}">${expr.detected_style}</span>
    </div>
    <div class="card-korean">"${escHtml(expr.korean)}"</div>
    <div class="card-japanese">${escHtml(expr.japanese)}</div>
    <div class="card-reading">${escHtml(expr.reading)}</div>
    <div class="card-romaji">${escHtml(expr.romaji)}</div>
    ${expr.example ? `
    <div class="card-example">
      <div class="label">📝 예문</div>
      ${escHtml(expr.example)}
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
  `;

  // Event listeners
  if (isSaved) {
    card.querySelector('.delete-btn')?.addEventListener('click', async () => {
      await deleteExpression(expr.id);
      card.style.opacity = '0';
      card.style.transform = 'translateX(40px)';
      card.style.transition = 'all .3s ease';
      setTimeout(() => { card.remove(); renderNotes(); }, 300);
      showToast('표현이 삭제되었습니다');
    });
  } else {
    card.querySelector('.save-btn')?.addEventListener('click', async () => {
      const exprToSave = {
        korean: expr.korean,
        importance: expr.importance,
        detected_style: expr.detected_style,
        japanese: expr.japanese,
        reading: expr.reading,
        romaji: expr.romaji,
        alt_style: expr.alt_style,
        alt_japanese: expr.alt_japanese,
        alt_reading: expr.alt_reading,
        explanation: expr.explanation,
        example: expr.example,
      };
      await saveExpression(exprToSave);
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
    els.convertBtn.disabled = true;

    try {
      const result = await translateToJapanese(text);
      els.loadingArea.classList.add('hidden');

      if (result?.expressions?.length) {
        renderStudyPaper(result);
        els.resultsArea.classList.remove('hidden');
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
    currentSessionText = '';
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

  // Restore model selection
  if (els.modelSelect) {
    els.modelSelect.value = state.model;
  }

  // Show modal if no API key
  if (!state.apiKey) {
    els.apiModal.classList.add('active');
  }

  // Register service worker (required for PWA install)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Check for updates periodically
      setInterval(() => reg.update(), 5 * 60 * 1000);
    }).catch((err) => console.warn('SW registration failed:', err));
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
