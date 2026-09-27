import { useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import type { MockPreview } from "../domain/mock.ts";

const preview = JSON.parse(document.querySelector<HTMLScriptElement>("#mock-data")!.textContent!) as MockPreview;
const MAX_REVIEW_HISTORY = 100;
const ACTION_ICONS = { tap: "⌖", type: "T", swipe: "↕", back: "←", wait: "◷" };
const SWIPE_ARROWS = { up: "↑", down: "↓", left: "←", right: "→", none: "" };

type ReplayLocation = { step: number; transitionId: string | null };

function Replay({ manifest, images }: MockPreview) {
  const [location, setLocation] = useState<ReplayLocation>({ step: manifest.initialStep, transitionId: null });
  const [history, setHistory] = useState<ReplayLocation[]>([]);
  const [showHints, setShowHints] = useState(true);
  const [status, setStatus] = useState("");
  const gesture = useRef<{ id: number; x: number; y: number } | null>(null);
  const didSwipe = useRef(false);
  const lastWheel = useRef(0);
  const observation = manifest.observations.find((item) => item.step === location.step)!;
  const state = manifest.states.find((item) => item.id === observation.stateId)!;
  const actions = manifest.transitions.filter((item) => item.from === state.id);
  const transition = actions.find((item) => item.id === location.transitionId);
  const action = transition?.action;
  const bounds = transition?.bounds;
  const destination = manifest.states.find((item) => item.id === transition?.to);
  const isTapTarget = action?.type === "tap" || (action?.type === "back" && bounds !== null);
  // Frames recorded while scrolling to an element: moving the content down shows a frame scrolled down from this one,
  // or goes back to the frame this one was scrolled up from.
  const frameToward = (direction: "up" | "down") => {
    const reverse = direction === "down" ? "up" : "down";
    if (observation.scroll?.direction === reverse) return observation.scroll.from;
    return manifest.observations.find((item) => item.scroll?.from === observation.step && item.scroll.direction === direction)?.step ?? null;
  };
  const scrollFrames = { up: frameToward("up"), down: frameToward("down") };
  function scrollPage(direction: "up" | "down"): void {
    const frame = scrollFrames[direction];
    if (frame === null) return;
    setLocation({ step: frame, transitionId: null });
    setStatus(`Scrolled ${direction}.`);
  }
  const viewportStyle = { "--device-width": observation.viewport.width, "--device-height": observation.viewport.height } as CSSProperties;
  const targetStyle: CSSProperties | undefined = bounds ? {
    left: `${bounds.x / observation.viewport.width * 100}%`,
    top: `${bounds.y / observation.viewport.height * 100}%`,
    width: `${bounds.width / observation.viewport.width * 100}%`,
    height: `${bounds.height / observation.viewport.height * 100}%`,
  } : undefined;

  function visit(next: ReplayLocation): void {
    setHistory((items) => [...items, location].slice(-MAX_REVIEW_HISTORY));
    setLocation(next);
    setStatus("");
  }

  function followTransition(): void {
    if (!transition) return;
    if (transition.targetStep === null) {
      setStatus(`Recorded outcome: ${transition.outcome}. No destination state was observed.`);
      return;
    }
    visit({ step: transition.targetStep, transitionId: null });
    setStatus(`Replayed ${transition.action.type}: ${transition.label}.`);
  }

  return <main className="workspace">
    <aside className="sidebar">
      <div className="session-title"><p className="eyebrow">Recorded state graph</p><h1>{manifest.app}</h1><p className="secondary">{manifest.states.length} states · {manifest.transitions.length} actions</p></div>
      <nav aria-label="Recorded states">
        <div className="section-label">States<span>{manifest.states.length}</span></div>
        <ul className="path-list">{manifest.states.map((item) =>
          <li key={item.id}><button className="path-step" data-state-id={item.id} aria-current={item.id === state.id ? "page" : undefined} onClick={() => {
            if (item.id !== state.id) visit({ step: item.observationSteps[0]!, transitionId: null });
          }}>
            <span className="step-copy"><strong>{item.screen.replaceAll("_", " ")}</strong><span>{item.variant.replaceAll("_", " ")}</span></span>
            {item.id === state.id && <span className="current-dot" aria-hidden="true" />}
          </button></li>
        )}</ul>
      </nav>
      <div className="session-footer"><span className="session-status">{manifest.runStatus}</span><p>Select a state, then choose one of its recorded actions.</p></div>
    </aside>

    <section className="viewer" aria-label="App preview">
      <div className="viewer-toolbar"><span>{state.screen.replaceAll("_", " ")} · observation {observation.step}</span>
        <button id="show-hints" className="quiet-button" aria-pressed={showHints} disabled={!action} onClick={() => setShowHints(!showHints)}><span aria-hidden="true">⌖</span> Action hints</button>
      </div>
      <div className="canvas">
        <div id="stage" data-step={observation.step} data-state-id={state.id} style={viewportStyle}>
          <img id="screen" src={images[observation.evidence.screenshot]} width={observation.viewport.width} height={observation.viewport.height} alt={`${state.screen}, observation ${observation.step}`} draggable={false} />
          <div className="interaction" style={{ touchAction: action?.type === "swipe" ? "none" : "auto" }}
            onClick={() => setStatus(action ? "Use the selected action’s control or matching gesture." : "Choose an action to see its recorded screenshot and interaction.")}
            onClickCapture={(event) => { if (didSwipe.current) { event.stopPropagation(); event.preventDefault(); didSwipe.current = false; } }}
            onPointerDown={(event) => {
              if (!event.isPrimary) return;
              didSwipe.current = false;
              gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
              if (action?.type === "swipe") event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerCancel={() => { gesture.current = null; }}
            onWheel={(event) => {
              if (Math.abs(event.deltaY) < 30 || Date.now() - lastWheel.current < 600) return;
              lastWheel.current = Date.now();
              scrollPage(event.deltaY > 0 ? "down" : "up");
            }}
            onPointerUp={(event) => {
              if (!gesture.current || gesture.current.id !== event.pointerId) return;
              const dx = event.clientX - gesture.current.x;
              const dy = event.clientY - gesture.current.y;
              gesture.current = null;
              if (Math.max(Math.abs(dx), Math.abs(dy)) < 40) return;
              didSwipe.current = true;
              const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
              if (action?.type !== "swipe") {
                if (direction === "up" || direction === "down") scrollPage(direction === "up" ? "down" : "up");
              } else if (action.direction === direction) followTransition();
              else setStatus(`This action requires a swipe ${action.direction}.`);
            }}>
            {bounds && transition && isTapTarget && <button id="hotspot" className={showHints ? "show" : ""} aria-label={transition.label} style={targetStyle}
              onClick={(event) => { event.stopPropagation(); followTransition(); }} />}
            {showHints && bounds && action?.type === "type" && <div className="input-target" style={targetStyle} aria-hidden="true" />}
            {showHints && action && !isTapTarget && <div className="gesture-hint" aria-hidden="true">
              <strong>{action.type === "swipe" ? SWIPE_ARROWS[action.direction] : ACTION_ICONS[action.type]}</strong>
              <span>{action.type === "swipe" ? `Swipe ${action.direction}` : action.type === "type" ? (action.text === "" ? "Submit existing input" : "Use recorded text below") : action.type === "wait" ? "Wait for result" : "Android Back"}</span>
            </div>}
          </div>
          {scrollFrames.up !== null && <button className="scroll-cue top" aria-label="Scroll up" onClick={() => scrollPage("up")}>↑ more above</button>}
          {scrollFrames.down !== null && <button className="scroll-cue bottom" aria-label="Scroll down" onClick={() => scrollPage("down")}>↓ more below</button>}
        </div>
      </div>
      <p className="device-caption">{observation.viewport.width} × {observation.viewport.height} px<span>{transition ? "Selected action’s source screenshot" : observation.scroll ? `Scrolled ${observation.scroll.direction}` : "Original screenshot"}</span></p>
      <div className="playback">
        {action?.type === "type" && action.text !== "" && <div className="recorded-input"><label htmlFor="recorded-text">Recorded text</label>
          <textarea id="recorded-text" readOnly value={action.text ?? ""} rows={3} aria-describedby="input-note" />
          <p id="input-note">{action.submit ? "Includes Enter to submit." : "Types without submitting."} Only this recorded input is replayed.</p>
        </div>}
        <div className="playback-buttons">
          <button id="previous" className="icon-button" aria-label="Previous view" title="Previous view (review history)" disabled={!history.length} onClick={() => {
            setLocation(history[history.length - 1]!); setHistory(history.slice(0, -1)); setStatus("");
          }}>←</button>
          <button id="perform" className="primary-button" disabled={!transition} onClick={followTransition}>
            <span>{transition ? `${transition.action.type === "tap" ? "Tap: " : ""}${transition.label}` : actions.length ? "Select an action" : "No recorded actions"}</span>
            <span aria-hidden="true">{action ? ACTION_ICONS[action.type] : "—"}</span>
          </button>
          <button id="restart" className="icon-button" aria-label="Reset view" title="Reset view" onClick={() => {
            setLocation({ step: manifest.initialStep, transitionId: null }); setHistory([]); setStatus("");
          }}>↺</button>
        </div>
        <p id="status" role="status" aria-live="polite">{status || (transition ? "Execute the selected action to follow its recorded transition." : actions.length ? "Choose an available action. Each may lead to a different state." : "No outgoing actions were recorded for this state.")}</p>
      </div>
    </section>

    <aside className="inspector" aria-label="State and actions">
      <p className="eyebrow">Current state</p><h2>{state.screen.replaceAll("_", " ")}</h2><span className="variant">{state.variant.replaceAll("_", " ")}</span>
      <section className="inspector-section"><h3>Available actions<span className="action-type">{actions.length}</span></h3>
        <p className="action-help">Select an action to view its source screenshot and parameters.</p>
        <div className="action-list">{actions.map((item) => {
          const target = manifest.states.find((candidate) => candidate.id === item.to);
          return <button key={item.id} className="action-option" data-transition-id={item.id} aria-pressed={item.id === transition?.id} onClick={() => {
            setLocation({ step: item.sourceStep, transitionId: item.id }); setStatus("");
          }}>
            <span className="action-icon" aria-hidden="true">{ACTION_ICONS[item.action.type]}</span>
            <span className="action-copy"><strong>{item.label}</strong><span>{item.action.type} · {target ? `${target.screen.replaceAll("_", " ")} / ${target.variant.replaceAll("_", " ")}` : `No destination · ${item.outcome}`}</span></span>
          </button>;
        })}</div>
        {!actions.length && <p>No recorded actions.</p>}
        {transition && <div className="selected-action"><p>{transition.action.reason}</p>
          <div className="destination"><span>Destination</span><strong>{destination ? `${destination.screen.replaceAll("_", " ")} / ${destination.variant.replaceAll("_", " ")}` : "No observed state"}</strong></div>
          <p className="secondary">Source observation {transition.sourceStep} · outcome: {transition.outcome}</p>
        </div>}
      </section>
      <details><summary>State summary</summary><p>{state.summary}</p></details>
      <details><summary>Exploration coverage</summary><p>{manifest.runStatus}: {manifest.stopReason.replaceAll("_", " ")}</p></details>
      <details><summary>Unexplored groups <span>{state.unexploredGroups.length}</span></summary>
        {state.unexploredGroups.length ? <ul>{state.unexploredGroups.map((group, index) => <li key={index}>{group}</li>)}</ul> : <p>No additional unexplored groups recorded.</p>}
      </details>
      <details><summary>Source evidence</summary><dl><dt>State</dt><dd>{state.id}</dd><dt>Screenshot</dt><dd>{observation.evidence.screenshot}</dd><dt>Element tree</dt><dd>{observation.evidence.elementTree}</dd></dl></details>
    </aside>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Replay {...preview} />);
