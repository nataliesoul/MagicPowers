// One-shot generator for the Ice / Telekinesis / Portal SFX (MagicPowers phase 2).
const fs = require('fs');
const path = require('path');
const ENGINE = 'C:/Users/natas/.claude/plugins/cache/ls-extensions/ls-clad/1.0.0/skills/build-sfx/tools';
const audio = require(ENGINE);
const p = audio.sfx_presets;
const fx = audio.mix_bus.applyFx;
const SR = audio.SAMPLE_RATE;
const PROJECT_ASSETS_SFX = 'E:/Dev/SPECS/MagicPowers/Assets/GeneratedSFX';
fs.mkdirSync(PROJECT_ASSETS_SFX, { recursive: true });

function mono(buf) { return buf && buf.left ? (() => { const o = new Float32Array(buf.left.length); for (let i = 0; i < o.length; i++) o[i] = 0.5 * (buf.left[i] + buf.right[i]); return o; })() : buf; }
function layer(parts, dur) {
  const out = new Float32Array(Math.floor(dur * SR));
  for (const [buf, at, vol] of parts) audio.addInto(out, mono(buf), Math.floor(at * SR), vol);
  return out;
}
function loopable(buf, fadeSec = 0.08) { audio.fadeIn(buf, fadeSec); audio.fadeOut(buf, fadeSec); return buf; }
function write(name, buf, opts = {}) {
  audio.mix_bus.masterChain(buf, Object.assign({ normalize: 'peak', peakCeiling: 0.9 }, opts));
  const file = path.join(PROJECT_ASSETS_SFX, name + '.wav');
  audio.WavBuilder.write(buf, file);
  console.log('wrote', file);
}

// ── Ice ───────────────────────────────────────────────────────────────────────
// Shimmer loop: airy high grain cloud + faint wind, seamless-ish (2.4 s)
{
  const cloud = audio.granular.grainCloud({ source: audio.sine(3600, 0.5, 1), duration: 2.4, grainSizeMs: 30, density: 28, pitchSpread: 10, panSpread: 0.5, ampJitter: 0.7, normalize: 0.5 });
  const wind = audio.granular.windTexture(2.4, 0.25);
  const buf = layer([[cloud, 0, 0.6], [wind, 0, 0.5]], 2.4);
  write('IceShimmer', loopable(fx(buf, { hpf: 1200, reverb: 'plate', gain: 0.6 })));
}
// Sphere forms: crystalline crackle (glass micro-impacts) + rising glassy tone
{
  const cr = new Float32Array(Math.floor(1.1 * SR));
  for (let i = 0; i < 9; i++) {
    const hit = p.impact({ material: 'glass', size: 0.35 + Math.random() * 0.3 });
    audio.addInto(cr, mono(hit), Math.floor((0.05 + i * 0.1 + Math.random() * 0.05) * SR), 0.35);
  }
  const tone = audio.sweep(900, 2600, 1.0, 'sine', 'exponential');
  audio.adsrExp(tone, 0.2, 0.3, 0.5, 0.4, 3);
  const buf = layer([[cr, 0, 1], [tone, 0.05, 0.25]], 1.3);
  write('IceForm', fx(buf, { hpf: 400, reverb: 'smallRoom', gain: 0.8 }));
}
// Shards launch: sharp icy swish + glass tick cluster
{
  const sw = p.whoosh({ duration: 0.45, size: 0.5, direction: 'up' });
  const ticks = new Float32Array(Math.floor(0.5 * SR));
  for (let i = 0; i < 5; i++) audio.addInto(ticks, mono(p.impact({ material: 'glass', size: 0.3 })), Math.floor(i * 0.03 * SR), 0.4);
  const buf = layer([[sw, 0, 0.9], [ticks, 0, 0.8]], 0.9);
  write('IceShoot', fx(buf, { hpf: 600, gain: 0.85 }));
}
// Impact: glass shatter + frosty hiss tail
{
  const shatter = p.impact({ material: 'glass', size: 1.2 });
  const hiss = audio.whiteNoise(0.6, 0.5);
  audio.adsrExp(hiss, 0.01, 0.2, 0.2, 0.4, 3);
  audio.highPass2(hiss, 3000, 0.7);
  const buf = layer([[shatter, 0, 1], [hiss, 0.02, 0.35]], 1.2);
  write('IceImpact', fx(buf, { reverb: 'mediumRoom', gain: 0.9 }));
}
// Shield: rising crystalline sweep + bell ring
{
  const rise = audio.sweep(300, 1800, 0.55, 'triangle', 'exponential');
  audio.adsrExp(rise, 0.05, 0.2, 0.5, 0.3, 3);
  const ring = audio.synth_voices.bell(91, 0.8, 90, 240);
  const buf = layer([[rise, 0, 0.5], [ring, 0.3, 0.6]], 1.4);
  write('IceShield', fx(buf, { hpf: 300, chorus: { voices: 3, mix: 0.3 }, reverb: 'plate', gain: 0.75 }));
}

