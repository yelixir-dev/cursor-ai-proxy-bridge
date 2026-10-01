/** Shared CommandCode-family materials; legacy control classes retain their behavior. */
export const dashboardTheme = String.raw`
@font-face{font-family:"Space Grotesk";src:url("https://yelixir.dev/fonts/space-grotesk.woff2") format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"DM Sans";src:url("https://yelixir.dev/fonts/dm-sans.woff2") format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"Instrument Serif";src:url("https://yelixir.dev/fonts/instrument-serif-italic.woff2") format("woff2");font-style:italic;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url("https://yelixir.dev/fonts/jetbrains-mono.woff2") format("woff2");font-weight:400 600;font-display:swap}
:root{
  --canvas:#0e0c0a;--paper:#15120f;--paper-2:#1b1714;--ink:#f1ede5;
  --secondary:#cbc2b4;--muted:#a69b8c;--rule:rgba(241,237,229,.12);--strong:rgba(241,237,229,.22);
  --accent:#e5b45b;--accent-ink:#0e0c0a;--good:#7fb8bb;--warn:#e5b45b;--bad:#d9805c;
  --glass:rgba(21,18,15,.9);--sans:"DM Sans",system-ui,sans-serif;
  --display:"Space Grotesk",system-ui,sans-serif;--serif:"Instrument Serif",Georgia,serif;
  --mono:"JetBrains Mono",ui-monospace,monospace;--radius:14px;--gutter:clamp(16px,4vw,40px);
  color-scheme:dark;
}
:root[data-theme=light]{
  --canvas:#f1ede5;--paper:#f7f4ee;--paper-2:#ebe5da;--ink:#28231f;--secondary:#5c544a;
  --muted:#6b6258;--rule:#d2cbc0;--strong:#bdb4a6;--accent:#9f4d2e;--accent-ink:#f7f4ee;
  --good:#1d6a72;--warn:#9a6a12;--bad:#9f4d2e;--glass:rgba(241,237,229,.9);color-scheme:light;
}
*{box-sizing:border-box}html{background:var(--canvas);scroll-padding-top:120px}
body{margin:0;min-height:100dvh;background:var(--canvas);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}a{color:inherit;text-underline-offset:4px}
button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:8px 16px;border:1px solid transparent;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:500;cursor:pointer;transition:transform 160ms}
button:active:not(:disabled){transform:scale(.97)}button:disabled{opacity:.5;cursor:not-allowed}
button.secondary,.family-action{background:transparent;border-color:var(--strong);color:var(--ink)}
button.secondary:hover:not(:disabled),.family-action:hover:not(:disabled){background:color-mix(in srgb,var(--ink) 7%,transparent)}
button.danger{color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
button.link{padding:4px 8px;background:transparent;color:var(--accent);min-height:32px}
input,select{width:100%;min-width:0;min-height:40px;padding:8px 12px;border:1px solid var(--strong);border-radius:6px;background:var(--paper);color:var(--ink)}
input::placeholder{color:var(--muted)}input[type=checkbox]{width:auto;min-height:0;accent-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
[hidden]{display:none!important}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.skip-link{position:fixed;top:-80px;left:16px;z-index:60;padding:12px 16px;background:var(--accent);color:var(--accent-ink);border-radius:6px}.skip-link:focus{top:12px}
.wrap{max-width:1320px;margin-inline:auto;padding-inline:var(--gutter);min-width:0}
.site-header{position:sticky;top:0;z-index:20;background:var(--glass);backdrop-filter:blur(16px);border-bottom:1px solid var(--rule)}
.header-row,.header-actions,.brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.header-row{justify-content:space-between;padding-block:16px}.brand{flex-wrap:nowrap;min-width:0}
.brand-mark{width:36px;height:36px;flex:none;border-radius:10px;background:radial-gradient(circle at 30% 28%,rgba(247,244,238,.9),transparent 34%),conic-gradient(from 200deg,#7fb8bb,#5b7fd6,#b58ad6,#e57fa8,#e5b45b,#8fb56b,#7fb8bb);box-shadow:inset 0 0 0 1px var(--strong)}
.brand-name{margin:0;font:500 18px/1.2 var(--display)}.brand-name em{font:italic 24px/1 var(--serif);color:var(--accent)}
.kicker{margin:4px 0 0;font:11px/1.3 var(--mono);letter-spacing:.08em;color:var(--muted)}
.header-actions{gap:8px}.header-actions button{font-size:12px;min-height:32px;padding:8px 12px}
.health-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--rule);border-radius:999px;font:11px/1 var(--mono)}
.dot{width:7px;height:7px;background:var(--muted);border-radius:50%}.dot.on{background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 18%,transparent)}.dot.off{background:var(--bad)}
.version{color:var(--muted)}.main{padding-block:24px 40px}
.tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:4px;margin-bottom:24px;background:var(--paper);border:1px solid var(--rule);border-radius:999px}
.tab{background:transparent;color:var(--muted);border-radius:999px;padding:8px;font-size:13px}
.tab[aria-selected=true]{background:var(--paper-2);color:var(--ink);box-shadow:inset 0 0 0 1px var(--strong)}
.tab-icon{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
.tab[aria-selected=true] .tab-icon{color:var(--accent)}.tab-panel{display:grid;gap:24px;min-width:0}
.card{min-width:0;padding:24px;border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper)}
.card h2{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 20px;font:500 18px/1.3 var(--display)}
h3{font:500 15px/1.4 var(--display);margin:0}.sub{font:12px/1.5 var(--sans);color:var(--muted);text-align:right}
.section-intro{display:flex;align-items:end;justify-content:space-between;gap:12px}.section-intro h1{margin:0;font:500 24px/1.2 var(--display)}
.section-intro p{margin:8px 0 0;color:var(--muted);font-size:13px;word-break:keep-all}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.kpi{padding:20px}.kpi-label{font:11px/1.4 var(--mono);color:var(--muted);letter-spacing:.06em}
.kpi-value{margin:12px 0 4px;font:500 30px/1.1 var(--display);font-variant-numeric:tabular-nums}
.kpi-hint{font-size:12px;color:var(--muted)}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px}
.kv{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--rule);font-size:13px;min-width:0}.kv span{color:var(--muted)}.kv b{font-weight:500;text-align:right;overflow-wrap:anywhere}
.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.empty{padding:24px;border:1px dashed var(--strong);border-radius:var(--radius);text-align:center;color:var(--muted);font-size:13px;word-break:keep-all}
.page-state{padding:12px 16px;margin-bottom:16px;border-radius:6px;background:color-mix(in srgb,var(--warn) 10%,var(--paper));color:var(--warn);font-size:13px;word-break:keep-all}
.page-state.error{background:color-mix(in srgb,var(--bad) 10%,var(--paper));color:var(--bad)}
.field,.policy-field{display:grid;gap:8px;min-width:0}.field label,.policy-label{font:12px/1.3 var(--sans);color:var(--muted)}
.add-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:24px;padding:20px;border-radius:6px;background:var(--paper-2)}
.field-wide{grid-column:span 2}.capability-field{align-content:end}.capability-field label{display:flex;align-items:center;gap:8px;min-height:40px}
.add-actions{display:flex;align-items:end}.add-actions button{width:100%}
.policy-panel{padding:20px;background:var(--paper-2);border:1px solid var(--rule);border-radius:var(--radius)}
.policy-heading{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.policy-heading p,.usage-heading p{margin:8px 0 0;color:var(--muted);font-size:13px;max-width:65ch;word-break:keep-all}
.policy-active{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--muted)}
code{font:12px/1.5 var(--mono);overflow-wrap:anywhere}.policy-active code{color:var(--accent)}
.policy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.policy-description{font-size:12px;color:var(--muted);word-break:keep-all}
.table-wrap{overflow-x:auto;max-width:100%;border:1px solid var(--rule);border-radius:6px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:12px;text-align:left;border-bottom:1px solid var(--rule);white-space:nowrap}
th{font:11px/1.4 var(--mono);color:var(--muted);background:var(--paper-2)}tbody tr:last-child td{border:0}
.weight-input{width:80px;min-height:36px}.plan-input{min-width:100px}
.locked-note,.weight-policy-note{display:block;max-width:180px;font-size:11px;color:var(--muted);white-space:normal;word-break:keep-all}
.weight-ignored,.is-ignored{color:var(--muted)}.switch{position:relative;display:inline-flex;width:38px;height:22px;flex:none}
.switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.slider{position:absolute;inset:0;border-radius:999px;background:color-mix(in srgb,var(--ink) 22%,transparent);pointer-events:none}
.slider::before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:var(--paper);border-radius:50%;transition:transform 160ms}
.switch input:checked+.slider{background:var(--accent)}.switch input:checked+.slider::before{transform:translateX(16px)}
.switch input:disabled+.slider{opacity:.45}.switch input:focus-visible+.slider{outline:2px solid var(--accent);outline-offset:4px}
.usage-section{margin-top:24px;padding-top:24px;border-top:1px solid var(--rule)}.usage-heading{display:flex;justify-content:space-between;gap:16px;margin-bottom:16px}
.usage-list{display:grid;gap:16px}.usage-card{padding:20px;background:var(--paper-2);border:1px solid var(--rule);border-radius:var(--radius)}
.usage-card.loading{opacity:.65}.usage-card-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.usage-account{display:grid;gap:4px}.usage-account code{color:var(--muted)}.usage-meta{display:flex;gap:8px;align-items:start;flex-wrap:wrap}
.usage-chip,.badge{display:inline-flex;padding:4px 8px;border:1px solid var(--strong);border-radius:999px;color:var(--muted);font-size:11px}
.usage-chip.fresh{color:var(--good)}.usage-chip.stale{color:var(--warn)}.usage-chip.unavailable{color:var(--bad)}
.usage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.usage-pool-head{display:flex;justify-content:space-between;gap:12px}.usage-pool-name{display:grid;gap:4px}.usage-pool-name strong{font-weight:500;font-size:13px}
.usage-pool-name span,.usage-detail,.usage-foot,.usage-error{font-size:12px;color:var(--muted)}
.usage-pool-value{font:500 24px/1.3 var(--display)}.usage-track{height:6px;margin:12px 0 8px;background:color-mix(in srgb,var(--ink) 10%,transparent);border-radius:999px;overflow:hidden}
.usage-bar{height:100%;background:var(--good)}.other .usage-bar{background:var(--accent)}
.usage-foot{display:flex;gap:16px;flex-wrap:wrap;margin-top:16px}.usage-error{color:var(--bad);margin-top:12px}
.model-tools{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.search{flex:1;max-width:400px;min-width:min(100%,220px)}.model-total{font:12px/1.4 var(--mono);color:var(--muted)}
.families{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
.family{min-width:0;border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper-2);overflow:hidden}
.family summary{display:flex;align-items:center;gap:8px;padding:16px;cursor:pointer;list-style:none}.family summary::-webkit-details-marker{display:none}
.family summary::after{content:"+";margin-left:auto;color:var(--accent);font-size:18px}.family[open] summary::after{content:"−"}
.family-name{font-weight:500}.family-count{color:var(--muted);font:11px/1.4 var(--mono)}
.family-dot{display:none}.family-actions{display:flex;gap:8px;padding:0 16px 12px}.family-action{min-height:32px;font-size:11px;padding:8px 12px}
.model-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid var(--rule);min-width:0}
.model-name{min-width:0}.model-name code{display:block;overflow-wrap:anywhere}.model-meta{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.model-control{display:flex;align-items:center;gap:8px;flex:none}.family.is-disabled .family-name{color:var(--muted)}
.guide{color:var(--muted);font-size:13px;word-break:keep-all;margin:0;max-width:70ch}.guide strong{color:var(--ink)}
.outcomes{display:grid;gap:20px}.outcome-head{display:flex;justify-content:space-between;font-size:13px}
.outcome-track{height:8px;border-radius:999px;background:var(--paper-2);overflow:hidden;margin-top:8px}
.outcome-fill{height:100%;background:var(--good)}.outcome-fill.error{background:var(--bad)}.outcome-fill.abort{background:var(--muted)}.outcome-fill.limited{background:var(--warn)}
.route-row{display:grid;grid-template-columns:1fr auto auto;gap:16px;padding:16px 0;border-bottom:1px solid var(--rule);font-size:13px}
.route-row:last-child{border:0}.route-row code{color:var(--accent)}.footnote{color:var(--muted);font-size:12px;margin:20px 0 0;word-break:keep-all}
.metrics-state{color:var(--muted);font-size:12px;margin:0}.metrics-state.error{color:var(--bad)}
.toast{position:fixed;left:50%;top:100px;z-index:50;max-width:calc(100% - 32px);width:max-content;padding:12px 20px;background:var(--paper-2);border:1px solid var(--strong);border-radius:999px;color:var(--ink);font-size:13px;opacity:0;pointer-events:none;transform:translate(-50%,-8px);transition:opacity 260ms,transform 260ms}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.error{color:var(--bad)}
dialog{width:min(calc(100% - 32px),440px);padding:24px;background:var(--paper);color:var(--ink);border:1px solid var(--strong);border-radius:var(--radius)}
dialog::backdrop{background:rgba(14,12,10,.7)}dialog h2{font:500 24px/1.3 var(--display);margin:0 0 12px}
dialog p{font-size:13px;color:var(--muted);word-break:keep-all}.dialog-actions{display:flex;justify-content:end;gap:8px;margin-top:16px}.auth-error{min-height:20px;color:var(--bad);font-size:12px}
.busy [data-admin-control]{pointer-events:none;opacity:.55}
@media(max-width:720px){
  .header-actions{width:100%}.health-pill{margin-right:auto}.kicker{font-size:11px;letter-spacing:0}
  .tab{flex-direction:column;gap:4px;font-size:11px;min-height:48px}.tabs{border-radius:var(--radius)}.tab{border-radius:10px}
  .main{padding-block:20px 32px}.card{padding:20px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .kpi{padding:16px}.kpi-value{font-size:24px}.pair,.status-grid,.policy-grid,.usage-grid,.families{grid-template-columns:minmax(0,1fr)}
  .add-form{grid-template-columns:minmax(0,1fr);padding:16px}.field-wide{grid-column:auto}
  .card h2{align-items:start;flex-direction:column;gap:8px}.sub{text-align:left}.section-intro{align-items:start;flex-direction:column}
  .policy-panel,.usage-card{padding:16px}.usage-heading{flex-wrap:wrap}.route-row{gap:8px}.model-control{flex-direction:column-reverse}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
