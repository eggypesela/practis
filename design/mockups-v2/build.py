#!/usr/bin/env python3
"""PRACTIS redesign mockups — one source of truth for CSS/sprite/shell.

Answers locked 2026-09-25: slick modern SaaS, blue #2563eb, collapsible left
sidebar, light only, Inter, dense, minimal filled icons.
Run: python3 build.py  ->  app.css + 4 html
"""
from pathlib import Path

OUT = Path(__file__).parent

CSS = r"""
:root{
  --bg:#f7f8fa; --surface:#fff; --surface-2:#fafbfc;
  --border:#e8eaee; --border-2:#dfe3e9;
  --t1:#0f172a; --t2:#475569; --t3:#8b95a5; --t4:#b3bac6;
  --accent:#2563eb; --accent-h:#1d4ed8; --accent-soft:#eff5ff; --accent-ring:rgba(37,99,235,.14);
  --ok:#15803d; --ok-soft:#eefaf1; --ok-line:#bbf7d0;
  --warn:#b45309; --warn-soft:#fff8ec; --warn-line:#fde68a;
  --bad:#b91c1c; --bad-soft:#fef2f2; --bad-line:#fecaca;
  --r:8px; --r-lg:10px;
  --sh:0 1px 2px rgba(15,23,42,.05); --sh-lg:0 6px 20px -6px rgba(15,23,42,.12);
  --mono:Inter,-apple-system,"Segoe UI",Roboto,sans-serif;
  --sb:236px; --sb-collapsed:60px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:Inter,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.45;
  color:var(--t1);background:var(--bg);font-feature-settings:"cv05" 1,"ss01" 1}
a{color:inherit;text-decoration:none}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.006em;
  font-feature-settings:"tnum" 1}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;
  letter-spacing:-.006em;font-feature-settings:"tnum" 1,"zero" 1}
.caps{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--t3)}
/* ---- charts ---- */
.chart{padding:4px 6px 10px}
.chart svg{width:100%;height:auto;display:block}
.chart .ax{font-size:9.5px;fill:var(--t3);font-variant-numeric:tabular-nums}
.legend{display:flex;align-items:center;gap:14px;margin-top:6px;font-size:11px;color:var(--t2)}
.legend .lg{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
.legend .lg.cpi{background:#2563eb}.legend .lg.spi{background:#22c55e}
.legend .lg.act{background:#2563eb}.legend .lg.pln{background:#94a3b8}
.legend .lgt{margin-left:auto;color:var(--t3)}
/* ---- ui states ---- */
.pd{padding:12px}
.skl{border-radius:4px;background:linear-gradient(90deg,#eef1f6 25%,#e2e7ef 37%,#eef1f6 63%);
  background-size:400% 100%;animation:shimmer 1.4s ease infinite}
.skl-l{height:14px;margin-bottom:10px}.skl-m{height:11px;margin-bottom:8px}.skl-s{height:10px;margin-bottom:7px}
.skl-table{margin-top:16px}
@keyframes shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
.empty{padding:28px 20px;text-align:center}
.empty-ic{width:44px;height:44px;margin:0 auto 12px;border-radius:10px;background:var(--surface-2);
  display:grid;place-items:center;color:var(--t3)}
.empty-ic svg{width:20px;height:20px}
.empty h3{font-size:13.5px;font-weight:620;color:var(--t1);margin-bottom:6px}
.empty p{font-size:12px;color:var(--t2);line-height:1.5;max-width:300px;margin:0 auto}
.empty-acts{display:flex;gap:8px;justify-content:center;margin-top:16px}
.errb{display:flex;gap:11px;padding:14px;border:1px solid var(--bad-line);background:var(--bad-soft);
  border-radius:8px;margin:12px}
.errb-ic{width:32px;height:32px;flex:0 0 32px;border-radius:8px;background:#fee2e2;
  display:grid;place-items:center;color:var(--bad)}
.errb-ic svg{width:16px;height:16px}
.errb-tx h3{font-size:13px;font-weight:620;color:var(--t1);margin-bottom:4px}
.errb-tx p{font-size:12px;color:var(--t2);line-height:1.5}
.errb-line{font-size:10.5px;color:var(--t3);margin-top:6px}
.errb-acts{display:flex;gap:8px;padding:0 12px 12px}
/* ---- tagging queue ---- */
.fbar{display:flex;gap:8px;align-items:center;padding:9px 13px;flex-wrap:wrap;border-bottom:1px solid var(--border)}
.fchk{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--t2);cursor:pointer}
.fchk input{width:14px;height:14px;accent-color:var(--accent);cursor:pointer}
.fbar-r{margin-left:auto;display:flex;gap:8px}
.tbl tbody tr.sel{background:var(--accent-soft)}
.tbl tbody tr.sel:hover{background:var(--accent-soft)}
.tbl td input[type="checkbox"]{width:14px;height:14px;accent-color:var(--accent);cursor:pointer;vertical-align:middle}
.tag-sel,.tag-sug{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:5px;
  font-size:11px;font-weight:550;white-space:nowrap}
.tag-sel{background:var(--accent);color:#fff}
.tag-sel b{font-size:10px}
.tag-sug{background:var(--surface-2);color:var(--t2);border:1px dashed var(--border-2)}

/* ---------- shell ---------- */
.shell{display:flex;min-height:100vh}
.sb{width:var(--sb);flex:0 0 var(--sb);background:var(--surface);border-right:1px solid var(--border);
  display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.sb.collapsed{width:var(--sb-collapsed);flex-basis:var(--sb-collapsed)}
.brand{display:flex;align-items:center;gap:9px;padding:13px 14px;border-bottom:1px solid var(--border)}
.mark{width:26px;height:26px;border-radius:7px;background:var(--accent);display:grid;place-items:center;
  color:#fff;flex:0 0 26px;box-shadow:0 2px 6px var(--accent-ring)}
.brand-txt{min-width:0}
.brand-txt b{display:block;font-size:13.5px;font-weight:650;letter-spacing:-.01em}
.brand-txt span{display:block;font-size:10px;color:var(--t3);letter-spacing:.04em;text-transform:uppercase}
.sb.collapsed .brand-txt{display:none}
.nav{flex:1;overflow-y:auto;padding:8px}
.nav .grp{padding:10px 8px 4px}
.sb.collapsed .nav .grp{display:none}
/* project context switcher — the project scopes every screen below it */
.pctx{padding:10px 8px 6px}
.pc-lbl{display:block;margin-bottom:5px}
.pc-btn{display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;
  border:1px solid var(--border);border-radius:6px;background:var(--surface-2);
  font:inherit;color:var(--t1);font-weight:600;font-size:12px;cursor:pointer;text-align:left}
.pc-btn:hover{border-color:var(--t4)}
.pc-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:0 0 7px}
.pc-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-chev{width:13px;height:13px;flex:0 0 13px;color:var(--t3)}
.sb.collapsed .pc-lbl,.sb.collapsed .pc-name,.sb.collapsed .pc-chev{display:none}
.sb.collapsed .pc-btn{justify-content:center;padding:6px}
.nav a{display:flex;align-items:center;gap:9px;height:31px;padding:0 8px;border-radius:6px;
  color:var(--t2);font-weight:500;position:relative}
.nav a:hover{background:var(--surface-2);color:var(--t1)}
.nav a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.nav a.on:before{content:"";position:absolute;left:-8px;top:6px;bottom:6px;width:2.5px;
  border-radius:0 3px 3px 0;background:var(--accent)}
.nav svg{width:16px;height:16px;flex:0 0 16px}
.nav .lbl{white-space:nowrap;overflow:hidden}
.sb.collapsed .nav .lbl{display:none}
.sb.collapsed .nav a{justify-content:center;padding:0}
.nav .pill{margin-left:auto;font-size:10px;font-weight:650;padding:1px 5px;border-radius:4px;
  background:var(--bad-soft);color:var(--bad)}
.sb.collapsed .nav .pill{display:none}
.sb-foot{border-top:1px solid var(--border);padding:9px;display:flex;align-items:center;gap:9px}
.av{width:26px;height:26px;border-radius:50%;background:var(--accent-soft);color:var(--accent);
  display:grid;place-items:center;font-size:11px;font-weight:650;flex:0 0 26px}
.sb-foot .who{min-width:0}
.sb-foot .who b{display:block;font-size:12px;font-weight:600;white-space:nowrap}
.sb-foot .who span{display:block;font-size:10.5px;color:var(--t3);white-space:nowrap}
.sb.collapsed .sb-foot .who{display:none}

.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{height:50px;flex:0 0 50px;background:var(--surface);border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:10px;padding:0 16px;position:sticky;top:0;z-index:20}
.iconbtn{width:30px;height:30px;border-radius:6px;display:grid;place-items:center;color:var(--t2);
  border:1px solid transparent;background:none;cursor:pointer}
.iconbtn:hover{background:var(--surface-2);color:var(--t1)}
.iconbtn svg{width:16px;height:16px}
.crumb{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--t3);min-width:0}
.crumb b{color:var(--t1);font-weight:600}
.search{margin-left:auto;position:relative}
.search input{width:238px;height:30px;border:1px solid var(--border-2);border-radius:7px;
  padding:0 10px 0 30px;font:inherit;font-size:12.5px;background:var(--surface-2);color:var(--t1)}
.search input::placeholder{color:var(--t3)}
.search input:focus{outline:none;background:#fff;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-ring)}
.search svg{position:absolute;left:9px;top:7px;width:15px;height:15px;color:var(--t3)}
.avatarbtn{width:28px;height:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);
  display:grid;place-items:center;font-size:11px;font-weight:650}

.wrap{padding:16px 18px 40px;max-width:1560px;width:100%}
.hd{display:flex;align-items:flex-start;gap:14px;margin-bottom:14px}
.hd h1{font-size:19px;font-weight:650;letter-spacing:-.02em}
.hd p{font-size:12.5px;color:var(--t3);margin-top:1px}
.hd .act{margin-left:auto;display:flex;gap:8px;flex:0 0 auto}

/* ---------- buttons ---------- */
.btn{height:31px;padding:0 12px;border-radius:7px;font:inherit;font-size:12.5px;font-weight:550;
  display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:1px solid var(--border-2);
  background:var(--surface);color:var(--t1);box-shadow:var(--sh);white-space:nowrap}
.btn:hover{background:var(--surface-2)}
.btn svg{width:15px;height:15px}
.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff;
  box-shadow:0 1px 2px rgba(37,99,235,.3)}
.btn.pri:hover{background:var(--accent-h);border-color:var(--accent-h)}
.btn.dgr{color:var(--bad);border-color:var(--bad-line);background:var(--bad-soft)}
.btn.sm{height:26px;padding:0 9px;font-size:12px}
.btn.sm svg{width:13px;height:13px}

/* ---------- cards ---------- */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--sh)}
.card-hd{display:flex;align-items:center;gap:10px;padding:10px 13px;border-bottom:1px solid var(--border)}
.card-hd h2{font-size:13px;font-weight:620;letter-spacing:-.01em}
.card-hd .r{margin-left:auto;font-size:12px;color:var(--accent);font-weight:550}
.grid{display:grid;gap:12px}
.k4{grid-template-columns:repeat(4,minmax(0,1fr))}
.k2{grid-template-columns:minmax(0,1.85fr) minmax(0,1fr)}
@media(max-width:1200px){.k4{grid-template-columns:repeat(2,minmax(0,1fr))}
  .k2{grid-template-columns:minmax(0,1fr)}}

.kpi{padding:12px 13px}
.kpi .lbl{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:550;color:var(--t3)}
.kpi .lbl svg{width:13px;height:13px;flex:0 0 13px;color:var(--t4)}
.kpi .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:20px;font-weight:620;
  letter-spacing:-.02em;margin-top:6px;line-height:1.15}
.kpi .v.sm{font-size:17px}
.kpi .f{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--t3);margin-top:4px}
.up{color:var(--ok);font-weight:600}.dn{color:var(--bad);font-weight:600}
.wn{color:var(--warn);font-weight:600}

/* ---------- tables ---------- */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
thead th{position:sticky;top:0;background:var(--surface-2);border-bottom:1px solid var(--border-2);
  padding:7px 10px;text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;color:var(--t3);white-space:nowrap}
thead th.r{text-align:right}
tbody td{padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:middle}
tbody td:last-child,thead th:last-child{padding-right:14px}
tbody td:first-child,thead th:first-child{padding-left:14px}
/* last column holds a chip: never let it compress below the chip */
thead th:last-child,tbody td:last-child{min-width:92px}
.chip{flex:0 0 auto}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--surface-2)}
tbody tr.tot{background:var(--surface-2);font-weight:600}
tbody tr.tot td{border-top:1px solid var(--border-2);border-bottom:0}
.tname{font-weight:550}
.sub{color:var(--t3);font-size:11.5px}
.mut{color:var(--t4)}

/* ---------- chips ---------- */
.chip{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 6px;border-radius:5px;
  font-size:10.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.chip:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 5px}
.chip.ok{background:var(--ok-soft);color:var(--ok);border:1px solid var(--ok-line)}
.chip.wn{background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn-line)}
.chip.bd{background:var(--bad-soft);color:var(--bad);border:1px solid var(--bad-line)}
.chip.nt{background:var(--surface-2);color:var(--t2);border:1px solid var(--border-2)}
.chip.bl{background:var(--accent-soft);color:var(--accent);border:1px solid #cfe0ff}
.chip.nd:before{display:none}

/* ---------- filters ---------- */
.filters{display:flex;gap:8px;align-items:center;padding:10px 13px;flex-wrap:wrap;
  border-bottom:1px solid var(--border)}
.inp{height:30px;border:1px solid var(--border-2);border-radius:7px;padding:0 10px;font:inherit;
  font-size:12.5px;color:var(--t1);background:var(--surface);min-width:120px}
.inp:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring)}
.sel{position:relative}
.sel select{appearance:none;height:30px;border:1px solid var(--border-2);border-radius:7px;
  padding:0 26px 0 10px;font:inherit;font-size:12.5px;background:var(--surface);color:var(--t1);cursor:pointer}
.sel select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring)}
.sel svg{position:absolute;right:8px;top:8px;width:14px;height:14px;color:var(--t3);pointer-events:none}
.filters .meta{margin-left:auto;font-size:12px;color:var(--t3)}
.filters .meta b{color:var(--t1);font-weight:600;font-family:var(--mono)}

/* ---------- lists / misc ---------- */
.rows{display:flex;flex-direction:column}
.row{display:flex;gap:10px;padding:9px 13px;border-bottom:1px solid var(--border);align-items:flex-start}
.row:last-child{border-bottom:0}
.row .ic{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;flex:0 0 26px}
.row .ic svg{width:14px;height:14px}
.ic.bd{background:var(--bad-soft);color:var(--bad)}
.ic.wn{background:var(--warn-soft);color:var(--warn)}
.ic.bl{background:var(--accent-soft);color:var(--accent)}
.ic.ok{background:var(--ok-soft);color:var(--ok)}
.row .tx{min-width:0;flex:1}
.row .tx .t{font-size:12.5px;font-weight:550;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.row .tx .d{font-size:11.5px;color:var(--t3);margin-top:1px}
.row .tm{font-family:var(--mono);font-size:11px;color:var(--t3);white-space:nowrap}
.bar{height:5px;border-radius:3px;background:var(--border);overflow:hidden;margin-top:7px}
.bar i{display:block;height:100%;border-radius:3px;background:var(--accent)}
.bar i.ok{background:#22c55e}.bar i.wn{background:#f59e0b}
.bar i.bd{background:repeating-linear-gradient(45deg,#ef4444,#ef4444 3px,#b91c1c 3px,#b91c1c 6px)}
.mix{display:flex;flex-direction:column;gap:7px;padding:12px 13px}
.mix .m{display:flex;align-items:center;gap:9px;font-size:12.5px}
.mix .m .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mix .m .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12px;color:var(--t2)}
.mix .m .b{flex:0 0 62px;height:5px;border-radius:3px;background:var(--border);overflow:hidden}
.mix .m .b i{display:block;height:100%;border-radius:3px;background:var(--accent)}
.grid.k3{grid-template-columns:repeat(3,minmax(0,1fr))}
.k3b{grid-template-columns:minmax(0,.82fr) minmax(0,1.5fr) minmax(0,.95fr)}
@media(max-width:1200px){.grid.k3,.k3b{grid-template-columns:minmax(0,1fr)}}
.pager{display:flex;align-items:center;gap:8px;padding:9px 13px;border-top:1px solid var(--border);
  font-size:12px;color:var(--t3)}
.pgbtn{width:26px;height:26px;border-radius:6px;border:1px solid var(--border-2);background:var(--surface);
  display:grid;place-items:center;color:var(--t2);font:inherit;font-size:12px;cursor:pointer}
.pgbtn.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.pager .sp{margin-left:auto;display:flex;gap:4px;align-items:center}
.note{margin:0 13px 13px;padding:10px 12px;border-radius:8px;background:var(--warn-soft);
  border:1px solid var(--warn-line);font-size:12px;color:#7c2d12;display:flex;gap:9px}
.note svg{width:15px;height:15px;flex:0 0 15px;margin-top:1px;color:var(--warn)}
.note b{font-weight:650}
.note.bd{background:var(--bad-soft);border-color:var(--bad-line);color:#7f1d1d}
.note.bd svg{color:var(--bad)}

/* ---------- design-system page only ---------- */
.ds{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(310px,1fr))}
.sw{height:52px;border-radius:8px;border:1px solid var(--border);display:flex;align-items:flex-end;
  padding:6px;font-family:var(--mono);font-size:10px;color:#fff}
.tok{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:7px 13px;
  border-bottom:1px solid var(--border);font-size:12.5px}
.tok:last-child{border-bottom:0}
.tok code{font-family:var(--mono);font-size:11.5px;color:var(--accent)}
.tsc{display:flex;align-items:baseline;justify-content:space-between;padding:7px 13px;
  border-bottom:1px solid var(--border)}
.tsc:last-child{border-bottom:0}
.tsc .m{font-family:var(--mono);font-size:11px;color:var(--t3)}
.pal{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px;padding:13px}
.pal figure{overflow:hidden;border-radius:7px;border:1px solid var(--border)}
.pal .c{height:44px}
.pal figcaption{padding:4px 6px;font-family:var(--mono);font-size:9.5px;color:var(--t2);
  background:var(--surface-2);border-top:1px solid var(--border)}
.rowi{display:flex;align-items:center;gap:14px;padding:8px 13px;border-bottom:1px solid var(--border);
  flex-wrap:wrap}
.rowi:last-child{border-bottom:0}
.rowi .nm{font-family:var(--mono);font-size:11px;color:var(--t3);width:110px;flex:0 0 110px}

/* ---------- responsive ---------- */
@media(max-width:900px){
  .sb{position:fixed;left:0;top:0;bottom:0;z-index:60;transform:translateX(-100%);
    transition:transform .18s ease;box-shadow:var(--sh-lg)}
  .sb.open{transform:none}
  .scrim{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:50}
  .wrap{padding:14px 12px 32px}
  .hd{flex-direction:column;gap:10px}
  .hd .act{margin-left:0;width:100%}
  .hd .act .btn{flex:1;justify-content:center}
  .search input{width:120px}
  .crumb .hide{display:none}
  .kpi .v{font-size:17px}
  .kpi .v.sm{font-size:15px}
  table{min-width:640px}
  .card .rows .row{padding:9px 11px}
}
@media(max-width:560px){
  .k4{grid-template-columns:minmax(0,1fr)}
  .search{display:none}
  .grp{display:none}
}
"""

