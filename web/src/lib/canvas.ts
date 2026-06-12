/**
 * JSON Canvas — the open file format Obsidian Canvas uses (jsoncanvas.org).
 * A `.canvas` file is `{ "nodes": [...], "edges": [...] }`. We read/write it
 * verbatim so canvases stay round-trip compatible with the Obsidian app.
 */

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';
/** color = preset "1".."6" (Obsidian's palette) or a "#RRGGBB" hex string. */
export type CanvasColor = string;

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}
export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
}
export interface FileNode extends NodeBase {
  type: 'file';
  file: string;
  subpath?: string;
}
export interface LinkNode extends NodeBase {
  type: 'link';
  url: string;
}
export interface GroupNode extends NodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}
export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export const EMPTY_CANVAS: CanvasData = { nodes: [], edges: [] };

/** Parse a `.canvas` string; always returns a valid (possibly empty) canvas. */
export function parseCanvas(raw: string): CanvasData {
  if (!raw || !raw.trim()) return { nodes: [], edges: [] };
  try {
    const obj = JSON.parse(raw);
    const nodes = Array.isArray(obj?.nodes) ? (obj.nodes as CanvasNode[]) : [];
    const edges = Array.isArray(obj?.edges) ? (obj.edges as CanvasEdge[]) : [];
    return { nodes, edges };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Serialize to the pretty-printed JSON Obsidian writes (tab indent). */
export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify({ nodes: data.nodes, edges: data.edges }, null, '\t');
}

/** 16-hex-char id, same shape Obsidian generates. `seed` keeps it deterministic. */
export function genId(seed: number): string {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  let out = '';
  for (let i = 0; i < 16; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out += ((s >>> 8) & 0xf).toString(16);
  }
  return out;
}

/** Obsidian's 6 preset accent colors (preset index "1".."6"). */
export const PRESET_COLORS: Record<string, string> = {
  '1': '#fb464c', // red
  '2': '#e9973f', // orange
  '3': '#e0de71', // yellow
  '4': '#44cf6e', // green
  '5': '#53dfdd', // cyan
  '6': '#a882ff', // purple
};

/** Resolve a node/edge color to a concrete CSS color, or null for default. */
export function resolveColor(color?: CanvasColor): string | null {
  if (!color) return null;
  if (PRESET_COLORS[color]) return PRESET_COLORS[color];
  return color; // hex / css color
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box covering every node (canvas coords). null when empty. */
export function nodesBBox(nodes: CanvasNode[]): Rect | null {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The anchor point (canvas coords) on a given side of a node rect. */
export function sideAnchor(n: Rect, side: CanvasSide): { x: number; y: number } {
  switch (side) {
    case 'top': return { x: n.x + n.width / 2, y: n.y };
    case 'bottom': return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left': return { x: n.x, y: n.y + n.height / 2 };
    case 'right': return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

/** Pick the best from/to sides for an edge based on node centers. */
export function autoSides(a: Rect, b: Rect): { from: CanvasSide; to: CanvasSide } {
  const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
  const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

/** Unit outward normal for a side — controls the Bézier handle direction. */
function sideNormal(side: CanvasSide): { x: number; y: number } {
  switch (side) {
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
  }
}

/**
 * Cubic Bézier path between two anchor points, with control handles pushed out
 * along each side's normal (Obsidian's smooth elbow look). Returns the SVG `d`
 * plus the tip angle (radians) at the `to` end for arrowhead orientation.
 */
export function edgePath(
  from: { x: number; y: number },
  fromSide: CanvasSide,
  to: { x: number; y: number },
  toSide: CanvasSide,
): { d: string; tipAngle: number; mid: { x: number; y: number } } {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const handle = Math.max(30, Math.min(dist * 0.5, 200));
  const fn = sideNormal(fromSide);
  const tn = sideNormal(toSide);
  const c1 = { x: from.x + fn.x * handle, y: from.y + fn.y * handle };
  const c2 = { x: to.x + tn.x * handle, y: to.y + tn.y * handle };
  const d = `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
  // Tangent at end of a cubic ≈ direction from c2 → end.
  const tipAngle = Math.atan2(to.y - c2.y, to.x - c2.x);
  // Midpoint by ARC LENGTH (not t=0.5) so the label sits visually centered on
  // the curve — matches Obsidian. Sample the cubic and walk to half its length.
  const mid = bezierArcMidpoint(from, c1, c2, to);
  return { d, tipAngle, mid };
}

function bezierPoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Point at half the arc length of a cubic Bézier (visual midpoint of the curve). */
function bezierArcMidpoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { x: number; y: number } {
  const N = 24;
  const pts: { x: number; y: number }[] = [];
  const lens: number[] = [0];
  let prev = p0;
  pts.push(p0);
  let total = 0;
  for (let i = 1; i <= N; i++) {
    const pt = bezierPoint(p0, p1, p2, p3, i / N);
    total += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    pts.push(pt);
    lens.push(total);
    prev = pt;
  }
  const half = total / 2;
  for (let i = 1; i <= N; i++) {
    if (lens[i] >= half) {
      const seg = lens[i] - lens[i - 1] || 1;
      const f = (half - lens[i - 1]) / seg;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      };
    }
  }
  return bezierPoint(p0, p1, p2, p3, 0.5);
}

/** Which side of a node a point (canvas coords) is nearest to. */
export function nearestSide(n: Rect, px: number, py: number): CanvasSide {
  const sides: CanvasSide[] = ['top', 'right', 'bottom', 'left'];
  let best: CanvasSide = 'top';
  let bestD = Infinity;
  for (const s of sides) {
    const a = sideAnchor(n, s);
    const d = Math.hypot(a.x - px, a.y - py);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
