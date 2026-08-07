// Chart-state sync tests — exercise the song:loaded / arrangement:changed
// listeners, chart-transform refreshes, and the `_syncChartStateFromHw`
// effective-metadata/reset semantics.
//
// Regression target: a session that started on a bass arrangement and
// then loaded a guitar song could carry `currentArrangement='bass'` /
// 4-string offsets into the new chart, so strings 4-5 of the guitar
// part scored against `_ND_TUNING_BASS_4` and retired with
// `expectedMidi: null`. The fix centralizes the sync in
// `_syncChartStateFromHw()` (which pre-resets to a known-good 6-string
// guitar default) and wires `song:loaded`/`arrangement:changed` so
// mid-session switches resync without waiting for the next enable().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function makeEventBus() {
    const listeners = new Map();
    return {
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
        },
        off(event, fn) {
            const handlers = listeners.get(event) || [];
            const index = handlers.indexOf(fn);
            if (index !== -1) handlers.splice(index, 1);
        },
        fire(event, detail) {
            for (const fn of (listeners.get(event) || []).slice()) fn({ detail });
        },
        listenerCount(event) {
            return (listeners.get(event) || []).length;
        },
    };
}

// Build a detector wired to a synthetic song. The vm `highway` stub
// only ships `getSongInfo: () => ({})`; tests need to override both
// getSongInfo and getStringCount to drive the resolution branches.
function mountDetectorWithSong(core, { arrangement, tuning, capo, stringCount } = {}) {
    core.highway.getSongInfo = () => {
        const info = {};
        if (arrangement !== undefined) info.arrangement = arrangement;
        if (tuning !== undefined)      info.tuning      = tuning;
        if (capo !== undefined)        info.capo        = capo;
        return info;
    };
    if (stringCount !== undefined) {
        core.highway.getStringCount = () => stringCount;
    } else {
        delete core.highway.getStringCount;
    }
    return core.createNoteDetector();
}

test('bass→guitar song:loaded resets arrangement/stringCount/tuning/capo', () => {
    const core = loadDetectionCore();

    // First song: 4-string bass with capo 2.
    const det = mountDetectorWithSong(core, {
        arrangement: 'bass',
        tuning: [0, 0, 0, 0],
        capo: 2,
        stringCount: 4,
    });
    det._bindChartStateEvents();
    det._syncChartStateFromHw();
    let state = det._getChartState();
    assert.equal(state.arrangement, 'bass');
    assert.equal(state.stringCount, 4);
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0]);
    assert.equal(state.capo, 2);

    // Second song: 6-string guitar, no capo. Switch host state and
    // fire song:loaded; the detector must resync end-to-end without
    // carrying any field from the previous song.
    core.highway.getSongInfo = () => ({
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
    });
    core.highway.getStringCount = () => 6;
    core.slopsmith._fire('song:loaded', { filename: 'guitar-song.archive' });

    state = det._getChartState();
    assert.equal(state.arrangement, 'guitar', 'arrangement must flip off bass');
    assert.equal(state.stringCount, 6, 'string count must flip to 6');
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0, 0, 0]);
    assert.equal(state.capo, 0);
    det.destroy();
});

test('chart-transform effective tuning/capo win over original song metadata', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        // Original chart: Eb standard with a native capo. getSongInfo remains
        // original by host contract even while a chart transform is active.
        tuning: [-1, -1, -1, -1, -1, -1],
        capo: 2,
        stringCount: 6,
    });
    // Effective Retuner output: E standard, physical-fret projection (capo 0).
    core.highway.getTuning = () => [0, 0, 0, 0, 0, 0];
    core.highway.getCapo = () => 0;

    det._syncChartStateFromHw();
    const state = det._getChartState();
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0, 0, 0]);
    assert.equal(state.capo, 0);
    // Eb-standard fret 8 and E-standard fret 7 are both MIDI 47 (B2).
    // This is the exact Retuner regression: stale getSongInfo tuning produced
    // MIDI 46 and displayed the heard MIDI 47 as fret 8.
    assert.equal(det._harness.expectedMidi(0, 7), 47);
    det.destroy();
});

test('custom all-fourths effective tuning scores the retuned upper strings', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
        stringCount: 6,
    });
    // E A D G C F: strings 4/5 are one semitone above standard B/E.
    core.highway.getTuning = () => [0, 0, 0, 0, 1, 1];
    core.highway.getCapo = () => 0;

    det._syncChartStateFromHw();
    assert.equal(det._harness.expectedMidi(4, 0), 60, 'open C4 must not score as stale B3');
    assert.equal(det._harness.expectedMidi(5, 0), 65, 'open F4 must not score as stale E4');
    det.destroy();
});

test('older host without effective getters falls back to getSongInfo tuning/capo', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [-1, -1, -1, -1, -1, -1],
        capo: 1,
        stringCount: 6,
    });
    delete core.highway.getTuning;
    delete core.highway.getCapo;

    det._syncChartStateFromHw();
    const state = det._getChartState();
    assert.deepEqual([...state.tuningOffsets], [-1, -1, -1, -1, -1, -1]);
    assert.equal(state.capo, 1);
    det.destroy();
});

