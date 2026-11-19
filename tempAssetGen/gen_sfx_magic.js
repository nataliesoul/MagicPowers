const fs = require('fs');
const path = require('path');
const ENGINE = 'C:/Users/natas/.claude/plugins/cache/ls-extensions/ls-clad/1.0.0/skills/build-sfx/tools';
const audio = require(ENGINE);
const PROJECT_ASSETS_SFX = 'E:/Dev/SPECS/MagicPowers/Assets/GeneratedSFX';
fs.mkdirSync(PROJECT_ASSETS_SFX, { recursive: true });
const SR = audio.SAMPLE_RATE;
const p = audio.sfx_presets;

function mono(buf) { return buf.left ? audio.mix([buf.left, buf.right], [0.5, 0.5]) : buf; }
function addAt(out, src, tSec, gain) {
  const s = mono(src);
  audio.addInto(out, s, Math.floor(tSec * SR), gain);
}
function loopify(m, xfSec) {
  const xf = Math.floor(xfSec * SR);
  for (let i = 0; i < xf; i++) { const t = i / xf; m[i] = m[i] * t + m[m.length - xf + i] * (1 - t); }
  return new Float32Array(m.subarray(0, m.length - xf));
}
function write(name, buf) {
  audio.mix_bus.masterChain(buf, { normalize: 'peak' });
  audio.WavBuilder.write(buf, path.join(PROJECT_ASSETS_SFX, name + '.wav'));
  console.log('wrote', name);
}

// 1. FireIgnite - flame bursting to life on the palm: short whoosh + crackle snap
(() => {
  const out = new Float32Array(Math.floor(0.7 * SR));
  addAt(out, p.whoosh({ duration: 0.5, size: 0.6, direction: 'up' }), 0, 0.9);
  const crack = audio.granular.grainCloud({ source: 'white', duration: 0.35, grainSizeMs: 6, density: 160, ampJitter: 0.8, filter: { type: 'bp', freq: 3200, Q: 1.2 }, panSpread: 0.2 });
  addAt(out, crack, 0.05, 0.35);
  const low = audio.sweep(140, 70, 0.4, 'sine', 'exponential'); audio.adsrExp(low, 0.01, 0.1, 0.3, 0.25, 3);
  addAt(out, low, 0, 0.5);
  write('FireIgnite', audio.mix_bus.applyFx(out, { hpf: 70, reverb: 'smallRoom', gain: 0.9 }));
})();

// 2. FireLoop - seamless crackling fire bed (3 s)
(() => {
  const dur = 3.0;
  const bed = audio.granular.grainCloud({ source: 'brown', duration: dur, grainSizeMs: 40, density: 60, ampJitter: 0.5, filter: { type: 'lp', freq: 900, Q: 0.7 }, panSpread: 0.3 });
  const crackle = audio.granular.grainCloud({ source: 'white', duration: dur, grainSizeMs: 5, density: 28, ampJitter: 0.9, filter: { type: 'bp', freq: 2800, Q: 1.5 }, panSpread: 0.5 });
  const m = audio.mix([mono(bed), mono(crackle)], [0.7, 0.35]);
  audio.humanize.ampWobble(m, 0.5, 0.15);
  write('FireLoop', audio.mix_bus.applyFx(loopify(m, 0.15), { hpf: 60, gain: 0.8 }));
})();

// 3. ChargeRise - energy gathering in a fist: 1.6 s riser with rising tone + accelerating pulse
(() => {
  const dur = 1.6;
  const out = new Float32Array(Math.floor(dur * SR));
  addAt(out, p.riser({ duration: dur }), 0, 0.7);
  const tone = audio.sweep(110, 660, dur, 'sawtooth', 'exponential'); audio.adsrExp(tone, 0.05, 0.2, 0.9, 0.15, 2);
  for (let i = 0; i < tone.length; i++) { const t = i / SR; const f = 4 + 12 * (t / dur); tone[i] *= 0.6 + 0.4 * Math.sin(2 * Math.PI * f * t); }
  addAt(out, audio.mix_bus.applyFx(tone, { lpf: 3500, distort: 2 }), 0, 0.45);
  write('ChargeRise', audio.mix_bus.applyFx(out, { hpf: 80, reverb: 'mediumRoom', gain: 0.85 }));
})();

// 4. FireLaunch - fireball leaving the hand: big whoosh + low thump
(() => {
  const out = new Float32Array(Math.floor(0.9 * SR));
  addAt(out, p.whoosh({ duration: 0.7, size: 1.2, direction: 'by' }), 0, 1.0);
  addAt(out, p.impact({ material: 'soft', size: 0.8 }), 0.02, 0.5);
  write('FireLaunch', audio.mix_bus.applyFx(out, { hpf: 60, reverb: 'mediumRoom', gain: 0.9 }));
})();

// 5. FireImpact - fireball burst on a surface
(() => {
  const out = new Float32Array(Math.floor(1.4 * SR));
  addAt(out, p.explosion({ size: 0.9 }), 0, 0.9);
  addAt(out, p.sparkle({ duration: 0.8 }), 0.08, 0.25);
  write('FireImpact', audio.mix_bus.applyFx(out, { hpf: 50, reverb: 'largeHall', gain: 0.9 }));
})();

