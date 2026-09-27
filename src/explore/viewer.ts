import { join, relative } from "node:path";

import type { Graph } from "./graph.ts";

/** Renders a self-contained page that shows the explored graph as a discovery tree next to each state's evidence. */
export function renderViewer(graph: Graph, runDirectory: string, projectRoot: string): string {
  const asset = (path: string) => relative(runDirectory, join(projectRoot, path));
  const data = {
    runId: graph.runId, app: graph.app, status: graph.status, reason: graph.reason, root: graph.root, budget: graph.budget,
    viewport: graph.viewport,
    usage: graph.usage.reduce((total, item) => ({ calls: total.calls + 1, input: total.input + item.inputTokens, output: total.output + item.outputTokens }),
      { calls: 0, input: 0, output: 0 }),
    screens: graph.screens,
    states: graph.states.map((state) => {
      const capture = graph.captures[state.steps[0]!]!;
      return {
        id: state.id, screenId: state.screenId, variant: state.variant, summary: state.summary, activity: state.activity, steps: state.steps,
        page: asset(capture.screenshot), actionCount: capture.elements.length, settled: capture.settled, monetization: state.monetization,
        entrances: state.entrances.map((entrance) => ({
          key: entrance.key, name: entrance.name, reason: entrance.reason, status: entrance.status, note: entrance.note,
          kind: entrance.locator.kind, text: entrance.text, rect: entrance.locator.rect, onScreen: entrance.locator.onScreen,
        })),
      };
    }),
    edges: graph.edges,
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${graph.app.key} product graph</title>
${graph.status === "running" ? '<meta http-equiv="refresh" content="5">' : ""}
<style>
:root { --bg: #f7f7f5; --panel: #fff; --text: #1d1d1f; --muted: #6e6e73; --line: #e3e3e0; --accent: #2f6fed;
  --ok: #1f8a4c; --warn: #b26b00; --bad: #c0392b; --chip: #efefec; }
@media (prefers-color-scheme: dark) { :root { --bg: #151516; --panel: #1f1f21; --text: #f2f2f2; --muted: #9a9aa0; --line: #333336;
  --accent: #6b9bff; --ok: #4cc27f; --warn: #e3a33b; --bad: #ff6b5e; --chip: #2b2b2e; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
header { padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel); display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; }
header h1 { font-size: 17px; margin: 0; }
header .meta { color: var(--muted); font-variant-numeric: tabular-nums; }
.status { font-weight: 600; } .status.complete { color: var(--ok); } .status.running { color: var(--accent); }
.status.incomplete, .status.blocked { color: var(--warn); } .status.failed { color: var(--bad); }
main { display: grid; grid-template-columns: minmax(300px, 420px) 1fr; height: calc(100vh - 56px); }
#tree { overflow: auto; padding: 12px 8px 40px; border-right: 1px solid var(--line); }
#detail { overflow: auto; padding: 20px 24px 60px; }
ul.tree { list-style: none; margin: 0; padding-left: 18px; border-left: 1px dashed var(--line); }
#tree > ul.tree { border-left: 0; padding-left: 4px; }
.node { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 8px; cursor: pointer; }
.node:hover { background: var(--chip); } .node.selected { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.node img { width: 34px; height: 60px; object-fit: cover; object-position: top; border-radius: 4px; border: 1px solid var(--line); flex: none; }
.node .name { font-weight: 600; } .node .variant { color: var(--muted); }
.via { color: var(--muted); font-size: 12px; padding: 2px 8px 0; }
.link { color: var(--muted); font-size: 12px; padding: 2px 8px 2px 26px; cursor: pointer; } .link:hover { color: var(--accent); }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--chip); color: var(--muted); margin-left: auto; white-space: nowrap; }
.detail-head h2 { margin: 0 0 4px; font-size: 20px; } .detail-head p { margin: 0 0 4px; color: var(--muted); }
.columns { display: grid; grid-template-columns: minmax(220px, 360px) 1fr; gap: 24px; margin-top: 16px; align-items: start; }
.page { position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); background: #000; }
.page img { display: block; width: 100%; }
.box { position: absolute; border: 2px solid var(--accent); border-radius: 4px; }
.box span { position: absolute; top: -2px; left: -2px; background: var(--accent); color: #fff; font-size: 11px; padding: 0 5px; border-radius: 3px 0 3px 0; }
.box.explored { border-color: var(--ok); } .box.explored span { background: var(--ok); }
.box.blocked, .box.no_effect, .box.unreachable, .box.timeout, .box.disabled { border-color: var(--warn); }
.box.blocked span, .box.no_effect span, .box.unreachable span, .box.timeout span, .box.disabled span { background: var(--warn); }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 20px 0 8px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.card .row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.card .reason { color: var(--muted); font-size: 13px; }
.pill { font-size: 11px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
.pill.explored, .pill.navigated { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.pill.pending, .pill.changed_in_place { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.pill.blocked, .pill.no_effect, .pill.unreachable, .pill.timeout, .pill.disabled, .pill.left_app { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
a.jump { color: var(--accent); cursor: pointer; text-decoration: none; } a.jump:hover { text-decoration: underline; }
.empty { color: var(--muted); padding: 40px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; height: auto; } #tree { border-right: 0; border-bottom: 1px solid var(--line); max-height: 45vh; } .columns { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header id="header"></header>
<main><nav id="tree"></nav><section id="detail"></section></main>
<script type="application/json" id="data">${json}</script>
<script>
const data = JSON.parse(document.getElementById("data").textContent);
const states = new Map(data.states.map((s) => [s.id, s]));
const screen = (s) => data.screens.find((item) => item.id === s.screenId);
const title = (s) => screen(s).name + " / " + s.variant;
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let selected = location.hash.slice(1) || data.root;

document.getElementById("header").innerHTML =
  '<h1>' + esc(data.app.key) + ' <span class="meta">' + esc(data.app.packageId) + (data.app.version ? " · v" + esc(data.app.version) : "") + '</span></h1>' +
  '<span class="status ' + data.status + '">' + data.status + '</span><span class="meta">' + esc(data.reason) + '</span>' +
  '<span class="meta">' + data.screens.length + ' screens · ' + data.states.length + ' states · ' + data.edges.length + ' edges · ' +
  data.budget.used + '/' + data.budget.max + ' actions · ' + data.usage.calls + ' model calls · ' + Math.round(data.usage.input / 1000) + 'K input tokens</span>';

// Discovery tree: each state hangs under the first edge that reached it; every other edge is shown as a link.
function buildTree() {
  const parent = new Map([[data.root, null]]);
  const children = new Map();
  for (const edge of data.edges) {
    if (edge.outcome !== "navigated" || parent.has(edge.to) || !parent.has(edge.from)) continue;
    parent.set(edge.to, edge);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge]);
  }
  for (const s of data.states) if (!parent.has(s.id)) { parent.set(s.id, null); children.set("orphans", [...(children.get("orphans") ?? []), { to: s.id }]); }
  const render = (id, via, seen) => {
    const s = states.get(id);
    const done = s.entrances.filter((e) => e.status === "explored").length;
    let html = '<li>' + (via ? '<div class="via">' + (via.action.kind === "type" ? "type " + esc(JSON.stringify(via.action.text)) + " into " : "tap ") + '“' + esc(via.action.name) + '”</div>' : "") +
      '<div class="node' + (id === selected ? " selected" : "") + '" data-id="' + id + '"><img loading="lazy" src="' + esc(s.page) + '">' +
      '<div><div class="name">' + esc(screen(s).name) + '</div><div class="variant">' + esc(s.variant) + '</div></div>' +
      '<span class="badge">' + done + '/' + s.entrances.length + '</span></div>';
    const links = data.edges.filter((edge) => edge.from === id && !(edge.outcome === "navigated" && parent.get(edge.to) === edge));
    for (const edge of links) {
      const mark = edge.outcome === "left_app" ? "↗ left app" : edge.outcome === "changed_in_place" ? "↻ in place" : "↪ " + esc(title(states.get(edge.to)));
      html += '<div class="link" data-id="' + (edge.to ?? id) + '">' + mark + ' · “' + esc(edge.action.name) + '”</div>';
    }
    const kids = (children.get(id) ?? []).filter((edge) => !seen.has(edge.to));
    if (kids.length) html += '<ul class="tree">' + kids.map((edge) => render(edge.to, edge, new Set([...seen, edge.to]))).join("") + '</ul>';
    return html + '</li>';
  };
  const orphans = (children.get("orphans") ?? []).map((edge) => render(edge.to, null, new Set([edge.to]))).join("");
  document.getElementById("tree").innerHTML = data.root
    ? '<ul class="tree">' + render(data.root, null, new Set([data.root])) + orphans + '</ul>'
    : '<p class="empty">No state observed yet.</p>';
}

function showDetail() {
  const s = states.get(selected);
  if (!s) { document.getElementById("detail").innerHTML = '<p class="empty">Select a state.</p>'; return; }
  const scale = 100 / data.viewport.width;
  const boxes = s.entrances.map((e, index) => e.onScreen ? '<div class="box ' + e.status + '" style="left:' + e.rect.x * scale + '%;top:' + e.rect.y / data.viewport.height * 100 +
    '%;width:' + e.rect.width * scale + '%;height:' + e.rect.height / data.viewport.height * 100 + '%"><span>' + (index + 1) + '</span></div>' : "").join("");
  const entrances = s.entrances.map((e, index) => {
    const edge = data.edges.find((item) => item.from === s.id && item.entrance === e.key);
    const target = edge && edge.to ? ' → <a class="jump" data-id="' + edge.to + '">' + esc(title(states.get(edge.to))) + '</a>' : "";
    return '<div class="card"><div class="row"><b>' + (index + 1) + '. ' + esc(e.name) + '</b><span class="pill ' + e.status + '">' + e.status + '</span>' +
      (edge ? '<span class="pill ' + edge.outcome + '">' + edge.outcome + '</span>' : "") + target + '</div>' +
      '<div class="reason">' + (e.onScreen ? "" : "below the visible area · ") + (e.kind === "type" ? "type " + esc(JSON.stringify(e.text)) + " · " : "") + esc(e.reason) + (e.note && e.note !== e.status ? " · " + esc(e.note) : "") + '</div>' +
      (edge && (edge.change.added.length || edge.change.enabled.length) ? '<div class="reason">after: ' + esc([...edge.change.added.map((n) => "+ " + n), ...edge.change.enabled.map((n) => "enabled " + n)].slice(0, 6).join(", ")) + '</div>' : "") + '</div>';
  }).join("") || '<p class="reason">The analyst chose no entrances here.</p>';
  const incoming = data.edges.filter((edge) => edge.to === s.id && edge.from !== s.id).map((edge) =>
    '<div class="card"><a class="jump" data-id="' + edge.from + '">' + esc(title(states.get(edge.from))) + '</a> · “' + esc(edge.action.name) + '”</div>').join("") ||
    '<p class="reason">' + (s.id === data.root ? "Cold launch lands here." : "Reached by replay or Back only.") + '</p>';
  document.getElementById("detail").innerHTML =
    '<div class="detail-head"><h2>' + esc(title(s)) + '</h2><p>' + esc(screen(s).description) + '</p><p>' + esc(s.summary) + '</p>' +
    '<p class="reason">' + esc(s.activity) + ' · ' + s.actionCount + ' actions on page' + (s.settled ? "" : " · screen kept changing") +
    ' · observed at steps ' + s.steps.join(", ") + '</p></div>' +
    '<div class="columns"><div class="page"><img src="' + esc(s.page) + '">' + boxes + '</div>' +
    '<div><h3>Entrances</h3>' + entrances + '<h3>Reached from</h3>' + incoming +
    (s.monetization.length ? '<h3>Monetization</h3>' + s.monetization.map((f) => '<p class="reason">' + esc(f.kind) + ' · ' + esc(f.description) + '</p>').join("") : "") + '</div></div>';
}

function select(id) { selected = id; history.replaceState(null, "", "#" + id); buildTree(); showDetail(); }
document.addEventListener("click", (event) => { const target = event.target.closest("[data-id]"); if (target) select(target.dataset.id); });
buildTree(); showDetail();
</script>
</body>
</html>
`;
}