test('hybrid host derives fallback string count from effective tuning', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0, 0],
        capo: 0,
        // Simulate a host with getTuning/getCapo but no getStringCount.
    });
    core.highway.getTuning = () => [0, 0, 0, 0, 0, 0];
    core.highway.getCapo = () => 0;

    det._syncChartStateFromHw();
    const state = det._getChartState();
    assert.equal(state.stringCount, 6, 'effective six-string tuning must beat original seven-string length');
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0, 0, 0]);
    assert.equal(det._harness.expectedMidi(0, 7), 47);
    det.destroy();
});

test('chart-state refresh commits atomically when a host getter throws', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
        stringCount: 6,
    });
    det._syncChartStateFromHw();
    const before = det._getChartState();
    before.tuningOffsets = before.tuningOffsets.slice();

    core.highway.getSongInfo = () => ({ arrangement: 'Bass', tuning: [0, 0, 0, 0], capo: 2 });
    core.highway.getTuning = () => { throw new Error('transform rebuilding'); };
    assert.equal(det._syncChartStateFromHw(), null);
    assert.deepEqual(det._getChartState(), before, 'failed read must preserve the complete previous snapshot');
    det.destroy();
});

test('chart-transform selection event resyncs effective tuning mid-session', () => {
    const core = loadDetectionCore();
    let effective = [-1, -1, -1, -1, -1, -1];
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [-1, -1, -1, -1, -1, -1],
        capo: 0,
        stringCount: 6,
    });
    core.highway.getTuning = () => effective;
    core.highway.getCapo = () => 0;
    det._bindChartStateEvents();
    det._syncChartStateFromHw();
    assert.equal(det._harness.expectedMidi(0, 7), 46);

    effective = [0, 0, 0, 0, 0, 0];
    core.slopsmith._fire('chart-transform:transform-changed', { from: null, to: 'chart_retuner' });
    assert.equal(det._harness.expectedMidi(0, 7), 47);
    det.destroy();
});

test('preferred feedBack transform bus resyncs and unsubscribes independently', () => {
    const feedBackBus = makeEventBus();
    const core = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.feedBack = feedBackBus;
        },
    });
    let effective = [-1, -1, -1, -1, -1, -1];
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [-1, -1, -1, -1, -1, -1],
        capo: 0,
        stringCount: 6,
    });
    core.highway.getTuning = () => effective;
    core.highway.getCapo = () => 0;
    det._bindChartStateEvents();
    det._syncChartStateFromHw();

    assert.equal(feedBackBus.listenerCount('chart-transform:transform-changed'), 1);
    assert.equal(core.slopsmith._listenerCount('chart-transform:transform-changed'), 0);
    effective = [0, 0, 0, 0, 0, 0];
    feedBackBus.fire('chart-transform:transform-changed', { from: null, to: 'chart_retuner' });
    assert.equal(det._harness.expectedMidi(0, 7), 47);

    det.destroy();
    assert.equal(feedBackBus.listenerCount('chart-transform:transform-changed'), 0);
});

test('chart signature polls and fingerprints tuning-only transform refreshes', () => {
    const core = loadDetectionCore();
    let effective = [0, 0, 0, 0, 0, 0];
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
        stringCount: 6,
    });
    core.highway.getTuning = () => effective;
    core.highway.getCapo = () => 0;
    core.highway.getNotes = () => [{ t: 1, s: 0, f: 7 }];

    const before = det._harness.chartSignature();
    // Same provider, same note geometry: only the effective P4 tuning changes.
    effective = [0, 0, 0, 0, 1, 1];
    const after = det._harness.chartSignature();
    assert.notEqual(after, before, 'desktop verifier must repush on tuning-only refresh');
    assert.deepEqual([...det._getChartState().tuningOffsets], effective);
    det.destroy();
});

test('already-synchronized chart signature avoids duplicate host metadata reads', () => {
    const core = loadDetectionCore();
    let tuningReads = 0;
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
        stringCount: 6,
    });
    core.highway.getTuning = () => {
        tuningReads++;
        return [0, 0, 0, 0, 0, 0];
    };
    core.highway.getCapo = () => 0;
    core.highway.getNotes = () => [{ t: 1, s: 0, f: 7 }];

    det._syncChartStateFromHw();
    assert.equal(tuningReads, 1);
    det._harness.chartSignature({ syncChartState: false });
    assert.equal(tuningReads, 1, 'same scoring pass must reuse its synchronized context');
    det._harness.chartSignature();
    assert.equal(tuningReads, 2, 'standalone signature polling must still detect transform refreshes');
    det.destroy();
});

test('arrangement:changed mid-session resyncs without waiting for enable()', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        stringCount: 6,
    });
    det._bindChartStateEvents();
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().arrangement, 'guitar');

    // Same song, but user flipped to the bass arrangement.
    core.highway.getSongInfo = () => ({
        arrangement: 'Bass',
        tuning: [0, 0, 0, 0],
    });
    core.highway.getStringCount = () => 4;
    core.slopsmith._fire('arrangement:changed', { arrangement: 'Bass' });

    const state = det._getChartState();
    assert.equal(state.arrangement, 'bass');
    assert.equal(state.stringCount, 4);
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0]);
    det.destroy();
});