SPRITE = """<svg style="display:none" aria-hidden="true"><defs>
<symbol id="i-grid" viewBox="0 0 24 24"><path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4.2c.5 0 .8.2 1.1.5L11 6h8.5A1.5 1.5 0 0 1 21 7.5v11A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/></symbol>
<symbol id="i-book" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm2 4v2h12V6Zm0 4v2h12v-2Zm0 4v2h8v-2Z"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm10.6 6.2-5 5-2.2-2.2-1.4 1.4 3.6 3.6 6.4-6.4Z"/></symbol>
<symbol id="i-in" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 3.5h2v6.5h3l-4 4.6L8 12h3Z"/></symbol>
<symbol id="i-out" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 16.5h2V12h3l-4-4.6L8 12h3Z"/></symbol>
<symbol id="i-tree" viewBox="0 0 24 24"><path d="M3 3h6v4H3zm0 7h6v4H3zm0 7h6v4H3zm12-7h6v4h-6zM9.2 4.6h1.8v14.8H9.2zm1.8 6.7h4v1.8h-4z"/></symbol>
<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 3l5 5h-3v6H10V8H7zM5 18h14v2H5z"/></symbol>
<symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20h16v1.6H4zM6.5 12h2.6v6H6.5zm4.6-5h2.6v11h-2.6zm4.6 3h2.6v8h-2.6z"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M5 2h14v20H5Zm3 4v2h8V6Zm0 4v2h8v-2Zm0 4v2h5v-2Z"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M10.6 2h2.8l.4 2.7c.7.2 1.4.5 2 .9l2.3-1.5 2 2-1.5 2.3c.4.6.7 1.3.9 2l2.7.4v2.8l-2.7.4c-.2.7-.5 1.4-.9 2l1.5 2.3-2 2-2.3-1.5c-.6.4-1.3.7-2 .9L13.4 22h-2.8l-.4-2.7c-.7-.2-1.4-.5-2-.9l-2.3 1.5-2-2 1.5-2.3c-.4-.6-.7-1.3-.9-2L1.8 13.2v-2.8l2.7-.4c.2-.7.5-1.4.9-2L4 5.7l2-2 2.3 1.5c.6-.4 1.3-.7 2-.9zm1.4 6.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M10.5 3a7.5 7.5 0 1 0 4.6 13.4l4.2 4.2 1.4-1.4-4.2-4.2A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z"/></symbol>
<symbol id="i-bell" viewBox="0 0 24 24"><path d="M12 2a6 6 0 0 0-6 6v3.6L4 15v1.5h16V15l-2-3.4V8a6 6 0 0 0-6-6zm0 20a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 22z"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="M12 15.4 5.6 9 7 7.6l5 5 5-5 1.4 1.4z"/></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z"/></symbol>
<symbol id="i-dl" viewBox="0 0 24 24"><path d="M11 3h2v9h3.5L12 17 7.5 12H11zM5 19h14v2H5z"/></symbol>
<symbol id="i-cart" viewBox="0 0 24 24"><path d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM3 3h3l2.6 11h10l2.4-8H6.2"/></symbol>
<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 2 1.5 21h21zM11 9h2v6h-2zm0 8h2v2h-2z"/></symbol>
<symbol id="i-badge" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm2.6 10.6-1.4 1.4-1.8-1.8-3 3-1.4-1.4 3-3L8.6 9 10 7.6l1.8 1.8 3-3 1.4 1.4-3 3zM6 15l-2 7 8-4 8 4-2-7a8 8 0 0 1-12 0Z"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-6 1.8-6 4v2h12v-2c0-2.2-2.7-4-6-4zm7-2a3 3 0 1 0 0-6v6zm1 2c-2 .1-3.5 1-4.4 2.2.8-.1 1.6.1 2.3.4 1.4.5 2.6 1.4 3.1 2.4H22v-2c0-1.8-2.2-3.2-5-3z"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5h-2v6l4.6 2.8 1-1.7-3.6-2.2z"/></symbol>
<symbol id="i-cash" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm2 3v6h14V9zm7 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></symbol>
<symbol id="i-home" viewBox="0 0 24 24"><path d="M12 3 2 11h2.5v10h6v-6h3v6h6V11H22z"/></symbol>
</defs></svg>"""

