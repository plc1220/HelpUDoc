// Explicit cover compositions, reviewed against each shipped design.md/preview.md.
// Color names and typography roles are resolved from the source, never mood guesses.
export const covers = {
  '8-bit-orbit': ['dark-void', 'neon-cyan', 'pixel-hero', 'arcade'],
  'biennale-yellow': ['paper', 'ink', 'display', 'solar'],
  'block-frame': ['offwhite', 'black', 'heading-xl', 'blocks'],
  'blue-professional': ['bg', 'text', 'h1', 'consulting'],
  'bold-poster': ['bg', 'red', 'hero-title-red', 'poster'],
  broadside: ['fire-orange', 'ink-black', 'display', 'broadside'],
  capsule: ['cream', 'ink', 'display', 'capsule'],
  cartesian: ['bg-primary', 'text-primary', 'display', 'cartesian'],
  'cobalt-grid': ['paper', 'ink', 'display-hero', 'cobalt'],
  coral: ['coral', 'black', 'hero-title', 'coral'],
  'creative-mode': ['cream', 'ink', 'display-hero', 'creative'],
  'daisy-days': ['cream', 'text-dark', 'display', 'daisy'],
  'editorial-forest': ['green', 'cream', 'display-hero', 'forest'],
  'editorial-tri-tone': ['pink', 'burgundy', 'display-wordmark', 'tritone'],
  'emerald-editorial': ['bg', 'ink', 'display-section', 'emerald'],
  grove: ['bg', 'fg', 'display', 'grove'],
  'long-table': ['paper', 'ink', 'display-cover', 'longtable'],
  mat: ['bg-dark', 'ink-cream', 'display', 'mat'],
  monochrome: ['cream-paper', 'ink-black', 'display', 'ledger'],
  'neo-grid-bold': ['bg', 'ink', 'display', 'neogrid'],
  'peoples-platform': ['paper', 'blue', 'display-hero', 'platform'],
  'pin-and-paper': ['paper', 'ink', 'display-mega', 'pin'],
  'pink-script': ['ink-deep', 'pink', 'script-huge', 'pink'],
  playful: ['bg', 'text', 'display-hero', 'playful'],
  'raw-grid': ['white', 'black', 'display', 'raw'],
  'retro-windows': ['bg-gray', 'black', 'text-xl', 'windows'],
  'retro-zine': ['bg', 'black', 'display-cover', 'zine'],
  'sakura-chroma': ['paper', 'ink', 'disp-hero', 'sakura'],
  scatterbrain: ['cream', 'ink', 'display-hero', 'notes'],
  signal: ['navy', 'cream', 'display', 'signal'],
  'soft-editorial': ['paper', 'ink', 'display', 'soft'],
  'stencil-tablet': ['bone', 'ink', 'cover-hero', 'stencil'],
  studio: ['near-black', 'acid-yellow', 'display', 'studio'],
  vellum: ['navy', 'yellow', 'display', 'vellum'],
};