test('_bindChartStateEvents is idempotent', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {});
    det._bindChartStateEvents();
    det._bindChartStateEvents();
    det._bindChartStateEvents();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1);
    assert.equal(core.slopsmith._listenerCount('song:ready'), 1);
    assert.equal(core.slopsmith._listenerCount('arrangement:changed'), 1);
    assert.equal(core.slopsmith._listenerCount('chart-transform:transform-changed'), 1);
    det.destroy();
});

test('destroy() unbinds song/arrangement/chart-transform listeners', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {});
    det._bindChartStateEvents();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1);
    assert.equal(core.slopsmith._listenerCount('song:ready'), 1);
    assert.equal(core.slopsmith._listenerCount('arrangement:changed'), 1);
    assert.equal(core.slopsmith._listenerCount('chart-transform:transform-changed'), 1);

    det.destroy();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 0);
    assert.equal(core.slopsmith._listenerCount('song:ready'), 0);
    assert.equal(core.slopsmith._listenerCount('arrangement:changed'), 0);
    assert.equal(core.slopsmith._listenerCount('chart-transform:transform-changed'), 0);

    // Firing post-destroy must not throw.
    assert.doesNotThrow(() => {
        core.slopsmith._fire('song:loaded', { filename: 'x.archive' });
        core.slopsmith._fire('song:ready', { hasPhraseData: true });
        core.slopsmith._fire('arrangement:changed', { arrangement: 'Lead' });
        core.slopsmith._fire('chart-transform:transform-changed', { from: null, to: 'chart_retuner' });
    });
});

test('no-tuning reset branch — missing info.tuning falls back to 6-string-guitar default', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'bass',
        tuning: [0, 0, 0, 0],
        capo: 3,
        stringCount: 4,
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().arrangement, 'bass');

    // New song with NO tuning array and NO arrangement, no stringCount.
    // The pre-reset must wipe the bass state back to guitar defaults.
    core.highway.getSongInfo = () => ({});
    delete core.highway.getStringCount;
    det._syncChartStateFromHw();

    const state = det._getChartState();
    assert.equal(state.arrangement, 'guitar');
    assert.equal(state.stringCount, 6);
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0, 0, 0]);
    assert.equal(state.capo, 0);
    det.destroy();
});

test('bass arrangement with no tuning array picks bass-4 default (not guitar-6)', () => {
    // Direct coverage for the second-order regression Copilot flagged:
    // info.arrangement='bass' but info.tuning missing/non-array meant
    // currentStringCount stayed at 6, and _ndStandardMidiFor('bass', 6)
    // returned the 4-entry _ND_TUNING_BASS_4 — reproducing the
    // expectedMidi:null symptom this PR exists to fix, just for the
    // bass case.
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, { arrangement: 'Bass' });
    // No tuning array. No getStringCount on the highway either.
    det._syncChartStateFromHw();
    const state = det._getChartState();
    assert.equal(state.arrangement, 'bass');
    assert.equal(state.stringCount, 4, 'bass arrangement must default to 4 strings, not 6');
    det.destroy();
});

test('host getStringCount wins over per-arrangement default and tuning length', () => {
    const core = loadDetectionCore();
    // 7-string guitar: tuning.length=7, host says 7. Verify host wins
    // (also implicitly checks per-arrangement default of 6 is overridden).
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0, 0],
        stringCount: 7,
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 7);
    det.destroy();
});

test('older host without getStringCount: 7-string guitar tuning.length wins over per-arrangement default', () => {
    // Codex preflight caught this: when hw.getStringCount is missing,
    // an arrangement-driven default of 6 would clobber a valid 7-entry
    // tuning array. tuning.length must win when it's consistent with
    // the arrangement (4/5 for bass, 6/7/8 for guitar).
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0, 0],
        // no stringCount → no hw.getStringCount on the highway
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 7,
        'tuning.length=7 must win over per-arrangement default of 6');
    det.destroy();
});

test('older host without getStringCount: 5-string bass tuning.length wins over per-arrangement default', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Bass',
        tuning: [0, 0, 0, 0, 0],
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 5,
        'tuning.length=5 must win over per-arrangement default of 4');
    det.destroy();
});

test('older host without getStringCount: bass with arrangement XML-padded 6-entry tuning falls back to bass-4', () => {
    // arrangement XML pads bass tunings to six entries. With no host count and
    // no way to disambiguate, tuning.length=6 is NOT consistent with
    // arrangement=bass, so the per-arrangement default (4) must win.
    // Without this guard the bass chart would map against a 6-entry
    // base array — the exact regression the helper exists to fix.
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Bass',
        tuning: [0, 0, 0, 0, 0, 0],
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 4,
        'bass + tuning.length=6 (arrangement XML pad) must fall back to bass-4');
    det.destroy();
});
