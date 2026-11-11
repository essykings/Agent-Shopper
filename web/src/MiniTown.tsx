// A small live picture of the town, for Home and for the landing page. It is the real map scaled down, with its
// words hidden (they would be too small to read), and one readable line underneath saying what is happening.
// It shows real runs live, a replay of a recent real run, or the labelled example. Nothing is invented.

import { useEffect, useRef, useState } from "react";
import { Scene, useLive } from "./Town";

export function MiniTown() {
  const { world, status } = useLive("/api/town");
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.2, el.clientWidth / 1000));
    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);

  const agents = Object.values(world.agents);
  const crowded = status === "busy";
  const label = crowded
    ? "Too many people are watching right now"
    : agents.some((a) => a.mine && !a.replay && !a.sample)
      ? "Live: your shopper"
      : agents.some((a) => !a.replay && !a.sample)
        ? "Live"
        : agents.some((a) => a.sample)
          ? "Example run"
          : agents.some((a) => a.replay)
            ? "Replay of a recent run"
            : status === "offline"
              ? "Not connected"
              : "Waiting for a shopper";
  const doing = crowded ? "" : world.log.at(-1)?.text ?? "";

  return (
    <div>
      <div ref={box} className="miniwrap" style={{ height: scale * 540 }} role="img" aria-label="A small map of the three shops, the guard and PayPal, with shoppers walking between them">
        <div className="mini" style={{ transform: `scale(${scale})` }}>
          <Scene world={crowded ? { ...world, agents: {} } : world} homeLabel="" empty="" compact />
        </div>
      </div>
      <p className="s" style={{ margin: "10px 0 0" }} aria-live="polite">
        <b>{label}</b>
        {doing ? ` · ${doing}` : ""}
      </p>
    </div>
  );
}