export const coverCSS = `
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
.stage{width:1920px;height:1080px;position:relative;isolation:isolate;background:var(--paper);color:var(--ink);padding:96px 120px;display:flex;flex-direction:column;justify-content:space-between}
header,footer{display:flex;justify-content:space-between;align-items:center;position:relative;z-index:2;font-family:var(--label);font-size:26px;font-weight:500;letter-spacing:.14em;text-transform:uppercase}
footer{border-top:2px solid currentColor;padding-top:24px;font-size:24px}
main{position:relative;z-index:1}h1{font-family:var(--display);font-size:var(--size,200px);font-weight:var(--weight);font-style:var(--slant);line-height:var(--leading);letter-spacing:var(--tracking);text-transform:var(--case);margin:0;max-width:1620px}p{font-family:var(--body);font-size:34px;font-weight:400;line-height:1.4;margin:42px 0 0;max-width:1000px}
em{font-style:inherit}.ornament{position:absolute;z-index:0;pointer-events:none}.mark{right:120px;top:80px;font:30px var(--label)}
.arcade{background-image:linear-gradient(#5edcf419 2px,transparent 2px),linear-gradient(90deg,#5edcf419 2px,transparent 2px);background-size:40px 40px}.arcade h1{font-size:180px;text-shadow:8px 8px var(--c-deep-navy),16px 16px var(--c-neon-pink)}.arcade header{color:var(--c-neon-yellow)}.arcade p,.arcade footer{color:var(--c-white)}.arcade main{border-left:8px solid var(--c-neon-yellow);padding:40px 64px}.arcade:after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(transparent 0 3px,#0002 3px 4px);pointer-events:none}
.solar{background:radial-gradient(ellipse at 70% 55%,var(--c-sun) 0,transparent 65%),var(--paper)}.solar h1{font-size:240px;font-weight:400}.solar em{font-style:italic}.solar main{padding-left:90px}
.blocks main{background:var(--c-pink);border:4px solid;box-shadow:8px 8px var(--c-black);padding:55px;transform:rotate(-2deg);width:1350px}.blocks h1{font-size:170px}.blocks .ornament{right:90px;top:240px;width:320px;height:430px;background:var(--c-blue);border:4px solid;box-shadow:8px 8px var(--c-black);transform:rotate(9deg)}.blocks header{background:var(--c-yellow);padding:24px;border:3px solid}
.consulting header{color:var(--c-primary)}.consulting h1{font-size:164px;max-width:1300px}.consulting main{border-left:8px solid var(--c-primary);padding-left:60px}.consulting .ornament{right:120px;bottom:250px;width:300px;height:260px;border:1.5px solid var(--c-border);border-radius:14px;background:var(--c-card-bg)}.consulting footer{color:var(--c-primary)}
.poster h1{font-size:230px;transform:rotate(-4deg);text-shadow:6px 6px var(--c-light)}.poster p{color:var(--c-dark)}.poster header,.poster footer{color:var(--c-dark);border-bottom:3px solid;padding-bottom:24px}.poster main{text-align:center}
.broadside h1{font-size:258px;text-transform:lowercase;line-height:.88}.broadside footer{border-width:1px}.broadside header{border-bottom:1px solid;padding-bottom:22px}
.capsule main{border:2px solid var(--c-outline);border-radius:9999px;background:var(--c-lavender);padding:65px 160px;text-align:center;box-shadow:12px 12px var(--c-shadow)}.capsule h1{font-size:170px}.capsule p{margin:32px auto 0}.capsule .ornament{width:390px;height:140px;background:var(--c-lime);border:2px solid;right:50px;top:115px;transform:rotate(18deg);border-radius:9999px}
.cartesian h1{font-size:180px;line-height:1.1}.cartesian .ornament{right:90px;top:175px;width:680px;height:680px;border:1px solid var(--c-line);border-radius:50%}.cartesian .ornament:after{content:'';position:absolute;inset:60px;border:1px dashed var(--c-line);border-radius:50%}.cartesian footer{border:0}.cartesian main{border-left:1px solid var(--c-line);padding-left:60px}
.cobalt{background-image:linear-gradient(var(--c-grid) 1px,transparent 1px),linear-gradient(90deg,var(--c-grid) 1px,transparent 1px);background-size:60px 60px}.cobalt header{border-bottom:1.5px solid;padding-bottom:28px}.cobalt h1{font-size:210px}.cobalt .ornament{width:200px;height:540px;right:90px;top:250px;background:repeating-linear-gradient(90deg,var(--ink) 0 8px,transparent 8px 16px);clip-path:polygon(60% 0,100% 0,100% 100%,0 100%,0 60%,30% 60%,30% 30%,60% 30%)}
.coral{background:linear-gradient(90deg,var(--c-coral) 70%,var(--c-cream) 70%)}.coral h1{font-size:230px;text-transform:uppercase;letter-spacing:4px}.coral .ornament{inset:0 30% 0 0;background:repeating-linear-gradient(45deg,transparent 0 15px,#0001 15px 17px)}.coral footer{background:var(--c-black);color:var(--c-cream);margin:0 -120px -96px;padding:40px 120px}.coral main{max-width:1300px}
.creative main{background:var(--c-pink);border:4px solid;padding:45px 60px;width:1400px;box-shadow:24px 24px 0 var(--c-yellow),24px 24px 0 4px var(--c-ink)}.creative h1{font-size:160px}.creative header{border-bottom:4px solid;padding-bottom:25px}
.daisy main{background:var(--c-turquoise);border:3px solid;border-radius:28px;padding:60px 90px;width:1420px;box-shadow:12px 12px var(--c-text-dark)}.daisy h1{font-size:166px}.daisy .ornament{right:100px;top:190px;width:220px;height:220px;border-radius:50%;background:var(--c-butter);border:3px solid;box-shadow:0 -130px 0 -55px var(--c-soft-pink),110px -60px 0 -55px var(--c-soft-pink),110px 65px 0 -55px var(--c-soft-pink),0 130px 0 -55px var(--c-soft-pink),-110px 65px 0 -55px var(--c-soft-pink),-110px -60px 0 -55px var(--c-soft-pink)}
.forest h1{font-size:220px;font-weight:500;font-style:normal}.forest header,.forest footer{color:var(--c-pink)}.forest header span:last-child{display:grid;place-items:center;border:2px solid var(--c-pink);border-radius:50%;width:130px;height:130px;letter-spacing:.1em}
.tritone h1{font-size:210px}.tritone em{font-family:'Instrument Serif';font-style:italic;font-weight:400}.tritone header span{border:2px solid;border-radius:999px;padding:18px 32px}.tritone .ornament{background:var(--c-butter);width:560px;height:700px;right:0;top:170px;border-radius:28px 0 0 28px}
.emerald main{text-align:center;border-top:12px double;border-bottom:12px double;padding:45px 0}.emerald h1{font-size:210px;font-weight:900}.emerald p{margin:32px auto 0}
.grove h1{font-size:196px;font-weight:400}.grove em{font-style:italic;color:var(--c-accent)}.grove header{border-bottom:1px solid var(--c-border);padding-bottom:25px}.grove footer{border-color:var(--c-border);border-width:1px}.grove .ornament{right:110px;top:200px;font:650px var(--display);color:var(--c-watermark-dark)}
.longtable main{border:1.5px solid;padding:65px;text-align:center}.longtable h1{font-size:180px}.longtable p{font-style:italic;margin:30px auto 0}.longtable{background-image:radial-gradient(var(--c-ink-32) .6px,transparent .6px);background-size:4px 4px}.longtable header span:last-child{border:1.5px solid;border-radius:50%;padding:25px}.longtable footer{border-style:dashed;border-width:1.5px}
.mat{background:radial-gradient(ellipse at bottom right,var(--c-wood-glow),transparent 65%),var(--paper)}.mat h1{font-size:215px;text-transform:none}.mat header{color:var(--c-accent-orange)}.mat footer{border-width:1px;border-color:var(--c-border-on-dark)}
.ledger h1{font-size:210px;font-weight:200}.ledger header{border-bottom:1px solid var(--c-ink-graphite-light);padding-bottom:24px}.ledger footer{border-width:1px}.ledger main{padding-left:150px}.ledger p{font-weight:300}
.neogrid{padding:40px;display:grid;grid-template-columns:repeat(12,1fr);grid-template-rows:repeat(8,1fr);gap:12px}.neogrid header{grid-column:1/13;grid-row:1;background:var(--c-ink);color:var(--c-paper);padding:30px}.neogrid main{grid-column:1/10;grid-row:2/8;background:var(--c-paper);padding:70px 40px}.neogrid h1{font-size:172px}.neogrid footer{grid-column:1/13;grid-row:8;background:var(--c-paper);padding:25px;border:0}.neogrid .ornament{position:relative;grid-column:10/13;grid-row:2/8;background:var(--c-accent-lemon)}
.platform h1{font-size:190px;text-shadow:8px 8px var(--c-red),16px 16px var(--c-red-deep);line-height:1}.platform header{border-bottom:6px solid;padding-bottom:25px}.platform p{font-family:'Caveat Brush';font-size:62px;transform:rotate(-3deg)}.platform footer{border-width:6px}
.pin{background:radial-gradient(ellipse at top left,var(--c-paper-2),transparent 60%),radial-gradient(ellipse at bottom right,var(--c-paper-3),transparent 70%),var(--paper)}.pin main{background:var(--c-cream);border:1.5px solid;border-radius:4px;box-shadow:6px 6px var(--ink);padding:65px;transform:rotate(-2deg);width:1500px}.pin h1{font-size:174px}.pin p{font-family:'Caveat';font-size:56px}.pin .ornament{z-index:3;right:230px;top:180px;width:75px;height:220px;border:8px double;border-radius:70px;transform:rotate(24deg)}
.pink{background:radial-gradient(ellipse at top left,#1a1218,transparent 80%),var(--paper)}.pink:after{content:'';position:absolute;inset:36px;border:1px solid var(--c-hair-paper);pointer-events:none}.pink h1{font-size:240px;font-weight:400}.pink p,.pink footer{color:var(--c-paper-blush)}.pink main{text-align:center}.pink p{margin:35px auto 0}.pink footer{border-color:var(--c-line-pink);border-width:1px}
.playful main{border:3px solid;border-radius:45% 35% 40% 30% / 25% 30% 25% 35%;padding:90px;transform:rotate(-2deg)}.playful main:before{content:'';position:absolute;inset:8px -8px -8px 8px;border:3px solid;border-radius:inherit;z-index:-1}.playful h1{font-size:180px}.playful p{margin-top:30px}
.raw{padding:0;display:grid;grid-template-columns:3fr 1fr;grid-template-rows:130px 1fr 140px;border:3px solid}.raw header{grid-column:1/3;border-bottom:3px solid;padding:35px 60px}.raw main{grid-column:1;grid-row:2;padding:90px 60px;background:var(--c-pink);border-right:3px solid}.raw h1{font-size:175px}.raw footer{grid-column:1/3;border-top:3px solid;padding:40px 60px}.raw .ornament{grid-column:2;grid-row:2;position:relative;background:var(--c-green);font:260px var(--display);display:grid;place-items:center}
.windows{padding:24px;border:8px outset var(--c-bg-light)}.windows header{background:linear-gradient(90deg,var(--c-blue-navy),var(--c-blue-light));color:var(--c-white);padding:20px;text-transform:none;font-size:32px;letter-spacing:0}.windows main{background:var(--c-white);border:8px inset var(--c-bg-gray);padding:80px;margin:35px 0;flex:1}.windows h1{font-size:150px;font-weight:700}.windows footer{border:3px inset var(--c-bg-gray);padding:20px;text-transform:none;letter-spacing:0}.windows p{font-size:42px}
.zine h1{font-size:240px;text-transform:uppercase}.zine main{border-top:3px solid;border-bottom:3px solid;padding:40px 0}.zine em{color:var(--c-green)}.zine p{font-family:'Caveat';font-size:60px;transform:rotate(-2deg)}.zine .ornament{width:250px;height:110px;border:6px double var(--c-green);right:120px;top:120px;transform:rotate(12deg)}
.sakura h1{font-size:235px;text-transform:uppercase;max-width:1200px}.sakura .ornament{right:-140px;top:330px;width:640px;height:300px;transform:rotate(-22deg);background:linear-gradient(var(--c-red) 0 20%,var(--c-pink) 20% 40%,var(--c-orange) 40% 60%,var(--c-green) 60% 80%,var(--c-blue) 80%)}.sakura:after{content:'';position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(#3a251626 .65px,transparent .65px);background-size:4px 4px}.sakura header{border-bottom:3px solid;padding-bottom:26px}
.notes main{width:1300px;background:linear-gradient(var(--c-yellow),var(--c-yellow-deep));padding:80px;transform:rotate(-3deg);box-shadow:12px 18px 24px var(--c-shadow)}.notes main:before{content:'';position:absolute;top:-20px;left:50%;width:38px;height:38px;border-radius:50%;background:#c83b35;box-shadow:4px 7px 7px var(--c-shadow-deep)}.notes h1{font-size:165px}.notes .ornament{right:100px;top:260px;width:470px;height:480px;background:var(--c-blue);transform:rotate(8deg);box-shadow:12px 18px 24px var(--c-shadow)}
.signal h1{font-size:198px}.signal em{font-style:italic;color:var(--c-gold)}.signal header{color:var(--c-gold);border-bottom:1px solid var(--c-border-dark);padding-bottom:25px}.signal footer{border-width:1px;border-color:var(--c-gold)}.signal{background-image:linear-gradient(#ffffff05 1px,transparent 1px),linear-gradient(90deg,#ffffff05 1px,transparent 1px);background-size:80px 80px}
.soft main{background:var(--c-card-fill);border-radius:36px;padding:60px 80px;width:1480px}.soft h1{font-size:210px}.soft em{font-style:italic;font-weight:400}.soft .ornament{right:80px;top:220px;width:520px;height:640px;background:var(--c-pink);border-radius:36px;transform:rotate(5deg)}.soft footer{border-width:1px;border-color:var(--c-rule-soft)}
.stencil main{background:var(--c-orange);border-radius:26px;padding:65px;width:1320px}.stencil h1{font-size:195px}.stencil .ornament{right:100px;top:250px;width:350px;height:530px;border-radius:26px;background:var(--c-teal);color:var(--c-bone);font:260px var(--display);display:grid;place-items:center}.stencil footer{border-width:4px}
.studio h1{font-size:250px;line-height:.9;text-transform:uppercase}.studio p{font-size:32px}.studio footer{border-width:1px;border-color:var(--c-border-dark)}
.vellum main{text-align:center}.vellum h1{font-size:230px;font-style:italic;font-weight:400}.vellum p{margin:40px auto 0}.vellum header{visibility:hidden}.vellum footer{border:0;color:var(--c-teal);text-transform:none;letter-spacing:0}
header,footer{font-weight:var(--label-weight);font-style:var(--label-style)}p{font-weight:var(--body-weight);font-style:var(--body-style)}
.grain{position:absolute;inset:0;width:100%;height:100%;opacity:.06;mix-blend-mode:multiply;pointer-events:none;z-index:4}.pink .grain{mix-blend-mode:screen;opacity:.08}
`;