# IA decision 2026-09-26 (user chose "A"): money screens are PROJECT-SCOPED.
# Routes follow TECH-SPEC §6.1: /projects/:id/ledger, /queue, /expense-reports,
# /reconciliation, /revenue ... So the sidebar nests them under a project context
# switcher. Portfolio-wide pages are only Dashboard, Projects and Reports.
# NAV tuples: (label, icon, pill, in_project)
NAV = [
    ("Portfolio", None, None, False),
    ("Dashboard", "i-grid", None, False),
    ("Projects", "i-folder", None, False),
    ("Reports", "i-chart", None, False),
    ("Project", None, None, False),
    ("Overview", "i-home", None, True),
    ("WBS", "i-tree", None, True),
    ("CBS plan", "i-chart", None, True),
    ("Ledger", "i-book", None, True),
    ("Tagging queue", "i-check", "44", True),
    ("Cash advances", "i-cash", None, True),
    ("Expense reports", "i-file", "2", True),
    ("Reconciliation", "i-check", None, True),
    ("Revenue", "i-in", None, True),
    ("Procurement", "i-cart", None, True),
    ("Acceptance", "i-badge", None, True),
    ("Update report", "i-dl", None, True),
    ("BCR register", "i-file", None, True),
    ("Administration", None, None, False),
    ("Users & roles", "i-users", None, False),
    ("Master data", "i-gear", None, False),
    ("Jobs", "i-clock", None, False),
]