// ── Telekinesis ───────────────────────────────────────────────────────────────
// Grab: soft reverse-whoosh "whoom" + low tonal bloom
{
  const sw = p.whoosh({ duration: 0.5, size: 1.6, direction: 'up' });
  const bloom = audio.osc_models.fmOperator(140, 0.7, 2, 3, (t) => Math.exp(-4 * t));
  audio.adsrExp(bloom, 0.08, 0.2, 0.4, 0.4, 3);
  const buf = layer([[sw, 0, 0.8], [bloom, 0.05, 0.6]], 1.0);
  write('TeleGrab', fx(buf, { lpf: 5000, reverb: 'mediumRoom', gain: 0.8 }));
}
// Hold hum loop: detuned low drone with slow shimmer (2.5 s)
{
  const drone = audio.osc_models.detunedStack(110, 2.5, { voices: 5, detuneCents: 9 });
  const shimmer = audio.granular.grainCloud({ source: audio.sine(1760, 0.5, 1), duration: 2.5, grainSizeMs: 40, density: 10, pitchSpread: 4, panSpread: 0.4, ampJitter: 0.8, normalize: 0.3 });
  const buf = layer([[drone, 0, 0.7], [shimmer, 0, 0.35]], 2.5);
  write('TeleHum', loopable(fx(buf, { lpf: 2500, hpf: 60, chorus: { voices: 2, mix: 0.3 }, gain: 0.6 }), 0.12));
}
// Throw: fast doppler whoosh
{
  const sw = p.whoosh({ duration: 0.6, size: 1.1, direction: 'by' });
  write('TeleThrow', fx(mono(sw), { gain: 0.9 }));
}
// Land: stone thud + a small glassy tick (crystal bounce)
{
  const thud = p.impact({ material: 'stone', size: 0.9 });
  const tick = p.impact({ material: 'glass', size: 0.4 });
  const buf = layer([[thud, 0, 1], [tick, 0.01, 0.35]], 1.0);
  write('TeleLand', fx(buf, { reverb: 'smallRoom', gain: 0.9 }));
}

// ── Portal ────────────────────────────────────────────────────────────────────
// Open: riser into a magic chime burst + deep boom
{
  const rise = p.riser({ duration: 0.9 });
  const chime = p.magicChime();
  const boom = p.explosion({ size: 0.6 });
  const buf = layer([[rise, 0, 0.7], [chime, 0.85, 0.9], [boom, 0.9, 0.5]], 2.8);
  write('PortalOpen', fx(buf, { reverb: 'largeHall', gain: 0.85 }));
}
// Hum loop: slow pulsing otherworldly pad (3 s)
{
  const pad = audio.synth_voices.pad(45, 6, 80, 120);
  const pad2 = audio.synth_voices.pad(52, 6, 70, 120);
  const whisper = audio.granular.windTexture(3.0, 0.35);
  const len = Math.floor(3.0 * SR);
  const buf = layer([[pad.subarray ? pad.subarray(0, len) : pad, 0, 0.6], [pad2.subarray ? pad2.subarray(0, len) : pad2, 0, 0.4], [whisper, 0, 0.3]], 3.0);
  for (let i = 0; i < buf.length; i++) buf[i] *= 0.8 + 0.2 * Math.sin((i / SR) * Math.PI * 2 * 0.66);
  write('PortalHum', loopable(fx(buf, { lpf: 3000, chorus: { voices: 3, mix: 0.4 }, gain: 0.6 }), 0.15));
}
// Close: power-down + reversed-feel swish
{
  const down = p.powerDown({ pitch: -3 });
  const sw = p.whoosh({ duration: 0.5, size: 1.3, direction: 'down' });
  const buf = layer([[down, 0, 0.8], [sw, 0.1, 0.7]], 1.4);
  write('PortalClose', fx(buf, { reverb: 'mediumRoom', gain: 0.8 }));
}
console.log('done');