export function renderCover(slug, design, fontCSS = '') {
  const [paper, ink, role, layout] = covers[slug] || [];
  if (!paper || !design.colors[paper] || !design.colors[ink] || !design.typography[role]) throw new Error(`Incomplete cover specification: ${slug}`);
  const typography = design.typography;
  const display = typography[role];
  const labelRoles = { '8-bit-orbit': 'label-eyebrow', 'biennale-yellow': 'micro-label', 'blue-professional': 'h4-eyebrow',
    'cobalt-grid': 'mono-chrome', coral: 'section-label', 'creative-mode': 'mono-label', 'daisy-days': 'meta',
    'long-table': 'edition-label', 'pin-and-paper': 'label-top', 'pink-script': 'mono-label', playful: 'label-eyebrow',
    'raw-grid': 'label-text', 'retro-windows': 'body', 'retro-zine': 'label-spaced', 'sakura-chroma': 'mono',
    scatterbrain: 'label-script', 'soft-editorial': 'eyebrow', 'stencil-tablet': 'meta' };
  const label = typography[labelRoles[slug] || 'label'];
  const body = typography[slug === 'long-table' ? 'body-serif-italic' : typography.body ? 'body' : 'body-md'];
  if (!label || !body) throw new Error(`Missing explicit type role: ${slug}`);
  const declarations = Object.entries(design.colors).map(([key, value]) => `--c-${key}:${value}`).join(';');
  const vars = `${declarations};--paper:${design.colors[paper]};--ink:${design.colors[ink]};--display:${display.fontFamily};--label:${label.fontFamily};--body:${body.fontFamily};--label-weight:${label.fontWeight || 400};--body-weight:${body.fontWeight || 400};--label-style:${label.fontStyle || 'normal'};--body-style:${body.fontStyle || 'normal'};--weight:${display.fontWeight || 400};--slant:${display.fontStyle || 'normal'};--leading:${display.lineHeight || 1};--tracking:${display.letterSpacing || '0'};--case:${display.textTransform || 'none'}`;
  const extra = { tritone: 'Instrument Serif', platform: 'Caveat Brush', pin: 'Caveat', zine: 'Caveat' }[layout];
  const fonts = [display, label, body, ...(extra ? [{ fontFamily: extra, fontWeight: 400 }] : [])];
  const ornament = ['grove','raw','stencil'].includes(layout) ? '01' : '';
  const grain = ['pink','pin','zine','platform','notes'].includes(layout) ? '<svg class="grain"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" seed="17" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#grain)"/></svg>' : '';
  return { fonts, html: `<!doctype html><html><head><meta charset="utf-8"><style>${fontCSS}\n${coverCSS}</style></head><body><section class="stage ${layout}" style="${vars.replaceAll('"', '&quot;')}">${grain}<header><span>Field notes / 2026</span><span>${layout === 'windows' ? '_ &nbsp; □ &nbsp; ×' : 'FN'}</span></header><div class="ornament">${ornament}</div><main><h1>Room for<br><em>new ideas.</em></h1><p>A shared point of view.<br>Exploring what comes next, together.</p></main><footer><span>A new perspective</span><span>01 / 12</span></footer></section></body></html>` };
}