PROJECT = "Citarum Bridge"


def sidebar(active="Dashboard", collapsed=False, project=PROJECT):
    """Project-scoped nav: money screens live under the selected project."""
    parts = []
    for label, icon, pill, in_proj in NAV:
        if icon is None:
            if label == "Project" and not collapsed:
                # project context switcher sits above the project nav group
                parts.append(
                    f'<div class="pctx"><span class="pc-lbl caps">Project</span>'
                    f'<button class="pc-btn"><span class="pc-dot"></span>'
                    f'<span class="pc-name">{project}</span>'
                    f'<svg class="pc-chev"><use href="#i-chev"/></svg></button></div>'
                )
            elif label == "Project":
                parts.append('<div class="grp caps">Project</div>')
            else:
                parts.append(f'<div class="grp caps">{label}</div>')
            continue
        cls = ' class="on"' if label == active else ""
        pl = f'<span class="pill">{pill}</span>' if pill else ""
        parts.append(
            f'<a href="#" data-proj="{1 if in_proj else 0}"{cls}>'
            f'<svg><use href="#{icon}"/></svg>'
            f'<span class="lbl">{label}</span>{pl}</a>'
        )
    return f"""<aside class="sb{' collapsed' if collapsed else ''}">
  <div class="brand">
    <div class="mark"><svg width="15" height="15"><use href="#i-book"/></svg></div>
    <div class="brand-txt"><b>PRACTIS</b><span>Cost Control</span></div>
  </div>
  <nav class="nav">{''.join(parts)}</nav>
  <div class="sb-foot">
    <div class="av">RC</div>
    <div class="who"><b>Ayu Kusuma</b><span>Administrator</span></div>
  </div>
</aside>"""


def topbar(crumb, title=None):
    """Breadcrumb is project-aware: PRACTIS / <project> / <page>."""
    if crumb == "Dashboard":
        c = '<div class="crumb"><b>Portfolio</b><span class="sep">/</span><b>Dashboard</b></div>'
    else:
        c = (f'<div class="crumb"><span class="hide">{PROJECT}</span>'
             f'<span class="sep hide">/</span><b>{crumb}</b></div>')
    return f"""<header class="top">
  <button class="iconbtn"><svg><use href="#i-menu"/></svg></button>
  {c}
  <div class="search"><svg><use href="#i-search"/></svg>
    <input placeholder="Search documents…"></div>
  <button class="iconbtn"><svg><use href="#i-bell"/></svg></button>
  <div class="avatarbtn">RC</div>
</header>"""


def page(title, subtitle, body, crumb, actions="", collapsed=False):
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRACTIS — {title}</title>
<link rel="stylesheet" href="fonts-local.css">
<link rel="stylesheet" href="app.css">
</head><body>
{SPRITE}
<div class="shell">
{sidebar(crumb, collapsed)}
<main class="main">
{topbar(crumb)}
<div class="wrap">
  <div class="hd"><div><h1>{title}</h1><p>{subtitle}</p></div>{actions}</div>
{body}
</div>
</main>
</div>
</body></html>"""


def chip(kind, text):
    return f'<span class="chip {kind}">{text}</span>'


# ---------------------------------------------------------------- dashboard
DASH = f"""<div class="grid k4">
  <div class="card kpi"><div class="lbl"><svg><use href="#i-folder"/></svg>Active projects</div>
    <div class="v">5</div><div class="f"><span class="up">+1</span> this month</div></div>
  <div class="card kpi"><div class="lbl"><svg><use href="#i-chart"/></svg>Contract value</div>
    <div class="v sm">Rp 12.480.000.000</div><div class="f">across 5 projects</div></div>
  <div class="card kpi"><div class="lbl"><svg><use href="#i-book"/></svg>Cost to date</div>
    <div class="v sm">Rp 9.252.000.000</div>
    <div class="f"><span class="wn">74%</span> of contract</div></div>
  <div class="card kpi"><div class="lbl"><svg><use href="#i-in"/></svg>Receivable outstanding</div>
    <div class="v sm">Rp 1.240.000.000</div>
    <div class="f"><span class="dn">3 invoices</span> overdue &gt; 30d</div></div>
</div>

<div class="grid k2" style="margin-top:12px">
  <div class="card">
    <div class="card-hd"><h2>Projects</h2><a class="r" href="#">View all</a></div>
    <div class="tw"><table>
      <thead><tr><th>Project</th><th class="r">Contract</th><th class="r">Cost to date</th>
        <th>Progress</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td><div class="tname">Citarum Bridge</div><div class="sub">PRJ-2401 · Bridge</div></td>
          <td class="num">4.200.000.000</td><td class="num">3.150.000.000</td>
          <td><div class="bar" style="width:78px"><i class="ok" style="width:75%"></i></div>
            <div class="sub mono">75%</div></td>
          <td>{chip("ok", "ON TRACK")}</td></tr>
        <tr><td><div class="tname">Gedung Dinas PUPR</div><div class="sub">PRJ-2402 · Building</div></td>
          <td class="num">3.600.000.000</td><td class="num">2.952.000.000</td>
          <td><div class="bar" style="width:78px"><i class="wn" style="width:82%"></i></div>
            <div class="sub mono">82%</div></td>
          <td>{chip("wn", "WATCH")}</td></tr>
        <tr><td><div class="tname">Rumah Sakit Tipe C</div><div class="sub">PRJ-2403 · Building</div></td>
          <td class="num">2.880.000.000</td><td class="num">2.010.000.000</td>
          <td><div class="bar" style="width:78px"><i class="ok" style="width:70%"></i></div>
            <div class="sub mono">70%</div></td>
          <td>{chip("ok", "ON TRACK")}</td></tr>
        <tr><td><div class="tname">Irigasi Saluran Sekunder</div><div class="sub">PRJ-2404 · Irrigation</div></td>
          <td class="num">1.200.000.000</td><td class="num">450.000.000</td>
          <td><div class="bar" style="width:78px"><i class="ok" style="width:38%"></i></div>
            <div class="sub mono">38%</div></td>
          <td>{chip("ok", "ON TRACK")}</td></tr>
        <tr><td><div class="tname">Gedung Serbaguna</div><div class="sub">PRJ-2405 · Building</div></td>
          <td class="num">600.000.000</td><td class="num">690.000.000</td>
          <td><div class="bar" style="width:78px"><i class="bd" style="width:100%"></i></div>
            <div class="sub mono dn">115%</div></td>
          <td>{chip("bd", "OVER")}</td></tr>
      </tbody>
    </table></div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Needs attention</h2><span class="r">4 open</span></div>
    <div class="rows">
      <div class="row"><div class="ic bd"><svg><use href="#i-warn"/></svg></div>
        <div class="tx"><div class="t">Cement invoice unpaid <span class="chip bd">OVER</span></div>
          <div class="d">PO-9001 · Gedung Dinas PUPR · 45 days past due</div></div>
        <div class="tm">90.000.000</div></div>
      <div class="row"><div class="ic wn"><svg><use href="#i-check"/></svg></div>
        <div class="tx"><div class="t">LPB split mismatch <span class="chip wn">CHECK</span></div>
          <div class="d">LPB-003 · finance 20.000.000 vs admin 18.000.000</div></div>
        <div class="tm">2.000.000</div></div>
      <div class="row"><div class="ic bl"><svg><use href="#i-up"/></svg></div>
        <div class="tx"><div class="t">Import staged <span class="chip bl">IMPORT</span></div>
          <div class="d">ledger-mar26.xlsx · awaiting confirmation</div></div>
        <div class="tm">2.340 rows</div></div>
      <div class="row"><div class="ic wn"><svg><use href="#i-book"/></svg></div>
        <div class="tx"><div class="t">Untagged cost lines <span class="chip nt">QUEUE</span></div>
          <div class="d">No WBS/CBS tag · blocks cost reporting</div></div>
        <div class="tm">44 lines</div></div>
    </div>
    <div class="card-hd" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
      <h2 style="color:var(--t3);font-weight:600;font-size:12px">Resolved this week</h2>
      <span class="r" style="color:var(--t3)">2</span></div>
    <div class="rows">
      <div class="row"><div class="ic ok"><svg><use href="#i-in"/></svg></div>
        <div class="tx"><div class="t">Progress billing received <span class="chip ok">CLEAR</span></div>
          <div class="d">INV-0224 · milestone 4 · Rumah Sakit Tipe C</div></div>
        <div class="tm">400.000.000</div></div>
      <div class="row"><div class="ic ok"><svg><use href="#i-check"/></svg></div>
        <div class="tx"><div class="t">Retainage cleared <span class="chip ok">CLEAR</span></div>
          <div class="d">RET-0044 · 10% milestone 4 · released</div></div>
        <div class="tm">40.000.000</div></div>
    </div>
  </div>
