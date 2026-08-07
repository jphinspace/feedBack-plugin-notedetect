// FeedBack note detection and scoring.
// createNoteDetector() returns isolated instances; bootstrap creates the default instance.
// Factory design originally contributed by topkoa in PR #2.

// Support desktop hosts that still expose the legacy bridge name.
try {
    if (typeof window !== 'undefined' && !window.feedBackDesktop && window.slopsmithDesktop) {
        window.feedBackDesktop = window.slopsmithDesktop;
    }
} catch (_) {  }

// Persist cross-instance resources across hot reloads and duplicate script loads.
const _ndShared = (window.__ndShared = window.__ndShared || {
    model: null,
    modelLoading: false,
    instances: new Set(),
    playSongRetries: 0,

    currentFilename: null,

    containedSlotOwners: new Map(),

    diagnosticReturn: {
        active: false,
        previousFilename: null,
        previousArrangementIndex: null,
        previousTitle: null,
        previousArtist: null,
        launchedTrackId: null,
        diagnosticFilename: null,
    },
});

if (!_ndShared.diagnosticReturn) {
    _ndShared.diagnosticReturn = {
        active: false,
        previousFilename: null,
        previousArrangementIndex: null,
        previousTitle: null,
        previousArtist: null,
        launchedTrackId: null,
        diagnosticFilename: null,
    };
}

const _ndInstances = _ndShared.instances;

// Enable the shared ML detector only while at least one instance needs it.
if (!_ndShared.mlGateWanters) _ndShared.mlGateWanters = new Set();
if (typeof _ndShared.mlGateOn !== 'boolean') _ndShared.mlGateOn = false;
function _ndSyncMlGate(token, wantsMl, audio) {
    const wanters = _ndShared.mlGateWanters;
    if (wantsMl) wanters.add(token); else wanters.delete(token);
    const desired = wanters.size > 0;
    if (desired === _ndShared.mlGateOn) return;
    if (!audio || typeof audio.setNoteDetectionEnabled !== 'function') return;
    try {
        audio.setNoteDetectionEnabled(desired);
        _ndShared.mlGateOn = desired;
    } catch (_) {  }
}

const _ND_DIAGNOSTIC_FILENAME_MARKERS = [
    'slopsmith-diagnostic-basic-guitar.sloppak',
];

function _ndFilenameLooksDiagnostic(fn) {
    const lower = String(fn || '').toLowerCase();
    if (!lower) return false;
    return _ND_DIAGNOSTIC_FILENAME_MARKERS.some((m) => lower.includes(m));
}

function _ndEscapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _ndClearDiagnosticReturnState() {
    const r = _ndShared.diagnosticReturn;
    if (!r) return;
    r.active = false;
    r.previousFilename = null;
    r.previousArrangementIndex = null;
    r.previousTitle = null;
    r.previousArtist = null;
    r.launchedTrackId = null;
    r.diagnosticFilename = null;
}

// Runtime constants and persisted-setting identifiers.
const _ND_STORAGE_KEY = 'slopsmith_notedetect';

const _ND_AUTO_ENABLE_RETRY_MS = 1500;

const _ND_VERSION = '1.32.2';

const _ND_HARMONIC_FALLBACK_MAX_HZ = 140;
const _ND_HARMONIC_FALLBACK_RATIOS = [1, 2, 3, 4, 5];
const _ND_HARMONIC_FALLBACK_HALF_CENTS = 80;
const _ND_HARMONIC_FALLBACK_PEAK_FRAC = 0.40;
const _ND_HARMONIC_FALLBACK_MIN_HARMONICS = 3;

const _ND_LOW_ENERGY_RESCUE_FLOOR = 0.015;

const _ND_PRESENCE_MIN_COMB = 2;

const _ND_MIN_YIN_SAMPLES = 4096;

const _ND_FRAME_SIZE = 1024;

const _ND_VALID_FRAME_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384];
function _ndClampFrameSize(v) {
    v = Number(v);
    return _ND_VALID_FRAME_SIZES.includes(v) ? v : 2048;
}

const _ND_VERIFY_PITCH_CENTS = 50;

const _ND_VERIFY_PITCH_CENTS_BASS = 60;

const _ND_VERIFY_HARMONIC_SNR = 3.0;

const _ND_VERIFY_HARMONIC_SNR_BASS = 2.0;

const _ND_VERIFY_FUNDAMENTAL_RATIO = 0.20;
const _ND_VERIFY_FUNDAMENTAL_RATIO_BASS = 0.08;

const _ND_VERIFY_PRESENCE_RATIO = 0.0;
const _ND_VERIFY_PRESENCE_RATIO_BASS = 0.3;

const _ND_VERIFY_MIN_HIT_RATIO = 0.5;

function _ndVerifyParamsFor(arrangement) {
    const bass = arrangement === 'bass';
    return {
        pitchCheckCents: bass ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
        harmonicSnr: bass ? _ND_VERIFY_HARMONIC_SNR_BASS : _ND_VERIFY_HARMONIC_SNR,
        fundamentalRatio: bass ? _ND_VERIFY_FUNDAMENTAL_RATIO_BASS : _ND_VERIFY_FUNDAMENTAL_RATIO,
        presenceRatio: bass ? _ND_VERIFY_PRESENCE_RATIO_BASS : _ND_VERIFY_PRESENCE_RATIO,
    };
}

// Absolute open-string MIDI values, ordered from lowest to highest string.
const _ND_TUNING_BASS_4 = [28, 33, 38, 43];
const _ND_TUNING_BASS_5 = [23, 28, 33, 38, 43];
const _ND_TUNING_BASS_6 = [23, 28, 33, 38, 43, 48];
const _ND_TUNING_GUITAR_6 = [40, 45, 50, 55, 59, 64];
const _ND_TUNING_GUITAR_7 = [35, 40, 45, 50, 55, 59, 64];
const _ND_TUNING_GUITAR_8 = [30, 35, 40, 45, 50, 55, 59, 64];

const _CAL_WIZARD_INSTRUMENT_CONFIGS = [
    { id: 'bass-4',   label: '4-string bass',          arrangement: 'bass',   stringCount: 4 },
    { id: 'bass-5',   label: '5-string bass',          arrangement: 'bass',   stringCount: 5 },
    { id: 'bass-6',   label: '6-string bass',          arrangement: 'bass',   stringCount: 6 },
    { id: 'guitar-6', label: '6-string guitar',        arrangement: 'guitar', stringCount: 6 },
    { id: 'guitar-7', label: '7-string guitar',        arrangement: 'guitar', stringCount: 7 },
    { id: 'guitar-8', label: '8-string guitar',        arrangement: 'guitar', stringCount: 8 },
];

function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

function _ndStandardMidiFor(arrangement, stringCount) {
    if (arrangement === 'bass') {
        if (stringCount === 6) return _ND_TUNING_BASS_6;
        return stringCount === 5 ? _ND_TUNING_BASS_5 : _ND_TUNING_BASS_4;
    }
    if (stringCount === 8) return _ND_TUNING_GUITAR_8;
    if (stringCount === 7) return _ND_TUNING_GUITAR_7;
    return _ND_TUNING_GUITAR_6;
}

// Verification targets are valid only within the tuning context that created them.
function _ndVerifySigFor(arrangement, stringCount, offsets, capo) {
    return arrangement + '|' + stringCount + '|'
        + offsets.slice(0, stringCount).join(',') + '|' + capo;
}

function _ndSanitizeVerifyCtx(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const rawOpen = Array.isArray(ctx.openMidis) ? ctx.openMidis : null;
    const rawOff = Array.isArray(ctx.tuning) ? ctx.tuning
        : (Array.isArray(ctx.offsets) ? ctx.offsets : null);

    const srcLen = (rawOpen && rawOpen.length) || (rawOff && rawOff.length) || 0;
    const explicitArr = (ctx.arrangement != null)
        ? _ndArrangementKindFromName(ctx.arrangement) : null;
    let stringCount = Number.isInteger(ctx.stringCount) && ctx.stringCount > 0
        ? ctx.stringCount
        : (srcLen || ((explicitArr || 'guitar') === 'bass' ? 4 : 6));
    stringCount = Math.max(1, Math.min(8, stringCount));

    const arrangement = explicitArr
        || (rawOpen ? _ndInferArrangementFromOpenMidis(rawOpen, stringCount) : 'guitar');

    stringCount = Math.min(stringCount, arrangement === 'bass' ? 5 : 8);
    const offsets = [];
    let capo;
    if (rawOpen) {

        const base = _ndStandardMidiFor(arrangement, stringCount);
        for (let s = 0; s < stringCount; s++) {
            const m = rawOpen[s];
            offsets.push(Number.isFinite(m) && Number.isFinite(base[s])
                ? Math.round(m - base[s]) : 0);
        }

        capo = 0;
    } else {

        for (let s = 0; s < stringCount; s++) {
            const v = rawOff ? rawOff[s] : 0;
            offsets.push(Number.isFinite(v) ? Math.trunc(v) : 0);
        }
        capo = Number.isInteger(ctx.capo) && ctx.capo >= 0 ? ctx.capo : 0;
    }
    return { arrangement, stringCount, offsets, capo };
}

function _ndInferArrangementFromOpenMidis(openMidis, stringCount) {
    const totalDistance = (arrangement) => {
        const base = _ndStandardMidiFor(arrangement, stringCount);
        let sum = 0;
        for (let s = 0; s < stringCount; s++) {
            const m = openMidis[s];
            sum += (Number.isFinite(m) && Number.isFinite(base[s])) ? Math.abs(m - base[s]) : 12;
        }
        return sum;
    };
    return totalDistance('bass') < totalDistance('guitar') ? 'bass' : 'guitar';
}

// Pure pitch, fingering, timing, and scoring helpers.
function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

const _ND_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function _ndMidiToName(midi) {
    const rounded = Math.round(midi);
    const pc = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return _ND_PITCH_NAMES[pc] + octave;
}

function _ndMidiFromStringFret(string, fret, arrangement, stringCount, offsets, capo) {
    const base = _ndStandardMidiFor(arrangement, stringCount);
    const offset = offsets && offsets[string] !== undefined ? offsets[string] : 0;
    return base[string] + offset + (capo || 0) + fret;
}

function _ndClassifyTiming(timingErrorMs, timingThresholdMs, lateGraceMs) {
    if (!Number.isFinite(timingErrorMs)) return null;
    const grace = Number.isFinite(lateGraceMs) && lateGraceMs > 0 ? lateGraceMs : 0;

    if (timingErrorMs < 0) {
        return Math.abs(timingErrorMs) <= timingThresholdMs ? 'OK' : 'EARLY';
    }
    return timingErrorMs <= timingThresholdMs + grace ? 'OK' : 'LATE';
}

function _ndClassifyPitch(pitchErrorCents, pitchThresholdCents) {
    if (!Number.isFinite(pitchErrorCents)) return null;
    return Math.abs(pitchErrorCents) <= pitchThresholdCents
        ? 'OK'
        : (pitchErrorCents > 0 ? 'SHARP' : 'FLAT');
}

const ND_BASE_SINGLE = 50;
const ND_BASE_CHORD  = 100;

function _ndMultiplierForStreak(streak) {
    return streak >= 50 ? 4 : streak >= 25 ? 3 : streak >= 10 ? 2 : 1;
}

function _ndIsStreakMilestone(streak) {
    return streak === 25 || streak === 50 || (streak >= 100 && streak % 100 === 0);
}

const ND_SKINS = ['neon', 'esports', 'metal'];
const ND_SKIN_STORAGE_KEY = 'slopsmith_notedetect_skin';

let _ndSkinRuntime = 'neon';

function _ndLoadSkin() {
    try {
        const v = localStorage.getItem(ND_SKIN_STORAGE_KEY);
        if (ND_SKINS.indexOf(v) !== -1) {
            _ndSkinRuntime = v;
            return v;
        }
    } catch (e) {  }
    return _ndSkinRuntime;
}

function _ndEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function _ndGradeFor(accuracy) {
    return accuracy >= 96 ? 'S'
        : accuracy >= 90 ? 'A'
        : accuracy >= 80 ? 'B'
        : accuracy >= 70 ? 'C'
        : accuracy >= 60 ? 'D'
        : 'F';
}

function _ndComputeBestDelta(prev, cur) {
    const a = Math.round(Number(cur && cur.accuracy) || 0);
    if (!prev) return { first: true, newBest: true, accDelta: 0, bestAcc: a };
    const pa = Math.round(Number(prev.accuracy) || 0);
    return { first: false, newBest: a > pa, accDelta: a - pa, bestAcc: Math.max(a, pa) };
}

const _ND_HERO_SOLID_ACC = 80;
const _ND_HERO_SECTION_PASS = 90;
const _ND_HERO_SECTION_GAP = 15;
function _ndPickHeroAction(ctx) {
    const acc = Math.round(Number(ctx && ctx.accuracy) || 0);
    const canRetry = !!(ctx && ctx.canRetry);
    const sections = (ctx && Array.isArray(ctx.sections)) ? ctx.sections : [];
    const fallback = {
        kind: 'retry',

        reason: (canRetry && acc < 60) ? 'Run it back — try it a touch slower.' : '',
    };
    if (!canRetry || !sections.length) return fallback;
    let weakest = null;
    for (const s of sections) {
        if (!s || s.acc == null) continue;
        const a = Math.round(Number(s.acc) || 0);
        if (!weakest || a < weakest.acc) weakest = { name: s.name, acc: a };
    }
    if (weakest
        && acc >= _ND_HERO_SOLID_ACC
        && weakest.acc < _ND_HERO_SECTION_PASS
        && (acc - weakest.acc) >= _ND_HERO_SECTION_GAP) {
        return {
            kind: 'practice-section',
            sectionName: weakest.name,
            reason: `Your accuracy's strong — ${weakest.name} is the last rough patch.`,
        };
    }
    return fallback;
}

function _ndInstrumentLabel(arrangement) {
    if (!arrangement) return '';
    const s = String(arrangement).trim();
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function _ndSongArtUrl(filename) {
    if (!filename) return '';
    return '/api/song/' + String(filename).split('/').map(encodeURIComponent).join('/') + '/art';
}

function _ndResultsGlowOn() {
    try { return localStorage.getItem('slopsmith_notedetect_results_glow') === '1'; }
    catch (e) { return false; }
}

function _ndSaveDir() {
    try { return (localStorage.getItem('slopsmith_notedetect_save_dir') || '').trim(); }
    catch (e) { return ''; }
}

function _ndAutoSaveEnabled() {
    try { return localStorage.getItem('slopsmith_notedetect_autosave_card') === '1'; }
    catch (e) { return false; }
}

function _ndQueueDelaySeconds() {
    try {
        const v = parseFloat(localStorage.getItem('slopsmith_notedetect_queue_delay'));
        return (Number.isFinite(v) && v >= 0) ? v : 10;
    } catch (e) { return 10; }
}

function _ndAutoDrillMissesSetting() {
    try {
        const v = parseInt(localStorage.getItem('slopsmith_notedetect_autodrill_misses'), 10);
        return (Number.isFinite(v) && v > 0) ? v : 0;
    } catch (e) { return 0; }
}

function _ndQueueShowScores() {
    try { return localStorage.getItem('slopsmith_notedetect_queue_show_scores') !== '0'; }
    catch (e) { return true; }
}

function _ndQueueSetSummaryEnabled() {
    try { return localStorage.getItem('slopsmith_notedetect_queue_set_summary') !== '0'; }
    catch (e) { return true; }
}

let _ndSetLog = [];

function _ndSetLogAppend(log, entry) {
    if (!entry || !Number.isFinite(entry.pos)) return log;
    const last = log.length ? log[log.length - 1] : null;
    if (!last || entry.total !== last.total || entry.pos <= last.pos) return [entry];

    if (entry.filename && entry.filename === last.filename) return log;
    return log.concat([entry]);
}

function _ndSetLogAverage(log) {
    if (!log || !log.length) return 0;
    return Math.round(log.reduce((s, e) => s + (e.accuracy || 0), 0) / log.length);
}

const _ND_SONG_BEST_KEY = 'slopsmith_notedetect_song_best';
const _ND_SONG_BEST_MAX = 600;
function _ndSongBestId(filename, arrangementIndex) {
    return String(filename || '') + '#'
        + (Number.isFinite(arrangementIndex) ? arrangementIndex : '');
}
function _ndReadSongBest(id) {
    try {
        const raw = localStorage.getItem(_ND_SONG_BEST_KEY);
        if (!raw) return null;
        const map = JSON.parse(raw);
        return (map && map[id]) ? map[id] : null;
    } catch (e) { return null; }
}
function _ndWriteSongBest(id, run) {
    try {
        let map = {};
        const raw = localStorage.getItem(_ND_SONG_BEST_KEY);
        if (raw) { try { map = JSON.parse(raw) || {}; } catch (e) { map = {}; } }
        const prev = map[id] || null;
        const max = (k, scale) => Math.max(
            Math.round((Number(run[k]) || 0) * (scale || 1)) / (scale || 1),
            prev ? (Number(prev[k]) || 0) : 0);
        map[id] = {
            accuracy: max('accuracy'),
            score: max('score'),
            bestStreak: max('bestStreak'),
            ts: Date.now(),
        };

        const keys = Object.keys(map);
        if (keys.length > _ND_SONG_BEST_MAX) {
            keys.sort((a, b) => (Number(map[a].ts) || 0) - (Number(map[b].ts) || 0));
            for (const k of keys.slice(0, keys.length - _ND_SONG_BEST_MAX)) delete map[k];
        }
        localStorage.setItem(_ND_SONG_BEST_KEY, JSON.stringify(map));
    } catch (e) {  }
}

function _ndToast(message, ms) {
    if (typeof document === 'undefined' || !document.body) return;
    try {
        const t = document.createElement('div');
        t.className = 'nd-toast';
        try { t.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        t.textContent = String(message == null ? '' : message);
        document.body.appendChild(t);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { try { t.classList.add('nd-toast-in'); } catch (e) {} });
        } else { t.classList.add('nd-toast-in'); }
        setTimeout(() => {
            try { t.classList.remove('nd-toast-in'); } catch (e) {}
            setTimeout(() => { try { t.remove(); } catch (e) {} }, 400);
        }, ms || 6000);
    } catch (e) {}
}

function _ndShareCardText(data) {
    const d = data || {};
    const what = d.title || 'My run';
    const inst = d.instrument ? ` (${d.instrument})` : '';
    const tail = [`${d.accuracy}%`, `${d.score} pts`];
    if (d.fullCombo) tail.push('Full Combo');
    return `fee[dB]ack — ${what}${inst}\n${tail.join(' · ')}`;
}

function _ndShareCardFilename(data) {
    const d = data || {};
    const base = String(d.title || 'score-card')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'score-card';
    return `feedback-${base}.png`;
}

function _ndAutoSaveFilename(data) {
    const d = data || {};
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate())
        + ' ' + p2(now.getHours()) + p2(now.getMinutes());

    const clean = (s) => String(s == null ? '' : s).replace(/[\\/]/g, '-').trim();
    const title = clean(d.title) || 'Song';
    const artist = clean(d.artist);
    return (artist ? artist + ' - ' + title : title) + ' - ' + stamp + '.png';
}

// Results-card rendering is independent of detector instances.
async function _ndRenderShareCard(data, overlayEl) {
    const d = data || {};
    if (typeof document === 'undefined' || !document.createElement) return null;
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 630;
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return null;

    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}

    let artImg = null;
    if (d.artUrl) {
        try {
            artImg = await new Promise((res) => {
                const im = new Image();
                im.onload = () => res(im.naturalWidth ? im : null);
                im.onerror = () => res(null);
                im.src = d.artUrl;
            });
        } catch (e) { artImg = null; }
    }

    const cssVar = (name, fallback) => {
        try {
            if (overlayEl && typeof getComputedStyle === 'function') {
                const v = getComputedStyle(overlayEl).getPropertyValue(name).trim();
                if (v) return v;
            }
        } catch (e) {}
        return fallback;
    };
    const accent  = cssVar('--nd-accent',  '#00f0ff');
    const accent2 = cssVar('--nd-accent2', '#ff2ec4');
    const hit     = cssVar('--nd-hit',     '#00ff88');
    const miss    = cssVar('--nd-miss',    '#ff4444');
    const text    = cssVar('--nd-text',    '#e8f6ff');
    const dim     = cssVar('--nd-dim',     '#7c93a8');
    const warn    = cssVar('--nd-warn',    '#ffcc00');
    const bg      = cssVar('--nd-bg',      'rgba(6,10,24,0.82)');
    const fDisp   = cssVar('--nd-font-display', "'Orbitron', sans-serif");

    const W = 1200, H = 630, P = 72;
    const font = (px, stack, weight) => { ctx.font = `${weight || 700} ${px}px ${stack}`; };
    const fit = (s, maxW) => {
        s = String(s == null ? '' : s);
        if (ctx.measureText(s).width <= maxW) return s;
        let t = s;
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        return t + '…';
    };
    const spaced = (px) => { try { ctx.letterSpacing = px + 'px'; } catch (e) {} };

    ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
    ctx.strokeRect(28.5, 28.5, W - 57, H - 57);
    ctx.textBaseline = 'alphabetic';

    const glow = _ndResultsGlowOn();
    const glowSet = (color) => { if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 16; } };
    const glowClear = () => { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; };

    const A = 190, artX = W - P - A, artY = 64, artR = 14;
    if (artImg) {
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(artX, artY, A, A, artR); else ctx.rect(artX, artY, A, A);
        ctx.closePath(); ctx.clip();
        const iw = artImg.naturalWidth, ih = artImg.naturalHeight;
        const s = Math.max(A / iw, A / ih), dw = iw * s, dh = ih * s;
        ctx.drawImage(artImg, artX + (A - dw) / 2, artY + (A - dh) / 2, dw, dh);
        ctx.restore();
        ctx.strokeStyle = accent; ctx.lineWidth = 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(artX + 1, artY + 1, A - 2, A - 2, artR); else ctx.rect(artX + 1, artY + 1, A - 2, A - 2);
        ctx.stroke();
    }
    const leftMaxW = (artImg ? artX - 28 : W - P) - P;

    spaced(6); ctx.fillStyle = dim; font(20, fDisp, 700);
    ctx.fillText(String(d.eyebrow || 'SONG COMPLETE').toUpperCase(), P, 92); spaced(0);
    let heroSize = 64; font(heroSize, fDisp, 800);
    const heroText = d.hero || d.title || 'Song Complete';
    if (ctx.measureText(heroText).width > leftMaxW) { heroSize = 48; font(heroSize, fDisp, 800); }
    glowSet(text); ctx.fillStyle = text; ctx.fillText(fit(heroText, leftMaxW), P, 156); glowClear();
    const sub = [d.artist, d.instrument].filter(Boolean).join('   ·   ');
    if (sub) { spaced(2); ctx.fillStyle = dim; font(24, fDisp, 500); ctx.fillText(fit(sub.toUpperCase(), leftMaxW), P, 196); spaced(0); }

    if (d.fullCombo) {
        spaced(4); glowSet(hit); ctx.fillStyle = hit; font(22, fDisp, 700);
        const fcW = ctx.measureText('★ FULL COMBO').width + 4 * 11;
        ctx.fillText('★ FULL COMBO', W - P - fcW, artImg ? artY + A + 36 : 150);
        glowClear(); spaced(0);
    }

    const secs = Array.isArray(d.sections) ? d.sections.slice(0, 5) : [];
    if (secs.length) {
        spaced(3); ctx.fillStyle = dim; font(15, fDisp, 600);
        ctx.fillText('SECTIONS', P, 252); spaced(0);
        const barX = P + 160, barW = 320, rowH = 36;
        let y = 292;
        for (const sec of secs) {
            const acc = Math.max(0, Math.min(100, Math.round(sec.acc)));
            const barColor = acc >= 90 ? hit : warn;
            ctx.textBaseline = 'middle';
            ctx.fillStyle = text; font(18, fDisp, 600);
            ctx.fillText(fit(sec.name, 140), P, y);
            ctx.fillStyle = 'rgba(255,255,255,0.10)';
            if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(barX, y - 7, barW, 14, 7); ctx.fill(); }
            else ctx.fillRect(barX, y - 7, barW, 14);
            ctx.fillStyle = barColor;
            const fw = Math.max(8, barW * acc / 100);
            if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(barX, y - 7, fw, 14, 7); ctx.fill(); }
            else ctx.fillRect(barX, y - 7, fw, 14);
            glowSet(barColor); ctx.fillStyle = barColor; font(18, fDisp, 700);
            ctx.fillText(acc + '%', barX + barW + 16, y); glowClear();
            y += rowH;
        }
        ctx.textBaseline = 'alphabetic';
    } else {

        const accPct = Math.max(0, Math.min(100, Math.round(Number(d.accuracy) || 0)));
        const heroColor = accPct >= 90 ? hit : warn;
        const hitsTotal = (d.hits || 0) + (d.misses || 0);
        spaced(3); ctx.fillStyle = dim; font(15, fDisp, 600);
        ctx.fillText('ACCURACY', P, 252); spaced(0);
        glowSet(heroColor); ctx.fillStyle = text; font(116, fDisp, 800);
        ctx.fillText(accPct + '%', P, 372); glowClear();
        spaced(2); ctx.fillStyle = dim; font(20, fDisp, 600);
        ctx.fillText((d.hits || 0) + ' / ' + hitsTotal + ' NOTES HIT', P, 410); spaced(0);
        const mX = P, mW = W - P * 2, mY = 446, mH = 18;
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(mX, mY, mW, mH, mH / 2); ctx.fill(); }
        else ctx.fillRect(mX, mY, mW, mH);
        ctx.fillStyle = heroColor;
        const mFw = Math.max(mH, mW * accPct / 100);
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(mX, mY, mFw, mH, mH / 2); ctx.fill(); }
        else ctx.fillRect(mX, mY, mFw, mH);
    }

    const total = (d.hits || 0) + (d.misses || 0);
    const stats = (Array.isArray(d.stats) && d.stats.length) ? d.stats.slice(0, 6) : [
        { label: 'ACCURACY',    value: d.accuracy + '%',          color: text },
        { label: 'SCORE',       value: String(d.score),           color: accent },
        { label: 'HITS',        value: d.hits + '/' + total,      color: hit },
        { label: (d.extraLabel || 'Top Section').toUpperCase(), value: d.extraValue || '—', color: accent },
        { label: 'BEST STREAK', value: String(d.bestStreak),      color: text },
        { label: 'MAX MULT',    value: '×' + d.maxMultiplier,     color: accent2 },
    ];
    const colW = (W - P * 2) / stats.length;
    const sy = 520;
    stats.forEach((st, i) => {
        const x = P + colW * i;
        const col = st.color || text;
        spaced(2); ctx.fillStyle = dim; font(15, fDisp, 600);
        ctx.fillText(String(st.label || '').toUpperCase(), x, sy); spaced(0);

        const valStr = String(st.value == null ? '' : st.value);
        const valMaxW = colW - 14;
        let valPx = 36;
        font(valPx, fDisp, 700);
        while (valPx > 22 && ctx.measureText(valStr).width > valMaxW) { valPx -= 2; font(valPx, fDisp, 700); }
        glowSet(col); ctx.fillStyle = col;
        ctx.fillText(fit(valStr, valMaxW), x, sy + 46); glowClear();
    });

    spaced(2); ctx.fillStyle = dim; font(16, fDisp, 500);
    ctx.fillText(String(d.brand || 'FEE[dB]ACK · NOTE DETECTION'), P, H - 26); spaced(0);
    return cv;
}

async function _ndShareCardAction(data, action, overlayEl) {
    const cv = await _ndRenderShareCard(data, overlayEl);
    if (!cv || !cv.toBlob) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(_ndShareCardText(data)); return 'copied-text';
            }
        } catch (e) {}
        return 'failed';
    }
    const toBlob = () => new Promise((r) => cv.toBlob(r, 'image/png'));
    const download = async () => {
        const b = await toBlob(); if (!b) return false;
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url; a.download = _ndShareCardFilename(data);
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
        return true;
    };
    if (action === 'download') {
        try { if (await download()) return 'saved'; } catch (e) {}
    } else {
        try {
            if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
                await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': toBlob() })]);
                return 'copied';
            }
        } catch (e) {}
        try { if (await download()) return 'saved'; } catch (e) {}
    }
    try { await navigator.clipboard.writeText(_ndShareCardText(data)); return 'copied-text'; } catch (e) {}
    return 'failed';
}

async function _ndSaveCard(data, overlayEl, opts) {
    const auto = !!(opts && opts.auto);
    const cv = await _ndRenderShareCard(data, overlayEl);
    if (!cv || !cv.toBlob) return { ok: false };
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    if (!blob) return { ok: false };
    const name = auto ? _ndAutoSaveFilename(data) : _ndShareCardFilename(data);
    const dir = _ndSaveDir();
    try {
        const qs = '?name=' + encodeURIComponent(name)
            + (dir ? '&dir=' + encodeURIComponent(dir) : '')
            + (auto ? '&auto=1' : '');
        const resp = await fetch('/api/plugins/note_detect/save-card' + qs, {
            method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
        });
        if (resp && resp.ok) {
            const j = await resp.json().catch(() => null);
            if (j && j.ok) return { ok: true, path: j.path, dir: j.dir, filename: j.filename };
        }
    } catch (e) {  }

    if (auto) return { ok: false };

    try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
        return { ok: true, fallback: true, filename: name };
    } catch (e) {}
    return { ok: false };
}

async function _ndShareCardClick(btn, action, data, overlayEl) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.disabled = true;
    if (action === 'download') {
        btn.textContent = 'Saving…';
        let res = { ok: false };
        try { res = await _ndSaveCard(data, overlayEl); } catch (e) {}
        if (res.ok && !res.fallback) {
            btn.textContent = 'Saved ✓';
            _ndToast('Saved to ' + (res.dir || res.path || 'disk'), 6000);
        } else if (res.ok && res.fallback) {
            btn.textContent = 'Saved ✓';
            _ndToast('Saved ' + (res.filename || 'card') + ' to your browser downloads', 6000);
        } else {
            btn.textContent = 'Couldn’t save';
        }
        setTimeout(() => { if (btn.isConnected) { btn.textContent = orig; btn.disabled = false; } }, 1600);
        return;
    }
    let res = 'failed';
    try { res = await _ndShareCardAction(data, 'copy', overlayEl); } catch (e) {}
    btn.textContent = res === 'copied' ? 'Copied ✓'
        : res === 'saved' ? 'Saved ✓'
        : res === 'copied-text' ? 'Copied text ✓'
        : 'Couldn’t copy';
    setTimeout(() => { if (btn.isConnected) { btn.textContent = orig; btn.disabled = false; } }, 1600);
}

function _ndGradeClean(hit, timingError, pitchError, cleanTimingMs, cleanPitchCents) {
    if (!hit) return { clean: false, looseReason: null };
    const tLoose = Number.isFinite(timingError) && Number.isFinite(cleanTimingMs)
        && Math.abs(timingError) > cleanTimingMs;
    const pLoose = Number.isFinite(pitchError) && Number.isFinite(cleanPitchCents)
        && Math.abs(pitchError) > cleanPitchCents;
    if (!tLoose && !pLoose) return { clean: true, looseReason: null };
    return { clean: false, looseReason: (tLoose && pLoose) ? 'both' : (tLoose ? 'timing' : 'pitch') };
}

// A hit uses configured tolerances; clean/loose is a stricter quality grade.
function _ndMakeJudgment(opts) {
    const o = opts || {};
    const matched = !!o.matched;
    const timingError = matched && Number.isFinite(o.judgedAt) && Number.isFinite(o.noteTime)
        ? Math.round((o.judgedAt - o.noteTime) * 1000)
        : null;
    const pitchError = matched && Number.isFinite(o.pitchError)
        ? Math.round(o.pitchError)
        : null;
    const timingThresholdMs = Number.isFinite(o.timingThresholdMs) ? o.timingThresholdMs : 100;
    const pitchThresholdCents = Number.isFinite(o.pitchThresholdCents) ? o.pitchThresholdCents : 20;

    const chartNote = o.chartNote || o.note || null;
    const susSec = chartNote && Number.isFinite(chartNote.sus) ? chartNote.sus : 0;
    const lateGraceMs = Number.isFinite(o.lateGraceMs)
        ? Math.max(0, o.lateGraceMs)
        : (susSec > 0 ? Math.min(susSec * 1000, 1000) : 0);
    const timingState = matched ? _ndClassifyTiming(timingError, timingThresholdMs, lateGraceMs) : null;
    const pitchState = matched ? _ndClassifyPitch(pitchError, pitchThresholdCents) : null;

    const isChord = !!o.chord;
    const hit = isChord
        ? (matched && timingState === 'OK')
        : (timingState === 'OK' && (pitchState === 'OK' || pitchState === null));

    const cleanTimingMs = Number.isFinite(o.cleanTimingThresholdMs) ? o.cleanTimingThresholdMs : timingThresholdMs;
    const cleanPitchCents = Number.isFinite(o.cleanPitchThresholdCents) ? o.cleanPitchThresholdCents : pitchThresholdCents;

    const skipCleanPitch = isChord || !!o.pitchWindowWidened;
    const { clean, looseReason } = _ndGradeClean(
        hit, timingError, skipCleanPitch ? null : pitchError, cleanTimingMs, cleanPitchCents);
    return {
        chartNote: o.chartNote || o.note || null,
        note: o.note || null,
        notes: o.notes || null,
        chord: !!o.chord,
        hit,
        clean,
        looseReason,
        timingState,
        timingError,
        pitchState,
        pitchError,
        detectedFreq: Number.isFinite(o.detectedFreq) ? o.detectedFreq : null,
        expectedFreq: Number.isFinite(o.expectedFreq) ? o.expectedFreq : null,
        detectedAt: matched && Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        time: Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        noteTime: Number.isFinite(o.noteTime) ? o.noteTime : null,
        expectedMidi: Number.isFinite(o.expectedMidi) ? o.expectedMidi : null,
        detectedMidi: Number.isFinite(o.detectedMidi) ? o.detectedMidi : null,
        confidence: Number.isFinite(o.confidence) ? o.confidence : 0,
        hitStrings: Number.isFinite(o.hitStrings) ? o.hitStrings : undefined,
        totalStrings: Number.isFinite(o.totalStrings) ? o.totalStrings : undefined,
        score: Number.isFinite(o.score) ? o.score : undefined,
        monophonicDetected: o.monophonicDetected,
    };
}

function _ndMidiToStringFret(midiNote, arrangement, stringCount, offsets, capo) {

    const base = _ndStandardMidiFor(arrangement, stringCount);
    let bestDist = Infinity;
    let bestString = -1;
    let bestFret = -1;
    for (let s = 0; s < base.length; s++) {
        const offset = offsets && offsets[s] !== undefined ? offsets[s] : 0;
        const openMidi = base[s] + offset + (capo || 0);
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        const dist = Math.abs(midiNote - (openMidi + fret));
        if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
            bestFret = fret;
        }
    }
    return { string: bestString, fret: bestFret };
}

function _ndFoldOctaveCents(cents) {
    if (!Number.isFinite(cents)) return Infinity;
    return cents - (Math.round(cents / 1200) * 1200);
}

function _ndNearestOctaveCents(detectedMidi, expectedMidi) {
    if (!Number.isFinite(detectedMidi) || !Number.isFinite(expectedMidi)) return Infinity;
    return _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100);
}

function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement, stringCount, offsets, capo, pitchToleranceCents) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement, stringCount, offsets, capo);
            if (Math.abs(_ndNearestOctaveCents(detectedMidi, expected)) <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f, displayMidi: expected };
            }
        }
    }
    const fallback = _ndMidiToStringFret(detectedMidi, arrangement, stringCount, offsets, capo);
    return { string: fallback.string, fret: fallback.fret, displayMidi: detectedMidi };
}

// YIN provides low-latency monophonic pitch detection.
const _ND_MIN_DETECTABLE_HZ = 30;

function _ndYinDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;

    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] *= tau / runningSum;
    }

    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0, underBuffered };

    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence), underBuffered };
}

function _ndNextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function _ndMinAnalysisSamples(arrangement, sampleRate) {
    if (arrangement !== 'bass' || !(sampleRate > 0)) return _ND_MIN_YIN_SAMPLES;

    const need = Math.ceil(2 * sampleRate / _ND_MIN_DETECTABLE_HZ);
    return Math.max(_ND_MIN_YIN_SAMPLES, need);
}

function _ndCalibrateOffsetMs(detections, chartNotes, geom, hitWindowS, pitchTolCents, opts) {
    opts = opts || {};
    const loMs = (opts.loMs != null) ? opts.loMs : -250;
    const hiMs = (opts.hiMs != null) ? opts.hiMs : 250;
    const stepMs = opts.stepMs || 10;
    const minMatched = (opts.minMatched != null) ? opts.minMatched : 12;
    if (!Array.isArray(detections) || !Array.isArray(chartNotes)) return null;
    if (detections.length < minMatched || chartNotes.length < minMatched) return null;

    const exp = [];
    for (const n of chartNotes) {
        const t = (n.time != null) ? n.time : n.t;
        if (t == null || n.s == null || n.f == null) continue;
        const em = _ndMidiFromStringFret(n.s, n.f, geom.arrangement, geom.stringCount, geom.offsets, geom.capo);
        if (Number.isFinite(em)) exp.push({ t, em });
    }
    if (exp.length < minMatched) return null;
    const dets = detections.slice().sort((a, b) => a.bt - b.bt);
    let best = null;
    for (let ms = loMs; ms <= hiMs; ms += stepMs) {
        const off = ms / 1000;
        let matched = 0, residSum = 0;
        for (const note of exp) {
            for (let i = 0; i < dets.length; i++) {
                const dt = dets[i].bt + off - note.t;
                if (dt < -hitWindowS) continue;
                if (dt > hitWindowS) break;
                if (Math.abs(_ndNearestOctaveCents(dets[i].m, note.em)) <= pitchTolCents) {
                    matched++; residSum += dt; break;
                }
            }
        }
        if (!best || matched > best.matched) best = { ms, matched, resid: matched ? residSum / matched : 0 };
    }
    if (!best || best.matched < minMatched) return null;

    const refinedMs = Math.round(best.ms - best.resid * 1000);
    return { offsetMs: Math.max(-1000, Math.min(1000, refinedMs)), matched: best.matched, total: exp.length };
}

// Shared radix-2 FFT used by HPS and spectral verification.
function _ndFftInPlace(data, direction) {
    const nPairs = data.length >> 1;

    for (let i = 1, j = 0; i < nPairs; i++) {
        let bit = nPairs >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const ir = 2 * i, jr = 2 * j;
            let tmp = data[ir];     data[ir] = data[jr];     data[jr] = tmp;
            tmp = data[ir + 1]; data[ir + 1] = data[jr + 1]; data[jr + 1] = tmp;
        }
    }

    for (let len = 2; len <= nPairs; len <<= 1) {
        const halfLen = len >> 1;
        const angle = -direction * 2 * Math.PI / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < nPairs; i += len) {
            let twRe = 1, twIm = 0;
            for (let k = 0; k < halfLen; k++) {
                const evenIdx = 2 * (i + k);
                const oddIdx = 2 * (i + k + halfLen);
                const oRe = data[oddIdx] * twRe - data[oddIdx + 1] * twIm;
                const oIm = data[oddIdx] * twIm + data[oddIdx + 1] * twRe;
                data[oddIdx]     = data[evenIdx]     - oRe;
                data[oddIdx + 1] = data[evenIdx + 1] - oIm;
                data[evenIdx]     = data[evenIdx]     + oRe;
                data[evenIdx + 1] = data[evenIdx + 1] + oIm;
                const nextTwRe = twRe * wRe - twIm * wIm;
                twIm = twRe * wIm + twIm * wRe;
                twRe = nextTwRe;
            }
        }
    }
}

let _ndFftInterleavedScratch = null;
let _ndFftMagnitudesScratch = null;
let _ndFftScratchSize = 0;

let _ndHpsScratch = null;
let _ndHpsScratchSize = 0;

function _ndFftMagnitude(buffer, sampleRate) {

    const TARGET_BIN_HZ = 3;
    const resolutionFloor = _ndNextPow2(Math.ceil(sampleRate / TARGET_BIN_HZ));
    const fftSize = Math.max(_ndNextPow2(buffer.length), resolutionFloor);
    const halfBins = (fftSize >> 1) + 1;

    if (_ndFftScratchSize !== fftSize) {
        _ndFftInterleavedScratch = new Float32Array(2 * fftSize);
        _ndFftMagnitudesScratch = new Float32Array(halfBins);
        _ndFftScratchSize = fftSize;
    }
    const interleaved = _ndFftInterleavedScratch;
    const magnitudes = _ndFftMagnitudesScratch;

    interleaved.fill(0);

    for (let i = 0; i < buffer.length; i++) {
        const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (buffer.length - 1)));
        interleaved[2 * i] = buffer[i] * w;
    }
    _ndFftInPlace(interleaved, 1);
    for (let k = 0; k < halfBins; k++) {
        const re = interleaved[2 * k];
        const im = interleaved[2 * k + 1];
        magnitudes[k] = Math.sqrt(re * re + im * im);
    }
    return { magnitudes, binHz: sampleRate / fftSize, fftSize };
}

function _ndParabolicOffset(yPrev, yPeak, yNext) {
    const denom = yPrev - 2 * yPeak + yNext;
    if (Math.abs(denom) < 1e-12) return 0;
    const delta = 0.5 * (yPrev - yNext) / denom;
    if (delta > 1) return 1;
    if (delta < -1) return -1;
    return delta;
}

// HPS is the bass-oriented monophonic fallback.
function _ndHpsDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const halfLen = Math.floor(buffer.length / 2);
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;
    if (underBuffered) return { freq: -1, confidence: 0, underBuffered };

    const { magnitudes, binHz } = _ndFftMagnitude(buffer, sampleRate);
    const nBins = magnitudes.length;
    const harmonics = 3;
    const maxFreqHz = 2000;
    const lowBin = Math.max(1, Math.floor(minFreqHz / binHz));
    const highBin = Math.min(Math.floor((nBins - 1) / harmonics),
                             Math.floor(maxFreqHz / binHz));
    if (highBin <= lowBin) return { freq: -1, confidence: 0, underBuffered: false };

    let maxMag = 0;
    for (let k = 0; k < nBins; k++) if (magnitudes[k] > maxMag) maxMag = magnitudes[k];
    const floor = maxMag * 1e-3;

    if (_ndHpsScratchSize <= highBin) {
        _ndHpsScratch = new Float32Array(highBin + 1);
        _ndHpsScratchSize = highBin + 1;
    }
    const hps = _ndHpsScratch;
    let peakBin = lowBin;
    let peakVal = -Infinity;
    let sum = 0;
    for (let k = lowBin; k <= highBin; k++) {
        let logSum = 0;
        for (let h = 1; h <= harmonics; h++) {
            logSum += Math.log(Math.max(magnitudes[k * h], floor));
        }
        hps[k] = logSum;
        sum += logSum;
        if (logSum > peakVal) { peakVal = logSum; peakBin = k; }
    }
    if (!isFinite(peakVal)) return { freq: -1, confidence: 0, underBuffered: false };

    if (peakBin * 3 < nBins) {
        const m1 = magnitudes[peakBin];
        const m2 = magnitudes[peakBin * 2];
        const m3 = magnitudes[peakBin * 3];
        const dominantSecond = m2 > 2 * m1;
        const weakThird = m3 < 0.1 * m2;
        if (dominantSecond && weakThird && peakBin * 2 <= highBin) {
            peakBin *= 2;
            peakVal = hps[peakBin];
        }
    }

    const delta = (peakBin > lowBin && peakBin < highBin)
        ? _ndParabolicOffset(hps[peakBin - 1], hps[peakBin], hps[peakBin + 1])
        : 0;
    const freq = (peakBin + delta) * binHz;

    const mean = sum / (highBin - lowBin + 1);
    const spread = peakVal - mean;
    const confidence = Math.min(1, Math.max(0, spread / (harmonics * Math.log(10))));

    return { freq, confidence, underBuffered: false };
}

function _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo) {
    const openMidi = _ndMidiFromStringFret(stringIdx, 0, arrangement, stringCount, offsets, capo);
    const fret24Midi = openMidi + 24;

    const loHz = 440 * Math.pow(2, (openMidi - 69) / 12) * 0.90;
    const hiHz = 440 * Math.pow(2, (fret24Midi - 69) / 12) * 1.10;
    return [loHz, hiHz];
}

function _ndBandEnergy(magnitudes, binHz, loHz, hiHz, totalEnergy = null) {
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));

    if (hiBin < loBin) return 0;

    let bandEnergy = 0;
    for (let k = loBin; k <= hiBin; k++) {
        bandEnergy += magnitudes[k] * magnitudes[k];
    }

    if (totalEnergy === null) {
        totalEnergy = 0;
        for (let k = 0; k < nBins; k++) {
            totalEnergy += magnitudes[k] * magnitudes[k];
        }
    }
    if (totalEnergy < 1e-12) return 0;
    return bandEnergy / totalEnergy;
}

function _ndTotalEnergy(magnitudes) {
    let total = 0;
    for (let k = 0; k < magnitudes.length; k++) {
        total += magnitudes[k] * magnitudes[k];
    }
    return total;
}

const _ND_DRILL_LEAD_IN_SEC = 5.0;
const _ND_DRILL_FIRST_NOTE_RUNWAY_SEC = 1.0;
const _ND_DRILL_DEFAULT_GOAL = 0.85;
const _ND_DRILL_DEFAULT_LADDER = [0.8, 0.9, 1.0];
const _ND_DRILL_FULLSPEED_REPS = 3;

function _ndDrillRampDecision(score, goal, rung, ladderLength, topClears = 0, reps = 1) {
    const cleared = Number.isFinite(score) && Number.isFinite(goal) && score >= goal;
    if (!cleared) return { action: 'hold', nextRung: rung };
    const atTop = rung >= ladderLength - 1;
    if (atTop) {

        if (topClears + 1 >= Math.max(1, reps)) return { action: 'graduate', nextRung: rung };
        return { action: 'consolidate', nextRung: rung };
    }
    return { action: 'advance', nextRung: rung + 1 };
}

function _ndDrillPassScore(hits, charted) {
    if (!Number.isFinite(charted) || charted <= 0) return null;
    return Math.max(0, Number(hits) || 0) / charted;
}

function _ndAutoDrillShouldTrigger(missStreak, threshold, drilling, playing) {
    return threshold > 0 && !drilling && !!playing && missStreak >= threshold;
}

function _ndAutoDrillRange(firstMissT, lastMissT, minSpanSec = 1.5) {
    const start = Math.max(0, Number(firstMissT));
    const rawEnd = Number(lastMissT);
    const end = Math.max(Number.isFinite(rawEnd) ? rawEnd : start, start + minSpanSec);
    return { start, end };
}

function _ndDescribeMiss(j) {
    if (!j) return { how: 'missed', detail: 'no note' };

    if (j.muteFail) return { how: 'mute', detail: 'open string rang — fret/mute fail' };
    const dm = j.detectedMidi;
    if (dm == null || !Number.isFinite(dm)) return { how: 'missed', detail: 'not played / not detected' };
    if (j.timingState === 'LATE') return { how: 'late', detail: Number.isFinite(j.timingError) ? `${Math.round(Math.abs(j.timingError))}ms late` : 'late' };
    if (j.timingState === 'EARLY') return { how: 'early', detail: Number.isFinite(j.timingError) ? `${Math.round(Math.abs(j.timingError))}ms early` : 'early' };
    if (j.pitchState === 'SHARP') return { how: 'sharp', detail: Number.isFinite(j.pitchError) ? `${Math.round(Math.abs(j.pitchError))}¢ sharp` : 'sharp' };
    if (j.pitchState === 'FLAT') return { how: 'flat', detail: Number.isFinite(j.pitchError) ? `${Math.round(Math.abs(j.pitchError))}¢ flat` : 'flat' };
    return { how: 'wrong', detail: 'wrong note' };
}

function _ndSummarizeWindowMisses(judgments, startSec, endSec) {
    const out = [];
    for (const j of (judgments || [])) {
        if (!j || j.hit) continue;
        const t = Number.isFinite(j.noteTime) ? j.noteTime : null;
        if (t == null || t < startSec || t > endSec) continue;
        const note = j.note || j.chartNote || {};
        const d = _ndDescribeMiss(j);
        out.push({ s: note.s, f: note.f, t, how: d.how, detail: d.detail });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

// Chord scoring verifies each expected string in its own spectral band.
function _ndConstraintCheckString(
    buffer, sampleRate,
    stringIdx, fret, arrangement, stringCount, offsets, capo,
    pitchCheckCents = 0,
    energyThreshold = 0.03,
    precomputedSpectrum = null,
    precomputedTotalEnergy = null
) {

    const { magnitudes, binHz } = precomputedSpectrum || _ndFftMagnitude(buffer, sampleRate);
    const [loHz, hiHz] = _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo);

    const expectedMidi = _ndMidiFromStringFret(stringIdx, fret, arrangement, stringCount, offsets, capo);
    const expectedHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);

    const bandEnergy = _ndBandEnergy(magnitudes, binHz, loHz, hiHz, precomputedTotalEnergy);
    const energyOk = bandEnergy >= energyThreshold;

    const combRescueEligible = pitchCheckCents > 0
        && expectedHz <= _ND_HARMONIC_FALLBACK_MAX_HZ
        && bandEnergy >= _ND_LOW_ENERGY_RESCUE_FLOOR;

    if (!energyOk && !combRescueEligible) {
        return { hit: false, bandEnergy, centsDiff: null, centsError: null };
    }

    if (pitchCheckCents <= 0) {
        return { hit: true, bandEnergy, centsDiff: null, centsError: null };
    }

    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    let peakBin = loBin;
    let peakVal = -Infinity;
    for (let k = loBin; k <= hiBin; k++) {
        if (magnitudes[k] > peakVal) { peakVal = magnitudes[k]; peakBin = k; }
    }
    const delta = (peakBin > loBin && peakBin < hiBin)
        ? _ndParabolicOffset(magnitudes[peakBin - 1], magnitudes[peakBin], magnitudes[peakBin + 1])
        : 0;
    const detectedHz = (peakBin + delta) * binHz;

    const rawCentsError = 1200 * Math.log2(detectedHz / expectedHz);
    const centsError = _ndFoldOctaveCents(rawCentsError);
    const centsDiff = Math.abs(centsError);

    let hit = energyOk && centsDiff <= pitchCheckCents;

    if (!hit && expectedHz <= _ND_HARMONIC_FALLBACK_MAX_HZ
        && _ndHarmonicCoherenceLow(magnitudes, binHz, expectedHz, peakVal)) {
        hit = true;
    }
    return { hit, bandEnergy, centsDiff, centsError };
}

function _ndHarmonicCoherenceLow(magnitudes, binHz, expectedHz, bandPeakMag) {
    return _ndHarmonicCombCount(magnitudes, binHz, expectedHz, bandPeakMag) >= _ND_HARMONIC_FALLBACK_MIN_HARMONICS;
}

function _ndHarmonicCombCount(magnitudes, binHz, expectedHz, bandPeakMag) {
    if (!(bandPeakMag > 0) || !(expectedHz > 0) || !(binHz > 0)) return 0;
    const widen = Math.pow(2, _ND_HARMONIC_FALLBACK_HALF_CENTS / 1200);
    const floor = _ND_HARMONIC_FALLBACK_PEAK_FRAC * bandPeakMag;
    const nBins = magnitudes.length;
    let coherent = 0;
    for (const k of _ND_HARMONIC_FALLBACK_RATIOS) {
        const f = expectedHz * k;
        const lo = Math.max(1, Math.floor((f / widen) / binHz));
        const hi = Math.min(nBins - 2, Math.ceil((f * widen) / binHz));
        let bestBin = -1;
        let bestVal = -Infinity;
        for (let b = lo; b <= hi; b++) {
            if (magnitudes[b] > bestVal) { bestVal = magnitudes[b]; bestBin = b; }
        }
        if (bestBin < 0 || bestVal < floor) continue;

        if (magnitudes[bestBin] >= magnitudes[bestBin - 1] && magnitudes[bestBin] >= magnitudes[bestBin + 1]) {
            coherent++;
        }
    }
    return coherent;
}

function _ndDetectMuteFail(magnitudes, binHz, expectedHz, openHz, bandPeakMag) {
    if (!(openHz > 0) || !(expectedHz > 0)) return false;

    if (Math.abs(1200 * Math.log2(expectedHz / openHz)) < 120) return false;
    const openComb = _ndHarmonicCombCount(magnitudes, binHz, openHz, bandPeakMag);
    if (openComb < _ND_HARMONIC_FALLBACK_MIN_HARMONICS) return false;
    const frettedComb = _ndHarmonicCombCount(magnitudes, binHz, expectedHz, bandPeakMag);
    return openComb > frettedComb;
}

function _ndIsSilentWindow(samples, centerT, halfWin, threshold) {
    if (!Array.isArray(samples) || samples.length === 0) return null;
    let peak = 0;
    let inWindow = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        if (!s) continue;
        if (s.songT > centerT + halfWin) continue;
        if (s.songT < centerT - halfWin) break;
        inWindow++;
        if (s.level > peak) peak = s.level;
    }
    if (inWindow === 0) return null;
    return peak < threshold;
}

function _ndKeysToReopenOnSeek(lastT, t, tolerance, keys) {
    if (!Number.isFinite(lastT) || !(t < lastT - 0.25)) return [];
    const floor = t - (Number.isFinite(tolerance) ? tolerance : 0);
    const out = [];
    for (const key of keys) {
        const nt = parseFloat(String(key).split('_')[0]);
        if (Number.isFinite(nt) && nt >= floor) out.push(key);
    }
    return out;
}

function _ndScoreChord(buffer, sampleRate, chordNotes, arrangement, stringCount, offsets, capo, pitchCheckCents, minHitRatio = 0.6) {
    let hitStrings = 0;
    const results = [];

    const spectrum = _ndFftMagnitude(buffer, sampleRate);
    const totalEnergy = _ndTotalEnergy(spectrum.magnitudes);

    for (const cn of chordNotes) {

        let energyThreshold = 0.03;
        let cents = pitchCheckCents;

        if (cn.ho || cn.po) {

            energyThreshold = 0.015;
        }
        if (cn.b || cn.sl) {

            cents = Math.max(cents, 100);
        }
        if (cn.hm) {

            cents = 0;
        }

        const check = _ndConstraintCheckString(
            buffer, sampleRate,
            cn.s, cn.f, arrangement, stringCount, offsets, capo,
            cents, energyThreshold, spectrum, totalEnergy
        );
        results.push({ s: cn.s, f: cn.f, ...check });
        if (check.hit) hitStrings++;
    }

    const totalStrings = chordNotes.length;
    const score = totalStrings > 0 ? hitStrings / totalStrings : 0;

    let voicingHit = false;
    if (results.length >= 2) {
        let pitchVerifiedHits = 0;
        for (const r of results) {

            if (r.hit && Number.isFinite(r.centsDiff)) pitchVerifiedHits++;
            if (pitchVerifiedHits >= 2) break;
        }
        if (pitchVerifiedHits >= 2) voicingHit = true;
    }

    const isHit = score >= minHitRatio;
    return { score, hitStrings, totalStrings, results, isHit, voicingHit };
}

// CREPE is loaded once and shared by all detector instances.
async function _ndLoadCrepe() {
    if (_ndShared.model || _ndShared.modelLoading) return;
    _ndShared.modelLoading = true;

    for (const inst of _ndInstances) inst._updateButton();

    try {
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        _ndShared.model = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            _ndShared.model = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _ndShared.model = null;
        }
    }
    _ndShared.modelLoading = false;

    for (const inst of _ndInstances) inst._updateButton();
}

function _ndLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function _ndCrepeDetect(buffer) {
    if (!_ndShared.model) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        if (_ndShared.model.execute) {
            outputs = _ndShared.model.execute(input);
        } else {
            outputs = _ndShared.model.predict(input);
        }

        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = uncData ? Math.max(0, 1 - uncData[0]) : 0.8;
            outputs.forEach(t => t.dispose());
        } else {
            const pitchData = await outputs.data();
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = pitchData.length > 1 ? Math.max(0, 1 - pitchData[1]) : 0.8;
            outputs.dispose();
        }
        input.dispose();

        if (freq < 20 || freq > 5000) return { freq: -1, confidence: 0 };
        return { freq, confidence };
    } catch (e) {
        return { freq: -1, confidence: 0 };
    }
}

function _ndEncodeWavPcm16(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = new ArrayBuffer(44 + total * 2);
    const v = new DataView(buf);
    let off = 0;
    const w4  = (s) => { for (let i = 0; i < 4; i++) v.setUint8(off++, s.charCodeAt(i)); };
    const w16 = (n) => { v.setUint16(off, n, true); off += 2; };
    const w32 = (n) => { v.setUint32(off, n, true); off += 4; };
    w4('RIFF');  w32(36 + total * 2);  w4('WAVE');
    w4('fmt ');  w32(16);
    w16(1);
    w16(1);
    w32(sampleRate);
    w32(sampleRate * 2);
    w16(2);
    w16(16);
    w4('data');  w32(total * 2);
    for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
            let s = c[i];
            if (s > 1)  s =  1;
            else if (s < -1) s = -1;
            v.setInt16(off, (s * 32767) | 0, true);
            off += 2;
        }
    }
    return buf;
}

function _ndScoringHealthy(enabled, usingBridge, extActive, cbFresh) {
    return !!(enabled && (usingBridge || extActive || cbFresh));
}

// Each detector owns its audio graph, state, UI, timers, and event subscriptions.
function createNoteDetector(options = {}) {
    const opts = options || {};

    // Resolve the highway lazily because plugins may initialize before the host.
    let hw = opts.highway || window.highway || null;
    function resolveHw() {
        if (hw) return hw;
        hw = opts.highway || window.highway || null;
        return hw;
    }

    // Scoring must use the same difficulty-filtered chart shown to the player.
    function _ndChartNotes(h) {
        const x = h || hw;
        if (!x) return [];
        if (typeof x.getFilteredNotes === 'function') return x.getFilteredNotes() || [];
        return (x.getNotes && x.getNotes()) || [];
    }
    function _ndChartChords(h) {
        const x = h || hw;
        if (!x) return [];
        if (typeof x.getFilteredChords === 'function') return x.getFilteredChords() || [];
        return (x.getChords && x.getChords()) || [];
    }

    function _ndChartOnsets(h) {
        const ts = [];
        for (const n of _ndChartNotes(h)) if (n && Number.isFinite(n.t)) ts.push(n.t);
        for (const c of _ndChartChords(h)) if (c && Number.isFinite(c.t)) ts.push(c.t);
        return ts.sort((a, b) => a - b);
    }

    function _ndTrainingChartSnapshot() {
        return {
            notes:  _ndChartNotes(),
            chords: _ndChartChords(),
            mastery: (hw && hw.getMastery) ? hw.getMastery() : null,
            hasPhraseData: !!(hw && hw.hasPhraseData && hw.hasPhraseData()),
        };
    }

    function _ndCalibrationNotes() {
        const singles = _ndChartNotes().filter((n) => n && Number.isFinite(n.t));
        if (singles.length) return singles;
        const out = [];
        for (const c of _ndChartChords()) {
            if (!c || !Number.isFinite(c.t)) continue;
            for (const m of (c.notes || [])) if (m) out.push({ ...m, t: c.t });
        }
        return out;
    }
    const isDefault = !!opts.isDefault;

    const externalStream = opts.audioStream || null;
    const externalAudioCtx = opts.audioCtx || null;

    const ownsStream = !externalStream;
    const ownsAudioCtx = !externalAudioCtx;

    let enabled = false;

    let detectPreference = true;

    let autoEnableTrial = false;

    let sessionGen = 0;
    let audioCtx = null;
    let stream = null;

    let sourceNode = null;
    let gainNode = null;
    let splitterNode = null;
    let mergerNode = null;
    let worklet = null;
    let levelAnalyser = null;

    let detectionMethod = 'yin';

    let detectionMethodUserSet = false;

    let nativeDetection = false;
    let timingTolerance = 0.150;
    let pitchTolerance = 50;
    let timingHitThreshold = 0.100;

    let chordTimingHitThreshold = 0.150;
    let pitchHitThreshold = 20;

    let cleanTimingThreshold = 0.050;
    let cleanPitchThreshold = 12;
    let showTimingErrors = true;
    let showPitchErrors = true;

    let edgeFlashEnabled = false;

    let tuningMode = false;

    let autoRecord = false;

    let frameSize = 2048;

    let autoCalibrate = true;
    let missMarkerDuration = 2.0;
    let hitGlowDuration = 0.5;
    let inputGain = 1.0;

    let engineInputGain = null;

    const CAL_TARGET_PEAK = 0.25;
    let selectedDeviceId = '';
    let selectedChannel = 'mono';

    let latencyOffset = 0.080;

    let chordHitRatio = 0.40;

    let detectionConfidenceMin = 0.20;

    try {
        const raw = localStorage.getItem(_ND_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s.deviceId !== undefined) selectedDeviceId = s.deviceId;

            if (['mono', 'left', 'right'].includes(s.channel)) selectedChannel = s.channel;
            const storedMethod = (typeof s.method === 'string'
                && ['yin', 'hps', 'crepe'].includes(s.method)) ? s.method : null;
            if (storedMethod) detectionMethod = storedMethod;

            detectionMethodUserSet = !!s.methodUserSet || (storedMethod !== null && storedMethod !== 'yin');

            if (s.timingTolerance !== undefined) timingTolerance = Math.max(0.03, Math.min(0.3, s.timingTolerance));
            if (s.pitchTolerance !== undefined) pitchTolerance = Math.max(10, Math.min(100, s.pitchTolerance));
            if (s.timingHitThreshold !== undefined) timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, s.timingHitThreshold));

            if (s.chordTimingHitThreshold !== undefined) chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
            if (s.pitchHitThreshold !== undefined) pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, s.pitchHitThreshold));
            if (s.cleanTimingThreshold !== undefined) cleanTimingThreshold = Math.max(0.01, Math.min(timingHitThreshold, s.cleanTimingThreshold));
            if (s.cleanPitchThreshold !== undefined) cleanPitchThreshold = Math.max(1, Math.min(pitchHitThreshold, s.cleanPitchThreshold));

            if (cleanTimingThreshold > timingHitThreshold) cleanTimingThreshold = timingHitThreshold;
            if (cleanPitchThreshold > pitchHitThreshold)   cleanPitchThreshold = pitchHitThreshold;
            if (s.showTimingErrors !== undefined) showTimingErrors = !!s.showTimingErrors;
            if (s.showPitchErrors !== undefined) showPitchErrors = !!s.showPitchErrors;
            if (s.edgeFlash !== undefined) edgeFlashEnabled = !!s.edgeFlash;
            if (s.tuningMode !== undefined) tuningMode = !!s.tuningMode;
            if (s.autoRecord !== undefined) autoRecord = !!s.autoRecord;
            if (s.frameSize !== undefined) frameSize = _ndClampFrameSize(s.frameSize);
            if (s.autoCalibrate !== undefined) autoCalibrate = !!s.autoCalibrate;
            if (s.nativeDetection !== undefined) nativeDetection = !!s.nativeDetection;

            if (s.detectEnabled !== undefined) detectPreference = !!s.detectEnabled;
            if (s.missMarkerDuration !== undefined) missMarkerDuration = Math.max(0.5, Math.min(5, s.missMarkerDuration));
            if (s.hitGlowDuration !== undefined) hitGlowDuration = Math.max(0.1, Math.min(2, s.hitGlowDuration));
            if (Number.isFinite(s.inputGain)) inputGain = Math.max(0.1, Math.min(5, s.inputGain));
            if (Number.isFinite(s.engineInputGain)) engineInputGain = Math.max(0.1, Math.min(5, s.engineInputGain));
            if (s.latencyOffset !== undefined) latencyOffset = s.latencyOffset;

            if (s.chordHitRatio !== undefined) chordHitRatio = Math.max(0.25, Math.min(1, s.chordHitRatio));

            if (s.autoDrillMisses !== undefined) {
                const n = parseInt(s.autoDrillMisses, 10);
                _autoDrillMisses = (Number.isFinite(n) && n > 0) ? n : 0;
            }

            if (s.detectionConfidenceMin !== undefined) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, s.detectionConfidenceMin));
            }
        }
    } catch (e) {  }

    if (isDefault && engineInputGain != null) {
        for (const ms of [800, 2500, 5000]) setTimeout(() => _ndApplyEngineGain(), ms);
    }

    if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
    if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;

    let _ndChannelIndex = selectedChannel === 'left' ? 0
        : selectedChannel === 'right' ? 1 : -1;

    let _ndDeviceKey = 0;
    if (typeof opts.deviceKey === 'number' && Number.isInteger(opts.deviceKey) && opts.deviceKey >= 0)
        _ndDeviceKey = opts.deviceKey;

    let _ndVerifierOffsetMs = 0;
    if (typeof opts.verifierOffsetMs === 'number' && Number.isFinite(opts.verifierOffsetMs))
        _ndVerifierOffsetMs = opts.verifierOffsetMs;
    function _ndApplyVerifierOffset() {
        const a = _ndBridgeAudio();

        if (_ndOwnsSource && sourceId != null && sourceId !== 0
            && a && typeof a.setSourceVerifierOffset === 'function') {
            try { a.setSourceVerifierOffset(sourceId, _ndVerifierOffsetMs / 1000); } catch (_) {  }
        }
    }

    if (typeof opts.channel === 'number' && Number.isInteger(opts.channel) && opts.channel >= -1) {
        if (opts.channel >= 2) {
            console.warn(`[note_detect] opts.channel ${opts.channel} (multi-channel selection) is not yet supported; using mono.`);
            _ndChannelIndex = -1;
            selectedChannel = 'mono';
        } else {
            _ndChannelIndex = opts.channel;
            if (opts.channel === 0) selectedChannel = 'left';
            else if (opts.channel === 1) selectedChannel = 'right';
            else selectedChannel = 'mono';
        }
    }

    let inputLevel = 0;
    let inputPeak = 0;
    let peakDecay = 0;

    let _lastAudioCbT = 0;
    let _maxCbGapMs = 0;
    let _scoringStalled = false;
    let _wdPlayStartT = 0;
    let _inputLost = false;
    let _lastInputRecover = 0;
    let scoringWatchdog = null;
    let _healthTrack = null;
    let _healthHandlers = null;

    let _calWizardEl = null;
    let _calWizardTick = null;
    let _calWizardState = null;

    let _calWizardOnDone = null;
    let _calWizardOnCancel = null;

    let _calWizardForceArrangement = null;
    const _CAL_WIZARD_NOTE_CHECK_DEFS = [
        { id: 'lowE', string: 0, fallbackLabel: 'Low E', fallbackMidi: 40 },
        { id: 'openA', string: 1, fallbackLabel: 'Open A', fallbackMidi: 45 },
    ];
    const _CAL_WIZARD_STEPS = [
        { id: 'welcome', title: 'Welcome' },
        { id: 'audio', title: 'Audio Input' },
        { id: 'tuner', title: 'Tuner' },
        { id: 'noise', title: 'Noise Floor' },
        { id: 'signal', title: 'Signal Level' },
        { id: 'notes', title: 'Note Detection' },
        { id: 'timing', title: 'Timing / Latency' },
        { id: 'review', title: 'Review' },
        { id: 'apply', title: 'Apply' },
    ];

    const _ndLevelSamples = [];
    const _ND_LEVEL_HISTORY_S = 6;
    const _ND_LEVEL_WIN_HALF = 0.2;
    const _ND_SILENCE_THRESHOLD = 0.02;

    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;

    let score = 0;
    let multiplier = 1;
    let maxMultiplier = 1;
    let sectionStats = [];
    let currentSection = null;
    const noteResults = new Map();

    const _scoreLedger = new Map();

    let seekResetSubscribed = false;
    let seekResetOnSeekFn = null;

    const _diagBreakdown = {
        pure: 0,
        chordPartial: 0,
        early: 0,
        late: 0,
        sharp: 0,
        flat: 0,
    };

    const _ND_VERIFIER_REJECT_MAX = 20;
    const _ndVerifierRejects = [];
    const _ndRejectDedup = new Set();
    const _ndVerifyFailSnap = new Map();
    const _ND_REJECT_REASON_LABEL = {
        NO_VERDICT: 'engine no verdict',
        SILENCE_GATE: 'silence gate',
        STRING_VERIFY_FAIL: 'string verify fail',
        CHORD_RATIO_FAIL: 'chord ratio fail',
        TIMING_FAIL: 'timing fail',
        PITCH_FAIL: 'pitch fail',
        RETIRE_NO_MATCH: 'retire no match',
        UNKNOWN: 'unknown',
    };
    const _diagSingles = { hits: 0, misses: 0 };
    const _diagChords  = { hits: 0, misses: 0 };

    const _diagClean = { clean: 0, loose: 0 };

    const _diagPerString = Array.from({ length: 8 }, () => ({ hits: 0, misses: 0 }));

    const _DIAG_ERROR_CAP = 2000;
    const _diagTimingErrors = [];

    const _diagTimingErrorsHits = [];

    let _calDetections = [];
    const _CAL_MAX = 8000;
    let _calDoneThisPlay = false;

    let _calPaused = false;
    let _lastAvCalibration = null;
    const _diagPitchErrors  = [];

    const _DIAG_EVENT_CAP = 2000;
    const _diagEvents = [];

    let _liveSessionId = null;

    let _liveLastSessionId = null;
    function _buildSessionHeader() {

        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
        const avOffsetMs = (hw && hw.getAvOffset) ? hw.getAvOffset() : 0;
        return {
            type: 'session_start',
            schema: 'note_detect.live.session_start.v1',
            ts: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            song: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                tuning: info.tuning || null,
                capo: info.capo != null ? info.capo : 0,
                duration: info.duration != null ? info.duration : null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
                av_offset_ms: avOffsetMs,
            },
        };
    }
    function _streamLiveJudgment(eventObj) {

        try {
            const p = fetch(
                '/api/plugins/note_detect/live-judgment?session='
                    + encodeURIComponent(_liveSessionId),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventObj),
                    keepalive: true,
                },
            ).catch(() => {});
            _livePending.add(p);
            p.finally(() => _livePending.delete(p));
        } catch (e) {  }
    }

    const _livePending = new Set();
    async function _flushLiveJudgments() {

        try { await Promise.allSettled([..._livePending]); } catch (_) {}
    }

    let _recArmed = false;
    let _recArmedForTraining = false;

    let _recSongPlaying = false;
    let _recChunks = [];
    let _recSampleRate = 44100;
    let _recLastSavePath = null;
    let _recLastSaveError = null;
    let _recSaveInFlight = false;
    let _recCappedAt = null;
    let _recTotalSamples = 0;

    let _recTrainingUploadInFlight = false;
    let _recTrainingUploadResult = null;

    let _summaryDeferred = false;

    let _ndAutoExitRelease = null;

    let _xpSubmittedTake = false;

    let _trainingCapture = null;

    const _susActiveUntil = new Map();

    let _ndLastMissScanT = null;

    let drillEnabled = false;
    let drillIterations = [];
    let drillIterStartT = null;
    let drillIterHits = 0;
    let drillIterMisses = 0;
    let drillIterStreak = 0;
    let drillIterBestStreak = 0;
    let drillSubscribed = false;

    let drillOnLoopRestartFn = null;
    let drillOnSongChangedFn = null;
    let drillOnLoopChangedFn = null;

    const DRILL_LOOP_POLL_MS = 1000;
    let drillLoopPollLastMs = 0;

    let endOfSongSubscribed = false;
    let endOfSongOnEndedFn = null;

    let reArmSubscribed = false;
    let reArmOnLoadedFn = null;

    let drillActiveLoopA = null;
    let drillActiveLoopB = null;

    let drillNextIdx = 1;
    const DRILL_MAX_ITERATIONS = 50;

    let drillDirty = true;

    let drillConductorActive = false;
    let drillConductorLadder = null;
    let drillConductorRung = 0;
    let drillConductorGoal = _ND_DRILL_DEFAULT_GOAL;
    let drillConductorBest = 0;
    let drillConductorFailStreak = 0;
    let drillConductorTopClears = 0;
    let drillConductorFocus = null;
    let drillConductorLabel = null;
    let drillConductorSavedSpeed = null;
    let drillConductorRange = null;

    let drillConductorExpandsLeft = 0;
    let drillConductorOnWrapFn = null;
    let _drillHudRemoveTimer = null;
    let _ndDrillLastChartT = 0;
    let _ndDrillLastScoredPerf = 0;

    let _drillBeatTimes = [];
    let _drillBeatIdx = 0;
    const _CLICK_LOOKAHEAD_S = 0.12;
    const _ndPerfNow = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const _ndMmSs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    let _autoDrillMisses = _ndAutoDrillMissesSetting();
    let _autoDrillMissStreak = 0;
    let _autoDrillFirstMissT = NaN;
    let _autoDrillLastMissT = NaN;
    let _autoDrillCooldownUntil = 0;

    let detectedMidi = -1;
    let detectedConfidence = 0;
    let detectedString = -1;
    let detectedFret = -1;
    let detectedDisplayMidi = -1;
    let underBufferWarned = false;

    let _verifyTarget = null;

    let _verifyTargetCtx = null;

    let _verifyTargetSig = null;

    // Caller-supplied verify contexts isolate exercises from the loaded song.
    function _ndVerifyActiveCtx() {
        if (_verifyTargetCtx) return _verifyTargetCtx;
        return {
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            offsets: tuningOffsets,
            capo,
        };
    }
    function _ndVerifyActiveSig() {
        const c = _ndVerifyActiveCtx();
        return _ndVerifySigFor(c.arrangement, c.stringCount, c.offsets, c.capo);
    }

    let lastChordScore = null;
    let lastChordHit = 0;
    let lastChordTotal = 0;

    const _chordLastResult = new Map();
    let lastChordTime = -Infinity;

    const _RESCUE_BUF_MAX = 32768;
    const _RESCUE_WIN = 16384;
    let _rescueBuf = new Float32Array(0);
    let _rescueBufEndT = 0;
    let _rescueCalls = 0, _rescueWindows = 0, _rescueHits = 0, _rescueSkippedSilent = 0;

    const _RESCUE_WINDOWS_PER_TICK = 24;

    let currentArrangement = 'guitar';

    const defaultTuningOffsets = [0, 0, 0, 0, 0, 0];
    let tuningOffsets = defaultTuningOffsets;
    let capo = 0;
    let currentStringCount = 6;

    let accumBuffer = new Float32Array(0);
    let pendingBuffer = null;
    let processingFrame = false;

    let detectInterval = null;
    let levelRaf = null;

    let _vuPanelEl = null;
    let _vuBarEl = null;
    let _vuPeakEl = null;
    let _vuPanelAbsent = false;
    let bridgeLevelTimer = null;

    let bridgeLevelsUnavailable = false;
    let hudInterval = null;
    let missCheckInterval = null;
    let gcInterval = null;
    let flashTimeouts = [];

    let usingDesktopBridge = false;

    const _ndGateToken = {};

    function _ndUpdateMlGate() {

        const wantsMl = !!(enabled && usingDesktopBridge && !_ndUsingEngineVerifier
            && !_ndHostChartSuspended && !_ndOtherOwnsOurSlot());
        _ndSyncMlGate(_ndGateToken, wantsMl, _ndBridgeAudio());
    }

    let usingNativeFrames = false;

    let bridgeSampleRate = 48000;

    let bridgeDesktop = null;

    let sourceId = (typeof opts.sourceId === 'number' && opts.sourceId >= 0)
        ? opts.sourceId : null;
    const _ndWantOwnSource = sourceId == null && !isDefault && opts.ownSource === true;
    let _ndOwnsSource = false;

    const _ndOrphanSourceIds = [];

    // Bridge adapters keep default-source and source-indexed APIs interchangeable.
    function _ndBridgeAudio() { return (bridgeDesktop && bridgeDesktop.audio) || null; }

    function _ndResolveAudioBridge() {
        const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        return (d && d.audio) || _ndBridgeAudio();
    }

    function _ndSetEngineGain(g) {
        const a = _ndResolveAudioBridge();
        if (a && typeof a.setGain === 'function') {
            try { a.setGain('input', g); return true; } catch (_) {  }
        }
        return false;
    }

    function _ndApplyEngineGain() {
        if (engineInputGain == null) return false;
        return _ndSetEngineGain(engineInputGain);
    }

    function _ndDesktopSourceApiReady(a) {
        return !!a
            && typeof a.scoreSourceChord === 'function'
            && typeof a.setSourceChart === 'function'
            && typeof a.getSourceNoteVerdicts === 'function'
            && typeof a.getSourcePitchDetection === 'function';
    }
    function _ndBridgeScoreAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        return sourceId != null
            ? typeof a.scoreSourceChord === 'function'
            : typeof a.scoreChord === 'function';
    }
    function _ndBridgeScoreChord(ctx) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.scoreSourceChord === 'function')
            return a.scoreSourceChord(sourceId, ctx);
        if (sourceId == null && typeof a.scoreChord === 'function')
            return a.scoreChord(ctx);
        return Promise.resolve(null);
    }
    function _ndBridgeVerifierAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        return sourceId != null
            ? (typeof a.setSourceChart === 'function' && typeof a.getSourceNoteVerdicts === 'function')
            : (typeof a.setChart === 'function' && typeof a.getNoteVerdicts === 'function');
    }
    function _ndBridgeSetChart(chart) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.setSourceChart === 'function')
            return a.setSourceChart(sourceId, chart);
        if (sourceId == null && typeof a.setChart === 'function')
            return a.setChart(chart);
        return Promise.resolve(null);
    }
    function _ndBridgeGetVerdicts(songTime, playing) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.getSourceNoteVerdicts === 'function')
            return a.getSourceNoteVerdicts(sourceId, songTime, playing);
        if (sourceId == null && typeof a.getNoteVerdicts === 'function')
            return a.getNoteVerdicts(songTime, playing);
        return Promise.resolve(null);
    }

    function _ndBridgeRawPitch() {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null) {
            if (typeof a.getSourceRawPitch === 'function') return a.getSourceRawPitch(sourceId);
            if (typeof a.getSourcePitchDetection === 'function') return a.getSourcePitchDetection(sourceId);
            return Promise.resolve(null);
        }
        if (typeof a.getRawPitch === 'function') return a.getRawPitch();
        if (typeof a.getPitchDetection === 'function') return a.getPitchDetection();
        return Promise.resolve(null);
    }

    function _ndBridgeRawAudioFrame(numSamples) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null) {
            if (typeof a.getSourceRawAudioFrame === 'function') return a.getSourceRawAudioFrame(sourceId, numSamples);
            return Promise.resolve(null);
        }
        if (typeof a.getRawAudioFrame === 'function') return a.getRawAudioFrame(numSamples);
        return Promise.resolve(null);
    }

    function _ndBridgeRawFramesAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        if (sourceId != null) return typeof a.getSourceRawAudioFrame === 'function';
        return typeof a.getRawAudioFrame === 'function';
    }

    function _ndBridgePitch() {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.getSourcePitchDetection === 'function')
            return a.getSourcePitchDetection(sourceId);
        if (sourceId == null && typeof a.getPitchDetection === 'function')
            return a.getPitchDetection();
        return Promise.resolve(null);
    }

    function _ndTryFreeSource(id) {
        if (id == null) return true;
        const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        const a = d && d.audio;
        if (!a || typeof a.removeSource !== 'function') return false;
        try {
            const r = a.removeSource(id);

            if (r && typeof r.then === 'function') r.then(undefined, () => {});
            return true;
        } catch (_) { return false; }
    }

    function _ndFlushOrphanSources() {
        for (let i = _ndOrphanSourceIds.length - 1; i >= 0; i--) {
            if (_ndTryFreeSource(_ndOrphanSourceIds[i])) _ndOrphanSourceIds.splice(i, 1);
        }
    }

    function _ndReleaseOwnedSource() {
        _ndFlushOrphanSources();
        if (_ndOwnsSource && sourceId != null) _ndTryFreeSource(sourceId);
        _ndOwnsSource = false;
        sourceId = null;
    }

    const ND_AUDIO_REQUESTER = 'note_detect';
    const ND_AUDIO_CAL_REQUESTER = 'note_detect:calibration';
    // Only sources allocated by this instance are released during teardown.
    async function _ndOpenSelectedInputSource(requesterId, purpose) {
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') return false;
        try {
            const res = await caps.command('audio-input', 'open-source', {
                requester: requesterId,

                payload: { purpose: purpose || 'note-detection' },
            });
            return !!(res && (res.outcome === 'handled' || res.status === 'open'));
        } catch (_) { return false; }
    }
    async function _ndCloseSelectedInputSource(requesterId) {
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') return;
        try { await caps.command('audio-input', 'close-source', { requester: requesterId, payload: {} }); }
        catch (_) {  }
    }

    let _ndUsingEngineVerifier = false;

    let _ndVerifierChartById = new Map();

    let _ndVerifierChords = new Map();
    let _ndVerifierChordKeyOf = new Map();
    let _ndPendingChords = new Map();

    let _ndVerifierChartSig = '';

    const _ndDrainStats = { dropUnknownId: 0, suppressedRedelivery: 0, maxBatch: 0 };

    let _ndLastPushedPlayhead = 0;

    let _ndContainedActive = false;

    let _ndContainedGen = 0;

    const _ND_CONTAINED_BUF_MAX = 512;

    let _ndContainedById = new Map();

    let _ndContainedCtx = null;

    let _ndContainedVerdictBuf = [];

    let _ndContainedLastPlayhead = 0;

    let _ndHostChartSuspended = false;

    let bridgeMlActive = false;

    let _diagDetector = null;

    let bridgeOnsetSeqSeen = new Map();
    let bridgeNewOnsets = new Map();
    let bridgeOnsetPrimed = false;

    let lastHitCount = 0;
    let lastMissCount = 0;

    let displayScore = 0;
    let lastMultTier = 1;
    let lastStreakVal = 0;

    const container = opts.container || document.getElementById('player');
    const instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance-root';
    instanceRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    try { instanceRoot.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
    let detectBtn = null;
    let gearBtn = null;

    const drawHookFn = (ctx, W, H) => drawOverlay(ctx, W, H);
    let drawHookRegistered = false;
    function ensureDrawHook() {
        if (drawHookRegistered) return;
        const h = resolveHw();
        if (h && h.addDrawHook) {
            h.addDrawHook(drawHookFn);
            drawHookRegistered = true;
        }

        if (h && h.setNoteStateProvider) {
            const existing = (typeof h.getNoteStateProvider === 'function') ? h.getNoteStateProvider() : null;
            if (existing == null || existing === noteStateFor) h.setNoteStateProvider(noteStateFor);
        }
    }

    function saveSettings() {
        if (!isDefault) return;
        try {
            localStorage.setItem(_ND_STORAGE_KEY, JSON.stringify({
                deviceId: selectedDeviceId,
                channel: selectedChannel,
                method: detectionMethod,

                methodUserSet: detectionMethodUserSet,
                nativeDetection,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                showTimingErrors,
                showPitchErrors,
                edgeFlash: edgeFlashEnabled,
                tuningMode,
                autoRecord,
                frameSize,
                autoCalibrate,
                detectEnabled: detectPreference,
                missMarkerDuration,
                hitGlowDuration,
                inputGain,
                engineInputGain,
                latencyOffset,
                chordHitRatio,
                detectionConfidenceMin,
            }));
        } catch (e) {  }
    }

    async function openInstrumentStream(constraints, { allowDeviceFallback = true } = {}) {
        for (;;) {
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (e) {
                if (e.name !== 'OverconstrainedError') throw e;
                if (e.constraint === 'deviceId' && constraints.audio.deviceId) {
                    if (!allowDeviceFallback) {

                        throw e;
                    }

                    selectedDeviceId = '';
                    saveSettings();
                    delete constraints.audio.deviceId;
                } else if ((e.constraint === 'channelCount' || !e.constraint)
                           && constraints.audio.channelCount !== undefined) {

                    delete constraints.audio.channelCount;
                } else {

                    throw e;
                }
            }
        }
    }

    // Select the desktop bridge when available; otherwise build a browser audio graph.
    async function startAudio() {
        try {

            const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
            const canUseDesktopBridge = !externalStream && !externalAudioCtx
                && desktop && desktop.isDesktop
                && desktop.audio
                && typeof desktop.audio.getPitchDetection === 'function'
                && typeof desktop.audio.isAvailable === 'function';
            if (canUseDesktopBridge) {
                let bridgeReady = false;
                try {
                    bridgeReady = await desktop.audio.isAvailable();
                } catch (_) {  }
                if (bridgeReady) {

                    await _ndOpenSelectedInputSource(ND_AUDIO_REQUESTER, 'note-detection');

                    try {
                        const running = typeof desktop.audio.isAudioRunning === 'function'
                            ? await desktop.audio.isAudioRunning()
                            : false;
                        if (!running && typeof desktop.audio.startAudio === 'function') {
                            await desktop.audio.startAudio();
                        }
                    } catch (_) {  }

                    usingDesktopBridge = true;
                    bridgeDesktop = desktop;
                    accumBuffer = new Float32Array(0);

                    if (_ndDesktopSourceApiReady(desktop.audio)) {

                        _ndFlushOrphanSources();

                        if (sourceId == null && !_ndOwnsSource
                            && typeof opts.sourceId === 'number' && opts.sourceId >= 0) {
                            sourceId = opts.sourceId;
                        }
                        if (_ndWantOwnSource && sourceId == null
                            && typeof desktop.audio.addSource === 'function') {
                            try {
                                const id = await desktop.audio.addSource(_ndChannelIndex, _ndDeviceKey);
                                if (typeof id === 'number' && id >= 0) {
                                    sourceId = id;
                                    _ndOwnsSource = true;
                                }
                            } catch (_) {  }
                        }

                        if (sourceId != null && sourceId !== 0
                            && typeof desktop.audio.setSourceInputChannel === 'function') {
                            try {
                                desktop.audio.setSourceInputChannel(sourceId, _ndChannelIndex);
                            } catch (_) {  }
                        }

                        if (sourceId != null) _ndApplyVerifierOffset();
                    } else if (sourceId != null) {

                        if (!_ndOwnsSource) {
                            console.warn('[note_detect] desktop addon lacks the source-indexed '
                                + 'scoring API; ignoring opts.sourceId and using the default input');
                        } else if (!_ndTryFreeSource(sourceId)) {
                            _ndOrphanSourceIds.push(sourceId);
                        }
                        sourceId = null;
                        _ndOwnsSource = false;
                    }

                    bridgeMlActive = false;
                    if (typeof desktop.audio.isMlNoteDetection === 'function') {
                        try {
                            bridgeMlActive = (await desktop.audio.isMlNoteDetection()) === true;
                        } catch (_) {  }
                    }
                    console.log(`[note_detect] desktop bridge active — ML detection: ${bridgeMlActive ? 'ON' : 'OFF (YIN fallback)'}`);

                    bridgeSampleRate = 48000;
                    if (typeof desktop.audio.getSampleRate === 'function') {
                        try {
                            const sr = await desktop.audio.getSampleRate();
                            if (Number.isFinite(sr) && sr > 0) bridgeSampleRate = sr;
                        } catch (_) {  }
                    }

                    const hasDetectNotes = typeof desktop.audio.detectNotes === 'function';

                    usingNativeFrames = nativeDetection && _ndBridgeRawFramesAvailable();
                    if (usingNativeFrames) {
                        console.log('[note_detect] native-frame detection active — local '
                            + `${detectionMethod || 'yin'} on engine audio; chords via engine scoreChord`);
                    }

                    detectInterval = setInterval(async () => {

                        _ndUpdateMlGate();
                        if (!enabled || processingFrame) return;
                        processingFrame = true;
                        const gen = sessionGen;
                        try {

                            if (_ndHostChartSuspended || _ndOtherOwnsOurSlot()) return;

                            if (usingNativeFrames) {
                                const want = _ndMinAnalysisSamples(currentArrangement, bridgeSampleRate);
                                let frame = null;
                                try { frame = await _ndBridgeRawAudioFrame(want); }
                                catch (_) { frame = null; }
                                if (!enabled || gen !== sessionGen) return;

                                if (frame && frame.length >= want) await processFrame(frame);
                                return;
                            }

                            if (_ndUsingEngineVerifier) {

                                if (_ndChartSignature() !== _ndVerifierChartSig) {
                                    await _ndPushChartToBridge({ chartStateSynced: true });
                                    if (!enabled || gen !== sessionGen) return;
                                }
                                await _ndDrainEngineVerdicts();
                                if (!enabled || gen !== sessionGen) return;

                                try {

                                    const lp = await _ndBridgeRawPitch();
                                    if (!enabled || gen !== sessionGen) return;
                                    if (lp && typeof lp.midiNote === 'number' && lp.midiNote >= 0
                                        && typeof lp.confidence === 'number'

                                        && lp.confidence > detectionConfidenceMin) {
                                        detectedMidi = lp.midiNote;
                                        detectedConfidence = lp.confidence;

                                        _calLogDetection();
                                    } else {
                                        detectedMidi = -1;
                                        detectedConfidence = 0;
                                    }
                                } catch (_) {

                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                }
                                _diagDetector = {
                                    desktop_bridge: true,
                                    ml: bridgeMlActive,
                                    path: 'desktop-engine-verifier',
                                };

                                if (_verifyTarget) await _runVerifyTarget(null);
                                return;
                            }

                            let detection = null;
                            if (hasDetectNotes) {
                                try { detection = await desktop.audio.detectNotes(); }
                                catch (_) { detection = null; }
                                if (!enabled || gen !== sessionGen) return;
                            }

                            if (detection && Array.isArray(detection.notes)) {
                                bridgeNewOnsets.clear();
                                for (const n of detection.notes) {
                                    if (!n || typeof n.midi !== 'number'
                                        || typeof n.onsetSeq !== 'number') continue;
                                    const prev = bridgeOnsetSeqSeen.get(n.midi);
                                    if (prev !== undefined && n.onsetSeq <= prev) continue;
                                    bridgeOnsetSeqSeen.set(n.midi, n.onsetSeq);

                                    if (bridgeOnsetPrimed
                                        && typeof n.confidence === 'number'
                                        && n.confidence >= detectionConfidenceMin) {
                                        bridgeNewOnsets.set(n.midi, {
                                            ageMs: Number.isFinite(n.onsetMs) ? n.onsetMs : 0,
                                            conf: n.confidence,
                                        });
                                    }
                                }
                                bridgeOnsetPrimed = true;

                                let best = null;
                                for (const n of detection.notes) {
                                    if (n && typeof n.midi === 'number'
                                        && (best === null || n.confidence > best.confidence)) {
                                        best = n;
                                    }
                                }
                                if (best && best.confidence >= detectionConfidenceMin) {
                                    detectedMidi = best.midi;
                                    detectedConfidence = best.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            } else {
                                bridgeNewOnsets.clear();
                                const p = await _ndBridgePitch();
                                if (!enabled || gen !== sessionGen) return;
                                if (p && typeof p.midiNote === 'number' && p.midiNote >= 0
                                    && typeof p.confidence === 'number' && p.confidence >= detectionConfidenceMin) {
                                    detectedMidi = p.midiNote;
                                    detectedConfidence = p.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            }

                            _diagDetector = {
                                desktop_bridge: true,
                                ml: bridgeMlActive,
                                path: bridgeMlActive ? 'desktop-ml-basicpitch' : 'desktop-yin',
                            };

                            await matchNotes(null);
                        } catch (e) {
                            console.warn('[note_detect] bridge poll failed:', e && e.message ? e.message : e);
                        } finally {
                            processingFrame = false;
                        }
                    }, 50);

                    startBridgeLevelMeter(desktop);
                    populateDevices();
                    return true;
                }

            }

            if (externalStream) {
                stream = externalStream;
            } else {
                const constraints = {
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                    }
                };
                if (selectedDeviceId) {
                    constraints.audio.deviceId = { exact: selectedDeviceId };
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    const msg = isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.';
                    throw new Error(msg);
                }

                stream = await openInstrumentStream(constraints, {
                    allowDeviceFallback: !autoEnableTrial,
                });
            }

            audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)({
                latencyHint: 'interactive',
            });

            sourceNode = audioCtx.createMediaStreamSource(stream);
            const streamChannels = sourceNode.channelCount;

            try { _bindStreamHealth(stream); } catch (_) {}

            gainNode = audioCtx.createGain();
            gainNode.gain.value = inputGain;

            if (streamChannels >= 2 && selectedChannel !== 'mono') {
                splitterNode = audioCtx.createChannelSplitter(2);
                sourceNode.connect(splitterNode);
                mergerNode = audioCtx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                splitterNode.connect(mergerNode, chIdx, 0);
                mergerNode.connect(gainNode);
            } else {
                sourceNode.connect(gainNode);
            }

            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            const processor = audioCtx.createScriptProcessor(frameSize, 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {

                const _cbNow = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
                if (_lastAudioCbT) {
                    const gap = _cbNow - _lastAudioCbT;
                    if (gap > _maxCbGapMs) _maxCbGapMs = gap;
                }
                _lastAudioCbT = _cbNow;
                if (!enabled) return;
                const input = e.inputBuffer.getChannelData(0);
                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);

                const minSamples = _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate);
                if (combined.length >= minSamples) {
                    const start = combined.length - minSamples;
                    pendingBuffer = combined.slice(start, start + minSamples);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

            detectInterval = setInterval(() => {
                if (processingFrame || !pendingBuffer) return;
                const buf = pendingBuffer;
                pendingBuffer = null;
                processingFrame = true;
                processFrame(buf).finally(() => { processingFrame = false; });
            }, 50);

            gainNode.connect(processor);
            processor.connect(audioCtx.destination);

            startLevelMeter();
            populateDevices();

            return true;
        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);

            if (enabled && !autoEnableTrial) {
                alert('Note Detection: Could not access audio input.\n\n' + e.message);
            }

            stopAudio();
            return false;
        }
    }

    function _unbindStreamHealth() {
        if (!_healthHandlers) return;
        const { track, ended, mute, unmute } = _healthHandlers;
        try {
            track.removeEventListener('ended', ended);
            track.removeEventListener('mute', mute);
            track.removeEventListener('unmute', unmute);
        } catch (_) {  }
        _healthHandlers = null;
    }

    function _bindStreamHealth(s) {
        if (!s || typeof s.getAudioTracks !== 'function') return;
        const track = s.getAudioTracks()[0];
        if (!track) return;

        _unbindStreamHealth();
        _healthTrack = track;
        const markLost = (why) => {
            if (_inputLost || !enabled) return;
            _inputLost = true;
            console.warn(`[note_detect] input ${why} — the audio interface dropped the input stream`);
            try { updateButton(); } catch (_) {}
            setTimeout(() => {
                if (!enabled || !_inputLost) return;
                const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
                if (now - _lastInputRecover < 4000) return;
                _lastInputRecover = now;
                console.warn('[note_detect] re-acquiring input after drop');
                try { restartAudio(); } catch (_) {}
            }, 1500);
        };
        const onEnded = () => markLost('ended');
        const onMute = () => markLost('muted');
        const onUnmute = () => {
            if (!_inputLost) return;
            _inputLost = false;
            try { updateButton(); } catch (_) {}
        };
        try {
            track.addEventListener('ended', onEnded);
            track.addEventListener('mute', onMute);
            track.addEventListener('unmute', onUnmute);
            _healthHandlers = { track, ended: onEnded, mute: onMute, unmute: onUnmute };
        } catch (_) {  }
    }

    function _bindScoringWatchdog() {
        if (!isDefault || scoringWatchdog) return;
        scoringWatchdog = setInterval(_scoringWatchdogTick, 1000);

        if (scoringWatchdog && typeof scoringWatchdog.unref === 'function') scoringWatchdog.unref();
    }

    function _scoringWatchdogTick() {
        const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;

        if (typeof window !== 'undefined' && window.__ndSuppressDefault) {
            _wdPlayStartT = 0; _clearScoringStall(); return;
        }
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);

        if (!playing || !detectPreference) { _wdPlayStartT = 0; _clearScoringStall(); return; }
        if (!_wdPlayStartT) { _wdPlayStartT = now; _maxCbGapMs = 0; }

        if (now - _wdPlayStartT < 2500) return;

        const cbFresh = (now - _lastAudioCbT) < 1800;
        if (_ndScoringHealthy(enabled, usingDesktopBridge, _extActive, cbFresh)) { _clearScoringStall(); return; }

        if (_ndIsExternalScoredArrangement()) { _clearScoringStall(); return; }

        if (!_scoringStalled) {
            _scoringStalled = true;
            _inputLost = true;
            console.warn(`[note_detect] scoring watchdog: playing + detect wanted, but not scoring (enabled=${enabled}, cbAgeMs=${now - _lastAudioCbT}) — recovering`);
            try { updateButton(); } catch (_) {}
            try { _showScoringStallBanner(); } catch (_) {}
            try { _logInputDropout(now - _lastAudioCbT); } catch (_) {}
        }
        if (now - _lastInputRecover >= 4000) {
            _lastInputRecover = now;
            if (!enabled) {
                console.warn('[note_detect] scoring watchdog: re-enabling detection');
                try { Promise.resolve(enable()).catch(() => {}); } catch (_) {}
            } else {
                console.warn('[note_detect] scoring watchdog: re-acquiring input');
                try { restartAudio(); } catch (_) {}
            }
        }
    }

    function _clearScoringStall() {
        if (!_scoringStalled) return;
        _scoringStalled = false;
        _inputLost = false;
        try { updateButton(); } catch (_) {}
        try { _hideScoringStallBanner(); } catch (_) {}
    }

    function _showScoringStallBanner() {
        let banner = instanceRoot.querySelector('.nd-scoring-stall');
        if (!banner) {
            banner = document.createElement('div');
            banner.className = 'nd-scoring-stall fixed top-3 left-1/2 -translate-x-1/2 z-[300] flex items-center gap-3 bg-red-900/95 border-2 border-red-500 rounded-xl px-4 py-2.5 shadow-2xl text-sm';
            banner.innerHTML = '<span class="text-red-100 font-semibold">⚠ Detect is ON but not hearing your instrument — input dropped. Reconnecting…</span>'
                + '<button class="nd-scoring-stall-retry px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-xs text-white">Reconnect now</button>';
            instanceRoot.appendChild(banner);
            const retry = banner.querySelector('.nd-scoring-stall-retry');
            if (retry) retry.onclick = () => { try { restartAudio(); } catch (_) {} };
        }
        banner.style.display = '';
    }

    function _hideScoringStallBanner() {
        const banner = instanceRoot.querySelector('.nd-scoring-stall');
        if (banner) banner.remove();
    }

    function _logInputDropout(sinceCbMs) {
        let heapMb = null;
        try {
            if (typeof performance !== 'undefined' && performance.memory) {
                heapMb = Math.round(performance.memory.usedJSHeapSize / 1048576);
            }
        } catch (_) {}
        const rec = {
            type: 'input_dropout',
            schema: 'note_detect.live.input_dropout.v1',
            ts: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            since_last_cb_ms: sinceCbMs,
            enabled,
            audio_ctx_state: (audioCtx && audioCtx.state) || null,
            sample_rate: (audioCtx && audioCtx.sampleRate) || null,
            frame_size: frameSize,
            processing_frame: processingFrame,
            max_cb_gap_ms: _maxCbGapMs,
            rec_armed: !!(_recArmed || _recArmedForTraining),
            using_bridge: usingDesktopBridge,
            arrangement: currentArrangement || null,
            track_ready: (_healthTrack && _healthTrack.readyState) || null,
            track_muted: _healthTrack ? !!_healthTrack.muted : null,
            track_enabled: _healthTrack ? !!_healthTrack.enabled : null,
            heap_mb: heapMb,
        };
        try { console.warn('[note_detect] input_dropout', JSON.stringify(rec)); } catch (_) {}
        try { if (_liveSessionId) _streamLiveJudgment(rec); } catch (_) {}
    }

    function stopAudio() {

        _ndSyncMlGate(_ndGateToken, false, _ndBridgeAudio());
        _inputLost = false;
        _unbindStreamHealth();
        _healthTrack = null;
        stopLevelMeter();
        stopBridgeLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;

        usingDesktopBridge = false;
        usingNativeFrames = false;
        bridgeDesktop = null;

        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndLastPushedPlayhead = 0;
        bridgeMlActive = false;
        bridgeOnsetSeqSeen = new Map();
        bridgeNewOnsets = new Map();
        bridgeOnsetPrimed = false;

        if (worklet) {
            worklet.onaudioprocess = null;
            try { worklet.disconnect(); } catch (e) {  }
            worklet = null;
        }
        if (levelAnalyser) {
            try { levelAnalyser.disconnect(); } catch (e) {}
            levelAnalyser = null;
        }
        if (gainNode) {
            try { gainNode.disconnect(); } catch (e) {}
            gainNode = null;
        }
        if (mergerNode) {
            try { mergerNode.disconnect(); } catch (e) {}
            mergerNode = null;
        }
        if (splitterNode) {
            try { splitterNode.disconnect(); } catch (e) {}
            splitterNode = null;
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode = null;
        }

        if (stream && ownsStream) {
            stream.getTracks().forEach(t => t.stop());
        }
        stream = null;
        if (audioCtx && ownsAudioCtx) {
            try { audioCtx.close(); } catch (e) {  }
        }
        audioCtx = null;
        inputLevel = 0;
        inputPeak = 0;
        accumBuffer = new Float32Array(0);
    }

    let audioOpChain = Promise.resolve();
    // Serialize graph changes so enable, restart, and teardown cannot overlap.
    function queueAudioOp(fn) {
        const queued = audioOpChain.then(fn);

        audioOpChain = queued.catch(() => {});
        return queued;
    }

    function restartAudio() {
        return queueAudioOp(async () => {
            sessionGen++;
            const gen = sessionGen;
            stopAudio();
            if (!enabled) return;
            const ok = await startAudio();

            if (!ok) {
                if (gen === sessionGen && enabled) {
                    disable({ silent: true });
                }
                return;
            }

            if (gen !== sessionGen || !enabled) {
                stopAudio();
            }
        });
    }

    function startBridgeLevelMeter(desktop) {
        stopBridgeLevelMeter();

        if (!desktop || !desktop.audio) {

            return;
        }
        if (typeof desktop.audio.getLevels !== 'function') {
            bridgeLevelsUnavailable = true;
            return;
        }
        bridgeLevelsUnavailable = false;

        let levelsInFlight = false;
        bridgeLevelTimer = setInterval(async () => {
            if (!enabled || !usingDesktopBridge || levelsInFlight) return;
            levelsInFlight = true;
            try {

                let levels;
                if (sourceId != null && sourceId !== 0) {

                    if (typeof desktop.audio.getSourceLevels !== 'function') {

                        bridgeLevelsUnavailable = true;
                        _ndLevelSamples.length = 0;
                        return;
                    }
                    levels = await desktop.audio.getSourceLevels(sourceId);
                } else {
                    levels = await desktop.audio.getLevels();
                }

                if (!enabled || !usingDesktopBridge) return;
                if (!levels) return;

                const rawLevel = Number.isFinite(levels.inputLevel) ? levels.inputLevel : 0;
                inputLevel = Math.min(1, Math.max(0, rawLevel));

                if (hw && typeof hw.getTime === 'function') {
                    const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                    const songT = hw.getTime() + avO;
                    const last = _ndLevelSamples.length
                        ? _ndLevelSamples[_ndLevelSamples.length - 1].songT
                        : -Infinity;
                    if (songT < last - 0.05) {

                        _ndLevelSamples.length = 0;
                    }
                    _ndLevelSamples.push({ songT, level: inputLevel });
                    const cutoff = songT - _ND_LEVEL_HISTORY_S;
                    while (_ndLevelSamples.length > 0 && _ndLevelSamples[0].songT < cutoff) {
                        _ndLevelSamples.shift();
                    }

                    while (_ndLevelSamples.length > 240) {
                        _ndLevelSamples.shift();
                    }
                }
                const rawPeak = Number.isFinite(levels.inputPeak) ? levels.inputPeak : inputLevel;
                const peak = Math.min(1, Math.max(0, rawPeak));
                if (peak > inputPeak) {
                    inputPeak = peak;
                    peakDecay = 30;
                } else if (peakDecay > 0) {
                    peakDecay--;
                } else {
                    inputPeak *= 0.95;
                }
                drawSettingsVU();
            } catch (_) {  }
            finally { levelsInFlight = false; }
        }, 50);
    }

    function stopBridgeLevelMeter() {
        if (bridgeLevelTimer) {
            clearInterval(bridgeLevelTimer);
            bridgeLevelTimer = null;
        }
    }

    function startLevelMeter() {
        stopLevelMeter();

        let levelBuf = null;
        let levelBufSize = 0;
        const tick = () => {
            if (!levelAnalyser) return;
            const fftSize = levelAnalyser.fftSize;
            if (!levelBuf || levelBufSize !== fftSize) {
                levelBuf = new Float32Array(fftSize);
                levelBufSize = fftSize;
            }
            levelAnalyser.getFloatTimeDomainData(levelBuf);
            let sum = 0;
            for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
            const rms = Math.sqrt(sum / levelBuf.length);
            inputLevel = Math.min(1, rms * 5);
            if (inputLevel > inputPeak) {
                inputPeak = inputLevel;
                peakDecay = 30;
            } else if (peakDecay > 0) {
                peakDecay--;
            } else {
                inputPeak *= 0.95;
            }
            drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRaf) {
            cancelAnimationFrame(levelRaf);
            levelRaf = null;
        }
    }

    function _vuSetPanel(panel) {
        if (panel) {
            _vuPanelEl = panel;
            _vuBarEl = panel.querySelector('.nd-vu-bar');
            _vuPeakEl = panel.querySelector('.nd-vu-peak');
            _vuPanelAbsent = !_vuBarEl;
        } else {
            _vuPanelEl = null;
            _vuBarEl = null;
            _vuPeakEl = null;
            _vuPanelAbsent = true;
        }
    }

    function drawSettingsVU() {
        let bar = _vuBarEl;

        if (!bar || !bar.isConnected) {
            if (_vuPanelAbsent) return;

            const panel = _vuPanelEl && _vuPanelEl.isConnected ? _vuPanelEl : null;
            if (!panel) { _vuSetPanel(null); return; }
            _vuSetPanel(panel);
            bar = _vuBarEl;
            if (!bar) return;
        }
        const peak = _vuPeakEl && _vuPeakEl.isConnected ? _vuPeakEl : null;
        const pct = Math.round(inputLevel * 100);
        bar.style.width = pct + '%';
        bar.className = pct > 85 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-red-500'
            : pct > 60 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-yellow-500'
            : 'nd-vu-bar h-full rounded transition-all duration-75 bg-green-500';
        if (peak) {
            const peakPct = Math.round(inputPeak * 100);
            peak.style.left = Math.min(peakPct, 100) + '%';
        }
    }

    // Analyze one audio frame, then route its result through chart matching.
    async function processFrame(buffer) {

        if (currentArrangement === 'bass' && buffer && buffer.length) {
            const keep = Math.min(_RESCUE_BUF_MAX, _rescueBuf.length + buffer.length);
            const nb = new Float32Array(keep);
            const fromBuf = Math.min(buffer.length, keep);
            nb.set(buffer.subarray(buffer.length - fromBuf), keep - fromBuf);
            const remain = keep - fromBuf;
            if (remain > 0) nb.set(_rescueBuf.subarray(_rescueBuf.length - remain), 0);
            _rescueBuf = nb;
            if (hw && hw.getTime) _rescueBufEndT = hw.getTime();
        }

        if (!usingDesktopBridge && buffer && buffer.length && hw && typeof hw.getTime === 'function') {
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
            const lvl = Math.min(1, Math.max(0, Math.sqrt(sum / buffer.length) * 5));
            const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const songT = hw.getTime() + avO;
            const last = _ndLevelSamples.length ? _ndLevelSamples[_ndLevelSamples.length - 1].songT : -Infinity;
            if (songT < last - 0.05) _ndLevelSamples.length = 0;
            _ndLevelSamples.push({ songT, level: lvl });
            const cutoff = songT - _ND_LEVEL_HISTORY_S;
            while (_ndLevelSamples.length > 0 && _ndLevelSamples[0].songT < cutoff) _ndLevelSamples.shift();
            while (_ndLevelSamples.length > 240) _ndLevelSamples.shift();
        }
        let result;
        let detectorUsed;

        const gen = sessionGen;

        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        const activeMethod = _ndEffectiveDetectionMethod();
        switch (activeMethod) {
            case 'crepe':
                if (_ndShared.model) {
                    result = await _ndCrepeDetect(buffer);
                    detectorUsed = 'crepe';
                    if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
                        result = _ndYinDetect(buffer, sr);
                        detectorUsed = 'yin';
                    }
                    break;
                }
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
                break;
            case 'hps':
                result = _ndHpsDetect(buffer, sr);
                detectorUsed = 'hps';
                break;
            case 'yin':
            default:
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
        }

        if (!enabled || gen !== sessionGen) return;

        if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
            if (result.underBuffered && !underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                underBufferWarned = true;
            }
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            detectedDisplayMidi = -1;

        } else {
            detectedMidi = _ndFreqToMidi(result.freq);
            detectedConfidence = result.confidence;
        }

        _diagDetector = usingNativeFrames
            ? { desktop_bridge: true, ml: false, path: 'desktop-native-' + (detectorUsed || activeMethod) }
            : { desktop_bridge: false, ml: false, path: 'web-' + (detectorUsed || activeMethod) };

        await matchNotes(buffer);

        if (_recArmed && _recSongPlaying) {
            _recSampleRate = audioCtx ? audioCtx.sampleRate : (bridgeSampleRate || _recSampleRate);

            const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
            if (_recTotalSamples >= maxSamples) {
                if (!_recCappedAt) _recCappedAt = _recTotalSamples / (_recSampleRate || 44100);

            } else {

                const copy = buffer.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            }
        }
    }

    function noteKey(note, time) {
        return `${time.toFixed(3)}_${note.s}_${note.f}`;
    }

    const NOTE_MISS_GEM_TTL = 0.6;

    const NOTE_SUS_GRACE_MS = 250;

    const NOTE_LIVE_LEAD = 0.12;
    const NOTE_LIVE_TAIL = 0.12;

    const NOTE_GLOW_LEVEL_THRESHOLD = 0.015;
    const NOTE_GLOW_REF_LEVEL       = 0.25;
    const NOTE_GLOW_MIN_ALPHA       = 0.30;

    function _ndSustainGlowAlpha() {

        if (usingDesktopBridge && bridgeLevelsUnavailable) return 1;
        if (!(inputLevel > NOTE_GLOW_LEVEL_THRESHOLD)) return 0;
        const span = NOTE_GLOW_REF_LEVEL - NOTE_GLOW_LEVEL_THRESHOLD;
        const a = span > 0 ? (inputLevel - NOTE_GLOW_LEVEL_THRESHOLD) / span : 1;
        return Math.max(NOTE_GLOW_MIN_ALPHA, Math.min(1, a));
    }

    // Highway rendering reads this cache; it does not perform pitch detection.
    function noteStateFor(note, chartTime) {
        if (!enabled || !note || !Number.isFinite(chartTime)) return null;
        const key = noteKey(note, chartTime);
        const j = noteResults.get(key);
        if (!j) {

            const songTLive = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
            const susLive = +note.sus || 0;
            if (songTLive >= chartTime - NOTE_LIVE_LEAD
                && songTLive <= chartTime + susLive + NOTE_LIVE_TAIL
                && _sustainStillHeld(key, note)) {
                const a = _ndSustainGlowAlpha();
                if (a > 0) return { state: 'active', alpha: a, live: true };
            }
            return null;
        }

        const songT = ((hw && hw.getTime) ? hw.getTime() : 0)
            + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);

        const dispAnchor = Number.isFinite(j._ndDisplayFrom)
            ? Math.max(chartTime, j._ndDisplayFrom) : chartTime;

        if (j.hit) {

            let points = j._ndPoints, mult = j._ndMult, popKey = key;
            if (points === undefined) {
                const chordKey = `${chartTime.toFixed(3)}_chord`;
                const cj = noteResults.get(chordKey);
                if (cj && cj.hit && cj._ndPoints !== undefined) {
                    points = cj._ndPoints;
                    mult = cj._ndMult;
                    popKey = chordKey;
                }
            }
            const sus = +note.sus || 0;

            if (sus > 0.05 && songT < chartTime + sus + 0.05 && _sustainStillHeld(key, note)) {
                const a = _ndSustainGlowAlpha();
                if (a > 0) return { state: 'active', alpha: a, live: true, points, mult, popKey };
            }

            const age = songT - dispAnchor;
            if (age < 0) return { state: 'hit', alpha: 1, points, mult, popKey };
            const glowDur = Math.max(0.1, hitGlowDuration);
            if (age >= glowDur) return null;
            return { state: 'hit', alpha: 1 - age / glowDur, points, mult, popKey };
        }

        const age = songT - dispAnchor;
        if (age < 0 || age >= NOTE_MISS_GEM_TTL) return null;
        return { state: 'miss', alpha: 1 - age / NOTE_MISS_GEM_TTL };
    }

    function _sustainStillHeld(key, note) {
        const nowMs = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
            const expectedMidi = _ndMidiFromStringFret(
                note.s, note.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (Number.isFinite(expectedMidi)
                && Math.abs(_ndNearestOctaveCents(detectedMidi, expectedMidi)) <= pitchTolerance) {
                _susActiveUntil.set(key, nowMs + NOTE_SUS_GRACE_MS);
                return true;
            }
        }
        const until = _susActiveUntil.get(key);
        return Number.isFinite(until) && until > nowMs;
    }

    function bsearch(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function dispatchInstanceEvent(type, detail) {

        const init = { detail, bubbles: true };
        try { window.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
        try { instanceRoot.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
    }

    function emitSlopsmithJudgment(judgment) {
        if (!window.slopsmith || typeof window.slopsmith.emit !== 'function') return;
        try {
            window.slopsmith.emit(judgment.hit ? 'note:hit' : 'note:miss', judgment);
        } catch (e) {}
    }

    function dispatchJudgment(judgment) {
        dispatchInstanceEvent(judgment.hit ? 'notedetect:hit' : 'notedetect:miss', judgment);
        emitSlopsmithJudgment(judgment);
    }

    function dispatchFx(detail) {
        detail.isDefault = isDefault;
        detail.ts = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        dispatchInstanceEvent('notedetect:fx', detail);
        if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
            try { window.slopsmith.emit('notedetect:fx', detail); } catch (e) {}
        }
    }

    function makeMatchedJudgment(cn, noteTime, t, expectedMidi, detectedMidiForJudgment, confidence, extra = {}) {
        const hasExplicitPitchError = Object.prototype.hasOwnProperty.call(extra, 'pitchError');
        const pitchError = hasExplicitPitchError
            ? extra.pitchError
            : (Number.isFinite(detectedMidiForJudgment) ? (detectedMidiForJudgment - expectedMidi) * 100 : null);
        const expectedFreq = 440 * Math.pow(2, (expectedMidi - 69) / 12);
        const detectedFreq = Number.isFinite(detectedMidiForJudgment)
            ? 440 * Math.pow(2, (detectedMidiForJudgment - 69) / 12)
            : null;
        return _ndMakeJudgment({
            matched: true,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            detectedMidi: detectedMidiForJudgment,
            confidence,
            pitchError,
            expectedFreq,
            detectedFreq,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,

            pitchThresholdCents: Number.isFinite(extra.pitchThresholdCents)
                ? extra.pitchThresholdCents : pitchHitThreshold,

            pitchWindowWidened: Number.isFinite(extra.pitchThresholdCents),
            cleanTimingThresholdMs: cleanTimingThreshold * 1000,
            cleanPitchThresholdCents: cleanPitchThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            monophonicDetected: extra.monophonicDetected,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    function _tryBassRescue(cn, noteTime, expectedMidi) {
        if (currentArrangement !== 'bass' || _rescueBuf.length < _RESCUE_WIN) return null;
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        if (!(sr > 0) || !Number.isFinite(expectedMidi)) return null;
        _rescueCalls++;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);

        const noteHwTime = noteTime - avOffsetSec + latencyOffset;
        const samplesBack = Math.round((_rescueBufEndT - noteHwTime) * sr);
        const center = _rescueBuf.length - samplesBack;

        const SEARCH = Math.round(0.16 * sr);
        const STEP = Math.round(0.08 * sr);
        const maxK = Math.floor(SEARCH / STEP);

        const _RESCUE_SILENT_BAND = 0.008;
        let r = null;
        for (let k = 0; k <= maxK && !r; k++) {
            for (const d of (k === 0 ? [0] : [k * STEP, -k * STEP])) {
                const start = center + d - (_RESCUE_WIN >> 1);
                if (start < 0 || start + _RESCUE_WIN > _rescueBuf.length) continue;
                const win = _rescueBuf.subarray(start, start + _RESCUE_WIN);
                _rescueWindows++;
                const cand = _ndConstraintCheckString(
                    win, sr, cn.s, cn.f, currentArrangement, currentStringCount,
                    tuningOffsets, capo, _ND_VERIFY_PITCH_CENTS_BASS, 0.015
                );
                if (cand && cand.hit) { r = cand; break; }

                if (k === 0 && cand && cand.bandEnergy < _RESCUE_SILENT_BAND) {
                    _rescueSkippedSilent++;
                    return null;
                }
            }
        }
        if (!r) return null;
        _rescueHits++;

        const detMidi = Number.isFinite(r.centsError) ? expectedMidi + r.centsError / 100 : expectedMidi;
        return makeMatchedJudgment(cn, noteTime, noteTime, expectedMidi, detMidi, 1, { pitchError: 0, rescued: true });
    }

    function _missAnalysisAtNote(chartNote, noteTime) {
        const blank = { stringEnergy: null, muteFail: false, presenceComb: 0 };
        if (currentArrangement !== 'bass' || _rescueBuf.length < _RESCUE_WIN) return blank;
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        if (!(sr > 0)) return blank;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const noteHwTime = noteTime - avOffsetSec + latencyOffset;
        const samplesBack = Math.round((_rescueBufEndT - noteHwTime) * sr);
        const center = _rescueBuf.length - samplesBack;
        const start = center - (_RESCUE_WIN >> 1);
        if (start < 0 || start + _RESCUE_WIN > _rescueBuf.length) return blank;
        const win = _rescueBuf.subarray(start, start + _RESCUE_WIN);
        try {
            const { magnitudes, binHz } = _ndFftMagnitude(win, sr);
            const total = _ndTotalEnergy(magnitudes);

            const stringEnergy = new Array(currentStringCount);
            for (let s = 0; s < currentStringCount; s++) {
                const [lo, hi] = _ndStringBandHz(s, currentArrangement, currentStringCount, tuningOffsets, capo);
                stringEnergy[s] = Math.round(_ndBandEnergy(magnitudes, binHz, lo, hi, total) * 1000) / 1000;
            }

            const expectedMidi = _ndMidiFromStringFret(chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo);
            const expHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);
            const [loHz, hiHz] = _ndStringBandHz(chartNote.s, currentArrangement, currentStringCount, tuningOffsets, capo);
            const loBin = Math.max(0, Math.floor(loHz / binHz));
            const hiBin = Math.min(magnitudes.length - 1, Math.ceil(hiHz / binHz));
            let bandPk = 0;
            for (let k = loBin; k <= hiBin; k++) if (magnitudes[k] > bandPk) bandPk = magnitudes[k];

            let muteFail = false;
            if (Number.isFinite(chartNote.f) && chartNote.f > 0) {
                const openMidi = _ndMidiFromStringFret(chartNote.s, 0, currentArrangement, currentStringCount, tuningOffsets, capo);
                const openHz = 440 * Math.pow(2, (openMidi - 69) / 12);
                muteFail = _ndDetectMuteFail(magnitudes, binHz, expHz, openHz, bandPk);
            }

            const presenceComb = _ndHarmonicCombCount(magnitudes, binHz, expHz, bandPk);
            return { stringEnergy, muteFail, presenceComb };
        } catch (_) { return blank; }
    }

    function _wasSilentAtNote(noteTime) {
        return _ndIsSilentWindow(_ndLevelSamples, noteTime + latencyOffset, _ND_LEVEL_WIN_HALF, _ND_SILENCE_THRESHOLD);
    }

    function makeMissJudgment(cn, noteTime, t, expectedMidi, extra = {}) {
        return _ndMakeJudgment({
            matched: false,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            pitchThresholdCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    function _recordPerStringForChord(judgment) {
        const n = judgment.chartNote || judgment.note;
        if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
            const slot = _diagPerString[n.s];
            if (judgment.hit) slot.hits++; else slot.misses++;
        }
    }

    function _recordDiagnostic(judgment) {
        const isChord = !!judgment.chord;
        if (judgment.hit) {
            (isChord ? _diagChords : _diagSingles).hits++;
            if (judgment.clean === false) _diagClean.loose++; else _diagClean.clean++;
        } else {
            (isChord ? _diagChords : _diagSingles).misses++;
            if (isChord) {
                _diagBreakdown.chordPartial++;
            } else if (judgment.detectedMidi == null) {
                _diagBreakdown.pure++;
            } else if (judgment.timingState === 'EARLY') {
                _diagBreakdown.early++;
            } else if (judgment.timingState === 'LATE') {
                _diagBreakdown.late++;
            } else if (judgment.pitchState === 'SHARP') {
                _diagBreakdown.sharp++;
            } else if (judgment.pitchState === 'FLAT') {
                _diagBreakdown.flat++;
            } else {

                _diagBreakdown.pure++;
            }
        }

        if (!isChord) {
            const n = judgment.chartNote || judgment.note;
            if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
                const slot = _diagPerString[n.s];
                if (judgment.hit) slot.hits++; else slot.misses++;
            }
        }
        if (Number.isFinite(judgment.timingError) && _diagTimingErrors.length < _DIAG_ERROR_CAP) {
            _diagTimingErrors.push(judgment.timingError);
            if (judgment.hit && _diagTimingErrorsHits.length < _DIAG_ERROR_CAP) {
                _diagTimingErrorsHits.push(judgment.timingError);
            }
        }
        if (Number.isFinite(judgment.pitchError) && _diagPitchErrors.length < _DIAG_ERROR_CAP) {
            _diagPitchErrors.push(judgment.pitchError);
        }

        const nn = judgment.chartNote || judgment.note || {};
        const eventObj = {
            t:   Number.isFinite(judgment.noteTime) ? +judgment.noteTime.toFixed(3) : null,
            at:  Number.isFinite(judgment.time)     ? +judgment.time.toFixed(3)     : null,
            s:   Number.isInteger(nn.s) ? nn.s : null,
            f:   Number.isInteger(nn.f) ? nn.f : null,
            sus: Number.isFinite(nn.sus) ? +(+nn.sus).toFixed(3) : 0,
            hit:   !!judgment.hit,
            clean: !!judgment.clean,
            lr:  judgment.looseReason || undefined,
            chord: !!judgment.chord,
            ts:  judgment.timingState || null,
            ps:  judgment.pitchState  || null,
            te:  Number.isFinite(judgment.timingError) ? judgment.timingError : null,
            pe:  Number.isFinite(judgment.pitchError)  ? judgment.pitchError  : null,
            ex:  Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
            dx:  Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
            cnf: Number.isFinite(judgment.confidence) ? +judgment.confidence.toFixed(3) : 0,
            hs:  Number.isFinite(judgment.hitStrings)   ? judgment.hitStrings   : undefined,
            tt:  Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : undefined,
            sc:  Number.isFinite(judgment.score) ? +judgment.score.toFixed(3) : undefined,
            tf:  _diagTechFlags(nn),

            mf:  judgment.muteFail ? true : undefined,
            np:  judgment.notePresent ? true : undefined,
            nc:  Number.isFinite(judgment.presenceComb) ? judgment.presenceComb : undefined,
            sil: judgment.silent ? true : undefined,
        };
        if (_diagEvents.length < _DIAG_EVENT_CAP) {
            _diagEvents.push(eventObj);
        }
        if ((tuningMode || _recArmedForTraining) && _liveSessionId) {
            _streamLiveJudgment(eventObj);
        }
    }

    function _diagTechFlags(n) {
        if (!n) return null;
        const flags = [];
        if (n.bn)               flags.push('B');
        if (n.sl != null && n.sl >= 0) flags.push('S');
        if (n.hm || n.hp)       flags.push('H');
        if (n.ho)               flags.push('h');
        if (n.po)               flags.push('p');
        if (n.tp)               flags.push('t');
        if (n.pm)               flags.push('PM');
        if (n.mt)               flags.push('M');
        if (n.tr)               flags.push('TR');
        if (n.ac)               flags.push('A');
        if ((+n.sus || 0) > 0)  flags.push('SUS');
        return flags.length ? flags.join(',') : null;
    }

    function _diagPercentile(arr, p) {
        if (!arr || !arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        return _diagPercentileFromSorted(sorted, p);
    }

    function _diagPercentileFromSorted(sorted, p) {
        if (!sorted || !sorted.length) return null;
        const rank = (p / 100) * (sorted.length - 1);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(rank)));
        return sorted[idx];
    }

    function _diagDistribution(arr) {
        if (!arr || !arr.length) return { count: 0, p10: null, median: null, p90: null };
        const sorted = arr.slice().sort((a, b) => a - b);
        return {
            count: sorted.length,
            p10:    _diagPercentileFromSorted(sorted, 10),
            median: _diagPercentileFromSorted(sorted, 50),
            p90:    _diagPercentileFromSorted(sorted, 90),
        };
    }

    function _diagResetCounters() {
        for (const k of Object.keys(_diagBreakdown)) _diagBreakdown[k] = 0;
        _diagSingles.hits = 0; _diagSingles.misses = 0;
        _diagChords.hits  = 0; _diagChords.misses  = 0;
        _diagClean.clean = 0; _diagClean.loose = 0;
        for (const slot of _diagPerString) { slot.hits = 0; slot.misses = 0; }
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
        _diagPitchErrors.length  = 0;
        _diagEvents.length       = 0;
        _ndDrainStats.dropUnknownId = 0;
        _ndDrainStats.suppressedRedelivery = 0;
        _ndDrainStats.maxBatch = 0;
    }

    function _ndAlreadyCounted(key) {
        return noteResults.has(key) || _scoreLedger.has(key);
    }

    // The ledger prevents duplicate engine verdicts and supports seek recomputation.
    function recordJudgment(key, judgment, { count = true, emit = true } = {}) {

        if (judgment && !Number.isFinite(judgment._ndDisplayFrom)) {
            judgment._ndDisplayFrom = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
        }
        noteResults.set(key, judgment);
        if (count) {
            if (judgment && !judgment.hit) {
                _ndLogVerifierRejectFromJudgmentIfNew(key, judgment);
            }
            _recordDiagnostic(judgment);

            if (judgment.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                const prevMult = multiplier;
                multiplier = _ndMultiplierForStreak(streak);
                if (multiplier > maxMultiplier) maxMultiplier = multiplier;
                const pts = (judgment.chord ? ND_BASE_CHORD : ND_BASE_SINGLE) * multiplier;
                score += pts;

                judgment._ndPoints = pts;
                judgment._ndMult = multiplier;
                if (multiplier !== prevMult) {
                    dispatchFx({ fxType: 'multiplier', mult: multiplier, prevMult, streak });
                }
                if (_ndIsStreakMilestone(streak)) {
                    dispatchFx({ fxType: 'milestone', streak, mult: multiplier });
                }
                updateSectionStat('hit');

                _autoDrillMissStreak = 0;
            } else {
                const lostStreak = streak;
                misses++;
                streak = 0;

                if (lostStreak >= 10) {
                    dispatchFx({ fxType: 'streakBreak', lostStreak, prevMult: multiplier });
                }
                multiplier = 1;
                updateSectionStat('miss');

                _autoDrillMissStreak++;
                if (Number.isFinite(judgment.noteTime)) {
                    if (_autoDrillMissStreak === 1) _autoDrillFirstMissT = judgment.noteTime;
                    _autoDrillLastMissT = judgment.noteTime;
                }
                _maybeAutoDrill();
            }

            if (drillEnabled) {
                if (judgment.hit) {
                    drillIterHits++;
                    drillIterStreak++;
                    if (drillIterStreak > drillIterBestStreak) drillIterBestStreak = drillIterStreak;
                } else {
                    drillIterMisses++;
                    drillIterStreak = 0;
                }
                drillDirty = true;
            }

            const _ledgerT = Number.isFinite(judgment && judgment.noteTime)
                ? judgment.noteTime
                : (judgment && judgment.chartNote && Number.isFinite(judgment.chartNote.t))
                    ? judgment.chartNote.t
                    : NaN;
            if (Number.isFinite(_ledgerT)) {
                _scoreLedger.set(key, { t: _ledgerT, hit: !!judgment.hit, chord: !!judgment.chord });
            }
        }
        if (emit) dispatchJudgment(judgment);
    }

    // Verify targets ignore playhead timing and are intended for frozen exercises.
    async function _runVerifyTarget(frameBuffer) {
        const target = _verifyTarget;
        if (!target || !target.length) return;

        if (_verifyTargetSig !== _ndVerifyActiveSig()) {
            _verifyTarget = null;
            _verifyTargetSig = null;
            _verifyTargetCtx = null;
            return;
        }

        const ctx = _ndVerifyActiveCtx();

        const verifyParams = _ndVerifyParamsFor(ctx.arrangement);
        let result;
        if (usingDesktopBridge) {
            if (!_ndBridgeScoreAvailable()) return;
            const gen = sessionGen;
            try {
                result = await _ndBridgeScoreChord({
                    arrangement: ctx.arrangement,
                    stringCount: ctx.stringCount,
                    offsets: ctx.offsets.slice(0, ctx.stringCount),
                    capo: ctx.capo,
                    pitchCheckCents: verifyParams.pitchCheckCents,
                    minHitRatio: _ND_VERIFY_MIN_HIT_RATIO,
                    bypassMl: true,
                    harmonicVerify: true,
                    harmonicSnr: verifyParams.harmonicSnr,
                    fundamentalRatio: verifyParams.fundamentalRatio,
                    notes: target,
                });
            } catch (e) { return; }
            if (!enabled || gen !== sessionGen) return;

            if (_verifyTarget !== target || _verifyTargetSig !== _ndVerifyActiveSig()) return;
        } else {
            if (!frameBuffer) return;
            const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
            result = _ndScoreChord(
                frameBuffer, sr, target,
                ctx.arrangement, ctx.stringCount, ctx.offsets, ctx.capo,
                verifyParams.pitchCheckCents, _ND_VERIFY_MIN_HIT_RATIO
            );
        }
        if (result && result.isHit) {
            dispatchInstanceEvent('notedetect:verify', {
                isHit: true,
                score: result.score,
                hitStrings: result.hitStrings,
                totalStrings: result.totalStrings,
                notes: target.map(n => ({ s: n.s, f: n.f })),
            });
        }
    }

    // Match the current audio result against notes inside the active timing window.
    async function matchNotes(frameBuffer) {

        if (_syncChartStateFromHw() === null) return;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;

        _calLogDetection();

        const notes = _ndChartNotes();
        const chords = _ndChartChords();

        if (_verifyTarget) {
            const vgen = sessionGen;
            const vtarget = _verifyTarget;
            const vsig = _ndChartSignature({ syncChartState: false });
            await _runVerifyTarget(frameBuffer);

            if (!enabled || vgen !== sessionGen
                || _verifyTarget !== vtarget || _ndChartSignature() !== vsig) return;
        }

        const tolerance = timingTolerance;
        const centsTolerance = pitchTolerance;

        const candidateNotes = [];

        const MAX_SUS_LATE_GRACE = 1.0;
        if (notes && notes.length > 0) {

            const start = bsearch(notes, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;

                const susSec = Number.isFinite(n.sus) && n.sus > 0 ? n.sus : 0;
                const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
                if (n.t < t - tolerance - lateGrace) continue;

                candidateNotes.push({ ...n });
            }
        }
        if (chords && chords.length > 0) {

            const start = bsearch(chords, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                let chordSus = 0;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const lateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                if (c.t < t - tolerance - lateGrace) continue;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;

                    candidateNotes.push({ ...cn, t: c.t });
                }
            }
        }

        if (detectedMidi >= 0) {
            const disp = _ndResolveDisplayFingering(
                detectedMidi, candidateNotes, currentArrangement,
                currentStringCount, tuningOffsets, capo, centsTolerance
            );
            detectedString = disp.string;
            detectedFret = disp.fret;
            detectedDisplayMidi = Number.isFinite(disp.displayMidi) ? disp.displayMidi : detectedMidi;
        }

        const byTime = new Map();
        for (const cn of candidateNotes) {
            const tk = cn.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(cn);
        }

        const _ndSingleNotes = [];
        for (const [, group] of byTime) {
            if (group.length !== 1) continue;
            const cn = group[0];
            if (noteResults.has(noteKey(cn, cn.t))) continue;
            _ndSingleNotes.push(cn);
        }
        const _ndSingleResult = new Map();
        if (_ndSingleNotes.length > 0) {

            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            let batch = null;
            if (usingDesktopBridge) {
                if (_ndBridgeScoreAvailable()) {
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,

                        pitchCheckCents: verifyParams.pitchCheckCents,
                        minHitRatio: chordHitRatio,
                        bypassMl: true,
                        harmonicVerify: true,
                        harmonicSnr: verifyParams.harmonicSnr,
                        fundamentalRatio: verifyParams.fundamentalRatio,
                        notes: _ndSingleNotes.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        batch = await _ndBridgeScoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        batch = null;
                    }

                    if (!enabled || gen !== sessionGen) return;
                }
            } else if (frameBuffer) {

                const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                batch = _ndScoreChord(
                    frameBuffer, sr,
                    _ndSingleNotes, currentArrangement, currentStringCount,

                    tuningOffsets, capo,
                    verifyParams.pitchCheckCents,
                    chordHitRatio
                );
            }

            if (batch && Array.isArray(batch.results)) {
                for (let i = 0; i < _ndSingleNotes.length && i < batch.results.length; i++) {
                    _ndSingleResult.set(_ndSingleNotes[i], batch.results[i]);
                }
            }
        }

        for (const [, group] of byTime) {
            if (group.length === 1) {

                const cn = group[0];
                const key = noteKey(cn, cn.t);
                if (noteResults.has(key)) continue;

                const r = _ndSingleResult.get(cn);

                if (!r || !r.hit) {
                    try {
                        const expectedMidiSnap = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        _ndVerifyFailSnap.set(key, {
                            noteTime: cn.t,
                            string: cn.s,
                            fret: cn.f,
                            expectedMidi: expectedMidiSnap,
                            pitchErrorCents: Number.isFinite(r && r.centsError) ? r.centsError : null,
                        });
                    } catch (_) {  }
                    continue;
                }

                const pitchError = Number.isFinite(r.centsError) ? r.centsError : null;
                const expectedMidi = _ndMidiFromStringFret(
                    cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                const judgment = makeMatchedJudgment(
                    cn, cn.t, t, expectedMidi, detectedMidiForJudgment, detectedConfidence,
                    { pitchError }
                );
                if (judgment.hit) {
                    recordJudgment(key, judgment);
                } else {
                    const teReason = judgment.timingState === 'EARLY' || judgment.timingState === 'LATE'
                        ? 'TIMING_FAIL'
                        : (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT'
                            ? 'PITCH_FAIL'
                            : 'UNKNOWN');
                    _ndLogVerifierRejectOnce(key, {
                        reason: teReason,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        detectedMidi: detectedMidiForJudgment,
                        confidence: detectedConfidence,
                        timingErrorMs: judgment.timingError,
                        pitchErrorCents: judgment.pitchError,
                    });
                }
            } else {

                const chordKey = `${group[0].t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;

                let chordResult;
                if (usingDesktopBridge) {

                    if (!_ndBridgeScoreAvailable()) {
                        continue;
                    }
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        pitchCheckCents: centsTolerance,
                        minHitRatio: chordHitRatio,
                        notes: group.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        chordResult = await _ndBridgeScoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        continue;
                    }
                    if (!chordResult) continue;

                    if (!enabled || gen !== sessionGen) return;
                    if (noteResults.has(chordKey)) continue;
                } else if (!usingDesktopBridge) {

                    if (!frameBuffer) continue;
                    const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                    chordResult = _ndScoreChord(
                        frameBuffer, sr,
                        group, currentArrangement, currentStringCount,
                        tuningOffsets, capo,
                        centsTolerance,
                        chordHitRatio
                    );
                }

                lastChordScore = chordResult.score;
                lastChordHit = chordResult.hitStrings;
                lastChordTotal = chordResult.totalStrings;
                lastChordTime = group[0].t;

                const lead = group[0];
                const expectedMidi = _ndMidiFromStringFret(
                    lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );

                let chordSusForGrace = 0;
                for (const cn of group) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSusForGrace) chordSusForGrace = cn.sus;
                }
                const chordLateGraceMs = chordSusForGrace > 0
                    ? Math.min(chordSusForGrace * 1000, 1000)
                    : 0;

                const firstFiniteCentsError = chordResult.results
                    ?.find(r => Number.isFinite(r?.centsError))?.centsError;
                const chordPitchError = firstFiniteCentsError !== undefined
                    ? firstFiniteCentsError
                    : (detectedMidi >= 0 ? _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100) : null);
                const chordDetectedMidi = detectedMidi >= 0
                    ? detectedMidi
                    : (Number.isFinite(chordPitchError)
                        ? expectedMidi + chordPitchError / 100
                        : null);

                let chordFreshOnsetAge = null;
                if (bridgeOnsetPrimed && bridgeNewOnsets.size > 0) {
                    for (const cn of group) {
                        const m = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount,
                            tuningOffsets, capo
                        );
                        const o = bridgeNewOnsets.get(m);
                        if (o && (chordFreshOnsetAge === null || o.ageMs < chordFreshOnsetAge)) {
                            chordFreshOnsetAge = o.ageMs;
                        }
                    }
                }
                const tChord = (chordFreshOnsetAge != null)
                    ? hw.getTime() + avOffsetSec - (chordFreshOnsetAge / 1000)
                    : t;

                const chordJudgment = makeMatchedJudgment(
                    lead, lead.t, tChord, expectedMidi,
                    chordDetectedMidi,
                    detectedConfidence,
                    {
                        notes: group.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings: chordResult.hitStrings,
                        totalStrings: chordResult.totalStrings,
                        score: chordResult.score,
                        pitchError: chordPitchError,
                        monophonicDetected: detectedMidi >= 0,
                        lateGraceMs: chordLateGraceMs,
                    }
                );

                if (!chordResult.isHit
                    || (bridgeOnsetPrimed && chordFreshOnsetAge == null)) {

                    const prev = _chordLastResult.get(chordKey);
                    const voicingEver = !!((prev && prev.voicingHit) || chordResult.voicingHit);
                    const useNewSnapshot = !prev || chordResult.score > (prev.score || 0);

                    const voicingT = (prev && prev.voicingT)
                        ? prev.voicingT
                        : (chordResult.voicingHit ? t : null);
                    _chordLastResult.set(chordKey, {
                        score:        useNewSnapshot ? chordResult.score        : prev.score,
                        hitStrings:   useNewSnapshot ? chordResult.hitStrings   : prev.hitStrings,
                        totalStrings: useNewSnapshot ? chordResult.totalStrings : prev.totalStrings,
                        voicingHit:   voicingEver,
                        voicingT,
                    });

                    continue;
                }

                recordJudgment(chordKey, chordJudgment, { count: true, emit: true });

                _chordLastResult.delete(chordKey);

                const stringResByKey = new Map();
                if (Array.isArray(chordResult.results)) {
                    for (const r of chordResult.results) {
                        if (r && typeof r.s === 'number' && typeof r.f === 'number') {
                            stringResByKey.set(`${r.s}_${r.f}`, r);
                        }
                    }
                }
                for (let i = 0; i < group.length; i++) {
                    const cn = group[i];
                    const key = noteKey(cn, cn.t);
                    if (noteResults.has(key)) continue;
                    if (!chordJudgment.hit) {

                        const stringExpectedMidi = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );

                        const stringMiss = makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                        noteResults.set(key, stringMiss);
                        _recordPerStringForChord(stringMiss);
                        continue;
                    }
                    const stringRes = stringResByKey.get(`${cn.s}_${cn.f}`);
                    const stringHit = stringRes && stringRes.hit;
                    const stringExpectedMidi = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    const stringJudgment = stringHit
                        ? makeMatchedJudgment(
                            cn, cn.t, t, stringExpectedMidi,
                            Number.isFinite(stringRes?.centsError)
                                ? stringExpectedMidi + stringRes.centsError / 100
                                : null,
                            detectedConfidence,
                            { pitchError: Number.isFinite(stringRes?.centsError) ? stringRes.centsError : null }
                        )
                        : makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                    noteResults.set(key, stringJudgment);
                    _recordPerStringForChord(stringJudgment);
                }
            }
        }
    }

    // Retire browser-path notes that leave the timing window without a verdict.
    function checkMisses() {
        if (!enabled) return;

        if (_ndUsingEngineVerifier) return;

        if (_syncChartStateFromHw() === null) return;

        let rescueWinBudget = _RESCUE_WINDOWS_PER_TICK;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        const tolerance = timingTolerance;

        for (const key of _ndKeysToReopenOnSeek(_ndLastMissScanT, t, tolerance, noteResults.keys())) {
            noteResults.delete(key);
            _susActiveUntil.delete(key);

            _chordLastResult.delete(key);
        }
        _ndLastMissScanT = t;
        const missDeadline = t - tolerance * 2;

        const MAX_SUS_LATE_GRACE = 1.0;
        const notes = _ndChartNotes();
        const chords = _ndChartChords();

        const checkNote = (chartNote, noteTime) => {
            const susSec = Number.isFinite(chartNote.sus) && chartNote.sus > 0 ? chartNote.sus : 0;
            const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;

            if (noteTime > missDeadline - lateGrace) return;
            const key = noteKey(chartNote, noteTime);
            if (!noteResults.has(key)) {
                const expectedMidi = _ndMidiFromStringFret(
                    chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );

                let rescued = null;
                if (rescueWinBudget > 0) {
                    const winBefore = _rescueWindows;
                    rescued = _tryBassRescue(chartNote, noteTime, expectedMidi);
                    rescueWinBudget -= (_rescueWindows - winBefore);
                }
                if (rescued) {
                    _ndVerifyFailSnap.delete(key);
                    recordJudgment(key, rescued);
                } else {
                const snap = _ndVerifyFailSnap.get(key);
                _ndLogVerifierRejectOnce(key, {
                    reason: snap ? 'STRING_VERIFY_FAIL' : 'RETIRE_NO_MATCH',
                    noteTime,
                    string: chartNote.s,
                    fret: chartNote.f,
                    expectedMidi,
                    pitchErrorCents: snap && Number.isFinite(snap.pitchErrorCents)
                        ? snap.pitchErrorCents
                        : null,
                });
                _ndVerifyFailSnap.delete(key);
                const missJudgment = makeMissJudgment(chartNote, noteTime, t, expectedMidi);

                let an = { stringEnergy: null, muteFail: false, presenceComb: 0 };
                if (rescueWinBudget > 0) {
                    an = _missAnalysisAtNote(chartNote, noteTime);
                    rescueWinBudget -= 1;
                }
                if (an.stringEnergy) missJudgment.stringEnergy = an.stringEnergy;
                if (an.muteFail) missJudgment.muteFail = true;
                if (an.presenceComb >= _ND_PRESENCE_MIN_COMB) missJudgment.notePresent = true;
                if (an.presenceComb > 0) missJudgment.presenceComb = an.presenceComb;

                if (_wasSilentAtNote(noteTime) === true) missJudgment.silent = true;
                recordJudgment(key, missJudgment);
                }
            }
        };

        const scanStartT = missDeadline - 1 - MAX_SUS_LATE_GRACE;
        if (notes && notes.length > 0) {
            const start = bsearch(notes, scanStartT);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > missDeadline) break;
                if (n.mt) continue;
                checkNote(n, n.t);
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, scanStartT);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > missDeadline) break;
                const liveNotes = (c.notes || []).filter(cn => !cn.mt);
                if (liveNotes.length === 0) continue;
                if (liveNotes.length === 1) {

                    checkNote(liveNotes[0], c.t);
                    continue;
                }

                let chordSus = 0;
                for (const cn of liveNotes) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const chordLateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;

                const chordLateGraceMs = chordLateGrace * 1000;
                if (c.t > missDeadline - chordLateGrace) continue;

                const chordKey = `${c.t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;
                const expectedMidi = _ndMidiFromStringFret(
                    liveNotes[0].s, liveNotes[0].f,
                    currentArrangement, currentStringCount, tuningOffsets, capo
                );

                const cachedChord = _chordLastResult.get(chordKey);

                const voicingRescue = !!(cachedChord && cachedChord.voicingHit);

                const judgedAtForRescue = (voicingRescue && Number.isFinite(cachedChord.voicingT))
                    ? cachedChord.voicingT
                    : t;
                const chordJudgment = voicingRescue
                    ? makeMatchedJudgment(
                        liveNotes[0], c.t, judgedAtForRescue, expectedMidi,
                        null,
                        0,
                        {
                            chord: true,
                            notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                            hitStrings:   cachedChord.hitStrings,
                            totalStrings: cachedChord.totalStrings,
                            score:        cachedChord.score,

                            pitchError: null,
                            lateGraceMs: chordLateGraceMs,
                        },
                    )
                    : makeMissJudgment(liveNotes[0], c.t, t, expectedMidi, {
                        notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings:   cachedChord ? cachedChord.hitStrings   : undefined,
                        totalStrings: cachedChord ? cachedChord.totalStrings : undefined,
                        score:        cachedChord ? cachedChord.score        : undefined,
                        lateGraceMs: chordLateGraceMs,
                    });
                if (!voicingRescue) {
                    _ndLogVerifierRejectOnce(chordKey, {
                        reason: cachedChord ? 'CHORD_RATIO_FAIL' : 'RETIRE_NO_MATCH',
                        noteTime: c.t,
                        chord: true,
                        expectedMidi,
                        hitStrings: cachedChord ? cachedChord.hitStrings : null,
                        totalStrings: cachedChord ? cachedChord.totalStrings : null,
                        chordScore: cachedChord ? cachedChord.score : null,
                    });
                }
                recordJudgment(chordKey, chordJudgment);

                _chordLastResult.delete(chordKey);
                for (const cn of liveNotes) {
                    const key = noteKey({ s: cn.s, f: cn.f }, c.t);
                    if (noteResults.has(key)) continue;
                    const stringMiss = makeMissJudgment(cn, c.t, t, _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    ));
                    noteResults.set(key, stringMiss);

                    if (!voicingRescue) _recordPerStringForChord(stringMiss);
                }
            }
        }

        const sections = hw.getSections ? hw.getSections() : null;
        if (sections) {
            let current = null;
            for (const sec of sections) {
                if (sec.time <= t) current = sec.name;
                else break;
            }
            if (current && current !== currentSection) {
                currentSection = current;
                if (!sectionStats.find(s => s.name === current)) {
                    sectionStats.push({ name: current, hits: 0, misses: 0 });
                }
            }
        }
    }

    function updateSectionStat(type) {
        if (!currentSection) return;
        let sec = sectionStats.find(s => s.name === currentSection);
        if (!sec) {
            sec = { name: currentSection, hits: 0, misses: 0 };
            sectionStats.push(sec);
        }
        if (type === 'hit') sec.hits++;
        else sec.misses++;
    }

    function _ndVerifierPathLabel() {
        if (_ndUsingEngineVerifier) return 'desktop-engine-verifier';
        if (_diagDetector && _diagDetector.path) return String(_diagDetector.path);
        if (usingDesktopBridge) return 'desktop-yin';
        return 'web-' + (detectionMethod || 'yin');
    }

    function _ndStrikeLevelContext(noteTimeAudio) {
        const levelAtLogPct = Math.round((inputLevel || 0) * 100);
        if (!Number.isFinite(noteTimeAudio)) {
            return {
                levelAtLogPct,
                strikePeakPct: Math.round((inputPeak || 0) * 100),
                strikeSamplesInWindow: null,
                silenceWouldTrigger: false,
            };
        }
        const cnCenterVisualT = noteTimeAudio + latencyOffset;
        let peakL = 0;
        let inWindow = 0;
        for (let i = _ndLevelSamples.length - 1; i >= 0; i--) {
            const s = _ndLevelSamples[i];
            if (!s || !Number.isFinite(s.songT)) continue;
            if (s.songT > cnCenterVisualT + _ND_LEVEL_WIN_HALF) continue;
            if (s.songT < cnCenterVisualT - _ND_LEVEL_WIN_HALF) break;
            inWindow++;
            if (s.level > peakL) peakL = s.level;
        }
        return {
            levelAtLogPct,
            strikePeakPct: inWindow > 0 ? Math.round(peakL * 100) : null,
            strikeSamplesInWindow: inWindow,
            silenceWouldTrigger: inWindow > 0 && peakL < _ND_SILENCE_THRESHOLD,
        };
    }

    function _ndSnapshotEngineVerdict(v) {
        if (!v || typeof v !== 'object') return null;
        try {
            const snap = {};
            for (const k of Object.keys(v)) {
                const val = v[k];
                if (val === undefined || typeof val === 'function') continue;
                if (typeof val === 'number' && Number.isFinite(val)) snap[k] = val;
                else if (typeof val === 'boolean') snap[k] = val;
                else if (typeof val === 'string') snap[k] = val;
            }
            return Object.keys(snap).length ? snap : null;
        } catch (_) {
            return null;
        }
    }

    function _ndOpenDomainPitchFields() {
        let detected = null;
        let conf = null;
        try {
            if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
                detected = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                conf = detectedConfidence;
            }
        } catch (_) {  }
        return { detectedMidi: detected, confidence: conf };
    }

    function _ndPushVerifierReject(entry) {
        try {
            const row = entry && typeof entry === 'object' ? entry : {};
            _ndVerifierRejects.push(row);
            while (_ndVerifierRejects.length > _ND_VERIFIER_REJECT_MAX) {
                _ndVerifierRejects.shift();
            }
        } catch (_) {  }
    }

    function _ndLogVerifierRejectOnce(dedupKey, partial) {
        try {
            if (!partial || typeof partial !== 'object') return;
            if (dedupKey && _ndRejectDedup.has(dedupKey)) return;
            const strikeCtx = Number.isFinite(partial.noteTime)
                ? _ndStrikeLevelContext(partial.noteTime)
                : _ndStrikeLevelContext(null);
            const levels = {
                levelPct: strikeCtx.levelAtLogPct,
                peakPct: strikeCtx.strikePeakPct,
            };
            const skipOpenPitch = !!partial.skipOpenDomainPitchFallback
                || partial.reason === 'NO_VERDICT'
                || partial.reason === 'SILENCE_GATE';
            const open = skipOpenPitch ? { detectedMidi: null, confidence: null } : _ndOpenDomainPitchFields();
            const row = {
                at: Date.now(),
                path: partial.path || _ndVerifierPathLabel(),
                reason: partial.reason || 'UNKNOWN',
                noteTime: Number.isFinite(partial.noteTime) ? partial.noteTime : null,
                string: Number.isInteger(partial.string) ? partial.string : null,
                fret: Number.isInteger(partial.fret) ? partial.fret : null,
                chord: !!partial.chord,
                expectedMidi: Number.isFinite(partial.expectedMidi) ? partial.expectedMidi : null,
                detectedMidi: Number.isFinite(partial.detectedMidi)
                    ? partial.detectedMidi
                    : open.detectedMidi,
                confidence: Number.isFinite(partial.confidence)
                    ? partial.confidence
                    : open.confidence,
                hitStrings: Number.isFinite(partial.hitStrings) ? partial.hitStrings : null,
                totalStrings: Number.isFinite(partial.totalStrings) ? partial.totalStrings : null,
                chordScore: Number.isFinite(partial.chordScore) ? partial.chordScore : null,
                timingErrorMs: Number.isFinite(partial.timingErrorMs) ? partial.timingErrorMs : null,
                pitchErrorCents: Number.isFinite(partial.pitchErrorCents) ? partial.pitchErrorCents : null,
                inputLevelPct: Number.isFinite(partial.inputLevelPct)
                    ? partial.inputLevelPct
                    : levels.levelPct,
                inputPeakPct: Number.isFinite(partial.inputPeakPct)
                    ? partial.inputPeakPct
                    : levels.peakPct,

                verifierId: typeof partial.verifierId === 'string' ? partial.verifierId : null,
                playheadAudio: Number.isFinite(partial.playheadAudio) ? partial.playheadAudio : null,
                engineDetected: typeof partial.engineDetected === 'boolean' ? partial.engineDetected : null,
                engineDetectedRaw: typeof partial.engineDetectedRaw === 'boolean'
                    ? partial.engineDetectedRaw
                    : null,
                detectedSongTime: Number.isFinite(partial.detectedSongTime)
                    ? partial.detectedSongTime
                    : null,
                silenceGateApplied: !!partial.silenceGateApplied,
                strikePeakPct: Number.isFinite(partial.strikePeakPct)
                    ? partial.strikePeakPct
                    : levels.peakPct,
                strikeSamplesInWindow: Number.isFinite(partial.strikeSamplesInWindow)
                    ? partial.strikeSamplesInWindow
                    : strikeCtx.strikeSamplesInWindow,
                inputLevelAtLogPct: Number.isFinite(partial.inputLevelAtLogPct)
                    ? partial.inputLevelAtLogPct
                    : levels.levelPct,
                rendererPitchPolled: partial.rendererPitchPolled !== undefined
                    ? !!partial.rendererPitchPolled
                    : !_ndUsingEngineVerifier,
                engineVerdict: partial.engineVerdict && typeof partial.engineVerdict === 'object'
                    ? { ...partial.engineVerdict }
                    : null,
            };
            _ndPushVerifierReject(row);
            if (dedupKey) _ndRejectDedup.add(dedupKey);
        } catch (_) {  }
    }

    function _ndRejectReasonFromJudgment(judgment) {
        if (!judgment) return 'UNKNOWN';
        if (judgment.chord) return 'CHORD_RATIO_FAIL';
        if (judgment.timingState === 'EARLY' || judgment.timingState === 'LATE') return 'TIMING_FAIL';
        if (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT') return 'PITCH_FAIL';
        if (judgment.detectedMidi == null) return 'RETIRE_NO_MATCH';
        return 'UNKNOWN';
    }

    function _ndLogVerifierRejectFromJudgmentIfNew(key, judgment) {
        try {
            if (!key || _ndRejectDedup.has(key)) return;
            const cn = judgment.chartNote || judgment.note || {};
            _ndLogVerifierRejectOnce(key, {
                reason: _ndRejectReasonFromJudgment(judgment),
                noteTime: Number.isFinite(judgment.noteTime) ? judgment.noteTime : null,
                string: Number.isInteger(cn.s) ? cn.s : null,
                fret: Number.isInteger(cn.f) ? cn.f : null,
                chord: !!judgment.chord,
                expectedMidi: Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
                detectedMidi: Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
                confidence: Number.isFinite(judgment.confidence) ? judgment.confidence : null,
                hitStrings: Number.isFinite(judgment.hitStrings) ? judgment.hitStrings : null,
                totalStrings: Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : null,
                chordScore: Number.isFinite(judgment.score) ? judgment.score : null,
                timingErrorMs: Number.isFinite(judgment.timingError) ? judgment.timingError : null,
                pitchErrorCents: Number.isFinite(judgment.pitchError) ? judgment.pitchError : null,
            });
        } catch (_) {  }
    }

    function getVerifierRejects() {
        try {
            return _ndVerifierRejects.map((e) => ({ ...e }));
        } catch (_) {
            return [];
        }
    }

    function _ndFormatMs(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        const r = Math.round(n);
        return (r >= 0 ? '+' + r : String(r)) + ' ms';
    }

    function _ndFormatPercent(ratio) {
        if (ratio == null || !Number.isFinite(ratio)) return '—';
        return Math.round(ratio * 100) + '%';
    }

    function _ndMusicianRejectHint(reason) {
        const hints = {
            NO_VERDICT: 'No detection at note time',
            SILENCE_GATE: 'Input too quiet when the note struck',
            STRING_VERIFY_FAIL: 'Something was heard but did not verify',
            CHORD_RATIO_FAIL: 'Not enough strings heard for the chord',
            TIMING_FAIL: 'Played outside the timing window',
            PITCH_FAIL: 'Pitch was outside the allowed window',
            RETIRE_NO_MATCH: 'No match before the note ended',
            UNKNOWN: 'Could not verify this note',
        };
        return hints[reason] || hints.UNKNOWN;
    }

    function _ndFormatMusicianRejectLine(r) {
        if (!r || typeof r !== 'object') return '—';
        const parts = [_ndMusicianRejectHint(r.reason)];
        if (Number.isFinite(r.hitStrings) && Number.isFinite(r.totalStrings)) {
            parts.push(`${r.hitStrings} of ${r.totalStrings} strings heard`);
        } else if (Number.isInteger(r.string) && Number.isInteger(r.fret)) {
            parts.push(`string ${r.string + 1}, fret ${r.fret}`);
        }
        const strikePeak = Number.isFinite(r.strikePeakPct)
            ? r.strikePeakPct
            : (Number.isFinite(r.inputPeakPct) ? r.inputPeakPct : null);
        if (Number.isFinite(strikePeak)) {
            parts.push(`signal at strike ${strikePeak}%`);
        }
        if (Number.isFinite(r.timingErrorMs)) {
            const te = Math.round(r.timingErrorMs);
            parts.push(te >= 0 ? `${te} ms late` : `${Math.abs(te)} ms early`);
        }
        return parts.join(' · ');
    }

    function _ndHealthHearingForPanel() {
        const line = _ndHealthDetectedLine();
        if (line !== '—') return line;
        if (!enabled) {
            return 'Nothing yet — turn Detect on, then play a note or chord';
        }
        return 'Nothing yet — play a note or chord (stays blank when input is quiet)';
    }

    function _calWizardNoiseStatusDisplay(status) {
        if (status === 'good') return 'Good — quiet room (under 5%)';
        if (status === 'elevated') return 'Elevated — some background noise (5–15%)';
        if (status === 'too_noisy') return 'Too noisy — over 15%; lower gain or quiet the room';
        return status || '—';
    }

    function _calWizardSignalStatusDisplay(status) {
        if (status === 'good') return 'Good — strong enough for detection';
        if (status === 'too_low') return 'Too low — play louder or raise input gain';
        if (status === 'too_hot') return 'Too hot — risk of clipping; lower input gain';
        return status || '—';
    }

    function _calLabDominantFailLabel(fail) {
        if (fail === 'SNR') return 'signal clarity';
        if (fail === 'FUND') return 'main note';
        if (fail === 'PITCH') return 'tuning match';
        return fail || '—';
    }

    function _calLabGateChipsHtml(tick) {
        if (!tick || typeof tick !== 'object') return '';
        const chip = (label, ok) => {
            const cls = ok ? 'text-green-300/90' : 'text-amber-200/90';
            const mark = ok ? '✓' : '✗';
            return `<span class="${cls}">${label}${mark}</span>`;
        };
        const snrOk = !!tick.passedSnr || (tick.gatePassCount >= 1 && !(tick.failedGateMask & 1));
        const fundOk = !!tick.passedFundamental || (tick.gatePassCount >= 2 && !(tick.failedGateMask & 2));
        const pitchOk = !!tick.passedPitch || tick.gatePassCount === 3;
        if (tick.passedSnr === undefined && tick.gatePassCount != null) {
            return `<span class="text-[9px] font-mono flex gap-1.5">`
                + chip('Clarity', (tick.failedGateMask & 1) === 0 && tick.gatePassCount >= 1)
                + chip('Main note', (tick.failedGateMask & 2) === 0 && tick.gatePassCount >= 2)
                + chip('Tuning', tick.gatePassCount === 3)
                + '</span>';
        }
        return `<span class="text-[9px] font-mono flex gap-1.5">`
            + chip('Clarity', snrOk) + chip('Main note', fundOk) + chip('Tuning', pitchOk)
            + '</span>';
    }

    function _ndDominantMissReason(breakdown, totalMisses) {
        if (!breakdown || !totalMisses || totalMisses <= 0) return null;
        const labels = {
            pure: 'no note heard',
            chordPartial: 'partial chord',
            early: 'played too early',
            late: 'played too late',
            sharp: 'pitch too sharp',
            flat: 'pitch too flat',
        };
        let bestKey = null;
        let bestVal = 0;
        for (const k of Object.keys(labels)) {
            const v = breakdown[k] || 0;
            if (v > bestVal) { bestVal = v; bestKey = k; }
        }
        if (!bestKey || bestVal === 0) return null;
        return { key: bestKey, label: labels[bestKey], count: bestVal };
    }

    function _ndDetectionHealthHint(d, totalJudgments) {
        if (inputLevel > 0.85) {
            return 'Signal is hot — reduce input gain.';
        }
        if (!totalJudgments || totalJudgments < 5) {
            return 'Not enough hits yet — play a few notes to collect data.';
        }
        const misses = (d && d.summary) ? (d.summary.misses || 0) : 0;
        const bk = (d && d.miss_breakdown) ? d.miss_breakdown : {};
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const median = teHits.median;
        const dom = _ndDominantMissReason(bk, misses);
        if (dom) {
            if (dom.key === 'late' || (Number.isFinite(median) && median > 25)) {
                return 'Mostly late hits — timing offset may need calibration.';
            }
            if (dom.key === 'early' || (Number.isFinite(median) && median < -25)) {
                return 'Mostly early hits — timing offset may need calibration.';
            }
            if (dom.key === 'pure') {
                return 'Many pure misses — check input channel, gain, or detector confidence.';
            }
            if (dom.key === 'chordPartial') {
                return 'Many chord partials — chord detection may be hearing only part of the chord.';
            }
            if (dom.key === 'sharp' || dom.key === 'flat') {
                return 'Many pitch misses — check tuning, capo, or pitch tolerance.';
            }
        }
        if (Number.isFinite(median) && Math.abs(median) >= 20) {
            return 'Timing median is off — try the Calibration Wizard timing step or adjust chart sync (A/V offset) in main Settings.';
        }
        return null;
    }

    function _ndHealthDetectedLine() {
        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
            const name = Number.isFinite(displayMidi) ? _ndMidiToName(displayMidi) : '—';
            const confPct = Math.round(detectedConfidence * 100);
            return `${name} · string ${detectedString} fret ${detectedFret} · ${confPct}% conf`;
        }
        const currentHw = resolveHw();
        if (lastChordScore !== null && currentHw && typeof currentHw.getTime === 'function') {
            const songTime = currentHw.getTime() - latencyOffset
                + (currentHw.getAvOffset ? currentHw.getAvOffset() / 1000 : 0);
            if (songTime - lastChordTime <= 1.5) {
                const pct = Math.round(lastChordScore * 100);
                return `Chord ${lastChordHit}/${lastChordTotal} strings (${pct}%)`;
            }
        }
        return '—';
    }

    function _ndHealthInputChannelLabel() {
        if (selectedChannel === 'left') return 'Left (Ch 1)';
        if (selectedChannel === 'right') return 'Right (Ch 2)';
        return 'Mono';
    }

    function _ndHealthDetectorPathLabel() {
        if (usingDesktopBridge) return 'Desktop audio engine';
        if (_diagDetector && _diagDetector.path) return String(_diagDetector.path);
        return 'Browser microphone';
    }

    // Detection Health reports state without changing detector settings.
    function renderDetectionHealth(panel) {
        if (!panel) return;
        const set = (sel, text) => {
            const el = panel.querySelector(sel);
            if (el) el.textContent = text;
        };
        let d;
        try {
            d = _buildDiagnosticPayload();
        } catch (e) {
            d = null;
        }
        const summary = (d && d.summary) ? d.summary : {};
        const total = summary.total || 0;
        const hitsN = summary.hits || 0;
        const missesN = summary.misses || 0;
        const methodLabel = detectionMethod === 'crepe' && _ndShared.modelLoading
            ? `${detectionMethod} (loading…)`
            : (detectionMethod || '—');
        const sr = audioCtx && audioCtx.sampleRate
            ? Math.round(audioCtx.sampleRate)
            : (bridgeSampleRate ? Math.round(bridgeSampleRate) : null);
        const avMs = (resolveHw() && resolveHw().getAvOffset)
            ? resolveHw().getAvOffset()
            : null;
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const dom = _ndDominantMissReason((d && d.miss_breakdown) ? d.miss_breakdown : {}, missesN);
        const levelPct = Math.round((inputLevel || 0) * 100);
        let levelNote = `${levelPct}%`;
        if (inputLevel > 0.85) levelNote += ' (hot)';
        else if (inputLevel < 0.02) levelNote += ' (quiet)';

        set('.nd-health-status',
            enabled
                ? `● Running · ${methodLabel} · ${_ndHealthDetectorPathLabel()}`
                : '○ Detect is off');
        set('.nd-health-input',
            `Input: ${_ndHealthInputChannelLabel()}`
            + (sr ? ` · ${sr} Hz` : '')
            + (selectedDeviceId ? '' : ' · default device'));
        set('.nd-health-hearing', `Now hearing: ${_ndHealthHearingForPanel()}`);
        set('.nd-health-session',
            total > 0
                ? `This song: ${hitsN} hits · ${missesN} misses · ${_ndFormatPercent(summary.accuracy)}`
                : 'This song: Not enough data yet');
        set('.nd-health-top-miss',
            dom
                ? `Most common miss: ${dom.label} (${dom.count})`
                : (missesN > 0 ? 'Most common miss: —' : 'Most common miss: none yet'));
        const timingMed = teHits.median;
        set('.nd-health-align',
            `Sync: chart/video offset ${_ndFormatMs(avMs)} · detection delay ${Math.round(latencyOffset * 1000)} ms`
            + (Number.isFinite(timingMed)
                ? ` · your hits average ${_ndFormatMs(timingMed)} vs chart`
                : ' · your hits: not enough data yet'));
        set('.nd-health-level', `Input level: ${levelNote}`);
        let rejectLines = '—';
        try {
            const recent = _ndVerifierRejects.slice(-3).reverse();
            if (recent.length > 0) {
                rejectLines = recent.map(_ndFormatMusicianRejectLine).join('\n');
            }
        } catch (_) {  }
        set('.nd-health-rejects', rejectLines);
        const hint = _ndDetectionHealthHint(d, total);
        set('.nd-health-hint', hint ? `Tip: ${hint}` : 'Tip: —');
    }

    function calibrationFormatLevel(levelPct, peakPct) {
        const l = Number.isFinite(levelPct) ? Math.round(levelPct) : 0;
        const p = Number.isFinite(peakPct) ? Math.round(peakPct) : l;
        let s = `${l}%`;
        if (p > l) s += ` (peak ${p}%)`;
        if (l > 85) s += ' — hot';
        else if (l < 2) s += ' — quiet';
        return s;
    }

    const _CAL_WIZARD_CHANNEL_PROBE_MS = 3000;
    const _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS = 100;
    const _CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS = 250;
    const _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK = 0.05;
    const _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO = 0.10;
    const _CAL_WIZARD_INPUT_CHANNEL_OPTIONS = [
        { ch: -1, label: 'Default / Mono Mix' },
        { ch: 0, label: 'Input 1 / Ch 1' },
        { ch: 1, label: 'Input 2 / Ch 2' },
    ];
    const _CAL_WIZARD_TIMED_PLAYALONG_SEC = 30;
    const _CAL_WIZARD_PLAY_ALONG_WAIT_MS = 60000;
    const _CAL_WIZARD_PLAY_ALONG_WAIT_POLL_MS = 250;
    const _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_SEC = 0.02;
    const _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_GAP_MS = 150;
    const _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS = [0, 150, 500, 1200, 2500, 4000];
    let _calWizardPauseRetryTimers = [];

    function _calWizardDefaultAllStringsState() {
        return {
            running: false,
            index: 0,
            ids: [],
            complete: false,
            failedId: null,
            detailsOpen: false,
            message: null,
        };
    }

    function _calWizardClearPauseRetries() {
        _calWizardPauseRetryTimers.forEach((id) => clearTimeout(id));
        _calWizardPauseRetryTimers = [];
    }

    // The calibration wizard recommends safe input and latency adjustments.
    function _calWizardNewState() {
        return {
            step: 0,
            startedAt: Date.now(),
            tunerMinimized: false,
            noise: null,
            signal: null,
            notes: {},
            allStrings: _calWizardDefaultAllStringsState(),

            selectedInstrumentConfig: null,
            timing: null,
            recommended: { inputGain: null, latencyOffset: null, reasons: {} },
            applyChecked: { inputGain: true, latencyOffset: true },
            applied: null,
            complete: null,
            playAlong: null,
            timingCaptureNote: null,
            autoCapture: null,
            channelProbeRunning: false,
            channelProbeResult: null,
            channelProbeError: null,
            channelProbeAbort: null,
        };
    }

    function _calWizardStopAutoCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        if (wiz.autoCapture) {
            const ac = wiz.autoCapture;
            if (ac.timerId) clearTimeout(ac.timerId);
            if (ac.intervalId) clearInterval(ac.intervalId);
            wiz.autoCapture = null;
        }
        if (wiz.channelProbeAbort) {
            wiz.channelProbeAbort = null;
            wiz.channelProbeRunning = false;
        }
    }

    function _calWizardNoiseStatus(avgPct) {
        if (!Number.isFinite(avgPct)) return 'unknown';
        if (avgPct < 5) return 'good';
        if (avgPct < 15) return 'elevated';
        return 'too_noisy';
    }

    function _calWizardSignalStatus(avgPct, peakPct, noiseAvg) {
        if (!Number.isFinite(avgPct)) return 'unknown';
        const floor = Number.isFinite(noiseAvg) ? noiseAvg + 6 : 8;
        if (avgPct < floor) return 'too_low';
        if ((peakPct || avgPct) > 85) return 'too_hot';
        return 'good';
    }

    function _calWizardRecommendInputGain(signalStatus, currentGain, signalAvg, signalPeakPct, measuredAtGain) {

        if (!(Number.isFinite(measuredAtGain) && measuredAtGain > 0)) return null;
        const measGain = measuredAtGain;
        const rawPeak = (Number.isFinite(signalPeakPct) ? signalPeakPct / 100 : 0) / measGain;
        if (rawPeak < 0.02) return null;
        const target = Math.max(0.1, Math.min(5, CAL_TARGET_PEAK / rawPeak));
        const pct = Math.round(rawPeak * 100);
        return {
            value: +target.toFixed(2),
            reason: `Hardest playing peaked at ~${pct}% of full scale — set input to ${target.toFixed(2)}× so it lands near −12 dBFS (keeps the amps clean and matches other instruments).`,
        };
    }

    function _calWizardRecommendLatency(medianMs, currentLatencyS) {
        if (!Number.isFinite(medianMs) || Math.abs(medianMs) < 8) return null;
        const cur = Number.isFinite(currentLatencyS) ? currentLatencyS : 0.08;
        const delta = (medianMs / 1000) * 0.5;
        const target = Math.max(0, Math.min(0.25, cur + delta));
        if (Math.abs(target - cur) < 0.005) return null;
        const dir = medianMs > 0 ? 'late' : 'early';
        return {
            value: +target.toFixed(3),
            reason: `Hit timing median is ${_ndFormatMs(medianMs)} (${dir}) — adjusting audio latency offset may align notes with the chart.`,
        };
    }

    function _calWizardBuildSafeRecommendations(wiz, snap) {
        const rec = { inputGain: null, latencyOffset: null, reasons: {} };
        if (wiz && wiz.signal) {
            const g = _calWizardRecommendInputGain(
                wiz.signal.status, inputGain, wiz.signal.avgPct, wiz.signal.peakPct, wiz._measuredAtGain);
            if (g) {
                rec.inputGain = g.value;
                rec.reasons.inputGain = g.reason;
            }
        }
        const med = wiz && wiz.timing && Number.isFinite(wiz.timing.medianMs)
            ? wiz.timing.medianMs
            : (snap && snap.timingMedianMs);
        const lat = _calWizardRecommendLatency(med, latencyOffset);
        if (lat) {
            rec.latencyOffset = lat.value;
            rec.reasons.latencyOffset = lat.reason;
        }
        wiz.recommended = rec;
        return rec;
    }

    function _calWizardSetAutoStatus(html) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-auto-status');
        if (el) el.innerHTML = html;
    }

    function _calWizardSetChannelProbeStatus(html) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-channel-probe-status');
        if (el) el.innerHTML = html;
    }

    function _calWizardSetTunerOpenStatus(message, tone) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-tuner-open-status');
        if (!el) return;
        if (!message) {
            el.innerHTML = '';
            return;
        }
        const cls = tone === 'warn' ? 'text-amber-200/90' : 'text-gray-400';
        el.innerHTML = `<span class="${cls}">${message}</span>`;
    }

    function _calWizardIsTunerUiVisible() {
        const el = document.getElementById('tuner-plugin-ui');
        if (!el || el.classList.contains('hidden')) return false;
        const cs = window.getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    async function _calWizardWaitForTunerUiVisible(maxMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            if (_calWizardIsTunerUiVisible()) return true;
            await _calWizardSleep(100);
        }
        return _calWizardIsTunerUiVisible();
    }

    async function _calWizardOpenTunerFromWizard() {
        if (!window.tuner || typeof window.tuner.enable !== 'function') {
            _calWizardSetTunerOpenStatus(
                'Tuner plugin is not loaded. Enable the Tuner plugin, then try again.', 'warn');
            return;
        }
        _calWizardSetTunerOpenStatus('Opening tuner…', 'neutral');
        try {
            await window.tuner.enable();
        } catch (e) {
            console.warn('[note_detect] tuner enable:', e);
            _calWizardSetTunerOpenStatus(
                'Tuner did not open. Check microphone permission or open the Tuner from the bottom toolbar.', 'warn');
            return;
        }
        const visible = await _calWizardWaitForTunerUiVisible(4000);
        if (visible) {
            _calWizardSetTunerOpenStatus('', 'neutral');
            _calWizardSetTunerMinimized(true);
            return;
        }
        _calWizardSetTunerOpenStatus(
            'Tuner did not open. Check microphone permission or open the Tuner from the bottom toolbar.', 'warn');
    }

    function _calWizardFinishLevelSample(wiz, kind, samples) {
        if (!samples.length) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
            return;
        }
        let sum = 0;
        let maxPeak = 0;
        for (const s of samples) {
            sum += s.level;
            if (s.peak > maxPeak) maxPeak = s.peak;
        }
        const avg = Math.round(sum / samples.length);
        const peak = maxPeak;
        if (kind === 'noise') {
            wiz.noise = {
                avgPct: avg,
                peakPct: peak,
                status: _calWizardNoiseStatus(avg),
                captured: true,
                at: Date.now(),
            };
            const label = _calWizardNoiseStatusDisplay(wiz.noise.status);
            _calWizardSetAutoStatus(
                `<span class="text-green-300/90">Captured:</span> avg ${avg}% · peak ${peak}% · <span class="font-semibold">${label}</span>`);
        } else if (kind === 'signal') {
            const noiseAvg = wiz.noise && wiz.noise.avgPct;
            wiz.signal = {
                avgPct: avg,
                peakPct: peak,
                status: _calWizardSignalStatus(avg, peak, noiseAvg),
                captured: true,
                at: Date.now(),
            };
            const label = _calWizardSignalStatusDisplay(wiz.signal.status);
            let extra = '';
            const gRec = _calWizardRecommendInputGain(wiz.signal.status, inputGain, avg, peak, wiz._measuredAtGain);
            if (gRec) extra = `<div class="text-gray-400 mt-1">Suggested input gain: ${gRec.value}x</div>`;

            if (gRec && wiz._onEnginePath) _ndSetEngineGain(gRec.value);
            _calWizardSetAutoStatus(
                `<span class="text-green-300/90">Captured:</span> avg ${avg}% · peak ${peak}% · <span class="font-semibold">${label}</span>${extra}`);
            _calWizardBuildSafeRecommendations(wiz, getCalibrationSnapshot());
        }
        renderCalibrationWizard();
    }

    function _calWizardRunLevelSampler(wiz, kind, durationMs, onDone) {
        _calWizardStopAutoCapture();
        const samples = [];
        const started = Date.now();
        wiz.autoCapture = { kind, phase: 'listening', samples, started };
        const tick = () => {
            const snap = getCalibrationSnapshot();
            samples.push({ level: snap.inputLevelPct, peak: snap.inputPeakPct, t: Date.now() });
            const elapsed = Date.now() - started;
            _calWizardSetAutoStatus(
                `<span class="text-cyan-300/90">Listening…</span> ${Math.round(elapsed / 1000)}s / ${Math.round(durationMs / 1000)}s · `
                + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct));
            if (elapsed >= durationMs) {
                _calWizardStopAutoCapture();
                onDone(samples);
            }
        };
        tick();
        wiz.autoCapture.intervalId = setInterval(tick, 120);
        wiz.autoCapture.timerId = setTimeout(() => {
            _calWizardStopAutoCapture();
            onDone(samples);
        }, durationMs + 200);
    }

    function _calWizardBeginCountdownThen(kind, countdownSec, afterCountdown) {
        const wiz = _calWizardState;
        if (!wiz) return;
        _calWizardStopAutoCapture();
        let left = countdownSec;
        wiz.autoCapture = { kind, phase: 'countdown', left };
        const tick = () => {
            if (!_calWizardState || _calWizardState !== wiz) return;

            if (wiz.autoCapture) wiz.autoCapture.left = left;
            _calWizardSetAutoStatus(`<span class="text-cyan-300/90">Get ready…</span> <span class="text-2xl font-bold text-white">${left}</span>`);
            if (left <= 0) {
                _calWizardStopAutoCapture();
                afterCountdown();
                return;
            }
            left--;
            wiz.autoCapture.timerId = setTimeout(tick, 1000);
        };
        tick();
    }

    function _calWizardStartNoiseCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calWizardBeginCountdownThen('noise', 3, () => {
            _calWizardSetAutoStatus('<span class="text-cyan-300/90">Listening…</span> Mute all strings.');
            _calWizardRunLevelSampler(wiz, 'noise', 1600, (samples) => {
                _calWizardFinishLevelSample(wiz, 'noise', samples);
            });
        });
    }

    function _calWizardStartSignalCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        const noiseFloor = (wiz.noise && wiz.noise.avgPct) || 3;
        const trigger = noiseFloor + 8;

        wiz._onEnginePath = !!_ndResolveAudioBridge();
        wiz._measuredAtGain = wiz._onEnginePath
            ? (_ndSetEngineGain(1.0) ? 1.0 : null)
            : inputGain;
        _calWizardBeginCountdownThen('signal', 3, () => {
            _calWizardStopAutoCapture();
            const samples = [];
            const started = Date.now();
            const maxWait = 12000;
            wiz.autoCapture = { kind: 'signal', phase: 'wait_signal', samples, started };
            const tick = () => {
                const s = getCalibrationSnapshot();
                const lvl = s.inputLevelPct;
                const elapsed = Date.now() - started;
                if (lvl >= trigger && wiz.autoCapture.phase === 'wait_signal') {
                    wiz.autoCapture.phase = 'listening';
                    wiz.autoCapture.signalStarted = Date.now();
                    _calWizardSetAutoStatus('<span class="text-cyan-300/90">Signal detected — listening…</span> Play open low E.');
                }
                if (wiz.autoCapture.phase === 'listening') {
                    samples.push({ level: lvl, peak: s.inputPeakPct, t: Date.now() });
                    const listenFor = Date.now() - (wiz.autoCapture.signalStarted || started);
                    _calWizardSetAutoStatus(
                        `<span class="text-cyan-300/90">Listening…</span> ${Math.round(listenFor / 1000)}s · `
                        + calibrationFormatLevel(lvl, s.inputPeakPct));
                    if (listenFor >= 1600) {
                        _calWizardStopAutoCapture();
                        _calWizardFinishLevelSample(wiz, 'signal', samples);
                        return;
                    }
                } else {
                    _calWizardSetAutoStatus(
                        `<span class="text-cyan-300/90">Waiting for signal…</span> Play open low E (need ≥${trigger}%). `
                        + calibrationFormatLevel(lvl, s.inputPeakPct));
                    if (elapsed >= maxWait) {
                        _calWizardStopAutoCapture();
                        _calWizardSetAutoStatus('<span class="text-amber-200/90">Timeout — no signal detected. Retry when ready.</span>');
                    }
                }
            };
            tick();
            wiz.autoCapture.intervalId = setInterval(tick, 120);
        });
    }

    function _calWizardResolveNoteCheckContext() {
        try { _syncChartStateFromHw(); } catch (_) {  }
        const hw = resolveHw();
        let info = null;
        try { info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null; } catch (_) {}
        const hasTuning = !!(info && Array.isArray(info.tuning) && info.tuning.length > 0);

        const cfgId = _calWizardState && _calWizardState.selectedInstrumentConfig;
        const cfg = (!hasTuning && cfgId)
            ? _CAL_WIZARD_INSTRUMENT_CONFIGS.find((c) => c.id === cfgId)
            : null;
        const forced = !hasTuning && !cfg && _calWizardForceArrangement;
        let arrangement;
        let stringCount;
        if (cfg) {
            arrangement = cfg.arrangement;
            stringCount = cfg.stringCount;
        } else {
            arrangement = forced
                ? _calWizardForceArrangement
                : (currentArrangement || 'guitar');

            stringCount = (Number.isFinite(currentStringCount) && currentStringCount > 0)
                ? currentStringCount : 6;
            if (forced && _calWizardForceArrangement === 'bass') stringCount = 4;
        }
        const offsets = Array.isArray(tuningOffsets) ? tuningOffsets : [0, 0, 0, 0, 0, 0];

        return { hasTuning, arrangement, stringCount, offsets, preset: cfg || null };
    }

    function _calWizardOpenStringMidi(stringIndex, ctx) {
        const { hasTuning, arrangement, stringCount, offsets } = ctx;
        let expectedMidi = null;
        if (hasTuning) {
            try {
                const computed = _ndMidiFromStringFret(
                    stringIndex, 0, arrangement, stringCount, offsets, 0);
                if (Number.isFinite(computed)) expectedMidi = computed;
            } catch (_) {  }
        }
        if (!Number.isFinite(expectedMidi)) {
            try {
                const base = _ndStandardMidiFor(arrangement, stringCount);
                if (base && base[stringIndex] !== undefined) expectedMidi = base[stringIndex];
            } catch (_) {  }
        }
        return expectedMidi;
    }

    function _calWizardOpenStringDisplayNum(stringIndex, stringCount) {
        return stringCount - stringIndex;
    }

    function _calWizardOpenStringLabel(stringIndex, stringCount, expectedNote, hasTuning) {
        const n = _calWizardOpenStringDisplayNum(stringIndex, stringCount);
        const note = expectedNote || '—';
        if (stringIndex === 0) {
            return hasTuning
                ? `String ${n} — low string (${note})`
                : `String ${n} — low string`;
        }
        if (stringIndex === stringCount - 1) {
            return hasTuning
                ? `String ${n} — high string (${note})`
                : `String ${n} — high string`;
        }
        return hasTuning ? `String ${n} (${note})` : `String ${n}`;
    }

    function _calWizardResolveNoteChecks(opts) {
        const mode = (opts && opts.mode === 'all') ? 'all' : 'quick';
        const ctx = _calWizardResolveNoteCheckContext();
        const { hasTuning, stringCount } = ctx;

        const showNote = true;
        if (mode === 'all') {
            const specs = [];
            for (let s = 0; s < stringCount; s++) {
                const expectedMidi = _calWizardOpenStringMidi(s, ctx);
                if (!Number.isFinite(expectedMidi)) continue;
                const expectedNote = _ndMidiToName(expectedMidi);
                specs.push({
                    id: 'openS' + s,
                    label: _calWizardOpenStringLabel(s, stringCount, expectedNote, showNote),
                    expectedMidi,
                    expectedNote,
                    string: s,
                    displayString: _calWizardOpenStringDisplayNum(s, stringCount),
                });
            }
            return specs;
        }
        const specs = [];
        for (const def of _CAL_WIZARD_NOTE_CHECK_DEFS) {
            if (def.string >= stringCount) continue;
            let expectedMidi = _calWizardOpenStringMidi(def.string, ctx);
            if (!Number.isFinite(expectedMidi)) expectedMidi = def.fallbackMidi;
            const expectedNote = _ndMidiToName(expectedMidi);
            const label = def.string === 0
                ? (showNote ? `Open low string (${expectedNote})` : def.fallbackLabel)
                : (showNote ? `Open 2nd string (${expectedNote})` : def.fallbackLabel);
            specs.push({
                id: def.id,
                label,
                expectedMidi,
                expectedNote,
                string: def.string,
            });
        }
        if (!specs.length) {
            return _CAL_WIZARD_NOTE_CHECK_DEFS.map((def) => ({
                id: def.id,
                label: def.fallbackLabel,
                expectedMidi: def.fallbackMidi,
                expectedNote: _ndMidiToName(def.fallbackMidi),
                string: def.string,
            }));
        }
        return specs;
    }

    function _calWizardFindNoteCheckSpec(noteId) {
        if (!noteId) return null;
        const quick = _calWizardResolveNoteChecks({ mode: 'quick' });
        const hit = quick.find((n) => n.id === noteId);
        if (hit) return hit;
        const all = _calWizardResolveNoteChecks({ mode: 'all' });
        return all.find((n) => n.id === noteId) || null;
    }

    function _calWizardResolveAdvancedStringChecks() {
        const quickStrings = new Set(_calWizardResolveNoteChecks({ mode: 'quick' }).map((s) => s.string));
        return _calWizardResolveNoteChecks({ mode: 'all' }).filter((s) => !quickStrings.has(s.string));
    }

    function _calWizardNoteResultParts(spec) {
        const wiz = _calWizardState;
        const r = wiz && wiz.notes ? wiz.notes[spec.id] : null;
        if (r && r.ok) {
            return { cls: 'text-green-300/90', txt: `OK — heard ${r.heardNote} (${r.confidencePct}%)` };
        }
        if (r) {
            return { cls: 'text-amber-200/90', txt: `Failed — expected ${r.expectedNote || spec.expectedNote}` };
        }
        return { cls: 'text-gray-500', txt: `Expected ${spec.expectedNote}` };
    }

    function _calWizardActiveNoteCapture() {
        const ac = _calWizardState && _calWizardState.autoCapture;
        if (!ac) return null;
        if (ac.phase === 'countdown' && typeof ac.kind === 'string' && ac.kind.startsWith('note_')) {
            return { id: ac.kind.slice(5), phase: 'countdown', left: Number.isFinite(ac.left) ? ac.left : '' };
        }
        if (ac.kind === 'note' && ac.noteId) {
            return { id: ac.noteId, phase: 'listening' };
        }
        return null;
    }

    function _calWizardRawPitchFields() {
        const confOk = detectedConfidence > detectionConfidenceMin;
        const rawMidi = (detectedMidi >= 0 && confOk) ? detectedMidi : null;
        const rawNote = Number.isFinite(rawMidi) ? _ndMidiToName(rawMidi) : '—';
        let displayNote = null;
        if (detectedString >= 0 && confOk) {
            const dm = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
            if (Number.isFinite(dm)) displayNote = _ndMidiToName(dm);
        }
        return {
            rawMidi,
            rawNote,
            displayNote,
            confidencePct: confOk ? Math.round(detectedConfidence * 100) : null,
            channel: _ndHealthInputChannelLabel(),
        };
    }

    function _calWizardMidiNearTarget(detectedMidi, targetMidi, centsTol) {
        if (!Number.isFinite(detectedMidi) || !Number.isFinite(targetMidi)) return false;
        return Math.abs(_ndNearestOctaveCents(detectedMidi, targetMidi)) <= centsTol;
    }

    function _calWizardStopAllStringsRun(reason, opts) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.allStrings) return;
        const seq = wiz.allStrings;
        const wasRunning = seq.running;
        seq.running = false;
        if (opts && opts.clearMessage) seq.message = null;
        if (reason === 'restart') {
            seq.complete = false;
            seq.failedId = null;
        }
        if (wasRunning && wiz.autoCapture && wiz.autoCapture.kind === 'note') {
            const nid = wiz.autoCapture.noteId;
            if (nid && seq.ids && seq.ids.includes(nid)) {
                _calWizardStopAutoCapture();
            }
        }
    }

    function _calWizardStartAllStringsRun() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calWizardStopAllStringsRun('restart', { clearMessage: true });

        const specs = _calWizardResolveAdvancedStringChecks();
        if (!specs.length) return;
        for (const key of Object.keys(wiz.notes)) {
            if (key.startsWith('openS')) delete wiz.notes[key];
        }
        const ids = specs.map((s) => s.id);
        const first = specs[0];
        wiz.allStrings = {
            running: true,
            index: 0,
            ids,
            complete: false,
            failedId: null,
            detailsOpen: true,
            message: first ? `Play ${first.label}` : null,
        };
        renderCalibrationWizard();
        _calWizardStartNoteCapture(ids[0]);
    }

    function _calWizardAdvanceAllStringsRun(noteId, ok) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.allStrings || !wiz.allStrings.running) return false;
        const seq = wiz.allStrings;
        const expectedId = seq.ids[seq.index];
        if (noteId !== expectedId) return true;
        seq.detailsOpen = true;
        if (!ok) {
            seq.running = false;
            seq.failedId = noteId;
            const spec = _calWizardFindNoteCheckSpec(noteId);
            const label = spec ? spec.label : noteId;
            seq.message = `${label} did not pass — retry the run or check manually.`;
            renderCalibrationWizard();
            return true;
        }
        seq.index += 1;
        if (seq.index >= seq.ids.length) {
            seq.running = false;
            seq.complete = true;
            seq.message = 'Remaining strings passed.';
            _calWizardSetAutoStatus('<span class="text-green-300/90">Remaining strings passed.</span>');
            renderCalibrationWizard();
            return true;
        }
        const nextId = seq.ids[seq.index];
        const nextSpec = _calWizardFindNoteCheckSpec(nextId);
        seq.message = nextSpec ? `Play ${nextSpec.label}` : `Play string ${seq.index + 1}`;
        renderCalibrationWizard();
        _calWizardStartNoteCapture(nextId);
        return true;
    }

    function _calWizardStartNoteCapture(noteId) {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            if (wiz.allStrings && wiz.allStrings.running) {
                _calWizardStopAllStringsRun('detect-off');
            }
            return;
        }
        _calWizardBeginCountdownThen('note_' + noteId, 2, () => {
            const spec = _calWizardFindNoteCheckSpec(noteId);
            if (!spec) return;
            _calWizardStopAutoCapture();
            const stable = [];
            const started = Date.now();
            const maxWait = 14000;
            wiz.autoCapture = { kind: 'note', noteId, stable, started };
            const tick = () => {
                const s = getCalibrationSnapshot();
                const heardMidi = _calWizardRawPitchFields().rawMidi;
                if (_calWizardMidiNearTarget(heardMidi, spec.expectedMidi, 100)) {
                    stable.push({ midi: heardMidi, conf: detectedConfidence, t: Date.now() });
                } else {
                    stable.length = 0;
                }
                const elapsed = Date.now() - started;
                if (stable.length >= 4) {
                    const last = stable[stable.length - 1];
                    wiz.notes[noteId] = {
                        ok: true,
                        label: spec.label,
                        expectedNote: spec.expectedNote,
                        expectedMidi: spec.expectedMidi,
                        heardNote: _ndMidiToName(last.midi),
                        confidencePct: Math.round(last.conf * 100),
                        at: Date.now(),
                    };
                    _calWizardStopAutoCapture();
                    _calWizardSetAutoStatus(
                        `<span class="text-green-300/90">${spec.label} OK</span> — `
                        + `expected ${spec.expectedNote}, heard ${wiz.notes[noteId].heardNote} `
                        + `(${wiz.notes[noteId].confidencePct}% conf)`);
                    if (!_calWizardAdvanceAllStringsRun(noteId, true)) {
                        renderCalibrationWizard();
                    }
                    return;
                }
                _calWizardSetAutoStatus(
                    `<span class="text-cyan-300/90">Listening for ${spec.label}…</span> `
                    + (s.heardConfidencePct != null
                        ? `Expected: ${spec.expectedNote} · Heard: ${s.rawHeardNote ?? s.heardNote} · ${s.heardConfidencePct}%`
                        : `Expected: ${spec.expectedNote} · Channel: ${s.channel || '—'} · Live: `
                        + calibrationFormatLevel(s.inputLevelPct, s.inputPeakPct)));
                if (elapsed >= maxWait) {
                    _calWizardStopAutoCapture();
                    wiz.notes[noteId] = {
                        ok: false,
                        label: spec.label,
                        expectedNote: spec.expectedNote,
                        expectedMidi: spec.expectedMidi,
                        at: Date.now(),
                    };
                    _calWizardSetAutoStatus(
                        `<span class="text-amber-200/90">${spec.label}: no stable note detected. `
                        + `Expected ${spec.expectedNote}. Retry.</span>`);
                    if (!_calWizardAdvanceAllStringsRun(noteId, false)) {
                        renderCalibrationWizard();
                    }
                }
            };
            tick();
            wiz.autoCapture.intervalId = setInterval(tick, 150);
        });
    }

    function _calWizardCaptureTimingSnapshot() {
        const wiz = _calWizardState;
        if (!wiz) return;
        let d = null;
        try { d = getCalibrationSnapshot().diagnostic; } catch (_) {}
        const dist = d && d.timing_error_ms_hits ? d.timing_error_ms_hits : {};
        const med = dist.median;
        const count = dist.count || 0;
        wiz.timing = {
            medianMs: Number.isFinite(med) ? med : null,
            sampleCount: count,
            captured: true,
            at: Date.now(),
        };
        _calWizardBuildSafeRecommendations(wiz, getCalibrationSnapshot());
        renderCalibrationWizard();
    }

    function _calWizardSetTunerMinimized(minimized) {
        const wiz = _calWizardState;
        if (!_calWizardEl || !wiz) return;
        wiz.tunerMinimized = !!minimized;
        const card = _calWizardEl.querySelector('.nd-cal-wizard-card');
        const ret = _calWizardEl.querySelector('.nd-cal-return-wizard');
        if (minimized) {
            _calWizardEl.style.background = 'transparent';
            _calWizardEl.style.pointerEvents = 'none';
            if (card) card.style.visibility = 'hidden';
            if (ret) ret.style.display = 'block';
        } else {
            _calWizardEl.style.background = 'rgba(0,0,0,0.65)';
            _calWizardEl.style.pointerEvents = 'auto';
            if (card) card.style.visibility = 'visible';
            if (ret) ret.style.display = 'none';
            _calWizardUpdateReturnButtonTimer(null);
        }
    }

    function _calWizardMinimizeForPlayback() {
        _calWizardSetTunerMinimized(true);
    }

    function _calWizardUpdateReturnButtonTimer(secLeft) {
        if (!_calWizardEl) return;
        const primary = _calWizardEl.querySelector('.nd-cal-return-primary');
        const secondary = _calWizardEl.querySelector('.nd-cal-return-secondary');
        if (!primary || !secondary) return;
        if (secLeft === 'waiting') {
            primary.textContent = 'Press Play to start timing';
            secondary.textContent = `The ${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s timer starts when playback begins`;
        } else if (Number.isFinite(secLeft) && secLeft >= 0) {
            primary.textContent = `Timing test: ${secLeft}s left`;
            secondary.textContent = 'Keep playing — setup will return automatically';
        } else {
            primary.textContent = 'Return to Calibration Wizard';
            secondary.textContent = 'Tap here to continue setup';
        }
    }

    function _calWizardTeardownPlayAlongWait(pa) {
        if (!pa) return;
        if (pa.waitTimeoutId) {
            clearTimeout(pa.waitTimeoutId);
            pa.waitTimeoutId = null;
        }
        if (pa.waitPollId) {
            clearInterval(pa.waitPollId);
            pa.waitPollId = null;
        }
        if (pa.onPlayHandler && window.slopsmith && typeof window.slopsmith.off === 'function') {
            try { window.slopsmith.off('song:play', pa.onPlayHandler); } catch (_) {}
            pa.onPlayHandler = null;
        }
    }

    function _calWizardIsPlaybackActive() {
        try {
            if (window.slopsmith && window.slopsmith.isPlaying) return true;
        } catch (_) {  }
        return false;
    }

    function _calWizardPlayheadAdvancing(pa) {
        const hw = resolveHw();
        if (!hw || typeof hw.getTime !== 'function' || !pa) return false;
        const t = hw.getTime();
        if (!Number.isFinite(pa._phLast)) {
            pa._phLast = t;
            pa._phLastAt = Date.now();
            return false;
        }
        const gapMs = Date.now() - pa._phLastAt;
        if (gapMs < _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_GAP_MS) return false;
        const advancing = t > pa._phLast + _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_SEC;
        pa._phLast = t;
        pa._phLastAt = Date.now();
        return advancing;
    }

    function _calWizardBeginTimedPlayAlongCountdown() {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong || wiz.playAlong.phase !== 'waiting') return;
        const pa = wiz.playAlong;
        _calWizardTeardownPlayAlongWait(pa);
        pa.phase = 'running';
        pa.endsAt = Date.now() + pa.durationMs;
        const tickCountdown = () => {
            if (!_calWizardState || !_calWizardState.playAlong) return;
            const active = _calWizardState.playAlong;
            if (active.phase !== 'running' || !Number.isFinite(active.endsAt)) return;
            const left = Math.ceil((active.endsAt - Date.now()) / 1000);
            if (left <= 0) {
                _calWizardFinishTimedPlayAlong(false);
                return;
            }
            _calWizardUpdateReturnButtonTimer(left);
        };
        tickCountdown();
        pa.intervalId = setInterval(tickCountdown, 1000);
        pa.timerId = setTimeout(() => _calWizardFinishTimedPlayAlong(false), pa.durationMs + 50);
    }

    function _calWizardPollPlayAlongWait() {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong || wiz.playAlong.phase !== 'waiting') return;
        const pa = wiz.playAlong;
        if (pa.playbackSeen || _calWizardIsPlaybackActive() || _calWizardPlayheadAdvancing(pa)) {
            _calWizardBeginTimedPlayAlongCountdown();
        }
    }

    function _calWizardCancelTimedPlayAlongWaiting(message) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return;
        _calWizardStopTimedPlayAlong('cancel-wait');
        _calWizardSetTunerMinimized(false);
        wiz.timingCaptureNote = message;
        renderCalibrationWizard();
        _calWizardRefreshLive();
    }

    function _calWizardStopTimedPlayAlong(reason) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return false;
        const pa = wiz.playAlong;
        _calWizardTeardownPlayAlongWait(pa);
        if (pa.timerId) {
            clearTimeout(pa.timerId);
            pa.timerId = null;
        }
        if (pa.intervalId) {
            clearInterval(pa.intervalId);
            pa.intervalId = null;
        }
        wiz.playAlong = null;
        _calWizardUpdateReturnButtonTimer(null);
        return true;
    }

    function _calWizardDispatchPlaybackPause(reason) {
        const caps = window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.dispatch !== 'function') {
            return Promise.resolve({ attempted: false, handled: false });
        }
        try {
            const result = caps.dispatch({
                capability: 'playback',
                command: 'pause',
                requester: 'slopsmith-plugin-notedetect',
                args: { requesterId: 'cal-wizard-timed-playalong', reason: reason || 'timed-playalong-complete' },
            });
            const parse = (r) => ({
                attempted: true,
                handled: !!(r && (r.outcome === 'handled' || r.status === 'paused')),
                result: r,
            });
            if (result && typeof result.then === 'function') {
                return result.then(parse).catch((e) => {
                    console.warn('[note_detect] cal-wizard timed playalong pause:', e);
                    return { attempted: true, handled: false, error: e };
                });
            }
            return Promise.resolve(parse(result));
        } catch (e) {
            console.warn('[note_detect] cal-wizard timed playalong pause:', e);
            return Promise.resolve({ attempted: false, handled: false, error: e });
        }
    }

    function _calWizardAppendTimingCaptureNote(fragment) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.timingCaptureNote || !fragment) return;
        if (!wiz.timingCaptureNote.includes(fragment)) {
            wiz.timingCaptureNote += ` ${fragment}`;
            renderCalibrationWizard();
        }
    }

    function _calWizardMaybePauseAfterTimedPlayAlong(pa) {
        if (!pa || pa.wasPlayingAtArm !== false) return;
        if (!_calWizardIsPlaybackActive()) return;
        _calWizardClearPauseRetries();
        const delays = _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS;
        delays.forEach((delayMs, idx) => {
            const isLast = idx === delays.length - 1;
            const timerId = setTimeout(() => {
                _calWizardPauseRetryTimers = _calWizardPauseRetryTimers.filter((id) => id !== timerId);
                if (!_calWizardState) return;
                if (!_calWizardIsPlaybackActive()) {
                    _calWizardAppendTimingCaptureNote('Playback paused.');
                    return;
                }
                const reason = idx === 0
                    ? 'cal-wizard-timed-playalong-complete'
                    : 'cal-wizard-timed-playalong-retry';
                _calWizardDispatchPlaybackPause(reason).then(() => {
                    if (!_calWizardState) return;
                    if (!_calWizardIsPlaybackActive()) {
                        _calWizardAppendTimingCaptureNote('Playback paused.');
                    } else if (isLast) {
                        _calWizardAppendTimingCaptureNote(
                            'Playback may still be running — pause when ready.');
                    }
                });
            }, delayMs);
            _calWizardPauseRetryTimers.push(timerId);
        });
    }

    function _calWizardFinishTimedPlayAlong(partial) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return;
        if (wiz.playAlong.phase === 'waiting') {
            _calWizardCancelTimedPlayAlongWaiting('Timed play-along cancelled — returned before playback started.');
            return;
        }
        const stashedPlayAlong = { wasPlayingAtArm: wiz.playAlong.wasPlayingAtArm };
        _calWizardStopTimedPlayAlong('finish');
        _calWizardSetTunerMinimized(false);
        wiz.timingCaptureNote = partial
            ? 'Partial window captured — returned early.'
            : `Timed play-along captured (${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s window).`;
        _calWizardCaptureTimingSnapshot();
        if (!partial) _calWizardMaybePauseAfterTimedPlayAlong(stashedPlayAlong);
    }

    function _calWizardStartTimedPlayAlong(durationSec) {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            wiz.timingCaptureNote = 'Turn Detect on first.';
            renderCalibrationWizard();
            return;
        }
        _calWizardStopTimedPlayAlong('restart');
        try { _resetCalibrationSamples(); } catch (e) {
            console.warn('[note_detect] resetCalibrationSamples:', e);
        }
        wiz.timing = null;
        wiz.timingCaptureNote = null;
        const sec = Number.isFinite(durationSec) && durationSec > 0
            ? durationSec : _CAL_WIZARD_TIMED_PLAYALONG_SEC;
        const durationMs = sec * 1000;
        const wasPlayingAtArm = _calWizardIsPlaybackActive();
        wiz.playAlong = {
            phase: 'waiting',
            durationSec: sec,
            durationMs,
            waitStartedAt: Date.now(),
            waitTimeoutId: null,
            waitPollId: null,
            onPlayHandler: null,
            playbackSeen: false,
            wasPlayingAtArm,
            endsAt: null,
            timerId: null,
            intervalId: null,
        };
        _calWizardMinimizeForPlayback();
        _calWizardUpdateReturnButtonTimer('waiting');
        const pa = wiz.playAlong;
        if (_calWizardIsPlaybackActive()) {
            _calWizardBeginTimedPlayAlongCountdown();
            return;
        }
        pa.onPlayHandler = () => {
            const w = _calWizardState;
            if (!w || !w.playAlong || w.playAlong.phase !== 'waiting') return;
            w.playAlong.playbackSeen = true;
            _calWizardPollPlayAlongWait();
        };
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            try { window.slopsmith.on('song:play', pa.onPlayHandler); } catch (_) {}
        }
        pa.waitPollId = setInterval(_calWizardPollPlayAlongWait, _CAL_WIZARD_PLAY_ALONG_WAIT_POLL_MS);
        pa.waitTimeoutId = setTimeout(() => {
            const w = _calWizardState;
            if (!w || !w.playAlong || w.playAlong.phase !== 'waiting') return;
            _calWizardCancelTimedPlayAlongWaiting('Timed play-along cancelled — playback did not start.');
        }, _CAL_WIZARD_PLAY_ALONG_WAIT_MS);
    }

    function _calWizardFmtGain(v) {
        return Number.isFinite(v) ? `${(+v).toFixed(2)}x` : '—';
    }

    function _calWizardFmtLatencyMs(v) {
        return Number.isFinite(v) ? `${Math.round(v * 1000)} ms` : '—';
    }

    function _calWizardCompletionHtml(wiz) {
        const applied = wiz.applied;
        const appliedParts = [];
        if (applied && applied.inputGain != null) {
            appliedParts.push(`Input gain ${_calWizardFmtGain(applied.inputGain)} — your hardest playing now peaks near −12 dBFS, so amps stay clean`);
        }
        if (applied && applied.latencyOffset != null) {
            appliedParts.push(`Detection delay ${_calWizardFmtLatencyMs(applied.latencyOffset)}`);
        }
        if (wiz.complete === 'applied') {
            const detailLine = appliedParts.length
                ? appliedParts.join(' · ')
                : 'Checked settings were applied.';
            return `
                <div class="text-center py-3 mb-4 rounded-xl bg-dark-800/90 border border-green-900/40">
                    <p class="text-xl font-bold text-white mb-2">Calibration applied</p>
                    <p class="text-sm text-gray-200 mb-1">You're done. These settings are now active.</p>
                    <p class="text-xs text-gray-400">${detailLine}</p>
                </div>
                <button type="button" class="nd-cal-done w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-base font-bold text-white mb-3 shadow-lg">Done — Close Wizard</button>
                <button type="button" class="nd-cal-run-lab w-full py-2.5 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-sm text-gray-300">Run Technique Assessment</button>`;
        }
        return `
            <div class="text-center py-3 mb-4 rounded-xl bg-dark-800/90 border border-gray-600">
                <p class="text-xl font-bold text-white mb-2">Calibration finished</p>
                <p class="text-sm text-gray-200">No recommended settings were applied.</p>
            </div>
            <button type="button" class="nd-cal-done w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-base font-bold text-white mb-3 shadow-lg">Done — Close Wizard</button>
            <button type="button" class="nd-cal-run-lab w-full py-2.5 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-sm text-gray-300">Run Technique Assessment</button>`;
    }

    function _calWizardReleaseTuner() {
        try {
            if (window.tuner && typeof window.tuner.disable === 'function') {
                window.tuner.disable();
            }
        } catch (e) {
            console.warn('[note_detect] cal wizard tuner release:', e);
        }
        if (_calWizardState) _calWizardSetTunerMinimized(false);
        if (enabled) {
            try { restartAudio(); } catch (e) {
                console.warn('[note_detect] cal wizard restartAudio after tuner release:', e);
            }
        }
    }

    function _calWizardApplySafeSettings(wiz) {
        const applied = {};
        const rec = wiz.recommended || {};
        if (wiz.applyChecked.inputGain && Number.isFinite(rec.inputGain)) {
            inputGain = Math.max(0.1, Math.min(5, rec.inputGain));
            if (gainNode) gainNode.gain.value = inputGain;

            engineInputGain = inputGain;
            _ndApplyEngineGain();
            applied.inputGain = inputGain;
        }
        if (wiz.applyChecked.latencyOffset && Number.isFinite(rec.latencyOffset)) {
            latencyOffset = Math.max(0, Math.min(0.25, rec.latencyOffset));
            applied.latencyOffset = latencyOffset;
        }
        saveSettings();
        wiz.applied = applied;
        return applied;
    }

    function launchCalibration(opts) {
        opts = opts || {};
        const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
        const onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
        const forcedInstrument = (opts.instrument === 'guitar' || opts.instrument === 'bass')
            ? opts.instrument : null;
        if (forcedInstrument) currentArrangement = forcedInstrument;
        const start = () => {
            try {
                openCalibrationWizard();
            } catch (e) {
                if (onCancel) { try { onCancel('error'); } catch (_) {  } }
                return;
            }

            _ndOpenSelectedInputSource(ND_AUDIO_CAL_REQUESTER, 'calibration');
            _calWizardOnDone = onDone;
            _calWizardOnCancel = onCancel;

            _calWizardForceArrangement = forcedInstrument;
        };

        if (!enabled) {
            let p = null;
            try { p = enable(); } catch (_) { p = null; }
            if (p && typeof p.then === 'function') p.then(start, start); else start();
        } else {
            start();
        }
    }

    function _calWizardDeviceLabel() {
        if (!selectedDeviceId) return 'Default system input';
        return `Device ${selectedDeviceId.slice(0, 12)}…`;
    }

    function _calWizardEngineChannelLabel(ch) {
        const opt = _CAL_WIZARD_INPUT_CHANNEL_OPTIONS.find((o) => o.ch === ch);
        return opt ? opt.label : `Channel ${ch}`;
    }

    function _calWizardEngineChannelDisplayLabel(ch) {
        if (ch === 0) return 'Left (Ch 1)';
        if (ch === 1) return 'Right (Ch 2)';
        return 'Default / Mono Mix';
    }

    function _calWizardPluginChannelFromEngine(ch) {
        if (ch === 0) return 'left';
        if (ch === 1) return 'right';
        return 'mono';
    }

    function _calWizardSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function _calWizardWizardAudioApi() {
        if (usingDesktopBridge && bridgeDesktop && bridgeDesktop.audio) return bridgeDesktop.audio;
        const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        return (desktop && desktop.audio) ? desktop.audio : null;
    }

    async function _calWizardSampleEngineLevels(durationMs, intervalMs) {
        const audio = _calWizardWizardAudioApi();
        if (!audio || typeof audio.getLevels !== 'function') {
            return { maxLevel: 0, avgLevel: 0, maxPeak: 0 };
        }
        let maxLevel = 0;
        let maxPeak = 0;
        let levelSum = 0;
        let levelCount = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < durationMs) {
            try {
                const lv = await audio.getLevels();
                if (lv) {
                    const level = Number.isFinite(lv.inputLevel) ? lv.inputLevel : 0;
                    const peak = Number.isFinite(lv.inputPeak) ? lv.inputPeak : 0;
                    maxLevel = Math.max(maxLevel, level);
                    maxPeak = Math.max(maxPeak, peak);
                    levelSum += level;
                    levelCount++;
                }
            } catch (_) {  }
            await _calWizardSleep(intervalMs);
        }
        const avgLevel = levelCount > 0 ? levelSum / levelCount : 0;
        return { maxLevel, avgLevel, maxPeak };
    }

    function _calWizardChannelProbeTrialShortLabel(t) {
        if (!t) return '?';
        if (t.ch === -1) return 'Mono';
        if (t.ch === 0) return 'Ch 1';
        if (t.ch === 1) return 'Ch 2';
        return t.label || '?';
    }

    function _calWizardChannelProbeProgressLabel(ch) {
        if (ch === -1) return 'Mono Mix';
        if (ch === 0) return 'Ch 1';
        if (ch === 1) return 'Ch 2';
        return 'Channel';
    }

    function _calWizardChannelProbeTrialsSummary(trials) {
        if (!trials || !trials.length) return '';
        return trials.map((t) => `${_calWizardChannelProbeTrialShortLabel(t)} ${Math.round((t.maxLevel || 0) * 100)}%`).join(', ');
    }

    function _calWizardLevelsClose(a, b, ratio) {
        const hi = Math.max(a, b);
        if (hi <= 0) return true;
        return Math.abs(a - b) / hi <= ratio;
    }

    function _calWizardTrialByCh(trials, ch) {
        return trials.find((t) => t.ch === ch) || null;
    }

    function _calWizardPickChannelProbeWinner(trials) {
        if (!trials || !trials.length) return null;
        let best = trials[0];
        for (let i = 1; i < trials.length; i++) {
            const t = trials[i];
            if (t.maxLevel > best.maxLevel
                || (t.maxLevel === best.maxLevel && t.avgLevel > best.avgLevel)) {
                best = t;
            }
        }
        const mono = trials.find((t) => t.ch === -1);
        if (!mono || best.ch !== -1) return best;
        let bestSingle = null;
        for (const t of trials) {
            if (t.ch !== 0 && t.ch !== 1) continue;
            if (!bestSingle || t.maxLevel > bestSingle.maxLevel
                || (t.maxLevel === bestSingle.maxLevel && t.avgLevel > bestSingle.avgLevel)) {
                bestSingle = t;
            }
        }
        if (!bestSingle) return best;
        const hi = Math.max(mono.maxLevel, bestSingle.maxLevel);
        if (hi > 0 && Math.abs(mono.maxLevel - bestSingle.maxLevel) / hi <= _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO) {
            return bestSingle;
        }
        return best;
    }

    function _calWizardAnalyzeChannelProbeTrials(trials) {
        const ratio = _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO;
        const ch1 = _calWizardTrialByCh(trials, 0);
        const ch2 = _calWizardTrialByCh(trials, 1);
        const best = _calWizardPickChannelProbeWinner(trials);
        const ch1ch2Close = !!(ch1 && ch2
            && _calWizardLevelsClose(ch1.maxLevel, ch2.maxLevel, ratio));
        const ch1usable = !!(ch1 && ch1.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK);
        const ch2usable = !!(ch2 && ch2.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK);
        const ambiguousCh12 = ch1ch2Close && ch1usable && ch2usable;
        let suggested = ch2;
        let alternate = ch1;
        if (ch1 && ch2) {
            if (ch2.maxLevel > ch1.maxLevel) {
                suggested = ch2;
                alternate = ch1;
            } else if (ch1.maxLevel > ch2.maxLevel) {
                suggested = ch1;
                alternate = ch2;
            } else if (ch2.avgLevel > ch1.avgLevel) {
                suggested = ch2;
                alternate = ch1;
            } else if (ch1.avgLevel > ch2.avgLevel) {
                suggested = ch1;
                alternate = ch2;
            } else {

                suggested = ch2;
                alternate = ch1;
            }
        }
        return {
            best,
            ch1,
            ch2,
            ch1ch2Close,
            ambiguousCh12,
            suggested,
            alternate,
        };
    }

    async function _calWizardApplyEngineInputChannel(ch) {
        const audio = _calWizardWizardAudioApi();
        if (!audio || typeof audio.setInputChannel !== 'function') return false;
        await audio.setInputChannel(ch);
        if (typeof audio.loadDeviceSettings === 'function'
            && typeof audio.saveDeviceSettings === 'function') {
            try {
                const cur = await audio.loadDeviceSettings();
                const base = (cur && typeof cur === 'object') ? cur : {};
                await audio.saveDeviceSettings({
                    ...base,
                    inputChannel: String(ch),
                    savedAt: Date.now(),
                });
            } catch (e) {
                console.warn('[note_detect] cal wizard saveDeviceSettings:', e);
            }
        }
        selectedChannel = _calWizardPluginChannelFromEngine(ch);
        saveSettings();
        return true;
    }

    function _calWizardFormatChannelProbeResult(result) {
        const summary = (result && result.trials) ? _calWizardChannelProbeTrialsSummary(result.trials) : '';
        if (!result || result.ok === false) {
            return `<span class="text-amber-200/90">No strong input detected.</span> Check guitar volume, cable, Spark USB routing, input gain, or try another device.${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
        }
        if (result.ok === 'ambiguous') {
            const sug = Number.isFinite(result.suggestedCh)
                ? _calWizardEngineChannelDisplayLabel(result.suggestedCh)
                : '—';
            const alt = Number.isFinite(result.alternateCh)
                ? _calWizardEngineChannelDisplayLabel(result.alternateCh)
                : '—';
            return `<span class="text-amber-200/90">Ch 1 and Ch 2 are very close.</span> Suggested: ${sug}, but ${alt} is also usable. Choose the channel that matches your setup.${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
        }
        const levelPct = Math.round((result.bestLevel || 0) * 100);
        const peakPct = Math.round((result.bestPeak || 0) * 100);
        const disp = Number.isFinite(result.bestCh)
            ? _calWizardEngineChannelDisplayLabel(result.bestCh)
            : (result.bestLabel || '—');
        const peakNote = peakPct > levelPct ? ` (peak ${peakPct}%)` : '';
        return `<span class="text-green-300/90">Best channel: ${disp}, level ${levelPct}%${peakNote}</span>${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
    }

    async function _calWizardApplyChannelProbeUserPick(ch) {
        const wiz = _calWizardState;
        if (!wiz || !Number.isFinite(ch)) return;
        const applied = await _calWizardApplyEngineInputChannel(ch);
        if (!applied) return;
        const trial = wiz.channelProbeResult && wiz.channelProbeResult.trials
            ? _calWizardTrialByCh(wiz.channelProbeResult.trials, ch)
            : null;
        wiz.channelProbeResult = {
            ok: true,
            userPicked: true,
            bestCh: ch,
            bestLabel: trial ? trial.label : _calWizardEngineChannelLabel(ch),
            bestLevel: trial ? trial.maxLevel : 0,
            bestPeak: trial ? trial.maxPeak : 0,
            trials: wiz.channelProbeResult.trials,
        };
        renderCalibrationWizard();
        _calWizardRefreshLive();
    }

    async function _calWizardAutoDetectInputChannel() {
        const wiz = _calWizardState;
        if (!wiz) return;
        if (wiz.channelProbeRunning) {
            _calWizardSetChannelProbeStatus(
                '<span class="text-amber-200/90">Detection already in progress...</span>');
            return;
        }
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            wiz.channelProbeError = 'Turn Detect on first.';
            renderCalibrationWizard();
            return;
        }
        const audio = _calWizardWizardAudioApi();
        if (!usingDesktopBridge || !audio
            || typeof audio.setInputChannel !== 'function'
            || typeof audio.getLevels !== 'function') {
            wiz.channelProbeError = 'Auto-detect needs the desktop audio engine.';
            renderCalibrationWizard();
            return;
        }
        wiz.channelProbeRunning = true;
        wiz.channelProbeError = null;
        wiz.channelProbeResult = null;
        const token = {};
        wiz.channelProbeAbort = token;
        renderCalibrationWizard();
        const trials = [];
        const probeSteps = _CAL_WIZARD_INPUT_CHANNEL_OPTIONS;
        try {
            for (let i = 0; i < probeSteps.length; i++) {
                const opt = probeSteps[i];
                if (wiz.channelProbeAbort !== token) return;
                const progLabel = _calWizardChannelProbeProgressLabel(opt.ch);
                _calWizardSetChannelProbeStatus(
                    `<span class="text-cyan-300/90">Strum hard…</span> Testing <strong>${progLabel} (${i + 1} of ${probeSteps.length})</strong>…`);
                await audio.setInputChannel(opt.ch);
                if (typeof audio.resetPeaks === 'function') await audio.resetPeaks();
                await _calWizardSleep(_CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS);
                const { maxLevel, avgLevel, maxPeak } = await _calWizardSampleEngineLevels(
                    _CAL_WIZARD_CHANNEL_PROBE_MS,
                    _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS,
                );
                if (wiz.channelProbeAbort !== token) return;
                trials.push({ ch: opt.ch, label: opt.label, maxLevel, avgLevel, maxPeak });
            }
            const analysis = _calWizardAnalyzeChannelProbeTrials(trials);
            const { best, ambiguousCh12, suggested, alternate } = analysis;
            const ok = best && best.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK;
            if (!ok) {
                wiz.channelProbeResult = {
                    ok: false,
                    trials,
                    bestLevel: best ? best.maxLevel : 0,
                    bestPeak: best ? best.maxPeak : 0,
                };
            } else if (ambiguousCh12) {
                wiz.channelProbeResult = {
                    ok: 'ambiguous',
                    ambiguousCh12: true,
                    suggestedCh: suggested ? suggested.ch : null,
                    alternateCh: alternate ? alternate.ch : null,
                    trials,
                };
            } else {
                await _calWizardApplyEngineInputChannel(best.ch);
                wiz.channelProbeResult = {
                    ok: true,
                    clearWinner: true,
                    bestCh: best.ch,
                    bestLabel: best.label,
                    bestLevel: best.maxLevel,
                    bestPeak: best.maxPeak,
                    trials,
                };
            }
        } catch (e) {
            wiz.channelProbeError = (e && e.message) ? e.message : String(e);
        } finally {
            if (wiz.channelProbeAbort === token) wiz.channelProbeAbort = null;
            wiz.channelProbeRunning = false;
            renderCalibrationWizard();
            _calWizardRefreshLive();
        }
    }

    function getCalibrationSnapshot() {
        let d = null;
        try { d = _buildDiagnosticPayload(); } catch (_) {  }
        const hw = resolveHw();
        let avMs = null;
        try { avMs = hw && hw.getAvOffset ? hw.getAvOffset() : null; } catch (_) {}
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const total = hits + misses;
        const pitch = _calWizardRawPitchFields();
        const heardNote = pitch.rawNote;
        const heardConfPct = pitch.confidencePct;
        let hearingLine = '—';
        try { hearingLine = _ndHealthDetectedLine(); } catch (_) {}
        const sr = audioCtx && audioCtx.sampleRate
            ? Math.round(audioCtx.sampleRate)
            : (bridgeSampleRate ? Math.round(bridgeSampleRate) : null);
        return {
            enabled: !!enabled,
            inputLevelPct: Math.round((inputLevel || 0) * 100),
            inputPeakPct: Math.round((inputPeak || 0) * 100),
            hearingLine,
            heardNote,
            heardConfidencePct: heardConfPct,
            rawHeardNote: pitch.rawNote,
            displayHeardNote: pitch.displayNote,
            rawMidi: pitch.rawMidi,
            channel: pitch.channel,
            source: _ndHealthDetectorPathLabel(),
            sampleRateHz: sr,
            avOffsetMs: avMs,
            latencyOffsetMs: Math.round(latencyOffset * 1000),
            timingMedianMs: teHits.median,
            diagnostic: d,
            stats: {
                hits,
                misses,
                total,
                accuracy: total > 0 ? Math.round((hits / total) * 100) : null,
            },
            method: detectionMethod,
        };
    }

    function calibrationWizardClose() {

        const _calHadWizard = !!_calWizardEl;
        const _calAppliedResult = (_calWizardState && _calWizardState.applied) || null;
        _calWizardStopAllStringsRun('close');
        _calWizardClearPauseRetries();
        _calWizardStopAutoCapture();

        _ndApplyEngineGain();
        _calWizardStopTimedPlayAlong('close');
        _calWizardReleaseTuner();
        if (_calWizardTick) {
            clearInterval(_calWizardTick);
            _calWizardTick = null;
        }
        if (_calWizardEl) {
            _calWizardEl.remove();
            _calWizardEl = null;
        }
        _calWizardState = null;
        _calWizardForceArrangement = null;

        if (_calHadWizard) {

            _ndCloseSelectedInputSource(ND_AUDIO_CAL_REQUESTER);
            const onDone = _calWizardOnDone;
            const onCancel = _calWizardOnCancel;
            _calWizardOnDone = null;
            _calWizardOnCancel = null;
            if (_calAppliedResult && typeof onDone === 'function') { try { onDone(_calAppliedResult); } catch (_) {  } }
            else if (typeof onCancel === 'function') { try { onCancel('closed'); } catch (_) {  } }
        }
    }

    function _calWizardDetectBanner(snap) {
        if (snap && snap.enabled) return '';
        return '<p class="nd-cal-detect-warn text-amber-200/90 text-xs mb-2">Turn Detect on first for live input and timing checks.</p>';
    }

    function _calWizardRefreshLive() {
        if (!_calWizardEl || !_calWizardState) return;
        const snap = getCalibrationSnapshot();
        const wiz = _calWizardState;
        const live = _calWizardEl.querySelector('.nd-cal-live-level');
        if (live) live.textContent = 'Live: ' + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct);
        const heard = _calWizardEl.querySelector('.nd-cal-heard');
        if (heard) {
            if (wiz.step === 5) {
                heard.textContent = snap.heardConfidencePct != null
                    ? `Now hearing: ${snap.rawHeardNote ?? snap.heardNote} · ${snap.heardConfidencePct}% confidence`
                    : `Now hearing: nothing yet — play a note · Channel: ${snap.channel || '—'} · Live: `
                    + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct);
            } else {
                heard.textContent = snap.heardConfidencePct != null
                    ? `Now hearing: ${snap.heardNote} · ${snap.heardConfidencePct}% confidence`
                    : `Now hearing: ${snap.hearingLine === '—' ? 'nothing yet — play a note' : snap.hearingLine}`;
            }
        }
        const debugEl = _calWizardEl.querySelector('.nd-cal-pitch-debug');
        if (debugEl) {
            if (wiz.step === 5) {
                let expectNote = '—';
                if (wiz.autoCapture && wiz.autoCapture.kind === 'note' && wiz.autoCapture.noteId) {
                    const active = _calWizardFindNoteCheckSpec(wiz.autoCapture.noteId);
                    if (active) expectNote = active.expectedNote;
                }
                if (expectNote === '—') {
                    const noteSpecs = _calWizardResolveNoteChecks({ mode: 'quick' });
                    const primary = noteSpecs[0];
                    if (primary) expectNote = primary.expectedNote;
                }
                if (snap.heardConfidencePct != null) {
                    let line = `Expected: ${expectNote} · Heard: ${snap.rawHeardNote ?? '—'}`;
                    if (snap.displayHeardNote && snap.displayHeardNote !== snap.rawHeardNote) {
                        line += ` · Display: ${snap.displayHeardNote}`;
                        const now = Date.now();
                        if (!wiz._lastPitchDbg || now - wiz._lastPitchDbg > 2000) {
                            console.debug('[cal-wizard] pitch', {
                                expected: expectNote,
                                raw: snap.rawHeardNote,
                                display: snap.displayHeardNote,
                                conf: snap.heardConfidencePct,
                                channel: snap.channel,
                            });
                            wiz._lastPitchDbg = now;
                        }
                    }
                    line += ` · Conf: ${snap.heardConfidencePct}% · Channel: ${snap.channel || '—'}`;
                    debugEl.textContent = line;
                    debugEl.classList.remove('hidden');
                } else {
                    debugEl.textContent = `Expected: ${expectNote} · Channel: ${snap.channel || '—'} · Live: `
                        + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct);
                    debugEl.classList.remove('hidden');
                }
            } else {
                debugEl.textContent = '';
                debugEl.classList.add('hidden');
            }
        }
        if (wiz.step === 5) {
            const rowCells = _calWizardEl.querySelectorAll('.nd-cal-all-row-result');
            if (rowCells.length) {
                const active = _calWizardActiveNoteCapture();
                const byId = {};
                _calWizardResolveNoteChecks({ mode: 'all' }).forEach((s) => { byId[s.id] = s; });
                rowCells.forEach((cell) => {
                    const id = cell.getAttribute('data-note-result');
                    if (active && active.id === id) {
                        cell.className = 'nd-cal-all-row-result text-cyan-300/90 text-[10px] text-right shrink-0';
                        cell.innerHTML = active.phase === 'countdown'
                            ? `Get ready… <strong class="text-white">${active.left}</strong>`
                            : 'Listening…';
                        return;
                    }
                    const spec = byId[id];
                    if (!spec) return;
                    const res = _calWizardNoteResultParts(spec);
                    cell.className = `nd-cal-all-row-result ${res.cls} text-[10px] text-right shrink-0`;
                    cell.textContent = res.txt;
                });
            }
        }
        const medEl = _calWizardEl.querySelector('.nd-cal-timing-median');
        if (medEl) {
            const t = wiz.timing;
            const m = t && Number.isFinite(t.medianMs) ? t.medianMs : snap.timingMedianMs;
            const n = t && t.sampleCount ? t.sampleCount : 0;
            medEl.textContent = Number.isFinite(m)
                ? `Your average timing vs chart: ${_ndFormatMs(m)} · ${n} hit samples`
                : `Your average timing vs chart: not enough hits yet (${n} samples)`;
        }
    }

    function _calWizardReviewChanges(wiz) {
        const rec = wiz.recommended || {};
        const changes = [];
        const consider = (key, label, curVal, recVal, fmt, reason) => {
            if (!Number.isFinite(recVal)) return;
            if (Number.isFinite(curVal) && Math.abs(recVal - curVal) < 0.004) return;
            changes.push({ key, label, curVal, recVal, fmt, reason: reason || '' });
        };
        consider('inputGain', 'Input gain', inputGain, rec.inputGain,
            _calWizardFmtGain, rec.reasons && rec.reasons.inputGain);
        consider('latencyOffset', 'Detection delay', latencyOffset, rec.latencyOffset,
            _calWizardFmtLatencyMs, rec.reasons && rec.reasons.latencyOffset);
        return changes;
    }

    function _calWizardReviewSummaryHtml(wiz, opts = {}) {
        const showCheckboxes = opts.showCheckboxes !== false;
        const onlyChecked = !!opts.onlyChecked;
        const changes = _calWizardReviewChanges(wiz);
        const visible = onlyChecked
            ? changes.filter((c) => wiz.applyChecked[c.key] !== false)
            : changes;
        if (!visible.length) {
            if (onlyChecked && changes.length) {
                return '<p class="text-sm text-gray-300 mb-3">No settings are selected to apply. Go back to Review to check items, or finish without applying.</p>';
            }
            return '<p class="text-sm text-gray-300 mb-3">No safe setting changes recommended — you can finish without applying.</p>';
        }
        const cards = visible.map((c) => {
            const checked = wiz.applyChecked[c.key] !== false ? 'checked' : '';
            const chk = showCheckboxes
                ? `<input type="checkbox" class="nd-cal-apply-chk accent-green-400 mt-0.5 shrink-0" data-key="${c.key}" ${checked}>`
                : '';
            return `<div class="flex items-start gap-3 p-3 rounded-lg bg-dark-800/90 border border-gray-600">
                ${chk}
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-gray-100">${c.label}</div>
                    <div class="text-sm text-gray-300 mt-1">${c.fmt(c.curVal)} → <span class="text-green-300 font-mono font-medium">${c.fmt(c.recVal)}</span></div>
                </div>
            </div>`;
        }).join('');
        return `<div class="space-y-2 mb-3">${cards}</div>`;
    }

    function _calWizardReviewDetailsHtml(wiz) {
        const changes = _calWizardReviewChanges(wiz);
        if (!changes.length) return '';
        const rows = changes.map((c) => {
            const checked = wiz.applyChecked[c.key] !== false ? 'checked' : '';
            return `<tr class="border-b border-gray-700/50">
                <td class="py-1.5 pr-2 text-gray-300">${c.label}</td>
                <td class="py-1.5 text-gray-400 font-mono">${c.fmt(c.curVal)}</td>
                <td class="py-1.5 text-green-300/90 font-mono">${c.fmt(c.recVal)}</td>
                <td class="py-1.5 text-xs text-gray-400">${c.reason}</td>
                <td class="py-1.5"><input type="checkbox" class="nd-cal-apply-chk accent-green-400" data-key="${c.key}" ${checked}></td></tr>`;
        }).join('');
        return `<details class="mb-3">
            <summary class="text-sm text-gray-400 cursor-pointer hover:text-gray-200 py-1 select-none">Show technical details</summary>
            <table class="w-full text-xs mt-2"><thead><tr class="text-gray-500 text-left">
                <th class="py-1 pr-1">Setting</th><th class="pr-1">Current</th><th class="pr-1">Recommended</th><th class="pr-1">Reason</th><th>Apply</th>
            </tr></thead><tbody>${rows}</tbody></table>
        </details>`;
    }

    function renderCalibrationWizard() {
        if (!_calWizardEl || !_calWizardState) return;
        const body = _calWizardEl.querySelector('.nd-cal-body');
        const title = _calWizardEl.querySelector('.nd-cal-title');
        const backBtn = _calWizardEl.querySelector('.nd-cal-back');
        const nextBtn = _calWizardEl.querySelector('.nd-cal-next');
        if (!body || !title) return;
        const step = _calWizardState.step;
        const snap = getCalibrationSnapshot();
        const wiz = _calWizardState;
        const meta = _CAL_WIZARD_STEPS[step] || { title: 'Step' };
        title.textContent = `Calibration Wizard — ${meta.title}`;
        if (backBtn) backBtn.style.visibility = step > 0 && step < 8 ? 'visible' : 'hidden';
        if (nextBtn) {
            if (step >= 8) {
                nextBtn.style.display = 'none';
            } else {
                nextBtn.style.display = '';
                nextBtn.textContent = step === 7 ? 'Continue to Apply' : 'Next';
            }
        }
        if (step === 7) _calWizardBuildSafeRecommendations(wiz, snap);

        let html = '';
        if (step === 0) {
            html = `
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Calibration Wizard</strong> sets up your audio input, levels, and timing.</p>
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Technique Assessment</strong> (separate tool) checks how well specific playing techniques verify — bends, harmonics, palm mutes, and more.</p>
                <p class="text-gray-400 text-[10px] mb-2">This wizard may recommend <strong>input gain</strong> and <strong>detection delay (latency offset)</strong> only. It does not change scoring strictness, pitch windows, or detection thresholds.</p>
                <p class="text-gray-400 text-[10px]">Tip: turn <strong>Detect</strong> on before starting step 1.</p>`;
        } else if (step === 1) {
            const engineOk = snap.enabled && (usingDesktopBridge || audioCtx);
            const probeBusy = wiz.channelProbeRunning;
            const probeAmbiguous = wiz.channelProbeResult && wiz.channelProbeResult.ok === 'ambiguous';
            const probePickHtml = probeAmbiguous
                ? `<div class="flex flex-col gap-1 mt-2">
                    <button type="button" class="nd-cal-pick-channel w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-ch="0">Ch 1 — Dry / Clean</button>
                    <button type="button" class="nd-cal-pick-channel w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-ch="1">Ch 2 — Wet / FX</button>
                   </div>`
                : '';
            const probeResultBoxClass = 'nd-cal-channel-probe-result text-[11px] mt-2 p-2 rounded-lg border border-gray-600 bg-dark-800/90';
            const probeResultHtml = wiz.channelProbeResult
                ? `<div class="${probeResultBoxClass}">${_calWizardFormatChannelProbeResult(wiz.channelProbeResult)}${probePickHtml}</div>`
                : (wiz.channelProbeError
                    ? `<div class="${probeResultBoxClass} text-amber-200/90">${_ndEscapeHtml(wiz.channelProbeError)}</div>`
                    : '');
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Confirm which input channel Slopsmith is listening to. Strum while auto-detect runs.</p>
                <div class="text-[11px] text-gray-300 font-mono space-y-1 mb-2">
                    <div>Device: ${_calWizardDeviceLabel()}</div>
                    <div>Channel: ${snap.channel || '—'}</div>
                    <div>Detector: ${snap.source || '—'}</div>
                    <div>Engine: ${engineOk ? 'Running' : 'Not ready — enable Detect'}</div>
                </div>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <button type="button" class="nd-cal-auto-channel w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${probeBusy ? ' opacity-60 cursor-not-allowed' : ''}"${probeBusy ? ' disabled' : ''}>${probeBusy ? 'Detecting...' : 'Auto-detect Channel'}</button>
                <div class="nd-cal-channel-probe-status text-[11px] text-gray-400 mb-2 min-h-[1.5rem]">${probeBusy
                    ? '<span class="text-cyan-300/90">Testing Mono Mix (1 of 3)…</span>'
                    : 'Tests Mono Mix, Ch 1 (dry), and Ch 2 (wet) on the desktop audio engine.'}</div>
                ${probeResultHtml}
                <p class="text-[10px] text-gray-500 mb-1"><strong class="text-gray-400">Desktop:</strong> this step sets the native audio engine channel (saved automatically when a winner is found).</p>
                <p class="text-[10px] text-gray-500">The <strong>Input Channel</strong> dropdown below only applies to browser microphone fallback — not desktop audio.</p>
                <p class="text-[10px] text-amber-200/80">If stuck: check USB cable, interface gain, turn Detect on, and strum loudly during the test.</p>`;
        } else if (step === 2) {
            html = `
                <p class="text-gray-300 text-xs mb-2">Tune your guitar using the bottom <strong class="text-gray-200">Tuner</strong> panel.</p>
                <p class="text-[10px] text-gray-500 mb-2">The tuner opens automatically and hides this wizard. Tap <strong>Return to Calibration Wizard</strong> when done — or use <strong>Open Tuner</strong> below to reopen it.</p>
                <p class="text-[10px] text-amber-200/80">If notes miss often later: retune here before continuing.</p>
                <button type="button" class="nd-cal-open-tuner w-full mb-2 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200">Open Tuner</button>
                <div class="nd-cal-tuner-open-status text-[11px] mb-2 min-h-[1.5rem]"></div>
                <button type="button" class="nd-cal-tuned w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">I'm Tuned — Continue</button>`;
        } else if (step === 3) {
            const nDone = wiz.noise && wiz.noise.captured;
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Mute all strings and rest your hands on the strings. The wizard listens automatically after a short countdown.</p>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">${nDone
                    ? `Captured: avg ${wiz.noise.avgPct}% · peak ${wiz.noise.peakPct}% · ${_calWizardNoiseStatusDisplay(wiz.noise.status)}`
                    : 'Ready to measure room noise.'}</div>
                <button type="button" class="nd-cal-start-noise w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">${nDone ? 'Retry Noise Capture' : 'Start Noise Capture'}</button>
                <p class="text-[10px] text-gray-500">If <strong>Too noisy</strong>: lower input gain, move away from amps/fans, or try the dry (Ch 1) input.</p>`;
        } else if (step === 4) {
            const sDone = wiz.signal && wiz.signal.captured;
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Play your <strong class="text-gray-200">open low E</strong> at normal playing volume when prompted. Listening starts after the countdown.</p>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">${sDone
                    ? `Captured: avg ${wiz.signal.avgPct}% · peak ${wiz.signal.peakPct}% · ${_calWizardSignalStatusDisplay(wiz.signal.status)}`
                    : 'Ready to measure your playing level.'}</div>
                <button type="button" class="nd-cal-start-signal w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">${sDone ? 'Retry Signal Capture' : 'Start Signal Capture'}</button>
                <p class="text-[10px] text-gray-500">If <strong>Too low</strong>: raise interface gain or play closer to the mic/DI. If <strong>Too hot</strong>: lower gain to avoid clipping.</p>`;
        } else if (step === 5) {
            const noteSpecs = _calWizardResolveNoteChecks({ mode: 'quick' });

            const _calCtx = _calWizardResolveNoteCheckContext();
            const _instrOpts = _CAL_WIZARD_INSTRUMENT_CONFIGS.map((c) =>
                `<option value="${c.id}"${wiz.selectedInstrumentConfig === c.id ? ' selected' : ''}>${c.label}</option>`
            ).join('');
            const instrumentPickerHtml = _calCtx.hasTuning ? '' : `
                <div class="nd-cal-instrument-picker mb-2 p-2 bg-dark-700 rounded-lg border border-gray-700">
                    <label class="block text-[11px] text-gray-300 mb-1">Your instrument <span class="text-gray-500">(no song loaded)</span></label>
                    <select class="nd-cal-instrument-config w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200">
                        <option value="">— Auto (6-string guitar) —</option>
                        ${_instrOpts}
                    </select>
                    <p class="text-[9px] text-gray-500 mt-1">Pick a 4/5/6-string bass or 6/7/8-string guitar so the open-string targets match your instrument.</p>
                </div>`;
            const allStr = wiz.allStrings || _calWizardDefaultAllStringsState();
            const allRunning = !!allStr.running;
            const detailsOpen = !!(allStr.detailsOpen || allStr.running || allStr.complete || allStr.failedId);
            const noteRowHtml = (spec, compact) => {
                const res = _calWizardNoteResultParts(spec);
                const labelCls = compact ? 'text-[10px]' : 'text-xs';
                return `<div class="flex justify-between py-1 border-b border-gray-700/50 gap-2">
                    <span class="text-gray-300 ${labelCls}">${spec.label}</span>
                    <span class="${res.cls} text-[10px] text-right shrink-0">${res.txt}</span></div>`;
            };
            const noteRows = noteSpecs.map((spec) => noteRowHtml(spec, false)).join('');
            const noteButtons = noteSpecs.map((spec) =>
                `<button type="button" class="nd-cal-check-note w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-1" data-note="${spec.id}">Check ${spec.label}</button>`
            ).join('');
            const allBtnDisabled = allRunning ? ' disabled' : '';
            const allBtnDisabledCls = allRunning ? ' opacity-50 cursor-not-allowed' : '';

            const advancedSpecs = _calWizardResolveAdvancedStringChecks();
            const active = _calWizardActiveNoteCapture();
            const allRows = advancedSpecs.map((spec) => {
                let res;
                if (active && active.id === spec.id) {
                    res = active.phase === 'countdown'
                        ? { cls: 'text-cyan-300/90', txt: `Get ready… ${active.left}` }
                        : { cls: 'text-cyan-300/90', txt: 'Listening…' };
                } else {
                    res = _calWizardNoteResultParts(spec);
                }
                return `<div class="flex items-center gap-2 py-1 border-b border-gray-700/50">
                    <button type="button" class="nd-cal-check-note-all shrink-0 px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded text-[10px] text-gray-200${allBtnDisabledCls}" data-note="${spec.id}"${allBtnDisabled}>Check</button>
                    <span class="text-gray-300 text-[10px] flex-1 min-w-0">${spec.label}</span>
                    <span class="nd-cal-all-row-result ${res.cls} text-[10px] text-right shrink-0" data-note-result="${spec.id}">${res.txt}</span>
                </div>`;
            }).join('');
            let seqStatusHtml = '';
            if (allStr.message) {
                const seqCls = allStr.complete
                    ? 'text-green-300/90'
                    : allStr.failedId
                        ? 'text-amber-200/90'
                        : 'text-cyan-300/90';
                seqStatusHtml = `<p class="text-[10px] ${seqCls} mb-2">${allStr.message}</p>`;
            }
            const runBtnLabel = allRunning ? 'Checking…' : 'Check All Remaining Strings';
            const runBtnDisabled = allRunning ? ' disabled' : '';
            const runBtnCls = allRunning ? ' opacity-60 cursor-not-allowed' : '';
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Quick check that Slopsmith hears open strings. This is simpler than Technique Assessment — just confirms basic detection works.</p>
                <p class="text-[10px] text-gray-500 mb-2">Targets match the current song tuning. Use the same tone and pitch-shift path you will play the song with.</p>
                <p class="text-[10px] text-gray-500 mb-2">Load a song first for song tuning in the tuner.</p>
                ${instrumentPickerHtml}
                <div class="nd-cal-heard text-cyan-300/90 text-[10px] font-mono mb-2 h-[2rem] overflow-y-auto">Now hearing: —</div>
                <div class="nd-cal-pitch-debug text-[9px] text-gray-500 font-mono mb-1 hidden"></div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">—</div>
                <div class="mb-2">${noteRows}</div>
                ${noteButtons}
                <details class="nd-cal-all-strings mt-3 mb-2"${detailsOpen ? ' open' : ''}>
                    <summary class="text-sm text-gray-400 cursor-pointer hover:text-gray-200 py-1 select-none">Check remaining strings (advanced)</summary>
                    <p class="text-[10px] text-gray-500 mt-2 mb-2">Optional — verify the remaining open strings against song tuning. The two lowest are covered by the Open low / Open 2nd checks above. Not required to continue.</p>
                    <button type="button" class="nd-cal-run-all-strings w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${runBtnCls}"${runBtnDisabled}>${runBtnLabel}</button>
                    ${seqStatusHtml}
                    <div class="mb-2">${allRows}</div>
                </details>
                <p class="text-[10px] text-gray-500">If a check fails: retune, confirm the right input channel, raise gain slightly, and try the other channel (dry vs wet).</p>`;
        } else if (step === 6) {
            const t = wiz.timing;
            const liveMed = snap.timingMedianMs;
            const liveN = (snap.diagnostic && snap.diagnostic.timing_error_ms_hits)
                ? snap.diagnostic.timing_error_ms_hits.count : 0;
            const playAlongBusy = !!(wiz.playAlong);
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Play part of a song</strong> with Detect on so hits are scored. Tap <strong>Minimize Wizard — Play Song</strong> to reach the song highway (then <strong>Return to Calibration Wizard</strong> to come back), or <strong>Start Timed Play-Along Test</strong> for a clean ${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s sample window.</p>
                <p class="text-[10px] text-gray-500 mb-2">Use the speed you normally practice. This measures input vs chart alignment, not tempo.</p>
                <div class="nd-cal-timing-median text-gray-300 text-xs mb-2">Your average timing vs chart: —</div>
                <p class="text-[10px] text-gray-500 mb-2">Live session: ${Number.isFinite(liveMed) ? _ndFormatMs(liveMed) + ' average' : 'not enough hits yet'} · ${liveN} hit samples</p>
                <p class="text-[10px] text-gray-500 mb-2"><strong class="text-gray-400">Chart/video offset</strong> (main Settings) moves notes on screen. <strong class="text-gray-400">Detection delay</strong> (latency offset) moves when your playing is judged — this step helps tune detection delay.</p>
                <p class="text-[10px] text-amber-200/80">Mostly late? Detection delay may need increasing. Mostly early? Try lowering it.</p>
                ${wiz.timingCaptureNote ? `<p class="text-[10px] text-cyan-300/90 mb-2">${wiz.timingCaptureNote}</p>` : ''}
                <button type="button" class="nd-cal-start-playalong w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${playAlongBusy ? ' opacity-60 cursor-not-allowed' : ''}"${playAlongBusy ? ' disabled' : ''}>Start Timed Play-Along Test (${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s)</button>
                <button type="button" class="nd-cal-minimize-play w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Minimize Wizard — Play Song</button>
                <button type="button" class="nd-cal-reset-timing w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Reset Timing Samples</button>
                <button type="button" class="nd-cal-capture-timing w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">Capture Timing Snapshot</button>
                ${t && t.captured ? `<p class="text-[10px] text-green-300/90">Stored: ${_ndFormatMs(t.medianMs)} · ${t.sampleCount} samples</p>` : ''}`;
        } else if (step === 7) {
            html = `
                <p class="text-sm text-gray-200 mb-3">Review safe recommendations. Uncheck anything you do not want applied.</p>
                ${_calWizardReviewSummaryHtml(wiz, { showCheckboxes: true })}
                ${_calWizardReviewDetailsHtml(wiz)}
                <p class="text-xs text-gray-500 mt-2"><strong class="text-gray-400">Never changed by this wizard:</strong> pitch tolerance, timing tolerance, chord leniency, clean timing/pitch thresholds, harmonic SNR, note verifier / scoring thresholds</p>`;
        } else if (step === 8) {
            if (wiz.complete) {
                html = _calWizardCompletionHtml(wiz);
            } else {
                html = `
                <p class="text-base font-medium text-gray-100 mb-3">Ready to apply recommended calibration settings.</p>
                ${_calWizardReviewSummaryHtml(wiz, { showCheckboxes: false, onlyChecked: true })}
                <p class="text-sm text-gray-400 mb-4">Apply updates input gain and/or detection delay only. Scoring strictness and detection thresholds are not changed.</p>
                <button type="button" class="nd-cal-apply-safe w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-sm font-bold text-white mb-3 shadow-lg">Apply Recommended Settings</button>
                <button type="button" class="nd-cal-finish-no-apply w-full py-2.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300">Finish Without Applying</button>`;
            }
        }
        body.innerHTML = html;

        const openTuner = body.querySelector('.nd-cal-open-tuner');
        if (openTuner) {
            openTuner.onclick = () => { _calWizardOpenTunerFromWizard(); };
        }
        const tunedBtn = body.querySelector('.nd-cal-tuned');
        if (tunedBtn) {
            tunedBtn.onclick = () => {
                _calWizardReleaseTuner();
                calibrationWizardNext();
            };
        }

        const startNoise = body.querySelector('.nd-cal-start-noise');
        if (startNoise) startNoise.onclick = () => _calWizardStartNoiseCapture();

        const startSignal = body.querySelector('.nd-cal-start-signal');
        if (startSignal) startSignal.onclick = () => _calWizardStartSignalCapture();

        const autoChannel = body.querySelector('.nd-cal-auto-channel');
        if (autoChannel) {
            autoChannel.onclick = () => {
                if (_calWizardState && _calWizardState.channelProbeRunning) {
                    _calWizardSetChannelProbeStatus(
                        '<span class="text-amber-200/90">Detection already in progress...</span>');
                    return;
                }
                _calWizardAutoDetectInputChannel();
            };
        }

        body.querySelectorAll('.nd-cal-pick-channel').forEach((btn) => {
            btn.onclick = () => {
                const ch = parseInt(btn.getAttribute('data-ch'), 10);
                if (Number.isFinite(ch)) _calWizardApplyChannelProbeUserPick(ch);
            };
        });

        body.querySelectorAll('.nd-cal-check-note').forEach((btn) => {
            btn.onclick = () => {
                const id = btn.getAttribute('data-note');
                if (id) _calWizardStartNoteCapture(id);
            };
        });

        body.querySelectorAll('.nd-cal-check-note-all').forEach((btn) => {
            btn.onclick = () => {
                if (_calWizardState && _calWizardState.allStrings && _calWizardState.allStrings.running) return;
                const id = btn.getAttribute('data-note');
                if (id) _calWizardStartNoteCapture(id);
            };
        });

        const runAllStrings = body.querySelector('.nd-cal-run-all-strings');
        if (runAllStrings) {
            runAllStrings.onclick = () => {
                if (_calWizardState && _calWizardState.allStrings && _calWizardState.allStrings.running) return;
                _calWizardStartAllStringsRun();
            };
        }

        const instrSelect = body.querySelector('.nd-cal-instrument-config');
        if (instrSelect) {
            instrSelect.onchange = () => {
                if (_calWizardState) {

                    _calWizardStopAllStringsRun('switch');
                    _calWizardStopAutoCapture();
                    _calWizardState.selectedInstrumentConfig = instrSelect.value || null;

                    _calWizardState.allStrings = _calWizardDefaultAllStringsState();
                    _calWizardState.notes = {};
                }
                renderCalibrationWizard();
            };
        }

        const resetTiming = body.querySelector('.nd-cal-reset-timing');
        if (resetTiming) {
            resetTiming.onclick = () => {
                _calWizardStopTimedPlayAlong('reset');
                try { _resetCalibrationSamples(); } catch (e) { console.warn('[note_detect] resetCalibrationSamples:', e); }
                wiz.timing = null;
                wiz.timingCaptureNote = null;
                _calWizardRefreshLive();
                renderCalibrationWizard();
            };
        }
        const capTiming = body.querySelector('.nd-cal-capture-timing');
        if (capTiming) {
            capTiming.onclick = () => {
                wiz.timingCaptureNote = null;
                _calWizardCaptureTimingSnapshot();
            };
        }

        const startPlayAlong = body.querySelector('.nd-cal-start-playalong');
        if (startPlayAlong) {
            startPlayAlong.onclick = () => _calWizardStartTimedPlayAlong(_CAL_WIZARD_TIMED_PLAYALONG_SEC);
        }

        const minimizePlay = body.querySelector('.nd-cal-minimize-play');
        if (minimizePlay) {
            minimizePlay.onclick = () => {
                _calWizardStopTimedPlayAlong('manual-minimize');
                _calWizardMinimizeForPlayback();
            };
        }

        body.querySelectorAll('.nd-cal-apply-chk').forEach((chk) => {
            chk.onchange = () => {
                const key = chk.getAttribute('data-key');
                if (key) wiz.applyChecked[key] = chk.checked;
            };
        });

        const applyBtn = body.querySelector('.nd-cal-apply-safe');
        if (applyBtn) {
            applyBtn.onclick = () => {
                _calWizardApplySafeSettings(wiz);
                wiz.complete = 'applied';
                renderCalibrationWizard();
            };
        }
        const finishNo = body.querySelector('.nd-cal-finish-no-apply');
        if (finishNo) {
            finishNo.onclick = () => {
                wiz.complete = 'finished';
                wiz.applied = null;
                renderCalibrationWizard();
            };
        }

        const doneBtn = body.querySelector('.nd-cal-done');
        if (doneBtn) doneBtn.onclick = () => calibrationWizardClose();

        const runLabBtn = body.querySelector('.nd-cal-run-lab');
        if (runLabBtn) {
            runLabBtn.onclick = () => {
                calibrationWizardClose();
                try { openInstrumentCalibrationLab(); } catch (e) {
                    console.warn('[note_detect] openInstrumentCalibrationLab:', e);
                }
            };
        }

        if (step >= 1 && step <= 6) _calWizardRefreshLive();

        const enteredStep = wiz._autoEnterStep !== step;
        wiz._autoEnterStep = step;
        if (enteredStep && !wiz.complete && !wiz.tunerMinimized) {
            if (step === 2) {
                _calWizardOpenTunerFromWizard();
            }
        }
    }

    function calibrationWizardNext() {
        if (!_calWizardState) return;
        _calWizardStopAllStringsRun('next');
        _calWizardStopAutoCapture();
        if (_calWizardState.step === 2) {
            _calWizardReleaseTuner();
        } else if (_calWizardState.tunerMinimized) {
            _calWizardSetTunerMinimized(false);
        }
        if (_calWizardState.step >= 8) return;
        _calWizardState.step++;
        renderCalibrationWizard();
    }

    function calibrationWizardBack() {
        if (!_calWizardState || _calWizardState.step <= 0) return;
        _calWizardStopAllStringsRun('back');
        _calWizardStopAutoCapture();
        if (_calWizardState.tunerMinimized) _calWizardSetTunerMinimized(false);
        _calWizardState.step--;
        renderCalibrationWizard();
    }

    function openCalibrationWizard() {
        calibrationWizardClose();
        _calWizardState = _calWizardNewState();
        const overlay = document.createElement('div');
        overlay.className = 'nd-cal-wizard';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);pointer-events:auto;';
        overlay.innerHTML = `
            <button type="button" class="nd-cal-return-wizard bg-accent hover:bg-accent-light text-white shadow-2xl border-2 border-white/25" style="display:none;pointer-events:auto;position:fixed;left:50%;transform:translateX(-50%);bottom:120px;z-index:301;padding:16px 32px;border-radius:16px;max-width:calc(100vw - 2rem);text-align:center;cursor:pointer;">
                <span class="nd-cal-return-primary block text-sm font-bold leading-tight">Return to Calibration Wizard</span>
                <span class="nd-cal-return-secondary block text-[11px] font-normal opacity-90 mt-1">Tap here to continue setup</span>
            </button>
            <div class="nd-cal-wizard-card bg-dark-700 border border-gray-600 rounded-2xl shadow-2xl text-sm" style="width:24rem;max-width:calc(100vw - 2rem);max-height:calc(100vh - 3rem);display:flex;flex-direction:column;">
                <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                    <span class="nd-cal-title text-gray-200 font-semibold text-xs">Calibration Wizard</span>
                    <button type="button" class="nd-cal-close text-gray-500 hover:text-white text-lg leading-none" title="Close">&times;</button>
                </div>
                <div class="nd-cal-body px-4 py-3 overflow-y-auto flex-1 text-xs"></div>
                <div class="flex gap-2 px-4 py-3 border-t border-gray-700">
                    <button type="button" class="nd-cal-back flex-1 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300">Back</button>
                    <button type="button" class="nd-cal-next flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">Next</button>
                </div>
            </div>`;
        overlay.onclick = (e) => { if (e.target === overlay) calibrationWizardClose(); };
        overlay.querySelector('.nd-cal-close').onclick = () => calibrationWizardClose();
        overlay.querySelector('.nd-cal-back').onclick = () => calibrationWizardBack();
        overlay.querySelector('.nd-cal-next').onclick = () => calibrationWizardNext();
        const ret = overlay.querySelector('.nd-cal-return-wizard');
        if (ret) {
            ret.onclick = () => {
                if (_calWizardState && _calWizardState.playAlong) {
                    if (_calWizardState.playAlong.phase === 'waiting') {
                        _calWizardCancelTimedPlayAlongWaiting(
                            'Timed play-along cancelled — returned before playback started.');
                        return;
                    }
                    _calWizardFinishTimedPlayAlong(true);
                    return;
                }
                _calWizardSetTunerMinimized(false);
                _calWizardRefreshLive();
            };
        }
        document.body.appendChild(overlay);
        _calWizardEl = overlay;
        renderCalibrationWizard();
        _calWizardTick = setInterval(() => {
            if (!_calWizardEl || !_calWizardEl.isConnected) {
                calibrationWizardClose();
                return;
            }
            if (_calWizardState && !_calWizardState.tunerMinimized
                && _calWizardState.step >= 1 && _calWizardState.step <= 6) {
                _calWizardRefreshLive();
            }
        }, 200);
    }

    let _calLabEl = null;
    let _calLabTick = null;
    let _calLabState = null;
    let _calLabLastReport = null;

    const _CAL_LAB_FAIL = { SNR: 1, FUND: 2, PITCH: 4 };
    const _CAL_LAB_SCHEMA = 'note_detect.calibration_report.v1';
    const _CAL_LAB_MIN_CAPTURES = 3;
    const _CAL_LAB_POWER_CHORD_NOTES = [
        { s: 0, f: 0, role: 'root' },
        { s: 1, f: 2, role: 'fifth' },
    ];
    const _CAL_LAB_ADVANCED_ONLY_STEP_IDS = new Set([
        'picked', 'hammerOn', 'pullOff', 'palmMute',
        'naturalHarmonic', 'pinchHarmonic', 'halfBend', 'wholeBend', 'sustain',
    ]);
    const _CAL_LAB_BASIC_OPEN_ROWS = [
        { s: 0, f: 0, prompt: 'Play the thickest string open', btn: 'Capture thickest string' },
        { s: 1, f: 0, prompt: 'Play the next string open', btn: 'Capture next string' },
    ];
    const _CAL_LAB_BASIC_FRET_ROWS = [
        { s: 0, f: 5, prompt: 'Play the thickest string at the 5th fret', btn: 'Capture thickest string, 5th fret' },
    ];
    const _CAL_LAB_AUTO_NOISE_MS = 1800;
    const _CAL_LAB_AUTO_SIGNAL_MS = 2000;
    const _CAL_LAB_AUTO_PROBE_LISTEN_MS = 7000;
    const _CAL_LAB_AUTO_PROBE_INTERVAL_MS = 600;
    const _CAL_LAB_AUTO_PWR_LISTEN_MS = 8000;
    const _CAL_LAB_AUTO_PWR_INTERVAL_MS = 700;

    // Technique Assessment records diagnostics; it does not alter scoring thresholds.
    function _calLabDefaultAutoRun() {
        return {
            active: false,
            phase: 'idle',
            stepId: null,
            subIndex: 0,
            status: null,
            timerId: null,
            intervalId: null,
            inFlight: false,
            capturesThisRun: 0,
            startedAt: 0,
            listenEndsAt: 0,
            sessionId: 0,
        };
    }

    function _calLabEnsureAutoRun(st) {
        if (!st.autoRun) st.autoRun = _calLabDefaultAutoRun();
        return st.autoRun;
    }

    function _calLabStopAutoCapture(reason) {
        const st = _calLabState;
        if (!st) return;
        const ar = st.autoRun;
        if (!ar) return;
        if (ar.timerId != null) {
            clearTimeout(ar.timerId);
            ar.timerId = null;
        }
        if (ar.intervalId != null) {
            clearInterval(ar.intervalId);
            ar.intervalId = null;
        }
        ar.inFlight = false;
        if (ar.phase === 'countdown' || ar.phase === 'listening') {
            ar.phase = 'idle';
        }
        ar.active = false;
        if (reason) ar.status = reason;
    }

    function _calLabSetAutoStatus(html) {
        if (!_calLabEl) return;
        const el = _calLabEl.querySelector('.nd-cal-lab-auto-status');
        if (el) el.innerHTML = html;
    }

    function _calLabIsAutoBusy(st) {
        const ar = st && st.autoRun;
        return !!(ar && ar.active && (ar.phase === 'countdown' || ar.phase === 'listening'));
    }

    function _calLabBeginCountdownThen(seconds, label, callback) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        if (ar.timerId != null) clearTimeout(ar.timerId);
        ar.active = true;
        ar.phase = 'countdown';
        let left = seconds;
        const tick = () => {
            if (!_calLabState || _calLabState !== st || !ar.active) return;
            const n = left > 0 ? String(left) : 'Go!';
            _calLabSetAutoStatus(
                `<p class="text-gray-200 text-sm mb-1">${label}</p>`
                + `<p class="text-2xl font-bold text-white text-center py-2">${n}</p>`);
            if (left <= 0) {
                ar.timerId = null;
                ar.phase = 'listening';
                callback();
                return;
            }
            left -= 1;
            ar.timerId = setTimeout(tick, 1000);
        };
        tick();
    }

    function _calLabAvgLevelSamples(samples) {
        if (!samples || !samples.length) return { avg: null, peak: null };
        let sum = 0;
        let maxPeak = 0;
        for (const s of samples) {
            sum += s.level;
            if (s.peak > maxPeak) maxPeak = s.peak;
        }
        return { avg: Math.round(sum / samples.length), peak: maxPeak };
    }

    function _calLabRunLevelSampler(durationMs, onDone) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const sessionId = ar.sessionId;
        const samples = [];
        const started = Date.now();
        ar.startedAt = started;
        ar.listenEndsAt = started + durationMs;
        if (ar.intervalId != null) clearInterval(ar.intervalId);
        if (ar.timerId != null) clearTimeout(ar.timerId);
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (ar.intervalId != null) {
                clearInterval(ar.intervalId);
                ar.intervalId = null;
            }
            if (ar.timerId != null) {
                clearTimeout(ar.timerId);
                ar.timerId = null;
            }
            ar.inFlight = false;
            onDone(samples, sessionId);
        };
        const tick = () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            const snap = getCalibrationSnapshot();
            samples.push({ level: snap.inputLevelPct, peak: snap.inputPeakPct, t: Date.now() });
            const elapsed = Date.now() - started;
            _calLabSetAutoStatus(
                `<span class="text-cyan-300/90">Listening…</span> ${Math.round(elapsed / 1000)}s · `
                + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct));
            if (elapsed >= durationMs) finish();
        };
        tick();
        ar.intervalId = setInterval(tick, 120);
        ar.timerId = setTimeout(finish, durationMs + 250);
    }

    function _calLabProbeCountForStep(st, opts) {
        const { store, noteDef, technique, multiNotes } = opts;
        if (multiNotes) {
            return ((st.techniqueCaptures && st.techniqueCaptures[technique]) || []).length;
        }
        const caps = (st[store] && st[store][noteDef.s]) || [];
        return caps.length;
    }

    function _calLabStoreProbeCapture(st, opts, cap) {
        if (!cap || !cap.ok) return false;
        const { store, noteDef, technique, multiNotes } = opts;
        if (multiNotes) {
            if (!st.techniqueCaptures) st.techniqueCaptures = {};
            if (!st.techniqueCaptures[technique]) st.techniqueCaptures[technique] = [];
            st.techniqueCaptures[technique].push(cap);
            return true;
        }
        if (!st[store]) st[store] = {};
        if (!st[store][noteDef.s]) st[store][noteDef.s] = [];
        st[store][noteDef.s].push(cap);
        return true;
    }

    function _calLabRunProbeListenWindow(opts) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const sessionId = ar.sessionId;
        const listenMs = opts.listenMs || _CAL_LAB_AUTO_PROBE_LISTEN_MS;
        const intervalMs = opts.intervalMs || _CAL_LAB_AUTO_PROBE_INTERVAL_MS;
        const minCaptures = opts.minCaptures || _CAL_LAB_MIN_CAPTURES;
        ar.phase = 'listening';
        ar.active = true;
        ar.startedAt = Date.now();
        ar.listenEndsAt = ar.startedAt + listenMs;
        ar.capturesThisRun = 0;

        let ended = false;
        const endWindow = (reason) => {
            if (ended) return;
            ended = true;
            if (ar.intervalId != null) {
                clearInterval(ar.intervalId);
                ar.intervalId = null;
            }
            if (ar.timerId != null) {
                clearTimeout(ar.timerId);
                ar.timerId = null;
            }
            ar.inFlight = false;
            ar.active = false;
            ar.phase = reason === 'stop' ? 'idle' : 'done';
            if (opts.onComplete) opts.onComplete(reason);
        };

        const tryCapture = async () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            if (ar.inFlight || Date.now() >= ar.listenEndsAt) return;
            ar.inFlight = true;
            let cap;
            try {
                if (opts.multiNotes) {
                    cap = await _calLabCaptureMulti(opts.multiNotes, opts.technique);
                } else {
                    cap = await _calLabCaptureProbe(opts.noteDef, opts.technique || opts.store);
                }
            } catch (_) {
                cap = null;
            }
            ar.inFlight = false;
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId) return;
            if (_calLabStoreProbeCapture(st, opts, cap)) {
                ar.capturesThisRun = _calLabProbeCountForStep(st, opts);
            }
            const count = _calLabProbeCountForStep(st, opts);
            const shortLabel = opts.shortLabel || opts.label || 'check';
            _calLabSetAutoStatus(
                `<span class="text-cyan-300/90">${shortLabel}</span> — ${count} of ${minCaptures} captures`);
            if (opts.onProgress) opts.onProgress(count);
            if (count >= minCaptures) endWindow('enough');
        };

        const tick = () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            if (Date.now() >= ar.listenEndsAt) {
                endWindow('timeout');
                return;
            }
            tryCapture();
        };

        const count = _calLabProbeCountForStep(st, opts);
        _calLabSetAutoStatus(
            `<span class="text-cyan-300/90">${opts.shortLabel || opts.label}</span> — ${count} of ${minCaptures} captures`);
        tick();
        ar.intervalId = setInterval(tick, intervalMs);
        ar.timerId = setTimeout(() => endWindow('timeout'), listenMs + 300);
    }

    function _calLabBasicAutoControlsHtml(stepKey, startLabel, busy, showRetry) {
        const hideStart = busy ? 'hidden' : '';
        const hideStop = busy ? '' : 'hidden';
        const hideRetry = showRetry && !busy ? '' : 'hidden';
        return `<div class="nd-cal-lab-auto-controls flex flex-col gap-2 mb-2">
            <button type="button" class="nd-cal-lab-auto-start ${hideStart} w-full py-2.5 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white" data-auto-step="${stepKey}">${startLabel}</button>
            <button type="button" class="nd-cal-lab-auto-retry ${hideRetry} w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-auto-step="${stepKey}">Retry</button>
            <button type="button" class="nd-cal-lab-auto-stop ${hideStop} w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-amber-200/90" data-auto-step="${stepKey}">Stop</button>
        </div>`;
    }

    function _calLabUpdateBasicAutoButtons() {
        if (!_calLabEl || !_calLabState) return;
        const busy = _calLabIsAutoBusy(_calLabState);
        const start = _calLabEl.querySelector('.nd-cal-lab-auto-start');
        const retry = _calLabEl.querySelector('.nd-cal-lab-auto-retry');
        const stop = _calLabEl.querySelector('.nd-cal-lab-auto-stop');
        if (start) start.classList.toggle('hidden', busy);
        if (stop) stop.classList.toggle('hidden', !busy);
        if (retry) {
            const done = _calLabState.autoRun && _calLabState.autoRun.phase === 'done';
            retry.classList.toggle('hidden', busy || !done);
        }
        const nextBtn = _calLabEl.querySelector('.nd-cal-lab-next');
        if (nextBtn) nextBtn.disabled = busy;
    }

    function _calLabClearBasicOpenCaptures(st) {
        st.openCaptures = {};
    }

    function _calLabClearBasicFretCaptures(st) {
        st.fretCaptures = {};
    }

    function _calLabClearBasicPowerCaptures(st) {
        if (!st.techniqueCaptures) st.techniqueCaptures = {};
        st.techniqueCaptures.powerChord = [];
    }

    function _calLabStartNoiseAuto() {
        const st = _calLabState;
        if (!st) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'noise';
        ar.sessionId = Date.now();
        ar.active = true;
        _calLabBeginCountdownThen(3, 'Get ready: mute all strings', () => {
            _calLabSetAutoStatus('<span class="text-cyan-300/90">Listening for room noise…</span>');
            _calLabRunLevelSampler(_CAL_LAB_AUTO_NOISE_MS, (samples, sessionId) => {
                if (!_calLabState || _calLabState.autoRun.sessionId !== sessionId) return;
                const { avg, peak } = _calLabAvgLevelSamples(samples);
                if (!Number.isFinite(avg)) {
                    st.autoRun.phase = 'error';
                    st.autoRun.active = false;
                    _calLabSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
                    _calLabUpdateBasicAutoButtons();
                    return;
                }
                st.noiseLevelPct = avg;
                st.noisePeakPct = peak;
                st.autoRun.phase = 'done';
                st.autoRun.active = false;
                const resultEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-auto-result');
                if (resultEl) {
                    resultEl.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                }
                _calLabSetAutoStatus(
                    `<span class="text-green-300/90">Noise check complete:</span> `
                    + calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct));
                _calLabUpdateBasicAutoButtons();
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabStartSignalAuto() {
        const st = _calLabState;
        if (!st) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'signal';
        ar.sessionId = Date.now();
        ar.active = true;
        _calLabBeginCountdownThen(3, 'Get ready: play the thickest string loudly', () => {
            _calLabSetAutoStatus('<span class="text-cyan-300/90">Listening for playing level…</span>');
            _calLabRunLevelSampler(_CAL_LAB_AUTO_SIGNAL_MS, (samples, sessionId) => {
                if (!_calLabState || _calLabState.autoRun.sessionId !== sessionId) return;
                const { avg, peak } = _calLabAvgLevelSamples(samples);
                if (!Number.isFinite(avg)) {
                    st.autoRun.phase = 'error';
                    st.autoRun.active = false;
                    _calLabSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
                    _calLabUpdateBasicAutoButtons();
                    return;
                }
                st.signalLevelPct = avg;
                st.signalPeakPct = peak;
                st.autoRun.phase = 'done';
                st.autoRun.active = false;
                const resultEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-auto-result');
                if (resultEl) {
                    resultEl.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                }
                _calLabSetAutoStatus(
                    `<span class="text-green-300/90">Signal check complete:</span> `
                    + calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct));
                _calLabUpdateBasicAutoButtons();
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabRunOpenSubPrompt() {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const rows = _CAL_LAB_BASIC_OPEN_ROWS;
        if (ar.subIndex >= rows.length) {
            ar.phase = 'done';
            ar.active = false;
            _calLabSetAutoStatus('<span class="text-green-300/90">Open-string check complete.</span>');
            _calLabUpdateBasicAutoButtons();
            renderCalibrationLab();
            return;
        }
        const row = rows[ar.subIndex];
        const shortLabel = ar.subIndex === 0 ? 'Checking thickest string open' : 'Checking next string open';
        _calLabBeginCountdownThen(3, `Get ready: ${row.prompt}`, () => {
            _calLabRunProbeListenWindow({
                store: 'openCaptures',
                noteDef: { s: row.s, f: row.f },
                technique: 'openCaptures',
                label: row.prompt,
                shortLabel,
                listenMs: _CAL_LAB_AUTO_PROBE_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PROBE_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.subIndex += 1;
                    if (ar.subIndex < rows.length) {
                        _calLabRunOpenSubPrompt();
                    } else {
                        ar.phase = 'done';
                        ar.active = false;
                        _calLabSetAutoStatus('<span class="text-green-300/90">Open-string check complete.</span>');
                        _calLabUpdateBasicAutoButtons();
                        renderCalibrationLab();
                    }
                },
            });
        });
    }

    function _calLabStartOpenAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicOpenCaptures(st);
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'open';
        ar.sessionId = Date.now();
        ar.subIndex = 0;
        ar.active = true;
        _calLabRunOpenSubPrompt();
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabStartFretAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicFretCaptures(st);
        const row = _CAL_LAB_BASIC_FRET_ROWS[0];
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'fret5';
        ar.sessionId = Date.now();
        ar.subIndex = 0;
        ar.active = true;
        _calLabBeginCountdownThen(3, `Get ready: ${row.prompt}`, () => {
            _calLabRunProbeListenWindow({
                store: 'fretCaptures',
                noteDef: { s: row.s, f: row.f },
                technique: 'fretCaptures',
                label: row.prompt,
                shortLabel: 'Checking thickest string, 5th fret',
                listenMs: _CAL_LAB_AUTO_PROBE_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PROBE_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.phase = 'done';
                    ar.active = false;
                    _calLabSetAutoStatus('<span class="text-green-300/90">Fretted-note check complete.</span>');
                    _calLabUpdateBasicAutoButtons();
                    renderCalibrationLab();
                },
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabPowerChordTargetLabel() {

        let root = 'E2', fifth = 'B2', chord = 'E5';
        try {
            if (currentStringCount >= 2) {
                const rootMidi = _ndMidiFromStringFret(0, 0, currentArrangement, currentStringCount, tuningOffsets, capo);
                const fifthMidi = _ndMidiFromStringFret(1, 2, currentArrangement, currentStringCount, tuningOffsets, capo);
                if (Number.isFinite(rootMidi) && Number.isFinite(fifthMidi)) {
                    root = _ndMidiToName(rootMidi);
                    fifth = _ndMidiToName(fifthMidi);
                    const interval = (((fifthMidi - rootMidi) % 12) + 12) % 12;
                    chord = interval === 7 ? String(root).replace(/-?\d+$/, '') + '5' : null;
                }
            }
        } catch (_) {  }
        const lead = chord ? `the ${chord} power chord` : 'the power chord';
        const leadHtml = chord
            ? `the <strong class="text-gray-100">${chord}</strong> power chord`
            : 'the power chord';
        return { chord, root, fifth, lead, leadHtml };
    }

    function _calLabStartPowerChordAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicPowerCaptures(st);
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'powerChord';
        ar.sessionId = Date.now();
        ar.active = true;
        const pwr = _calLabPowerChordTargetLabel();
        _calLabBeginCountdownThen(3, `Get ready: play ${pwr.lead} (${pwr.root} open + next string 2nd fret = ${pwr.fifth})`, () => {
            _calLabRunProbeListenWindow({
                multiNotes: [{ s: 0, f: 0 }, { s: 1, f: 2 }],
                technique: 'powerChord',
                label: `Play ${pwr.lead}: ${pwr.root} open + ${pwr.fifth} (next string, 2nd fret)`,
                shortLabel: 'Power chord check',
                listenMs: _CAL_LAB_AUTO_PWR_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PWR_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onProgress: () => {
                    const diagEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-pwr-diag-live');
                    if (diagEl) diagEl.textContent = _calLabPowerChordSimpleDiagnosis(st);
                },
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.phase = 'done';
                    ar.active = false;
                    _calLabSetAutoStatus(
                        `<span class="text-green-300/90">Power chord check complete.</span> `
                        + _calLabPowerChordSimpleDiagnosis(st));
                    _calLabUpdateBasicAutoButtons();
                    renderCalibrationLab();
                },
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabRetryBasicAuto(stepKey) {
        if (stepKey === 'noise') _calLabStartNoiseAuto();
        else if (stepKey === 'signal') _calLabStartSignalAuto();
        else if (stepKey === 'open') _calLabStartOpenAuto(true);
        else if (stepKey === 'fret5') _calLabStartFretAuto(true);
        else if (stepKey === 'powerChord') _calLabStartPowerChordAuto(true);
    }

    function _calLabEffectivePitchTol(chartPitch, flags) {
        let cents = chartPitch;
        if (flags && (flags.b || flags.sl)) cents = Math.max(cents, 100);
        if (flags && flags.hm) cents = 0;
        return cents;
    }

    function _calLabTickFromResult(r, flags) {
        const harmonicSnr = _ND_VERIFY_HARMONIC_SNR;
        const snr = Number.isFinite(r && r.bandEnergy) ? r.bandEnergy : 0;
        const pitchTol = _calLabEffectivePitchTol(pitchTolerance, flags || {});
        const passedSnr = snr >= harmonicSnr;
        const passedFund = !!(r && r.fundamentalPresent);
        const absCents = (r && Number.isFinite(r.centsError)) ? Math.abs(r.centsError) : null;
        const passedPitch = pitchTol <= 0
            || (absCents != null && absCents <= pitchTol);
        const gatePassCount = (passedSnr ? 1 : 0) + (passedFund ? 1 : 0) + (passedPitch ? 1 : 0);
        let failedMask = 0;
        if (!passedSnr) failedMask |= _CAL_LAB_FAIL.SNR;
        if (!passedFund) failedMask |= _CAL_LAB_FAIL.FUND;
        if (!passedPitch) failedMask |= _CAL_LAB_FAIL.PITCH;
        const snrRatio = harmonicSnr > 0 ? snr / harmonicSnr : snr;
        return {
            snr,
            snrRatio,
            harmonicSnrUsed: harmonicSnr,
            fundamentalRatio: Number.isFinite(r && r.fundamentalRatio) ? r.fundamentalRatio : null,
            centsError: Number.isFinite(r && r.centsError) ? r.centsError : null,
            absCentsError: absCents,
            passedSnr,
            passedFundamental: passedFund,
            passedPitch,
            gatePassCount,
            failedGateMask: failedMask,
            hit: !!(r && r.hit),
        };
    }

    function _calLabMedian(arr) {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function _calLabAvg(arr) {
        return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    }

    function _calLabPowerChordDisplayString(stringIndex) {
        return currentStringCount - stringIndex;
    }

    function _calLabPowerChordNoteMeta(stringIndex, fret) {
        const def = _CAL_LAB_POWER_CHORD_NOTES.find((n) => n.s === stringIndex && n.f === fret);
        const disp = _calLabPowerChordDisplayString(stringIndex);
        let label;
        if (def && def.role === 'root') label = 'thickest string (root)';
        else if (def && def.role === 'fifth') label = 'next string (fifth)';
        else label = `String ${disp}`;
        let expectedNote = '—';
        try {
            const midi = _ndMidiFromStringFret(
                stringIndex, fret, currentArrangement, currentStringCount, tuningOffsets, capo);
            if (Number.isFinite(midi)) expectedNote = _ndMidiToName(midi);
        } catch (_) {  }
        return {
            label,
            role: def ? def.role : null,
            expectedNote,
            string: stringIndex,
            fret,
        };
    }

    function _calLabPowerChordNotePass(noteTick) {
        return !!(noteTick && (noteTick.hit || noteTick.gatePassCount === 3));
    }

    function _calLabPowerChordHeardNote(noteTick) {
        if (!noteTick || !Number.isFinite(noteTick.centsError)) return '—';
        try {
            const expectedMidi = _ndMidiFromStringFret(
                noteTick.string, noteTick.fret, currentArrangement, currentStringCount, tuningOffsets, capo);
            if (!Number.isFinite(expectedMidi)) return '—';
            return _ndMidiToName(expectedMidi + noteTick.centsError / 100);
        } catch (_) {
            return '—';
        }
    }

    function _calLabPowerChordNoteRowHtml(noteTick) {
        if (!noteTick) return '';
        const meta = _calLabPowerChordNoteMeta(noteTick.string, noteTick.fret);
        const clarity = Number.isFinite(noteTick.snrRatio) ? noteTick.snrRatio.toFixed(2) : '—';
        const heard = _calLabPowerChordHeardNote(noteTick);
        const chips = _calLabGateChipsHtml(noteTick);
        const passCls = _calLabPowerChordNotePass(noteTick)
            ? 'text-green-300/90' : 'text-amber-200/90';
        return `<div class="py-1 border-b border-gray-700/40">
            <div class="flex justify-between gap-2 text-[10px]">
                <span class="text-gray-300">${meta.label}</span>
                <span class="${passCls} shrink-0">${_calLabPowerChordNotePass(noteTick) ? 'pass' : 'fail'}</span>
            </div>
            <div class="text-[9px] text-gray-500">Expected ${meta.expectedNote} · heard ${heard} · clarity ${clarity}</div>
            ${chips ? `<div class="mt-0.5">${chips}</div>` : ''}
        </div>`;
    }

    function _calLabPowerChordCaptureBlockHtml(cap, index) {
        if (!cap || !cap.ok || !Array.isArray(cap.notes)) {
            return `<div class="text-[10px] text-amber-200/90 py-1">Capture ${index + 1}: probe failed</div>`;
        }
        const rows = cap.notes.map((n) => _calLabPowerChordNoteRowHtml(n)).join('');
        const batch = cap.batchHit
            ? '<span class="text-green-300/90">batch hit</span>'
            : '<span class="text-amber-200/90">batch miss</span>';
        return `<div class="mb-2 p-2 bg-dark-800/50 rounded border border-gray-700/40">
            <div class="text-[10px] text-gray-400 mb-1">Capture ${index + 1} · ${batch}</div>
            ${rows}
        </div>`;
    }

    function _calLabSummarizePowerChordRole(caps, role) {
        const def = _CAL_LAB_POWER_CHORD_NOTES.find((n) => n.role === role);
        if (!def) {
            return { role, n: 0, passRate: null, dominantFailure: null, failCounts: { SNR: 0, FUND: 0, PITCH: 0 } };
        }
        let passes = 0;
        let total = 0;
        const failCounts = { SNR: 0, FUND: 0, PITCH: 0 };
        for (const cap of caps) {
            if (!cap || !cap.ok || !Array.isArray(cap.notes)) continue;
            const note = cap.notes.find((n) => n.string === def.s && n.fret === def.f);
            if (!note) continue;
            total++;
            if (_calLabPowerChordNotePass(note)) passes++;
            if (note.failedGateMask & _CAL_LAB_FAIL.SNR) failCounts.SNR++;
            if (note.failedGateMask & _CAL_LAB_FAIL.FUND) failCounts.FUND++;
            if (note.failedGateMask & _CAL_LAB_FAIL.PITCH) failCounts.PITCH++;
        }
        let dominantFailure = null;
        let maxF = 0;
        for (const [k, v] of Object.entries(failCounts)) {
            if (v > maxF) { maxF = v; dominantFailure = k; }
        }
        return {
            role,
            string: def.s,
            fret: def.f,
            label: _calLabPowerChordNoteMeta(def.s, def.f).label,
            expectedNote: _calLabPowerChordNoteMeta(def.s, def.f).expectedNote,
            n: total,
            passRate: total > 0 ? passes / total : null,
            dominantFailure,
            failCounts,
        };
    }

    function _calLabSummarizePowerChordCaptures(caps) {
        const list = caps || [];
        const root = _calLabSummarizePowerChordRole(list, 'root');
        const fifth = _calLabSummarizePowerChordRole(list, 'fifth');
        const aggregate = _calLabSummarizeCaptures(list);
        return {
            ...aggregate,
            root,
            fifth,
            likelyCause: _calLabPowerChordLikelyCause({ root, fifth }),
        };
    }

    function _calLabPowerChordLikelyCause(ps) {
        if (!ps || !ps.root || !ps.fifth) return null;
        const rootRate = ps.root.passRate;
        const fifthRate = ps.fifth.passRate;
        if (rootRate == null && fifthRate == null) return null;
        const rootOk = rootRate != null && rootRate >= 0.5;
        const fifthOk = fifthRate != null && fifthRate >= 0.5;
        if (rootOk && !fifthOk) {
            if (ps.fifth.dominantFailure === 'FUND') {
                return 'Root verifies, fifth fails fundamental: distorted tone may be hiding the fifth\'s fundamental.';
            }
            if (ps.fifth.dominantFailure === 'PITCH') {
                return 'Root verifies, fifth fails pitch: tuning or pitch-shift path may not match the song.';
            }
            return 'Root verifies, fifth fails: likely masking, wet distortion, or chord voicing issue.';
        }
        if (!rootOk && fifthOk) {
            return 'Fifth verifies, root fails: low-string clarity or fundamental may be weak — check gain, palm muting, or low-string coupling.';
        }
        if (!rootOk && !fifthOk) {
            if (ps.root.dominantFailure === 'SNR' && ps.fifth.dominantFailure === 'SNR') {
                return 'Both strings fail clarity: signal may be too noisy/wet or wrong channel.';
            }
            if (ps.root.dominantFailure === 'FUND' || ps.fifth.dominantFailure === 'FUND') {
                return 'Fundamental fails: distorted tone may be hiding the fundamental.';
            }
            if (ps.root.dominantFailure === 'PITCH' || ps.fifth.dominantFailure === 'PITCH') {
                return 'Pitch fails: tuning or pitch-shift path may not match the song.';
            }
            return 'Both strings struggle to verify: check input channel, gain, and tone path.';
        }
        if (rootOk && fifthOk) {
            return 'Root and fifth both verify in probes — gameplay chord misses may be timing, chart voicing, or a different detector path.';
        }
        return null;
    }

    function _calLabPowerChordSimpleDiagnosis(st) {
        const caps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const sum = _calLabSummarizePowerChordCaptures(caps);
        if (!sum.n) return 'No captures yet — press Capture while playing both strings.';
        const rootOk = sum.root.passRate != null && sum.root.passRate >= 0.5;
        const fifthOk = sum.fifth.passRate != null && sum.fifth.passRate >= 0.5;
        if (rootOk && fifthOk) {
            return 'Power chord: root and fifth both heard in probes.';
        }
        if (rootOk && !fifthOk) {
            return 'Power chord: root heard, fifth not heard. Try the dry/clean channel to compare.';
        }
        if (!rootOk && fifthOk) {
            return 'Power chord: fifth heard, root not heard. Check gain and low-string clarity.';
        }
        if (sum.root.dominantFailure === 'SNR' && sum.fifth.dominantFailure === 'SNR') {
            return 'Both strings failed signal clarity. Your signal may be too quiet, noisy, or on the wrong channel.';
        }
        if (sum.root.dominantFailure === 'FUND' || sum.fifth.dominantFailure === 'FUND') {
            return 'The main note is missing. Distortion may be hiding it.';
        }
        if (sum.likelyCause) return sum.likelyCause;
        return 'Power chord root/fifth check did not pass. Try the dry/clean channel to compare.';
    }

    function _calLabFormatPowerChordSum(st) {
        const caps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const sum = _calLabSummarizePowerChordCaptures(caps);
        if (!sum.n) return 'No captures yet — press Capture while playing.';
        const rootPct = sum.root.passRate != null ? Math.round(sum.root.passRate * 100) : '—';
        const fifthPct = sum.fifth.passRate != null ? Math.round(sum.fifth.passRate * 100) : '—';
        const rootWeak = _calLabDominantFailLabel(sum.root.dominantFailure);
        const fifthWeak = _calLabDominantFailLabel(sum.fifth.dominantFailure);
        let line = `${sum.n} captures · root pass ${rootPct}% · fifth pass ${fifthPct}%`
            + ` · root weakest: ${rootWeak} · fifth weakest: ${fifthWeak}`;
        if (sum.likelyCause) line += ` · ${sum.likelyCause}`;
        return line;
    }

    function _calLabMusicianStringRowLabel(s, fret, stringName) {
        if (s === 0 && fret === 0) return 'thickest string, open';
        if (s === 1 && fret === 0) return 'next string, open';
        if (s === 0 && fret === 5) return 'thickest string, 5th fret';
        const fretTxt = fret === 0 ? 'open' : `fret ${fret}`;
        return `${stringName || 'string'} · ${fretTxt}`;
    }

    function _calLabBuildSimpleReportBullets(rep) {
        const bullets = [];
        bullets.push('This report did not change gameplay settings.');
        const hw = rep.hardware || {};
        if (Number.isFinite(hw.noise_level_pct) && hw.noise_level_pct >= 5) {
            bullets.push('Your signal is quiet or noisy — check room noise and input gain.');
        }
        if (Number.isFinite(hw.signal_level_pct) && hw.signal_level_pct < 5) {
            bullets.push('Your playing level looks low — try playing louder or raising input gain.');
        }
        let fundFails = 0;
        for (const t of (rep.per_technique || [])) {
            if (!t.summary || !t.summary.failCounts) continue;
            fundFails += t.summary.failCounts.FUND || 0;
        }
        for (const ps of (rep.per_string || [])) {
            if (ps.open && ps.open.summary && ps.open.summary.failCounts) {
                fundFails += ps.open.summary.failCounts.FUND || 0;
            }
            if (ps.fret5 && ps.fret5.summary && ps.fret5.summary.failCounts) {
                fundFails += ps.fret5.summary.failCounts.FUND || 0;
            }
        }
        if (fundFails >= 2) {
            bullets.push('The main note is missing on several tests. Distortion may be hiding it.');
        }
        const pwr = rep.power_chord_diagnostics;
        if (pwr && pwr.root && pwr.fifth) {
            const rootOk = pwr.root.passRate != null && pwr.root.passRate >= 0.5;
            const fifthOk = pwr.fifth.passRate != null && pwr.fifth.passRate >= 0.5;
            if (!rootOk || !fifthOk) {
                bullets.push('Power chord root/fifth check did not fully pass.');
            }
            if (pwr.likely_cause) {
                bullets.push(pwr.likely_cause);
            }
            if (!rootOk || !fifthOk) {
                bullets.push('Try the dry/clean channel to compare against a wet tone.');
            }
        }
        if (bullets.length === 1) {
            bullets.push('No major issues detected from your captures — review details if something still feels off.');
        }
        return bullets;
    }

    function _calLabBuildPowerChordReportSummary(caps) {
        const sum = _calLabSummarizePowerChordCaptures(caps || []);
        const snap = getCalibrationSnapshot();
        let detectorPath = null;
        try {
            if (_diagDetector && _diagDetector.path) detectorPath = _diagDetector.path;
            else if (_ndUsingEngineVerifier) detectorPath = 'desktop-engine-verifier';
        } catch (_) {  }
        return {
            root: sum.root,
            fifth: sum.fifth,
            likely_cause: sum.likelyCause,
            input_channel: snap.channel || selectedChannel,
            detector_path: detectorPath,
            aggregate: {
                n: sum.n,
                hitRate: sum.hitRate,
                medianSnrRatio: sum.medianSnrRatio,
                dominantFailure: sum.dominantFailure,
            },
        };
    }

    function _calLabCanProbe() {
        return !!(enabled && usingDesktopBridge && _ndBridgeScoreAvailable());
    }

    async function _calLabRunScoreProbe(notes) {
        if (!_calLabCanProbe()) return null;
        const ctx = {
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            offsets: tuningOffsets.slice(0, currentStringCount),
            capo,
            pitchCheckCents: pitchTolerance,
            minHitRatio: chordHitRatio,
            bypassMl: true,
            harmonicVerify: true,
            harmonicSnr: _ND_VERIFY_HARMONIC_SNR,
            notes: notes.map((n) => ({
                s: n.s,
                f: n.f,
                ho: !!n.ho,
                po: !!n.po,
                b: !!n.b,
                sl: !!n.sl,
                hm: !!n.hm,
            })),
        };
        try {
            return await _ndBridgeScoreChord(ctx);
        } catch (e) {
            console.warn('[note_detect] cal lab scoreChord:', e);
            return null;
        }
    }

    async function _calLabCaptureProbe(noteDef, technique) {
        const batch = await _calLabRunScoreProbe([noteDef]);
        if (!batch || !Array.isArray(batch.results) || !batch.results.length) {
            return { ok: false, error: 'probe_failed' };
        }
        const r = batch.results[0];
        const flags = {
            ho: !!noteDef.ho, po: !!noteDef.po,
            b: !!noteDef.b, sl: !!noteDef.sl, hm: !!noteDef.hm,
        };
        const tick = _calLabTickFromResult(r, flags);
        return {
            ok: true,
            at: Date.now(),
            technique: technique || null,
            string: noteDef.s,
            fret: noteDef.f,
            flags,
            ...tick,
        };
    }

    async function _calLabCaptureMulti(notes, technique) {
        const batch = await _calLabRunScoreProbe(notes);
        if (!batch || !Array.isArray(batch.results)) return { ok: false, error: 'probe_failed' };
        const perNote = batch.results.map((r, i) => {
            const nd = notes[i] || { s: r.s, f: r.f };
            const flags = {
                ho: !!nd.ho, po: !!nd.po,
                b: !!nd.b, sl: !!nd.sl, hm: !!nd.hm,
            };
            return { string: nd.s, fret: nd.f, ..._calLabTickFromResult(r, flags) };
        });
        return {
            ok: true,
            at: Date.now(),
            technique: technique || null,
            notes: perNote,
            batchHit: !!batch.isHit,
        };
    }

    function _calLabCaptureTicks(capture) {
        if (capture && Array.isArray(capture.notes) && capture.notes.length) {
            return capture.notes.map((n) => ({
                snrRatio: n.snrRatio,
                gatePassCount: n.gatePassCount,
                failedGateMask: n.failedGateMask,
                hit: n.hit,
            }));
        }
        return [{
            snrRatio: capture && capture.snrRatio,
            gatePassCount: capture && capture.gatePassCount,
            failedGateMask: capture && capture.failedGateMask,
            hit: capture && capture.hit,
        }];
    }

    function _calLabCaptureHit(capture) {
        if (capture && Array.isArray(capture.notes) && capture.notes.length) {
            if (capture.batchHit) return true;
            return capture.notes.every((n) => n.hit || n.gatePassCount === 3);
        }
        return !!(capture && (capture.hit || capture.gatePassCount === 3));
    }

    function _calLabSummarizeTicks(ticks, captureCount, hitRate) {
        const ratios = ticks.map((t) => t.snrRatio).filter(Number.isFinite);
        const gates = ticks.map((t) => t.gatePassCount).filter(Number.isFinite);
        const masks = ticks.map((t) => t.failedGateMask | 0);
        const failCounts = { SNR: 0, FUND: 0, PITCH: 0 };
        for (const m of masks) {
            if (m & _CAL_LAB_FAIL.SNR) failCounts.SNR++;
            if (m & _CAL_LAB_FAIL.FUND) failCounts.FUND++;
            if (m & _CAL_LAB_FAIL.PITCH) failCounts.PITCH++;
        }
        let dominantFailure = null;
        let maxF = 0;
        for (const [k, v] of Object.entries(failCounts)) {
            if (v > maxF) { maxF = v; dominantFailure = k; }
        }
        return {
            n: captureCount,
            avgSnrRatio: _calLabAvg(ratios),
            medianSnrRatio: _calLabMedian(ratios),
            bestSnrRatio: ratios.length ? Math.max(...ratios) : null,
            minSnrRatio: ratios.length ? Math.min(...ratios) : null,
            avgGatePassCount: _calLabAvg(gates),
            hitRate,
            dominantFailure,
            failCounts,
        };
    }

    function _calLabSummarizeCaptures(captures) {
        const caps = captures || [];
        const ticks = caps.flatMap((c) => _calLabCaptureTicks(c));
        const hitRate = caps.length
            ? caps.filter((c) => _calLabCaptureHit(c)).length / caps.length
            : null;
        return _calLabSummarizeTicks(ticks, caps.length, hitRate);
    }

    function _calLabSummarizeSustainSeries(series) {
        const samples = series || [];
        const ticks = samples.map((s) => ({
            snrRatio: s.snrRatio,
            gatePassCount: s.gatePassCount,
            failedGateMask: s.failedGateMask,
        }));
        const hitRate = samples.length
            ? samples.filter((s) => s.gatePassCount === 3).length / samples.length
            : null;
        return _calLabSummarizeTicks(ticks, samples.length, hitRate);
    }

    function _calLabBuildRecommendations(report) {
        const rec = [];
        const thr = report.settings && report.settings.harmonic_snr_used;
        for (const t of (report.per_technique || [])) {
            if (!t.summary || !t.summary.n) continue;
            const med = t.summary.medianSnrRatio;
            const dom = t.summary.dominantFailure;
            if (Number.isFinite(med) && thr && med < 0.9 && dom === 'SNR') {
                rec.push(`${t.label}: SNR frequently weak (median ratio ${med.toFixed(2)} vs threshold ${thr}).`);
            } else if (Number.isFinite(med) && thr && med < 1.0 && dom === 'SNR') {
                rec.push(`${t.label}: SNR often below threshold (median ratio ${med.toFixed(2)}).`);
            }
            if (dom === 'FUND' && (t.summary.failCounts.FUND || 0) >= 2) {
                rec.push(`${t.label}: fundamental gate failures common on best-frame probes.`);
            }
            if (dom === 'PITCH' && (t.summary.failCounts.PITCH || 0) >= 2) {
                rec.push(`${t.label}: pitch gate failures observed (may include bend travel).`);
            }
        }
        for (const s of (report.per_string || [])) {
            if (!s.open || !s.open.summary || !s.open.summary.n) continue;
            const med = s.open.summary.medianSnrRatio;
            if (Number.isFinite(med) && med < 0.85) {
                rec.push(`String ${s.string} open: weak SNR (median ratio ${med.toFixed(2)}).`);
            }
        }
        if (report.hardware && Number.isFinite(report.hardware.noise_level_pct)
            && report.hardware.noise_level_pct >= 5) {
            rec.push('Noise floor looks elevated — check room noise or input gain.');
        }
        if (report.hardware && Number.isFinite(report.hardware.signal_level_pct)
            && report.hardware.signal_level_pct < 5) {
            rec.push('Signal level looks low — increase interface gain or play louder.');
        }
        const halfCaps = ((report.per_technique || []).find((t) => t.id === 'halfBend') || {}).captures || [];
        const wholeCaps = ((report.per_technique || []).find((t) => t.id === 'wholeBend') || {}).captures || [];
        if (halfCaps.length || wholeCaps.length) {
            rec.push('Half bends and whole bends currently use the same native bend probe; compare results as labeled technique captures, not distinct detector modes.');
        }
        const pwrDiag = report.power_chord_diagnostics;
        if (pwrDiag && pwrDiag.root && pwrDiag.root.n >= 2 && pwrDiag.likely_cause) {
            rec.push(`Power chords: ${pwrDiag.likely_cause}`);
        }
        if (!rec.length) rec.push('No strong patterns detected — collect more captures or review per-step summaries.');
        return rec;
    }

    function _calLabBuildReport() {
        const snap = getCalibrationSnapshot();
        const st = _calLabState || {};
        const perString = [];
        for (let si = 0; si < currentStringCount; si++) {
            const openCaps = (st.openCaptures && st.openCaptures[si]) || [];
            const fretCaps = (st.fretCaptures && st.fretCaptures[si]) || [];
            perString.push({
                string: si,
                open: { captures: openCaps, summary: _calLabSummarizeCaptures(openCaps) },
                fret5: { captures: fretCaps, summary: _calLabSummarizeCaptures(fretCaps) },
            });
        }
        const techniqueKeys = [
            ['picked', 'Picked notes'],
            ['hammerOn', 'Hammer-ons'],
            ['pullOff', 'Pull-offs'],
            ['powerChord', 'Power chords'],
            ['palmMute', 'Palm mutes'],
            ['naturalHarmonic', 'Natural harmonics'],
            ['pinchHarmonic', 'Pinch harmonics'],
            ['halfBend', 'Half bends'],
            ['wholeBend', 'Whole bends'],
            ['sustain', 'Sustain / decay'],
        ];
        const perTechnique = techniqueKeys.map(([key, label]) => {
            const caps = (st.techniqueCaptures && st.techniqueCaptures[key]) || [];
            let summary;
            if (key === 'sustain' && (st.sustainSeries || []).length) {
                summary = _calLabSummarizeSustainSeries(st.sustainSeries);
            } else if (key === 'powerChord') {
                summary = _calLabSummarizePowerChordCaptures(caps);
            } else {
                summary = _calLabSummarizeCaptures(caps);
            }
            const entry = { id: key, label, captures: caps, summary };
            if (key === 'powerChord') {
                entry.per_string_summary = _calLabBuildPowerChordReportSummary(caps);
            }
            return entry;
        });
        const powerChordCaps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const report = {
            schema: _CAL_LAB_SCHEMA,
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            assessment_mode: st.mode || null,
            calibration_notes: [
                'Half bends and whole bends use the same native bend probe (G string fret 7, bend flag); labels distinguish technique captures only.',
            ],
            settings: {
                harmonic_snr_used: _ND_VERIFY_HARMONIC_SNR,
                pitch_tolerance_cents: pitchTolerance,
                pitch_check_cents_verify: _ND_VERIFY_PITCH_CENTS,
                timing_tolerance_s: timingTolerance,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                method: detectionMethod,
            },
            hardware: {
                noise_level_pct: st.noiseLevelPct,
                noise_peak_pct: st.noisePeakPct,
                signal_level_pct: st.signalLevelPct,
                signal_peak_pct: st.signalPeakPct,
                sample_rate_hz: snap.sampleRateHz,
                channel: snap.channel,
                source: snap.source,
                av_offset_ms: snap.avOffsetMs,
            },
            per_string: perString,
            per_technique: perTechnique,
            sustain_series: (st.sustainSeries || []),
            power_chord_diagnostics: _calLabBuildPowerChordReportSummary(powerChordCaps),
        };
        report.recommendations = _calLabBuildRecommendations(report);
        report.simple_summary = _calLabBuildSimpleReportBullets(report);
        _calLabLastReport = report;
        return report;
    }

    function _calLabDownloadReport() {
        try {
            const payload = _calLabBuildReport();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_calibration_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] calibration report download:', e);
            return false;
        }
    }

    function calibrationLabClose() {
        _calLabStopAutoCapture('close');
        if (_calLabTick) {
            clearInterval(_calLabTick);
            _calLabTick = null;
        }
        if (_calLabEl) {
            _calLabEl.remove();
            _calLabEl = null;
        }
        _calLabState = null;
    }

    function _calLabAllStepMeta() {
        return [
            { id: 'intro', title: 'Get Started' },
            { id: 'noise', title: 'Noise Floor' },
            { id: 'signal', title: 'Signal Level' },
            { id: 'open', title: 'Open Strings' },
            { id: 'fret5', title: 'Fretted Note' },
            { id: 'picked', title: 'Picked Notes' },
            { id: 'hammerOn', title: 'Hammer-ons' },
            { id: 'pullOff', title: 'Pull-offs' },
            { id: 'powerChord', title: 'Power Chords' },
            { id: 'palmMute', title: 'Palm Mutes' },
            { id: 'naturalHarmonic', title: 'Natural Harmonics' },
            { id: 'pinchHarmonic', title: 'Pinch Harmonics' },
            { id: 'halfBend', title: 'Half Bends' },
            { id: 'wholeBend', title: 'Whole Bends' },
            { id: 'sustain', title: 'Sustain / Decay' },
            { id: 'report', title: 'Report' },
        ];
    }

    function _calLabActiveSteps(mode) {
        if (!mode) return [{ id: 'intro', title: 'Get Started' }];
        return _calLabAllStepMeta().filter((s) => {
            if (s.id === 'intro') return false;
            if (mode === 'basic') return !_CAL_LAB_ADVANCED_ONLY_STEP_IDS.has(s.id);
            return true;
        });
    }

    function _calLabStringCaptureRowHtml(st, store, s, f, label, opts) {
        const caps = (st[store] && st[store][s]) || [];
        const sum = _calLabSummarizeCaptures(caps);
        const lastCap = caps.length ? caps[caps.length - 1] : null;
        const chips = _calLabGateChipsHtml(lastCap);
        const techDetail = opts && opts.showTech
            ? `<span class="text-[9px] text-gray-600"> (s${s} f${f})</span>` : '';
        const countNote = (opts && opts.showCount)
            ? ` · ${caps.length}/${_CAL_LAB_MIN_CAPTURES} checks` : '';
        const status = caps.length
            ? (lastCap && (lastCap.hit || lastCap.gatePassCount === 3)
                ? '<span class="text-green-300/90 text-[10px]">heard</span>'
                : '<span class="text-amber-200/90 text-[10px]">not verified</span>')
            : '';
        return `<div class="flex flex-col gap-0.5 py-2 border-b border-gray-700/50">
            <p class="text-gray-300 text-xs mb-1">${label}${techDetail}</p>
            <div class="flex items-center justify-between gap-2">
                <span class="text-gray-400 text-[10px]">${countNote.trim() || 'Ready'} ${status}</span>
                <button type="button" class="nd-cal-lab-cap-str px-2 py-1 rounded text-[10px] bg-dark-600 hover:bg-dark-500 text-gray-200" data-store="${store}" data-s="${s}" data-f="${f}">${opts && opts.btnLabel ? opts.btnLabel : 'Capture'}</button>
            </div>${chips ? `<div class="mt-0.5">${chips}</div>` : ''}</div>`;
    }

    function _calLabStringLabels() {
        const labels = ['E', 'A', 'D', 'G', 'B', 'e', 'B7', 'F#'];
        const out = [];
        for (let i = 0; i < currentStringCount; i++) {
            out.push({ s: i, label: labels[i] || ('S' + i) });
        }
        return out;
    }

    function _calLabRefreshLive() {
        if (!_calLabEl || !_calLabState) return;
        const snap = getCalibrationSnapshot();
        const live = _calLabEl.querySelector('.nd-cal-lab-live');
        if (live) {
            live.textContent = 'Live: ' + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct)
                + (_calLabCanProbe() ? ' · ready to capture' : ' · turn Detect on (desktop) to capture');
        }
    }

    function renderCalibrationLab() {
        if (!_calLabEl || !_calLabState) return;
        const body = _calLabEl.querySelector('.nd-cal-lab-body');
        const title = _calLabEl.querySelector('.nd-cal-lab-title');
        const backBtn = _calLabEl.querySelector('.nd-cal-lab-back');
        const nextBtn = _calLabEl.querySelector('.nd-cal-lab-next');
        if (!body || !title) return;
        const st = _calLabState;
        const steps = _calLabActiveSteps(st.mode);
        const step = st.step;
        const stepDef = steps[step];
        const stepId = stepDef ? stepDef.id : 'intro';
        if (st._lastRenderStepId !== stepId || st._lastRenderMode !== st.mode) {
            _calLabStopAutoCapture('step-change');
            st._lastRenderStepId = stepId;
            st._lastRenderMode = st.mode;
        }
        const modeLabel = st.mode === 'basic' ? 'Basic' : (st.mode === 'advanced' ? 'Advanced' : '');
        title.textContent = modeLabel
            ? `Technique Assessment — ${modeLabel} · ${stepDef ? stepDef.title : 'Step'}`
            : `Technique Assessment — ${stepDef ? stepDef.title : 'Get Started'}`;
        if (backBtn) backBtn.style.visibility = (st.mode && step > 0) ? 'visible' : 'hidden';
        if (nextBtn) {
            if (!st.mode) {
                nextBtn.style.visibility = 'hidden';
                nextBtn.disabled = false;
            } else {
                nextBtn.style.visibility = 'visible';
                nextBtn.textContent = step >= steps.length - 1 ? 'Done' : 'Next';
                nextBtn.disabled = _calLabIsAutoBusy(st);
            }
        }

        let html = `<div class="nd-cal-lab-live text-cyan-300/90 text-[10px] font-mono mb-2">Live: —</div>`;
        if (!_calLabCanProbe() && st.mode && stepId !== 'report') {
            html += '<p class="text-amber-200/90 text-[10px] mb-2">Turn Detect on (desktop) to run listening checks.</p>';
        }

        if (stepId === 'intro') {
            html += `<p class="text-gray-300 text-xs mb-3"><strong class="text-gray-200">Calibration Wizard</strong> sets up your input. <strong class="text-gray-200">Technique Assessment</strong> checks how well Slopsmith hears your playing.</p>
                <p class="text-gray-300 text-xs mb-3">Each check looks at <strong class="text-gray-200">signal clarity</strong>, whether the <strong class="text-gray-200">main note</strong> is present, and <strong class="text-gray-200">tuning match</strong>. Read-only — nothing here changes gameplay settings.</p>
                <button type="button" class="nd-cal-lab-start-basic w-full py-2.5 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2">Start Basic Assessment</button>
                <p class="text-[10px] text-gray-500 mb-3">Checks input level, open strings, one fretted note, and one power chord. Best first step.</p>
                <button type="button" class="nd-cal-lab-start-advanced w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Advanced Assessment</button>
                <p class="text-[10px] text-gray-500">Detailed probes: hammer-ons, pull-offs, palm mutes, harmonics, bends, and sustain.</p>`;
        } else if (stepId === 'noise') {
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'noise';
                const noiseResult = Number.isFinite(st.noiseLevelPct)
                    ? calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct) : '—';
                html += `<p class="text-gray-300 text-sm mb-2">Mute all strings. We will listen to room noise.</p>
                    ${_calLabBasicAutoControlsHtml('noise', 'Start noise check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-result text-[11px] text-gray-400 mb-2">${noiseResult}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-noise w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2 mt-1">Capture room noise (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Mute all strings and rest your hands on the strings.</p>
                    <button type="button" class="nd-cal-lab-cap-noise w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Capture room noise</button>
                    <div class="nd-cal-lab-cap-noise-txt text-[11px] text-gray-400">—</div>`;
            }
        } else if (stepId === 'signal') {
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'signal';
                const sigResult = Number.isFinite(st.signalLevelPct)
                    ? calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct) : '—';
                html += `<p class="text-gray-300 text-sm mb-2">Play the thickest string loudly.</p>
                    ${_calLabBasicAutoControlsHtml('signal', 'Start signal check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-result text-[11px] text-gray-400 mb-2">${sigResult}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-signal w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2 mt-1">Capture playing level (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play the thickest string open at normal volume.</p>
                    <button type="button" class="nd-cal-lab-cap-signal w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Capture playing level</button>
                    <div class="nd-cal-lab-cap-signal-txt text-[11px] text-gray-400">—</div>`;
            }
        } else if (stepId === 'open' || stepId === 'fret5') {
            const fret = stepId === 'open' ? 0 : 5;
            const store = stepId === 'open' ? 'openCaptures' : 'fretCaptures';
            if (st.mode === 'basic') {
                const rows = stepId === 'open' ? _CAL_LAB_BASIC_OPEN_ROWS : _CAL_LAB_BASIC_FRET_ROWS;
                const busy = _calLabIsAutoBusy(st);
                const autoKey = stepId === 'open' ? 'open' : 'fret5';
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === autoKey;
                const startLabel = stepId === 'open' ? 'Start open-string check' : 'Start fretted-note check';
                const instruct = stepId === 'open'
                    ? 'We will check the thickest string open, then the next string open.'
                    : 'Play the thickest string at the 5th fret when prompted.';
                let summaryHtml = '';
                for (const row of rows) {
                    const caps = (st[store] && st[store][row.s]) || [];
                    const lastCap = caps.length ? caps[caps.length - 1] : null;
                    const chips = _calLabGateChipsHtml(lastCap);
                    const heard = caps.length
                        ? (lastCap && (lastCap.hit || lastCap.gatePassCount === 3)
                            ? '<span class="text-green-300/90">heard</span>'
                            : '<span class="text-amber-200/90">not verified</span>')
                        : '<span class="text-gray-500">not checked</span>';
                    summaryHtml += `<div class="py-1 border-b border-gray-700/40 text-[10px]">
                        <span class="text-gray-300">${row.prompt}</span> · ${caps.length} captures · ${heard}
                        ${chips ? `<div class="mt-0.5">${chips}</div>` : ''}</div>`;
                }
                html += `<p class="text-gray-300 text-sm mb-2">${instruct}</p>
                    ${_calLabBasicAutoControlsHtml(autoKey, startLabel, busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-summary text-[10px] text-gray-400 mb-2">${summaryHtml}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <div class="mt-1">`;
                for (const row of rows) {
                    html += _calLabStringCaptureRowHtml(st, store, row.s, row.f, row.prompt, {
                        btnLabel: row.btn,
                    });
                }
                html += `</div></details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play each string ${fret === 0 ? 'open' : `at fret ${fret}`}. Capture while the note rings.</p>`;
                for (const { s, label } of _calLabStringLabels()) {
                    const musician = _calLabMusicianStringRowLabel(s, fret, label);
                    html += _calLabStringCaptureRowHtml(st, store, s, fret, musician, {
                        showTech: true,
                        showCount: true,
                        btnLabel: `Capture ${musician}`,
                    });
                }
            }
        } else if (stepId === 'picked') {
            html += `<p class="text-gray-300 text-xs mb-2">Pick single notes (e.g. 12th fret). Capture while playing.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="picked" data-s="0" data-f="12">Capture picked sample (low E @ 12)</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'picked')}</div>`;
        } else if (stepId === 'hammerOn') {
            html += `<p class="text-gray-300 text-xs mb-2">Hammer onto fret 5 on A string (from fret 3). Capture during hammer.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="hammerOn" data-s="1" data-f="5" data-ho="1">Capture hammer-on</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'hammerOn')}</div>`;
        } else if (stepId === 'pullOff') {
            html += `<p class="text-gray-300 text-xs mb-2">Pull-off from fret 5 to 3 on A string. Capture during pull-off.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="pullOff" data-s="1" data-f="3" data-po="1">Capture pull-off</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'pullOff')}</div>`;
        } else if (stepId === 'powerChord') {
            const pwrCaps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
            const pwrCaptureBlocks = pwrCaps.length
                ? pwrCaps.map((cap, i) => _calLabPowerChordCaptureBlockHtml(cap, i)).join('')
                : '';
            const simpleDiag = _calLabPowerChordSimpleDiagnosis(st);
            const pwrTarget = _calLabPowerChordTargetLabel();
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'powerChord';
                html += `<p class="text-gray-300 text-sm mb-2">Play ${pwrTarget.leadHtml} — thickest string open (<strong class="text-gray-100">${pwrTarget.root}</strong>) + next string, 2nd fret (<strong class="text-gray-100">${pwrTarget.fifth}</strong>).</p>
                    <p class="text-[10px] text-gray-500 mb-2">Try the dry/clean channel if available to compare against a wet tone.</p>
                    ${_calLabBasicAutoControlsHtml('powerChord', 'Start power-chord check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <p class="nd-cal-lab-pwr-diag-live text-[11px] text-gray-200 mb-2">${simpleDiag}</p>
                    ${pwrCaptureBlocks ? `<details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical capture details</summary>
                        <div class="nd-cal-lab-tech-sum text-[10px] text-gray-500 mt-1 mb-2">${_calLabFormatPowerChordSum(st)}</div>
                        <div class="nd-cal-lab-pwr-captures">${pwrCaptureBlocks}</div></details>` : ''}
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-pwr w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2 mt-1">Capture power chord (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play ${pwrTarget.leadHtml} — thickest string open (<strong class="text-gray-100">${pwrTarget.root}</strong>) + next string at the 2nd fret (<strong class="text-gray-100">${pwrTarget.fifth}</strong>). Capture while both ring.</p>
                    <p class="text-[10px] text-gray-500 mb-2">Power chords are tested per string. If the root passes but the fifth fails, the issue is usually masking, distortion, or channel choice — not your timing.</p>
                    <p class="text-[10px] text-gray-500 mb-2">Try the dry/clean channel if available to compare against a wet Spark tone.</p>
                    <button type="button" class="nd-cal-lab-cap-pwr w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2">Capture power chord</button>
                    <p class="text-[11px] text-gray-200 mb-2">${simpleDiag}</p>
                    ${pwrCaptureBlocks ? `<details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical capture details</summary>
                        <div class="nd-cal-lab-tech-sum text-[10px] text-gray-500 mt-1 mb-2">${_calLabFormatPowerChordSum(st)}</div>
                        <div class="nd-cal-lab-pwr-captures">${pwrCaptureBlocks}</div></details>` : ''}`;
            }
        } else if (stepId === 'palmMute') {
            html += `<p class="text-gray-300 text-xs mb-2">Palm-muted chugs on low E.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Note: charts do not flag palm mutes yet — this probe uses a picked-note context. Results show how muted playing verifies, not chart palm-mute scoring.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="palmMute" data-s="0" data-f="0">Capture palm mute</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'palmMute')}</div>`;
        } else if (stepId === 'naturalHarmonic') {
            html += `<p class="text-gray-300 text-xs mb-2">Natural harmonic at 12th fret low E. Capture lightly.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="naturalHarmonic" data-s="0" data-f="12" data-hm="1">Capture natural harmonic</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'naturalHarmonic')}</div>`;
        } else if (stepId === 'pinchHarmonic') {
            html += `<p class="text-gray-300 text-xs mb-2">Pinch harmonic on any string.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Note: charts do not flag pinch harmonics yet — this probe uses picked-note context.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="pinchHarmonic" data-s="2" data-f="7">Capture pinch harmonic</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'pinchHarmonic')}</div>`;
        } else if (stepId === 'halfBend') {
            html += `<p class="text-gray-300 text-xs mb-2">Half bend at 7th fret G string. Capture mid-bend and release.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Half and whole bends use the same detector probe — labels distinguish your technique, not separate detector modes.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="halfBend" data-s="3" data-f="7" data-b="1">Capture half bend</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'halfBend')}</div>`;
        } else if (stepId === 'wholeBend') {
            html += `<p class="text-gray-300 text-xs mb-2">Whole-step bend at 7th fret G string.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Same probe as half bends — compare results as labeled captures, not distinct modes.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="wholeBend" data-s="3" data-f="7" data-b="1">Capture whole bend</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'wholeBend')}</div>`;
        } else if (stepId === 'sustain') {
            html += `<p class="text-gray-300 text-xs mb-2">Hold a note (open low E). Record polls SNR over ~1.5 s.</p>
                <button type="button" class="nd-cal-lab-cap-sustain w-full py-2 bg-accent hover:bg-accent-light rounded text-xs font-semibold text-white mb-2">Record sustain</button>
                <div class="nd-cal-lab-sustain-txt text-[11px] text-gray-400">${(st.sustainSeries || []).length} samples</div>`;
        } else if (stepId === 'report') {
            const rep = _calLabBuildReport();
            const simpleBullets = _calLabBuildSimpleReportBullets(rep);
            const simpleHtml = simpleBullets.map((t) => `<li class="text-gray-200">${t}</li>`).join('');
            const recHtml = (rep.recommendations || []).map((t) => `<li class="text-amber-200/90">${t}</li>`).join('');
            html += `<p class="text-gray-300 text-xs mb-2">Your Technique Assessment results. This did not change gameplay settings.</p>
                <ul class="text-[11px] list-disc pl-4 mb-3 space-y-1">${simpleHtml}</ul>
                <button type="button" class="nd-cal-lab-dl w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2">Download full report (JSON)</button>
                <details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical details</summary>
                    <ul class="text-[10px] list-disc pl-4 mb-2 space-y-0.5 mt-2">${recHtml || '<li class="text-gray-500">No extra technical notes.</li>'}</ul>
                    <pre class="text-[9px] text-gray-500 max-h-32 overflow-auto whitespace-pre-wrap">${_calLabReportPreview(rep)}</pre>
                </details>`;
        }

        body.innerHTML = html;
        _calLabWireHandlers();
        _calLabRefreshLive();
    }

    function _calLabFormatTechSum(st, key) {
        if (key === 'powerChord') return _calLabFormatPowerChordSum(st);
        let sum;
        let lastCap = null;
        if (key === 'sustain' && (st.sustainSeries || []).length) {
            sum = _calLabSummarizeSustainSeries(st.sustainSeries);
            const s = st.sustainSeries[st.sustainSeries.length - 1];
            if (s) lastCap = { gatePassCount: s.gatePassCount, failedGateMask: s.failedGateMask };
        } else {
            const caps = (st.techniqueCaptures && st.techniqueCaptures[key]) || [];
            sum = _calLabSummarizeCaptures(caps);
            lastCap = caps.length ? caps[caps.length - 1] : null;
        }
        if (!sum.n) return 'No captures yet — press Capture while playing.';
        const unit = key === 'sustain' ? 'samples' : 'captures';
        const weak = _calLabDominantFailLabel(sum.dominantFailure);
        const chips = _calLabGateChipsHtml(lastCap);
        return `${sum.n} ${unit} · weakest area: ${weak}${chips ? ' · ' : ''}${chips}`;
    }

    function _calLabReportPreview(rep) {
        try {
            const lines = [];
            for (const t of (rep.per_technique || [])) {
                if (!t.summary || !t.summary.n) continue;
                if (t.id === 'powerChord' && t.summary.root && t.summary.fifth) {
                    const rootPct = t.summary.root.passRate != null
                        ? Math.round(t.summary.root.passRate * 100) : '—';
                    const fifthPct = t.summary.fifth.passRate != null
                        ? Math.round(t.summary.fifth.passRate * 100) : '—';
                    let line = `${t.label}: ${t.summary.n} captures · root ${rootPct}% · fifth ${fifthPct}%`;
                    if (t.summary.likelyCause) line += ` · ${t.summary.likelyCause}`;
                    lines.push(line);
                    continue;
                }
                const med = Number.isFinite(t.summary.medianSnrRatio)
                    ? t.summary.medianSnrRatio.toFixed(2) : '—';
                lines.push(`${t.label}: ${t.summary.n} captures · clarity ${med} · weakest: ${_calLabDominantFailLabel(t.summary.dominantFailure)}`);
            }
            return lines.slice(0, 12).join('\n') || '(empty)';
        } catch (_) { return ''; }
    }

    function _calLabWireHandlers() {
        if (!_calLabEl || !_calLabState) return;
        const st = _calLabState;
        const body = _calLabEl.querySelector('.nd-cal-lab-body');
        if (!body) return;

        const startBasic = body.querySelector('.nd-cal-lab-start-basic');
        if (startBasic) {
            startBasic.onclick = () => {
                _calLabStopAutoCapture('mode');
                st.mode = 'basic';
                st.step = 0;
                renderCalibrationLab();
            };
        }
        const startAdvanced = body.querySelector('.nd-cal-lab-start-advanced');
        if (startAdvanced) {
            startAdvanced.onclick = () => {
                _calLabStopAutoCapture('mode');
                st.mode = 'advanced';
                st.step = 0;
                renderCalibrationLab();
            };
        }

        body.querySelectorAll('.nd-cal-lab-auto-start').forEach((btn) => {
            btn.onclick = () => {
                const key = btn.getAttribute('data-auto-step');
                if (key === 'noise') _calLabStartNoiseAuto();
                else if (key === 'signal') _calLabStartSignalAuto();
                else if (key === 'open') _calLabStartOpenAuto(false);
                else if (key === 'fret5') _calLabStartFretAuto(false);
                else if (key === 'powerChord') _calLabStartPowerChordAuto(false);
            };
        });
        body.querySelectorAll('.nd-cal-lab-auto-retry').forEach((btn) => {
            btn.onclick = () => {
                const key = btn.getAttribute('data-auto-step');
                _calLabRetryBasicAuto(key);
            };
        });
        body.querySelectorAll('.nd-cal-lab-auto-stop').forEach((btn) => {
            btn.onclick = () => {
                _calLabStopAutoCapture('user');
                _calLabSetAutoStatus('<span class="text-gray-400">Stopped.</span>');
                _calLabUpdateBasicAutoButtons();
            };
        });

        const capNoise = body.querySelector('.nd-cal-lab-cap-noise');
        if (capNoise) {
            capNoise.onclick = () => {
                _calLabStopAutoCapture('manual');
                const s = getCalibrationSnapshot();
                st.noiseLevelPct = s.inputLevelPct;
                st.noisePeakPct = s.inputPeakPct;
                const el = body.querySelector('.nd-cal-lab-cap-noise-txt');
                if (el) el.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                const autoEl = body.querySelector('.nd-cal-lab-auto-result');
                if (autoEl) {
                    autoEl.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                }
                if (st.autoRun) {
                    st.autoRun.phase = 'done';
                    st.autoRun.stepId = 'noise';
                }
                renderCalibrationLab();
            };
        }
        const capSignal = body.querySelector('.nd-cal-lab-cap-signal');
        if (capSignal) {
            capSignal.onclick = () => {
                _calLabStopAutoCapture('manual');
                const s = getCalibrationSnapshot();
                st.signalLevelPct = s.inputLevelPct;
                st.signalPeakPct = s.inputPeakPct;
                const el = body.querySelector('.nd-cal-lab-cap-signal-txt');
                if (el) el.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                const autoEl = body.querySelector('.nd-cal-lab-auto-result');
                if (autoEl) {
                    autoEl.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                }
                if (st.autoRun) {
                    st.autoRun.phase = 'done';
                    st.autoRun.stepId = 'signal';
                }
                renderCalibrationLab();
            };
        }

        body.querySelectorAll('.nd-cal-lab-cap-str').forEach((btn) => {
            btn.onclick = async () => {
                _calLabStopAutoCapture('manual');
                const store = btn.getAttribute('data-store');
                const s = parseInt(btn.getAttribute('data-s'), 10);
                const f = parseInt(btn.getAttribute('data-f'), 10);
                if (!store || !Number.isInteger(s)) return;
                btn.disabled = true;
                const cap = await _calLabCaptureProbe({ s, f }, store);
                btn.disabled = false;
                if (!_calLabState || _calLabState !== st) return;
                if (cap.ok) {
                    if (!st[store]) st[store] = {};
                    if (!st[store][s]) st[store][s] = [];
                    st[store][s].push(cap);
                }
                renderCalibrationLab();
            };
        });

        body.querySelectorAll('.nd-cal-lab-cap-tech').forEach((btn) => {
            btn.onclick = async () => {
                _calLabStopAutoCapture('manual');
                const tech = btn.getAttribute('data-tech');
                const s = parseInt(btn.getAttribute('data-s'), 10);
                const f = parseInt(btn.getAttribute('data-f'), 10);
                const note = { s, f };
                if (btn.getAttribute('data-ho')) note.ho = true;
                if (btn.getAttribute('data-po')) note.po = true;
                if (btn.getAttribute('data-b')) note.b = true;
                if (btn.getAttribute('data-hm')) note.hm = true;
                btn.disabled = true;
                const cap = await _calLabCaptureProbe(note, tech);
                btn.disabled = false;
                if (cap.ok) {
                    if (!st.techniqueCaptures) st.techniqueCaptures = {};
                    if (!st.techniqueCaptures[tech]) st.techniqueCaptures[tech] = [];
                    st.techniqueCaptures[tech].push(cap);
                }
                renderCalibrationLab();
            };
        });

        const capPwr = body.querySelector('.nd-cal-lab-cap-pwr');
        if (capPwr) {
            capPwr.onclick = async () => {
                _calLabStopAutoCapture('manual');
                capPwr.disabled = true;
                const cap = await _calLabCaptureMulti([{ s: 0, f: 0 }, { s: 1, f: 2 }], 'powerChord');
                capPwr.disabled = false;
                if (!_calLabState || _calLabState !== st) return;
                if (cap.ok) {
                    if (!st.techniqueCaptures) st.techniqueCaptures = {};
                    if (!st.techniqueCaptures.powerChord) st.techniqueCaptures.powerChord = [];
                    st.techniqueCaptures.powerChord.push(cap);
                }
                renderCalibrationLab();
            };
        }

        const capSus = body.querySelector('.nd-cal-lab-cap-sustain');
        if (capSus) {
            capSus.onclick = async () => {
                capSus.disabled = true;
                if (!st.sustainSeries) st.sustainSeries = [];
                const note = { s: 0, f: 0 };
                for (let i = 0; i < 10; i++) {
                    const cap = await _calLabCaptureProbe(note, 'sustain');
                    if (cap.ok) {
                        st.sustainSeries.push({
                            tMs: i * 150,
                            snrRatio: cap.snrRatio,
                            gatePassCount: cap.gatePassCount,
                            failedGateMask: cap.failedGateMask,
                        });
                    }
                    await new Promise((r) => setTimeout(r, 150));
                }
                capSus.disabled = false;
                renderCalibrationLab();
            };
        }

        const dl = body.querySelector('.nd-cal-lab-dl');
        if (dl) dl.onclick = () => _calLabDownloadReport();
    }

    function calibrationLabNext() {
        if (!_calLabState || !_calLabState.mode) return;
        if (_calLabIsAutoBusy(_calLabState)) return;
        _calLabStopAutoCapture('next');
        const steps = _calLabActiveSteps(_calLabState.mode);
        if (_calLabState.step >= steps.length - 1) {
            calibrationLabClose();
            return;
        }
        _calLabState.step++;
        renderCalibrationLab();
    }

    function calibrationLabBack() {
        if (!_calLabState || !_calLabState.mode || _calLabState.step <= 0) return;
        if (_calLabIsAutoBusy(_calLabState)) return;
        _calLabStopAutoCapture('back');
        _calLabState.step--;
        renderCalibrationLab();
    }

    function openInstrumentCalibrationLab() {
        calibrationLabClose();
        _calLabState = {
            mode: null,
            step: 0,
            noiseLevelPct: null,
            noisePeakPct: null,
            signalLevelPct: null,
            signalPeakPct: null,
            openCaptures: {},
            fretCaptures: {},
            techniqueCaptures: {},
            sustainSeries: [],
            autoRun: _calLabDefaultAutoRun(),
        };
        const overlay = document.createElement('div');
        overlay.className = 'nd-cal-lab';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:301;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);pointer-events:auto;';
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl shadow-2xl text-sm" style="width:24rem;max-width:calc(100vw - 2rem);max-height:calc(100vh - 3rem);display:flex;flex-direction:column;">
                <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                    <span class="nd-cal-lab-title text-gray-200 font-semibold text-xs">Technique Assessment</span>
                    <button type="button" class="nd-cal-lab-close text-gray-500 hover:text-white text-lg leading-none">&times;</button>
                </div>
                <div class="nd-cal-lab-body px-4 py-3 overflow-y-auto flex-1 text-xs"></div>
                <div class="flex gap-2 px-4 py-3 border-t border-gray-700">
                    <button type="button" class="nd-cal-lab-back flex-1 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300">Back</button>
                    <button type="button" class="nd-cal-lab-next flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">Next</button>
                </div>
            </div>`;
        overlay.onclick = (e) => { if (e.target === overlay) calibrationLabClose(); };
        overlay.querySelector('.nd-cal-lab-close').onclick = () => calibrationLabClose();
        overlay.querySelector('.nd-cal-lab-back').onclick = () => calibrationLabBack();
        overlay.querySelector('.nd-cal-lab-next').onclick = () => calibrationLabNext();
        document.body.appendChild(overlay);
        _calLabEl = overlay;
        renderCalibrationLab();
        _calLabTick = setInterval(() => {
            if (!_calLabEl || !_calLabEl.isConnected) {
                calibrationLabClose();
                return;
            }
            _calLabRefreshLive();
        }, 200);
    }

    function getCalibrationReport() {
        try {
            return _calLabLastReport || (_calLabState ? _calLabBuildReport() : null);
        } catch (_) {
            return null;
        }
    }

    function _ndWireSettingsRangeScrollLock(panel) {
        if (!panel || panel._ndRangeScrollLock) return;
        panel._ndRangeScrollLock = true;

        const release = () => {
            panel.style.overflowY = 'auto';
            panel.classList.remove('nd-settings-panel--slider-drag');
        };

        for (const el of panel.querySelectorAll('input[type=range]')) {
            el.style.touchAction = 'none';
            el.style.userSelect = 'none';

            el.addEventListener('pointerdown', (e) => {
                panel.style.overflowY = 'hidden';
                panel.classList.add('nd-settings-panel--slider-drag');
                try { el.setPointerCapture(e.pointerId); } catch (_) {  }
            });

            el.addEventListener('pointerup', release);
            el.addEventListener('pointercancel', release);
            el.addEventListener('lostpointercapture', release);
        }
    }

    // Settings UI writes through the same setters exposed by the public API.
    function showSettings() {
        attachInstanceRoot();

        let panel = document.querySelector('.nd-settings-panel');
        if (panel) {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            _vuSetPanel(null);
            if (panel.isConnected) {
                panel.remove();
                return;
            }
            panel.remove();
        }

        panel = document.createElement('div');

        panel.className = 'nd-settings-panel bg-dark-700 border border-gray-600 rounded-xl p-4 shadow-2xl text-sm';
        panel.style.pointerEvents = 'auto';
        panel.style.position = 'fixed';
        panel.style.top = '4rem';
        panel.style.right = '1rem';
        panel.style.zIndex = '250';
        panel.style.width = '20rem';
        panel.style.maxWidth = 'calc(100vw - 2rem)';
        panel.style.maxHeight = 'calc(100vh - 5rem)';
        panel.style.overflowY = 'auto';

        const _ndCanNativeFrames = (function () {
            const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
            const a = d && d.isDesktop && d.audio;
            if (!a) return false;
            return typeof a.getRawAudioFrame === 'function'
                || typeof a.getSourceRawAudioFrame === 'function';
        })();
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-settings-close text-gray-500 hover:text-white">&times;</button>
            </div>

            <div class="nd-health-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3 text-[11px] text-gray-300 leading-snug">
                <div class="text-gray-200 text-xs font-semibold uppercase tracking-wider mb-2">Detection Health</div>
                <div class="nd-health-status text-gray-400 mb-1">—</div>
                <div class="nd-health-input text-gray-400 mb-1">—</div>
                <div class="nd-health-hearing text-cyan-300/90 mb-1 font-mono text-[10px]">—</div>
                <div class="nd-health-session text-gray-300 mb-1">—</div>
                <div class="nd-health-top-miss text-gray-400 mb-1">—</div>
                <div class="nd-health-align text-gray-400 mb-1">—</div>
                <div class="nd-health-level text-gray-400 mb-1">—</div>
                <div class="text-gray-200 text-[10px] font-semibold uppercase tracking-wider mt-2 mb-1">Recent notes that did not verify</div>
                <div class="nd-health-rejects text-gray-400 text-[10px] whitespace-pre-line leading-snug mb-1">—</div>
                <div class="nd-health-hint text-amber-200/90 mt-2 pt-2 border-t border-gray-700/80">—</div>
                <div class="text-[10px] text-gray-500 mt-1 leading-tight">Read-only health stats. Use the diagnostic track for playthrough assessment, Calibration Wizard for setup, and Advanced Signal Check for deeper signal detail.</div>
                <div class="text-[10px] text-gray-500 mt-2 mb-1 leading-tight">Play a short built-in track to check timing, open strings, fretted notes, and power chords on the highway.</div>
                <button type="button" class="nd-diag-launch-basic w-full py-2 bg-dark-600 hover:bg-dark-500 border border-cyan-900/50 rounded-lg text-xs text-gray-200 transition">
                    Run Basic Guitar Diagnostic
                </button>
                <div class="nd-health-diag-launch-status text-[10px] text-cyan-200/90 mt-1 mb-2 leading-snug"></div>
                <div class="text-[10px] text-gray-500 mb-1 leading-tight">Set up audio input, levels, and timing before you play.</div>
                <button type="button" class="nd-cal-wizard-open w-full py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-lg text-xs text-gray-200 transition">
                    Run Calibration Wizard
                </button>
                <div class="text-[10px] text-gray-500 mt-2 mb-1 leading-tight">Optional deeper troubleshooting for root/fifth, SNR, tuning, and signal-clarity details after a diagnostic track.</div>
                <button type="button" class="nd-cal-lab-open w-full py-2 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-xs text-gray-200 transition">
                    Advanced Signal Check
                </button>
            </div>

            ${tuningMode ? `
            <div class="nd-rec-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-gray-200 text-xs font-semibold uppercase tracking-wider">Reference Recording</span>
                    <span class="nd-rec-state text-[10px] uppercase tracking-wider text-gray-500">idle</span>
                </div>
                <div class="nd-rec-info text-[11px] text-gray-400 leading-snug mb-2">Click Arm, then press Play on the song.</div>
                <div class="flex gap-1.5">
                    <button class="nd-rec-arm flex-1 bg-accent hover:bg-accent-light disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition">
                        Arm
                    </button>
                    <button class="nd-rec-arm-training flex-1 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition" title="Capture this take and upload it to the curated training dataset (WAV + detect-stream + manifest, zipped, sent to pCloud)">
                        Arm (training)
                    </button>
                    <button class="nd-rec-save px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Save what's captured so far">
                        Save
                    </button>
                    <button class="nd-rec-discard px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Throw out the in-flight buffer">
                        Discard
                    </button>
                </div>
                <div class="nd-rec-saved text-[10px] text-gray-500 mt-2 break-all"></div>
                <div class="nd-rec-upload text-[10px] mt-1 break-all"></div>
            </div>
            ` : ''}

            <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
            <select class="nd-device-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="">Default</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
            <select class="nd-channel-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="mono" ${selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
                <option value="left" ${selectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
                <option value="right" ${selectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Level</label>
            <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
                <div class="nd-vu-bar h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
                <div class="nd-vu-peak absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-gray-600 mb-3">
                <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3">
                <option value="yin" ${detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="hps" ${detectionMethod === 'hps' ? 'selected' : ''}>HPS (bass with weak fundamental, no model)</option>
                <option value="crepe" ${detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span class="nd-timing-val">${Math.round(timingTolerance * 1000)}</span>ms</label>
            <input type="range" min="30" max="300" value="${Math.round(timingTolerance * 1000)}"
                   class="nd-timing-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-2 leading-tight">
                Outer match window. Detections outside this range are ignored.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span class="nd-pitch-val">${pitchTolerance}</span> cents</label>
            <input type="range" min="10" max="100" value="${pitchTolerance}"
                   class="nd-pitch-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Outer pitch match window. Wider values correlate more attempts.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Timing: <span class="nd-timing-hit-val">${Math.round(timingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="30" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(timingHitThreshold * 1000)}"
                   class="nd-timing-hit-slider w-full accent-blue-400 mb-2">

            <label class="block text-gray-400 text-xs mb-1">Chord Timing Window: <span class="nd-chord-timing-val">${Math.round(chordTimingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="${Math.round(timingHitThreshold * 1000)}" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(chordTimingHitThreshold * 1000)}"
                   class="nd-chord-timing-slider w-full accent-blue-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord strums have more inherent timing jitter than single notes (multi-string strike spread + analysis-window smearing). Fast power-chord punk also anticipates the beat. Wider than Clean Timing; pinned >= it.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Pitch: <span class="nd-pitch-hit-val">${pitchHitThreshold}</span> cents</label>
            <input type="range" min="5" max="${pitchTolerance}" value="${pitchHitThreshold}"
                   class="nd-pitch-hit-slider w-full accent-blue-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Detection Confidence: <span class="nd-conf-val">${Math.round(detectionConfidenceMin * 100)}</span>%</label>
            <input type="range" min="5" max="50" value="${Math.round(detectionConfidenceMin * 100)}"
                   class="nd-conf-slider w-full accent-purple-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Minimum confidence to accept a YIN/HPS/CREPE frame. Lower this if too many notes register as "pure miss" with no detection — at the cost of more false positives on quiet/noisy signals.
            </div>

            ${_ndCanNativeFrames ? `
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-native-detect accent-purple-400" ${nativeDetection ? 'checked' : ''}>
                Detect in-plugin (native audio)
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Desktop only. Runs note_detect's own ${'YIN/HPS/CREPE'} on the engine-captured guitar signal (instead of the engine's built-in detector), while chords are still verified by the engine's harmonic-comb scorer. Use this to pick HPS/CREPE on desktop. Takes effect immediately if Detect is currently on; otherwise on the next Detect toggle.
            </div>` : ''}

            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-timing accent-green-400" ${showTimingErrors ? 'checked' : ''}>
                Show early/late labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-pitch accent-green-400" ${showPitchErrors ? 'checked' : ''}>
                Show sharp/flat labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-edge-flash accent-green-400" ${edgeFlashEnabled ? 'checked' : ''}>
                Screen-edge flash on hit/miss
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Off by default — the highway now lights up the note itself on a hit. Turn on for the old full-screen green/red edge flash.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Miss Marker Duration: <span class="nd-miss-duration-val">${missMarkerDuration.toFixed(1)}</span>s</label>
            <input type="range" min="5" max="50" value="${Math.round(missMarkerDuration * 10)}"
                   class="nd-miss-duration-slider w-full accent-red-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Input Gain: <span class="nd-gain-val">${inputGain.toFixed(1)}</span>x</label>
            <input type="range" min="1" max="50" value="${Math.round(inputGain * 10)}"
                   class="nd-gain-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Chord Leniency: <span class="nd-chord-ratio-val">${Math.round(chordHitRatio * 100)}</span>% of strings</label>
            <input type="range" min="25" max="100" value="${Math.round(chordHitRatio * 100)}"
                   class="nd-chord-ratio-slider w-full accent-green-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord detection uses per-string band analysis. This sets how many strings must ring to count as a hit (e.g. 60% = 4 of 6). Lower for beginners or dense voicings.
            </div>

            <div class="text-[10px] text-gray-600 mt-1 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
                See the <b>Pitch Detection Methods</b> section of the plugin README for guidance on choosing between YIN, HPS, and CREPE.
            </div>
        `;

        document.body.appendChild(panel);

        _vuSetPanel(panel);

        panel.querySelector('.nd-settings-close').onclick = () => {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            _vuSetPanel(null);
            panel.remove();
        };

        const calWizardBtn = panel.querySelector('.nd-cal-wizard-open');
        if (calWizardBtn) {
            calWizardBtn.onclick = () => openCalibrationWizard();
        }
        const calLabBtn = panel.querySelector('.nd-cal-lab-open');
        if (calLabBtn) {
            calLabBtn.onclick = () => openInstrumentCalibrationLab();
        }
        const diagLaunchBtn = panel.querySelector('.nd-diag-launch-basic');
        if (diagLaunchBtn) {
            diagLaunchBtn.onclick = () => _ndLaunchDiagnosticTrack('basic-guitar-6', panel);
        }

        try {
            renderDetectionHealth(panel);
        } catch (e) {
            console.warn('[note_detect] Detection Health render failed:',
                e && e.message ? e.message : e);
        }
        panel._ndHealthTick = setInterval(() => {
            if (!panel.isConnected) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
                return;
            }
            try {
                renderDetectionHealth(panel);
            } catch (e) {
                console.warn('[note_detect] Detection Health render failed:',
                    e && e.message ? e.message : e);
            }
        }, 400);

        const recBlock = panel.querySelector('.nd-rec-block');
        if (recBlock) {
            const armBtn  = recBlock.querySelector('.nd-rec-arm');
            const armTrnBtn = recBlock.querySelector('.nd-rec-arm-training');
            const saveBtn = recBlock.querySelector('.nd-rec-save');
            const discBtn = recBlock.querySelector('.nd-rec-discard');
            const stateEl = recBlock.querySelector('.nd-rec-state');
            const infoEl  = recBlock.querySelector('.nd-rec-info');
            const savedEl = recBlock.querySelector('.nd-rec-saved');
            const uploadEl = recBlock.querySelector('.nd-rec-upload');

            let tick = null;

            function renderRec() {
                if (!document.body.contains(panel)) { if (tick != null) clearInterval(tick); return; }
                const r = getRecordingState();
                const hasBuffer = r.samples > 0;
                const trainTag = r.armedForTraining ? ' (training)' : '';
                let label, info;
                if (r.saveInFlight) { label = 'saving…'; info = 'Encoding + uploading the WAV…'; }
                else if (r.trainingUploadInFlight) { label = 'uploading…'; info = 'Bundling WAV + detect-stream + manifest and shipping to pCloud…'; }
                else if (r.lastError) { label = 'error'; info = 'Last attempt failed: ' + r.lastError; }
                else if (r.armed && r.songPlaying) { label = 'recording' + trainTag; info = `Capturing… ${r.durationS.toFixed(1)} s (${r.samples} samples @ ${r.sampleRate} Hz). Auto-saves on song end${r.armedForTraining ? ' and uploads to the training dataset' : ''}.`; }
                else if (r.armed && !r.detectEnabled) { label = 'armed (Detect off)' + trainTag; info = 'Armed, but Detect isn\'t on — no audio is flowing.'; }
                else if (r.armed) { label = 'armed' + trainTag; info = 'Armed. Press Play to start capturing.'; }
                else if (hasBuffer) { label = 'paused'; info = `${r.durationS.toFixed(1)} s captured; Save to keep it or Discard to throw it out.`; }
                else if (r.lastSavePath) { label = 'idle'; info = 'Ready. Click Arm for the next take.'; }
                else { label = 'idle'; info = 'Click Arm, then press Play.'; }
                if (stateEl) stateEl.textContent = label;
                if (infoEl)  {
                    infoEl.textContent = info;
                    infoEl.className = 'nd-rec-info text-[11px] leading-snug mb-2 ' + (r.lastError ? 'text-red-400' : 'text-gray-400');
                }

                const _setCodeLine = (el, label, codeText) => {
                    el.textContent = label;
                    const c = document.createElement('code');
                    c.className = 'text-gray-300';
                    c.textContent = codeText;
                    el.appendChild(c);
                };
                if (savedEl) {
                    if (r.lastSavePath && !r.armed && !r.lastError) {
                        _setCodeLine(savedEl, 'Saved: ', r.lastSavePath);
                    } else {
                        savedEl.textContent = '';
                    }
                }
                if (uploadEl) {
                    const tr = r.trainingUploadResult;
                    if (tr && tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-green-400 mt-1 break-all';
                        _setCodeLine(uploadEl, 'Uploaded to training dataset: ', tr.bundle_filename || '(unknown)');
                    } else if (tr && !tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-red-400 mt-1 break-all';
                        uploadEl.textContent = 'Upload failed: ' + (tr.error || 'unknown error') + (tr.local_bundle ? ' (bundle retained at ' + tr.local_bundle + ')' : '');
                    } else {
                        uploadEl.textContent = '';
                    }
                }

                if (armBtn)  { armBtn.textContent = (r.armed && !r.armedForTraining) ? 'Disarm' : 'Arm'; armBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && r.armedForTraining); }
                if (armTrnBtn) { armTrnBtn.textContent = (r.armed && r.armedForTraining) ? 'Disarm' : 'Arm (training)'; armTrnBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && !r.armedForTraining); }

                if (saveBtn) saveBtn.disabled = !hasBuffer || r.saveInFlight || r.trainingUploadInFlight || r.armedForTraining;
                if (discBtn) discBtn.disabled = !(r.armed || hasBuffer) || r.saveInFlight || r.trainingUploadInFlight;
            }
            if (armBtn) armBtn.onclick = () => {
                const r = getRecordingState();
                if (r.armed && !r.armedForTraining) disarmRecording();
                else if (!r.armed) armRecording();
                renderRec();
            };
            if (armTrnBtn) armTrnBtn.onclick = async () => {
                const r = getRecordingState();
                if (r.armed && r.armedForTraining) {
                    disarmRecording();
                } else if (!r.armed) {

                    try { await armRecordingForTraining(); } catch (_) {  }
                }
                renderRec();
            };
            if (saveBtn) saveBtn.onclick = async () => {
                await saveRecordingNow();
                renderRec();
            };
            if (discBtn) discBtn.onclick = () => { discardRecording(); renderRec(); };
            renderRec();
            tick = setInterval(renderRec, 1000);
        }
        panel.querySelector('.nd-device-select').onchange = (e) => onDeviceChange(e.target.value);
        panel.querySelector('.nd-channel-select').onchange = (e) => onChannelChange(e.target.value);
        panel.querySelector('.nd-method-select').onchange = (e) => setMethod(e.target.value);
        panel.querySelector('.nd-latency-slider').oninput = (e) => {
            latencyOffset = e.target.value / 1000;
            panel.querySelector('.nd-latency-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-timing-slider').oninput = (e) => {
            timingTolerance = e.target.value / 1000;
            timingHitThreshold = Math.min(timingHitThreshold, timingTolerance);
            chordTimingHitThreshold = Math.min(chordTimingHitThreshold, timingTolerance);
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            panel.querySelector('.nd-timing-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-timing-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = Math.round(timingHitThreshold * 1000);
                panel.querySelector('.nd-timing-hit-val').textContent = hitSlider.value;
            }
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.max = e.target.value;
                chordSlider.min = Math.round(timingHitThreshold * 1000);
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-pitch-slider').oninput = (e) => {
            pitchTolerance = +e.target.value;
            pitchHitThreshold = Math.min(pitchHitThreshold, pitchTolerance);
            panel.querySelector('.nd-pitch-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-pitch-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = pitchHitThreshold;
                panel.querySelector('.nd-pitch-hit-val').textContent = hitSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-timing-hit-slider').oninput = (e) => {
            timingHitThreshold = e.target.value / 1000;
            panel.querySelector('.nd-timing-hit-val').textContent = e.target.value;

            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.min = e.target.value;
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-chord-timing-slider').oninput = (e) => {
            chordTimingHitThreshold = e.target.value / 1000;

            const clamped = chordTimingHitThreshold < timingHitThreshold;
            if (clamped) chordTimingHitThreshold = timingHitThreshold;

            if (clamped) e.target.value = Math.round(chordTimingHitThreshold * 1000);
            panel.querySelector('.nd-chord-timing-val').textContent = Math.round(chordTimingHitThreshold * 1000);
            saveSettings();
        };
        panel.querySelector('.nd-pitch-hit-slider').oninput = (e) => {
            pitchHitThreshold = +e.target.value;
            panel.querySelector('.nd-pitch-hit-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-conf-slider').oninput = (e) => {

            detectionConfidenceMin = (+e.target.value) / 100;
            panel.querySelector('.nd-conf-val').textContent = e.target.value;
            saveSettings();
        };

        const nativeDetectEl = panel.querySelector('.nd-native-detect');
        if (nativeDetectEl) {
            nativeDetectEl.onchange = (e) => {
                nativeDetection = !!e.target.checked;
                saveSettings();
                if (enabled) restartAudio();
            };
        }
        panel.querySelector('.nd-show-timing').onchange = (e) => {
            showTimingErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-show-pitch').onchange = (e) => {
            showPitchErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-edge-flash').onchange = (e) => {
            edgeFlashEnabled = !!e.target.checked;
            if (!edgeFlashEnabled) {

                const fe = instanceRoot.querySelector('.nd-flash-overlay');
                if (fe) fe.style.borderColor = 'transparent';
            }
            saveSettings();
        };
        panel.querySelector('.nd-miss-duration-slider').oninput = (e) => {
            missMarkerDuration = e.target.value / 10;
            panel.querySelector('.nd-miss-duration-val').textContent = missMarkerDuration.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-gain-slider').oninput = (e) => {
            inputGain = e.target.value / 10;
            panel.querySelector('.nd-gain-val').textContent = inputGain.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-chord-ratio-slider').oninput = (e) => {
            chordHitRatio = e.target.value / 100;
            panel.querySelector('.nd-chord-ratio-val').textContent = e.target.value;
            saveSettings();
        };

        _ndWireSettingsRangeScrollLock(panel);
        populateDevices();
    }

    function onDeviceChange(deviceId) {
        selectedDeviceId = deviceId;
        saveSettings();
        restartAudio();
    }

    function onChannelChange(channel) {

        const idx = channel === 'left' ? 0 : channel === 'right' ? 1 : -1;
        setChannel(idx);
    }

    async function populateDevices() {
        const sel = document.querySelector('.nd-settings-panel .nd-device-select');
        if (!sel) return;

        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        let nativeManaged = false;
        if (desktop && desktop.isDesktop && desktop.audio
            && caps && typeof caps.command === 'function'
            && typeof desktop.audio.isAvailable === 'function') {
            try { nativeManaged = !!(await desktop.audio.isAvailable()); }
            catch (_) { nativeManaged = false; }
        }
        if (nativeManaged) {
            sel.innerHTML = '<option value="">Set in Input Setup</option>';
            sel.disabled = true;
            sel.title = 'Your input device and input are chosen in the Input Setup wizard.';
            return;
        }
        sel.disabled = false;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) {  }
    }

    function setMethod(method) {
        detectionMethod = method;
        detectionMethodUserSet = true;
        saveSettings();
        if (method === 'crepe') _ndLoadCrepe();
    }

    function _ndEffectiveDetectionMethod() {
        if (currentArrangement === 'bass' && !detectionMethodUserSet && detectionMethod === 'yin')
            return 'hps';
        return detectionMethod;
    }

    function setChannel(idx) {
        if (!Number.isInteger(idx) || idx < -1) {
            console.warn(`[note_detect] setChannel: invalid channel ${idx}; expected an integer >= -1 (-1 = mono mix, else 0-based input channel).`);
            return false;
        }

        if (idx >= 2) {
            console.warn(`[note_detect] setChannel: channel ${idx} (multi-channel selection) is not yet supported; use a separate input device per panel.`);
            return false;
        }
        _ndChannelIndex = idx;

        if (idx === -1) selectedChannel = 'mono';
        else if (idx === 0) selectedChannel = 'left';
        else selectedChannel = 'right';
        saveSettings();

        if (sourceId != null && sourceId !== 0) {
            const a = bridgeDesktop && bridgeDesktop.audio;
            if (a && typeof a.setSourceInputChannel === 'function') {
                try { a.setSourceInputChannel(sourceId, _ndChannelIndex); } catch (_) {  }
            }
        }
        restartAudio();
        return true;
    }

    function setVerifierOffset(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
        _ndVerifierOffsetMs = ms;
        _ndApplyVerifierOffset();
    }
    function getVerifierOffset() { return _ndVerifierOffsetMs; }

    // HUD and canvas overlay consume scoring state produced by this instance.
    function createHUD() {
        if (instanceRoot.querySelector('.nd-hud')) return;

        try { instanceRoot.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        const hud = document.createElement('div');

        hud.className = 'nd-hud';
        hud.innerHTML = `
            <div class="nd-hud-score">0</div>
            <div class="nd-hud-mainrow">
                <span class="nd-hud-accuracy"></span>
                <span class="nd-hud-mult" data-tier="1">×1</span>
            </div>
            <div class="nd-hud-streak"></div>
            <div class="nd-hud-counts"></div>
            <div class="nd-hud-detected"></div>
            <div class="nd-drill hidden">
                <div class="nd-drill-header"></div>
                <div class="nd-drill-list"></div>
            </div>
        `;
        instanceRoot.appendChild(hud);
    }

    function removeHUD() {
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        instanceRoot.appendChild(flash);
    }

    function startHUD() {
        createHUD();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;

        displayScore = score;
        lastMultTier = multiplier;
        lastStreakVal = streak;
        const multEl = instanceRoot.querySelector('.nd-hud-mult');
        if (multEl) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
        }
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        removeHUD();
    }

    function updateHUD() {
        if (!enabled) return;

        const nowMs = Date.now();
        if (nowMs - drillLoopPollLastMs >= DRILL_LOOP_POLL_MS) {
            drillLoopPollLastMs = nowMs;
            _drillSyncFromLoopState();
        }

        _drillConductorTick();
        _drillRender();

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');
        const scoreEl = instanceRoot.querySelector('.nd-hud-score');
        const multEl = instanceRoot.querySelector('.nd-hud-mult');

        if (scoreEl) {

            if (score < displayScore) displayScore = score;
            const diff = score - displayScore;
            displayScore = diff < 1 ? score : displayScore + diff * 0.25;
            scoreEl.textContent = String(Math.round(displayScore));
        }

        if (multEl && multiplier !== lastMultTier) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
            if (multiplier > lastMultTier) {

                multEl.classList.remove('nd-pop');
                void multEl.offsetWidth;
                multEl.classList.add('nd-pop');
            }
            lastMultTier = multiplier;
        }

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
            if (streak === 0 && lastStreakVal >= 10) {

                const hudEl = instanceRoot.querySelector('.nd-hud');
                if (hudEl) {
                    hudEl.classList.remove('nd-shake');
                    void hudEl.offsetWidth;
                    hudEl.classList.add('nd-shake');
                }
            } else if (streak > lastStreakVal && _ndIsStreakMilestone(streak)) {
                streakEl.classList.remove('nd-flash');
                void streakEl.offsetWidth;
                streakEl.classList.add('nd-flash');
            }
            lastStreakVal = streak;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        } else if (countsEl) {

            countsEl.textContent = '';
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {

                const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                detectedEl.textContent = `${_ndMidiToName(displayMidi)} · s${detectedString} f${detectedFret}`;
            } else if (lastChordScore !== null) {

                const songTime = (hw.getTime ? hw.getTime() : 0) - latencyOffset
                    + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                const CHORD_HUD_TTL_SEC = 1.5;
                if (songTime - lastChordTime <= CHORD_HUD_TTL_SEC) {
                    const pct = Math.round(lastChordScore * 100);
                    detectedEl.textContent = `chord ${lastChordHit}/${lastChordTotal} (${pct}%)`;
                } else {
                    detectedEl.textContent = '';
                }
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {

            const spawnFlash = (color) => {

                if (!edgeFlashEnabled) return;
                flashEl.style.borderColor = color;
                const tid = setTimeout(() => {
                    if (flashEl) flashEl.style.borderColor = 'transparent';
                    const idx = flashTimeouts.indexOf(tid);
                    if (idx !== -1) flashTimeouts.splice(idx, 1);
                }, 80);
                flashTimeouts.push(tid);
            };
            if (hits > lastHitCount) {
                spawnFlash('rgba(0, 255, 136, 0.6)');
            } else if (misses > lastMissCount) {
                spawnFlash('rgba(255, 50, 68, 0.4)');
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

    function drawOverlay(ctx, W, H) {
        if (!enabled) return;
        if (!hw.project || !hw.fretX) return;

        if (hw.isDefaultRenderer && !hw.isDefaultRenderer()) return;

        const t = hw.getTime();
        const renderT = t + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const notes = _ndChartNotes();
        const chords = _ndChartChords();

        const drawTextReadable = (text, x, y) => {
            if (hw.fillTextUnmirrored) hw.fillTextUnmirrored(text, x, y);
            else ctx.fillText(text, x, y);
        };

        const nowPoint = hw.project(0);

        const drawIndicator = (s, f, noteTime, judgment) => {
            const tOff = noteTime - renderT;
            if (!nowPoint) return;

            const age = Math.max(0, renderT - noteTime);
            let scale = nowPoint.scale || 1;
            let x;
            let y;
            if (judgment.hit || tOff >= -0.05) {
                const p = hw.project(tOff);
                if (!p) return;
                scale = p.scale || scale;
                x = hw.fretX(f, scale, W);
                y = p.y * H;
            } else {
                const nowY = nowPoint.y * H;
                const pastArea = Math.max(40, H - nowY - 18);
                const progress = Math.min(1, age / Math.max(0.1, missMarkerDuration));
                x = hw.fretX(f, scale, W);
                y = nowY + Math.min(pastArea, 28 + progress * pastArea);
            }

            if (judgment.hit) {

                if (hw && hw.getNoteStateProvider && hw.getNoteStateProvider() === noteStateFor) return;
                const fade = Math.max(0, 1 - age / Math.max(0.1, hitGlowDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.7;
                ctx.globalCompositeOperation = 'lighter';
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 20 * scale;
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 3 * scale;
                ctx.beginPath();
                ctx.arc(x, y, 14 * scale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            } else {
                const fade = Math.max(0, 1 - age / Math.max(0.1, missMarkerDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.85;
                ctx.shadowColor = '#ff3344';
                ctx.shadowBlur = 12 * scale;
                ctx.strokeStyle = '#ff3344';
                ctx.lineWidth = 2.5 * scale;
                const sz = 8 * scale;
                ctx.beginPath();
                ctx.moveTo(x - sz, y - sz);
                ctx.lineTo(x + sz, y + sz);
                ctx.moveTo(x + sz, y - sz);
                ctx.lineTo(x - sz, y + sz);
                ctx.stroke();

                const pulse = Math.max(0, 1 - age / 0.2);
                if (pulse > 0) {
                    const nowY = nowPoint.y * H;
                    ctx.globalAlpha = pulse * 0.5;
                    ctx.strokeStyle = '#ff3344';
                    ctx.lineWidth = 5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(Math.max(0, x - 18 * scale), nowY + 4);
                    ctx.lineTo(Math.min(W, x + 18 * scale), nowY + 4);
                    ctx.stroke();
                }

                const labels = [];
                if (showTimingErrors && judgment.timingState && judgment.timingState !== 'OK') {
                    labels.push({
                        color: '#ffb347',
                        text: `${judgment.timingState === 'EARLY' ? '↑' : '↓'} ${judgment.timingError > 0 ? '+' : ''}${judgment.timingError}ms`,
                    });
                }
                if (showPitchErrors && judgment.pitchState && judgment.pitchState !== 'OK') {
                    labels.push({
                        color: '#66c7ff',
                        text: `${judgment.pitchState === 'SHARP' ? '♯' : '♭'} ${judgment.pitchError > 0 ? '+' : ''}${judgment.pitchError}¢`,
                    });
                }
                if (labels.length > 0) {
                    ctx.font = `bold ${Math.max(10, 11 * scale)}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    for (let i = 0; i < labels.length; i++) {
                        const yy = y + (i - (labels.length - 1) / 2) * 16 * scale - 18 * scale;
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                        ctx.strokeText(labels[i].text, x, yy);
                        ctx.fillStyle = labels[i].color;
                        drawTextReadable(labels[i].text, x, yy);
                    }
                }
                ctx.restore();
            }
        };

        if (notes) {
            for (const n of notes) {
                if (n.t < renderT - missMarkerDuration - 0.2) continue;
                if (n.t > renderT + 3) break;
                if (n.mt) continue;
                const key = noteKey(n, n.t);
                const result = noteResults.get(key);
                if (result) drawIndicator(n.s, n.f, n.t, result);
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t < renderT - missMarkerDuration - 0.2) continue;
                if (c.t > renderT + 3) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    const key = noteKey(cn, c.t);
                    const result = noteResults.get(key);
                    if (result) drawIndicator(cn.s, cn.f, c.t, result);
                }
            }
        }

        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            if (nowPoint) {
                const x = hw.fretX(detectedFret, nowPoint.scale, W);
                const y = nowPoint.y * H;
                ctx.save();
                ctx.globalAlpha = Math.min(1, detectedConfidence);
                ctx.fillStyle = '#44ddff';
                ctx.shadowColor = '#44ddff';
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 7px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(detectedFret, x, y);
                ctx.restore();
            }
        }
    }

    function attachInstanceRoot() {
        const target = container || document.getElementById('player');
        if (target && !target.contains(instanceRoot)) {
            target.appendChild(instanceRoot);
        }
    }

    function injectButton(bar) {
        const controls = bar || document.getElementById('player-controls');
        if (!controls) return;

        if (detectBtn && detectBtn.isConnected) return;

        const closeBtn = controls.querySelector(':scope > button:last-of-type');

        detectBtn = document.createElement('button');
        detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        detectBtn.textContent = 'Detect';
        detectBtn.title = 'Toggle real-time note detection & scoring';
        detectBtn.onclick = toggle;
        if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(detectBtn, closeBtn);
        else controls.appendChild(detectBtn);

        gearBtn = document.createElement('button');
        gearBtn.className = 'nd-gear-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        gearBtn.textContent = '\u2699';
        gearBtn.title = 'Note detection settings';
        gearBtn.onclick = showSettings;
        if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(gearBtn, closeBtn);
        else controls.appendChild(gearBtn);

        attachInstanceRoot();

        updateButton();
    }

    function updateButton() {
        if (!detectBtn) return;
        const loading = detectionMethod === 'crepe' && _ndShared.modelLoading;
        if (loading) {
            detectBtn.textContent = 'Detect (loading model...)';
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-400 transition';
        } else if (enabled) {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            detectBtn.textContent = 'Detect \u2713';
        } else {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
        }
        if (gearBtn) gearBtn.classList.toggle('hidden', !enabled);
    }

    // Reset all per-song scoring, diagnostics, and calibration state together.
    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        score = 0;
        multiplier = 1;
        maxMultiplier = 1;
        _xpSubmittedTake = false;

        _ndAutoExitRelease = null;
        noteResults.clear();
        _scoreLedger.clear();
        _susActiveUntil.clear();
        _chordLastResult.clear();
        _ndLastMissScanT = null;

        _autoDrillMisses = _ndAutoDrillMissesSetting();
        _autoDrillMissStreak = 0;
        _autoDrillFirstMissT = NaN;
        _autoDrillLastMissT = NaN;
        _rescueBuf = new Float32Array(0);
        _rescueBufEndT = 0;

        _rescueCalls = 0;
        _rescueWindows = 0;
        _rescueHits = 0;
        _rescueSkippedSilent = 0;
        _ndVerifierRejects.length = 0;
        _ndRejectDedup.clear();
        _ndVerifyFailSnap.clear();
        _diagResetCounters();
        sectionStats = [];
        currentSection = null;
        detectedMidi = -1;
        detectedConfidence = 0;
        detectedString = -1;
        detectedFret = -1;
        detectedDisplayMidi = -1;
        lastChordScore = null;
        lastChordHit = 0;
        lastChordTotal = 0;
        lastChordTime = -Infinity;
    }

    function _resetCalibrationSamples() {
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
    }

    function _recomputeScoreToPosition(t) {
        if (!Number.isFinite(t)) return;
        for (const [key, e] of _scoreLedger) {
            if (e.t >= t) {
                _scoreLedger.delete(key);
                noteResults.delete(key);
                _susActiveUntil.delete(key);
                _chordLastResult.delete(key);
            }
        }
        const survivors = Array.from(_scoreLedger.values()).sort((a, b) => a.t - b.t);
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        score = 0;
        multiplier = 1;
        maxMultiplier = 1;
        for (const e of survivors) {
            if (e.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                multiplier = _ndMultiplierForStreak(streak);
                if (multiplier > maxMultiplier) maxMultiplier = multiplier;
                score += (e.chord ? ND_BASE_CHORD : ND_BASE_SINGLE) * multiplier;
            } else {
                misses++;
                streak = 0;
                multiplier = 1;
            }
        }
    }

    function _onSongSeekReposition(e) {

        if (!enabled) return;
        const d = (e && e.detail) || {};
        const to = Number(d.to);
        if (!Number.isFinite(to)) return;

        if (drillEnabled || d.reason === 'loop-wrap') return;

        const from = Number(d.from);
        const movedBack = Number.isFinite(from) ? (to < from - 0.05) : true;
        if (!movedBack) return;
        _recomputeScoreToPosition(to);
    }

    function _seekResetBindEvents() {
        if (seekResetSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _onSongSeekReposition;
        try {
            window.slopsmith.on('song:seek', fn);
        } catch (e) {
            return;
        }
        seekResetOnSeekFn = fn;
        seekResetSubscribed = true;
    }

    function _seekResetUnbindEvents() {
        if (!seekResetSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && seekResetOnSeekFn) {
            try { window.slopsmith.off('song:seek', seekResetOnSeekFn); } catch (e) {}
        }
        seekResetSubscribed = false;
        seekResetOnSeekFn = null;
    }

    function _drillCurrentLoop() {
        const fallback = { loopA: null, loopB: null };
        if (!window.slopsmith || typeof window.slopsmith.getLoop !== 'function') {
            return fallback;
        }

        let result;
        try {
            result = window.slopsmith.getLoop();
        } catch (e) {
            return fallback;
        }

        if (!result || typeof result !== 'object') return fallback;
        return result;
    }

    function _hostGetSpeed() {

        try {
            const slider = document.getElementById('speed-slider');
            if (slider && Number.isFinite(Number(slider.value))) return Number(slider.value) / 100;
        } catch (_) {}
        const audio = document.getElementById('audio');
        return (audio && Number.isFinite(audio.playbackRate)) ? audio.playbackRate : 1;
    }

    function _hostSetSpeed(mul) {
        if (!Number.isFinite(mul) || mul <= 0) return false;
        if (typeof window.setSpeed === 'function') { window.setSpeed(mul); return true; }
        const audio = document.getElementById('audio');
        if (audio) { audio.playbackRate = mul; return true; }
        return false;
    }

    function _maybeAutoDrill() {
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);
        if (!_ndAutoDrillShouldTrigger(_autoDrillMissStreak, _autoDrillMisses, drillConductorActive, playing)) return;
        if (_ndPerfNow() < _autoDrillCooldownUntil) return;
        const first = _autoDrillFirstMissT;
        const last = _autoDrillLastMissT;
        const n = _autoDrillMissStreak;
        _autoDrillMissStreak = 0;
        _autoDrillCooldownUntil = _ndPerfNow() + 4000;
        Promise.resolve().then(() => {
            try {
                if (Number.isFinite(first) && Number.isFinite(last)) {
                    const { start, end } = _ndAutoDrillRange(first, last);
                    startDrill(start, end, { expandContext: true, label: 'Missed run', focus: `${n} missed in a row` });
                } else {
                    startDrillHere(null, { expandContext: true, label: 'Missed run' });
                }
            } catch (_) {  }
        });
    }

    // Drill mode owns loop bounds and playback speed until endDrill() restores them.
    async function startDrill(startSec, endSec, opts = {}) {
        const {
            label = null,
            focus = null,
            goal = _ND_DRILL_DEFAULT_GOAL,
            speedLadder = _ND_DRILL_DEFAULT_LADDER,
            expandContext = false,
            maxExpansions = 2,
        } = opts || {};

        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const audio = document.getElementById('audio');
        const totalDuration = Number.isFinite(songInfo.duration)
            ? songInfo.duration
            : (audio && Number.isFinite(audio.duration) ? audio.duration : null);
        if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
            console.warn('[note_detect] startDrill: no song duration available — aborting');
            return false;
        }

        const requestedStart = Math.max(0, Number(startSec));
        const judgeEnd = Math.min(totalDuration - 0.05, Number(endSec));
        if (!Number.isFinite(requestedStart) || !Number.isFinite(judgeEnd)
                || judgeEnd - requestedStart < 0.5) {
            console.warn(`[note_detect] startDrill: range too short/invalid (${requestedStart}–${judgeEnd}) — aborting`);
            return false;
        }

        const ladder = (Array.isArray(speedLadder) && speedLadder.length
            && speedLadder.every(v => Number.isFinite(v) && v > 0))
            ? speedLadder.slice().sort((a, b) => a - b)
            : _ND_DRILL_DEFAULT_LADDER.slice();

        const firstOnset = _ndChartOnsets(_hw)
            .find(t => t >= requestedStart && t <= judgeEnd);
        const judgeStart = Number.isFinite(firstOnset)
            ? Math.max(0, Math.min(requestedStart, firstOnset - _ND_DRILL_FIRST_NOTE_RUNWAY_SEC))
            : requestedStart;
        const loopStart = Math.max(0, judgeStart - _ND_DRILL_LEAD_IN_SEC);
        const loopEnd = judgeEnd;

        drillConductorSavedSpeed = _hostGetSpeed();
        drillConductorActive = true;

        _autoDrillMissStreak = 0;
        _autoDrillFirstMissT = NaN;
        _autoDrillLastMissT = NaN;
        drillConductorLadder = ladder;
        drillConductorRung = 0;
        drillConductorGoal = Number.isFinite(goal) ? Math.max(0, Math.min(1, goal)) : _ND_DRILL_DEFAULT_GOAL;
        drillConductorBest = 0;
        drillConductorFailStreak = 0;
        drillConductorTopClears = 0;
        drillConductorFocus = focus;
        drillConductorLabel = label || `${judgeStart.toFixed(1)}–${judgeEnd.toFixed(1)}s`;
        drillConductorRange = { loopStart, loopEnd, judgeStart, judgeEnd };
        drillConductorExpandsLeft = expandContext ? Math.max(0, maxExpansions) : 0;

        _drillClearWindow(judgeStart, judgeEnd);
        _ndDrillLastChartT = 0;
        _ndDrillLastScoredPerf = 0;

        window._ndAnyDrillActive = true;

        _hostSetSpeed(ladder[0]);

        let looped = false;
        try {
            if (window.slopsmith && typeof window.slopsmith.setLoop === 'function') {
                looped = await window.slopsmith.setLoop(loopStart, loopEnd, { reason: 'note_detect-drill' });
            }
        } catch (e) {
            console.warn('[note_detect] startDrill: setLoop threw:', e);
        }
        if (!looped) {
            console.warn('[note_detect] startDrill: setLoop unavailable/failed — aborting');
            endDrill('setloop-failed');
            return false;
        }
        if (audio) {
            try { await audio.play(); } catch (_) {  }
        }

        if (!enabled) { try { await enable(); } catch (_) {} }

        _drillInitBeats();

        if (window.slopsmith && typeof window.slopsmith.on === 'function') {

            if (drillConductorOnWrapFn && typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', drillConductorOnWrapFn); } catch (_) {}
            }
            drillConductorOnWrapFn = _drillConductorOnWrap;
            try { window.slopsmith.on('loop:restart', drillConductorOnWrapFn); } catch (_) {}
        }

        _drillConductorShowHud();
        console.log(`[note_detect] Drill "${drillConductorLabel}" loop=${loopStart.toFixed(1)}–${loopEnd.toFixed(1)}s judge=${judgeStart.toFixed(1)}–${judgeEnd.toFixed(1)}s ladder=${ladder.map(r => Math.round(r * 100) + '%').join('→')} goal=${Math.round(drillConductorGoal * 100)}%`);
        return true;
    }

    function startDrillHere(centerSec = null, opts = {}) {
        const _hw = resolveHw();
        const audio = document.getElementById('audio');

        let center = Number(centerSec);
        if (!Number.isFinite(center)) {
            const at = (audio && Number.isFinite(audio.currentTime)) ? audio.currentTime : NaN;
            const chartT = (_hw && typeof _hw.getTime === 'function') ? _hw.getTime() : NaN;
            center = Number.isFinite(at) ? at : chartT;
        }
        if (!Number.isFinite(center) || center < 0) {
            console.warn('[note_detect] startDrillHere: no playhead time — aborting');
            return Promise.resolve(false);
        }

        const noteTimes = _ndChartOnsets(_hw);
        if (!noteTimes.length) {
            console.warn('[note_detect] startDrillHere: chart has nothing to play — aborting');
            return Promise.resolve(false);
        }

        const beats = (_hw && _hw.getBeats) ? _hw.getBeats() : null;
        const downbeats = (Array.isArray(beats) ? beats : [])
            .filter(b => b && b.measure >= 0 && Number.isFinite(b.time))
            .map(b => b.time).sort((x, y) => x - y);
        const prevDb = (t) => { let r = null; for (const x of downbeats) { if (x <= t + 0.02) r = x; else break; } return r; };
        const nextDb = (t) => { for (const x of downbeats) if (x > t + 0.02) return x; return null; };
        const barAround = (t) => {
            let lo = prevDb(t), hi = nextDb(t);
            if (lo === null || hi === null) { lo = Math.max(0, t - 1.5); hi = t + 1.5; }
            if (hi - lo < 0.5) hi = lo + 0.5;
            return [lo, hi];
        };

        let [a, b] = barAround(center);
        const hasNote = (lo, hi) => noteTimes.some(t => t >= lo && t <= hi);
        if (!hasNote(a, b)) {
            let anchor = noteTimes[0], best = Math.abs(anchor - center);
            for (const t of noteTimes) { const d = Math.abs(t - center); if (d < best) { best = d; anchor = t; } }
            [a, b] = barAround(anchor);
        }

        const {
            goal = _ND_DRILL_DEFAULT_GOAL,
            speedLadder = _ND_DRILL_DEFAULT_LADDER,
            expandContext = true,
            maxExpansions = 3,
            label = `Drill @ ${_ndMmSs((a + b) / 2)}`,
        } = opts || {};
        return startDrill(a, b, { goal, speedLadder, expandContext, maxExpansions, label });
    }

    function _drillSyncRangeFromLoop() {
        if (!drillConductorActive || !drillConductorRange) return false;
        const lp = _drillCurrentLoop();
        if (!lp || !Number.isFinite(lp.loopA) || !Number.isFinite(lp.loopB)
                || lp.loopB - lp.loopA < 0.5) return false;
        const r = drillConductorRange;

        if (Math.abs(lp.loopA - r.loopStart) < 0.02 && Math.abs(lp.loopB - r.loopEnd) < 0.02) return false;
        const loopStart = Math.max(0, lp.loopA);
        const loopEnd = lp.loopB;
        const judgeStart = Math.min(loopEnd - 0.25, loopStart + _ND_DRILL_LEAD_IN_SEC);
        drillConductorRange = { loopStart, loopEnd, judgeStart, judgeEnd: loopEnd };
        drillConductorLabel = `${judgeStart.toFixed(1)}–${loopEnd.toFixed(1)}s`;
        _drillInitBeats();
        return true;
    }

    function _drillExpandLoop() {
        if (!drillConductorRange) return false;
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const audioEl = document.getElementById('audio');
        const dur = Number.isFinite(songInfo.duration) ? songInfo.duration
            : (audioEl && Number.isFinite(audioEl.duration) ? audioEl.duration : null);
        const cur = drillConductorRange;
        const beats = (_hw && _hw.getBeats) ? _hw.getBeats() : null;
        const downbeats = (Array.isArray(beats) ? beats : [])
            .filter(b => b && b.measure >= 0 && Number.isFinite(b.time))
            .map(b => b.time).sort((a, b) => a - b);
        const prevDb = (t) => { let r = null; for (const x of downbeats) { if (x < t - 0.05) r = x; else break; } return r; };
        const nextDb = (t) => { for (const x of downbeats) if (x > t + 0.05) return x; return null; };
        let newStart = prevDb(cur.loopStart);
        let newEnd = nextDb(cur.loopEnd);
        if (newStart === null) newStart = Math.max(0, cur.loopStart - 2);
        if (newEnd === null) newEnd = Number.isFinite(dur) ? Math.min(dur - 0.05, cur.loopEnd + 2) : cur.loopEnd + 2;
        newStart = Math.min(newStart, cur.loopStart);
        newEnd = Math.max(newEnd, cur.loopEnd);

        if (newStart >= cur.loopStart - 0.05 && newEnd <= cur.loopEnd + 0.05) return false;

        const judgeStart = Math.min(newEnd - 0.25, newStart + _ND_DRILL_LEAD_IN_SEC);
        drillConductorRange = { loopStart: newStart, loopEnd: newEnd, judgeStart, judgeEnd: newEnd };
        drillConductorLabel = `${judgeStart.toFixed(1)}–${newEnd.toFixed(1)}s +context`;

        if (Array.isArray(drillConductorLadder) && drillConductorLadder.length) {
            drillConductorRung = Math.max(0, drillConductorRung - 1);
            _hostSetSpeed(drillConductorLadder[drillConductorRung] || 1);
        }
        drillConductorBest = 0;
        drillConductorFailStreak = 0;
        drillConductorTopClears = 0;
        try {
            if (window.slopsmith && typeof window.slopsmith.setLoop === 'function') {
                window.slopsmith.setLoop(newStart, newEnd, { reason: 'note_detect-drill-expand' });
            }
        } catch (e) { console.warn('[note_detect] drill expand setLoop threw:', e); }
        _drillInitBeats();
        _drillConductorUpdateHud({ expanded: true });
        _drillClearWindow(judgeStart, newEnd);
        return true;
    }

    function _drillChartedCount(a, b) {
        const _hw = resolveHw();
        if (!_hw) return 0;
        const inWin = (item) => {
            const t = Number.isFinite(item && item.t) ? item.t
                : (item && Number.isFinite(item.time) ? item.time : null);
            return t != null && t >= a && t <= b;
        };
        let n = 0;
        const notes = _ndChartNotes(_hw);
        for (const x of notes) if (inWin(x)) n++;
        const chords = _ndChartChords(_hw);
        for (const x of chords) if (inWin(x)) n++;
        return n;
    }

    function _drillClearWindow(a, b) {
        for (const [key, v] of noteResults) {
            const t = Number.isFinite(v && v.noteTime) ? v.noteTime
                : parseFloat(String(key).split('_')[0]);
            if (Number.isFinite(t) && t >= a && t <= b) {
                noteResults.delete(key);
                _susActiveUntil.delete(key);

                _chordLastResult.delete(key);
            }
        }
    }

    function _drillConductorOnWrap() {
        if (!drillConductorActive || !drillConductorRange) return;

        _drillSyncRangeFromLoop();
        _ndDrillLastScoredPerf = _ndPerfNow();
        const { judgeStart, judgeEnd } = drillConductorRange;
        const arr = [];
        for (const v of noteResults.values()) arr.push(v);

        const charted = _drillChartedCount(judgeStart, judgeEnd);

        const chordTimeKeys = new Set();
        for (const key of noteResults.keys()) {
            const s = String(key);
            if (s.endsWith('_chord')) chordTimeKeys.add(s.slice(0, -6));
        }
        let hits = 0;
        for (const [key, j] of noteResults) {
            const t = Number.isFinite(j && j.noteTime) ? j.noteTime : null;
            if (t == null || t < judgeStart || t > judgeEnd) continue;
            if (!String(key).endsWith('_chord') && chordTimeKeys.has(t.toFixed(3))) continue;
            if (j.hit) hits++;
        }

        const score = _ndDrillPassScore(hits, charted);
        if (score == null) return;
        if (score > drillConductorBest) drillConductorBest = score;

        _drillClearWindow(judgeStart, judgeEnd);

        const decision = _ndDrillRampDecision(
            score, drillConductorGoal, drillConductorRung, drillConductorLadder.length,
            drillConductorTopClears, _ND_DRILL_FULLSPEED_REPS);
        if (decision.action === 'graduate') {

            if (drillConductorExpandsLeft > 0 && _drillExpandLoop()) {
                drillConductorExpandsLeft--;
                return;
            }
            drillConductorTopClears++;
            _drillConductorUpdateHud({ lastScore: score, graduated: true });
            endDrill('graduated');
            return;
        }
        if (decision.action === 'consolidate') {

            drillConductorTopClears++;
            drillConductorFailStreak = 0;
            const repsLeft = Math.max(0, _ND_DRILL_FULLSPEED_REPS - drillConductorTopClears);
            _drillConductorUpdateHud({ lastScore: score, consolidate: true, repsLeft });
        } else if (decision.action === 'advance') {

            drillConductorRung = decision.nextRung;
            drillConductorBest = 0;
            drillConductorFailStreak = 0;
            drillConductorTopClears = 0;
            const toPct = Math.round((drillConductorLadder[drillConductorRung] || 1) * 100);
            _hostSetSpeed(drillConductorLadder[drillConductorRung]);
            _drillConductorUpdateHud({ lastScore: score, advanced: true, toPct });
        } else {

            drillConductorTopClears = 0;

            drillConductorFailStreak++;
            if (drillConductorFailStreak >= 3) {
                if (drillConductorRung > 0) {
                    drillConductorRung--;
                } else {
                    const cur = drillConductorLadder[0] || 1;
                    const slower = Math.max(0.4, Math.round((cur - 0.15) * 100) / 100);
                    if (slower < cur - 1e-6) drillConductorLadder.unshift(slower);
                }
                const sp = drillConductorLadder[drillConductorRung] || 1;
                drillConductorBest = 0;
                drillConductorFailStreak = 0;
                _hostSetSpeed(sp);
                _drillConductorUpdateHud({ lastScore: score, slowedToPct: Math.round(sp * 100) });
            } else {

                _drillConductorUpdateHud({ lastScore: score, misses: _ndSummarizeWindowMisses(arr, judgeStart, judgeEnd) });
            }
        }

    }

    function _drillConductorTick() {
        if (!drillConductorActive) return;
        const _hw = resolveHw();
        if (!_hw || !_hw.getTime) return;
        const ct = _hw.getTime();
        if (_ndDrillLastChartT > 0 && ct >= 0 && ct < _ndDrillLastChartT - 1.0) {

            _drillBeatIdx = 0;

            if (_ndPerfNow() - _ndDrillLastScoredPerf > 1200) _drillConductorOnWrap();
        } else {

            const speed = (drillConductorLadder && drillConductorLadder[drillConductorRung]) || 1;
            _drillScheduleDueClicks(ct, speed);
        }
        _ndDrillLastChartT = ct;
    }

    function _drillInitBeats() {
        _drillBeatTimes = [];
        _drillBeatIdx = 0;
        if (!drillConductorRange) return;
        const _hw = resolveHw();
        const { loopStart, loopEnd, judgeStart } = drillConductorRange;
        const beats = (_hw && _hw.getBeats) ? _hw.getBeats() : null;
        if (Array.isArray(beats) && beats.length) {
            for (const b of beats) {
                const bt = (typeof b === 'number') ? b : (b && Number.isFinite(b.time) ? b.time : null);
                if (bt != null && bt >= loopStart - 1e-6 && bt <= loopEnd) _drillBeatTimes.push(bt);
            }
        }
        if (!_drillBeatTimes.length) {
            const bpm = (_hw && _hw.getBPM) ? _hw.getBPM(judgeStart) : 100;
            const beat = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 100);
            for (let bt = loopStart; bt <= loopEnd; bt += beat) _drillBeatTimes.push(bt);
        }
    }

    function _drillScheduleDueClicks(ct, speed) {
        if (!audioCtx || !_drillBeatTimes.length) return;
        const sp = (Number.isFinite(speed) && speed > 0) ? speed : 1;
        while (_drillBeatIdx < _drillBeatTimes.length
               && _drillBeatTimes[_drillBeatIdx] <= ct + _CLICK_LOOKAHEAD_S) {
            const bt = _drillBeatTimes[_drillBeatIdx];
            const at = audioCtx.currentTime + Math.max(0, (bt - ct) / sp);
            const accent = (_drillBeatIdx % 4 === 0);
            try {
                const osc = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                osc.frequency.value = accent ? 1320 : 880;
                g.gain.setValueAtTime(0.0001, at);
                g.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.26, at + 0.004);
                g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
                osc.connect(g); g.connect(audioCtx.destination);
                osc.start(at); osc.stop(at + 0.06);
            } catch (_) {  }
            _drillBeatIdx++;
        }
    }

    function endDrill(reason = 'user') {
        if (!drillConductorActive) return;
        drillConductorActive = false;

        _autoDrillMissStreak = 0;
        _autoDrillFirstMissT = NaN;
        _autoDrillLastMissT = NaN;
        _autoDrillCooldownUntil = _ndPerfNow() + 4000;
        const graduated = reason === 'graduated';
        const label = drillConductorLabel;
        const best = drillConductorBest;

        if (Number.isFinite(drillConductorSavedSpeed)) _hostSetSpeed(drillConductorSavedSpeed);

        if (reason !== 'song-changed') {
            try {
                if (window.slopsmith && typeof window.slopsmith.clearLoop === 'function') {
                    window.slopsmith.clearLoop({ reason: 'note_detect-drill-end' });
                }
            } catch (e) {
                console.warn('[note_detect] endDrill: clearLoop threw:', e);
            }
        }
        window._ndAnyDrillActive = false;

        if (drillConductorOnWrapFn && window.slopsmith && typeof window.slopsmith.off === 'function') {
            try { window.slopsmith.off('loop:restart', drillConductorOnWrapFn); } catch (_) {}
        }
        drillConductorOnWrapFn = null;
        _drillConductorHideHud(graduated);

        try {
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                window.slopsmith.emit('notedetect:drill-ended', { reason, graduated, label, best });
            }
        } catch (_) {}

        drillConductorLadder = null;
        drillConductorRung = 0;
        drillConductorBest = 0;
        drillConductorFocus = null;
        drillConductorLabel = null;
        drillConductorSavedSpeed = null;
        drillConductorRange = null;
        console.log(`[note_detect] Drill ended (${reason})${graduated ? ` — graduated "${label}" at ${Math.round(best * 100)}%` : ''}`);
    }

    function _drillConductorShowHud() {

        if (_drillHudRemoveTimer) { clearTimeout(_drillHudRemoveTimer); _drillHudRemoveTimer = null; }
        let hud = document.getElementById('nd-drill-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'nd-drill-hud';
            hud.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[210] min-w-[330px] bg-dark-800 border-2 border-blue-700 rounded-xl shadow-2xl px-4 py-2 text-sm';
            document.body.appendChild(hud);
        }
        _drillConductorUpdateHud();
    }

    function _drillConductorUpdateHud(extra = {}) {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        const { lastScore = null, graduated = false, advanced = false, consolidate = false, repsLeft = null, toPct = null, slowedToPct = null, misses = null, expanded = false } = extra;
        const speedPct = drillConductorLadder
            ? Math.round((drillConductorLadder[drillConductorRung] || 1) * 100) : 100;
        const goalPct = Math.round((drillConductorGoal || 0) * 100);
        const bestPct = Math.round((drillConductorBest || 0) * 100);
        const lastPct = lastScore != null ? Math.round(lastScore * 100) : null;
        const atTop = drillConductorLadder
            ? drillConductorRung >= drillConductorLadder.length - 1 : true;

        let banner;
        if (graduated) {
            banner = `<div class="text-green-300 font-bold text-sm">✓ Nailed it at full speed — drill complete!</div>`;
        } else if (expanded) {
            banner = `<div class="text-green-300 font-bold text-sm">✓ Nailed! Now widening the loop — play into and out of it</div>`;
        } else if (advanced) {
            banner = `<div class="text-green-300 font-bold text-sm">▲ Time to go faster — now ${toPct != null ? toPct : speedPct}% speed</div>`;
        } else if (consolidate) {
            const n = repsLeft != null ? repsLeft : 0;
            banner = `<div class="text-green-300 font-bold text-sm">✓ Clean at full speed! ${n > 0 ? `Lock it in — ${n} more to graduate` : 'One more to graduate'}</div>`;
        } else if (slowedToPct != null) {
            banner = `<div class="text-blue-300 font-bold text-sm">▼ Slowing to ${slowedToPct}% — get it solid here first</div>`;
        } else if (lastPct != null) {
            const ok = lastPct >= goalPct;
            banner = ok
                ? `<div class="text-green-300 text-sm">Last pass <span class="font-bold">${lastPct}%</span> — clean!</div>`
                : `<div class="text-amber-200 text-sm">Last pass <span class="font-bold">${lastPct}%</span> — need <span class="font-bold">${goalPct}%</span> to speed up. Keep going.</div>`;
        } else {
            banner = `<div class="text-gray-300 text-sm">Play the loop — hit <span class="font-bold">${goalPct}%</span> clean to speed up.</div>`;
        }

        const sub = `<div class="text-gray-500 text-[11px] mt-0.5">🎯 ${speedPct}% speed${atTop ? ' (full)' : ''} · best ${bestPct}%${drillConductorFocus ? ' · ' + _ndEscapeHtml(drillConductorFocus) : (drillConductorLabel ? ' · ' + _ndEscapeHtml(drillConductorLabel) : '')}</div>`;

        const howColor = { missed: 'text-red-300', late: 'text-amber-300', early: 'text-amber-300', sharp: 'text-purple-300', flat: 'text-purple-300', wrong: 'text-red-300' };
        let missList = '';
        if (Array.isArray(misses) && misses.length) {
            const shown = misses.slice(0, 6).map((m) => {
                const pos = `S${(Number.isInteger(m.s) ? m.s + 1 : '?')}·${Number.isInteger(m.f) ? 'fr' + m.f : '?'}`;
                return `<div class="flex justify-between gap-3"><span class="text-gray-300">${pos}</span><span class="${howColor[m.how] || 'text-gray-400'}">${m.detail}</span></div>`;
            }).join('');
            const more = misses.length > 6 ? `<div class="text-gray-600 text-[10px]">+${misses.length - 6} more</div>` : '';
            missList = `<div class="mt-1.5 pt-1.5 border-t border-gray-700 text-[11px] font-mono leading-tight">`
                + `<div class="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Missed this pass</div>${shown}${more}</div>`;
        }

        const _mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        const rng = drillConductorRange || {};
        const nb = (edge, d, t) => `<button class="nd-loop-nudge px-2 py-0.5 bg-dark-600 hover:bg-dark-500 rounded text-gray-300" data-edge="${edge}" data-d="${d}" title="${t}">${d < 0 ? '−' : '+'}</button>`;
        const loopRow = (Number.isFinite(rng.judgeStart) && Number.isFinite(rng.judgeEnd))
            ? `<div class="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-700 text-[11px]">
                   <span class="text-gray-500">Loop</span>
                   ${nb('start', -2, 'Start 2s earlier')}<span class="text-gray-300 font-mono">${_mmss(rng.judgeStart)}</span>${nb('start', 2, 'Start 2s later')}
                   <span class="text-gray-600">–</span>
                   ${nb('end', -2, 'End 2s earlier')}<span class="text-gray-300 font-mono">${_mmss(rng.judgeEnd)}</span>${nb('end', 2, 'End 2s later')}
               </div>`
            : '';
        hud.innerHTML = `
            <div class="flex items-start gap-3">
                <div class="flex-1">${banner}${sub}${missList}${loopRow}</div>
                <button id="nd-drill-end" class="px-2.5 py-1 bg-dark-600 hover:bg-dark-500 text-gray-200 rounded-lg text-xs font-semibold whitespace-nowrap" title="End drill">✕ End</button>
            </div>`;
        const endBtn = hud.querySelector('#nd-drill-end');
        if (endBtn) endBtn.onclick = () => endDrill('user');
        hud.querySelectorAll('.nd-loop-nudge').forEach((b) => {
            b.onclick = () => _drillAdjustLoop(b.dataset.edge, Number(b.dataset.d));
        });
    }

    function _drillAdjustLoop(edge, d) {
        if (!drillConductorActive || !drillConductorRange || !Number.isFinite(d)) return;
        let start = drillConductorRange.judgeStart;
        let end = drillConductorRange.judgeEnd;
        if (edge === 'start') start = Math.max(0, start + d);
        else end = end + d;
        if (!(end - start >= 0.5)) return;

        startDrill(start, end, { goal: drillConductorGoal }).catch(() => {});
    }

    function _drillConductorHideHud(graduated) {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        if (graduated) {

            _drillConductorUpdateHud({ graduated: true });
            _drillHudRemoveTimer = setTimeout(() => {
                _drillHudRemoveTimer = null;
                if (hud.isConnected) hud.remove();
            }, 3000);
        } else {
            hud.remove();
        }
    }

    function _drillResetIteration(startT) {
        drillIterHits = 0;
        drillIterMisses = 0;
        drillIterStreak = 0;
        drillIterBestStreak = 0;

        drillIterStartT = Number.isFinite(startT) ? startT : null;
    }

    function _drillSnapshotIteration() {
        const total = drillIterHits + drillIterMisses;

        if (total === 0) return;
        const accuracy = Math.round((drillIterHits / total) * 100);

        const durationSec = (Number.isFinite(drillActiveLoopA) && Number.isFinite(drillActiveLoopB))
            ? Math.max(0, drillActiveLoopB - drillActiveLoopA)
            : null;
        drillIterations.push({
            idx: drillNextIdx++,
            hits: drillIterHits,
            misses: drillIterMisses,
            accuracy,
            bestStreak: drillIterBestStreak,
            durationSec,
            ts: Date.now(),
        });

        if (drillIterations.length > DRILL_MAX_ITERATIONS) {
            drillIterations.splice(0, drillIterations.length - DRILL_MAX_ITERATIONS);
        }
        drillDirty = true;
    }

    function _drillOnLoopRestart(e) {
        const rawTime = (e && e.detail) ? e.detail.time : undefined;
        const wrapTime = Number.isFinite(rawTime) ? rawTime : null;

        _drillSnapshotIteration();

        _drillResetIteration(wrapTime);
    }

    function _drillOnSongChanged() {

        if (drillConductorActive) endDrill('song-changed');

        drillIterations = [];
        _drillResetIteration(null);
        drillActiveLoopA = null;
        drillActiveLoopB = null;
        drillNextIdx = 1;
        drillEnabled = false;
        drillDirty = true;
    }

    function _drillBindEvents() {
        if (drillSubscribed) return;

        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;

        const onLoopRestart = _drillOnLoopRestart;
        const onSongChanged = _drillOnSongChanged;

        const onLoopChanged = () => _drillSyncFromLoopState();
        try {
            window.slopsmith.on('loop:restart', onLoopRestart);
            window.slopsmith.on('song:loaded', onSongChanged);
            window.slopsmith.on('song:ended', onSongChanged);
            window.slopsmith.on('playback:loop-set', onLoopChanged);
            window.slopsmith.on('playback:loop-cleared', onLoopChanged);
        } catch (e) {

            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', onLoopRestart); } catch (_) {}
                try { window.slopsmith.off('song:loaded', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('song:ended', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('playback:loop-set', onLoopChanged); } catch (_) {}
                try { window.slopsmith.off('playback:loop-cleared', onLoopChanged); } catch (_) {}
            }
            return;
        }
        drillOnLoopRestartFn = onLoopRestart;
        drillOnSongChangedFn = onSongChanged;
        drillOnLoopChangedFn = onLoopChanged;
        drillSubscribed = true;
    }

    let _chartStateReadWarned = false;
    // Read transformed notes and metadata as one coherent chart context.
    function _readChartStateFromHw() {
        const info = (hw && hw.getSongInfo) ? (hw.getSongInfo() || {}) : {};
        const arrangement = info.arrangement
            ? _ndArrangementKindFromName(info.arrangement) : 'guitar';

        const effectiveTuning = (hw && typeof hw.getTuning === 'function')
            ? hw.getTuning() : undefined;
        const effectiveCapo = (hw && typeof hw.getCapo === 'function')
            ? hw.getCapo() : undefined;
        const hasEffectiveTuning = Array.isArray(effectiveTuning);
        const nextTuning = hasEffectiveTuning
            ? effectiveTuning
            : (Array.isArray(info.tuning) ? info.tuning : defaultTuningOffsets);
        const nextCapo = Number.isFinite(effectiveCapo)
            ? effectiveCapo
            : (Number.isFinite(info.capo) ? info.capo : 0);

        const hostStringCount = (hw && hw.getStringCount) ? hw.getStringCount() : undefined;
        let stringCount;
        if (Number.isFinite(hostStringCount)) {
            stringCount = hostStringCount;
        } else if (info.arrangement) {
            const tuneLen = nextTuning.length;

            const consistent = arrangement === 'bass'
                ? (tuneLen === 4 || tuneLen === 5 || (hasEffectiveTuning && tuneLen === 6))
                : (tuneLen === 6 || tuneLen === 7 || tuneLen === 8);
            if (consistent) {
                stringCount = tuneLen;
            } else {
                stringCount = arrangement === 'bass' ? 4 : 6;
            }
        } else {
            stringCount = nextTuning.length;
        }
        return { arrangement, stringCount, tuningOffsets: nextTuning, capo: nextCapo };
    }

    function _chartStateEquals(next) {
        if (currentArrangement !== next.arrangement
            || currentStringCount !== next.stringCount
            || capo !== next.capo
            || tuningOffsets.length !== next.tuningOffsets.length) return false;
        for (let i = 0; i < next.tuningOffsets.length; i++) {
            const off = Number.isFinite(next.tuningOffsets[i]) ? Math.trunc(next.tuningOffsets[i]) : 0;
            if (tuningOffsets[i] !== off) return false;
        }
        return true;
    }

    // Commit chart context atomically; transient host failures preserve prior state.
    function _syncChartStateFromHw() {
        let next;
        try {
            next = _readChartStateFromHw();
            _chartStateReadWarned = false;
        } catch (e) {
            if (!_chartStateReadWarned) {
                _chartStateReadWarned = true;
                console.warn('[note_detect] chart-state refresh failed; keeping previous context:',
                    e && e.message ? e.message : e);
            }
            return null;
        }
        if (_chartStateEquals(next)) return false;

        const nextOffsets = next.tuningOffsets === defaultTuningOffsets
            ? defaultTuningOffsets
            : next.tuningOffsets.map((off) => Number.isFinite(off) ? Math.trunc(off) : 0);
        currentArrangement = next.arrangement;
        currentStringCount = next.stringCount;
        tuningOffsets = nextOffsets;
        capo = next.capo;
        return true;
    }

    // The desktop verifier is republished whenever chart content or pitch context changes.
    function _ndChartSignature({ syncChartState = true } = {}) {
        if (!hw || typeof hw.getNotes !== 'function') return '';

        if (syncChartState && _syncChartStateFromHw() === null) return _ndVerifierChartSig;

        const notes = _ndChartNotes();
        const n = notes.length;
        let c = 0;

        let fnv = 0x811c9dc5;
        const mix = (v) => { fnv ^= (v | 0); fnv = Math.imul(fnv, 0x01000193); };

        const mixNote = (nn) => {
            mix(Math.round((Number.isFinite(nn.t) ? nn.t : 0) * 1000));
            mix(((nn.s | 0) * 100) + (nn.f | 0));
            mix(Math.round((Number.isFinite(nn.sus) ? nn.sus : 0) * 1000));
            mix((nn.ho ? 1 : 0) | (nn.po ? 2 : 0) | (nn.b ? 4 : 0)
                | (nn.sl ? 8 : 0) | (nn.hm ? 16 : 0) | (nn.mt ? 32 : 0));
        };
        for (const nn of notes) if (nn) mixNote(nn);
        for (const ch of _ndChartChords()) {
            const members = (ch && ch.notes) || [];
            c += members.length;
            mix(Math.round((ch && Number.isFinite(ch.t) ? ch.t : 0) * 1000));

            for (const m of members) if (m) mixNote({ ...m, t: (ch && ch.t) });
        }

        for (let s = 0; s < currentStringCount; s++) {
            const off = tuningOffsets[s];
            mix(Number.isFinite(off) ? Math.trunc(off) : 0);
        }

        return n + ':' + c + ':' + currentArrangement + ':' + currentStringCount
            + ':' + capo + ':' + timingTolerance + ':' + pitchTolerance
            + ':' + (fnv >>> 0);
    }

    // Submit a snapshot and retain the signature of exactly what the engine received.
    async function _ndPushChartToBridge({ chartStateSynced = false } = {}) {

        if (_ndHostChartSuspended || _ndOtherOwnsOurSlot()) return;
        if (!chartStateSynced && _syncChartStateFromHw() === null) return;
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndVerifierChartSig = '';
        _ndLastPushedPlayhead = 0;

        if (!usingDesktopBridge || usingNativeFrames || !bridgeDesktop || !bridgeDesktop.audio) return;
        if (!_ndBridgeVerifierAvailable()) {

            return;
        }
        if (!hw || typeof hw.getNotes !== 'function' || typeof hw.getChords !== 'function') return;

        const notes = [];
        const byId = new Map();

        const chordGroups = new Map();
        const chordKeyById = new Map();

        const single = _ndChartNotes();
        for (const n of single) {
            if (!n || n.mt) continue;
            const id = noteKey(n, n.t);
            if (byId.has(id)) continue;
            const entry = {
                id,
                t: n.t,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            notes.push(entry);
            byId.set(id, { ...n });
        }

        const chords = _ndChartChords();
        for (const c of chords) {
            for (const cn of (c.notes || [])) {
                if (!cn || cn.mt) continue;
                const id = noteKey(cn, c.t);
                if (byId.has(id)) continue;
                const entry = {
                    id,
                    t: c.t,
                    s: cn.s,
                    f: cn.f,
                    sus: Number.isFinite(cn.sus) ? cn.sus : 0,
                    ho: !!cn.ho, po: !!cn.po, b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                };
                notes.push(entry);
                byId.set(id, { ...cn, t: c.t });
            }
        }

        const byTime = new Map();
        for (const e of notes) {
            const tk = e.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(e);
        }
        for (const [tk, grp] of byTime) {
            if (grp.length < 2) continue;
            const chordKey = tk + '_chord';
            let maxSus = 0;
            for (const e of grp) if ((e.sus || 0) > maxSus) maxSus = e.sus || 0;
            chordGroups.set(chordKey, {
                t: grp[0].t,
                memberIds: grp.map(e => e.id),
                memberNotes: grp.map(e => ({ s: e.s, f: e.f })),
                maxSus,
            });
            for (const e of grp) chordKeyById.set(e.id, chordKey);
        }

        const pushedChartSig = _ndChartSignature({ syncChartState: false });
        try {
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            const ok = await _ndBridgeSetChart({
                arrangement: currentArrangement,
                stringCount: currentStringCount,
                tuningOffsets: tuningOffsets.slice(0, currentStringCount),
                capo,

                pitchCheckCents: pitchTolerance,
                harmonicSnr: verifyParams.harmonicSnr,

                fundamentalRatio: verifyParams.fundamentalRatio,

                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes,
            });

            if (ok === null || ok === false) return;
            _ndVerifierChartById = byId;
            _ndVerifierChords = chordGroups;
            _ndVerifierChordKeyOf = chordKeyById;
            _ndPendingChords = new Map();
            _ndVerifierChartSig = pushedChartSig;
            _ndUsingEngineVerifier = true;
            console.log(`[note_detect] engine chart verifier active — ${notes.length} notes pushed`
                + ` (${chordGroups.size} chords)`);
        } catch (e) {
            console.warn('[note_detect] setChart failed, falling back to matchNotes:',
                e && e.message ? e.message : e);
        }
    }

    // Convert native verifier results into the same judgment path used in the browser.
    async function _ndDrainEngineVerdicts() {
        if (!_ndUsingEngineVerifier || !bridgeDesktop || !bridgeDesktop.audio) return;

        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const playheadAudio = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);

        if (playheadAudio < _ndLastPushedPlayhead - 0.25) {
            for (const [id, cn] of _ndVerifierChartById) {
                if (cn && Number.isFinite(cn.t) && cn.t >= playheadAudio) {
                    noteResults.delete(id);
                    _scoreLedger.delete(id);
                    _susActiveUntil.delete(id);
                }
            }

            for (const [ckey, grp] of _ndVerifierChords) {
                if (grp && Number.isFinite(grp.t) && grp.t >= playheadAudio) {
                    noteResults.delete(ckey);
                    _scoreLedger.delete(ckey);
                    _ndPendingChords.delete(ckey);
                }
            }
        }
        _ndLastPushedPlayhead = playheadAudio;

        let verdicts = null;
        try {
            verdicts = await _ndBridgeGetVerdicts(playheadAudio, playing);
        } catch (e) {
            console.warn('[note_detect] getNoteVerdicts failed:', e && e.message ? e.message : e);
            return;
        }
        if (!Array.isArray(verdicts) || verdicts.length === 0) return;
        if (verdicts.length > _ndDrainStats.maxBatch) _ndDrainStats.maxBatch = verdicts.length;

        for (const v of verdicts) {
            if (!v || typeof v.id !== 'string') continue;
            const cn = _ndVerifierChartById.get(v.id);
            if (!cn) { _ndDrainStats.dropUnknownId++; continue; }

            const engineDetectedRaw = !!v.detected;
            const strikeCtx = _ndStrikeLevelContext(cn.t);
            if (v.detected && _ndLevelSamples.length > 0) {

                if (strikeCtx.silenceWouldTrigger) {
                    const expectedMidiSg = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    _ndLogVerifierRejectOnce('silence:' + v.id, {
                        reason: 'SILENCE_GATE',
                        path: 'desktop-engine-verifier',
                        skipOpenDomainPitchFallback: true,
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi: expectedMidiSg,
                        engineDetectedRaw,
                        engineDetected: false,
                        silenceGateApplied: true,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        inputPeakPct: strikeCtx.strikePeakPct,
                        rendererPitchPolled: false,
                        detectedSongTime: Number.isFinite(v.detectedSongTime)
                            ? v.detectedSongTime
                            : null,
                        pitchErrorCents: Number.isFinite(v.centsError) ? v.centsError : null,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                    v.detected = false;
                }
            }

            const chordKey = _ndVerifierChordKeyOf.get(v.id);
            if (chordKey) {

                if (_ndAlreadyCounted(chordKey)) { _ndDrainStats.suppressedRedelivery++; continue; }
                let pc = _ndPendingChords.get(chordKey);
                if (!pc) { pc = new Map(); _ndPendingChords.set(chordKey, pc); }
                pc.set(v.id, v);
                const grp = _ndVerifierChords.get(chordKey);
                if (grp && pc.size >= grp.memberIds.length) {
                    _ndFinalizeChordVerdict(chordKey, grp, pc);
                    _ndPendingChords.delete(chordKey);
                }
                continue;
            }

            const key = v.id;
            if (_ndAlreadyCounted(key)) { _ndDrainStats.suppressedRedelivery++; continue; }

            const expectedMidi = _ndMidiFromStringFret(
                cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (v.detected) {

                const judgedAt = v.detectedSongTime;
                const pitchError = Number.isFinite(v.centsError) ? v.centsError : null;
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;

                const lenientPitch = !!(cn.b || cn.sl || cn.hm);
                const judgment = makeMatchedJudgment(
                    cn, cn.t, judgedAt, expectedMidi, detectedMidiForJudgment, 1,
                    { pitchError, pitchThresholdCents: lenientPitch ? 600 : undefined }
                );
                if (!judgment.hit) {
                    const teReason = judgment.timingState === 'EARLY' || judgment.timingState === 'LATE'
                        ? 'TIMING_FAIL'
                        : (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT'
                            ? 'PITCH_FAIL'
                            : 'UNKNOWN');
                    _ndLogVerifierRejectOnce(key, {
                        reason: teReason,
                        path: 'desktop-engine-verifier',
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        detectedMidi: detectedMidiForJudgment,
                        confidence: 1,
                        engineDetectedRaw,
                        engineDetected: true,
                        silenceGateApplied: false,
                        detectedSongTime: judgedAt,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        rendererPitchPolled: false,
                        timingErrorMs: judgment.timingError,
                        pitchErrorCents: judgment.pitchError,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                }
                recordJudgment(key, judgment);
            } else {

                const t = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
                if (!_ndRejectDedup.has('silence:' + key)) {
                    let timingErrorMs = null;
                    if (Number.isFinite(v.timingErrorMs)) timingErrorMs = v.timingErrorMs;
                    else if (Number.isFinite(v.timingError)) timingErrorMs = v.timingError;
                    else if (Number.isFinite(v.detectedSongTime) && Number.isFinite(cn.t)) {
                        timingErrorMs = Math.round((v.detectedSongTime - cn.t) * 1000);
                    }
                    _ndLogVerifierRejectOnce(key, {
                        reason: 'NO_VERDICT',
                        path: 'desktop-engine-verifier',
                        skipOpenDomainPitchFallback: true,
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        engineDetectedRaw,
                        engineDetected: false,
                        silenceGateApplied: false,
                        detectedSongTime: Number.isFinite(v.detectedSongTime)
                            ? v.detectedSongTime
                            : null,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        rendererPitchPolled: false,
                        timingErrorMs,
                        pitchErrorCents: Number.isFinite(v.centsError) ? v.centsError : null,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                }
                recordJudgment(key, makeMissJudgment(cn, cn.t, t, expectedMidi));
            }
        }

        for (const [ckey, pc] of _ndPendingChords) {
            const grp = _ndVerifierChords.get(ckey);
            if (!grp) { _ndPendingChords.delete(ckey); continue; }
            if (playheadAudio > grp.t + (grp.maxSus || 0) + timingTolerance + 1.0) {
                _ndFinalizeChordVerdict(ckey, grp, pc);
                _ndPendingChords.delete(ckey);
            }
        }
    }

    function _ndFinalizeChordVerdict(chordKey, grp, verdictMap) {
        if (_ndAlreadyCounted(chordKey)) return;
        let hitStrings = 0;
        let detectedTime = null;
        let bestCents = null;
        for (const id of grp.memberIds) {
            const v = verdictMap.get(id);
            if (v && v.detected) {
                hitStrings++;
                if (detectedTime === null) detectedTime = v.detectedSongTime;
                if (bestCents === null && Number.isFinite(v.centsError)) bestCents = v.centsError;
            }
        }
        const totalStrings = grp.memberIds.length;
        const score = totalStrings > 0 ? hitStrings / totalStrings : 0;
        const lead = _ndVerifierChartById.get(grp.memberIds[0]) || { s: 0, f: 0 };
        const expectedMidi = _ndMidiFromStringFret(
            lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
        );
        const lateGraceMs = Math.min((grp.maxSus || 0) * 1000, 1000);

        const chordIsHit = score >= chordHitRatio && detectedTime !== null;
        if (chordIsHit) {
            const detMidi = Number.isFinite(bestCents) ? expectedMidi + bestCents / 100 : null;
            recordJudgment(chordKey, makeMatchedJudgment(
                lead, grp.t, detectedTime, expectedMidi, detMidi, 1,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings,
                  score, pitchError: bestCents, lateGraceMs }
            ));
        } else {

            const avOffsetSecMiss = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const missJudgedAt = (hw.getTime ? hw.getTime() : 0) + avOffsetSecMiss - latencyOffset;
            _ndLogVerifierRejectOnce(chordKey, {
                reason: 'CHORD_RATIO_FAIL',
                noteTime: grp.t,
                chord: true,
                expectedMidi,
                hitStrings,
                totalStrings,
                chordScore: score,
            });
            recordJudgment(chordKey, makeMissJudgment(
                lead, grp.t, missJudgedAt, expectedMidi,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings, score, lateGraceMs }
            ));
        }

        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const nowSongT = (hw.getTime ? hw.getTime() : 0) + avOffsetSec;
        const missAt = nowSongT - latencyOffset;
        for (const id of grp.memberIds) {
            if (noteResults.has(id)) continue;
            const mcn = _ndVerifierChartById.get(id);
            if (!mcn) continue;
            const mExpectedMidi = _ndMidiFromStringFret(
                mcn.s, mcn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );

            const constituentDetected = !!(verdictMap.get(id) || {}).detected;
            let mJudgment;
            if (chordIsHit) {

                const lenientPitch = !!(mcn.b || mcn.sl || mcn.hm);
                const mDetMidi = Number.isFinite(bestCents)
                    ? mExpectedMidi + bestCents / 100 : null;
                mJudgment = makeMatchedJudgment(
                    mcn, mcn.t, detectedTime, mExpectedMidi, mDetMidi, 1,
                    { chord: true, pitchError: bestCents,
                      pitchThresholdCents: lenientPitch ? 600 : undefined,
                      lateGraceMs }
                );
            } else {
                mJudgment = makeMissJudgment(mcn, mcn.t, missAt, mExpectedMidi,
                    { chord: true, lateGraceMs });
            }

            mJudgment._ndDisplayFrom = nowSongT;
            noteResults.set(id, mJudgment);

            _recordPerStringForChord({ hit: constituentDetected, chartNote: mcn });
        }
    }

    // A contained verifier temporarily owns one engine chart slot per audio source.
    function _ndContainedVerifierAvailable() {
        return usingDesktopBridge && _ndBridgeVerifierAvailable();
    }

    function _ndOtherOwnsOurSlot() {
        const owner = _ndShared.containedSlotOwners.get(sourceId);
        return !!owner && owner !== api;
    }

    function _ndSuspendHostChart() {
        if (_ndHostChartSuspended) return;
        _ndHostChartSuspended = true;

        _ndUsingEngineVerifier = false;
    }

    async function _ndRestoreHostChart() {
        if (!_ndHostChartSuspended) return;
        _ndHostChartSuspended = false;

        if (_ndOtherOwnsOurSlot()) return;

        try {
            await _ndPushChartToBridge();
        } catch (e) {
            console.warn('[note_detect] host chart restore failed:', e && e.message ? e.message : e);
        }
    }

    async function _ndSetContainedChart(notes, ctx) {
        if (!_ndContainedVerifierAvailable()) return null;
        if (!Array.isArray(notes) || notes.length === 0) {

            if (_ndContainedActive || _ndHostChartSuspended || _ndShared.containedSlotOwners.get(sourceId) === api) {
                await _ndReleaseContainedChart();
            }
            return false;
        }

        if (_ndOtherOwnsOurSlot()) {
            return false;
        }

        const vctx = _ndSanitizeVerifyCtx(ctx);
        const arrangement = vctx ? vctx.arrangement : currentArrangement;
        const stringCount = vctx ? vctx.stringCount : currentStringCount;
        const offsets = vctx ? vctx.offsets.slice(0, stringCount)
            : tuningOffsets.slice(0, currentStringCount);
        const containedCapo = vctx ? vctx.capo : capo;

        const entries = [];
        const byId = new Map();
        for (const n of (notes || [])) {
            if (!n || typeof n.id !== 'string' || !n.id) continue;
            if (!Number.isInteger(n.s) || n.s < 0 || n.s >= stringCount) continue;
            if (!Number.isInteger(n.f) || n.f < 0) continue;
            if (byId.has(n.id)) continue;
            const entry = {
                id: n.id,
                t: Number.isFinite(n.t) ? n.t : 0,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            entries.push(entry);
            byId.set(n.id, { ...n });
        }

        if (entries.length === 0) return false;

        const myGen = ++_ndContainedGen;
        _ndShared.containedSlotOwners.set(sourceId, api);

        _ndContainedActive = false;
        _ndContainedVerdictBuf = [];

        _ndSuspendHostChart();

        const verifyParams = _ndVerifyParamsFor(arrangement);
        let ok = null;
        try {
            ok = await _ndBridgeSetChart({
                arrangement,
                stringCount,
                tuningOffsets: offsets,
                capo: containedCapo,

                pitchCheckCents: arrangement === 'bass'
                    ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
                harmonicSnr: verifyParams.harmonicSnr,
                fundamentalRatio: verifyParams.fundamentalRatio,
                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes: entries,
            });
        } catch (e) {
            console.warn('[note_detect] setContainedChart failed:', e && e.message ? e.message : e);
            ok = null;
        }

        if (myGen !== _ndContainedGen) {
            const slotOwnedHere = !!_ndShared.containedSlotOwners.get(sourceId);
            if (!slotOwnedHere && !_ndHostChartSuspended) {
                try { _ndVerifierChartSig = ''; await _ndPushChartToBridge(); } catch (_) {}
            }
            return false;
        }
        if (ok === null || ok === false) {

            if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
            await _ndRestoreHostChart();
            return ok;
        }
        _ndContainedActive = true;
        _ndContainedById = byId;
        _ndContainedCtx = vctx;
        _ndContainedVerdictBuf = [];
        _ndContainedLastPlayhead = 0;

        console.log(`[note_detect] contained verifier active — ${entries.length} notes`
            + ` (${arrangement}, ${stringCount} strings)`);
        return true;
    }

    async function _ndPushContainedPlayhead(t, playing) {

        if (!_ndContainedActive || _ndShared.containedSlotOwners.get(sourceId) !== api) return;
        const myGen = _ndContainedGen;
        const songTime = Number.isFinite(t) ? t : 0;

        if (songTime < _ndContainedLastPlayhead - 0.25 && _ndContainedVerdictBuf.length) {
            _ndContainedVerdictBuf = _ndContainedVerdictBuf.filter(v => {
                const cn = v && _ndContainedById.get(v.id);
                return !(cn && Number.isFinite(cn.t) && cn.t >= songTime);
            });
        }
        _ndContainedLastPlayhead = songTime;
        let verdicts = null;
        try {
            verdicts = await _ndBridgeGetVerdicts(songTime, !!playing);
        } catch (e) {
            console.warn('[note_detect] contained getNoteVerdicts failed:',
                e && e.message ? e.message : e);
            return;
        }

        if (myGen !== _ndContainedGen || !_ndContainedActive) return;
        if (Array.isArray(verdicts) && verdicts.length) {
            for (const v of verdicts) {
                if (v && typeof v.id === 'string' && _ndContainedById.has(v.id)) {
                    _ndContainedVerdictBuf.push(v);
                }
            }

            if (_ndContainedVerdictBuf.length > _ND_CONTAINED_BUF_MAX) {
                _ndContainedVerdictBuf.splice(0, _ndContainedVerdictBuf.length - _ND_CONTAINED_BUF_MAX);
            }
        }
    }

    function _ndDrainContainedVerdicts() {
        if (!_ndContainedVerdictBuf.length) return [];
        const out = _ndContainedVerdictBuf;
        _ndContainedVerdictBuf = [];
        return out;
    }

    async function _ndReleaseContainedChart() {
        if (!_ndContainedActive && !_ndHostChartSuspended) return;
        _ndContainedGen++;
        _ndContainedActive = false;
        _ndContainedById = new Map();
        _ndContainedCtx = null;
        _ndContainedVerdictBuf = [];
        _ndContainedLastPlayhead = 0;
        if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
        await _ndRestoreHostChart();
    }

    let _chartStateSubscribed = false;
    const _chartStateUnsubscribers = [];
    // Store every subscription as an idempotent teardown operation.
    function _chartStateSubscribe(bus, event, handler) {
        if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') return false;
        _chartStateUnsubscribers.push(() => bus.off(event, handler));
        bus.on(event, handler);
        return true;
    }
    function _chartStateBindEvents() {
        if (_chartStateSubscribed) return;

        const onChange = () => {
            if (_syncChartStateFromHw() === null) return;

            Promise.resolve(_ndPushChartToBridge({ chartStateSynced: true })).catch(() => {});
        };
        const songBus = window.slopsmith;
        const transformBus = (window.feedBack
            && typeof window.feedBack.on === 'function'
            && typeof window.feedBack.off === 'function')
            ? window.feedBack : songBus;
        try {

            _chartStateSubscribe(songBus, 'song:loaded', onChange);
            _chartStateSubscribe(songBus, 'song:ready', onChange);
            _chartStateSubscribe(songBus, 'arrangement:changed', onChange);
            _chartStateSubscribe(transformBus, 'chart-transform:transform-changed', onChange);
        } catch (e) {
            for (const unsubscribe of _chartStateUnsubscribers.splice(0).reverse()) {
                try { unsubscribe(); } catch (_) {}
            }
            console.warn('[note_detect] chart-state event binding failed:',
                e && e.message ? e.message : e);
            return;
        }
        if (_chartStateUnsubscribers.length === 0) return;
        _chartStateSubscribed = true;
    }
    function _chartStateUnbindEvents() {
        if (!_chartStateSubscribed) return;
        for (const unsubscribe of _chartStateUnsubscribers.splice(0).reverse()) {
            try { unsubscribe(); } catch (_) {}
        }
        _chartStateSubscribed = false;
    }

    function _drillUnbindEvents() {
        if (!drillSubscribed) return;

        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (drillOnLoopRestartFn) {
                try { window.slopsmith.off('loop:restart', drillOnLoopRestartFn); } catch (e) {}
            }
            if (drillOnSongChangedFn) {
                try { window.slopsmith.off('song:loaded', drillOnSongChangedFn); } catch (e) {}
                try { window.slopsmith.off('song:ended', drillOnSongChangedFn); } catch (e) {}
            }
            if (drillOnLoopChangedFn) {
                try { window.slopsmith.off('playback:loop-set', drillOnLoopChangedFn); } catch (e) {}
                try { window.slopsmith.off('playback:loop-cleared', drillOnLoopChangedFn); } catch (e) {}
            }
        }
        drillSubscribed = false;
        drillOnLoopRestartFn = null;
        drillOnSongChangedFn = null;
        drillOnLoopChangedFn = null;
    }

    const _SUMMARY_MIN_JUDGMENTS = 5;
    function _summaryWorthy() {
        return (hits + misses) >= _SUMMARY_MIN_JUDGMENTS;
    }

    function _inGigSet() {

        const q = (window.feedBack && window.feedBack.playQueue)
            || (window.slopsmith && window.slopsmith.playQueue)
            || null;
        if (!q || typeof q.active !== 'function' || typeof q.source !== 'function') return false;
        try { return q.active() && q.source() === 'gig'; } catch (_) { return false; }
    }

    // Song-end handlers finalize scoring before any summary or queue transition.
    function _endOfSongOnEnded() {
        if (!isDefault) return;
        if (!enabled) return;

        if (_inGigSet()) {
            try {
                if (_summaryWorthy()) _submitSongXp();
            } catch (e) {
                console.warn('[note_detect] gig-song XP failed:', e && e.message ? e.message : e);
            }
            try { disable({ silent: true }); } catch (e) {  }
            return;
        }

        try {

            const built = showSummary({ startHidden: _recArmedForTraining, claimAutoExit: true, autoSave: _ndAutoSaveEnabled() });

            if (_recArmedForTraining && built) _summaryDeferred = true;

            if (built) _submitSongXp();
        } catch (e) {
            console.warn('[note_detect] end-of-song summary failed:', e && e.message ? e.message : e);
        }
        try { disable({ silent: true }); } catch (e) {}
    }

    async function _submitSongXp() {
        if (_xpSubmittedTake) return;

        _xpSubmittedTake = true;
        const mg = window.slopsmithMinigames;
        if (!mg || typeof mg.submitRun !== 'function') {
            _xpSubmittedTake = false;
            return;
        }
        const currentHw = resolveHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        const total = hits + misses;
        const accuracy = total > 0 ? Math.round((hits / total) * 100) : 0;
        try {
            const res = await mg.submitRun({
                game_id: 'song_play',
                score,
                duration_ms: (info && Number.isFinite(info.duration))
                    ? Math.round(info.duration * 1000) : 0,
                meta: {
                    title: info && info.title || '',
                    artist: info && info.artist || '',
                    arrangement: info && info.arrangement || '',
                    accuracy,
                    hits,
                    misses,
                    bestStreak,
                    maxMultiplier,
                    grade: _ndGradeFor(accuracy),
                    fullCombo: misses === 0,
                },
            });
            _fillSummaryXpRow(res);
        } catch (e) {

        }
    }

    function _fillSummaryXpRow(res) {
        if (!res || !res.ok) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (!overlay) return;
        let row = overlay.querySelector('.nd-sum-xp');
        if (!row) {
            const panel = overlay.firstElementChild;
            if (!panel) return;
            row = document.createElement('div');
            row.className = 'nd-sum-xp text-center text-sm text-green-400 mt-2';
            panel.appendChild(row);
        }

        row.textContent = `+${res.xp_gained} dB`;
        row.classList.remove('hidden');
    }

    function _runDeferredSummary() {
        if (!_summaryDeferred) return;
        _summaryDeferred = false;
        if (!isDefault) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (overlay) {
            overlay.style.display = '';

            if (typeof overlay._ndStartUpNext === 'function') {
                const _start = overlay._ndStartUpNext;
                overlay._ndStartUpNext = null;
                _start();
            }

            _animateSummary(overlay, overlay._ndReveal);
        }
    }

    function _endOfSongBindEvents() {
        if (endOfSongSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _endOfSongOnEnded;
        try {
            window.slopsmith.on('song:ended', fn);
        } catch (e) {
            return;
        }
        endOfSongOnEndedFn = fn;
        endOfSongSubscribed = true;
    }

    function _endOfSongUnbindEvents() {
        if (!endOfSongSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && endOfSongOnEndedFn) {
            try { window.slopsmith.off('song:ended', endOfSongOnEndedFn); } catch (e) {}
        }
        endOfSongSubscribed = false;
        endOfSongOnEndedFn = null;
    }

    function _reArmOnSongLoaded() {
        if (!isDefault) return;

        if (typeof window !== 'undefined' && window.__ndSuppressDefault) return;
        if (enabled) return;
        if (!detectPreference) return;
        enable().catch((e) => {
            console.warn('[note_detect] auto re-arm on song:loaded failed:',
                e && e.message ? e.message : e);
        });
    }

    function _reArmBindEvents() {
        if (reArmSubscribed) return;
        if (!isDefault) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _reArmOnSongLoaded;
        try {
            window.slopsmith.on('song:loaded', fn);
        } catch (e) {
            return;
        }
        reArmOnLoadedFn = fn;
        reArmSubscribed = true;
    }

    function _reArmUnbindEvents() {
        if (!reArmSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && reArmOnLoadedFn) {
            try { window.slopsmith.off('song:loaded', reArmOnLoadedFn); } catch (e) {}
        }
        reArmSubscribed = false;
        reArmOnLoadedFn = null;
    }

    function _drillRender() {
        if (!drillDirty) return;
        drillDirty = false;
        const panel = instanceRoot.querySelector('.nd-drill');
        if (!panel) return;

        const hasHistory = drillIterations.length > 0;
        if (!drillEnabled && !hasHistory) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        const headerEl = panel.querySelector('.nd-drill-header');
        const listEl = panel.querySelector('.nd-drill-list');
        if (headerEl) {
            if (drillEnabled) {
                const liveTotal = drillIterHits + drillIterMisses;
                const liveAcc = liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : null;

                const num = drillNextIdx;
                headerEl.textContent = liveAcc !== null
                    ? `Drill #${num}: ${drillIterHits}/${liveTotal} (${liveAcc}%)`
                    : `Drill #${num}`;
            } else {

                headerEl.textContent = `Drill (last loop)`;
            }
        }
        if (listEl) {
            if (!hasHistory) {
                listEl.textContent = '';
            } else {

                const recent = drillIterations.slice(-5);
                let best = recent[0], worst = recent[0];
                for (const it of recent) {
                    if (it.accuracy > best.accuracy) best = it;
                    if (it.accuracy < worst.accuracy) worst = it;
                }
                const parts = recent.map((it) => {
                    const tag = it === best && recent.length > 1
                        ? ' <span style="color:#00ff88">★</span>'
                        : it === worst && recent.length > 1
                            ? ' <span style="color:#ff4444">·</span>'
                            : '';
                    return `#${it.idx} ${it.hits}/${it.hits + it.misses} ${it.accuracy}%${tag}`;
                });
                listEl.innerHTML = parts.join('<br>');
            }
        }
    }

    function _drillSyncFromLoopState() {
        const { loopA, loopB } = _drillCurrentLoop();

        const nowEnabled = Number.isFinite(loopA) && Number.isFinite(loopB);
        if (nowEnabled && !drillEnabled) {

            const sameBounds = (loopA === drillActiveLoopA && loopB === drillActiveLoopB);
            if (!sameBounds) {
                drillIterations = [];
                drillNextIdx = 1;
            }
            drillActiveLoopA = loopA;
            drillActiveLoopB = loopB;

            _drillResetIteration(loopA);
            drillDirty = true;
        } else if (nowEnabled && drillEnabled) {

            if (loopA !== drillActiveLoopA || loopB !== drillActiveLoopB) {
                drillIterations = [];
                drillNextIdx = 1;
                drillActiveLoopA = loopA;
                drillActiveLoopB = loopB;
                _drillResetIteration(loopA);
                drillDirty = true;
            }
        } else if (!nowEnabled && drillEnabled) {

            _drillResetIteration(null);
            drillDirty = true;
        }
        drillEnabled = nowEnabled;
    }

    let _extActive = false;
    let _extOnHit = null, _extOnMiss = null, _extWatchOpen = null, _extWatchClose = null;
    let _extPending = [];

    // External note providers bypass microphone analysis but reuse scoring and UI.
    function _extScan() {
        const nd = window.slopsmith && window.slopsmith.noteDetection;
        if (!nd || nd.version !== 1 || typeof nd.snapshot !== 'function') return null;
        let snap; try { snap = nd.snapshot(); } catch (_) { return null; }
        if (!snap || !Array.isArray(snap.providers) || !Array.isArray(snap.bindings)) return null;

        const boundIds = new Set(snap.bindings.filter(b => b && b.providerId).map(b => b.providerId));
        const ext = snap.providers.find(p => p && p.kind && p.kind !== 'audio' && p.kind !== 'engine' && boundIds.has(p.id));
        return ext || null;
    }

    function _ndIsExternalScoredArrangement() {
        try {
            const info = (resolveHw() && hw.getSongInfo) ? hw.getSongInfo() : null;
            const name = info && info.arrangement;
            return !!(name && /\b(keys|piano|keyboard|synth)\b/i.test(String(name)));
        } catch (_) { return false; }
    }

    function _extFeed(detail, hit) {
        const p = (detail && detail.payload) || {};
        const midi = Number(p.midi);
        if (!_extActive) {

            if (detectPreference && _extScan() && _extPending.length < 128) _extPending.push({ hit, midi });
            return;
        }
        const t = (resolveHw() && hw.getTime) ? hw.getTime() : 0;
        const key = 'ext:' + (Number.isFinite(midi) ? midi : 'x') + ':' + Number(t).toFixed(3) + ':' + (hit ? 'h' : 'm');
        try {

            recordJudgment(key, { hit: !!hit, detectedMidi: hit && Number.isFinite(midi) ? midi : null, noteTime: t, _external: true },
                { count: true, emit: true });
        } catch (_) {}
    }

    function _extSubscribe() {
        if (_extOnHit) return;
        _extOnHit  = (detail) => _extFeed(detail, true);
        _extOnMiss = (detail) => _extFeed(detail, false);
        try {
            window.slopsmith.on('note-detection:hit', _extOnHit);
            window.slopsmith.on('note-detection:miss', _extOnMiss);
        } catch (_) {}
    }
    function _extUnsubscribe() {
        try {
            if (_extOnHit)  window.slopsmith.off('note-detection:hit', _extOnHit);
            if (_extOnMiss) window.slopsmith.off('note-detection:miss', _extOnMiss);
        } catch (_) {}
        _extOnHit = _extOnMiss = null;
    }

    function _enableExternal() {
        _extActive = true;
        attachInstanceRoot();
        updateButton();
        startHUD();
        _extSubscribe();

        if (_extPending.length) {
            const pend = _extPending; _extPending = [];
            for (const v of pend) _extFeed({ payload: { midi: v.midi } }, v.hit);
        }
        return true;
    }

    function _extBindWatch() {
        if (_extWatchOpen || !isDefault) return;
        _extWatchOpen = () => {
            if (_extActive || !detectPreference || !_ndIsExternalScoredArrangement() || !_extScan()) return;
            if (enabled) { try { stopAudio(); } catch (_) {} }
            enabled = false;
            enable().catch(() => {});
        };
        _extWatchClose = () => {
            if (!_extActive || _extScan()) return;
            _extActive = false;
            _extPending = [];

            stopHUD();
            enabled = false;
            updateButton();
        };
        try {
            window.slopsmith.on('note-detection:binding-opened', _extWatchOpen);
            window.slopsmith.on('note-detection:provider-registered', _extWatchOpen);
            window.slopsmith.on('note-detection:binding-closed', _extWatchClose);
            window.slopsmith.on('note-detection:provider-unregistered', _extWatchClose);
        } catch (_) {}

        _extSubscribe();
    }

    let enableInFlight = null;
    // Public lifecycle calls are serialized through enableImpl() and queueAudioOp().
    function enable() {
        if (enableInFlight) return enableInFlight;
        if (enabled) return Promise.resolve(true);
        enableInFlight = (async () => {
            try {
                return await enableImpl();
            } finally {
                enableInFlight = null;
            }
        })();
        return enableInFlight;
    }

    async function enableImpl() {

        if (!resolveHw()) {
            console.warn('[note_detect] enable() called but `highway` is not available yet — plugin may have loaded before slopsmith core.');
            return false;
        }
        ensureDrawHook();

        _ndApplyEngineGain();

        _drillBindEvents();

        _endOfSongBindEvents();

        _reArmBindEvents();

        _seekResetBindEvents();

        _drillSyncFromLoopState();
        enabled = true;

        attachInstanceRoot();
        updateButton();

        _syncChartStateFromHw();
        _chartStateBindEvents();

        resetScoring();

        if (_ndIsExternalScoredArrangement() && _extScan()) return _enableExternal();

        if (_ndIsExternalScoredArrangement()) {
            enabled = false;
            updateButton();
            return false;
        }

        const result = await queueAudioOp(async () => {

            if (!enabled) return { ok: false, superseded: true };

            sessionGen++;
            const gen = sessionGen;
            const ok = await startAudio();
            if (gen !== sessionGen || !enabled) {

                if (ok) stopAudio();
                return { ok: false, superseded: true };
            }
            return { ok, superseded: false };
        });

        if (result.superseded) {

            return false;
        }
        if (!result.ok) {
            enabled = false;
            updateButton();
            return false;
        }

        missCheckInterval = setInterval(checkMisses, 100);
        startHUD();

        await _ndPushChartToBridge();

        if (_ndDeviceKey > 0 && _ndOwnsSource && sourceId != null && sourceId !== 0) {
            const warmGen = sessionGen;
            setTimeout(() => {
                if (enabled && warmGen === sessionGen) resetScoring();
            }, 2500);
        }

        gcInterval = setInterval(() => {
            if (!enabled || noteResults.size < 500) return;
            const t = hw.getTime();
            for (const [key] of noteResults) {
                const noteTime = parseFloat(key.split('_')[0]);
                if (noteTime < t - 5) { noteResults.delete(key); _susActiveUntil.delete(key); }
            }
        }, 5000);

        if (detectionMethod === 'crepe') _ndLoadCrepe();

        _bindAutoRecord();

        _calBindEvents();
        return true;
    }

    function disable(disableOptions) {
        if (!enabled) return;
        enabled = false;

        if (drillConductorActive) endDrill('disabled');

        if (_ndContainedActive || _ndHostChartSuspended) {
            _ndContainedGen++;
            _ndContainedActive = false;
            _ndContainedById = new Map();
            _ndContainedCtx = null;
            _ndContainedVerdictBuf = [];
            _ndContainedLastPlayhead = 0;
            _ndHostChartSuspended = false;
            if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
        }

        sessionGen++;
        stopAudio();

        _ndCloseSelectedInputSource(ND_AUDIO_REQUESTER);
        stopHUD();

        _extActive = false; _extUnsubscribe();

        _unbindAutoRecord();

        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
        for (const tid of flashTimeouts) clearTimeout(tid);
        flashTimeouts = [];

        if (!disableOptions || !disableOptions.silent) showSummary();

        const panel = document.querySelector('.nd-settings-panel');
        if (panel) {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            panel.remove();
        }
        _vuSetPanel(null);
        calibrationWizardClose();
        calibrationLabClose();

        updateButton();
    }

    // destroy() releases every resource owned by this instance.
    function destroy() {

        disable({ silent: true });

        if (scoringWatchdog) { clearInterval(scoringWatchdog); scoringWatchdog = null; }
        try { _clearScoringStall(); } catch (_) {}

        _ndReleaseOwnedSource();
        calibrationWizardClose();
        calibrationLabClose();

        _drillUnbindEvents();
        _endOfSongUnbindEvents();
        _reArmUnbindEvents();
        _seekResetUnbindEvents();
        _chartStateUnbindEvents();
        _recUnbindEvents();
        _unbindAutoRecord();
        _calUnbindEvents();
        _liveUnbindEvents();

        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recTrainingUploadResult = null;
        _stopParallelTrainingCapture();

        try { if (hw && hw.removeDrawHook) hw.removeDrawHook(drawHookFn); } catch (e) {}

        try {
            if (hw && hw.setNoteStateProvider
                && typeof hw.getNoteStateProvider === 'function'
                && hw.getNoteStateProvider() === noteStateFor) {
                hw.setNoteStateProvider(null);
            }
        } catch (e) {}
        if (detectBtn) { detectBtn.remove(); detectBtn = null; }
        if (gearBtn) { gearBtn.remove(); gearBtn = null; }
        if (instanceRoot.parentNode) instanceRoot.remove();
        _ndInstances.delete(api);
    }

    async function toggle() {
        if (enabled) {
            disable();
            detectPreference = false;
            saveSettings();
        } else {
            await enable();
            detectPreference = true;
            saveSettings();
        }
    }

    function _buildDiagnosticPayload() {
        const currentHw = resolveHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        const total = hits + misses;
        const sumAcc = total > 0 ? +(hits / total).toFixed(3) : 0;
        const sAcc = (_diagSingles.hits + _diagSingles.misses) > 0
            ? +(_diagSingles.hits / (_diagSingles.hits + _diagSingles.misses)).toFixed(3) : 0;
        const cAcc = (_diagChords.hits + _diagChords.misses) > 0
            ? +(_diagChords.hits / (_diagChords.hits + _diagChords.misses)).toFixed(3) : 0;
        return {
            schema: 'note_detect.diagnostic.v1',
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,

            detector: _diagDetector || {
                desktop_bridge: false, ml: false, path: 'none',
            },
            benchmark_hint: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
            },
            song: {
                tuning: info.tuning || null,
                capo: (info.capo != null) ? info.capo : 0,
                duration: (info.duration != null) ? info.duration : null,
                format: info.format || null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
            },
            summary: {
                hits, misses, total,
                accuracy: sumAcc,
                best_streak: bestStreak,
                singles: { hits: _diagSingles.hits, misses: _diagSingles.misses, accuracy: sAcc },
                chords:  { hits: _diagChords.hits,  misses: _diagChords.misses,  accuracy: cAcc },
                rescue: { calls: _rescueCalls, windows: _rescueWindows, hits: _rescueHits, skipped_silent: _rescueSkippedSilent },

                clean_hits: _diagClean.clean,
                loose_hits: _diagClean.loose,
                clean_rate: hits > 0 ? +(_diagClean.clean / hits).toFixed(3) : null,
            },

            engine_drain: {
                active: _ndUsingEngineVerifier,
                drop_unknown_id: _ndDrainStats.dropUnknownId,
                suppressed_redelivery: _ndDrainStats.suppressedRedelivery,
                max_batch: _ndDrainStats.maxBatch,
            },
            miss_breakdown: { ..._diagBreakdown },
            per_string: _diagPerString.map((slot, s) => ({
                s,
                hits: slot.hits,
                misses: slot.misses,
                total: slot.hits + slot.misses,
                accuracy: (slot.hits + slot.misses) > 0
                    ? +(slot.hits / (slot.hits + slot.misses)).toFixed(3) : null,
            })),
            timing_error_ms: _diagDistribution(_diagTimingErrors),

            timing_error_ms_hits: _diagDistribution(_diagTimingErrorsHits),
            pitch_error_cents:    _diagDistribution(_diagPitchErrors),
            sections: sectionStats.map(s => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? +(s.hits / (s.hits + s.misses)).toFixed(3) : 0,
            })),
            events: _diagEvents,
        };
    }

    function _downloadDiagnostic() {
        try {
            const payload = _buildDiagnosticPayload();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const slug = (payload.benchmark_hint.title || 'song')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_diag_${slug}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] diagnostic download failed:', e);
            return false;
        }
    }

    // Reference recording is opt-in and bounded before upload or local save.
    function armRecording() {
        _recArmed = true;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;

        _recBindEvents();
    }
    async function _startParallelTrainingCapture() {
        if (_trainingCapture) return;
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            throw new Error('getUserMedia is not available in this context');
        }
        const constraints = { audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,

            channelCount: 2,
        }};
        if (selectedDeviceId) {
            constraints.audio.deviceId = { exact: selectedDeviceId };
        }
        let stream;
        try {

            stream = await openInstrumentStream(constraints);
        } catch (e) {
            throw new Error('mic permission denied or device unavailable: ' + (e && e.message || e));
        }

        if (!_recArmed || !_recArmedForTraining) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            return;
        }

        let ctx = null;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            const source = ctx.createMediaStreamSource(stream);

            const processor = ctx.createScriptProcessor(4096, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!_recArmed || !_recSongPlaying) return;
                const input = e.inputBuffer.getChannelData(0);
                const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
                if (_recTotalSamples >= maxSamples) {
                    if (!_recCappedAt) _recCappedAt = _recTotalSamples / (ctx.sampleRate || 44100);
                    return;
                }
                _recSampleRate = ctx.sampleRate || _recSampleRate;

                const copy = input.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            };

            const gain = ctx.createGain();
            gain.gain.value = inputGain;
            let splitter = null, merger = null;
            if (source.channelCount >= 2 && selectedChannel !== 'mono') {
                splitter = ctx.createChannelSplitter(2);
                merger = ctx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                source.connect(splitter);
                splitter.connect(merger, chIdx, 0);
                merger.connect(gain);
            } else {
                source.connect(gain);
            }
            gain.connect(processor);

            const mute = ctx.createGain();
            mute.gain.value = 0;
            processor.connect(mute);
            mute.connect(ctx.destination);
            _trainingCapture = { stream, ctx, source, splitter, merger, gain, processor, mute };
        } catch (e) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { if (ctx) ctx.close(); } catch (_) {}
            throw new Error('training capture graph setup failed: ' + (e && e.message || e));
        }
    }
    function _stopParallelTrainingCapture() {
        if (!_trainingCapture) return;
        const cap = _trainingCapture;
        _trainingCapture = null;
        try { cap.source.disconnect(); } catch (_) {}
        try { if (cap.splitter) cap.splitter.disconnect(); } catch (_) {}
        try { if (cap.merger) cap.merger.disconnect(); } catch (_) {}
        try { if (cap.gain) cap.gain.disconnect(); } catch (_) {}
        try { cap.processor.disconnect(); } catch (_) {}
        try { cap.mute.disconnect(); } catch (_) {}
        try { cap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { cap.ctx.close(); } catch (_) {}
    }
    async function armRecordingForTraining() {

        _recArmed = true;
        _recArmedForTraining = true;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;

        _liveLastSessionId = null;
        _recBindEvents();
        _liveBindEvents();

        const _t1 = (hw && hw.getTime) ? hw.getTime() : 0;
        await new Promise((r) => setTimeout(r, 150));

        if (!_recArmed || !_recArmedForTraining) return;
        const _t2 = (hw && hw.getTime) ? hw.getTime() : 0;
        if (_t2 > _t1 + 0.02) {
            _recSongPlaying = true;

            _startLiveSession();
        }

        if (usingDesktopBridge) {
            try {
                await _startParallelTrainingCapture();
            } catch (e) {

                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = String(e && e.message || e);
                _recUnbindEvents();
                if (!tuningMode) _liveUnbindEvents();
                console.warn('[note_detect] arm-for-training getUserMedia failed:', e);
                throw e;
            }
        }
    }
    function disarmRecording() {

        _recArmed = false;
        _recArmedForTraining = false;
        _recUnbindEvents();

        if (!tuningMode) _liveUnbindEvents();

        _stopParallelTrainingCapture();
    }
    function discardRecording() {
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        _recUnbindEvents();
        if (!tuningMode) _liveUnbindEvents();
        _stopParallelTrainingCapture();
    }
    async function saveRecordingNow() {
        if (_recSaveInFlight) return null;
        if (_recChunks.length === 0) {
            _recLastSaveError = 'no audio captured (Detect off, or song never played)';
            return null;
        }

        const chunks = _recChunks;
        const sr = _recSampleRate;
        _recArmed = false;
        _recSaveInFlight = true;
        try {
            const wav = _ndEncodeWavPcm16(chunks, sr);
            const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
            const slug = ((info.title || 'recording') + '')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'recording';
            const resp = await fetch(
                '/api/plugins/note_detect/recording?slug=' + encodeURIComponent(slug),
                { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
            const data = await resp.json();
            _recLastSavePath = data && data.relative_path || null;
            _recLastSaveError = null;

            _recChunks = [];
            _recTotalSamples = 0;
            _recCappedAt = null;
            return data;
        } catch (e) {
            _recLastSaveError = String(e && e.message || e);
            console.warn('[note_detect] saveRecording failed:', e);

            return null;
        } finally {
            _recSaveInFlight = false;

            _recUnbindEvents();
        }
    }
    function getRecordingState() {

        const samples = _recTotalSamples;
        return {
            armed:        _recArmed,
            armedForTraining: _recArmedForTraining,
            songPlaying:  _recSongPlaying,
            chunks:       _recChunks.length,
            samples,
            sampleRate:   _recSampleRate,
            durationS:    samples / Math.max(1, _recSampleRate),
            saveInFlight: _recSaveInFlight,
            lastSavePath: _recLastSavePath,
            lastError:    _recLastSaveError,

            cappedAtS:    _recCappedAt,

            detectEnabled: enabled,

            trainingUploadInFlight: _recTrainingUploadInFlight,
            trainingUploadResult:   _recTrainingUploadResult,
        };
    }

    const _TRAINING_PREFS_KEY = 'nd_training_prefs_v1';
    function _loadTrainingPrefs() {
        try {
            const raw = localStorage.getItem(_TRAINING_PREFS_KEY);
            if (!raw) return { name: '', discord: '', instrument: '', notes: '' };
            const p = JSON.parse(raw) || {};
            return {
                name:       typeof p.name       === 'string' ? p.name       : '',
                discord:    typeof p.discord    === 'string' ? p.discord    : '',
                instrument: typeof p.instrument === 'string' ? p.instrument : '',
                notes:      typeof p.notes      === 'string' ? p.notes      : '',
            };
        } catch (_) {
            return { name: '', discord: '', instrument: '', notes: '' };
        }
    }
    function _saveTrainingPrefs(prefs) {
        try {
            localStorage.setItem(_TRAINING_PREFS_KEY, JSON.stringify({
                name:       prefs.name       || '',
                discord:    prefs.discord    || '',
                instrument: prefs.instrument || '',
                notes:      prefs.notes      || '',
            }));
        } catch (_) {  }
    }

    let _trainingModalActive = false;

    function _showTrainingConsentModal(prefill, doUpload, doRetry) {
        if (_trainingModalActive) return Promise.resolve(null);
        _trainingModalActive = true;
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'nd-train-modal fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 p-4 overflow-y-auto';

            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'nd-tr-title');

            const _prevFocus = document.activeElement;

            modal.innerHTML = `
                <div class="bg-dark-700 border border-gray-600 rounded-lg max-w-md w-full p-5 shadow-2xl my-4">
                    <h3 id="nd-tr-title" class="nd-tr-title text-base font-semibold text-gray-100 mb-1">Submit Training Take</h3>
                    <p class="nd-tr-intro text-[11px] text-gray-400 mb-4 leading-snug">
                        Review the details below, then check the consent box to upload your take
                        (audio + detection events + this form) to the training dataset. All fields
                        marked optional can be left blank.
                    </p>

                    <div class="nd-tr-form">
                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Song Name</label>
                        <input class="nd-tr-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">custom song File Name</label>
                        <input class="nd-tr-custom-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Instrument</label>
                        <select class="nd-tr-instr w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">
                            <option value="guitar">Guitar</option>
                            <option value="bass">Bass</option>
                        </select>

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Tuning</label>
                        <input class="nd-tr-tuning w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Your Name <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-name w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Discord Handle <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-discord w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Extra Notes <span class="text-gray-500 normal-case">(optional)</span></label>
                        <textarea class="nd-tr-notes w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3" rows="3"></textarea>

                        <label class="flex items-start gap-2 mb-4 cursor-pointer">
                            <input type="checkbox" class="nd-tr-consent mt-0.5">
                            <span class="text-xs text-gray-300 leading-snug">
                                I give permission for this recording to be used for training purposes
                                of the note detection system.
                            </span>
                        </label>
                    </div>
                    <div class="nd-tr-status hidden text-xs leading-snug mb-4 px-3 py-2 rounded border"></div>

                    <div class="flex gap-2">
                        <button class="nd-tr-cancel flex-1 px-3 py-2 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300">Cancel</button>
                        <button class="nd-tr-retry flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" style="display:none">Retry upload</button>
                        <button class="nd-tr-submit flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" disabled>Upload</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const $ = (sel) => modal.querySelector(sel);

            $('.nd-tr-song').value    = prefill.songName || '';
            $('.nd-tr-custom-song').value    = prefill.cdlcFilename || '';
            $('.nd-tr-instr').value   = (prefill.instrument === 'bass') ? 'bass' : 'guitar';
            $('.nd-tr-tuning').value  = prefill.tuning || '';
            $('.nd-tr-name').value    = prefill.name || '';
            $('.nd-tr-discord').value = prefill.discord || '';
            $('.nd-tr-notes').value   = prefill.notes || '';

            try { $('.nd-tr-song').focus(); } catch (_) {}

            const submitBtn  = $('.nd-tr-submit');
            const retryBtn   = $('.nd-tr-retry');
            const cancelBtn  = $('.nd-tr-cancel');
            const consentCb  = $('.nd-tr-consent');
            const statusEl   = $('.nd-tr-status');
            const formEl     = $('.nd-tr-form');
            consentCb.addEventListener('change', () => { submitBtn.disabled = !consentCb.checked; });

            let finalResult = null;

            let _activeUpload = null;
            const cleanup = () => {
                modal.remove();
                _trainingModalActive = false;

                try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch (_) {}
                if (_activeUpload) {
                    _activeUpload.finally(() => resolve(finalResult));
                } else {
                    resolve(finalResult);
                }
            };
            const setStatus = (kind, text) => {
                statusEl.classList.remove('hidden');
                statusEl.className = 'nd-tr-status text-xs leading-snug mb-4 px-3 py-2 rounded border ' + ({
                    info: 'bg-blue-900/30 border-blue-700/50 text-blue-200',
                    ok:   'bg-green-900/30 border-green-700/50 text-green-200',
                    err:  'bg-red-900/30 border-red-700/50 text-red-200',
                }[kind] || '');
                statusEl.textContent = text;
            };

            const applyResult = (result) => {
                finalResult = result;
                _recTrainingUploadResult = result;
                if (result && result.ok) {
                    setStatus('ok', '✓ Uploaded to the training dataset: ' + (result.bundle_filename || '(file)') + '. Thanks for contributing!');
                    submitBtn.style.display = 'none';
                    retryBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-xs font-semibold text-white';
                } else {
                    const errMsg = (result && result.error) ? result.error : 'unknown error';
                    const canRetry = !!(doRetry && result && result.local_bundle);
                    const retained = (result && result.local_bundle)
                        ? ('\nThe local bundle was retained at ' + result.local_bundle
                           + (canRetry ? ' — use Retry below.' : ' — you can retry from there.'))
                        : '';
                    setStatus('err', '✗ Upload failed: ' + errMsg + retained);
                    submitBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-red-700 hover:bg-red-600 rounded text-xs font-semibold text-white';
                    if (canRetry) {
                        retryBtn.style.display = '';
                        retryBtn.disabled = false;
                        retryBtn._localBundle = result.local_bundle;
                    }
                }
            };

            cancelBtn.onclick = () => { cleanup(); };
            retryBtn.onclick = async () => {
                const localBundle = retryBtn._localBundle;
                if (!localBundle || !doRetry) return;
                retryBtn.disabled = true;
                retryBtn.textContent = 'Retrying…';
                setStatus('info', 'Re-uploading the saved bundle to pCloud — no re-recording needed. Don’t close Slopsmith yet.');
                let result = null;
                const p = doRetry(localBundle);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                retryBtn.textContent = 'Retry upload';
                applyResult(result);
            };
            submitBtn.onclick = async () => {
                if (!consentCb.checked) return;
                const formData = {
                    songName:     $('.nd-tr-song').value.trim(),
                    cdlcFilename: $('.nd-tr-custom-song').value.trim(),
                    instrument:   $('.nd-tr-instr').value,
                    tuning:       $('.nd-tr-tuning').value.trim(),
                    name:         $('.nd-tr-name').value.trim(),
                    discord:      $('.nd-tr-discord').value.trim(),
                    notes:        $('.nd-tr-notes').value.trim(),
                    consent:      true,
                };

                formEl.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
                formEl.classList.add('opacity-50', 'pointer-events-none');
                submitBtn.disabled = true;
                submitBtn.textContent = 'Uploading…';
                cancelBtn.textContent = 'Hide';
                setStatus('info', 'Bundling the WAV, detect-stream, and manifest, then shipping to pCloud. Don’t close Slopsmith yet — this can take a few seconds on a slow uplink.');

                let result = null;
                const p = doUpload(formData);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e) };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                applyResult(result);
            };

            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
            });
        });
    }
    // Training uploads require explicit consent and preserve local recovery data on failure.
    async function _uploadTrainingBundle(savedData, sessionId, songInfoSnapshot, chartSnapshot, audioStats, cdlcFilenameSnapshot) {

        audioStats = audioStats || {
            sampleRate: _recSampleRate, totalSamples: _recTotalSamples, cappedAtS: _recCappedAt,
        };
        if (_recTrainingUploadInFlight) return null;

        _recTrainingUploadInFlight = true;
        try {

            const filename = (savedData && savedData.filename) || '';
            const m = /^note_detect_(.+?)_\d{8}_\d{6}_\d{3}_[0-9a-f]+\.wav$/.exec(filename);
            if (!m) {
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'could not parse slug from saved filename: ' + filename,
                };
                return null;
            }
            const slug = m[1];

            const info = songInfoSnapshot
                || ((hw && hw.getSongInfo) ? hw.getSongInfo() : {});

            const cdlcFilename = cdlcFilenameSnapshot
                || info.filename || _ndShared.currentFilename || '';
            const tuningArr = Array.isArray(info.tuning) ? info.tuning.slice() : null;

            const arrLower = String(info.arrangement || '').toLowerCase();
            const guessedInstrument = arrLower.includes('bass') ? 'bass' : 'guitar';
            const persisted = _loadTrainingPrefs();

            const result = await _showTrainingConsentModal({
                songName:     info.title || '',
                cdlcFilename: cdlcFilename,
                tuning:       tuningArr ? tuningArr.join(', ') : '',

                instrument:   persisted.instrument || guessedInstrument,
                name:         persisted.name,
                discord:      persisted.discord,
                notes:        persisted.notes,
            }, async (formData) => {

                _saveTrainingPrefs({
                    name:       formData.name,
                    discord:    formData.discord,
                    instrument: formData.instrument,
                    notes:      formData.notes,
                });

                _recTrainingUploadResult = null;

                const manifest = {

                    plugin: { id: 'note_detect' },
                    song: {
                        filename:    formData.cdlcFilename || cdlcFilename || null,
                        title:       formData.songName || info.title || null,
                        artist:      info.artist || null,
                        arrangement: info.arrangement || null,
                        arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                        tuning:       tuningArr,
                        tuning_label: formData.tuning || null,
                        instrument:   formData.instrument || guessedInstrument,
                        capo:         (info.capo != null) ? info.capo : null,
                        format:       info.format || null,
                        duration_s:   (info.duration != null) ? info.duration : null,

                        mastery:          chartSnapshot ? chartSnapshot.mastery : null,
                        has_phrase_data:  chartSnapshot ? !!chartSnapshot.hasPhraseData : false,
                    },
                    settings: {
                        detection_method:        detectionMethod,
                        av_offset_ms:            Math.round(latencyOffset * 1000),
                        timing_tolerance_ms:     Math.round(timingTolerance * 1000),
                        timing_hit_threshold_ms: Math.round(timingHitThreshold * 1000),
                        pitch_tolerance_cents:   pitchTolerance,
                    },
                    audio: {

                        sample_rate: audioStats.sampleRate,
                        channels:    1,
                        bit_depth:   16,
                        duration_s:  audioStats.totalSamples / Math.max(1, audioStats.sampleRate),
                        capped_at_s: audioStats.cappedAtS,
                    },
                    client: {
                        user_agent: navigator.userAgent,
                        platform:   navigator.platform || null,
                        timestamp_local: new Date().toISOString(),
                    },
                    contributor: {
                        name:    formData.name    || null,
                        discord: formData.discord || null,
                        consent: true,
                        consent_text: 'I give permission for this recording to be used for training purposes of the note detection system.',
                        consent_at:   new Date().toISOString(),
                    },
                    notes: formData.notes || null,
                };

                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}

                await _flushLiveJudgments();

                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            slug,

                            wav_filename: filename || null,

                            session: sessionId || null,
                            manifest,

                            arrangement: chartSnapshot
                                ? { notes: chartSnapshot.notes, chords: chartSnapshot.chords }
                                : null,
                            upload_url: uploadUrl,
                        }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) {  }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: data && data.local_bundle || null };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e) };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle upload failed:', e);
                    return out;
                }
            }, async (localBundle) => {

                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}
                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle/retry', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ local_bundle: localBundle, upload_url: uploadUrl }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) {  }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: (data && data.local_bundle) || localBundle };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle retry failed:', e);
                    return out;
                }
            });
            if (!result) {

                _recTrainingUploadResult = {
                    ok: false,
                    error: 'cancelled — bundle not uploaded',
                    local_bundle: null,
                };
            }
            return _recTrainingUploadResult;
        } catch (e) {
            _recTrainingUploadResult = { ok: false, error: String(e && e.message || e) };
            console.warn('[note_detect] training-bundle flow failed:', e);
            return null;
        } finally {

            _recTrainingUploadInFlight = false;
        }
    }

    let _recOnPlay = null, _recOnPause = null, _recOnEnded = null;
    let _recSubscribed = false;
    function _recBindEvents() {
        if (_recSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _recOnPlay  = () => { _recSongPlaying = true; };
        _recOnPause = () => { _recSongPlaying = false; };
        _recOnEnded = () => {
            _recSongPlaying = false;
            if (_recArmed && _recChunks.length > 0) {

                const shouldUpload = _recArmedForTraining;

                const sessionAtEnd = _liveSessionId || _liveLastSessionId;
                const songInfoAtEnd = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};

                const cdlcFilenameAtEnd =
                    (songInfoAtEnd && songInfoAtEnd.filename)
                    || _ndShared.currentFilename || '';

                const chartAtEnd = _ndTrainingChartSnapshot();

                const audioStatsAtEnd = {
                    sampleRate:    _recSampleRate,
                    totalSamples:  _recTotalSamples,
                    cappedAtS:     _recCappedAt,
                };

                saveRecordingNow().then((data) => {

                    _stopParallelTrainingCapture();
                    if (data && shouldUpload) {
                        return _uploadTrainingBundle(data, sessionAtEnd, songInfoAtEnd, chartAtEnd, audioStatsAtEnd, cdlcFilenameAtEnd);
                    }
                }).catch(() => { _stopParallelTrainingCapture(); }).finally(() => {

                    _recArmed = false;
                    _recArmedForTraining = false;
                    if (!tuningMode) _liveUnbindEvents();

                    _runDeferredSummary();
                });
            } else if (_recArmed) {

                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = 'no audio captured before song:ended';
                _recUnbindEvents();

                if (!tuningMode) _liveUnbindEvents();
                _stopParallelTrainingCapture();

                _runDeferredSummary();
            }
        };
        try {
            window.slopsmith.on('song:play',  _recOnPlay);
            window.slopsmith.on('song:pause', _recOnPause);
            window.slopsmith.on('song:ended', _recOnEnded);
        } catch (e) {

            try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:pause', _recOnPause); } catch (_) {}
            try { window.slopsmith.off('song:ended', _recOnEnded); } catch (_) {}
            _recOnPlay = _recOnPause = _recOnEnded = null;
            return;
        }
        _recSubscribed = true;
    }
    function _recUnbindEvents() {
        if (!_recSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_recOnPlay)  { try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (e) {} }
            if (_recOnPause) { try { window.slopsmith.off('song:pause', _recOnPause); } catch (e) {} }
            if (_recOnEnded) { try { window.slopsmith.off('song:ended', _recOnEnded); } catch (e) {} }
        }
        _recOnPlay = _recOnPause = _recOnEnded = null;
        _recSubscribed = false;
    }

    let _autoRecOnLoaded = null, _autoRecOnPause = null, _autoRecOnPlay = null;

    const _AUTO_REC_MIN_PAUSE_SAVE_S = 3;
    function _bindAutoRecord() {
        if (!isDefault || _autoRecOnLoaded) return;
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;

        _autoRecOnLoaded = async () => {
            if (!autoRecord || !detectPreference) return;
            if (_recArmedForTraining) return;

            if (!_recArmed && _recChunks.length > 0) return;
            if (_recArmed) {
                if (_recChunks.length > 0) {

                    const saved = await saveRecordingNow().catch(() => null);
                    if (!saved && _recChunks.length > 0) return;
                } else {
                    discardRecording();
                }
            }
            armRecording();
        };

        _autoRecOnPause = () => {
            if (!autoRecord || _recArmedForTraining || !_recArmed) return;
            const secs = _recTotalSamples / Math.max(1, _recSampleRate);
            if (_recChunks.length > 0 && secs >= _AUTO_REC_MIN_PAUSE_SAVE_S) {
                saveRecordingNow().catch(() => {});
            }
        };

        _autoRecOnPlay = () => {

            if (!autoRecord || !detectPreference || _recArmedForTraining || _recArmed || _recChunks.length > 0) return;
            armRecording();
            _recSongPlaying = true;
        };
        try {
            window.slopsmith.on('song:loaded', _autoRecOnLoaded);
            window.slopsmith.on('song:pause',  _autoRecOnPause);
            window.slopsmith.on('song:play',   _autoRecOnPlay);
        } catch (_) { _unbindAutoRecord(); }
    }
    function _unbindAutoRecord() {
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_autoRecOnLoaded) { try { window.slopsmith.off('song:loaded', _autoRecOnLoaded); } catch (_) {} }
            if (_autoRecOnPause)  { try { window.slopsmith.off('song:pause',  _autoRecOnPause); } catch (_) {} }
            if (_autoRecOnPlay)   { try { window.slopsmith.off('song:play',   _autoRecOnPlay); } catch (_) {} }
        }
        _autoRecOnLoaded = _autoRecOnPause = _autoRecOnPlay = null;
    }

    function _calLogDetection() {
        if (autoCalibrate && isDefault && detectedMidi >= 0 && _calDetections.length < _CAL_MAX) {
            _calDetections.push({ bt: hw.getTime() - latencyOffset, m: detectedMidi });
        }
    }
    function _ndRunAutoCalibrate() {
        if (!autoCalibrate) return 'autoCalibrate off';
        if (!isDefault) return 'not default';

        if (!detectPreference) return 'detect off (user)';
        if (_calDoneThisPlay) return 'already done this play';
        if (typeof window.setAvOffsetMs !== 'function') return 'no window.setAvOffsetMs';
        const notes = _ndCalibrationNotes();
        if (!notes || !notes.length) return 'no notes';
        const geom = { arrangement: currentArrangement, stringCount: currentStringCount, offsets: tuningOffsets, capo };
        const r = _ndCalibrateOffsetMs(_calDetections, notes, geom, timingHitThreshold, pitchTolerance, {});
        if (!r) return `sweep null (dets=${_calDetections.length}, notes=${notes.length}, arr=${currentArrangement}/${currentStringCount}, win=${timingHitThreshold}, tol=${pitchTolerance})`;
        _calDoneThisPlay = true;
        _lastAvCalibration = r;
        try {
            window.setAvOffsetMs(r.offsetMs);
            console.log(`[note_detect] A/V auto-calibrated to ${r.offsetMs} ms (${r.matched}/${r.total} notes matched)`);

            dispatchInstanceEvent('notedetect:calibrated', { offsetMs: r.offsetMs, matched: r.matched, total: r.total });
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                window.slopsmith.emit('notedetect:calibrated', { offsetMs: r.offsetMs, matched: r.matched, total: r.total });
            }
        } catch (e) { return 'setAvOffsetMs threw: ' + (e && e.message || e); }
        return 'OK ' + JSON.stringify(r);
    }
    let _calOnLoaded = null, _calOnEnded = null, _calOnPause = null, _calOnPlay = null, _calSubscribed = false;
    function _calBindEvents() {
        if (!isDefault || _calSubscribed) return;
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;

        _calOnLoaded = () => {
            _calDetections = []; _calDoneThisPlay = false; _lastAvCalibration = null; _calPaused = false;
        };

        _calOnPlay = () => {
            if (_calPaused) { _calPaused = false; return; }
            _calDetections = []; _calDoneThisPlay = false;
        };

        _calOnPause = () => { _calPaused = true; };

        _calOnEnded = () => { _ndRunAutoCalibrate(); _calPaused = false; };
        try {
            window.slopsmith.on('song:loaded', _calOnLoaded);
            window.slopsmith.on('song:play',   _calOnPlay);
            window.slopsmith.on('song:ended',  _calOnEnded);
            window.slopsmith.on('song:pause',  _calOnPause);
            _calSubscribed = true;
        } catch (_) { _calUnbindEvents(); }
    }
    function _calUnbindEvents() {
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_calOnLoaded) { try { window.slopsmith.off('song:loaded', _calOnLoaded); } catch (_) {} }
            if (_calOnPlay)   { try { window.slopsmith.off('song:play',   _calOnPlay); } catch (_) {} }
            if (_calOnEnded)  { try { window.slopsmith.off('song:ended',  _calOnEnded); } catch (_) {} }
            if (_calOnPause)  { try { window.slopsmith.off('song:pause',  _calOnPause); } catch (_) {} }
        }
        _calOnLoaded = _calOnPlay = _calOnEnded = _calOnPause = null;
        _calSubscribed = false;
    }

    let _liveOnPlay = null, _liveOnEnded = null;
    let _liveSubscribed = false;

    function _startLiveSession() {

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear()
            + pad(now.getMonth() + 1) + pad(now.getDate()) + '_'
            + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());

        const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        _liveSessionId = `${ts}_${rand}`;

        _liveLastSessionId = _liveSessionId;

        _streamLiveJudgment(_buildSessionHeader());
    }

    function _liveBindEvents() {
        if (_liveSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _liveOnPlay = () => { _startLiveSession(); };
        _liveOnEnded = () => {
            _liveSessionId = null;
        };
        try {
            window.slopsmith.on('song:play',  _liveOnPlay);
            window.slopsmith.on('song:ended', _liveOnEnded);
        } catch (e) {
            try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (_) {}
            _liveOnPlay = _liveOnEnded = null;
            return;
        }
        _liveSubscribed = true;
    }
    function _liveUnbindEvents() {
        if (!_liveSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_liveOnPlay)  { try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (e) {} }
            if (_liveOnEnded) { try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (e) {} }
        }
        _liveOnPlay = _liveOnEnded = null;
        _liveSubscribed = false;
        _liveSessionId = null;
    }

    const _DIAGNOSTIC_TRACK_CATALOG = [
        {
            id: 'basic-guitar-6',
            title: 'Slopsmith Diagnostic — Basic Guitar',
            artist: 'Slopsmith',
            arrangement: 'Diagnostic Guitar',
            filenameIncludes: 'slopsmith-diagnostic-basic-guitar.sloppak',
            dlcRelativePath: 'diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak',
            instrument: 'guitar',
            stringCount: 6,
            reportProfile: 'basic-guitar-v1',
            description: 'Checks timing, open strings, fretted notes, and power chords.',
        },
    ];

    function _ndSetDiagnosticLaunchStatus(panel, message) {
        if (!panel) return;
        const el = panel.querySelector('.nd-health-diag-launch-status');
        if (el) el.textContent = message || '';
    }

    function _ndSetDiagnosticLaunchStatusAny(message) {
        const el = document.querySelector('.nd-health-diag-launch-status');
        if (el) el.textContent = message || '';
    }

    function _ndWaitForSongReadyEvent(timeoutMs) {
        const ms = timeoutMs != null ? timeoutMs : 15000;
        return new Promise((resolve) => {
            if (!window.slopsmith || typeof window.slopsmith.on !== 'function') {
                resolve(false);
                return;
            }
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { window.slopsmith.off('song:ready', onReady); } catch (_) {}
                resolve(ok);
            };
            const onReady = () => finish(true);
            const timer = setTimeout(() => finish(false), ms);
            try {
                window.slopsmith.on('song:ready', onReady);
            } catch (_) {
                finish(false);
            }
        });
    }

    function _ndCaptureDiagnosticReturnBeforeLaunch(track) {
        _ndClearDiagnosticReturnState();
        const prevFn = String(_ndShared.currentFilename || '').trim();
        if (!prevFn) return;
        if (_getDiagnosticTrackForSession()) return;
        const diagFn = String(track.dlcRelativePath || '').trim();
        if (!diagFn) return;
        const prevLower = prevFn.toLowerCase();
        if (prevLower === diagFn.toLowerCase()) return;
        if (track.filenameIncludes
            && prevLower.includes(String(track.filenameIncludes).toLowerCase())) {
            return;
        }
        const hw = resolveHw();
        let info = {};
        try {
            info = (hw && hw.getSongInfo) ? (hw.getSongInfo() || {}) : {};
        } catch (_) {  }
        const arrIdx = info.arrangement_index;
        _ndShared.diagnosticReturn.active = true;
        _ndShared.diagnosticReturn.previousFilename = prevFn;
        _ndShared.diagnosticReturn.previousArrangementIndex = Number.isFinite(arrIdx)
            ? arrIdx
            : null;
        _ndShared.diagnosticReturn.previousTitle = info.title || null;
        _ndShared.diagnosticReturn.previousArtist = info.artist || null;
        _ndShared.diagnosticReturn.launchedTrackId = track.id;
        _ndShared.diagnosticReturn.diagnosticFilename = diagFn;
    }

    async function _ndReturnToPreviousSongAfterDiagnostic() {
        const r = _ndShared.diagnosticReturn;
        if (!r || !r.active || !r.previousFilename) {
            return false;
        }
        if (typeof window.playSong !== 'function') {
            _ndSetDiagnosticLaunchStatusAny(
                'Could not return to the previous song. Load it from your library.',
            );
            _ndClearDiagnosticReturnState();
            return false;
        }

        const prevFn = r.previousFilename;
        const arrIdx = r.previousArrangementIndex;
        const readyPromise = _ndWaitForSongReadyEvent();

        try {
            const loadPromise = window.playSong(
                encodeURIComponent(prevFn),
                Number.isFinite(arrIdx) ? arrIdx : undefined,
                { bridge: false },
            );
            if (loadPromise && typeof loadPromise.then === 'function') {
                await loadPromise;
            }
        } catch (e) {
            console.warn('[note_detect] return to previous song failed:', e);
            _ndSetDiagnosticLaunchStatusAny(
                'Could not return to the previous song. Load it from your library.',
            );
            _ndClearDiagnosticReturnState();
            return false;
        }

        const ready = await readyPromise;
        const prevTitle = r.previousTitle;
        _ndClearDiagnosticReturnState();
        if (ready) {
            const label = prevTitle
                ? `Returned to ${prevTitle}. Press Play when ready.`
                : 'Returned to previous song. Press Play when ready.';
            _ndSetDiagnosticLaunchStatusAny(label);
            return true;
        }

        _ndSetDiagnosticLaunchStatusAny(
            'Could not return to the previous song. Load it from your library.',
        );
        return false;
    }

    // Diagnostic playback records enough state to return to the previous song safely.
    async function _ndLaunchDiagnosticTrack(trackId, panel) {
        const track = _DIAGNOSTIC_TRACK_CATALOG.find((t) => t.id === trackId);
        if (!track || !track.dlcRelativePath) {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track is not configured.',
            );
            return;
        }
        if (typeof window.playSong !== 'function') {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track could not be loaded. Restart Slopsmith or rescan your library.',
            );
            return;
        }

        _ndCaptureDiagnosticReturnBeforeLaunch(track);

        _ndSetDiagnosticLaunchStatus(panel, 'Loading diagnostic track…');

        const readyPromise = _ndWaitForSongReadyEvent();

        try {
            const loadPromise = window.playSong(
                encodeURIComponent(track.dlcRelativePath),
                undefined,
                { bridge: false },
            );
            if (loadPromise && typeof loadPromise.then === 'function') {
                await loadPromise;
            }
        } catch (e) {
            console.warn('[note_detect] diagnostic launch failed:', e);
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track could not be loaded. Restart Slopsmith or rescan your library.',
            );
            return;
        }

        const ready = await readyPromise;
        if (ready) {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Loaded Basic Guitar Diagnostic. Press Play or Spacebar to begin.',
            );
            return;
        }

        _ndSetDiagnosticLaunchStatus(
            panel,
            'Diagnostic track is not available yet. Restart Slopsmith or rescan the library. If it still does not appear, the built-in diagnostic pack may not be installed.',
        );
    }

    const _DIAGNOSTIC_REPORT_PROFILES = {
        'basic-guitar-v1': {
            matchTolS: 0.075,
            powerChordCategoryId: 'powerChords',
            expectedChordStrings: 2,
            displayOrder: ['openLow', 'openNext', 'fretted', 'powerChords', 'repeatCheck'],
            singleHitMissCategories: ['openLow', 'openNext', 'fretted'],
            events: [
                { t: 4,  category: 'openLow',      label: 'Open low string',  chord: false, s: 0, f: 0 },
                { t: 8,  category: 'openNext',     label: 'Open next string', chord: false, s: 1, f: 0 },
                { t: 12, category: 'fretted',      label: 'Fretted note',     chord: false, s: 0, f: 5 },
                { t: 16, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 20, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 24, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 28, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 32, category: 'repeatCheck',  label: 'Repeat open low',  chord: false, s: 0, f: 0 },
                { t: 36, category: 'repeatCheck',  label: 'Repeat fretted',   chord: false, s: 0, f: 5 },
                { t: 40, category: 'repeatCheck',  label: 'Repeat power chord', chord: true },
                { t: 44, category: 'repeatCheck',  label: 'Repeat power chord', chord: true },
                { t: 48, category: 'repeatCheck',  label: 'Repeat power chord', chord: true },
            ],
            categories: {
                openLow:     { label: 'Open low string' },
                openNext:    { label: 'Open next string' },
                fretted:     { label: 'Fretted note' },
                powerChords: { label: 'Power chords' },
                repeatCheck: { label: 'Repeat check' },
            },
        },
    };

    function _getDiagnosticTrackForSession() {
        const fn = (_ndShared.currentFilename || '').toLowerCase();
        const currentHw = resolveHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        for (const track of _DIAGNOSTIC_TRACK_CATALOG) {
            if (track.filenameIncludes
                && fn.includes(String(track.filenameIncludes).toLowerCase())) {
                return track;
            }
        }
        for (const track of _DIAGNOSTIC_TRACK_CATALOG) {
            if (info.title === track.title
                && info.artist === track.artist
                && info.arrangement === track.arrangement) {
                return track;
            }
        }
        return null;
    }

    function _diagMatchProfileEvent(events, spec, matchTolS) {
        for (const ev of events) {
            if (!ev || !Number.isFinite(ev.t)) continue;
            if (Math.abs(ev.t - spec.t) > matchTolS) continue;
            if (!!ev.chord !== !!spec.chord) continue;
            if (!spec.chord) {
                if (ev.s !== spec.s || ev.f !== spec.f) continue;
            }
            return ev;
        }
        return null;
    }

    function _buildDiagnosticPlayReportFromProfile(profile, reportProfileId) {
        const events = _diagEvents.slice();
        const chartEvents = profile.events || [];
        const matchTolS = profile.matchTolS != null ? profile.matchTolS : 0.075;
        let matchedCount = 0;
        for (const spec of chartEvents) {
            if (_diagMatchProfileEvent(events, spec, matchTolS)) matchedCount++;
        }
        if (matchedCount === 0) return null;

        const playTotal = hits + misses;
        const overall = {
            hits,
            misses,
            accuracy: playTotal > 0 ? Math.round((hits / playTotal) * 100) : 0,
            bestStreak,
        };

        const categoryMeta = profile.categories || {};
        const categories = {};
        let hasPartialPowerChords = false;
        const powerChordCategoryId = profile.powerChordCategoryId || 'powerChords';
        const expectedChordStrings = profile.expectedChordStrings != null
            ? profile.expectedChordStrings
            : 2;

        for (const catId of Object.keys(categoryMeta)) {
            const specs = chartEvents.filter((s) => s.category === catId);
            let attempts = 0;
            let catHits = 0;
            let catMisses = 0;
            const timingErrors = [];
            const chordAttempts = [];

            for (const spec of specs) {
                const ev = _diagMatchProfileEvent(events, spec, matchTolS);
                if (!ev) continue;
                attempts++;
                if (ev.hit) catHits++; else catMisses++;
                if (Number.isFinite(ev.te)) timingErrors.push(ev.te);
                if (spec.chord) {
                    const hs = Number.isFinite(ev.hs) ? ev.hs : null;
                    const tt = Number.isFinite(ev.tt) ? ev.tt : expectedChordStrings;
                    chordAttempts.push({ t: ev.t, hit: !!ev.hit, hs, tt });
                    if (hs != null && hs < tt) hasPartialPowerChords = true;
                }
            }

            if (attempts === 0) continue;

            const cat = {
                id: catId,
                label: categoryMeta[catId].label,
                attempts,
                hits: catHits,
                misses: catMisses,
                accuracy: Math.round((catHits / attempts) * 100),
                timingMedianMs: timingErrors.length
                    ? _diagPercentile(timingErrors, 50)
                    : null,
            };

            if (catId === powerChordCategoryId && chordAttempts.length) {
                const heard = chordAttempts.filter((c) => c.hs != null);
                const avgHeard = heard.length
                    ? heard.reduce((sum, c) => sum + c.hs, 0) / heard.length
                    : null;
                cat.chordHits = catHits;
                cat.chordMisses = catMisses;
                cat.avgStringsHeard = avgHeard;
                cat.expectedStrings = expectedChordStrings;
                cat.perAttempt = chordAttempts.map((c) => {
                    const heardTxt = c.hs != null
                        ? `heard ${c.hs} of ${c.tt} strings`
                        : 'strings heard unknown';
                    return { t: c.t, hit: c.hit, heardTxt };
                });
            }

            categories[catId] = cat;
        }

        if (!Object.keys(categories).length) return null;

        return {
            reportProfile: reportProfileId,
            overall,
            categories,
            matchedCount,
            hasPartialPowerChords,
            sections: sectionStats.map((s) => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? Math.round((s.hits / (s.hits + s.misses)) * 100)
                    : 0,
            })),
        };
    }

    function _buildDiagnosticPlayReport(track) {
        if (!track || !track.reportProfile) return null;
        const profile = _DIAGNOSTIC_REPORT_PROFILES[track.reportProfile];
        if (!profile) return null;
        if (track.reportProfile === 'basic-guitar-v1') {
            return _buildDiagnosticPlayReportFromProfile(profile, track.reportProfile);
        }
        return null;
    }

    function _diagPlayReportHitMissHtml(hit) {
        return hit
            ? '<span class="text-green-400">Hit</span>'
            : '<span class="text-red-400">Miss</span>';
    }

    function _renderDiagnosticPlayHtml(report, reportProfileId) {
        if (!report || !report.categories) return '';
        if (reportProfileId === 'basic-guitar-v1') {
            return _renderDiagnosticBasicGuitarPlayHtml(report);
        }
        return '';
    }

    function _renderDiagnosticBasicGuitarPlayHtml(report) {
        const profile = _DIAGNOSTIC_REPORT_PROFILES['basic-guitar-v1'];
        if (!report || !report.categories || !profile) return '';
        const cats = report.categories;
        let rows = '';

        for (const id of (profile.singleHitMissCategories || [])) {
            const c = cats[id];
            if (!c || !c.attempts) continue;
            rows += `<div class="flex justify-between gap-2 mb-1">`
                + `<span class="text-gray-300">${c.label}</span>`
                + _diagPlayReportHitMissHtml(c.hits > 0)
                + `</div>`;
        }

        const pwr = cats[profile.powerChordCategoryId || 'powerChords'];
        if (pwr && pwr.attempts) {
            let pwrDetail = '';
            if (pwr.avgStringsHeard != null) {
                pwrDetail += `<div class="text-[10px] text-gray-500">`
                    + `${pwr.chordHits}/${pwr.attempts} hit`
                    + ` · avg heard ${pwr.avgStringsHeard.toFixed(1)} of ${pwr.expectedStrings} strings`
                    + `</div>`;
            } else {
                pwrDetail += `<div class="text-[10px] text-gray-500">${pwr.hits}/${pwr.attempts} hit</div>`;
            }
            const partialLines = (pwr.perAttempt || [])
                .filter((a) => a.heardTxt && (!a.hit || a.heardTxt.indexOf('heard 2 of 2') === -1))
                .map((a) => {
                    const prefix = Number.isFinite(a.t) ? `${a.t}s: ` : '';
                    return `${prefix}${a.heardTxt}`;
                });
            if (partialLines.length) {
                pwrDetail += `<div class="text-[10px] text-gray-500 mt-0.5">`
                    + partialLines.join('<br>')
                    + `</div>`;
            }
            rows += `<div class="mb-1">`
                + `<div class="flex justify-between gap-2">`
                + `<span class="text-gray-300">${pwr.label}</span>`
                + `<span class="text-gray-400">${pwr.hits}/${pwr.attempts} hit</span>`
                + `</div>${pwrDetail}</div>`;
        }

        const rep = cats.repeatCheck;
        if (rep && rep.attempts) {
            rows += `<div class="flex justify-between gap-2 mb-1">`
                + `<span class="text-gray-300">${rep.label}</span>`
                + `<span class="text-gray-400">${rep.hits}/${rep.attempts} hit</span>`
                + `</div>`;
        }

        if (!rows) return '';

        let notes = '<p class="text-[10px] text-gray-500 mt-2">'
            + 'This diagnostic report did not change gameplay settings.'
            + '</p>';
        if (report.hasPartialPowerChords) {
            notes += '<p class="text-[10px] text-gray-500 mt-1">'
                + 'Power chords were partly heard. Try a cleaner/drier channel or run '
                + 'Technique Assessment for root/fifth detail.'
                + '</p>';
        }

        return `<div class="mt-3 text-xs border-t border-gray-600 pt-3">`
            + `<div class="text-gray-200 text-xs font-semibold mb-2">Diagnostic Results</div>`
            + rows
            + notes
            + `</div>`;
    }

    // Summary rendering reads an immutable snapshot of the completed take.
    function showSummary(opts) {
        if (!_summaryWorthy()) return false;
        const total = hits + misses;

        const existing = instanceRoot.querySelector('.nd-summary-overlay');
        if (existing) { existing.remove(); _ndAutoExitRelease = null; }

        const accuracy = Math.round((hits / total) * 100);
        const grade = _ndGradeFor(accuracy);
        const fullCombo = misses === 0;

        const _summaryHw = resolveHw();
        const _summaryInfo = (_summaryHw && _summaryHw.getSongInfo)
            ? (_summaryHw.getSongInfo() || {}) : {};
        const songTitle = _summaryInfo.title ? String(_summaryInfo.title) : '';
        const songArtist = _summaryInfo.artist ? String(_summaryInfo.artist) : '';
        const instrument = _ndInstrumentLabel(_summaryInfo.arrangement);
        const arrangementIndex = Number.isFinite(_summaryInfo.arrangement_index)
            ? _summaryInfo.arrangement_index : undefined;
        const retryFilename = _ndShared.currentFilename || '';
        const canRetry = !!retryFilename && typeof window.playSong === 'function';
        const artUrl = _ndSongArtUrl(retryFilename);

        const _bestId = _ndSongBestId(retryFilename, arrangementIndex);
        const _prevBest = retryFilename ? _ndReadSongBest(_bestId) : null;
        const _bestDelta = _ndComputeBestDelta(_prevBest, { accuracy });
        if (retryFilename && opts && opts.claimAutoExit) {
            _ndWriteSongBest(_bestId, { accuracy, score, bestStreak });
        }

        let bestHtml = '';
        if (_prevBest) {
            let cls = 'nd-sum-best', txt;
            if (_bestDelta.newBest) {
                cls += ' nd-sum-best--up';
                txt = `★ New best · +${_bestDelta.accDelta}% accuracy`;
            } else if (_bestDelta.accDelta === 0) {
                txt = `Matched your best · ${_bestDelta.bestAcc}%`;
            } else {
                txt = `Your best · ${_bestDelta.bestAcc}%`;
            }
            bestHtml = `<div class="${cls}">${_ndEscapeHtml(txt)}</div>`;
        }

        const _hwSections = (_summaryHw && _summaryHw.getSections)
            ? (_summaryHw.getSections() || []) : [];
        const _sectionRange = (name) => {
            for (let i = 0; i < _hwSections.length; i++) {
                if (!_hwSections[i] || _hwSections[i].name !== name) continue;
                const start = Number(_hwSections[i].time);
                if (!Number.isFinite(start)) return null;
                let end = (i + 1 < _hwSections.length) ? Number(_hwSections[i + 1].time) : NaN;
                if (!Number.isFinite(end) || end <= start) {
                    let d = Number(_summaryInfo.duration) || 0;
                    if (d > 6000) d /= 1000;
                    end = (d > start) ? d : start + 30;
                }
                return { start, end };
            }
            return null;
        };
        const shareSections = sectionStats.map((s) => {
            const t = s.hits + s.misses;
            return { name: s.name, acc: t > 0 ? Math.round((s.hits / t) * 100) : 0 };
        });

        const _heroSectionInput = sectionStats.map((s) => {
            const t = s.hits + s.misses;
            return { name: s.name, acc: t > 0 ? Math.round((s.hits / t) * 100) : null };
        });
        const _heroPick = _ndPickHeroAction({ accuracy, canRetry, sections: _heroSectionInput });
        let _heroRange = null;
        if (_heroPick.kind === 'practice-section') {
            _heroRange = _sectionRange(_heroPick.sectionName);

            if (!_heroRange) { _heroPick.kind = 'retry'; _heroPick.reason = ''; }
        }
        const _heroIsSection = _heroPick.kind === 'practice-section';
        const heroReasonHtml = _heroPick.reason
            ? `<div class="nd-sum-hero-reason">${_ndEscapeHtml(_heroPick.reason)}</div>`
            : '';

        let _topSec = null;
        for (const s of sectionStats) {
            const t = s.hits + s.misses;
            if (t <= 0) continue;
            const acc = Math.round((s.hits / t) * 100);
            if (!_topSec || acc > _topSec.acc) _topSec = { name: s.name, acc };
        }
        let _durSec = Number(_summaryInfo.duration) || 0;
        if (_durSec > 6000) _durSec /= 1000;
        const _fmtDur = (n) => {
            n = Math.max(0, Math.round(n));
            return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
        };
        let extraLabel, extraValue, extraValueFull;
        if (_topSec) {
            extraLabel = 'Top Section';
            extraValue = _topSec.name;
            extraValueFull = _topSec.name;
        } else if (_durSec > 0) {
            extraLabel = 'Length'; extraValue = _fmtDur(_durSec); extraValueFull = extraValue;
        } else {
            extraLabel = 'Notes'; extraValue = String(total); extraValueFull = extraValue;
        }
        const shareData = {
            title: songTitle, artist: songArtist, instrument, artUrl,
            accuracy, score, hits, misses, bestStreak, maxMultiplier, fullCombo,
            sections: shareSections, extraLabel, extraValue,
        };

        if (opts && opts.autoSave) {
            try { _ndSaveCard(shareData, instanceRoot, { auto: true }); } catch (e) {}
        }
        const metaSub = [songArtist, instrument].filter(Boolean).join(' · ');
        const songMetaHtml = (songTitle || metaSub)
            ? `<div class="nd-sum-songmeta">
                <div class="nd-sum-song-text">${
                    songTitle ? `<div class="nd-sum-song-title">${_ndEscapeHtml(songTitle)}</div>` : ''
                }${
                    metaSub ? `<div class="nd-sum-song-sub">${_ndEscapeHtml(metaSub)}</div>` : ''
                }</div>${
                    artUrl ? `<img class="nd-sum-art" alt="" src="${artUrl}">` : ''
                }</div>`
            : '';

        let sectionHtml = '';
        if (sectionStats.length > 0) {
            sectionHtml = '<div class="nd-sum-sections"><div class="nd-sum-subhead">Per Section</div>';
            for (const sec of sectionStats) {
                const secTotal = sec.hits + sec.misses;
                const secAcc = secTotal > 0 ? Math.round((sec.hits / secTotal) * 100) : 0;

                const cls = secAcc >= 90 ? 'nd-bar-good' : 'nd-bar-mid';

                const range = canRetry ? _sectionRange(sec.name) : null;
                const practiceBtn = range
                    ? `<button type="button" class="nd-sum-practice" data-start="${range.start}" data-end="${range.end}" title="Loop this section to practice it">Practice</button>`
                    : '';
                sectionHtml += `
                    <div class="nd-sum-bar-row">
                        <span class="nd-sum-bar-label">${_ndEscapeHtml(sec.name)}</span>
                        <div class="nd-sum-bar-track"><div class="nd-sum-bar-fill ${cls}" style="--nd-bar-w:${secAcc}%"></div></div>
                        <span class="nd-sum-bar-val">${secAcc}%</span>
                        ${practiceBtn}
                    </div>
                `;
            }
            sectionHtml += '</div>';
        }

        let focusHtml = '';
        if (sectionStats.length > 0 && !_heroIsSection) {
            let weakest = null;
            for (const sec of sectionStats) {
                const t = sec.hits + sec.misses;
                if (t <= 0) continue;
                const acc = Math.round((sec.hits / t) * 100);
                if (!weakest || acc < weakest.acc) weakest = { name: sec.name, acc };
            }
            if (weakest && weakest.acc < 90) {
                focusHtml = `<div class="nd-sum-focus"><span class="nd-sum-focus-label">Focus next</span>${_ndEscapeHtml(weakest.name)} · ${weakest.acc}%</div>`;
            }
        }

        let breakdownHtml = '';
        if (tuningMode && misses > 0) {
            const labels = {
                pure:         ['Pure (no pitch)',    'nd-bar-dim'],
                chordPartial: ['Chord — partial',    'nd-bar-alt'],
                early:        ['Timing — early',     'nd-bar-mid'],
                late:         ['Timing — late',      'nd-bar-mid'],
                sharp:        ['Pitch — sharp',      'nd-bar-cool'],
                flat:         ['Pitch — flat',       'nd-bar-cool'],
            };
            breakdownHtml = '<div class="nd-sum-sections"><div class="nd-sum-subhead">Miss Breakdown</div>';
            for (const k of Object.keys(labels)) {
                const v = _diagBreakdown[k] || 0;
                if (v === 0) continue;
                const pct = Math.round((v / misses) * 100);
                breakdownHtml += `
                    <div class="nd-sum-bar-row">
                        <span class="nd-sum-bar-label">${labels[k][0]}</span>
                        <div class="nd-sum-bar-track"><div class="nd-sum-bar-fill ${labels[k][1]}" style="--nd-bar-w:${pct}%"></div></div>
                        <span class="nd-sum-bar-val">${v} (${pct}%)</span>
                    </div>
                `;
            }
            const timingMed = _diagPercentile(_diagTimingErrors, 50);
            const pitchMed  = _diagPercentile(_diagPitchErrors, 50);
            if (timingMed != null || pitchMed != null) {
                breakdownHtml += '<div class="nd-sum-note">';
                if (timingMed != null) {
                    const tp10 = _diagPercentile(_diagTimingErrors, 10);
                    const tp90 = _diagPercentile(_diagTimingErrors, 90);
                    breakdownHtml += `Timing err (ms): median ${timingMed}, p10..p90 [${tp10}..${tp90}]<br>`;
                }
                if (pitchMed != null) {
                    const pp10 = _diagPercentile(_diagPitchErrors, 10);
                    const pp90 = _diagPercentile(_diagPitchErrors, 90);
                    breakdownHtml += `Pitch err (¢): median ${pitchMed}, p10..p90 [${pp10}..${pp90}]`;
                }
                breakdownHtml += '</div>';
            }
            breakdownHtml += '</div>';
        }

        let diagnosticPlayHtml = '';
        const diagnosticTrack = _getDiagnosticTrackForSession();
        const diagnosticReport = diagnosticTrack
            ? _buildDiagnosticPlayReport(diagnosticTrack)
            : null;
        if (diagnosticReport) {
            diagnosticPlayHtml = _renderDiagnosticPlayHtml(
                diagnosticReport,
                diagnosticTrack.reportProfile,
            );
        }

        const returnSnap = _ndShared.diagnosticReturn;
        const showReturnPrevBtn = !!(diagnosticReport
            && returnSnap
            && returnSnap.active
            && returnSnap.previousFilename);

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay' + (_ndResultsGlowOn() ? ' nd-glow' : '');

        try { overlay.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        overlay.style.pointerEvents = 'auto';

        const _ndDismissSummary = (navigateHome) => {
            overlay.remove();
            const release = _ndAutoExitRelease;
            _ndAutoExitRelease = null;
            if (release && navigateHome) { try { release(); } catch (e) {} }
        };

        const _ndQueue = (window.feedBack && window.feedBack.playQueue)
            || (window.slopsmith && window.slopsmith.playQueue) || null;
        const _ndQueueNext = (_ndQueue && typeof _ndQueue.active === 'function'
            && _ndQueue.active() && typeof _ndQueue.peekNext === 'function')
            ? _ndQueue.peekNext() : null;

        const _ndQueueNextLabel = _ndQueueNext
            ? String(_ndQueueNext.filename).split('/').pop().replace(/\.(feedpak|sloppak)$/i, '')
            : '';

        const _ndQueueActive = !!(_ndQueue && typeof _ndQueue.active === 'function'
            && _ndQueue.active() && typeof _ndQueue.peekNext === 'function');
        if (_ndQueueActive && opts && opts.claimAutoExit) {
            const _ndPrevEntry = _ndSetLog.length ? _ndSetLog[_ndSetLog.length - 1] : null;
            _ndSetLog = _ndSetLogAppend(_ndSetLog, {
                pos: _ndQueueNext ? (_ndQueueNext.index - 1)
                    : (_ndPrevEntry ? _ndPrevEntry.pos + 1 : 0),
                total: _ndQueueNext ? _ndQueueNext.total
                    : (_ndPrevEntry ? _ndPrevEntry.total : 1),
                filename: retryFilename,
                title: songTitle
                    || String(retryFilename).split('/').pop().replace(/\.sloppak$/i, ''),
                artist: songArtist,
                accuracy: accuracy, hits: hits, misses: misses,
            });
        }

        const _ndSetDone = _ndQueueActive && !_ndQueueNext
            && _ndQueueSetSummaryEnabled() && _ndSetLog.length >= 2;

        const _ndScoreless = !_ndQueueShowScores() && _ndQueueActive && !!_ndQueueNext;
        if (_ndScoreless) { try { overlay.classList.add('nd-sum-scoreless'); } catch (e) {} }

        const _ndRenderSetSummary = () => {
            const log = _ndSetLog.slice();
            const avg = _ndSetLogAverage(log);
            const src = (_ndQueue && typeof _ndQueue.source === 'function'
                && _ndQueue.source()) || '';
            const rows = log.map((e, i) => `
                <div class="nd-set-row">
                    <span class="nd-set-row-n">${i + 1}</span>
                    <span class="nd-set-row-title">${_ndEscapeHtml(e.artist ? (e.artist + ' — ' + e.title) : e.title)}</span>
                    <span class="nd-set-row-acc">${Number(e.accuracy) || 0}%</span>
                </div>`).join('');
            overlay.classList.remove('nd-sum-scoreless');
            overlay.innerHTML = `
                <div class="nd-sum-shell">
                <div class="nd-sum-panel">
                    <div class="nd-sum-header">Set Complete</div>
                    ${src ? `<div class="nd-sum-song">${_ndEscapeHtml(src)}</div>` : ''}
                    <div class="nd-sum-headline">
                        <div class="nd-sum-acc"><span class="nd-sum-acc-n">${avg}</span>%<div class="nd-sum-label">Average accuracy</div></div>
                        <div class="nd-sum-score"><span class="nd-sum-score-n">${log.length}</span><div class="nd-sum-label">Songs played</div></div>
                    </div>
                    <div class="nd-set-rows">${rows}</div>
                    <div class="nd-sum-actions">
                        <button type="button" class="nd-summary-close nd-btn nd-btn-primary">Exit Song</button>
                    </div>
                </div>
                <div class="nd-sum-frame"></div>
                </div>
            `;
            try { overlay.classList.add('nd-revealed'); } catch (e) {}

            overlay._ndReveal = null;
            const exitBtn = overlay.querySelector('.nd-summary-close');
            if (exitBtn) exitBtn.onclick = () => {
                _ndSetLog = [];
                try { if (_ndQueue) _ndQueue.clear(); } catch (e) {}
                _ndDismissSummary(true);
            };
        };

        overlay.innerHTML = `
            <div class="nd-sum-shell">
            <div class="nd-sum-panel">
                <canvas class="nd-sum-confetti"></canvas>
                <div class="nd-sum-header">Song Complete</div>
                ${songMetaHtml}
                ${fullCombo ? '<div class="nd-sum-fc">★ Full Combo</div>' : ''}
                <div class="nd-sum-headline">
                    <div class="nd-sum-acc"><span class="nd-sum-acc-n">0</span>%<div class="nd-sum-label">Accuracy</div></div>
                    <div class="nd-sum-score"><span class="nd-sum-score-n">0</span><div class="nd-sum-label">Score</div></div>
                </div>
                ${bestHtml}
                <div class="nd-sum-stats">
                    <div class="nd-sum-stat" style="--row-i:0"><span class="nd-sum-stat-label">Hits</span><span class="nd-sum-stat-val nd-val-good">${hits}/${total}</span></div>
                    <div class="nd-sum-stat" style="--row-i:1"><span class="nd-sum-stat-label">${_ndEscapeHtml(extraLabel)}</span><span class="nd-sum-stat-val nd-val-accent">${_ndEscapeHtml(extraValueFull)}</span></div>
                    <div class="nd-sum-stat" style="--row-i:2"><span class="nd-sum-stat-label">Best Streak</span><span class="nd-sum-stat-val nd-val-accent">${bestStreak}</span></div>
                    <div class="nd-sum-stat" style="--row-i:3"><span class="nd-sum-stat-label">Max Multiplier</span><span class="nd-sum-stat-val nd-val-accent">×${maxMultiplier}</span></div>
                </div>
                <div class="nd-sum-xp hidden"></div>
                ${breakdownHtml}
                ${focusHtml}
                ${sectionHtml}
                ${diagnosticPlayHtml}
                <div class="nd-sum-share">
                    <button type="button" class="nd-summary-copy nd-btn"
                            title="Copy a shareable score card to the clipboard">Copy card</button>
                    <button type="button" class="nd-summary-save nd-btn"
                            title="Save the score card as a PNG">⤓ Save</button>
                </div>
                ${heroReasonHtml}
                ${_ndQueueNext ? `
                <div class="nd-sum-upnext">
                    <span class="nd-sum-upnext-meta">Up next (${_ndQueueNext.index + 1} of ${_ndQueueNext.total})</span>
                    <span class="nd-sum-upnext-title">${_ndEscapeHtml(_ndQueueNextLabel)}</span>
                    <span class="nd-sum-upnext-count"></span>
                    <span class="nd-sum-upnext-btns">
                        <button type="button" class="nd-summary-next nd-btn nd-btn-primary">▶ Play now</button>
                        <button type="button" class="nd-summary-stay nd-btn">⏸ Stay</button>
                    </span>
                </div>` : (_ndSetDone ? `
                <div class="nd-sum-upnext">
                    <span class="nd-sum-upnext-meta">Set complete (${_ndSetLog.length} songs)</span>
                    <span class="nd-sum-upnext-title">Average accuracy ${_ndSetLogAverage(_ndSetLog)}%</span>
                    <span class="nd-sum-upnext-btns">
                        <button type="button" class="nd-summary-setsum nd-btn nd-btn-primary">View set summary</button>
                    </span>
                </div>` : '')}
                <div class="nd-sum-actions">
                    ${showReturnPrevBtn ? `
                    <button type="button" class="nd-summary-return-prev nd-btn">
                        Return to Previous Song
                    </button>` : ''}
                    ${tuningMode ? `
                    <button class="nd-summary-download nd-btn">
                        Download Diagnostic JSON
                    </button>` : ''}
                    ${_heroIsSection ? `
                    <button type="button" class="nd-summary-hero-practice nd-btn nd-btn-primary"
                            data-start="${_heroRange.start}" data-end="${_heroRange.end}"
                            title="Loop ${_ndEscapeHtml(_heroPick.sectionName)} to practice it">
                        Practice: ${_ndEscapeHtml(_heroPick.sectionName)}
                    </button>` : ''}
                    ${canRetry ? `
                    <button type="button" class="nd-summary-retry nd-btn${_heroIsSection ? '' : ' nd-btn-primary'}">
                        Retry Song
                    </button>` : ''}
                    <button type="button" class="nd-summary-close nd-btn${canRetry ? '' : ' nd-btn-primary'}">
                        Exit Song
                    </button>
                </div>
            </div>
            <div class="nd-sum-frame"></div>
            </div>
        `;
        const closeBtn = overlay.querySelector('.nd-summary-close');
        if (closeBtn) closeBtn.onclick = () => _ndDismissSummary(true);

        if (_ndQueueNext) {
            const nextBtn = overlay.querySelector('.nd-summary-next');
            const stayBtn = overlay.querySelector('.nd-summary-stay');
            const countEl = overlay.querySelector('.nd-sum-upnext-count');
            const titleEl = overlay.querySelector('.nd-sum-upnext-title');
            try {

                const _ndNextUrl = String(_ndQueueNext.filename)
                    .split('/').map(encodeURIComponent).join('/');
                fetch('/api/song/' + _ndNextUrl)
                    .then((r) => (r && r.ok ? r.json() : null))
                    .then((m) => {
                        if (m && m.title && titleEl && titleEl.isConnected) {
                            titleEl.textContent = m.artist ? (m.artist + ' — ' + m.title) : m.title;
                        }
                    })
                    .catch(() => {});
            } catch (e) {}
            let _ndAdvanceTimer = null;
            const _ndStopCountdown = () => {
                if (_ndAdvanceTimer) { clearInterval(_ndAdvanceTimer); _ndAdvanceTimer = null; }
                if (countEl) countEl.textContent = '';
                if (stayBtn) stayBtn.style.display = 'none';
            };
            const _ndQueueAdvance = () => {

                if (!overlay.isConnected) return;
                _ndStopCountdown();
                _ndAutoExitRelease = null;
                overlay.remove();
                try { _ndQueue.advance(); } catch (e) {}
            };
            if (nextBtn) nextBtn.onclick = _ndQueueAdvance;
            if (stayBtn) stayBtn.onclick = _ndStopCountdown;
            let _ndSecsLeft = _ndQueueDelaySeconds();

            const _ndStartUpNext = () => {
                if (_ndSecsLeft <= 0) {

                    setTimeout(_ndQueueAdvance, 0);
                    return;
                }
                if (countEl) countEl.textContent = 'starting in ' + Math.ceil(_ndSecsLeft) + 's';
                _ndAdvanceTimer = setInterval(() => {

                    if (!overlay.isConnected) { _ndStopCountdown(); return; }
                    _ndSecsLeft -= 1;
                    if (_ndSecsLeft <= 0) { _ndQueueAdvance(); return; }
                    if (countEl) countEl.textContent = 'starting in ' + Math.ceil(_ndSecsLeft) + 's';
                }, 1000);
            };
            if (opts && opts.startHidden) { overlay._ndStartUpNext = _ndStartUpNext; }
            else { _ndStartUpNext(); }
            if (closeBtn) closeBtn.onclick = () => {
                _ndStopCountdown();
                try { _ndQueue.clear(); } catch (e) {}
                _ndDismissSummary(true);
            };
        }

        if (_ndSetDone) {
            const setsumBtn = overlay.querySelector('.nd-summary-setsum');
            if (setsumBtn) setsumBtn.onclick = _ndRenderSetSummary;
            if (closeBtn) closeBtn.onclick = () => {
                _ndSetLog = [];
                _ndDismissSummary(true);
            };
        }

        const artImgEl = overlay.querySelector('.nd-sum-art');
        if (artImgEl) artImgEl.onerror = () => { try { artImgEl.remove(); } catch (e) {} };

        const copyBtn = overlay.querySelector('.nd-summary-copy');
        if (copyBtn) copyBtn.onclick = () => _ndShareCardClick(copyBtn, 'copy', shareData, overlay);
        const saveBtn = overlay.querySelector('.nd-summary-save');
        if (saveBtn) saveBtn.onclick = () => _ndShareCardClick(saveBtn, 'download', shareData, overlay);

        const retryBtn = overlay.querySelector('.nd-summary-retry');
        if (retryBtn) {
            retryBtn.onclick = () => {
                if (!canRetry) { _ndDismissSummary(true); return; }
                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                try {
                    const p = window.playSong(
                        encodeURIComponent(retryFilename),
                        arrangementIndex,
                        { bridge: false },
                    );
                    if (p && typeof p.then === 'function') {
                        p.catch((e) => {
                            console.warn('[note_detect] retry song failed:',
                                e && e.message ? e.message : e);
                            _fallback();
                        });
                    }
                } catch (e) {
                    console.warn('[note_detect] retry song failed:',
                        e && e.message ? e.message : e);
                    _fallback();
                }
            };
        }

        (overlay.querySelectorAll('.nd-sum-practice, .nd-summary-hero-practice') || []).forEach((pBtn) => {
            pBtn.onclick = () => {
                if (!canRetry) { _ndDismissSummary(true); return; }
                const a = Number(pBtn.dataset.start), b = Number(pBtn.dataset.end);
                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                try {
                    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {

                        window._pendingHighwayLoop = { a, b, returnCtx: null };
                    }
                    const p = window.playSong(
                        encodeURIComponent(retryFilename), arrangementIndex, { bridge: false },
                    );
                    if (p && typeof p.then === 'function') {
                        p.catch((e) => {
                            console.warn('[note_detect] practice section failed:',
                                e && e.message ? e.message : e);
                            try { window._pendingHighwayLoop = null; } catch (_) {}
                            _fallback();
                        });
                    }
                } catch (e) {
                    console.warn('[note_detect] practice section failed:',
                        e && e.message ? e.message : e);
                    try { window._pendingHighwayLoop = null; } catch (_) {}
                    _fallback();
                }
            };
        });
        const returnPrevBtn = overlay.querySelector('.nd-summary-return-prev');
        if (returnPrevBtn) {
            returnPrevBtn.onclick = () => {

                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                _ndReturnToPreviousSongAfterDiagnostic().then((ok) => {
                    if (!ok) _fallback();
                }).catch((e) => {
                    console.warn('[note_detect] return to previous song failed:',
                        e && e.message ? e.message : e);
                    _fallback();
                });
            };
        }
        const dlBtn = overlay.querySelector('.nd-summary-download');
        if (dlBtn) dlBtn.onclick = () => _downloadDiagnostic();

        overlay._ndReveal = { accuracy, score, fullCombo };

        if (opts && opts.startHidden) overlay.style.display = 'none';
        instanceRoot.appendChild(overlay);
        if (!(opts && opts.startHidden)) _animateSummary(overlay, overlay._ndReveal);

        if (opts && opts.claimAutoExit && window.slopsmith
            && window.slopsmith.autoplayExit
            && typeof window.slopsmith.holdAutoExit === 'function') {
            try { _ndAutoExitRelease = window.slopsmith.holdAutoExit(); } catch (e) {}
        }

        if (_ndSetDone && !_ndQueueShowScores()) _ndRenderSetSummary();

        publishToJournal(accuracy);
        return true;
    }

    function _animateSummary(overlay, vals) {
        if (!overlay || !vals) return;
        const accEl = overlay.querySelector('.nd-sum-acc-n');
        const scoreEl = overlay.querySelector('.nd-sum-score-n');
        const setFinal = () => {
            if (accEl) accEl.textContent = String(vals.accuracy);
            if (scoreEl) scoreEl.textContent = String(vals.score);
        };
        let reduced = false;
        try {
            reduced = !!(window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) {}
        const reveal = () => { try { overlay.classList.add('nd-revealed'); } catch (e) {} };
        if (reduced || typeof requestAnimationFrame !== 'function') {
            reveal();
            setFinal();
            return;
        }

        requestAnimationFrame(() => requestAnimationFrame(reveal));
        const DUR_MS = 1400;
        let start = null;
        const tick = (now) => {
            if (overlay.isConnected === false) return;
            if (start === null) start = now;
            const t = Math.min(1, (now - start) / DUR_MS);
            const ease = 1 - Math.pow(1 - t, 3);
            if (accEl) accEl.textContent = String(Math.round(vals.accuracy * ease));
            if (scoreEl) scoreEl.textContent = String(Math.round(vals.score * ease));
            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                setFinal();

                if (vals.fullCombo || vals.accuracy >= 90) _runConfetti(overlay);
            }
        };
        requestAnimationFrame(tick);
    }

    function _runConfetti(overlay) {
        try {
            if (window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        } catch (e) {}
        const canvas = overlay.querySelector('.nd-sum-confetti');
        if (!canvas || typeof canvas.getContext !== 'function') return;
        const wrap = canvas.parentElement;
        const W = canvas.width = (wrap && wrap.clientWidth) || 360;
        const H = canvas.height = (wrap && wrap.clientHeight) || 130;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let colors = ['#00f0ff', '#ff2ec4', '#00ff88', '#ffffff'];
        try {
            const cs = getComputedStyle(overlay);
            const a = cs.getPropertyValue('--nd-accent').trim();
            const b = cs.getPropertyValue('--nd-accent2').trim();
            const h = cs.getPropertyValue('--nd-hit').trim();
            if (a) colors = [a, b || a, h || a, '#ffffff'];
        } catch (e) {}
        const parts = [];
        for (let i = 0; i < 70; i++) {
            parts.push({
                x: W / 2 + (Math.random() - 0.5) * W * 0.35,
                y: H * 0.6,
                vx: (Math.random() - 0.5) * 4.2,
                vy: -(1.8 + Math.random() * 3.4),
                rot: Math.random() * Math.PI,
                vr: (Math.random() - 0.5) * 0.3,
                size: 2.5 + Math.random() * 3.5,
                color: colors[i % colors.length],
            });
        }
        const LIFE_MS = 1500;
        let t0 = null;
        const frame = (now) => {
            if (overlay.isConnected === false) return;
            if (t0 === null) t0 = now;
            const t = now - t0;
            ctx.clearRect(0, 0, W, H);
            if (t >= LIFE_MS) return;
            const fade = 1 - t / LIFE_MS;
            for (const p of parts) {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.10;
                p.rot += p.vr;
                ctx.save();
                ctx.globalAlpha = fade;
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                ctx.restore();
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    function publishToJournal(accuracy) {

        const currentHw = resolveHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        if (!info) return;
        dispatchInstanceEvent('notedetect:session', {
            title: info.title,
            artist: info.artist,
            arrangement: info.arrangement,
            accuracy,
            hits,
            misses,
            bestStreak,

            score,
            maxMultiplier,
            grade: _ndGradeFor(accuracy),
            fullCombo: misses === 0,
            sections: sectionStats.map(s => ({
                name: s.name,
                accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
            })),
            timestamp: new Date().toISOString(),
        });
    }

    // Public methods appear first; underscored members support tests and headless tools.
    const api = {
        enable,
        disable,
        destroy,
        isEnabled: () => enabled,

        startDrill,
        startDrillHere,
        endDrill,
        isDrilling: () => drillConductorActive,
        getConductorState: () => ({
            active: drillConductorActive,
            label: drillConductorLabel,
            focus: drillConductorFocus,
            goal: drillConductorGoal,
            best: drillConductorBest,
            rung: drillConductorRung,
            ladder: drillConductorLadder ? drillConductorLadder.slice() : null,
            speed: drillConductorLadder ? (drillConductorLadder[drillConductorRung] || null) : null,
            range: drillConductorRange ? { ...drillConductorRange } : null,
        }),

        setVerifyTarget: (notes, ctx) => {
            if (!Array.isArray(notes)) {
                _verifyTarget = null; _verifyTargetSig = null; _verifyTargetCtx = null;
                return;
            }

            const clean = notes
                .filter(n => n
                    && Number.isInteger(n.s) && n.s >= 0
                    && Number.isInteger(n.f) && n.f >= 0)
                .map(n => ({
                    s: n.s, f: n.f,
                    ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
                }));
            let cleanNotes = clean.length ? clean : null;

            const vctx = cleanNotes ? _ndSanitizeVerifyCtx(ctx) : null;
            if (cleanNotes && vctx) {

                cleanNotes = cleanNotes.filter(n => n.s < vctx.stringCount);
                if (!cleanNotes.length) cleanNotes = null;
            }
            _verifyTarget = cleanNotes;
            _verifyTargetCtx = cleanNotes ? vctx : null;

            _verifyTargetSig = cleanNotes ? _ndVerifyActiveSig() : null;
        },
        getVerifyTarget: () => (_verifyTarget ? _verifyTarget.map(n => ({ ...n })) : null),

        getVerifyContext: () => (_verifyTargetCtx
            ? { arrangement: _verifyTargetCtx.arrangement, stringCount: _verifyTargetCtx.stringCount,
                offsets: _verifyTargetCtx.offsets.slice(), capo: _verifyTargetCtx.capo }
            : null),

        setContainedChart: (notes, ctx) => _ndSetContainedChart(notes, ctx),

        pushContainedPlayhead: (t, playing) => _ndPushContainedPlayhead(t, playing),

        drainContainedVerdicts: () => _ndDrainContainedVerdicts(),

        releaseContainedChart: () => _ndReleaseContainedChart(),

        isContainedVerifierAvailable: () => _ndContainedVerifierAvailable(),

        getStats: () => {
            const accuracy = (hits + misses) > 0 ? Math.round(hits / (hits + misses) * 100) : 0;
            return {
                hits, misses, streak, bestStreak,
                accuracy,
                score, multiplier, maxMultiplier,
                grade: _ndGradeFor(accuracy),
                sectionStats: sectionStats.map(s => ({ name: s.name, hits: s.hits, misses: s.misses })),
            };
        },

        wantsDetect: () => !!detectPreference,

        getDrillStats: () => {

            _drillSyncFromLoopState();
            const liveTotal = drillIterHits + drillIterMisses;
            return {
                active: drillEnabled,
                current: {
                    hits: drillIterHits,
                    misses: drillIterMisses,
                    streak: drillIterStreak,
                    bestStreak: drillIterBestStreak,
                    accuracy: liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : 0,
                    startT: drillIterStartT,
                },
                iterations: drillIterations.map((it) => ({ ...it })),
            };
        },
        setChannel,
        setVerifierOffset,
        getVerifierOffset,
        injectButton,
        showSummary,

        renderResultsCard: (data, opts) =>
            _ndRenderShareCard(data || {}, (opts && opts.overlayEl) || null),
        copyResultsCard: (data, opts) =>
            _ndShareCardAction(data || {}, 'copy', (opts && opts.overlayEl) || null),
        saveResultsCard: (data, opts) =>
            _ndSaveCard(data || {}, (opts && opts.overlayEl) || null),

        downloadDiagnostic: _downloadDiagnostic,
        getDiagnostic: _buildDiagnosticPayload,
        resetDiagnostic: resetScoring,
        getCalibrationSnapshot,
        getVerifierRejects,
        openCalibrationWizard,
        launchCalibration,
        closeCalibrationWizard: calibrationWizardClose,
        openInstrumentCalibrationLab,
        closeInstrumentCalibrationLab: calibrationLabClose,
        getCalibrationReport,
        downloadCalibrationReport: _calLabDownloadReport,

        applySettings: (partial) => {
            partial = partial || {};

            let restartNeeded = false;
            if (typeof partial.method === 'string' && ['yin', 'hps', 'crepe'].includes(partial.method)) {
                detectionMethod = partial.method;
                detectionMethodUserSet = true;
            }
            if (partial.frameSize !== undefined) {

                const nextFrameSize = _ndClampFrameSize(partial.frameSize);
                if (nextFrameSize !== frameSize) {
                    frameSize = nextFrameSize;
                    restartNeeded = enabled;
                }
            }
            if (Number.isFinite(partial.timingTolerance)) {
                timingTolerance = Math.max(0.03, Math.min(0.3, partial.timingTolerance));
            }
            if (Number.isFinite(partial.pitchTolerance)) {
                pitchTolerance = Math.max(10, Math.min(100, partial.pitchTolerance));
            }
            if (Number.isFinite(partial.timingHitThreshold)) {
                timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, partial.timingHitThreshold));
            }
            if (Number.isFinite(partial.chordTimingHitThreshold)) {
                chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, partial.chordTimingHitThreshold));
            }

            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (Number.isFinite(partial.pitchHitThreshold)) {
                pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, partial.pitchHitThreshold));
            }
            if (Number.isFinite(partial.chordHitRatio)) {
                chordHitRatio = Math.max(0.25, Math.min(1, partial.chordHitRatio));
            }
            if (Number.isFinite(partial.detectionConfidenceMin)) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, partial.detectionConfidenceMin));
            }
            if (Number.isFinite(partial.latencyOffset)) {

                latencyOffset = Math.max(0, Math.min(0.25, partial.latencyOffset));
            }

            if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            saveSettings();

            if (restartNeeded) restartAudio();
            return {
                method: detectionMethod,
                frameSize,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                chordHitRatio,
                detectionConfidenceMin,
                latencyOffset,
            };
        },

        resetCalibrationSamples: _resetCalibrationSamples,

        isTuningMode: () => tuningMode,
        setTuningMode: (v) => {
            const next = !!v;
            if (next === tuningMode) return;
            tuningMode = next;

            if (!tuningMode && (_recArmed || _recChunks.length > 0)) {
                discardRecording();
            }

            if (tuningMode) _liveBindEvents(); else _liveUnbindEvents();
            saveSettings();
        },

        isAutoRecord: () => autoRecord,
        setAutoRecord: (v) => {
            const next = !!v;
            if (next === autoRecord) return;
            autoRecord = next;
            saveSettings();
        },

        getSkin: () => _ndLoadSkin(),
        setSkin: (skin) => {
            if (ND_SKINS.indexOf(skin) === -1) return false;

            _ndSkinRuntime = skin;
            try { localStorage.setItem(ND_SKIN_STORAGE_KEY, skin); } catch (e) {}
            try {
                document.querySelectorAll('.nd-instance-root, .nd-summary-overlay')
                    .forEach(el => el.setAttribute('data-nd-skin', skin));
            } catch (e) {}
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                try { window.slopsmith.emit('notedetect:skin', { skin }); } catch (e) {}
            }
            return true;
        },

        isAutoCalibrate: () => autoCalibrate,
        setAutoCalibrate: (v) => {
            const next = !!v;
            if (next === autoCalibrate) return;
            autoCalibrate = next;
            saveSettings();
        },
        getLastCalibration: () => _lastAvCalibration,

        _calDebug: () => ({ detections: _calDetections.length, subscribed: _calSubscribed, autoCalibrate, isDefault, notes: (hw && hw.getNotes) ? (hw.getNotes() || []).length : -1 }),
        _calDetectionsDump: () => _calDetections.slice(),

        _calibrationNotes: () => _ndCalibrationNotes(),

        _trainingChartSnapshot: () => _ndTrainingChartSnapshot(),
        _runAutoCalibrate: () => _ndRunAutoCalibrate(),

        _calState: () => ({ detections: _calDetections.length, done: _calDoneThisPlay, paused: _calPaused }),
        _calSeedForTest: (n = 5) => { for (let i = 0; i < n; i++) _calDetections.push({ bt: i, m: 40 }); },
        _bindCalEvents: _calBindEvents,
        _unbindCalEvents: _calUnbindEvents,

        _calibrateOffsetMs: (dets, notes, geom, winS, tolC, opts) =>
            _ndCalibrateOffsetMs(dets, notes, geom, winS, tolC, opts),

        armRecording,
        armRecordingForTraining,
        disarmRecording,
        discardRecording,
        saveRecordingNow,
        getRecordingState,

        getAudioLatencyInfo: () => {
            if (!audioCtx) return null;
            return {
                baseLatency:   Number.isFinite(audioCtx.baseLatency)   ? audioCtx.baseLatency   : null,
                outputLatency: Number.isFinite(audioCtx.outputLatency) ? audioCtx.outputLatency : null,
                sampleRate:    audioCtx.sampleRate,
                frameSize:     frameSize,

                yinBufferSize: _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate),
                state:         audioCtx.state,
            };
        },

        _resetScoring: resetScoring,

        _updateButton: updateButton,

        _bindDrillEvents: _drillBindEvents,
        _unbindDrillEvents: _drillUnbindEvents,
        _drillSyncFromLoopState: _drillSyncFromLoopState,
        _recordJudgment: recordJudgment,

        _recomputeScoreToPosition: _recomputeScoreToPosition,
        _bindSeekResetEvents: _seekResetBindEvents,
        _unbindSeekResetEvents: _seekResetUnbindEvents,

        _bindEndOfSongEvents: _endOfSongBindEvents,
        _unbindEndOfSongEvents: _endOfSongUnbindEvents,

        _submitSongXp: _submitSongXp,

        _bindChartStateEvents: _chartStateBindEvents,
        _unbindChartStateEvents: _chartStateUnbindEvents,
        _syncChartStateFromHw: _syncChartStateFromHw,

        _bindAutoRecord: _bindAutoRecord,
        _unbindAutoRecord: _unbindAutoRecord,

        _injectRecChunkForTest: (n = 128) => {
            const frame = new Float32Array(n);
            _recChunks.push(frame);
            _recTotalSamples += frame.length;
        },
        _getChartState: () => ({
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            tuningOffsets: tuningOffsets.slice(),
            capo,
        }),

        _harness: {
            chartSignature: _ndChartSignature,
            expectedMidi: (string, fret) => _ndMidiFromStringFret(
                string, fret, currentArrangement, currentStringCount, tuningOffsets, capo
            ),
            feedFrame: async (buffer, sampleRate) => {
                if (Number.isFinite(sampleRate)) bridgeSampleRate = sampleRate;
                await processFrame(buffer);
            },
            tick: () => { checkMisses(); },
            setEnabled: (v) => { enabled = !!v; },
            setContext: (ctx) => {
                ctx = ctx || {};
                if (typeof ctx.arrangement === 'string') currentArrangement = ctx.arrangement;
                if (Number.isFinite(ctx.stringCount))   currentStringCount = ctx.stringCount;
                if (Array.isArray(ctx.tuningOffsets))   tuningOffsets = ctx.tuningOffsets.slice();
                if (Number.isFinite(ctx.capo))          capo = ctx.capo;
            },
            setSettings: (s) => {
                s = s || {};

                if (typeof s.method === 'string' && ['yin', 'hps'].includes(s.method)) {
                    detectionMethod = s.method;
                    detectionMethodUserSet = true;
                }
                if (Number.isFinite(s.pitchTolerance))      pitchTolerance      = s.pitchTolerance;
                if (Number.isFinite(s.pitchHitThreshold))   pitchHitThreshold   = s.pitchHitThreshold;
                if (Number.isFinite(s.timingTolerance))     timingTolerance     = s.timingTolerance;
                if (Number.isFinite(s.timingHitThreshold))  timingHitThreshold  = s.timingHitThreshold;

                if (Number.isFinite(s.cleanTimingThreshold)) cleanTimingThreshold = Math.max(0.01, s.cleanTimingThreshold);
                if (Number.isFinite(s.cleanPitchThreshold))  cleanPitchThreshold  = Math.max(1, s.cleanPitchThreshold);
                if (Number.isFinite(s.chordTimingHitThreshold)) {

                    chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
                }
                if (Number.isFinite(s.chordHitRatio))       chordHitRatio       = s.chordHitRatio;
                if (s.autoDrillMisses !== undefined) {
                    const _adn = parseInt(s.autoDrillMisses, 10);
                    _autoDrillMisses = (Number.isFinite(_adn) && _adn > 0) ? _adn : 0;
                }
                if (Number.isFinite(s.latencyOffset))       latencyOffset       = s.latencyOffset;
                if (Number.isFinite(s.inputGain))           inputGain           = s.inputGain;
                if (Number.isFinite(s.engineInputGain))     engineInputGain     = Math.max(0.1, Math.min(5, s.engineInputGain));

                if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
                if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
                if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;

                if (cleanTimingThreshold > timingHitThreshold) cleanTimingThreshold = timingHitThreshold;
                if (cleanPitchThreshold > pitchHitThreshold)   cleanPitchThreshold = pitchHitThreshold;
            },

            getSettings: () => ({
                pitchTolerance, pitchHitThreshold,
                timingTolerance, timingHitThreshold,
                chordTimingHitThreshold,
                cleanTimingThreshold, cleanPitchThreshold,
            }),
        },
    };

    ensureDrawHook();

    if (tuningMode) _liveBindEvents();

    const _hasAudio = typeof window !== 'undefined'
        && (typeof window.AudioContext === 'function'
            || typeof window.webkitAudioContext === 'function');

    _extBindWatch();

    if (isDefault && detectPreference && _hasAudio) {

        const autoEnableAttempt = (retriesLeft) => {

            if (typeof window !== 'undefined' && window.__ndSuppressDefault) return;
            if (enabled || !detectPreference) return;

            autoEnableTrial = retriesLeft > 0;
            enable().then((ok) => {
                autoEnableTrial = false;

                if (!ok && retriesLeft > 0 && !enabled && detectPreference) {
                    setTimeout(() => autoEnableAttempt(retriesLeft - 1), _ND_AUTO_ENABLE_RETRY_MS);
                }
            }).catch((e) => {
                autoEnableTrial = false;
                console.warn('[note_detect] auto-enable failed:', e && e.message ? e.message : e);
            });
        };
        setTimeout(() => autoEnableAttempt(1), 0);
    }

    try { _bindScoringWatchdog(); } catch (_) {}

    _ndInstances.add(api);
    return api;
}

// Wrap playSong once so every instance resets and the default detector can re-arm.
const _ND_PLAY_SONG_MAX_RETRIES = 20;
function _ndInstallPlaySongHook() {
    const origPlaySong = window.playSong;
    if (typeof origPlaySong !== 'function') {

        if (_ndShared.playSongRetries++ < _ND_PLAY_SONG_MAX_RETRIES) {
            setTimeout(_ndInstallPlaySongHook, 50);
        }
        return;
    }

    if (origPlaySong._ndWrapped) return;
    const wrapper = async function (...args) {

        if (typeof args[0] === 'string') {
            let f = args[0];
            try { f = decodeURIComponent(f); } catch (_) {  }
            _ndShared.currentFilename = f;
            const ret = _ndShared.diagnosticReturn;
            if (ret && ret.active && f) {
                const pf = ret.previousFilename;
                const isRestoreTarget = pf && f === pf;
                if (!isRestoreTarget && !_ndFilenameLooksDiagnostic(f)) {
                    _ndClearDiagnosticReturnState();
                }
            }
        }

        for (const inst of _ndInstances) {
            if (inst.isEnabled()) inst.disable({ silent: true });
            if (typeof inst._resetScoring === 'function') inst._resetScoring();
        }
        const ret = await origPlaySong.apply(this, args);

        if (window.noteDetect) {
            window.noteDetect.injectButton();
        }

        const def = window.noteDetect;
        if (def

            && !(typeof window !== 'undefined' && window.__ndSuppressDefault)
            && typeof def.wantsDetect === 'function' && def.wantsDetect()
            && !def.isEnabled()) {

            def.enable().catch((e) => {
                console.warn('[note_detect] auto-re-enable on playSong failed:',
                    e && e.message ? e.message : e);
            });
        }
        return ret;
    };
    wrapper._ndWrapped = true;
    window.playSong = wrapper;
}

// Reuse an existing singleton during hot reload; otherwise create the default instance.
const _ndExistingDefault = (window.noteDetect && typeof window.noteDetect.injectButton === 'function')
    ? window.noteDetect
    : null;
const _ndDefaultInstance = _ndExistingDefault || createNoteDetector({ isDefault: true });
window.noteDetect = _ndDefaultInstance;
window.createNoteDetector = createNoteDetector;

window.createNoteDetector.setDefaultSuppressed = function (suppressed) {
    if (typeof window === 'undefined') return;
    window.__ndSuppressDefault = !!suppressed;

    if (suppressed) {
        const def = window.noteDetect;
        if (def && typeof def.isEnabled === 'function' && def.isEnabled()
            && typeof def.disable === 'function') {

            try { def.disable({ silent: true }); } catch (_) {  }
        }
    }
};

_ndInstallPlaySongHook();

if (!_ndExistingDefault) _ndDefaultInstance.injectButton();
