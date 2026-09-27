import { useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import type { MockEntrance, MockPreview, MockTransition } from "../domain/mock.ts";

const { manifest, images } = JSON.parse(document.querySelector<HTMLScriptElement>("#mock-data")!.textContent!) as MockPreview;
const MAX_HISTORY = 100;
const STATUS_TEXT: Record<MockEntrance["status"], string> = {
  explored: "done", pending: "pending", blocked: "blocked", no_effect: "no effect", unreachable: "unreachable", timeout: "timed out", disabled: "disabled",
};
const tone = (status: MockEntrance["status"]) => status === "explored" ? "done" : status === "pending" ? "todo" : "stop";

const stateById = new Map(manifest.states.map((state) => [state.id, state]));
const observationByStep = new Map(manifest.observations.map((observation) => [observation.step, observation]));
const transitionById = new Map(manifest.transitions.map((transition) => [transition.id, transition]));
const words = (value: string) => value.replaceAll("_", " ");
const title = (stateId: string) => `${words(stateById.get(stateId)!.screen)} · ${words(stateById.get(stateId)!.variant)}`;
const firstStep = (stateId: string) => stateById.get(stateId)!.observationSteps[0]!;
const rootId = observationByStep.get(manifest.initialStep)!.stateId;

// Discovery tree: each state hangs under the first navigation that reached it; every other transition is a link.
const treeEdge = new Map<string, MockTransition | null>([[rootId, null]]);
const children = new Map<string, MockTransition[]>();
for (const transition of manifest.transitions) {
  if (transition.outcome !== "navigated" || !transition.to || treeEdge.has(transition.to) || !treeEdge.has(transition.from)) continue;
  treeEdge.set(transition.to, transition);
  children.set(transition.from, [...(children.get(transition.from) ?? []), transition]);
}
const roots = [rootId, ...manifest.states.map((state) => state.id).filter((id) => !treeEdge.has(id))];

function TreeNode({ stateId, current, go }: { stateId: string; current: string; go: (step: number) => void }) {
  const state = stateById.get(stateId)!;
  const done = state.entrances.filter((entrance) => entrance.status === "explored").length;
  const links = manifest.transitions.filter((transition) => transition.from === stateId && treeEdge.get(transition.to ?? "") !== transition);
  const kids = children.get(stateId) ?? [];
  return <li>
    <button className="node" aria-current={stateId === current ? "true" : undefined} onClick={() => go(firstStep(stateId))}>
      <img src={images[observationByStep.get(firstStep(stateId))!.evidence.screenshot]} alt="" loading="lazy" />
      <span><strong>{words(state.screen)}</strong><small>{words(state.variant)}</small></span>
      <span className="count" title="entrances done / chosen">{done}/{state.entrances.length}</span>
    </button>
    {links.map((transition) => <button key={transition.id} className="link" title={transition.label}
      onClick={() => transition.targetStep !== null && go(transition.targetStep)}>
      {transition.targetStep === null ? "↗ left app" : transition.to === stateId ? "↻ in place" : `↪ ${title(transition.to!)}`}
    </button>)}
    {kids.length > 0 && <ul className="tree">{kids.map((transition) =>
      <TreeNode key={transition.id} stateId={transition.to!} current={current} go={go} />)}</ul>}
  </li>;
}

function Replay() {
  const [step, setStep] = useState(manifest.initialStep);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [caption, setCaption] = useState("");
  const drag = useRef<{ id: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const lastWheel = useRef(0);
  const observation = observationByStep.get(step)!;
  const state = stateById.get(observation.stateId)!;
  const { width, height } = observation.viewport;

  function show(next: number, entranceKey: string | null = null, note = ""): void {
    if (next !== step) setHistory((items) => [...items, step].slice(-MAX_HISTORY));
    setStep(next);
    setSelected(entranceKey);
    setCaption(note);
  }

  const locate = (entrance: MockEntrance) => show(entrance.step ?? step, entrance.key, entrance.bounds ? "" : "Not on a recorded screen");

  function follow(entrance: MockEntrance): void {
    const transition = transitionById.get(entrance.transitionId!)!;
    if (transition.targetStep === null) {
      show(transition.sourceStep, entrance.key, "Left the app");
      return;
    }
    show(transition.targetStep, null, transition.action.type === "type" ? `Typed “${transition.action.text}”${transition.action.submit ? " + Enter" : ""}` : "");
  }

  // Frames recorded while scrolling to an element: moving the content down shows a frame scrolled down from this one,
  // or goes back to the frame this one was scrolled up from.
  const frameToward = (direction: "up" | "down") => {
    if (observation.scroll && observation.scroll.direction !== direction) return observation.scroll.from;
    return manifest.observations.find((item) => item.scroll?.from === step && item.scroll.direction === direction)?.step ?? null;
  };
  const frames = { up: frameToward("up"), down: frameToward("down") };
  const scroll = (direction: "up" | "down") => { const frame = frames[direction]; if (frame !== null) show(frame); };

  const percent = (bounds: NonNullable<MockEntrance["bounds"]>): CSSProperties => ({
    left: `${bounds.x / width * 100}%`, top: `${bounds.y / height * 100}%`,
    width: `${bounds.width / width * 100}%`, height: `${bounds.height / height * 100}%`,
  });
  const destination = (entrance: MockEntrance) => {
    const transition = entrance.transitionId ? transitionById.get(entrance.transitionId)! : null;
    if (!transition) return STATUS_TEXT[entrance.status];
    return transition.targetStep === null ? "↗ left app" : transition.to === state.id ? "↻ here" : `→ ${title(transition.to!)}`;
  };
  const counts = manifest.states.flatMap((item) => item.entrances).reduce((total, entrance) => {
    total[tone(entrance.status)] += 1;
    return total;
  }, { done: 0, todo: 0, stop: 0 });

  return <>
    <header>
      <h1>{manifest.app}</h1>
      <span className="meta">{manifest.runStatus} · {manifest.states.length} states · {manifest.transitions.length} actions</span>
      <span className="legend">
        <span><i className="dot done" /> done {counts.done}</span>
        <span><i className="dot todo" /> pending {counts.todo}</span>
        <span title="blocked, unreachable, no effect, timed out or disabled"><i className="dot stop" /> not done {counts.stop}</span>
      </span>
    </header>
    <main>
      <nav aria-label="States"><ul className="tree">{roots.map((id) => <TreeNode key={id} stateId={id} current={state.id} go={(next) => show(next)} />)}</ul></nav>

      <section className="stage-column" aria-label="Screen">
        <div className="toolbar">
          <button aria-label="Back" title="Back" disabled={!history.length} onClick={() => {
            setStep(history.at(-1)!); setHistory(history.slice(0, -1)); setSelected(null); setCaption("");
          }}>←</button>
          <button aria-label="Restart" title="Restart" onClick={() => { setStep(manifest.initialStep); setHistory([]); setSelected(null); setCaption(""); }}>↺</button>
        </div>
        <div id="stage" style={{ "--ratio": `${width} / ${height}` } as CSSProperties}
          onClickCapture={(event) => { if (didDrag.current) { event.stopPropagation(); didDrag.current = false; } }}
          onPointerDown={(event) => { if (event.isPrimary) { drag.current = { id: event.pointerId, y: event.clientY }; didDrag.current = false; } }}
          onPointerCancel={() => { drag.current = null; }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            const dy = event.clientY - drag.current.y;
            drag.current = null;
            if (Math.abs(dy) < 40) return;
            didDrag.current = true;
            scroll(dy < 0 ? "down" : "up");
          }}
          onWheel={(event) => {
            if (Math.abs(event.deltaY) < 30 || Date.now() - lastWheel.current < 600) return;
            lastWheel.current = Date.now();
            scroll(event.deltaY > 0 ? "down" : "up");
          }}>
          <img src={images[observation.evidence.screenshot]} alt={title(state.id)} draggable={false} />
          {state.entrances.map((entrance, index) => {
            if (entrance.step !== step || !entrance.bounds) return null;
            const props = { className: `box ${tone(entrance.status)}`, style: percent(entrance.bounds), "data-selected": entrance.key === selected || undefined, title: `${entrance.name} · ${destination(entrance)}` };
            return entrance.transitionId
              ? <button key={entrance.key} {...props} aria-label={`${entrance.name}, ${destination(entrance)}`} onClick={() => follow(entrance)}><b>{index + 1}</b></button>
              : <div key={entrance.key} {...props}><b>{index + 1}</b></div>;
          })}
          {frames.up !== null && <button className="cue top" onClick={() => scroll("up")}>↑ more</button>}
          {frames.down !== null && <button className="cue bottom" onClick={() => scroll("down")}>↓ more</button>}
        </div>
        <p className="caption" role="status">{caption}</p>
      </section>

      <aside aria-label="Entrances">
        <h2>{words(state.screen)}<small>{words(state.variant)}</small></h2>
        {state.entrances.length ? <ol className="entrances">{state.entrances.map((entrance, index) =>
          <li key={entrance.key}>
            <div className={`entrance ${tone(entrance.status)}`} data-selected={entrance.key === selected || undefined}>
              <button className="locate" title={entrance.name} onClick={() => locate(entrance)}>
                <span className="n">{index + 1}</span><i className="dot" /><span className="name">{entrance.name}</span>
              </button>
              {entrance.transitionId
                ? <button className="to" title={destination(entrance)} onClick={() => follow(entrance)}>{destination(entrance)}</button>
                : <span className="to">{destination(entrance)}</span>}
            </div>
          </li>)}</ol> : <p className="empty">No entrances chosen here.</p>}
      </aside>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<Replay />);