</div>

<div class="grid k2" style="margin-top:12px">
  <div class="card">
    <div class="card-hd"><h2>CPI / SPI trend</h2><span class="r">12 months · parity = 1.0</span></div>
    <div class="chart">
      <svg viewBox="0 0 560 182" role="img" aria-label="CPI and SPI trend, 12 months">
        <!-- grid -->
        <g stroke="#e8ecf2" stroke-width="1">
          <line x1="46" y1="18" x2="540" y2="18"/>
          <line x1="46" y1="64" x2="540" y2="64"/>
          <line x1="46" y1="110" x2="540" y2="110"/>
          <line x1="46" y1="156" x2="540" y2="156"/>
        </g>
        <!-- parity line 1.0 -->
        <line x1="46" y1="64" x2="540" y2="64" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3"/>
        <text x="4" y="22" class="ax">1.10</text>
        <text x="10" y="68" class="ax">1.00</text>
        <text x="4" y="114" class="ax">0.90</text>
        <text x="4" y="160" class="ax">0.80</text>
        <!-- month labels: 12 months Nov'25..Oct'26 -->
        <g class="ax" text-anchor="middle">
          <text x="46" y="172">Nov</text><text x="87" y="172">Dec</text>
          <text x="128" y="172">Jan</text><text x="169" y="172">Feb</text>
          <text x="210" y="172">Mar</text><text x="251" y="172">Apr</text>
          <text x="292" y="172">May</text><text x="333" y="172">Jun</text>
          <text x="374" y="172">Jul</text><text x="415" y="172">Aug</text>
          <text x="456" y="172">Sep</text><text x="497" y="172">Oct</text>
        </g>
        <!-- SPI (green): 1.03 -> 0.96 -->
        <polyline fill="none" stroke="#22c55e" stroke-width="2"
          points="46,50.2 87,54.8 128,59.4 169,64.0 210,68.6 252,73.2 293,70.9 334,73.2 375,75.5 416,77.8 457,80.1 498,82.4"/>
        <circle cx="498" cy="82.4" r="3" fill="#22c55e"/>
        <!-- CPI (blue): 1.05 -> 0.88 -->
        <polyline fill="none" stroke="#2563eb" stroke-width="2"
          points="46,41.0 87,50.2 128,59.4 169,68.6 210,77.8 252,87.0 293,91.6 334,96.2 375,100.8 416,105.4 457,110.0 498,119.2"/>
        <circle cx="498" cy="119.2" r="3" fill="#2563eb"/>
      </svg>
      <div class="legend">
        <span><i class="lg cpi"></i>CPI 0.88</span>
        <span><i class="lg spi"></i>SPI 0.96</span>
        <span class="lgt">drifting — Citarum behind plan</span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Cashflow forecast</h2><span class="r">planned vs actual · cumulative</span></div>
    <div class="chart">
      <svg viewBox="0 0 560 182" role="img" aria-label="Cashflow forecast, planned vs actual">
        <g stroke="#e8ecf2" stroke-width="1">
          <line x1="46" y1="18" x2="540" y2="18"/>
          <line x1="46" y1="64" x2="540" y2="64"/>
          <line x1="46" y1="110" x2="540" y2="110"/>
          <line x1="46" y1="156" x2="540" y2="156"/>
        </g>
        <text x="4" y="22" class="ax">4.2 mld</text>
        <text x="4" y="68" class="ax">2.8</text>
        <text x="4" y="114" class="ax">1.4</text>
        <text x="4" y="160" class="ax">0</text>
        <g class="ax" text-anchor="middle">
          <text x="72" y="176">Apr</text><text x="162" y="176">May</text>
          <text x="252" y="176">Jun</text><text x="342" y="176">Jul</text>
          <text x="432" y="176">Aug</text><text x="522" y="176">Sep</text>
        </g>
        <!-- planned (dashed gray) -->
        <polyline fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 3"
          points="72,22 162,40 252,60 342,72 432,82 522,90"/>
        <!-- actual (blue) cumulative cost -->
        <polyline fill="none" stroke="#2563eb" stroke-width="2"
          points="72,46 162,60 252,80 342,104 432,124 522,138"/>
        <circle cx="522" cy="138" r="3" fill="#2563eb"/>
      </svg>
      <div class="legend">
        <span><i class="lg act"></i>Actual</span>
        <span><i class="lg pln"></i>Planned</span>
        <span class="lgt">−Rp 1.1 mld below plan</span>
      </div>
    </div>
  </div>
</div>

<div class="grid k3b" style="margin-top:12px">
  <div class="card">
    <div class="card-hd"><h2>Cost by category</h2><span class="r">Mar 2026</span></div>
    <div class="mix">
      <div class="m"><span class="n">Materials</span>
        <span class="b"><i style="width:100%"></i></span><span class="v">3.900.000.000</span></div>
      <div class="m"><span class="n">Subcontractor</span>
        <span class="b"><i style="width:73%"></i></span><span class="v">2.850.000.000</span></div>
      <div class="m"><span class="n">Direct labor</span>
        <span class="b"><i style="width:39%"></i></span><span class="v">1.520.000.000</span></div>
      <div class="m"><span class="n">Equipment rental</span>
        <span class="b"><i style="width:17%"></i></span><span class="v">650.000.000</span></div>
      <div class="m"><span class="n">Overhead</span>
        <span class="b"><i style="width:9%"></i></span><span class="v">332.000.000</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Project cash position</h2><span class="r">net</span></div>
    <div class="tw"><table>
      <thead><tr><th>Project</th><th class="r">Billed</th><th class="r">Paid</th>
        <th class="r">Outstanding</th></tr></thead>
      <tbody>
        <tr><td class="tname">Rumah Sakit Tipe C</td><td class="num">400.000.000</td>
          <td class="num">300.000.000</td><td class="num">60.000.000</td></tr>
        <tr><td class="tname">Gedung Dinas PUPR</td><td class="num">90.000.000</td>
          <td class="num">30.000.000</td><td class="num">60.000.000</td></tr>
        <tr><td class="tname">Citarum Bridge</td><td class="num">240.000.000</td>
          <td class="num mut">—</td><td class="num">240.000.000</td></tr>
        <tr class="tot"><td>Total</td><td class="num">730.000.000</td>
          <td class="num">330.000.000</td><td class="num">360.000.000</td></tr>
      </tbody>
    </table></div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Recent activity</h2><a class="r" href="#">Audit log</a></div>
    <div class="rows">
      <div class="row"><div class="ic bl"><svg><use href="#i-book"/></svg></div>
        <div class="tx"><div class="t">Ledger entry posted</div>
          <div class="d">CASHIN-0114 · 300.000.000</div></div>
        <div class="tm">09:41</div></div>
      <div class="row"><div class="ic wn"><svg><use href="#i-check"/></svg></div>
        <div class="tx"><div class="t">LPB-003 flagged</div>
          <div class="d">split mismatch · needs correction</div></div>
        <div class="tm">08:57</div></div>
      <div class="row"><div class="ic bl"><svg><use href="#i-up"/></svg></div>
        <div class="tx"><div class="t">Import staged</div>
          <div class="d">ledger-mar26.xlsx · 2.340 rows</div></div>
        <div class="tm">08:12</div></div>
      <div class="row"><div class="ic ok"><svg><use href="#i-tree"/></svg></div>
        <div class="tx"><div class="t">WBS tags applied</div>
          <div class="d">PO-0897 · steel structure</div></div>
        <div class="tm">Yst</div></div>
    </div>
  </div>
