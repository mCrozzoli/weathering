// =============================================================================
//  WEATHERING — sound
//
//  The sculpture is silent until someone touches it. A knock on a panel
//  opens a window; inside it that panel's feedback rings — through a resonator network
//  building on Alberto DeCampo's Polyharpyie x-strument ((https://2020.xcoax.org/adc/).

//  Four panels (NPTX: the four triangles the strings pull), each with a
//  piezo (in) and an exciter (out), each its own loop:
//
//    piezo k (or virtual panel k) ─▶ touch gate ─▶ CoFlo gain
//      ─▶ resonators + dry ─▶ frequency shift ─▶ safety ─▶ exciter k
//      ▲                                                                 │
//      └──────────────── through the panel (and a little through the air) ◀┘
//
//  The data does not play the sound. Each 12-hour run sends a CONTEXT (what
//  kind of hour it is, how today divides into quiet / in-between / busy
//  hours, how new today is, how open the show has become), and that shapes
//  how the feedback is allowed to behave, on every panel:
//
//    openness   → how much loop gain there is and how long a touch rings
//                 (a newly closed sculpture barely answers; it opens up)
//    kind now   → which resonator leads and the band set
//    today      → the mix of the three resonators
//    novelty    → CoFlo threshold and frequency shift: on unusual days the
//                 feedback is not allowed to settle into one tone
//    pulls (4)  → the virtual panels' modes (on the real sculpture the
//                 strings' tension itself re-tunes the panels)
//
//  CoFlo: complexity-controlled feedback gain — Kiefer, Overholt & Eldridge,
//  "Shaping the behaviour of feedback instruments with complexity-controlled
//  gain dynamics", NIME 2020. Complexity measured with CccRPC (Kiefer,
//  libcccrt; SMC 2023). If CccRPC isn't installed (tools/build_cccrpc.sh),
//  spectral flatness stands in for complexity, and the console says so.
//
//  Modes (environment variables, set by the app):
//    WX_MODE      virtual (default: no sound card, four simulated panels,
//                 heard as a stereo mix) | live (piezos in, exciters out)
//    WX_PANELS    number of panels (default 4)
//    WX_INS / WX_OUTS   live: the sound card's first input / output for panel 1
//                 (default 0 / 0: panel k on input k, output k)
//    WX_MASTER    output level (0 = silent, for tests)
//    WX_AUTOTOUCH 1 = in virtual mode, an imaginary visitor knocks now and then
//    WX_RECORD    a .wav path: record the stereo mix (tests)
//    WX_SERVER_PORT  scsynth's UDP port (the app picks a free one, so two
//                 engines never share a server)
//
//  OSC (to this sclang): /wx/context k v k v … · /wx/pose p1..p4 ·
//    /wx/touch [panel] · /wx/set key value · /wx/panic · /wx/quit
// =============================================================================

