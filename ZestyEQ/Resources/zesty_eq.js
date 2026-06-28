(function () {
    'use strict';

    if (window.ZestyEQ) return;
    window.ZestyEQ = true;

    const PARAMS = {
        preamp: 50, pan: 50, width: 50, pitch: 50,
        beastMode: false, vacuum: false, sabotageHum: false,
        ghost: false, siren: false, talkMode: false,
        drive: 0, saturation: 0, reverb: 0, delay: 0, chorus: 0,
        outputGain: 50, mono: false, swap: false,
        phaseL: false, phaseR: false, limiter: 100,
        eqFilters: [], soundboard: []
    };

    let filterIdCounter = 0;
    let sbIdCounter = 0;

    const Recorder = {
        externalStreams: [], isRecording: false, mediaRecorder: null,
        recordedChunks: [], _micStream: null, _timerInterval: null, _startTime: 0,

        setMicStream(stream) { this._micStream = stream; },

        addExternalStream(stream) {
            if (stream && !this.externalStreams.includes(stream) && stream !== this._micStream) {
                this.externalStreams = this.externalStreams.filter(s => s.active);
                this.externalStreams.push(stream);
            }
        },

        async startRecording(recordMic, recordExternal) {
            if (this.isRecording) return;
            this.recordedChunks = [];
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const mixDest = ctx.createMediaStreamDestination();
            let hasInput = false;

            if (recordMic && Core.dest && Core.dest.stream && Core.dest.stream.active) {
                try {
                    const src = ctx.createMediaStreamSource(Core.dest.stream);
                    const g = ctx.createGain(); g.gain.value = 1;
                    src.connect(g); g.connect(mixDest); hasInput = true;
                } catch (e) { console.error('Recorder mic', e); }
            }

            if (recordExternal) {
                const activeExt = this.externalStreams.filter(s => s.active);
                for (const stream of activeExt) {
                    try {
                        const src = ctx.createMediaStreamSource(stream);
                        const g = ctx.createGain(); g.gain.value = 1;
                        src.connect(g); g.connect(mixDest); hasInput = true;
                    } catch (e) {}
                }
            }

            if (!hasInput) throw new Error('No audio sources');

            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
            this.mediaRecorder = new MediaRecorder(mixDest.stream, { mimeType: mime });
            this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
            this.mediaRecorder.start(100);
            this.isRecording = true;
            this._startTime = Date.now();
            App.onRecorderStart();
            return true;
        },

        stopRecording() {
            return new Promise((resolve) => {
                if (!this.mediaRecorder || !this.isRecording) { resolve(null); return; }
                this.mediaRecorder.onstop = () => {
                    this.isRecording = false;
                    App.onRecorderStop();
                    const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `recording-${Date.now()}.webm`;
                    document.body.appendChild(a); a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                    this.recordedChunks = [];
                    resolve(blob);
                };
                this.mediaRecorder.stop();
            });
        },

        toggle() {
            if (this.isRecording) { this.stopRecording(); return; }
            const mic = document.getElementById('zc-rec-mic')?.checked ?? true;
            const ext = document.getElementById('zc-rec-ext')?.checked ?? true;
            this.startRecording(mic, ext).catch(e => {
                const st = document.getElementById('zc-rec-status');
                if (st) st.textContent = 'Error: ' + e.message;
            });
        }
    };

    /* ===========================
       AUDIO ENGINE (iOS: ScriptProcessorNode instead of AudioWorklet)
    =========================== */

    window.DiscordContext = null;
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    let pendingContextResolvers = [];
    let contextReady = false;

    const createContextOnGesture = () => {
        if (contextReady) return;
        contextReady = true;
        window.removeEventListener('click', createContextOnGesture, { capture: true });
        window.removeEventListener('keydown', createContextOnGesture, { capture: true });
        window.removeEventListener('touchstart', createContextOnGesture, { capture: true });
        if (window.DiscordContext && window.DiscordContext.state === 'suspended') {
            window.DiscordContext.resume().then(() => {
                pendingContextResolvers.forEach(r => r());
                pendingContextResolvers = [];
            });
        } else {
            pendingContextResolvers.forEach(r => r());
            pendingContextResolvers = [];
        }
    };

    window.addEventListener('click', createContextOnGesture, { capture: true });
    window.addEventListener('keydown', createContextOnGesture, { capture: true });
    window.addEventListener('touchstart', createContextOnGesture, { capture: true });

    window.AudioContext = function () {
        const ctx = new NativeAudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        window.DiscordContext = ctx;
        return ctx;
    };
    window.AudioContext.prototype = NativeAudioContext.prototype;

    const _origCreateMSS = NativeAudioContext.prototype.createMediaStreamSource;
    NativeAudioContext.prototype.createMediaStreamSource = function (stream) {
        const node = _origCreateMSS.call(this, stream);
        Recorder.addExternalStream(stream);
        return node;
    };

    /* ===========================
       CORE (with ScriptProcessorNode)
    =========================== */

    const Core = {
        ctx: null, inputGain: null, eqNodeChain: [],
        scriptNode: null, masterGain: null, dest: null,
        analyser: null, source: null, soundboardNodes: [],
        delayNode: null, chorusNode: null, chorusLFO: null,
        meterData: { peakL: 0, peakR: 0, corr: 0 },

        // DSP state (moved from worklet)
        _bufSize: 8192,
        _bufL: null, _bufR: null,
        _writePos: 0, _readPos: 0,
        _phase: 0, _sirenPhase: 0,
        _noiseVal: 0, _tonePhase: 0,
        _peakL: 0, _peakR: 0,
        _corrAccum: 0, _corrCount: 0,
        _frameCount: 0,

        // Parameters updated from PARAMS
        _params: {
            gain: 1, boost: 1, width: 0.5, pitch: 1,
            beast: 0, vacuum: 0, hum: 0, ghost: 0, siren: 0, talk: 0,
            drive: 0, saturate: 0, pan: 0.5, mono: 0, swap: 0,
            phaseL: 0, phaseR: 0, limit: 1
        },

        async inject(stream) {
            const ctx = window.DiscordContext;
            this.ctx = ctx;
            if (ctx.state === 'suspended') {
                await new Promise(resolve => {
                    if (contextReady) { ctx.resume().then(resolve); }
                    else { pendingContextResolvers.push(() => ctx.resume().then(resolve)); }
                });
            }

            this._bufL = new Float32Array(this._bufSize);
            this._bufR = new Float32Array(this._bufSize);
            this._writePos = 0;
            this._readPos = 0;
            this._phase = 0;
            this._sirenPhase = 0;
            this._tonePhase = 0;

            Recorder.setMicStream(stream);
            this.source = ctx.createMediaStreamSource(stream);
            this.inputGain = ctx.createGain();
            this.masterGain = ctx.createGain();
            this.dest = ctx.createMediaStreamDestination();
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 256;

            this.delayNode = ctx.createDelay(2);
            this.delayNode.delayTime.value = 0.3;
            this.chorusNode = ctx.createDelay(0.02);
            this.chorusNode.delayTime.value = 0.005;
            this.chorusLFO = ctx.createOscillator();
            this.chorusLFO.frequency.value = 0.5;
            this.chorusLFO.type = 'sine';
            const cg = ctx.createGain();
            cg.gain.value = 0.003;
            this.chorusLFO.connect(cg);
            cg.connect(this.chorusNode.delayTime);
            this.chorusLFO.start();

            // Create ScriptProcessorNode (iOS-compatible replacement for AudioWorklet)
            this.scriptNode = ctx.createScriptProcessor(4096, 2, 2);
            this.scriptNode.channelCount = 2;

            this.scriptNode.onaudioprocess = (event) => {
                const input = event.inputBuffer;
                const output = event.outputBuffer;
                const p = this._params;

                const inL_ = input.getChannelData(0);
                const inR_ = input.getChannelData(1);
                const outL = output.getChannelData(0);
                const outR = output.getChannelData(1);
                const len = inL_.length;

                for (let i = 0; i < len; i++) {
                    let L = inL_[i] * p.boost;
                    let R = inR_[i] * p.boost;

                    if (p.phaseL > 0.5) L = -L;
                    if (p.phaseR > 0.5) R = -R;
                    if (p.swap > 0.5) { const t = L; L = R; R = t; }
                    if (p.mono > 0.5) { const m = (L + R) * 0.5; L = m; R = m; }

                    const panVal = (p.pan - 0.5) * 2;
                    if (panVal < 0) R *= (1 + panVal);
                    else if (panVal > 0) L *= (1 - panVal);

                    this._peakL = Math.max(this._peakL, Math.abs(L));
                    this._peakR = Math.max(this._peakR, Math.abs(R));
                    this._corrAccum += L * R;
                    this._corrCount++;

                    if (p.vacuum > 0.5) {
                        if (Math.abs(L) < 0.2) L = (L > 0 ? 0.2 : -0.2);
                        if (Math.abs(R) < 0.2) R = (R > 0 ? 0.2 : -0.2);
                    }

                    if (p.ghost > 0.5) {
                        if (Math.random() > 0.98) this._noiseVal = (Math.random() - 0.5) * 0.4;
                        L += this._noiseVal;
                        R += this._noiseVal;
                    }

                    if (p.beast > 0.5) {
                        L *= 3000; R *= 3000;
                        L = (L > 0) ? Math.min(1, L) : Math.max(-1, L);
                        R = (R > 0) ? Math.min(1, R) : Math.max(-1, R);
                    } else if (p.talk > 0.5) {
                        L *= 80; R *= 80;
                        L = Math.tanh(L); R = Math.tanh(R);
                    }

                    if (p.drive > 0) {
                        const d = 1 + p.drive * 20;
                        L = Math.tanh(L * d) / Math.tanh(d);
                        R = Math.tanh(R * d) / Math.tanh(d);
                    }

                    if (p.saturate > 0) {
                        const s = 1 + p.saturate * 10;
                        L = Math.pow(Math.abs(L), s) * Math.sign(L) * (1 + p.saturate * 0.5);
                        R = Math.pow(Math.abs(R), s) * Math.sign(R) * (1 + p.saturate * 0.5);
                    }

                    if (p.hum > 0.5) {
                        this._phase += (22 * 2 * Math.PI) / 48000;
                        const h = Math.sin(this._phase) * 0.3;
                        L += h; R += h;
                    }

                    this._bufL[this._writePos] = L;
                    this._bufR[this._writePos] = R;
                    this._writePos = (this._writePos + 1) % this._bufSize;
                    const ri = Math.floor(this._readPos);
                    const frac = this._readPos - ri;
                    const ri1 = (ri + 1) % this._bufSize;
                    L = this._bufL[ri] * (1 - frac) + this._bufL[ri1] * frac;
                    R = this._bufR[ri] * (1 - frac) + this._bufR[ri1] * frac;

                    if (p.siren > 0.5) {
                        this._sirenPhase += (1.5 * 2 * Math.PI) / 48000;
                        const sweep = 1000 + Math.sin(this._sirenPhase) * 500;
                        this._tonePhase = (this._tonePhase || 0) + (sweep * 2 * Math.PI) / 48000;
                        const alarm = Math.sin(this._tonePhase) * 0.4;
                        L += alarm; R += alarm;
                    }
                    this._readPos = (this._readPos + p.pitch) % this._bufSize;

                    if (p.width > 0) {
                        const mid = (L + R) * 0.5;
                        const side = (L - R) * 0.5 * (1 + p.width * 2);
                        L = mid + side; R = mid - side;
                    }

                    L = Math.max(-p.limit, Math.min(p.limit, L)) * p.gain;
                    R = Math.max(-p.limit, Math.min(p.limit, R)) * p.gain;

                    L = Math.max(-1, Math.min(1, L));
                    R = Math.max(-1, Math.min(1, R));

                    outL[i] = L;
                    outR[i] = R;
                }

                this._frameCount++;
                if (this._frameCount >= 4) {
                    const n = this._corrCount || 1;
                    this.meterData.peakL = this._peakL;
                    this.meterData.peakR = this._peakR;
                    this.meterData.corr = this._corrAccum / n;
                    this._peakL = 0; this._peakR = 0;
                    this._corrAccum = 0; this._corrCount = 0;
                    this._frameCount = 0;
                }
            };

            try {
                this.source.connect(this.inputGain);
                this.inputGain.connect(this.scriptNode);
                this.scriptNode.connect(this.masterGain);
                this.rebuildEQ();
                this.masterGain.connect(this.dest);
                this.masterGain.connect(this.analyser);
                this.update();
                App.startMeter();
                App.setStatus('ACTIVE', '#00aaff');
            } catch (e) {
                console.error(e);
                this.source.connect(this.dest);
            }
            return this.dest.stream;
        },

        rebuildEQ() {
            const ctx = this.ctx;
            if (!ctx) return;
            for (const n of this.eqNodeChain) { try { n.disconnect(); } catch (e) {} }
            this.eqNodeChain = [];
            const prev = this.inputGain;
            const next = this.scriptNode || this.masterGain;
            if (!prev || !next) return;
            let last = prev;
            for (const f of PARAMS.eqFilters) {
                if (!f.enabled) continue;
                try {
                    const bqf = ctx.createBiquadFilter();
                    const map = { 'Peak':'peaking','Bell':'peaking','Low Shelf':'lowshelf','High Shelf':'highshelf','Low Pass':'lowpass','High Pass':'highpass','Band Pass':'bandpass','Notch':'notch','All Pass':'allpass','Band Stop':'notch','Tilt Shelf':'lowshelf','Low Cut':'highpass','High Cut':'lowpass' };
                    bqf.type = map[f.type] || 'peaking';
                    bqf.frequency.value = Math.max(20, Math.min(20000, f.frequency));
                    bqf.gain.value = Math.max(-30, Math.min(30, f.gain));
                    bqf.Q.value = Math.max(0.01, Math.min(100, f.Q));
                    last.connect(bqf);
                    last = bqf;
                    this.eqNodeChain.push(bqf);
                } catch (e) {}
            }
            last.connect(next);
        },

        async playSoundboardItem(item) {
            const ctx = this.ctx;
            if (!ctx || !this.masterGain) return;
            try {
                const buffer = await ctx.decodeAudioData(item.data.slice(0));
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                const gainNode = ctx.createGain();
                gainNode.gain.value = item.volume || 1;
                source.connect(gainNode);
                gainNode.connect(this.masterGain);
                source.start();
                const entry = { source, gainNode, item, ended: false };
                this.soundboardNodes.push(entry);
                source.onended = () => {
                    entry.ended = true;
                    try { source.disconnect(); gainNode.disconnect(); } catch (e) {}
                    const idx = this.soundboardNodes.indexOf(entry);
                    if (idx >= 0) this.soundboardNodes.splice(idx, 1);
                };
                return entry;
            } catch (e) { console.error('play fail', e); }
        },

        stopSoundboard(entry) {
            try { entry.source.stop(); entry.source.disconnect(); entry.gainNode.disconnect(); } catch (e) {}
            const idx = this.soundboardNodes.indexOf(entry);
            if (idx >= 0) this.soundboardNodes.splice(idx, 1);
        },

        update() {
            if (!this.scriptNode) return;
            const p = this._params;
            const t = window.DiscordContext ? window.DiscordContext.currentTime : 0;

            if (this.inputGain) this.inputGain.gain.setTargetAtTime(1 + (PARAMS.preamp - 50) * 0.02, t, 0.05);

            p.gain = 1 + (PARAMS.outputGain - 50) * 0.01;
            p.boost = 1 + PARAMS.preamp * 0.02;
            p.width = PARAMS.width / 100;
            p.pitch = Math.pow(2, (PARAMS.pitch - 50) / 25);
            p.beast = PARAMS.beastMode ? 1 : 0;
            p.vacuum = PARAMS.vacuum ? 1 : 0;
            p.hum = PARAMS.sabotageHum ? 1 : 0;
            p.ghost = PARAMS.ghost ? 1 : 0;
            p.siren = PARAMS.siren ? 1 : 0;
            p.talk = PARAMS.talkMode ? 1 : 0;
            p.drive = PARAMS.drive / 100;
            p.saturate = PARAMS.saturation / 100;
            p.pan = PARAMS.pan / 100;
            p.mono = PARAMS.mono ? 1 : 0;
            p.swap = PARAMS.swap ? 1 : 0;
            p.phaseL = PARAMS.phaseL ? 1 : 0;
            p.phaseR = PARAMS.phaseR ? 1 : 0;
            p.limit = PARAMS.limiter / 100;

            if (this.masterGain) this.masterGain.gain.setTargetAtTime(1 + (PARAMS.outputGain - 50) * 0.01, t, 0.05);

            try {
                if (this.delayNode) this.delayNode.disconnect();
                if (PARAMS.delay > 0 && this.scriptNode && this.masterGain) {
                    this.scriptNode.connect(this.delayNode);
                    this.delayNode.connect(this.masterGain);
                }
            } catch (e) {}
            try {
                if (this.chorusNode) this.chorusNode.disconnect();
                if (PARAMS.chorus > 0 && this.scriptNode && this.masterGain) {
                    this.scriptNode.connect(this.chorusNode);
                    this.chorusNode.connect(this.masterGain);
                }
            } catch (e) {}

            this.rebuildEQ();
        },

        getDb() {
            if (!this.analyser) return -100;
            const arr = new Uint8Array(this.analyser.frequencyBinCount);
            this.analyser.getByteTimeDomainData(arr);
            let s = 0;
            for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i] - 128);
            const lvl = s / arr.length;
            return lvl < 1 ? -100 : 20 * Math.log10(lvl / 128);
        },

        getFrequencyData() {
            if (!this.analyser) return null;
            const arr = new Uint8Array(this.analyser.frequencyBinCount);
            this.analyser.getByteFrequencyData(arr);
            return arr;
        }
    };

    const nativeGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints.audio) {
            constraints.audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
        }
        try { return Core.inject(await nativeGUM(constraints)); } catch (e) { return nativeGUM(constraints); }
    };

    /* ===========================
       EQ MATH (graph)
    =========================== */

    const FILTER_TYPES = [
        'Peak','Low Shelf','High Shelf','Low Pass','High Pass',
        'Band Pass','Notch','All Pass','Band Stop','Tilt Shelf',
        'Bell','Low Cut','High Cut'
    ];

    function computeBiquadCoefs(type, freq, gain, Q, fs) {
        const ω0 = 2 * Math.PI * freq / fs;
        const c = Math.cos(ω0), s = Math.sin(ω0);
        const A = Math.pow(10, gain / 40);
        const α = s / (2 * Q);
        let b0,b1,b2,a0,a1,a2;
        switch (type) {
            case 'Peak':case 'Bell':
                b0=1+α*A;b1=-2*c;b2=1-α*A;a0=1+α/A;a1=-2*c;a2=1-α/A;break;
            case 'Low Shelf':
                b0=A*((A+1)-(A-1)*c+2*Math.sqrt(A)*α);b1=2*A*((A-1)-(A+1)*c);
                b2=A*((A+1)-(A-1)*c-2*Math.sqrt(A)*α);a0=(A+1)+(A-1)*c+2*Math.sqrt(A)*α;
                a1=-2*((A-1)+(A+1)*c);a2=(A+1)+(A-1)*c-2*Math.sqrt(A)*α;break;
            case 'High Shelf':
                b0=A*((A+1)+(A-1)*c+2*Math.sqrt(A)*α);b1=-2*A*((A-1)+(A+1)*c);
                b2=A*((A+1)+(A-1)*c-2*Math.sqrt(A)*α);a0=(A+1)-(A-1)*c+2*Math.sqrt(A)*α;
                a1=2*((A-1)-(A+1)*c);a2=(A+1)-(A-1)*c-2*Math.sqrt(A)*α;break;
            case 'Low Pass':case 'High Cut':
                b0=(1-c)/2;b1=1-c;b2=(1-c)/2;a0=1+α;a1=-2*c;a2=1-α;break;
            case 'High Pass':case 'Low Cut':
                b0=(1+c)/2;b1=-(1+c);b2=(1+c)/2;a0=1+α;a1=-2*c;a2=1-α;break;
            case 'Band Pass':b0=α;b1=0;b2=-α;a0=1+α;a1=-2*c;a2=1-α;break;
            case 'Notch':case 'Band Stop':
                b0=1;b1=-2*c;b2=1;a0=1+α;a1=-2*c;a2=1-α;break;
            case 'All Pass':b0=1-α;b1=-2*c;b2=1+α;a0=1+α;a1=-2*c;a2=1-α;break;
            case 'Tilt Shelf':
                {const β=Math.sqrt(A);b0=A*((A+1)-(A-1)*c+β*α);b1=2*A*((A-1)-(A+1)*c);
                b2=A*((A+1)-(A-1)*c-β*α);a0=(A+1)+(A-1)*c+β*α;a1=-2*((A-1)+(A+1)*c);a2=(A+1)+(A-1)*c-β*α;}break;
            default:b0=1;b1=0;b2=0;a0=1;a1=0;a2=0;
        }
        return {b0,b1,b2,a0,a1,a2};
    }

    function magAtFreq(c, f, fs) {
        const ω=2*Math.PI*f/fs;
        const rn=c.b0+c.b1*Math.cos(ω)+c.b2*Math.cos(2*ω);
        const inn=-c.b1*Math.sin(ω)-c.b2*Math.sin(2*ω);
        const rd=c.a0+c.a1*Math.cos(ω)+c.a2*Math.cos(2*ω);
        const ind=-c.a1*Math.sin(ω)-c.a2*Math.sin(2*ω);
        const mn=Math.sqrt(rn*rn+inn*inn), md=Math.sqrt(rd*rd+ind*ind);
        return md>0?mn/md:1;
    }

    function getCombinedMag(freq, fs) {
        let m=1;
        for (const f of PARAMS.eqFilters) { if (!f.enabled) continue; m*=magAtFreq(computeBiquadCoefs(f.type,f.frequency,f.gain,f.Q,fs),freq,fs); }
        return 20*Math.log10(m);
    }

    /* ===========================
       APP (unchanged from Android version)
    =========================== */

    const App = {
        panel: null, isVisible: false, shortcutButton: null,
        graphCanvas: null, graphCtx: null, meterCanvas: null, meterCtx: null,
        animFrame: null, draggingFilter: null, meterInterval: null,
        meterHistL: [], meterHistR: [],

        init() { this.createShortcut(); this.createPanel(); this.injectCSS(); this.bindEvents(); setTimeout(() => this.show(), 500); },

        show() {
            this.isVisible = true; this.panel.style.display = 'flex'; this.shortcutButton.classList.add('active');
            setTimeout(() => { this.panel.style.opacity = '1'; this.panel.style.transform = 'translateY(0) scale(1)'; }, 10);
            if (this.graphCanvas) this.startGraphLoop();
            if (this.meterCanvas) this.startMeterLoop();
        },

        hide() {
            this.isVisible = false; this.panel.style.opacity = '0';
            this.panel.style.transform = 'translateY(10px) scale(0.98)'; this.shortcutButton.classList.remove('active');
            setTimeout(() => { this.panel.style.display = 'none'; }, 200);
            if (this.animFrame) { cancelAnimationFrame(this.animFrame); this.animFrame = null; }
        },

        toggle() { this.isVisible ? this.hide() : this.show(); },

        setStatus(text, color) { const el = document.getElementById('zc-status'); if (el) { el.textContent = text; el.style.color = color; } },

        onRecorderStart() {
            const btn = document.getElementById('zc-rec-btn');
            const status = document.getElementById('zc-rec-status');
            if (btn) { btn.innerHTML = `${Icons.stop} Stop`; btn.classList.add('active'); }
            if (status) status.textContent = 'Recording...';
            const t0 = Date.now();
            if (this._recTimer) clearInterval(this._recTimer);
            this._recTimer = setInterval(() => {
                const el = document.getElementById('zc-rec-time');
                if (el && Recorder.isRecording) {
                    const s = Math.floor((Date.now() - t0) / 1000);
                    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
                }
            }, 200);
        },

        onRecorderStop() {
            const btn = document.getElementById('zc-rec-btn');
            const status = document.getElementById('zc-rec-status');
            const time = document.getElementById('zc-rec-time');
            if (btn) { btn.innerHTML = `${Icons.record} Record`; btn.classList.remove('active'); }
            if (status) status.textContent = 'Saved';
            if (time) time.textContent = '00:00';
            if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null; }
            setTimeout(() => { const el = document.getElementById('zc-rec-status'); if (el && !Recorder.isRecording) el.textContent = 'Ready'; }, 2000);
        },

        startMeter() {},
        startMeterLoop() { const loop = () => { this.drawMeters(); this.animFrame = requestAnimationFrame(loop); }; loop(); },

        createShortcut() {
            this.shortcutButton = document.createElement('div');
            this.shortcutButton.id = 'zc-shortcut';
            this.shortcutButton.innerHTML = `<span class="zc-sico">${Icons.faders}</span><span class="zc-slabel">Zesty EQ</span>`;
            document.body.appendChild(this.shortcutButton);
            this.makeDraggable(this.shortcutButton);
            this.shortcutButton.addEventListener('click', (e) => { if (this._didDrag) return; this.toggle(); });
            this.shortcutButton.addEventListener('mousedown', () => { this._didDrag = false; });
            this.shortcutButton.addEventListener('mousemove', () => { this._didDrag = true; });
        },

        createPanel() {
            this.panel = document.createElement('div');
            this.panel.id = 'zc-panel';
            this.panel.innerHTML = `
                <div class="zc-header" id="zc-header">
                    <span class="zc-hico">${Icons.faders}</span>
                    <span class="zc-htitle">Zesty EQ</span>
                    <span class="zc-hsub">Professional Audio Workstation</span>
                    <div class="zc-hspacer"></div>
                    <button class="zc-hbtn" id="zc-save" title="Save Preset">${Icons.save}</button>
                    <button class="zc-hbtn" id="zc-load" title="Load Preset">${Icons.load}</button>
                    <button class="zc-hbtn" id="zc-minimize" title="Minimize">${Icons.minimize}</button>
                    <button class="zc-hbtn zc-hclose" id="zc-close" title="Close">${Icons.close}</button>
                </div>
                <div class="zc-body">
                    <div class="zc-section">
                        <div class="zc-meter-section">
                            <canvas id="zc-meters" width="416" height="80"></canvas>
                            <div class="zc-meter-info">
                                <span class="zc-meter-label">Stereo Correlation: <span id="zc-corr-val">+1.00</span></span>
                                <span class="zc-db-readout" id="zc-db-val">-∞ dB</span>
                            </div>
                        </div>
                    </div>
                    <div class="zc-section">
                        <div class="zc-graph-wrap">
                            <canvas id="zc-graph" width="820" height="260"></canvas>
                            <div class="zc-graph-overlay">
                                <span class="zc-graph-label">Frequency Analyzer &amp; EQ Curve</span>
                                <div class="zc-graph-right"><span class="zc-meter-num" id="zc-freq-hz">—</span></div>
                            </div>
                        </div>
                    </div>
                    <div class="zc-section"><div class="zc-panel-header open" data-panel="preamp"><span class="zc-ph-icon">${Icons.preamp}</span><span class="zc-ph-title">Preamp &amp; Pan</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-preamp-body">
                        <div class="zc-slider-row"><span class="zc-slider-label">Preamp</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-blue" id="zpf-preamp" style="width:50%"></div></div><input type="range" class="zc-slider-input" id="zc-preamp" min="0" max="100" value="50"></div><span class="zc-slider-value" id="zc-preamp-val">0.0 dB</span><button class="zc-reset-btn" data-reset="preamp" data-val="50">${Icons.reset}</button></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Pan</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-pan" id="zpf-pan" style="width:50%"></div></div><input type="range" class="zc-slider-input" id="zc-pan" min="0" max="100" value="50"></div><span class="zc-slider-value" id="zc-pan-val">C</span><button class="zc-reset-btn" data-reset="pan" data-val="50">${Icons.reset}</button></div>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header open" data-panel="eq"><span class="zc-ph-icon">${Icons.eq}</span><span class="zc-ph-title">Parametric EQ</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-eq-body">
                        <div class="zc-eq-table"><div class="zc-eq-thead"><span class="zc-eq-col zc-eq-enable">On</span><span class="zc-eq-col zc-eq-type">Type</span><span class="zc-eq-col zc-eq-freq">Freq (Hz)</span><span class="zc-eq-col zc-eq-gain">Gain (dB)</span><span class="zc-eq-col zc-eq-q">Q</span><span class="zc-eq-col zc-eq-del"></span></div><div class="zc-eq-rows" id="zc-eq-rows"></div></div>
                        <button class="zc-add-filter" id="zc-add-filter">+ Add Filter Band</button>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header" data-panel="stereo"><span class="zc-ph-icon">${Icons.stereo}</span><span class="zc-ph-title">Stereo Tools</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-stereo-body">
                        <div class="zc-btn-row"><button class="zc-toggle-btn ${PARAMS.mono?'active':''}" id="zc-toggle-mono">${Icons.mono} Force Mono</button><button class="zc-toggle-btn ${PARAMS.swap?'active':''}" id="zc-toggle-swap">${Icons.swap} Swap Channels</button></div>
                        <div class="zc-btn-row"><button class="zc-toggle-btn ${PARAMS.phaseL?'active':''}" id="zc-toggle-phaseL">Phase Invert L</button><button class="zc-toggle-btn ${PARAMS.phaseR?'active':''}" id="zc-toggle-phaseR">Phase Invert R</button></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Width</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-blue" id="zpf-width" style="width:50%"></div></div><input type="range" class="zc-slider-input" id="zc-width" min="0" max="100" value="50"></div><span class="zc-slider-value" id="zc-width-val">50%</span><button class="zc-reset-btn" data-reset="width" data-val="50">${Icons.reset}</button></div>
                        <div class="zc-correlation-bar"><span class="zc-corr-label">Phase Correlation</span><div class="zc-corr-track"><div class="zc-corr-fill" id="zc-corr-bar" style="left:50%;width:0%"></div></div><span class="zc-corr-num" id="zc-corr-num">+1.00</span></div>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header" data-panel="fx"><span class="zc-ph-icon">${Icons.fx}</span><span class="zc-ph-title">FX Rack</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-fx-body">
                        <div class="zc-slider-row"><span class="zc-slider-label">Drive</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-orange" id="zpf-drive"></div></div><input type="range" class="zc-slider-input" id="zc-drive" min="0" max="100" value="0"></div><span class="zc-slider-value" id="zc-drive-val">0%</span></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Saturation</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-orange" id="zpf-saturation"></div></div><input type="range" class="zc-slider-input" id="zc-saturation" min="0" max="100" value="0"></div><span class="zc-slider-value" id="zc-saturation-val">0%</span></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Reverb</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-purple" id="zpf-reverb"></div></div><input type="range" class="zc-slider-input" id="zc-reverb" min="0" max="100" value="0"></div><span class="zc-slider-value" id="zc-reverb-val">0%</span></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Delay</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-purple" id="zpf-delay"></div></div><input type="range" class="zc-slider-input" id="zc-delay" min="0" max="100" value="0"></div><span class="zc-slider-value" id="zc-delay-val">0%</span></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Chorus</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-purple" id="zpf-chorus"></div></div><input type="range" class="zc-slider-input" id="zc-chorus" min="0" max="100" value="0"></div><span class="zc-slider-value" id="zc-chorus-val">0%</span></div>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header" data-panel="output"><span class="zc-ph-icon">${Icons.output}</span><span class="zc-ph-title">Output &amp; Limiter</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-output-body">
                        <div class="zc-slider-row"><span class="zc-slider-label">Output Gain</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-blue" id="zpf-outputGain" style="width:50%"></div></div><input type="range" class="zc-slider-input" id="zc-outputGain" min="0" max="100" value="50"></div><span class="zc-slider-value" id="zc-outputGain-val">0.0 dB</span><button class="zc-reset-btn" data-reset="outputGain" data-val="50">${Icons.reset}</button></div>
                        <div class="zc-slider-row"><span class="zc-slider-label">Limiter</span><div class="zc-slider-container"><div class="zc-slider-track"><div class="zc-slider-fill zc-fill-red" id="zpf-limiter" style="width:100%"></div></div><input type="range" class="zc-slider-input" id="zc-limiter" min="0" max="100" value="100"></div><span class="zc-slider-value" id="zc-limiter-val">0 dBFS</span><button class="zc-reset-btn" data-reset="limiter" data-val="100">${Icons.reset}</button></div>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header" data-panel="warfare"><span class="zc-ph-icon">${Icons.warfare}</span><span class="zc-ph-title">Warfare</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-warfare-body">
                        <div class="zc-warfare-grid">
                            <button class="zc-war-btn" data-param="vacuum">Vacuum</button>
                            <button class="zc-war-btn" data-param="sabotageHum">Sabotage</button>
                            <button class="zc-war-btn" data-param="ghost">Ghost</button>
                            <button class="zc-war-btn" data-param="siren">Siren</button>
                            <button class="zc-war-btn zc-war-beast" data-param="beastMode">Beast Mode</button>
                            <button class="zc-war-btn zc-war-talk" data-param="talkMode">Talk Mode</button>
                        </div>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header" data-panel="soundboard"><span class="zc-ph-icon">${Icons.music}</span><span class="zc-ph-title">Soundboard</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-soundboard-body">
                        <button class="zc-sb-upload" id="zc-sb-upload">+ Upload Audio File</button>
                        <div class="zc-sb-yt-row"><input type="text" class="zc-sb-yt-input" id="zc-sb-yt-input" placeholder="Paste YouTube URL..."><button class="zc-sb-yt-btn" id="zc-sb-yt-btn">${Icons.download}</button></div>
                        <div class="zc-sb-list" id="zc-sb-list"></div>
                    </div></div>
                    <div class="zc-section"><div class="zc-panel-header" data-panel="recorder"><span class="zc-ph-icon">${Icons.record}</span><span class="zc-ph-title">Recorder</span><span class="zc-ph-arrow">▼</span></div><div class="zc-panel-body" id="zc-recorder-body">
                        <div class="zc-rec-controls"><button class="zc-rec-btn" id="zc-rec-btn">${Icons.record} Record</button><span class="zc-rec-status" id="zc-rec-status">Ready</span><span class="zc-rec-time" id="zc-rec-time">00:00</span></div>
                        <div class="zc-rec-opts"><label class="zc-rec-opt"><input type="checkbox" id="zc-rec-mic" checked> ${Icons.mic} Mic</label><label class="zc-rec-opt"><input type="checkbox" id="zc-rec-ext" checked> ${Icons.people} Others</label></div>
                    </div></div>
                </div>
            `;
            document.body.appendChild(this.panel);
            this.makeDraggable(this.panel.querySelector('#zc-header'));
            this.graphCanvas = document.getElementById('zc-graph');
            this.graphCtx = this.graphCanvas.getContext('2d');
            this.meterCanvas = document.getElementById('zc-meters');
            this.meterCtx = this.meterCanvas.getContext('2d');
        },

        drawMeters() {
            const c = this.meterCanvas; const ctx = this.meterCtx;
            const W = c.width; const H = c.height;
            ctx.clearRect(0, 0, W, H);
            const peakL = Core.meterData.peakL || 0;
            const peakR = Core.meterData.peakR || 0;
            const corr = Core.meterData.corr || 0;

            this.meterHistL.push(peakL); this.meterHistR.push(peakR);
            if (this.meterHistL.length > 30) this.meterHistL.shift();
            if (this.meterHistR.length > 30) this.meterHistR.shift();

            const barW = 160; const barH = 18;

            const drawBar = (x, y, peak, hist, label, color) => {
                const db = peak > 0 ? 20 * Math.log10(Math.min(1, peak)) : -60;
                const pct = Math.min(100, Math.max(0, (db + 60) / 60 * 100));
                ctx.fillStyle = '#060606';
                ctx.fillRect(x, y, barW, barH);
                const grad = ctx.createLinearGradient(x, y, x + barW, y);
                grad.addColorStop(0, '#6644ff'); grad.addColorStop(0.6, '#00aaff');
                grad.addColorStop(0.85, '#ffcc00'); grad.addColorStop(1, '#ff3300');
                ctx.fillStyle = grad;
                ctx.fillRect(x + 2, y + 2, Math.max(0, (barW - 4) * pct / 100), barH - 4);
                let hold = 0;
                for (let i = hist.length - 1; i >= 0; i--) { if (hist[i] > hold) hold = hist[i]; }
                const holdDb = hold > 0 ? 20 * Math.log10(Math.min(1, hold)) : -60;
                const holdPct = Math.min(100, Math.max(0, (holdDb + 60) / 60 * 100));
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.fillRect(x + 2 + (barW - 4) * holdPct / 100 - 1, y + 1, 2, barH - 2);
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.font = '8px Inter, sans-serif';
                ctx.textAlign = 'left'; ctx.fillText(label, x + 4, y + 12);
                ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
                ctx.font = '700 9px JetBrains Mono, monospace';
                ctx.fillText(db.toFixed(1) + ' dB', x + barW - 4, y + 12);
                for (let d = -60; d <= 0; d += 10) {
                    const dp = Math.min(100, Math.max(0, (d + 60) / 60 * 100));
                    ctx.fillStyle = 'rgba(255,255,255,0.1)';
                    ctx.fillRect(x + 2 + (barW - 4) * dp / 100, y, 1, barH);
                }
            };

            drawBar(12, 8, peakL, this.meterHistL, 'L', '#00aaff');
            drawBar(12, 44, peakR, this.meterHistR, 'R', '#00aaff');

            const cx = 340, cy = H / 2, r = 28;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#060606'; ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.stroke();

            const angle = Math.max(-1, Math.min(1, corr)) * Math.PI * 0.75;
            ctx.beginPath(); ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.sin(angle) * r * 0.7, cy - Math.cos(angle) * r * 0.7);
            ctx.strokeStyle = corr > 0.5 ? '#00aaff' : corr > 0 ? '#ffcc00' : '#ff3300';
            ctx.lineWidth = 2.5;
            ctx.shadowColor = corr > 0.5 ? 'rgba(0,170,255,0.5)' : 'rgba(255,204,0,0.3)';
            ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;

            ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = '7px Inter, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('CORR', cx, cy + 3);

            const corrEl = document.getElementById('zc-corr-val');
            if (corrEl) corrEl.textContent = (corr > 0 ? '+' : '') + corr.toFixed(2);
            const corrNum = document.getElementById('zc-corr-num');
            if (corrNum) corrNum.textContent = (corr > 0 ? '+' : '') + corr.toFixed(2);

            const dbEl = document.getElementById('zc-db-val');
            if (dbEl) { const db = Core.getDb(); dbEl.textContent = db > -99 ? db.toFixed(1) + ' dB' : '-∞ dB'; }
        },

        startGraphLoop() { const loop = () => { this.drawGraph(); this.animFrame = requestAnimationFrame(loop); }; loop(); },

        drawGraph() {
            const c = this.graphCanvas; const ctx = this.graphCtx;
            const W = c.width; const H = c.height;
            const pad = { top: 20, bottom: 26, left: 42, right: 14 };
            const gW = W - pad.left - pad.right; const gH = H - pad.top - pad.bottom;
            const fs = 48000;
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H);

            const freqMin = 20, freqMax = 20000, dBMin = -30, dBMax = 30;
            function f2x(f) { return pad.left + (Math.log2(f/freqMin)/Math.log2(freqMax/freqMin)) * gW; }
            function db2y(db) { return pad.top + (1 - (db-dBMin)/(dBMax-dBMin)) * gH; }

            ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1;
            for (let db = dBMin; db <= dBMax; db += 10) {
                const y = db2y(db); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W-pad.right, y); ctx.stroke();
                ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.font = '8px Inter, sans-serif'; ctx.textAlign = 'right';
                ctx.fillText((db>=0?'+':'')+db, pad.left-5, y+3);
            }
            const freqLbls = [20,50,100,200,500,1000,2000,5000,10000,20000];
            ctx.strokeStyle = 'rgba(255,255,255,0.025)';
            for (const f of freqLbls) {
                const x = f2x(f); ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top+gH); ctx.stroke();
                ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.font = '8px Inter, sans-serif'; ctx.textAlign = 'center';
                ctx.fillText(f>=1000?(f/1000)+'k':''+f, x, pad.top+gH+14);
            }

            ctx.strokeStyle = 'rgba(0,170,255,0.05)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
            const zy = db2y(0); ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(W-pad.right, zy); ctx.stroke(); ctx.setLineDash([]);

            const freqData = Core.getFrequencyData();
            if (freqData) {
                const bc = freqData.length; ctx.beginPath();
                for (let i = 0; i < bc; i++) {
                    const t = i/bc; const x = f2x(Math.max(freqMin, Math.min(freqMax, t*fs/2)));
                    const v = freqData[i]/255; const y = db2y(Math.max(dBMin, Math.min(dBMax, v*60-60)));
                    i===0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.strokeStyle = 'rgba(0,170,255,0.06)'; ctx.lineWidth = 1.5; ctx.stroke();
            }

            const pts = [];
            for (let i = 0; i <= 300; i++) {
                const t = i/300; const freq = freqMin * Math.pow(freqMax/freqMin, t);
                const db = getCombinedMag(freq, fs); pts.push({x: f2x(freq), y: db2y(Math.max(dBMin, Math.min(dBMax, db))), freq, db});
            }
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) { const xc = (pts[i-1].x + pts[i].x)/2; const yc = (pts[i-1].y + pts[i].y)/2; ctx.quadraticCurveTo(pts[i-1].x, pts[i-1].y, xc, yc); }
            ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
            ctx.strokeStyle = '#00aaff'; ctx.lineWidth = 2.5; ctx.shadowColor = 'rgba(0,170,255,0.4)'; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;

            for (const f of PARAMS.eqFilters) {
                if (!f.enabled) continue;
                const x = f2x(f.frequency); const y = db2y(Math.max(dBMin, Math.min(dBMax, getCombinedMag(f.frequency, fs))));
                const act = this.draggingFilter && this.draggingFilter.id === f.id;
                ctx.beginPath(); ctx.arc(x, y, act ? 7 : 5, 0, Math.PI*2);
                ctx.fillStyle = act ? '#fff' : '#00aaff'; ctx.shadowColor = 'rgba(0,170,255,0.7)'; ctx.shadowBlur = act ? 18 : 8; ctx.fill(); ctx.shadowBlur = 0;
                ctx.beginPath(); ctx.arc(x, y, act ? 9 : 7, 0, Math.PI*2);
                ctx.strokeStyle = 'rgba(0,170,255,0.25)'; ctx.lineWidth = 1.5; ctx.stroke();
            }
        },

        bindEvents() {
            this.panel.querySelectorAll('.zc-panel-header').forEach(h => {
                h.addEventListener('click', () => {
                    const open = h.classList.contains('open');
                    h.classList.toggle('open', !open);
                    h.querySelector('.zc-ph-arrow').textContent = open ? '▶' : '▼';
                });
            });

            document.getElementById('zc-close').addEventListener('click', () => this.hide());
            document.getElementById('zc-minimize').addEventListener('click', () => {
                const b = this.panel.querySelector('.zc-body');
                if (b) b.style.display = b.style.display === 'none' ? 'block' : 'none';
            });

            document.getElementById('zc-save').addEventListener('click', () => {
                const data = JSON.stringify({
                    eqFilters: PARAMS.eqFilters.map(f => ({type:f.type,frequency:f.frequency,gain:f.gain,Q:f.Q,enabled:f.enabled})),
                    preamp: PARAMS.preamp, pan: PARAMS.pan, width: PARAMS.width,
                    drive: PARAMS.drive, saturation: PARAMS.saturation, reverb: PARAMS.reverb,
                    delay: PARAMS.delay, chorus: PARAMS.chorus, outputGain: PARAMS.outputGain,
                    limiter: PARAMS.limiter, mono: PARAMS.mono, swap: PARAMS.swap,
                    phaseL: PARAMS.phaseL, phaseR: PARAMS.phaseR
                }, null, 2);
                const blob = new Blob([data], {type:'application/json'});
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zesty-eq-preset.json'; a.click();
            });

            document.getElementById('zc-load').addEventListener('click', () => {
                const inp = document.createElement('input'); inp.type='file'; inp.accept='.json';
                const app = this;
                inp.onchange = (e) => {
                    const file = e.target.files[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        try {
                            const d = JSON.parse(ev.target.result);
                            if (d.eqFilters) { PARAMS.eqFilters.length = 0; d.eqFilters.forEach(x => {const f=createFilter(x.type,x.frequency,x.gain,x.Q);f.enabled=x.enabled!==false;}); app.renderEQRows(); }
                            ['preamp','pan','width','drive','saturation','reverb','delay','chorus','outputGain','limiter'].forEach(k => {
                                if (d[k]!==undefined) { PARAMS[k]=d[k]; const s = document.getElementById('zc-'+k); if (s) { s.value=d[k]; s.dispatchEvent(new Event('input',{bubbles:true})); } }
                            });
                            ['mono','swap','phaseL','phaseR'].forEach(k => { if (d[k]!==undefined) { PARAMS[k]=d[k]; const btn = document.getElementById('zc-toggle-'+k); if (btn) btn.classList.toggle('active', d[k]); } });
                            Core.update();
                        } catch(e) { console.error('Invalid preset'); }
                    };
                    reader.readAsText(file);
                };
                inp.click();
            });

            this.bindSlider('zc-preamp','preamp',v=>{const d=v-50;return(d>=0?'+':'')+(d*0.3).toFixed(1)+' dB'});
            this.bindSlider('zc-pan','pan',v=>{if(v<45)return'L'+Math.round((50-v)*2);if(v>55)return'R'+Math.round((v-50)*2);return'C'});
            this.bindSlider('zc-width','width',v=>v+'%');
            this.bindSlider('zc-drive','drive',v=>v+'%');
            this.bindSlider('zc-saturation','saturation',v=>v+'%');
            this.bindSlider('zc-reverb','reverb',v=>v+'%');
            this.bindSlider('zc-delay','delay',v=>v+'%');
            this.bindSlider('zc-chorus','chorus',v=>v+'%');
            this.bindSlider('zc-outputGain','outputGain',v=>{const d=v-50;return(d>=0?'+':'')+(d*0.3).toFixed(1)+' dB'});
            this.bindSlider('zc-limiter','limiter',v=>{const dB=20*Math.log10(Math.max(0.01,v/100));return dB.toFixed(1)+' dBFS'});

            document.querySelectorAll('[data-reset]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.dataset.reset; const val = btn.dataset.val !== undefined ? btn.dataset.val : 0;
                    const slider = document.getElementById('zc-'+id);
                    if (slider) { slider.value = val; slider.dispatchEvent(new Event('input', {bubbles: true})); }
                });
            });

            document.getElementById('zc-add-filter').addEventListener('click', () => {
                createFilter('Peak',1000,0,0.707); this.renderEQRows();
                const h = this.panel.querySelector('.zc-panel-header[data-panel="eq"]');
                h.classList.add('open'); h.querySelector('.zc-ph-arrow').textContent = '▼';
                Core.rebuildEQ();
            });

            this.bindGraphDrag();

            ['mono','swap','phaseL','phaseR'].forEach(k => {
                const btn = document.getElementById('zc-toggle-'+k);
                if (btn) { btn.addEventListener('click', () => { PARAMS[k] = !PARAMS[k]; btn.classList.toggle('active', PARAMS[k]); Core.update(); }); }
            });

            document.querySelectorAll('.zc-war-btn').forEach(btn => {
                btn.addEventListener('click', () => { const p = btn.dataset.param; PARAMS[p] = !PARAMS[p]; btn.classList.toggle('active', PARAMS[p]); Core.update(); });
            });

            document.getElementById('zc-sb-upload').addEventListener('click', () => {
                const inp = document.createElement('input'); inp.type='file'; inp.accept='audio/*'; inp.multiple=true;
                inp.onchange = (e) => { for (const f of e.target.files) this.addSoundboardItem(f); };
                inp.click();
            });

            const ytInput = document.getElementById('zc-sb-yt-input');
            const ytBtn = document.getElementById('zc-sb-yt-btn');
            const doYT = () => this.addFromYouTube();
            ytBtn.addEventListener('click', doYT);
            ytInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doYT(); });

            window.addEventListener('message', (event) => {
                if (event.data && event.data.source === 'zestcord-bridge' && event.data.action === 'fetch-yt-audio-response') {
                    this.handleYTDownloadResponse(event.data);
                }
            });

            document.getElementById('zc-rec-btn').addEventListener('click', () => Recorder.toggle());
        },

        addSoundboardItem(file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                PARAMS.soundboard.push({id:++sbIdCounter,name:file.name,data:e.target.result,volume:1,playing:false,entry:null});
                this.renderSoundboard();
            };
            reader.readAsArrayBuffer(file);
        },

        addFromYouTube() {
            const input = document.getElementById('zc-sb-yt-input');
            const url = input.value.trim();
            if (!url) return;
            const videoId = this.extractYouTubeId(url);
            if (!videoId) { input.placeholder = 'Invalid URL'; setTimeout(() => { input.placeholder = 'Paste YouTube URL...'; }, 2000); return; }
            input.disabled = true; input.value = 'Downloading...';
            const requestId = Date.now().toString() + Math.random().toString(36).slice(2);
            this._pendingYT = { requestId, videoId, input };
            window.postMessage({ source: 'zestcord-main', action: 'fetch-yt-audio', videoId, requestId }, '*');
        },

        extractYouTubeId(url) {
            const patterns = [
                /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
                /^([a-zA-Z0-9_-]{11})$/
            ];
            for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
            return null;
        },

        handleYTDownloadResponse(data) {
            if (!this._pendingYT || this._pendingYT.requestId !== data.requestId) return;
            const { input } = this._pendingYT; this._pendingYT = null;
            input.disabled = false;
            if (data.success) {
                const uint8 = new Uint8Array(data.data);
                const blob = new Blob([uint8], { type: 'audio/mpeg' });
                const name = `youtube-${data.videoId || 'audio'}.mp3`;
                const file = new File([blob], name, { type: 'audio/mpeg' });
                input.value = ''; this.addSoundboardItem(file);
            } else {
                input.value = ''; input.placeholder = 'Error: ' + (data.error || 'download failed');
                setTimeout(() => { input.placeholder = 'Paste YouTube URL...'; }, 3000);
            }
        },

        renderSoundboard() {
            const list = document.getElementById('zc-sb-list'); if (!list) return;
            list.innerHTML = '';
            for (const item of PARAMS.soundboard) {
                const el = document.createElement('div'); el.className = 'zc-sb-item';
                el.innerHTML = `<span class="zc-sb-name">${Icons.music} ${item.name}</span><div class="zc-sb-controls"><button class="zc-sb-play" data-id="${item.id}">${item.playing?Icons.stop:Icons.play}</button><div class="zc-sb-vol-wrap"><input type="range" class="zc-sb-vol" data-id="${item.id}" min="0" max="100" value="${item.volume*100}"></div><button class="zc-sb-del" data-id="${item.id}">${Icons.close}</button></div>`;
                list.appendChild(el);
                const playBtn = el.querySelector('.zc-sb-play');
                playBtn.addEventListener('click', async () => {
                    if (item.playing && item.entry) { Core.stopSoundboard(item.entry); item.playing = false; item.entry = null; playBtn.innerHTML = Icons.play; }
                    else { item.entry = await Core.playSoundboardItem(item); if (item.entry) { item.playing = true; playBtn.innerHTML = Icons.stop; item.entry.source.onended = () => { item.playing = false; item.entry = null; const b = el.querySelector('.zc-sb-play'); if (b) b.innerHTML = Icons.play; }; } }
                });
                el.querySelector('.zc-sb-vol').addEventListener('input', function() {
                    item.volume = parseFloat(this.value)/100;
                    if (item.entry && item.entry.gainNode) item.entry.gainNode.gain.value = item.volume;
                });
                el.querySelector('.zc-sb-del').addEventListener('click', () => {
                    if (item.playing && item.entry) Core.stopSoundboard(item.entry);
                    const idx = PARAMS.soundboard.indexOf(item); if (idx>=0) PARAMS.soundboard.splice(idx,1);
                    this.renderSoundboard();
                });
            }
        },

        bindSlider(id, param, formatFn) {
            const slider = document.getElementById(id); if (!slider) return;
            const valEl = document.getElementById(id+'-val'); const fillEl = document.getElementById('zpf-'+param);
            const update = () => { const v = parseFloat(slider.value); PARAMS[param] = v; if (valEl) valEl.textContent = formatFn(v); if (fillEl) fillEl.style.width = v+'%'; Core.update(); };
            slider.addEventListener('input', update);
            slider.addEventListener('wheel', (e) => { e.preventDefault(); const step = e.shiftKey ? 5 : 1; slider.value = Math.max(0, Math.min(100, parseFloat(slider.value)+(e.deltaY<0?step:-step))); update(); }, {passive:false});
            update();
        },

        bindGraphDrag() {
            const c = this.graphCanvas; const freqMin=20,freqMax=20000,dBMin=-30,dBMax=30;
            const pad={left:42,right:14,top:20,bottom:26};
            const gW=820-pad.left-pad.right,gH=260-pad.top-pad.bottom;
            function x2f(x) { return freqMin*Math.pow(freqMax/freqMin,(x-pad.left)/gW); }
            function nearest(mx,my) {
                let best=null,bestD=Infinity;
                for (const f of PARAMS.eqFilters) {
                    if (!f.enabled) continue;
                    const x=pad.left+(Math.log2(f.frequency/freqMin)/Math.log2(freqMax/freqMin))*gW;
                    const db=getCombinedMag(f.frequency,48000);
                    const y=pad.top+(1-(Math.max(dBMin,Math.min(dBMax,db))-dBMin)/(dBMax-dBMin))*gH;
                    const d=Math.hypot(mx-x,my-y);
                    if (d<bestD) { bestD=d; best=f; }
                }
                return bestD<25?best:null;
            }
            c.addEventListener('mousedown', (e) => {
                const r=c.getBoundingClientRect(); const mx=(e.clientX-r.left)*(c.width/r.width); const my=(e.clientY-r.top)*(c.height/r.height);
                const f=nearest(mx,my); if (f) { this.draggingFilter=f; c.style.cursor='grabbing'; e.preventDefault(); }
            });
            document.addEventListener('mousemove', (e) => {
                const r=c.getBoundingClientRect(); const mx=(e.clientX-r.left)*(c.width/r.width); const my=(e.clientY-r.top)*(c.height/r.height);
                if (this.draggingFilter) {
                    const freq=Math.max(freqMin,Math.min(freqMax,x2f(mx)));
                    const ny=1-(my-pad.top)/gH; const db=Math.max(dBMin,Math.min(dBMax,dBMin+ny*(dBMax-dBMin)));
                    this.draggingFilter.frequency=Math.round(freq); this.draggingFilter.gain=Math.round(db*10)/10;
                    this.renderEQRows(); Core.rebuildEQ(); e.preventDefault();
                } else { c.style.cursor=nearest(mx,my)?'grab':'default'; }
            });
            document.addEventListener('mouseup', () => { if (this.draggingFilter) { this.draggingFilter=null; c.style.cursor='default'; } });
        },

        renderEQRows() {
            const c=document.getElementById('zc-eq-rows'); if (!c) return;
            c.innerHTML=''; for (const f of PARAMS.eqFilters) c.appendChild(this.createFilterRow(f));
        },

        createFilterRow(f) {
            const row=document.createElement('div'); row.className='zc-eq-row';
            const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=f.enabled; cb.className='zc-eq-cb';
            const sel=document.createElement('select'); sel.className='zc-eq-sel';
            FILTER_TYPES.forEach(t=>{const o=document.createElement('option');o.value=t;o.textContent=t;if(t===f.type)o.selected=true;sel.appendChild(o);});
            const fi=this.mkNum(f.frequency,'1',v=>{f.frequency=Math.max(20,Math.min(20000,v||20));});
            const gi=this.mkNum(f.gain,'0.1',v=>{f.gain=Math.max(-30,Math.min(30,v||0));});
            const qi=this.mkNum(f.Q,'0.01',v=>{f.Q=Math.max(0.01,Math.min(100,v||0.01));});
            const del=document.createElement('button'); del.className='zc-eq-del'; del.innerHTML=Icons.close; del.title='Delete';
            del.addEventListener('click',()=>{const i=PARAMS.eqFilters.indexOf(f);if(i>=0)PARAMS.eqFilters.splice(i,1);this.renderEQRows();Core.rebuildEQ();});
            row.append(cb,sel,fi,gi,qi,del);
            const ch=()=>{Core.rebuildEQ();Core.update();};
            cb.addEventListener('change',()=>{f.enabled=cb.checked;ch();});
            sel.addEventListener('change',()=>{f.type=sel.value;ch();});
            row.querySelectorAll('input[type="number"]').forEach(inp=>{
                inp.addEventListener('input',ch);
                inp.addEventListener('wheel',e=>{e.preventDefault();const s=parseFloat(inp.dataset.step||'1');inp.value=parseFloat(inp.value)+(e.deltaY<0?s:-s);inp.dispatchEvent(new Event('input'));},{passive:false});
            });
            return row;
        },

        mkNum(def,step,fn) {
            const inp=document.createElement('input'); inp.type='number'; inp.className='zc-eq-num'; inp.value=def; inp.dataset.step=step;
            inp.addEventListener('input',()=>{const v=parseFloat(inp.value);if(!isNaN(v))fn(v);});
            inp.addEventListener('blur',()=>{const v=parseFloat(inp.value);if(!isNaN(v)){fn(v);inp.value=v;}});
            return inp;
        },

        makeDraggable(el) {
            let drag=false,ox,oy;
            const tgt=()=>el.id==='zc-shortcut'?el:el.closest('#zc-panel')||el;
            const sd=e=>{if(e.button!==0)return;const t=tgt(),r=t.getBoundingClientRect();drag=true;ox=e.clientX-r.left;oy=e.clientY-r.top;t.style.right='auto';t.style.left=r.left+'px';t.style.top=r.top+'px';e.preventDefault();document.addEventListener('mousemove',mv);document.addEventListener('mouseup',sp);};
            const mv=e=>{if(!drag)return;e.preventDefault();const t=tgt();t.style.left=Math.max(0,Math.min(e.clientX-ox,window.innerWidth-t.offsetWidth))+'px';t.style.top=Math.max(0,Math.min(e.clientY-oy,window.innerHeight-t.offsetHeight))+'px';};
            const sp=()=>{drag=false;document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',sp);};
            el.addEventListener('mousedown',sd);
        },

        injectCSS() {
            const s=document.createElement('style');
            s.textContent=`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap');
                :root{--bg:#060606;--surf:#0b0b0b;--bord:#1a1a1a;--bhover:#2a2a2a;--accent:#00aaff;--glow:rgba(0,170,255,0.2);--glow2:rgba(0,170,255,0.06);--purple:#6644ff;--text:#aaa;--dim:#3d3d3d;--r:10px}
                #zc-shortcut{position:fixed;top:20px;right:20px;background:linear-gradient(135deg,#0d0d0d,#0a0a0a);border:1px solid var(--bord);border-radius:var(--r);padding:8px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;z-index:9999998;box-shadow:0 20px 60px rgba(0,0,0,.95);transition:all .3s cubic-bezier(.19,1,.22,1);user-select:none}
                #zc-shortcut:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 20px 60px rgba(0,0,0,.95),0 0 30px var(--glow)}
                #zc-shortcut.active{border-color:var(--accent);box-shadow:0 20px 60px rgba(0,0,0,.95),0 0 20px var(--glow)}
                .zc-sico{display:flex;align-items:center;color:var(--accent);width:18px;height:14px}
                .zc-slabel{font:700 9px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase;letter-spacing:2px;transition:color .2s}
                #zc-shortcut:hover .zc-slabel{color:var(--text)}
                #zc-panel{position:fixed;top:20px;right:20px;width:420px;max-height:92vh;background:var(--bg);border:1px solid var(--bord);border-radius:12px;box-shadow:0 30px 80px rgba(0,0,0,.95),0 0 60px rgba(0,0,0,.5);z-index:9999999;font-family:Inter,system-ui,sans-serif;display:none;flex-direction:column;opacity:0;transform:translateY(12px) scale(.97);transition:opacity .25s ease,transform .3s cubic-bezier(.19,1,.22,1),box-shadow .3s}
                .zc-header{background:linear-gradient(180deg,#141414 0%,#090909 100%);border-bottom:1px solid var(--bord);padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:move;user-select:none;flex-shrink:0;position:relative}
                .zc-header::after{content:'';position:absolute;bottom:-1px;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.15}
                .zc-hico{display:flex;align-items:center;color:var(--accent);width:16px;height:12px}
                .zc-htitle{font:800 11px/1 Inter,sans-serif;color:#eee;letter-spacing:1.5px}
                .zc-hsub{font:500 7px/1 Inter,sans-serif;color:var(--dim);letter-spacing:.5px;padding-top:2px}
                .zc-hspacer{flex:1}
                .zc-hbtn{width:24px;height:24px;border-radius:5px;border:1px solid var(--bord);background:transparent;color:var(--dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
                .zc-hbtn:hover{border-color:var(--bhover);color:var(--text);background:rgba(255,255,255,.025);box-shadow:0 0 8px rgba(0,0,0,.3)}
                .zc-hclose:hover{border-color:#aa3333;color:#ff5555;background:rgba(255,50,50,.06);box-shadow:0 0 10px rgba(255,50,50,.15)}
                .zc-hbtn:active{transform:scale(.93)}
                .zc-hbtn svg{width:12px;height:12px}
                .zc-body{position:relative;padding:10px;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth}
                .zc-body::-webkit-scrollbar{width:6px}
                .zc-body::-webkit-scrollbar-track{background:rgba(255,255,255,.015);border-radius:3px}
                .zc-body::-webkit-scrollbar-thumb{background:var(--bord);border-radius:3px;border:2px solid transparent;background-clip:padding-box;transition:background .2s}
                .zc-body::-webkit-scrollbar-thumb:hover{background:var(--bhover)}
                .zc-section{background:var(--surf);border:1px solid var(--bord);border-radius:6px;transition:border-color .2s,box-shadow .2s;flex-shrink:0}
                .zc-section:hover{border-color:var(--bhover);box-shadow:0 0 20px rgba(0,0,0,.4)}
                .zc-section:has(.zc-panel-header.open){border-color:var(--bhover)}
                .zc-meter-section{padding:6px;background:#060606;border-bottom:1px solid var(--bord)}
                .zc-meter-section canvas{display:block;width:100%;height:60px}
                .zc-meter-info{display:flex;justify-content:space-between;align-items:center;padding:3px 6px 0}
                .zc-meter-label{font:500 7px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
                .zc-meter-label span{color:var(--accent);font-weight:600}
                .zc-db-readout{font:600 10px/1 JetBrains Mono,monospace;color:var(--accent);text-shadow:0 0 8px var(--glow)}
                .zc-graph-wrap{position:relative;background:#050505;border-radius:0;overflow:hidden}
                .zc-graph-wrap canvas{display:block;width:100%;height:180px}
                .zc-graph-overlay{position:absolute;top:5px;left:8px;right:8px;display:flex;align-items:center;justify-content:space-between;pointer-events:none}
                .zc-graph-label{font:500 7px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
                .zc-graph-right{display:flex;align-items:center;gap:6px}
                .zc-meter-num{font:500 8px/1 JetBrains Mono,monospace;color:var(--dim)}
                .zc-panel-header{display:flex;align-items:center;gap:6px;padding:10px 12px;cursor:pointer;user-select:none;border-bottom:1px solid var(--bord);transition:background .2s,border-color .2s;position:relative}
                .zc-panel-header:hover{background:rgba(255,255,255,.018)}
                .zc-panel-header:active{background:rgba(255,255,255,.03)}
                .zc-panel-header.open{border-bottom-color:transparent;background:rgba(0,170,255,.015)}
                .zc-panel-header.open::after{content:'';position:absolute;left:0;top:4px;bottom:4px;width:2px;background:var(--accent);border-radius:0 2px 2px 0;opacity:.6}
                .zc-ph-icon{display:flex;align-items:center;color:var(--accent);width:14px;height:12px;opacity:.7;transition:opacity .2s}
                .zc-panel-header:hover .zc-ph-icon{opacity:1}
                .zc-ph-title{font:600 9px/1 Inter,sans-serif;color:var(--text);text-transform:uppercase;letter-spacing:1.2px;flex:1;transition:color .2s}
                .zc-panel-header:hover .zc-ph-title{color:#ccc}
                .zc-ph-arrow{font-size:7px;color:var(--dim);transition:transform .3s cubic-bezier(.4,0,.2,1),color .2s;display:inline-block}
                .zc-panel-header.open .zc-ph-arrow{transform:rotate(0deg)}
                .zc-panel-body{max-height:0;overflow:hidden;transition:max-height .35s cubic-bezier(.4,0,.2,1),opacity .3s ease,padding .3s ease;opacity:0;padding:0 10px}
                .zc-panel-header.open+.zc-panel-body{max-height:600px;opacity:1;padding:6px 10px 10px}
                .zc-slider-row{display:grid;grid-template-columns:68px 1fr 46px 18px;align-items:center;gap:6px;padding:4px 0}
                .zc-slider-label{font:500 7px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase;letter-spacing:.3px}
                .zc-slider-container{position:relative;height:20px;display:flex;align-items:center}
                .zc-slider-track{position:absolute;left:0;right:0;height:4px;background:#050505;border:1px solid #141414;border-radius:3px;overflow:hidden;transition:border-color .2s}
                .zc-slider-container:hover .zc-slider-track{border-color:#222}
                .zc-slider-fill{height:100%;width:0%;border-radius:3px;transition:width .05s ease-out;box-shadow:0 0 6px currentColor}
                .zc-fill-blue{background:linear-gradient(90deg,var(--purple),var(--accent))}
                .zc-fill-orange{background:linear-gradient(90deg,#6644ff,#ff6600)}
                .zc-fill-purple{background:linear-gradient(90deg,#6644ff,#cc44ff)}
                .zc-fill-red{background:linear-gradient(90deg,#ff6600,#ff3300)}
                .zc-fill-pan{background:linear-gradient(90deg,#00aaff,#6644ff,#00aaff)}
                .zc-slider-input{position:absolute;left:-2px;right:-2px;height:100%;opacity:0;cursor:ew-resize;z-index:2}
                .zc-slider-value{font:500 8px/1 JetBrains Mono,monospace;color:var(--text);text-align:right;transition:color .15s;min-width:40px}
                .zc-slider-container:hover~.zc-slider-value{color:#ccc}
                .zc-reset-btn{width:18px;height:18px;border-radius:4px;border:1px solid var(--bord);background:transparent;color:var(--dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
                .zc-reset-btn:hover{border-color:var(--accent);color:var(--accent);background:rgba(0,170,255,.04);box-shadow:0 0 6px var(--glow)}
                .zc-reset-btn:active{transform:scale(.92)}
                .zc-reset-btn svg{width:9px;height:9px}
                .zc-btn-row{display:flex;gap:4px;margin:3px 0}
                .zc-toggle-btn{flex:1;padding:6px 5px;border:1px solid var(--bord);border-radius:5px;background:#050505;color:var(--dim);font:600 7px/1 Inter,sans-serif;text-transform:uppercase;letter-spacing:1px;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:4px;position:relative;overflow:hidden}
                .zc-toggle-btn:hover{border-color:var(--bhover);color:var(--text);background:#0a0a0a}
                .zc-toggle-btn:active{transform:scale(.97)}
                .zc-toggle-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(0,170,255,.05);box-shadow:0 0 12px var(--glow),inset 0 0 20px var(--glow2)}
                .zc-toggle-btn.active::before{content:'';position:absolute;top:-1px;left:20%;right:20%;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.5}
                .zc-toggle-btn svg{width:10px;height:10px}
                .zc-correlation-bar{display:grid;grid-template-columns:80px 1fr 40px;align-items:center;gap:6px;padding:6px 0;margin-top:4px;border-top:1px solid var(--bord)}
                .zc-corr-label{font:500 7px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase}
                .zc-corr-track{position:relative;height:6px;background:#050505;border:1px solid #141414;border-radius:3px;overflow:hidden}
                .zc-corr-fill{position:absolute;height:100%;top:0;border-radius:3px;background:linear-gradient(90deg,#ff3300,#ffcc00,#00aaff);transition:left .12s ease,width .12s ease;box-shadow:0 0 8px rgba(0,170,255,.2)}
                .zc-corr-num{font:600 9px/1 JetBrains Mono,monospace;color:var(--text);text-align:right;transition:color .2s}
                .zc-eq-table{width:100%}
                .zc-eq-thead{display:grid;grid-template-columns:24px 1fr 52px 48px 40px 20px;gap:2px;padding:3px 3px;border-bottom:1px solid var(--bord)}
                .zc-eq-col{font:500 6px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
                .zc-eq-rows{display:flex;flex-direction:column;gap:2px;padding:2px 0;max-height:160px;overflow-y:auto}
                .zc-eq-rows::-webkit-scrollbar{width:3px}
                .zc-eq-rows::-webkit-scrollbar-thumb{background:var(--bord);border-radius:2px}
                .zc-eq-row{display:grid;grid-template-columns:24px 1fr 52px 48px 40px 20px;gap:2px;align-items:center;padding:3px 3px;border-radius:4px;transition:background .15s,box-shadow .15s}
                .zc-eq-row:hover{background:rgba(255,255,255,.015)}
                .zc-eq-row:has(.zc-eq-cb:checked){background:rgba(0,170,255,.015)}
                .zc-eq-cb{width:12px;height:12px;accent-color:var(--accent);cursor:pointer;border-radius:3px}
                .zc-eq-cb:active{transform:scale(.85)}
                .zc-eq-sel{background:#050505;border:1px solid var(--bord);border-radius:4px;color:var(--text);font:500 7px/1 Inter,sans-serif;padding:3px 2px;cursor:pointer;outline:none;width:100%;transition:border-color .2s,box-shadow .2s;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='4'%3E%3Cpath d='M0 0l3 4 3-4' fill='%23333'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 3px center;padding-right:10px}
                .zc-eq-sel:hover{border-color:var(--bhover)}
                .zc-eq-sel:focus{border-color:var(--accent);box-shadow:0 0 6px var(--glow)}
                .zc-eq-num{background:#050505;border:1px solid var(--bord);border-radius:4px;color:var(--text);font:500 7px/1 JetBrains Mono,monospace;padding:3px 2px;width:100%;text-align:center;outline:none;-moz-appearance:textfield;transition:border-color .2s,box-shadow .2s}
                .zc-eq-num::-webkit-inner-spin-button,.zc-eq-num::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
                .zc-eq-num:hover{border-color:var(--bhover)}
                .zc-eq-num:focus{border-color:var(--accent);box-shadow:0 0 6px var(--glow)}
                .zc-eq-del{width:18px;height:18px;border-radius:4px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
                .zc-eq-del:hover{border-color:rgba(170,50,50,.3);color:#ff5555;background:rgba(255,50,50,.05)}
                .zc-eq-del:active{transform:scale(.9)}
                .zc-eq-del svg{width:7px;height:7px}
                .zc-add-filter{width:100%;padding:7px;margin-top:3px;border:1px dashed var(--bord);border-radius:5px;background:transparent;color:var(--accent);font:600 7px/1 Inter,sans-serif;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:1.5px}
                .zc-add-filter:hover{border-color:var(--accent);background:rgba(0,170,255,.045);box-shadow:0 0 15px var(--glow);border-style:solid}
                .zc-add-filter:active{transform:scale(.98)}
                .zc-warfare-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px}
                .zc-war-btn{padding:7px 4px;background:#050505;border:1px solid var(--bord);border-radius:5px;color:var(--dim);font:700 7px/1 Inter,sans-serif;text-transform:uppercase;letter-spacing:1.2px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden}
                .zc-war-btn:hover{border-color:var(--bhover);color:var(--text);background:#0a0a0a}
                .zc-war-btn:active{transform:scale(.96)}
                .zc-war-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(0,170,255,.05);box-shadow:0 0 12px var(--glow),inset 0 0 20px var(--glow2)}
                .zc-war-btn.active::before{content:'';position:absolute;top:-1px;left:20%;right:20%;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.5}
                .zc-war-beast.active{border-color:#ff3300;color:#ff3300;box-shadow:0 0 8px rgba(255,51,0,.2);background:rgba(255,51,0,.04)}
                .zc-war-talk.active{border-color:#00aaff;color:#00aaff}
                .zc-sb-upload{width:100%;padding:7px;border:1px dashed var(--bord);border-radius:5px;background:transparent;color:var(--accent);font:600 7px/1 Inter,sans-serif;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:1.5px}
                .zc-sb-upload:hover{border-color:var(--accent);background:rgba(0,170,255,.045);border-style:solid;box-shadow:0 0 12px var(--glow)}
                .zc-sb-upload:active{transform:scale(.98)}
                .zc-sb-yt-row{display:flex;gap:4px;margin-top:5px}
                .zc-sb-yt-input{flex:1;background:#050505;border:1px solid var(--bord);border-radius:5px;color:var(--text);font:500 7px/1 Inter,sans-serif;padding:6px 8px;outline:none;transition:border-color .2s,box-shadow .2s}
                .zc-sb-yt-input::placeholder{color:var(--dim)}
                .zc-sb-yt-input:focus{border-color:var(--accent);box-shadow:0 0 6px var(--glow)}
                .zc-sb-yt-input:disabled{opacity:.4}
                .zc-sb-yt-btn{width:28px;height:28px;border-radius:5px;border:1px solid var(--bord);background:transparent;color:var(--accent);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
                .zc-sb-yt-btn:hover{border-color:var(--accent);background:rgba(0,170,255,.06);box-shadow:0 0 8px var(--glow)}
                .zc-sb-yt-btn:active{transform:scale(.92)}
                .zc-sb-yt-btn svg{width:12px;height:12px}
                .zc-rec-controls{display:flex;align-items:center;gap:6px;padding:4px 0}
                .zc-rec-btn{padding:6px 10px;border-radius:5px;border:1px solid var(--bord);background:transparent;color:#ff3355;font:700 8px/1 Inter,sans-serif;cursor:pointer;display:flex;align-items:center;gap:4px;transition:all .2s;text-transform:uppercase;letter-spacing:1px}
                .zc-rec-btn:hover{border-color:#ff3355;background:rgba(255,51,85,.06);box-shadow:0 0 8px rgba(255,51,85,.2)}
                .zc-rec-btn.active{border-color:#ff3355;background:rgba(255,51,85,.1);box-shadow:0 0 12px rgba(255,51,85,.3)}
                .zc-rec-btn.active svg{animation:zc-rec-pulse 1s infinite}
                @keyframes zc-rec-pulse{0%,100%{opacity:1}50%{opacity:.3}}
                .zc-rec-btn svg{width:10px;height:10px}
                .zc-rec-status{flex:1;font:500 7px/1 Inter,sans-serif;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
                .zc-rec-time{font:600 8px/1 JetBrains Mono,monospace;color:var(--text);min-width:36px;text-align:right}
                .zc-rec-opts{display:flex;gap:10px;padding:3px 0 2px}
                .zc-rec-opt{display:flex;align-items:center;gap:4px;font:500 7px/1 Inter,sans-serif;color:var(--dim);cursor:pointer;text-transform:uppercase;letter-spacing:.5px}
                .zc-rec-opt input[type="checkbox"]{accent-color:var(--accent);width:10px;height:10px;cursor:pointer}
                .zc-rec-opt svg{width:8px;height:8px;opacity:.4}
                .zc-sb-list{display:flex;flex-direction:column;gap:3px;margin-top:5px;max-height:130px;overflow-y:auto}
                .zc-sb-list::-webkit-scrollbar{width:3px}
                .zc-sb-list::-webkit-scrollbar-thumb{background:var(--bord);border-radius:2px}
                .zc-sb-item{display:flex;align-items:center;gap:5px;padding:5px 7px;background:#050505;border:1px solid var(--bord);border-radius:5px;transition:border-color .2s,background .2s}
                .zc-sb-item:hover{border-color:var(--bhover);background:#080808}
                .zc-sb-name{font:500 7px/1 Inter,sans-serif;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                .zc-sb-name svg{width:9px;height:9px;margin-right:4px;vertical-align:middle;opacity:.4}
                .zc-sb-controls{display:flex;align-items:center;gap:4px}
                .zc-sb-play{width:22px;height:22px;border-radius:4px;border:1px solid var(--bord);background:transparent;color:var(--accent);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
                .zc-sb-play:hover{border-color:var(--accent);background:rgba(0,170,255,.06);box-shadow:0 0 8px var(--glow)}
                .zc-sb-play:active{transform:scale(.92)}
                .zc-sb-play svg{width:9px;height:9px}
                .zc-sb-vol-wrap{width:44px;flex-shrink:0}
                .zc-sb-vol{width:100%;height:3px;accent-color:var(--accent);cursor:pointer;border-radius:2px}
                .zc-sb-del{width:18px;height:18px;border-radius:3px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
                .zc-sb-del:hover{color:#ff5555;border-color:rgba(255,50,50,.2);background:rgba(255,50,50,.04)}
                .zc-sb-del svg{width:6px;height:6px}
            `;
            document.head.appendChild(s);
        }
    };

    const Icons = {
        faders: `<svg viewBox="0 0 28 20" fill="none"><rect x="1" y="2" width="3" height="16" rx="1.5" fill="currentColor" opacity="0.25"/><rect x="1" y="8" width="3" height="5" rx="1.5" fill="currentColor"/><rect x="7" y="2" width="3" height="16" rx="1.5" fill="currentColor" opacity="0.25"/><rect x="7" y="4" width="3" height="5" rx="1.5" fill="currentColor"/><rect x="13" y="2" width="3" height="16" rx="1.5" fill="currentColor" opacity="0.25"/><rect x="13" y="11" width="3" height="5" rx="1.5" fill="currentColor"/><rect x="19" y="2" width="3" height="16" rx="1.5" fill="currentColor" opacity="0.25"/><rect x="19" y="7" width="3" height="5" rx="1.5" fill="currentColor"/><rect x="25" y="2" width="3" height="16" rx="1.5" fill="currentColor" opacity="0.25"/><rect x="25" y="3" width="3" height="5" rx="1.5" fill="currentColor"/></svg>`,
        minimize: `<svg viewBox="0 0 12 12" fill="none"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
        close: `<svg viewBox="0 0 12 12" fill="none"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
        save: `<svg viewBox="0 0 14 14" fill="none"><path d="M3 1h8l2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M5 1v4h4V1" stroke="currentColor" stroke-width="1.2"/><rect x="4" y="8" width="6" height="5" rx="0.5" stroke="currentColor" stroke-width="1.2"/></svg>`,
        load: `<svg viewBox="0 0 14 14" fill="none"><path d="M12 9v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9" stroke="currentColor" stroke-width="1.2"/><path d="M7 2v7M4 6l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        preamp: `<svg viewBox="0 0 14 14" fill="none"><polygon points="2,2 2,12 12,7" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>`,
        eq: `<svg viewBox="0 0 16 14" fill="none"><rect x="1" y="2" width="2" height="10" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="1" y="6" width="2" height="3" rx="0.5" fill="currentColor"/><rect x="5" y="2" width="2" height="10" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="5" y="4" width="2" height="3" rx="0.5" fill="currentColor"/><rect x="9" y="2" width="2" height="10" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="9" y="8" width="2" height="3" rx="0.5" fill="currentColor"/><rect x="13" y="2" width="2" height="10" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="13" y="5" width="2" height="3" rx="0.5" fill="currentColor"/></svg>`,
        fx: `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
        reset: `<svg viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 1 1 1.2 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><polyline points="2.5,10.5 2.5,7 6,7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
        warfare: `<svg viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/></svg>`,
        music: `<svg viewBox="0 0 14 14" fill="none"><path d="M5 11V3l7-1.5v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="3.5" cy="11" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="10.5" cy="9.5" r="2" stroke="currentColor" stroke-width="1.2"/></svg>`,
        play: `<svg viewBox="0 0 12 12" fill="none"><path d="M4 2l6 4-6 4V2z" fill="currentColor"/></svg>`,
        stop: `<svg viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor"/></svg>`,
        stereo: `<svg viewBox="0 0 14 14" fill="none"><circle cx="4.5" cy="7" r="3" stroke="currentColor" stroke-width="1.2"/><circle cx="9.5" cy="7" r="3" stroke="currentColor" stroke-width="1.2"/><path d="M6 4l2 6" stroke="currentColor" stroke-width="1.2" opacity="0.3"/></svg>`,
        mono: `<svg viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2"/><line x1="6" y1="2" x2="6" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>`,
        swap: `<svg viewBox="0 0 12 12" fill="none"><path d="M2 4h8M8 2l2 2-2 2M10 8H2M4 6l-2 2 2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        output: `<svg viewBox="0 0 14 14" fill="none"><path d="M7 1v12M4 4l3-3 3 3M4 10l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.2" opacity="0.3"/></svg>`,
        download: `<svg viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 10v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" stroke="currentColor" stroke-width="1.2"/></svg>`,
        record: `<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="4.5" fill="#ff3355" stroke="#ff3355" stroke-width="1"/></svg>`,
        mic: `<svg viewBox="0 0 14 14" fill="none"><rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M3 6.5a4 4 0 0 0 8 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="7" y1="11" x2="7" y2="13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
        people: `<svg viewBox="0 0 14 14" fill="none"><circle cx="5" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.2"/><circle cx="10" cy="5" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M1 12a4 4 0 0 1 8 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8 11a3 3 0 0 1 5 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    };

    function createFilter(type,freq,gain,Q) { const f={id:++filterIdCounter,enabled:true,type,frequency:freq,gain,Q}; PARAMS.eqFilters.push(f); return f; }

    createFilter('Peak',60,0,0.707);
    createFilter('Peak',250,0,0.707);
    createFilter('Peak',1000,0,0.707);
    createFilter('Peak',4000,0,0.707);
    createFilter('Peak',12000,0,0.707);

    if (document.readyState==='loading') { document.addEventListener('DOMContentLoaded',()=>App.init()); }
    else { App.init(); }
})();