</div>"""

# ------------------------------------------------------------------- ledger
LEDGER = f"""<div class="grid k4">
  <div class="card kpi"><div class="lbl">Total debit</div><div class="v sm">Rp 8.912.000.000</div>
    <div class="f">2.340 entries</div></div>
  <div class="card kpi"><div class="lbl">Total credit</div><div class="v sm">Rp 8.912.000.000</div>
    <div class="f"><span class="up">balanced</span></div></div>
  <div class="card kpi"><div class="lbl">Cost checked</div><div class="v">2.296<span
      style="font-size:13px;color:var(--t3)"> / 2.340</span></div>
    <div class="f"><span class="up">98.1%</span> tagged to WBS/CBS</div></div>
  <div class="card kpi"><div class="lbl">Untagged queue</div><div class="v">44</div>
    <div class="f"><span class="wn">blocks cost report</span></div></div>
</div>

<div class="card" style="margin-top:12px">
  <div class="filters">
    <div class="search" style="margin:0;position:relative">
      <svg><use href="#i-search"/></svg>
      <input placeholder="Search doc no., description…"></div>
    <div class="sel"><select><option>All types</option></select><svg><use href="#i-chev"/></svg></div>
    <div class="sel"><select><option>All status</option></select><svg><use href="#i-chev"/></svg></div>
    <div class="sel"><select><option>Mar 2026</option></select><svg><use href="#i-chev"/></svg></div>
    <div class="sel"><select><option>Saved views</option></select><svg><use href="#i-chev"/></svg></div>
    <div class="meta"><b>2.340</b> rows · <b>8.912.000.000</b> total</div>
  </div>
  <div class="tw"><table>
    <thead><tr><th>Date</th><th>Document no.</th><th>Description</th><th>Type</th>
      <th class="r">Debit</th><th class="r">Credit</th><th class="pad">Cost check</th></tr></thead>
    <tbody>
      <tr><td class="mono">2026-03-20</td><td class="mono">CASHIN-0114</td>
        <td>Client progress payment — milestone 4</td><td>{chip("ok", "RECEIVABLE")}</td>
        <td class="num mut">—</td><td class="num">300.000.000</td>
        <td>{chip("ok", "CHECKED")}</td></tr>
      <tr><td class="mono">2026-03-20</td><td class="mono">PO-9001</td>
        <td>Cement supply — 400 bags</td><td>{chip("wn", "PAYABLE")}</td>
        <td class="num mut">—</td><td class="num">90.000.000</td>
        <td>{chip("wn", "UNCHECKED")}</td></tr>
      <tr><td class="mono">2026-03-18</td><td class="mono">INV-0224</td>
        <td>Progress billing invoice — milestone 4</td><td>{chip("ok", "RECEIVABLE")}</td>
        <td class="num">400.000.000</td><td class="num mut">—</td>
        <td>{chip("ok", "CHECKED")}</td></tr>
      <tr><td class="mono">2026-03-17</td><td class="mono">LPB-003</td>
        <td>Split mismatch — finance vs admin</td><td>{chip("bd", "LPB")}</td>
        <td class="num">20.000.000</td><td class="num">18.000.000</td>
        <td>{chip("wn", "UNCHECKED")}</td></tr>
      <tr><td class="mono">2026-03-15</td><td class="mono">PO-0897</td>
      <td>Subcontractor — steel structure</td><td>{chip("nt", "EXPENSE")}</td>
      <td class="num">150.000.000</td><td class="num mut">—</td>
      <td>{chip("ok", "CHECKED")}</td></tr>
      <tr><td class="mono">2026-03-14</td><td class="mono">SAL-0012</td>
      <td>Site payroll — March week 2</td><td>{chip("nt", "EXPENSE")}</td>
      <td class="num">85.000.000</td><td class="num mut">—</td>
      <td>{chip("ok", "CHECKED")}</td></tr>
      <tr><td class="mono">2026-03-12</td><td class="mono">RET-0044</td>
        <td>Retainage 10% — milestone 4</td><td>{chip("ok", "RECEIVABLE")}</td>
        <td class="num mut">—</td><td class="num">40.000.000</td>
        <td>{chip("ok", "CHECKED")}</td></tr>
      <tr><td class="mono">2026-03-10</td><td class="mono">CASHOUT-0208</td>
        <td>Payment run — PO-9001 partial</td><td>{chip("nt", "FUNDING")}</td>
        <td class="num mut">—</td><td class="num">30.000.000</td>
        <td>{chip("nt", "EXCLUDED")}</td></tr>
    </tbody>
  </table></div>
  <div class="pager">Showing <b class="mono" style="color:var(--t1)">1–8</b> of
    <b class="mono" style="color:var(--t1)">2.340</b>
    <div class="sp"><button class="pgbtn">‹</button><button class="pgbtn on">1</button>
      <button class="pgbtn">2</button><button class="pgbtn">3</button>
      <button class="pgbtn">›</button></div></div>
</div>"""

# ---------------------------------------------------------------------- lpb
LPB = f"""<div class="grid k4">
  <div class="card kpi"><div class="lbl">Expense reports</div><div class="v">6</div>
    <div class="f">this project · FY 2026</div></div>
  <div class="card kpi"><div class="lbl">Finance total</div><div class="v sm">Rp 168.500.000</div>
    <div class="f">submitted by finance</div></div>
  <div class="card kpi"><div class="lbl">Admin total</div><div class="v sm">Rp 166.500.000</div>
    <div class="f">checked by admin</div></div>
  <div class="card kpi"><div class="lbl">Mismatched</div><div class="v">1</div>
    <div class="f"><span class="dn">Rp 2.000.000</span> difference</div></div>
</div>

<div class="grid k2" style="margin-top:12px">
  <div class="card">
    <div class="filters">
      <div class="search" style="margin:0;position:relative">
        <svg><use href="#i-search"/></svg><input placeholder="Search LPB no…"></div>
      <div class="sel"><select><option>Mar 2026</option></select><svg><use href="#i-chev"/></svg></div>
      <div class="sel"><select><option>All status</option></select><svg><use href="#i-chev"/></svg></div>
      <div class="meta"><b>2</b> pending · <b>1</b> mismatched</div>
    </div>
    <div class="tw"><table>
      <thead><tr><th>Expense report</th><th>Period</th><th class="r">Finance</th>
        <th class="r">Admin</th><th class="r">Diff</th><th class="pad">Status</th></tr></thead>
      <tbody>
        <tr><td class="mono">LPB-001</td><td class="mono">2026-01</td>
          <td class="num">31.500.000</td><td class="num">31.500.000</td><td class="num mut">—</td>
          <td>{chip("ok", "RECONCILED")}</td></tr>
        <tr><td class="mono">LPB-002</td><td class="mono">2026-02</td>
          <td class="num">38.000.000</td><td class="num">38.000.000</td><td class="num mut">—</td>
          <td>{chip("ok", "RECONCILED")}</td></tr>
        <tr style="background:var(--warn-soft)"><td class="mono">LPB-003</td><td class="mono">2026-03</td>
          <td class="num">20.000.000</td><td class="num">18.000.000</td>
          <td class="num dn">2.000.000</td><td>{chip("wn", "MISMATCH")}</td></tr>
        <tr><td class="mono">LPB-004</td><td class="mono">2026-03</td>
          <td class="num">45.000.000</td><td class="num">45.000.000</td><td class="num mut">—</td>
          <td>{chip("ok", "RECONCILED")}</td></tr>
        <tr><td class="mono">LPB-005</td><td class="mono">2026-04</td>
          <td class="num">12.000.000</td><td class="num">12.000.000</td><td class="num mut">—</td>
          <td>{chip("bl", "PENDING")}</td></tr>
        <tr><td class="mono">LPB-006</td><td class="mono">2026-04</td>
          <td class="num">22.000.000</td><td class="num">22.000.000</td><td class="num mut">—</td>
          <td>{chip("bl", "PENDING")}</td></tr>
      </tbody>
    </table></div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>LPB-003 · detail</h2>
      <span class="r">Rumah Sakit Tipe C · Mar 2026</span></div>
    <div class="tw"><table>
      <thead><tr><th>Cost category</th><th class="r">Finance</th><th class="r">Admin</th>
        <th class="r">Difference</th></tr></thead>
      <tbody>
        <tr><td>Direct labor</td><td class="num">12.000.000</td><td class="num">12.000.000</td>
          <td class="num mut">—</td></tr>
        <tr><td>Equipment rental</td><td class="num">5.000.000</td><td class="num">3.000.000</td>
          <td class="num dn">2.000.000</td></tr>
        <tr><td>Subcontractor</td><td class="num">3.000.000</td><td class="num">3.000.000</td>
          <td class="num mut">—</td></tr>
        <tr class="tot"><td>Total</td><td class="num">20.000.000</td><td class="num">18.000.000</td>
          <td class="num dn">2.000.000</td></tr>
      </tbody>
    </table></div>
    <div class="note"><svg><use href="#i-warn"/></svg>
      <div><b>Equipment rental differs by Rp 2.000.000.</b> Finance recorded 5.000.000, admin
        3.000.000. A correcting ledger line is required before this LPB can be tagged to cost.</div></div>
    <div class="card-hd" style="border-top:1px solid var(--border);border-bottom:0">
      <button class="btn sm"><svg><use href="#i-dl"/></svg>Export</button>
      <button class="btn sm dgr">Flag mismatch</button>
      <button class="btn sm pri" style="margin-left:auto"><svg><use href="#i-check"/></svg>
        Tag cost &amp; reconcile</button>
    </div>
  </div>