(
var env = { |k, d| var v = k.getenv; if (v.isNil or: { v.isEmpty }) { d } { v } };
~mode      = env.("WX_MODE", "virtual").asSymbol;
~n         = env.("WX_PANELS", "4").asInteger.clip(1, 8);
~in0       = env.("WX_INS", "0").asInteger.max(0);
~out0      = env.("WX_OUTS", "0").asInteger.max(0);
~master    = env.("WX_MASTER", "1").asFloat;
~autoTouch = env.("WX_AUTOTOUCH", "1") == "1";
~recPath   = env.("WX_RECORD", "");
~hasCoflo  = \CccRPC.asClass.notNil;
~srvPort   = env.("WX_SERVER_PORT", "57110").asInteger;

Server.default = s = Server(\weathering, NetAddr("127.0.0.1", ~srvPort));
// Inputs only in live mode: the laptop mic's sample rate often differs from
// the speakers', and scsynth won't start with open inputs at mismatched rates.
s.options.numInputBusChannels  = if (~mode == \live) { ~in0 + ~n } { 0 };
s.options.numOutputBusChannels = if (~mode == \live) { ~out0 + ~n } { 2 };
s.options.memSize = 65536 * 2;

s.waitForBoot {
    // with no inputs, SoundIn would read the first private bus: keep it unused
    ~guard = Bus.audio(s, 2);
    ~spk   = Bus.audio(s, ~n);    // what the exciters play, one channel per panel
    ~mic   = Bus.audio(s, ~n);    // what the piezos hear
    ~mix   = Bus.audio(s, 2);     // a stereo picture of the four (virtual mode, recording)

    // ------------------------------------------------------- a virtual panel
    // A plywood triangle with a few body modes. It hears its own exciter
    // (a block later, through the wood), a little of the others (through the
    // air) and a visitor's knock; its modes move with its string's pull.
    SynthDef(\wxPanel, { |out = 0, in = 0, others = 0, couple = 0.5, t_touch = 0, knock = 1, pull = 1, detune = 1|
        var base  = [131, 197, 263, 347, 421, 563, 709, 887] * detune;
        var freqs = base * (1 + ((pull.lag(5) - 0.5) * 0.3));
        var hit   = EnvGen.ar(Env.perc(0.0005, 0.02), t_touch);
        var kn    = HPF.ar(WhiteNoise.ar, 400) * hit * knock;
        var own   = InFeedback.ar(in, 1) * couple;
        var air   = InFeedback.ar(others, 1) * couple * 0.08;
        var body  = Klank.ar(`[freqs, [1, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3], [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35]],
                             own + air + (kn * 0.4)) * 0.005;
        // a real piezo clips at the converter (±1); so does this one
        Out.ar(out, LeakDC.ar(body + (kn * 0.3) + PinkNoise.ar(0.0003)).clip2(1));
    }).add;

    // the sum of all exciters, for the air between panels
    SynthDef(\wxAir, { |in = 0, out = 0|
        Out.ar(out, In.ar(in, ~n).sum / ~n);
    }).add;

    // ------------------------------------------------------------ live piezo
    SynthDef(\wxMic, { |out = 0, ch = 0, trimDb = 0|
        Out.ar(out, SoundIn.ar(ch) * trimDb.dbamp);
    }).add;

    // ------------------------------------------------------- one panel's loop
    SynthDef(\wxLoop, { |in = 0, out = 0, panel = 0,
        fbGain = 0.6, makeupDb = 18, hpf = 90, lpf = 6000,
        amount = 1.5, thresh = 60, attack = 0.02, release = 0.5, shift = 0,
        ring = 6, touchThresh = 0.01, touchRatio = 4,
        w0 = 0.4, w1 = 0.3, w2 = 0.3, dry = 0.35, band = 220,
        ceiling = 0.5, holdLevel = 0.15, gate = 1|

        var mic, det, fast, slow, trig, window, prev, comx, simple, cofloEnv, gain;
        var shim, ringz, tabla, comb, sig, auto, outSig;

        mic = LPF.ar(HPF.ar(In.ar(in, 1), hpf), lpf) * makeupDb.dbamp;

        // touch: a sharp rise above the level of a moment ago opens a window
        // that decays over `ring` seconds. "A moment ago" is 100 ms in the
        // past, so a knock is always compared with the quiet before it;
        // steady feedback rises slowly and can't keep re-opening its window.
        det  = HPF.ar(mic, 800);
        fast = Amplitude.kr(det, 0.002, 0.05);
        slow = Amplitude.kr(DelayN.ar(det, 0.1, 0.1), 0.4, 2.0);
        // refractory: a new touch opens a window only once the last one has
        // closed AND the panel has gone quiet — so the loop's own swells
        // can never re-open it
        prev = LocalIn.kr(2);                         // [window, output level]
        trig = Trig1.kr((fast > (slow * touchRatio)) * (fast > touchThresh)
                        * (prev[0] < 0.12) * (prev[1] < 0.005), 0.3);
        window = EnvGen.kr(Env.perc(0.03, ring, 1, -3), trig);

        // CoFlo: low complexity (a howl ≈ a sine) → gain down
        comx = if (~hasCoflo) {
            CccRPC.ar(mic, 10, 3, 0.5, 10, 900, 0.5, 2000)
        } {
            // stand-in: spectral flatness, scaled to CccRPC's rough range
            K2A.ar(SpecFlatness.kr(FFT(LocalBuf(1024), mic)) * 2000)
        };
        simple   = 1 - comx.min(thresh).linlin(0, thresh, 0, 1);
        cofloEnv = Amplitude.ar(simple, attack, release) * amount;
        gain     = (1 - cofloEnv).clip(0, 1);


        // fed by the panel's own piezo mics
        shim  = LFNoise2.kr([0.4, 0.53, 0.67]).range(0.55, 1.0);
        ringz = (Ringz.ar(mic * 0.04, band * [1, 3, 5], [0.9, 0.8, 0.7]) * shim).sum.tanh;
        tabla = (Ringz.ar(mic * 0.02, band * [1, 1.5133, 2.0159, 2.54867, 3.0708],
                          [2.625, 0.9, 1.2, 0.375, 0.45] * 0.6).sum * 0.33).tanh;
        comb  = RLPF.ar(CombL.ar(LeakDC.ar(mic), 0.05, 1 / band.max(25), 2.5), band * 6, 0.4).tanh * 0.5;

        sig = (mic * dry) + (ringz * w0.lag(3)) + (tabla * w1.lag(3)) + (comb * w2.lag(3));
        sig = FreqShift.ar(sig, shift.lag(2));
        sig = sig * gain * window * fbGain.lag(0.5) * EnvGen.kr(Env.asr(0.1, 1, 0.2), gate, doneAction: 2);

        // safety: a slow automatic gain holds the long-term level, then a
        // brickwall limiter. Neither can be switched off from outside.
        auto   = (holdLevel / (Amplitude.kr(sig, 2.0, 3) + 1e-4)).clip(0, 1).lag(0.5);
        outSig = Limiter.ar(LeakDC.ar(sig * auto), ceiling.clip(0.05, 0.7), 0.005);
        LocalOut.kr([window, Amplitude.kr(outSig, 0.01, 0.5)]);

        SendReply.kr(Impulse.kr(4), '/wx/meter',
            [panel, A2K.kr(comx), A2K.kr(gain), window, Amplitude.kr(outSig, 0.01, 0.3),
             RunningMax.kr(fast, Impulse.kr(4)), slow, Amplitude.kr(mic, 0.01, 0.3)]);
        Out.ar(out, outSig);
    }).add;

    // ------------------------------------------------------ to the sound card
    // live: panel k → output out0 + k; virtual: the four spread over stereo
    SynthDef(\wxOut, { |in = 0, mix = 0, amp = 1, live = 0|
        var sig = In.ar(in, ~n);
        // the stereo picture: each panel at its own place, limited as a whole
        // (recorded before the master level, so a muted test still hears it)
        var st  = Limiter.ar(Splay.ar(sig, 0.9, levelComp: false), 0.7, 0.005);
        var g   = amp.lag(0.2);
        Out.ar(mix, st);
        Out.ar(~out0, sig * g * live);          // live: one exciter per panel
        Out.ar(0, st * g * (1 - live));         // virtual: the laptop's speakers
    }).add;

    SynthDef(\wxRec, { |in = 0, buf = 0|
        DiskOut.ar(buf, In.ar(in, 2));
    }).add;

    s.sync;

    // order: sources (panels or piezos) → loops → out → recorder
    ~air = Bus.audio(s, 1);
    ~srcGroup = Group.new(s);
    ~src = ~n.collect { |k|
        if (~mode == \live) {
            Synth(\wxMic, [\out, ~mic.index + k, \ch, ~in0 + k], ~srcGroup)
        } {
            Synth(\wxPanel, [\out, ~mic.index + k, \in, ~spk.index + k, \others, ~air,
                             \detune, [1, 1.07, 0.94, 1.13].wrapAt(k)], ~srcGroup)
        }
    };
    ~loopGroup = Group.after(~srcGroup);
    ~loops = ~n.collect { |k| Synth(\wxLoop, [\in, ~mic.index + k, \out, ~spk.index + k, \panel, k], ~loopGroup) };
    ~airSyn = Synth.after(~loopGroup, \wxAir, [\in, ~spk, \out, ~air]);
    ~out  = Synth.after(~airSyn, \wxOut, [\in, ~spk, \mix, ~mix, \amp, ~master, \live, if (~mode == \live) { 1 } { 0 }]);
    if (~recPath.size > 0) {
        ~recBuf = Buffer.alloc(s, 65536, 2);
        s.sync;
        ~recBuf.write(~recPath, "wav", "int16", 0, 0, true);
        s.sync;
        ~rec = Synth.after(~out, \wxRec, [\in, ~mix, \buf, ~recBuf]);
    };
    ~setLoops = { |...args| ~loops.do { |l| l.set(*args) } };

    // --------------------------------------------------------- the context
    ~bands = [
        [180, 240, 320, 427],          // quiet hours: high, sparse
        [140, 210, 280, 350, 420],     // in between
        [90, 130, 190, 260, 380]       // busy hours: low, dense
    ];
    ~ctx = (openness: 0, kind: 1, quiet: 0.33, between: 0.34, busy: 0.33, novelty: 0);
    ~band = Array.fill(~n, 220);

    ~applyContext = {
        var c = ~ctx, lead, mix, k = c[\kind].clip(0, 2).asInteger;
        // openness: closed barely answers, open rings
        ~setLoops.(\fbGain, 0.15 + (0.85 * c[\openness].clip(0, 1)));
        ~setLoops.(\ring, 2 + (10 * c[\openness].clip(0, 1)));
        // which resonator leads: the kind of hour now; the mix: today
        lead = [0, 0, 0].put(k, 1);
        mix  = (lead * 0.5) + ([c[\quiet], c[\between], c[\busy]] * 0.5);
        ~setLoops.(\w0, mix[0], \w1, mix[1], \w2, mix[2]);
        // novelty: a restless day doesn't let the feedback settle. CoFlo's
        // threshold sits just under ordinary panel ringing (complexity ~50
        // here; noise ~200+), so only a lock onto one tone is pulled down —
        // stricter on unusual days. Calibrate on the real panels (WX_DEBUG=1).
        ~setLoops.(\thresh, 30 + (40 * c[\novelty].clip(0, 1)));
        ~setLoops.(\shift, 4 * c[\novelty].clip(0, 1));
        ~setLoops.(\release, 1.0 - (0.7 * c[\novelty].clip(0, 1)));
        // each panel its own band of the current kind, as different as possible
        ~n.do { |p|
            if (~bands[k].includes(~band[p]).not) {
                ~band[p] = ~bands[k].wrapAt(p + k);
                ~loops[p].set(\band, ~band[p]);
            };
        };
        "WX context  open %  kind %  today %/%/%  novelty %  → bands % Hz".format(
            c[\openness].round(0.01), k, c[\quiet].round(0.01), c[\between].round(0.01),
            c[\busy].round(0.01), c[\novelty].round(0.01), ~band).postln;
    };
    ~applyContext.();

    // CoFlo pulling a panel's gain down for a while = that loop locked onto
    // one tone: move its resonators to another band of the current kind
    ~lowFor = Array.fill(~n, 0);
    ~debug = "WX_DEBUG".getenv == "1";
    OSCdef(\wxMeter, { |msg|
        var p = msg[3].asInteger, comx = msg[4], gain = msg[5], window = msg[6];
        if (~debug) { "WXM % cx % gain % win % out % | fastmax % slow % mic %".format(p + 1, comx.round(0.1), gain.round(0.01), window.round(0.01), msg[7].round(0.0001), msg[8].round(0.0001), msg[9].round(0.0001), msg[10].round(0.0001)).postln };
        if (p < ~n) {
            if ((gain < 0.4) and: { window > 0.1 }) { ~lowFor[p] = ~lowFor[p] + 1 } { ~lowFor[p] = 0 };
            if (~lowFor[p] >= 8) {
                var k = ~ctx[\kind].clip(0, 2).asInteger;
                var other = ~bands[k].reject { |b| b == ~band[p] };
                ~band[p] = other.choose; ~loops[p].set(\band, ~band[p]); ~lowFor[p] = 0;
                "WX panel % locked (complexity %) → band % Hz".format(p + 1, comx.round(1), ~band[p]).postln;
            };
        };
    }, '/wx/meter');

    OSCdef(\wxContext, { |msg|
        msg[1..].clump(2).do { |kv| if (kv.size == 2) { ~ctx[kv[0].asSymbol] = kv[1].asFloat } };
        ~applyContext.();
    }, '/wx/context');

    // the strings' pulls (1 = closed): in virtual mode they re-tune the panels
    OSCdef(\wxPose, { |msg|
        var p = msg[1..].collect(_.asFloat);
        if (~mode == \virtual) { ~n.do { |k| ~src[k].set(\pull, p.wrapAt(k)) } };
    }, '/wx/pose');

    ~touch = { |k|
        k = (k ?? { ~n.rand }).asInteger.clip(0, ~n - 1);
        if (~mode == \virtual) { ~src[k].set(\t_touch, 1) };
        "WX touch panel %".format(k + 1).postln;
    };
    OSCdef(\wxTouch, { |msg| ~touch.(msg[1]) }, '/wx/touch');

    OSCdef(\wxSet, { |msg|
        var key = msg[1].asSymbol, val = msg[2].asFloat;
        if ([\fbGain, \makeupDb, \amount, \thresh, \attack, \release, \shift, \ring,
             \touchThresh, \touchRatio, \dry, \band, \ceiling, \holdLevel].includes(key)) {
            ~setLoops.(key, val); "WX set % %".format(key, val).postln;
        } {
            if (key == \couple and: { ~mode == \virtual }) { ~src.do { |x| x.set(\couple, val) } };
            if (key == \trimDb and: { ~mode == \live }) { ~src.do { |x| x.set(\trimDb, val) } };
            if (key == \master) { ~out.set(\amp, val.clip(0, 1)) };
        };
    }, '/wx/set');

    ~panicUntil = 0;
    OSCdef(\wxPanic, {
        ~out.set(\amp, 0); ~setLoops.(\fbGain, 0);
        "WX PANIC: silent for 10 s".postln;
        SystemClock.sched(10, { ~out.set(\amp, ~master); ~applyContext.(); nil });
    }, '/wx/panic');

    OSCdef(\wxQuit, {
        "WX quitting".postln;
        fork {
            ~rec !? { ~rec.free; s.sync; ~recBuf.close; s.sync; ~recBuf.free };
            s.quit; 0.5.wait; 0.exit;
        };
    }, '/wx/quit');

    // an imaginary visitor, so the virtual sculpture is heard now and then
    if (~mode == \virtual and: { ~autoTouch }) {
        ~visitor = Routine { loop { rrand(20.0, 50.0).wait; ~touch.(nil) } }.play;
    };

    "WX panels: % (%)".format(~n, if (~mode == \live) { "inputs %–%, outputs %–%".format(~in0 + 1, ~in0 + ~n, ~out0 + 1, ~out0 + ~n) } { "virtual, stereo mix" }).postln;
    "WX CoFlo: %".format(if (~hasCoflo) { "CccRPC (complexity)" } { "spectral flatness stand-in (CccRPC not installed)" }).postln;
    "WEATHERING SOUND READY mode % port %".format(~mode, NetAddr.langPort).postln;
};
)