// 6. LightningCrackle - arcing electricity bed between palms (2 s loop)
(() => {
  const dur = 2.0;
  const buzz = audio.square(60, dur); audio.adsrExp(buzz, 0.01, 0.1, 0.9, 0.05, 2);
  for (let i = 0; i < buzz.length; i++) { const t = i / SR; buzz[i] *= 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 17 * t) * Math.sin(2 * Math.PI * 3.3 * t)); }
  const hiss = audio.granular.grainCloud({ source: 'white', duration: dur, grainSizeMs: 3, density: 220, ampJitter: 0.9, filter: { type: 'hp', freq: 4000, Q: 0.8 }, panSpread: 0.6 });
  const snaps = audio.granular.grainCloud({ source: 'white', duration: dur, grainSizeMs: 2, density: 18, ampJitter: 1.0, filter: { type: 'bp', freq: 6500, Q: 2 }, panSpread: 0.7 });
  const m = audio.mix([audio.mix_bus.applyFx(buzz, { lpf: 2500, distort: 6 }), mono(hiss), mono(snaps)], [0.35, 0.3, 0.5]);
  audio.humanize.ampWobble(m, 0.4, 0.12);
  write('LightningCrackle', audio.mix_bus.applyFx(loopify(m, 0.1), { hpf: 90, gain: 0.8 }));
})();

// 7. LightningBolt - bolt discharge: snap + zap + thunder crack
(() => {
  const out = new Float32Array(Math.floor(1.2 * SR));
  const zap = audio.sweep(5000, 300, 0.18, 'sawtooth', 'exponential'); audio.adsrExp(zap, 0.001, 0.03, 0.5, 0.12, 3);
  addAt(out, audio.mix_bus.applyFx(zap, { distort: 10, lpf: 7000 }), 0, 0.6);
  addAt(out, p.impact({ material: 'metal', size: 0.6 }), 0.0, 0.5);
  addAt(out, p.explosion({ size: 0.5 }), 0.04, 0.6);
  write('LightningBolt', audio.mix_bus.applyFx(out, { hpf: 80, reverb: 'largeHall', gain: 0.9 }));
})();

// 8. EnergyHum - violet energy sphere drone between palms (3 s loop)
(() => {
  const dur = 3.0;
  const a = audio.sine(98, dur, 0.5), b = audio.sine(98 * 1.007, dur, 0.4), c = audio.sine(196, dur, 0.2), d = audio.sine(294, dur, 0.12);
  const m = audio.mix([a, b, c, d], [0.5, 0.4, 0.3, 0.2]);
  for (let i = 0; i < m.length; i++) { const t = i / SR; m[i] *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 6.5 * t); }
  const shimmer = audio.granular.grainCloud({ source: 'pink', duration: dur, grainSizeMs: 30, density: 40, ampJitter: 0.5, filter: { type: 'bp', freq: 2200, Q: 2 }, panSpread: 0.6 });
  const mix = audio.mix([m, mono(shimmer)], [0.8, 0.2]);
  audio.humanize.ampWobble(mix, 0.3, 0.1);
  write('EnergyHum', audio.mix_bus.applyFx(loopify(mix, 0.2), { hpf: 50, lpf: 4000, chorus: true, gain: 0.7 }));
})();

// 9. EnergyLaunch - energy wave released: power-up blip + whoosh + sub
(() => {
  const out = new Float32Array(Math.floor(1.0 * SR));
  addAt(out, p.powerUp({ retro: false }), 0, 0.5);
  addAt(out, p.whoosh({ duration: 0.6, size: 1.0, direction: 'by' }), 0.05, 0.9);
  const sub = audio.sweep(90, 40, 0.5, 'sine', 'exponential'); audio.adsrExp(sub, 0.005, 0.1, 0.4, 0.3, 3);
  addAt(out, sub, 0, 0.5);
  write('EnergyLaunch', audio.mix_bus.applyFx(out, { hpf: 40, reverb: 'mediumRoom', gain: 0.9 }));
})();

// 10. EnergyImpact - soft energy burst with sparkle dust
(() => {
  const out = new Float32Array(Math.floor(1.3 * SR));
  addAt(out, p.impact({ material: 'glass', size: 0.7 }), 0, 0.6);
  addAt(out, p.magicChime(), 0.02, 0.35);
  addAt(out, p.sparkle({ duration: 0.9 }), 0.05, 0.4);
  write('EnergyImpact', audio.mix_bus.applyFx(out, { hpf: 80, reverb: 'largeHall', gain: 0.85 }));
})();

// 11. SpellSelect - selecting a power symbol
(() => { write('SpellSelect', audio.mix_bus.applyFx(p.uiBlip({ pitch: 2 }), { reverb: 'smallRoom', gain: 0.8 })); })();

// 12. SelectorOpen - the palm-up selector blooming open
(() => {
  const out = new Float32Array(Math.floor(0.8 * SR));
  addAt(out, p.uiHover({ pitch: 4 }), 0, 0.8);
  addAt(out, p.sparkle({ duration: 0.6 }), 0.0, 0.5);
  write('SelectorOpen', audio.mix_bus.applyFx(out, { hpf: 200, gain: 0.8 }));
})();