</div>"""

# -------------------------------------------------------------- design system
def tok(name, val):
    return f'<div class="tok"><span>{name}</span><code>{val}</code></div>'


def swatch(name, hexv, dark=False):
    fg = "#fff" if dark else "#0f172a"
    return f'<figure><div class="c" style="background:{hexv};color:{fg}"></div>'\
           f'<figcaption>{name}<br>{hexv}</figcaption></figure>'


DS = f"""<div class="ds">
  <div class="card">
    <div class="card-hd"><h2>Color</h2><span class="r">one accent only</span></div>
    <div class="pal">
      {swatch("accent", "#2563eb", True)}{swatch("accent hover", "#1d4ed8", True)}
      {swatch("accent soft", "#eff5ff")}{swatch("ok", "#15803d", True)}
      {swatch("warn", "#b45309", True)}{swatch("bad", "#b91c1c", True)}
      {swatch("text 1", "#0f172a", True)}{swatch("text 3", "#8b95a5", True)}
      {swatch("border", "#e8eaee")}{swatch("surface 2", "#fafbfc")}{swatch("bg", "#f7f8fa")}
    </div>
    <div class="tok" style="border-top:1px solid var(--border)">
      <span class="sub">Money semantics fixed</span>
      <code class="mono">green in · red over/unpaid</code></div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Type</h2><span class="r">Inter · tabular numerals</span></div>
    <div class="tsc"><span style="font-size:19px;font-weight:650;letter-spacing:-.02em">Page title</span>
      <span class="m">19 / 650</span></div>
    <div class="tsc"><span style="font-size:13px;font-weight:620">Card title</span>
      <span class="m">13 / 620</span></div>
    <div class="tsc"><span style="font-size:12.5px">Body &amp; table cell</span>
      <span class="m">12.5 / 400</span></div>
    <div class="tsc"><span class="caps">Table header</span><span class="m">10.5 / 600 caps</span></div>
    <div class="tsc"><span class="num" style="font-size:20px;font-weight:620">Rp 12.480.000.000</span>
      <span class="m">mono tabular</span></div>
    <div class="tsc"><span class="mono" style="font-size:12.5px">CASHIN-0114</span>
      <span class="m">mono ids</span></div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Spacing &amp; radius</h2></div>
    {tok("4px grid · card gap", "12px")}{tok("card padding", "12–13px")}
    {tok("row height (dense)", "31px")}{tok("input / button height", "30–31px")}
    {tok("radius · control", "7px")}{tok("radius · card", "10px")}
    {tok("radius · chip", "5px")}
  </div>

  <div class="card">
    <div class="card-hd"><h2>Status chips</h2><span class="r">dot + tinted bg</span></div>
    <div class="rowi"><span class="nm">ok</span>{chip("ok", "ON TRACK")} {chip("ok", "CHECKED")}
      {chip("ok", "RECONCILED")}</div>
    <div class="rowi"><span class="nm">warn</span>{chip("wn", "WATCH")} {chip("wn", "UNCHECKED")}
      {chip("wn", "MISMATCH")}</div>
    <div class="rowi"><span class="nm">bad</span>{chip("bd", "OVER")} {chip("bd", "OVERDUE")}
      {chip("bd", "EXPENSE")}</div>
    <div class="rowi"><span class="nm">neutral / info</span>{chip("bl", "PENDING")}
      {chip("nt", "FUNDING")} {chip("nt", "EXCLUDED")}</div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Buttons</h2></div>
    <div class="rowi"><span class="nm">primary</span>
      <button class="btn pri"><svg><use href="#i-plus"/></svg>New project</button>
      <button class="btn pri sm"><svg><use href="#i-plus"/></svg>Small</button></div>
    <div class="rowi"><span class="nm">secondary</span>
      <button class="btn"><svg><use href="#i-dl"/></svg>Export</button>
      <button class="btn sm">Small</button></div>
    <div class="rowi"><span class="nm">danger</span>
      <button class="btn dgr">Flag mismatch</button>
      <button class="iconbtn"><svg><use href="#i-search"/></svg></button>
      <button class="iconbtn"><svg><use href="#i-bell"/></svg></button></div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Icons</h2><span class="r">minimal filled · 16px nav / 15px action</span></div>
    <div class="rowi" style="gap:16px">
      {''.join(f'<svg style="width:18px;height:18px;color:var(--t2)"><use href="#{i}"/></svg>' for i in
               ["i-grid","i-folder","i-book","i-check","i-in","i-out","i-tree","i-up","i-chart",
                "i-file","i-gear","i-search","i-bell","i-warn","i-dl","i-plus"])}
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Navigation</h2><span class="r">expanded · collapsed · mobile</span></div>
    <div class="rowi" style="gap:16px;align-items:stretch">
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <div style="width:210px;padding:8px;background:var(--surface)">
          <a class="nav-on" style="display:flex;align-items:center;gap:9px;height:31px;padding:0 8px;
             border-radius:6px;background:var(--accent-soft);color:var(--accent);font-weight:600">
            <svg style="width:16px;height:16px"><use href="#i-grid"/></svg>Dashboard</a>
          <a style="display:flex;align-items:center;gap:9px;height:31px;padding:0 8px;border-radius:6px;
             color:var(--t2)"><svg style="width:16px;height:16px"><use href="#i-book"/></svg>Ledger</a>
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <div style="width:56px;padding:8px;background:var(--surface)">
          <div style="height:31px;display:grid;place-items:center;border-radius:6px;
            background:var(--accent-soft);color:var(--accent)"><svg style="width:16px;height:16px">
            <use href="#i-grid"/></svg></div>
          <div style="height:31px;display:grid;place-items:center;color:var(--t2)">
            <svg style="width:16px;height:16px"><use href="#i-book"/></svg></div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--t3);max-width:230px">
        ≤900px: sidebar slides in over a scrim behind a menu button. Dense tables scroll
        horizontally; short lists restack as rows.
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
          <b style="color:var(--t1)">Scope rule.</b> Dashboard, Projects and Reports are
          portfolio-wide. Every money screen (Ledger, Tagging queue, Cash advances,
          Expense reports, Reconciliation, Revenue) belongs to the project chosen in the
          switcher, and its route carries the project id.</div>
      </div>
    </div>
  </div>
