import { useEffect, useRef, useState } from 'react';
import { useStore, type GraphSettings } from '../lib/store';
import { api } from '../lib/api';
import Icon from './Icon';
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
} from 'd3-force';
import type { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';

type NodeKind = 'note' | 'attachment' | 'unresolved' | 'tag';

interface GNode {
  id: string;
  label: string;
  kind: NodeKind;
  tags: string[];
  deg: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}
interface GLink {
  source: GNode | string;
  target: GNode | string;
}
interface RawGraph {
  nodes: { id: string; label: string; kind: 'note' | 'attachment' | 'unresolved'; tags: string[] }[];
  edges: { source: string; target: string }[];
}

interface ColorSet {
  accent: number;
  accentHover: number;
  edge: number;
  text: number;
  textStrong: number;
  attach: number;
  unresolved: number;
  tag: number;
  bg: number;
}
interface PixiCtx {
  app: Application;
  world: Container;
  edges: Graphics;
  arrows: Graphics;
  nodeLayer: Container;
  labelLayer: Container;
  tex: Texture;
  sprites: Map<GNode, Sprite>;
  labels: Text[];
  cols: ColorSet;
}

const TEXR = 32; // radius of the shared circle texture (sprites are scaled from this)

// --- force mapping: normalized 0..1 sliders → d3-force params -------------
// Stronger repulsion + longer links + gentler centering so the graph spreads
// into readable clusters instead of collapsing into a tangled hairball.
const charge = (s: GraphSettings) => -(20 + s.repelForce * 200); // default ≈ -120
const linkDist = (s: GraphSettings) => 25 + s.linkDistance * 150; // default ≈ 100
const linkStr = (s: GraphSettings) => 0.1 + s.linkForce * 0.8; // default ≈ 0.5
const centerStr = (s: GraphSettings) => s.centerForce * 0.08; // default ≈ 0.04
const chargeStrength = (s: GraphSettings) => (n: GNode) => charge(s) * (1 + Math.sqrt(n.deg) * 0.3);
// Gentle sqrt growth, CAPPED so a high-degree tag hub stays only ~3-4× a note
// (Obsidian-like) instead of ballooning. Notes have a solid visible base size.
const nodeRadius = (n: GNode, s: GraphSettings) =>
  (3 + Math.min(Math.sqrt(n.deg), 11)) * (0.45 + s.nodeSize);

/**
 * Graph view — WebGL-rendered via PixiJS (like Obsidian's PixiJS graph), with the
 * d3-force layout running on the main thread. Pan/zoom is a GPU camera transform
 * (no geometry rebuild), so it stays smooth at thousands of nodes. The Filters
 * panel mirrors Obsidian: Tags / Attachments / Existing-only / Orphans, color
 * Groups, Display sliders and Forces.
 */
export default function GraphView() {
  const openFile = useStore((s) => s.openFile);
  const searchFor = useStore((s) => s.searchFor);
  const settings = useStore((s) => s.graphSettings);
  const patch = useStore((s) => s.setGraphSettings);
  const reset = useStore((s) => s.resetGraphSettings);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<GNode, GLink> | null>(null);
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const rawRef = useRef<RawGraph | null>(null);
  const pixi = useRef<PixiCtx | null>(null);
  const mod = useRef<typeof import('pixi.js') | null>(null);
  const cam = useRef({ x: 0, y: 0, k: 1 });
  const hover = useRef<GNode | null>(null);
  const drag = useRef<{ px: number; py: number; moved: number } | null>(null);
  const rafRef = useRef<number>();
  const fullDirty = useRef(false);
  const lastEdgeK = useRef(-1);
  const userMoved = useRef(false);
  const sref = useRef(settings);
  sref.current = settings;

  const [rawVersion, setRawVersion] = useState(0);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [stats, setStats] = useState({ total: 0, shown: 0, orphans: 0 });
  const [buildError, setBuildError] = useState<string | null>(null);

  // ---- colour helpers -----------------------------------------------------
  const getCols = (): ColorSet => {
    const Color = mod.current!.Color;
    const cs = getComputedStyle(document.querySelector('.theme-light, .theme-dark') || document.body);
    const toInt = (name: string, fb: number) => {
      const v = cs.getPropertyValue(name).trim();
      if (!v) return fb;
      try {
        return new Color(v).toNumber();
      } catch {
        return fb;
      }
    };
    return {
      accent: toInt('--interactive-accent', 0x7852ee),
      accentHover: toInt('--text-accent-hover', 0xa98bff),
      edge: toInt('--text-faint', 0x999999),
      text: toInt('--text-muted', 0x666666),
      textStrong: toInt('--text-normal', 0x222222),
      attach: 0xe0a008,
      unresolved: toInt('--text-faint', 0xaaaaaa),
      tag: 0x13a8cd,
      bg: toInt('--bg-primary', 0xffffff),
    };
  };

  const colorOf = (n: GNode, cols: ColorSet): number => {
    for (const g of sref.current.groups) {
      const q = g.query.trim().toLowerCase();
      if (!q) continue;
      if (
        n.label.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q.replace(/^#/, '')))
      ) {
        try {
          return new mod.current!.Color(g.color).toNumber();
        } catch {
          /* ignore bad color */
        }
      }
    }
    if (n.kind === 'attachment') return cols.attach;
    if (n.kind === 'unresolved') return cols.unresolved;
    if (n.kind === 'tag') return cols.tag;
    return cols.accent;
  };

  // ---- rendering (camera transform + on-demand repaint) -------------------
  const scheduleRender = (full: boolean) => {
    if (full) fullDirty.current = true;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined;
      doRender();
    });
  };

  const doRender = () => {
    const p = pixi.current;
    if (!p) return;
    const { x, y, k } = cam.current;
    p.world.position.set(x, y);
    p.world.scale.set(k);
    if (fullDirty.current) updatePositions();
    // edges are drawn in world space but their width is set to 1/k so they keep a
    // constant on-screen thickness — redraw on layout change or when zoom changes.
    if (fullDirty.current || k !== lastEdgeK.current) {
      drawEdges();
      lastEdgeK.current = k;
    }
    fullDirty.current = false;
    updateLabels();
    p.app.render();
  };

  const updatePositions = () => {
    const p = pixi.current;
    if (!p) return;
    for (const [n, sp] of p.sprites) {
      sp.x = n.x ?? 0;
      sp.y = n.y ?? 0;
    }
  };

  const drawEdges = () => {
    const p = pixi.current;
    if (!p) return;
    const s = sref.current;
    const k = cam.current.k || 1;
    const g = p.edges;
    g.clear();
    for (const l of linksRef.current) {
      const a = l.source as GNode;
      const b = l.target as GNode;
      g.moveTo(a.x ?? 0, a.y ?? 0);
      g.lineTo(b.x ?? 0, b.y ?? 0);
    }
    // width / k → constant on-screen thickness after the world is scaled by k
    g.stroke({ width: (0.8 + s.linkThickness * 1.2) / k, color: p.cols.edge, alpha: 0.5 + s.linkThickness * 0.45 });

    const ag = p.arrows;
    ag.clear();
    if (s.arrows) {
      const size = (4 + s.linkThickness * 3) / k;
      for (const l of linksRef.current) {
        const a = l.source as GNode;
        const b = l.target as GNode;
        const ang = Math.atan2((b.y ?? 0) - (a.y ?? 0), (b.x ?? 0) - (a.x ?? 0));
        const r = nodeRadius(b, s) + 1;
        const tx = (b.x ?? 0) - Math.cos(ang) * r;
        const ty = (b.y ?? 0) - Math.sin(ang) * r;
        ag.moveTo(tx, ty);
        ag.lineTo(tx - Math.cos(ang - 0.4) * size, ty - Math.sin(ang - 0.4) * size);
        ag.lineTo(tx - Math.cos(ang + 0.4) * size, ty - Math.sin(ang + 0.4) * size);
        ag.closePath();
      }
      ag.fill({ color: p.cols.edge, alpha: 0.6 });
    }
  };

  const ensureLabel = (i: number): Text => {
    const p = pixi.current!;
    let t = p.labels[i];
    if (!t) {
      t = new mod.current!.Text({
        text: '',
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: 13,
          fontWeight: '600',
          fill: p.cols.textStrong,
          stroke: { color: p.cols.bg, width: 4, join: 'round' },
        },
      });
      t.anchor.set(0.5, 0);
      p.labelLayer.addChild(t);
      p.labels[i] = t;
    }
    return t;
  };

  const updateLabels = () => {
    const p = pixi.current;
    const wrap = wrapRef.current;
    if (!p || !wrap) return;
    const s = sref.current;
    const { x: cx, y: cy, k } = cam.current;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const h = hover.current;
    // Labels begin appearing once a node's on-screen radius passes rMin, then
    // FADE GRADUALLY from dim → fully opaque over a zoom range (like Obsidian):
    // big hubs clear first, smaller notes ramp up as you keep zooming in.
    const rMin = 1.0 - s.textFade * 0.9; // default(0.5) ≈ 0.55px — where the fade starts
    const fade = 4.5; // px of on-screen radius over which a label ramps to full

    const cand: { n: GNode; sx: number; sy: number; r: number; a: number }[] = [];
    for (const n of nodesRef.current) {
      const sx = (n.x ?? 0) * k + cx;
      const sy = (n.y ?? 0) * k + cy;
      if (sx < -60 || sx > W + 60 || sy < -40 || sy > H + 40) continue;
      const r = nodeRadius(n, s) * k;
      const a = n === h ? 1 : Math.min(1, (r - rMin) / fade);
      if (a <= 0.04) continue;
      cand.push({ n, sx, sy, r, a });
    }
    // Consider the most prominent candidates first (hover, then degree).
    cand.sort((u, v) => (v.n === h ? 1 : 0) - (u.n === h ? 1 : 0) || v.n.deg - u.n.deg);
    const POOL = Math.min(cand.length, 800);

    // Greedy placement: skip any label whose box overlaps one already placed, so
    // labels never pile into an unreadable mass (Obsidian-style decluttering).
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const MAX = 220;
    let li = 0;
    for (let ci = 0; ci < POOL && li < MAX; ci++) {
      const { n, sx, sy, r, a } = cand[ci];
      const label = n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label;
      const w = Math.max(16, label.length * 7.2);
      const x0 = sx - w / 2;
      const x1 = sx + w / 2;
      const y0 = sy + r + 3;
      const y1 = y0 + 15;
      let clash = false;
      for (const b of placed) {
        if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) {
          clash = true;
          break;
        }
      }
      if (clash && n !== h) continue;
      placed.push({ x0, y0, x1, y1 });

      const t = ensureLabel(li++);
      if (t.text !== label) t.text = label;
      const isH = n === h;
      if ((t as unknown as { _hv?: boolean })._hv !== isH) {
        (t as unknown as { _hv?: boolean })._hv = isH;
        t.style.fill = isH ? p.cols.accentHover : p.cols.textStrong;
        t.style.fontSize = isH ? 14 : 13;
      }
      t.x = sx;
      t.y = y0;
      t.alpha = a;
      t.visible = true;
    }
    for (let i = li; i < p.labels.length; i++) p.labels[i].visible = false;
  };

  // ---- scene (re)build ----------------------------------------------------
  const resizeRenderer = () => {
    const p = pixi.current;
    const wrap = wrapRef.current;
    if (!p || !wrap) return;
    const W = wrap.clientWidth || 900;
    const H = wrap.clientHeight || 600;
    p.app.renderer.resize(W, H);
  };

  const buildScene = () => {
    const p = pixi.current;
    if (!p) return;
    try {
      const Sprite = mod.current!.Sprite;
      const s = sref.current;
      p.cols = getCols();
      for (const sp of p.sprites.values()) sp.destroy();
      p.sprites.clear();
      p.nodeLayer.removeChildren();

      for (const n of nodesRef.current) {
        const sp = new Sprite(p.tex);
        sp.anchor.set(0.5);
        sp.tint = colorOf(n, p.cols);
        sp.scale.set(nodeRadius(n, s) / TEXR);
        sp.alpha = n.kind === 'unresolved' ? 0.55 : 1;
        sp.x = n.x ?? 0;
        sp.y = n.y ?? 0;
        p.nodeLayer.addChild(sp);
        p.sprites.set(n, sp);
      }
      cam.current = { x: 0, y: 0, k: 1 };
      resizeRenderer();
      fullDirty.current = true;
      scheduleRender(true);
    } catch (err) {
      console.error('Pixi scene build failed:', err);
    }
  };

  // Frame the dense core: center on the median position and scale so the bulk of
  // the nodes (a percentile, ignoring far-flung outlier clusters) fills the view.
  // Fitting the full extent would shrink a sprawling graph to a dot in the middle.
  const fitView = () => {
    const nodes = nodesRef.current;
    const wrap = wrapRef.current;
    if (!nodes.length || !wrap) return;
    const xs = nodes.map((n) => n.x ?? 0).sort((a, b) => a - b);
    const ys = nodes.map((n) => n.y ?? 0).sort((a, b) => a - b);
    const mid = (arr: number[]) => arr[Math.floor(arr.length / 2)];
    const cxw = mid(xs);
    const cyw = mid(ys);
    const dists = nodes.map((n) => Math.hypot((n.x ?? 0) - cxw, (n.y ?? 0) - cyw)).sort((a, b) => a - b);
    const rad = Math.max(1, dists[Math.floor(dists.length * 0.82)] || dists[dists.length - 1] || 1);
    const W = wrap.clientWidth || 900;
    const H = wrap.clientHeight || 600;
    const margin = 80;
    const k = Math.max(0.05, Math.min((W - margin) / (2 * rad), (H - margin) / (2 * rad), 1.5));
    cam.current = { k, x: W / 2 - cxw * k, y: H / 2 - cyw * k };
    scheduleRender(false);
  };

  const applyDisplay = () => {
    const p = pixi.current;
    if (!p) return;
    const s = sref.current;
    p.cols = getCols();
    for (const [n, sp] of p.sprites) {
      sp.tint = n === hover.current ? p.cols.accentHover : colorOf(n, p.cols);
      const mul = n === hover.current ? 1.25 : 1;
      sp.scale.set((nodeRadius(n, s) * mul) / TEXR);
    }
    scheduleRender(true);
  };

  // ---- init pixi (once) ---------------------------------------------------
  useEffect(() => {
    let destroyed = false;
    (async () => {
      const PIXI = await import('pixi.js');
      if (destroyed) return;
      mod.current = PIXI;
      const wrap = wrapRef.current!;
      const app = new PIXI.Application();
      await app.init({
        canvas: canvasRef.current!,
        width: wrap.clientWidth || 900,
        height: wrap.clientHeight || 600,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        backgroundAlpha: 0,
        autoStart: false,
        preference: 'webgl',
        powerPreference: 'high-performance',
      });
      if (destroyed) {
        app.destroy(true);
        return;
      }
      app.ticker.stop();
      const world = new PIXI.Container();
      const edges = new PIXI.Graphics();
      const arrows = new PIXI.Graphics();
      const nodeLayer = new PIXI.Container();
      const labelLayer = new PIXI.Container();
      world.addChild(edges);
      world.addChild(arrows);
      world.addChild(nodeLayer);
      app.stage.addChild(world);
      app.stage.addChild(labelLayer);

      const cg = new PIXI.Graphics().circle(0, 0, TEXR).fill(0xffffff);
      const tex = app.renderer.generateTexture({ target: cg, resolution: 2, antialias: true });
      cg.destroy();

      pixi.current = { app, world, edges, arrows, nodeLayer, labelLayer, tex, sprites: new Map(), labels: [], cols: getCols() };
      buildScene(); // builds from current data (or nothing yet)
    })();
    return () => {
      destroyed = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const p = pixi.current;
      if (p) {
        p.app.destroy(true, { children: true, texture: true });
        pixi.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fetch the raw graph once
  useEffect(() => {
    let cancelled = false;
    api
      .graph()
      .then((g) => {
        if (cancelled) return;
        rawRef.current = g as RawGraph;
        setRawVersion((v) => v + 1);
      })
      .catch(() => {
        rawRef.current = { nodes: [], edges: [] };
        setRawVersion((v) => v + 1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // (re)build filtered graph + simulation whenever the structural filters change
  useEffect(() => {
    const raw = rawRef.current;
    if (!raw) return;
    const s = sref.current;
    let sim: Simulation<GNode, GLink> | null = null;

    try {
      const byId = new Map<string, GNode>();
      for (const n of raw.nodes) {
        if (n.kind === 'attachment' && !s.attachments) continue;
        if (n.kind === 'unresolved' && s.existingOnly) continue;
        byId.set(n.id, { id: n.id, label: n.label, kind: n.kind, tags: n.tags ?? [], deg: 0 });
      }
      if (s.tags) {
        for (const n of raw.nodes) {
          if (!byId.has(n.id) || !n.tags) continue;
          for (const tag of n.tags) {
            const id = `tag:${tag}`;
            if (!byId.has(id)) byId.set(id, { id, label: '#' + tag, kind: 'tag', tags: [], deg: 0 });
          }
        }
      }

      const pairs: { source: string; target: string }[] = [];
      for (const e of raw.edges) {
        if (byId.has(e.source) && byId.has(e.target)) pairs.push({ source: e.source, target: e.target });
      }
      if (s.tags) {
        for (const n of raw.nodes) {
          if (!byId.has(n.id) || !n.tags) continue;
          for (const tag of n.tags) pairs.push({ source: n.id, target: `tag:${tag}` });
        }
      }

      let nodeList = [...byId.values()];
      const q = s.search.trim().toLowerCase();
      if (q) {
        const keep = new Set(
          nodeList
            .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
            .map((n) => n.id),
        );
        nodeList = nodeList.filter((n) => keep.has(n.id));
      }

      let ids = new Set(nodeList.map((n) => n.id));
      let pairList = pairs.filter((l) => ids.has(l.source) && ids.has(l.target));

      const deg = new Map<string, number>();
      for (const l of pairList) {
        deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
        deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
      }
      nodeList.forEach((n) => (n.deg = deg.get(n.id) ?? 0));

      const orphanCount = nodeList.filter((n) => n.kind === 'note' && (deg.get(n.id) ?? 0) === 0).length;

      if (!s.orphans) {
        nodeList = nodeList.filter((n) => (deg.get(n.id) ?? 0) > 0);
        ids = new Set(nodeList.map((n) => n.id));
        pairList = pairList.filter((l) => ids.has(l.source) && ids.has(l.target));
      }

      const nodeMap = new Map(nodeList.map((n) => [n.id, n] as const));
      const linkList: GLink[] = [];
      for (const l of pairList) {
        const a = nodeMap.get(l.source);
        const b = nodeMap.get(l.target);
        if (a && b) linkList.push({ source: a, target: b });
      }

      nodesRef.current = nodeList;
      linksRef.current = linkList;
      setBuildError(null);
      setStats({
        total: raw.nodes.filter((n) => n.kind === 'note').length,
        shown: nodeList.length,
        orphans: orphanCount,
      });

      const wrap = wrapRef.current!;
      const W = wrap.clientWidth || 900;
      const H = wrap.clientHeight || 600;

      nodeList.forEach((n, i) => {
        const a = (i / Math.max(1, nodeList.length)) * Math.PI * 2;
        n.x = W / 2 + Math.cos(a) * 250;
        n.y = H / 2 + Math.sin(a) * 250;
      });

      simRef.current?.stop();
      sim = forceSimulation<GNode>(nodeList)
        .force('charge', forceManyBody<GNode>().strength(chargeStrength(s)).theta(0.85).distanceMax(1400))
        .force('link', forceLink<GNode, GLink>(linkList).distance(linkDist(s)).strength(linkStr(s)))
        .force('center', forceCenter(W / 2, H / 2).strength(centerStr(s)))
        .force('collide', forceCollide<GNode>((n) => nodeRadius(n, s) + 3).iterations(1))
        .alpha(1)
        .alphaDecay(0.025)
        .velocityDecay(0.35);
      userMoved.current = false;
      let ticks = 0;
      sim.on('tick', () => {
        // keep the expanding graph framed until the user takes over
        if (!userMoved.current && ++ticks % 12 === 0) fitView();
        scheduleRender(true);
      });
      sim.on('end', () => {
        if (!userMoved.current) fitView();
      });
      simRef.current = sim;
      setSceneVersion((v) => v + 1); // tell the renderer to (re)create sprites
    } catch (err) {
      console.error('Graph build failed:', err);
      simRef.current?.stop();
      simRef.current = null;
      nodesRef.current = [];
      linksRef.current = [];
      setBuildError('Could not render the graph with the current filters.');
      setSceneVersion((v) => v + 1);
    }

    return () => {
      sim?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawVersion, settings.tags, settings.attachments, settings.existingOnly, settings.orphans, settings.search]);

  // rebuild the Pixi scene whenever the data changes (and once Pixi is ready)
  useEffect(() => {
    if (pixi.current) buildScene();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneVersion]);

  // forces changed → update in place and reheat
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const s = sref.current;
    (sim.force('charge') as ReturnType<typeof forceManyBody<GNode>> | undefined)?.strength(chargeStrength(s));
    (sim.force('link') as ReturnType<typeof forceLink<GNode, GLink>> | undefined)?.distance(linkDist(s)).strength(linkStr(s));
    (sim.force('center') as ReturnType<typeof forceCenter> | undefined)?.strength(centerStr(s));
    sim.alpha(0.5).restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.repelForce, settings.linkForce, settings.linkDistance, settings.centerForce]);

  // display-only changes → re-tint / re-scale + repaint
  useEffect(() => {
    applyDisplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.nodeSize, settings.linkThickness, settings.textFade, settings.arrows, settings.groups]);

  // repaint + resize on container resize
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      resizeRenderer();
      scheduleRender(false);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // smooth cursor-anchored zoom (native non-passive wheel listener)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = cam.current;
      const speed = e.ctrlKey ? 0.012 : 0.0018;
      const factor = Math.exp(-e.deltaY * speed);
      const nk = Math.max(0.04, Math.min(10, v.k * factor));
      v.x = mx - ((mx - v.x) * nk) / v.k;
      v.y = my - ((my - v.y) * nk) / v.k;
      v.k = nk;
      userMoved.current = true;
      scheduleRender(false);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- pointer interactions ----------------------------------------------
  const nodeAt = (clientX: number, clientY: number): GNode | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { x: cx, y: cy, k } = cam.current;
    let best: GNode | null = null;
    let bestD = 14;
    for (const n of nodesRef.current) {
      const px = (n.x ?? 0) * k + cx;
      const py = (n.y ?? 0) * k + cy;
      const d = Math.hypot(px - mx, py - my);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  };

  const setHover = (n: GNode | null) => {
    if (n === hover.current) return;
    const p = pixi.current;
    const s = sref.current;
    if (p) {
      const prev = hover.current;
      if (prev) {
        const sp = p.sprites.get(prev);
        if (sp) {
          sp.tint = colorOf(prev, p.cols);
          sp.scale.set(nodeRadius(prev, s) / TEXR);
        }
      }
      if (n) {
        const sp = p.sprites.get(n);
        if (sp) {
          sp.tint = p.cols.accentHover;
          sp.scale.set((nodeRadius(n, s) * 1.25) / TEXR);
        }
      }
    }
    hover.current = n;
    if (canvasRef.current) canvasRef.current.style.cursor = n ? 'pointer' : 'grab';
    scheduleRender(false);
  };

  const onDown = (e: React.MouseEvent) => {
    drag.current = { px: e.clientX, py: e.clientY, moved: 0 };
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag.current) {
      const dx = e.clientX - drag.current.px;
      const dy = e.clientY - drag.current.py;
      drag.current.px = e.clientX;
      drag.current.py = e.clientY;
      drag.current.moved += Math.abs(dx) + Math.abs(dy);
      cam.current.x += dx;
      cam.current.y += dy;
      userMoved.current = true;
      scheduleRender(false);
    } else {
      setHover(nodeAt(e.clientX, e.clientY));
    }
  };
  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved < 5) {
      const n = nodeAt(e.clientX, e.clientY);
      if (!n) return;
      if (n.kind === 'note') openFile(n.id);
      else if (n.kind === 'tag') searchFor(`tag:${n.id.slice(4)}`);
    }
  };

  return (
    <div className="graph-view">
      <div className="graph-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ cursor: 'grab', position: 'absolute', inset: 0 }}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={() => {
            drag.current = null;
            setHover(null);
          }}
        />
        <div className="graph-hint">
          {stats.shown} / {stats.total} notes · {stats.orphans} orphans · scroll to zoom · drag to pan · click a tag to search
        </div>

        {buildError && (
          <div className="graph-error">
            <span>{buildError}</span>
            <button className="btn secondary" onClick={reset}>
              Reset filters
            </button>
          </div>
        )}

        {!panelOpen && (
          <button className="graph-panel-open" title="Show filters" onClick={() => setPanelOpen(true)}>
            <Icon name="settings" size={16} />
          </button>
        )}

        {panelOpen && (
          <FilterPanel
            settings={settings}
            patch={patch}
            reset={reset}
            onClose={() => setPanelOpen(false)}
            onAnimate={() => simRef.current?.alpha(0.9).restart()}
          />
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Filter panel (Obsidian parity)
// ----------------------------------------------------------------------------

const GROUP_COLORS = ['#e0a008', '#13a8cd', '#3aa757', '#e5534b', '#9b6dff', '#e668c0'];

function FilterPanel({
  settings: s,
  patch,
  reset,
  onClose,
  onAnimate,
}: {
  settings: GraphSettings;
  patch: (p: Partial<GraphSettings>) => void;
  reset: () => void;
  onClose: () => void;
  onAnimate: () => void;
}) {
  const addGroup = () =>
    patch({
      groups: [...s.groups, { query: '', color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length] }],
    });
  const setGroup = (i: number, g: Partial<{ query: string; color: string }>) =>
    patch({ groups: s.groups.map((x, j) => (j === i ? { ...x, ...g } : x)) });
  const delGroup = (i: number) => patch({ groups: s.groups.filter((_, j) => j !== i) });

  return (
    <div className="graph-panel">
      <Section
        title="Filters"
        actions={
          <>
            <button className="nav-action" title="Reset to defaults" onClick={reset}>
              <Icon name="refresh-cw" size={14} />
            </button>
            <button className="nav-action" title="Close" onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          </>
        }
      >
        <input
          className="text-input"
          placeholder="Search files..."
          value={s.search}
          onChange={(e) => patch({ search: e.target.value })}
        />
        <Toggle label="Tags" checked={s.tags} onChange={(v) => patch({ tags: v })} />
        <Toggle label="Attachments" checked={s.attachments} onChange={(v) => patch({ attachments: v })} />
        <Toggle label="Existing files only" checked={s.existingOnly} onChange={(v) => patch({ existingOnly: v })} />
        <Toggle label="Orphans" checked={s.orphans} onChange={(v) => patch({ orphans: v })} />
      </Section>

      <Section title="Groups">
        <button className="btn" style={{ width: '100%' }} onClick={addGroup}>
          New group
        </button>
        {s.groups.map((g, i) => (
          <div className="graph-group-row" key={i}>
            <input
              type="color"
              className="graph-color"
              value={g.color}
              onChange={(e) => setGroup(i, { color: e.target.value })}
            />
            <input
              className="text-input"
              placeholder="Search query"
              value={g.query}
              onChange={(e) => setGroup(i, { query: e.target.value })}
            />
            <button className="nav-action" title="Remove group" onClick={() => delGroup(i)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </Section>

      <Section title="Display">
        <Toggle label="Arrows" checked={s.arrows} onChange={(v) => patch({ arrows: v })} />
        <Slider label="Text fade threshold" value={s.textFade} onChange={(v) => patch({ textFade: v })} />
        <Slider label="Node size" value={s.nodeSize} onChange={(v) => patch({ nodeSize: v })} />
        <Slider label="Link thickness" value={s.linkThickness} onChange={(v) => patch({ linkThickness: v })} />
        <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={onAnimate}>
          Animate
        </button>
      </Section>

      <Section title="Forces">
        <Slider label="Center force" value={s.centerForce} onChange={(v) => patch({ centerForce: v })} />
        <Slider label="Repel force" value={s.repelForce} onChange={(v) => patch({ repelForce: v })} />
        <Slider label="Link force" value={s.linkForce} onChange={(v) => patch({ linkForce: v })} />
        <Slider label="Link distance" value={s.linkDistance} onChange={(v) => patch({ linkDistance: v })} />
      </Section>
    </div>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="graph-section">
      <div className="graph-section-head">
        <button className="graph-section-title" onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          {title}
        </button>
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {open && <div className="graph-section-body">{children}</div>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="graph-row">
      <span className="graph-row-label">{label}</span>
      <button
        className={`graph-switch ${checked ? 'on' : ''}`}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
      >
        <span className="graph-knob" />
      </button>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="graph-slider">
      <span className="graph-row-label">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}