</div>"""


def write(name, html):
    (OUT / name).write_text(html)
    print("wrote", name, len(html), "bytes")


(OUT / "app.css").write_text(CSS)
print("wrote app.css", len(CSS), "bytes")

# ---------------------------------------------------------------- states page
# The three states the spec's hard cases need (design-critique finding #3):
# loading (skeleton = final structure), empty (why + next action),
# error (frozen period: specific + recovery path).
STATES = f"""<div class="grid k3" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:14px">

  <div class="card">
    <div class="card-hd"><h2>Loading</h2><span class="r">skeleton = final structure</span></div>
    <div class="pd">
      <div class="skl skl-l" style="width:42%"></div>
      <div class="skl skl-m" style="width:64%"></div>
      <div class="skl skl-s" style="width:30%"></div>
      <div class="skl-table">
        <div class="skl skl-l" style="width:100%;height:26px"></div>
        <div class="skl skl-s" style="width:92%"></div>
        <div class="skl skl-s" style="width:88%"></div>
        <div class="skl skl-s" style="width:95%"></div>
        <div class="skl skl-s" style="width:80%"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Empty</h2><span class="r">why + next action</span></div>
    <div class="empty">
      <div class="empty-ic"><svg><use href="#i-book"/></svg></div>
      <h3>No ledger entries yet</h3>
      <p>Nothing has been posted for <b>Citarum Bridge</b> this period.
        Entries appear here once Finance adds them or an import is confirmed.</p>
      <div class="empty-acts">
        <button class="btn pri"><svg><use href="#i-plus"/></svg>Add first entry</button>
        <button class="btn"><svg><use href="#i-up"/></svg>Import Excel</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>Error — frozen period</h2><span class="r">specific + recovery</span></div>
    <div class="errb">
      <div class="errb-ic"><svg><use href="#i-warn"/></svg></div>
      <div class="errb-tx">
        <h3>March 2026 is frozen</h3>
        <p>The March report was approved on <b>2026-04-08</b>. Entries can no longer be
          posted to that period — this keeps the report's numbers truthful.</p>
        <div class="errb-line mono">code: PERIOD_FROZEN</div>
      </div>
    </div>
    <div class="errb-acts">
      <button class="btn pri"><svg><use href="#i-plus"/></svg>Post to April</button>
      <button class="btn">…or request a revision</button>
    </div>
  </div>
</div>"""

write("06-states.html", page(
    "UI states", "Loading · empty · error — the three cases every screen must handle",
    STATES, "Ledger",
    '<div class="act"><button class="btn pri"><svg><use href="#i-plus"/></svg>Add entry</button></div>'))

# ---------------------------------------------------------------- queue page
# Cost Controller's main screen — tag untagged ledger lines to WBS/CBS.
QUEUE = f"""<div class="grid k4">
  <div class="card kpi"><div class="lbl">Untagged lines</div><div class="v">44</div>
    <div class="f">of 2.340 ledger entries</div></div>
  <div class="card kpi"><div class="lbl">Lines selected</div><div class="v">3</div>
    <div class="f">2 with suggested tag</div></div>
  <div class="card kpi"><div class="lbl">Tag coverage</div><div class="v">98.1%</div>
    <div class="f"><span class="wn">target 100%</span> before report</div></div>
  <div class="card kpi"><div class="lbl">Oldest untagged</div><div class="v">12d</div>
    <div class="f">CASHIN-0114 · 14 Sep</div></div>
</div>

<div class="card" style="margin-top:12px">
  <div class="card-hd"><h2>Untagged lines</h2><span class="r">44 rows · sorted by date asc</span></div>
  <div class="fbar">
    <div class="fchk"><input type="checkbox" id="selall" checked><label for="selall">Select all</label></div>
    <div class="sel"><select><option>All types</option></select><svg><use href="#i-chev"/></svg></div>
    <div class="sel"><select><option>14–30 Sep 2026</option></select><svg><use href="#i-chev"/></svg></div>
    <div class="fbar-r">
      <button class="btn pri sm"><svg><use href="#i-check"/></svg>Apply tag to 3 selected</button>
      <button class="btn sm"><svg><use href="#i-dl"/></svg>Export</button>
    </div>
  </div>
  <div class="tw"><table class="tbl">
    <thead><tr>
      <th style="width:26px"></th>
      <th>Date</th><th>Doc no.</th><th>Description</th><th>Type</th>
      <th class="r">Amount</th><th>Suggested tag</th>
    </tr></thead>
    <tbody>
      <tr class="sel"><td><input type="checkbox" checked></td><td class="mono">14 Sep</td>
        <td class="mono">CASHIN-0114</td><td>Progress billing milestone 4</td><td>{chip('bl','RECEIVABLE')}</td>
        <td class="num">400.000.000</td><td><div class="tag-sel">1.1.1 Site setup <b>⚡</b></div></td></tr>
      <tr class="sel"><td><input type="checkbox" checked></td><td class="mono">15 Sep</td>
        <td class="mono">PO-0897</td><td>Cement 500 sacks</td><td>{chip('wn','PAYABLE')}</td>
        <td class="num">90.000.000</td><td><div class="tag-sel">2.3.1 Materials <b>⚡</b></div></td></tr>
      <tr class="sel"><td><input type="checkbox" checked></td><td class="mono">16 Sep</td>
        <td class="mono">INV-0224</td><td>Subcontractor progress term 3</td><td>{chip('nt','EXPENSE')}</td>
        <td class="num">120.000.000</td><td><div class="tag-sel">3.2 Subcontractor <b>⚡</b></div></td></tr>
      <tr><td><input type="checkbox"></td><td class="mono">17 Sep</td>
        <td class="mono">LPB-004</td><td>Labor weekly — crew B</td><td>{chip('bd','LPB')}</td>
        <td class="num">18.000.000</td><td><div class="tag-sug">4.1 Direct labor</div></td></tr>
      <tr><td><input type="checkbox"></td><td class="mono">18 Sep</td>
        <td class="mono">CASHOUT-0209</td><td>Rent excavator week 37</td><td>{chip('nt','EXPENSE')}</td>
        <td class="num">12.500.000</td><td><div class="tag-sug">5.1 Equipment rental</div></td></tr>
      <tr><td><input type="checkbox"></td><td class="mono">19 Sep</td>
        <td class="mono">INV-0225</td><td>Generator fuel — site office</td><td>{chip('nt','EXPENSE')}</td>
        <td class="num">4.200.000</td><td><div class="tag-sug">6 Overhead</div></td></tr>
    </tbody>
  </table></div>
</div>"""

write("07-queue.html", page(
    "Tagging queue", "Citarum Bridge · untagged ledger lines · 44",
    QUEUE, "Ledger",
    '<div class="act"><button class="btn pri"><svg><use href="#i-check"/></svg>Apply tag</button></div>'))

write("01-design-system.html", page(
    "Design system", "PRACTIS · blue #2563eb · Inter · dense · minimal filled icons",
    DS, "Design system",
    '<div class="act"><button class="btn pri sm"><svg><use href="#i-plus"/></svg>New</button></div>'))

write("02-dashboard.html", page(
    "Dashboard", "Portfolio overview · Friday, 25 Sep 2026", DASH, "Dashboard",
    '<div class="act"><button class="btn"><svg><use href="#i-dl"/></svg>Export</button>'
    '<button class="btn pri"><svg><use href="#i-plus"/></svg>New project</button></div>'))

write("03-ledger.html", page(
    "Ledger", "Citarum Bridge · immutable entries · FY 2026", LEDGER, "Ledger",
    '<div class="act"><button class="btn"><svg><use href="#i-dl"/></svg>Export</button>'
    '<button class="btn pri"><svg><use href="#i-plus"/></svg>Add entry</button></div>'))

write("04-lpb.html", page(
    "Expense Report reconciliation", "Citarum Bridge · finance bulk vs admin detail · FY 2026",
    LPB, "Reconciliation",
    '<div class="act"><button class="btn"><svg><use href="#i-dl"/></svg>Export</button>'
    '<button class="btn pri"><svg><use href="#i-plus"/></svg>New report</button></div>'))

write("05-collapsed.html", page(
    "Dashboard", "Portfolio overview · sidebar collapsed state", DASH, "Dashboard",
    '<div class="act"><button class="btn pri"><svg><use href="#i-plus"/></svg>New project</button></div>',
    collapsed=True))
