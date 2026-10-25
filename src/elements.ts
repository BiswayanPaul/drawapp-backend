// Everything a client sends is validated here before it is stored or relayed.

export type Point = { x: number; y: number };

type Base = { id: string; color: string; size: number };

export type DrawElement =
  | (Base & { kind: "stroke"; points: Point[]; opacity: number })
  | (Base & { kind: "line" | "arrow" | "rect" | "ellipse"; from: Point; to: Point })
  | (Base & { kind: "text"; at: Point; text: string });

export const MAX_POINTS_PER_STROKE = 4000;
const SHAPE_KINDS = new Set(["line", "arrow", "rect", "ellipse"]);

const round = (n: number) => Math.round(n * 10) / 10;

export function cleanPoint(value: unknown): Point | null {
  const p = value as Point;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: round(p.x), y: round(p.y) };
}

export function cleanPoints(value: unknown, max: number): Point[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return null;
  }
  const points = value.map(cleanPoint);
  return points.every(Boolean) ? (points as Point[]) : null;
}

export function cleanElement(value: unknown): DrawElement | null {
  const el = value as Record<string, unknown>;
  if (!el || typeof el !== "object") return null;

  const { id, kind, color, size } = el;
  if (typeof id !== "string" || id.length === 0 || id.length > 40) return null;
  if (typeof color !== "string" || color.length > 32) return null;
  if (typeof size !== "number" || !(size > 0 && size <= 200)) return null;
  const base = { id, color, size };

  if (kind === "stroke") {
    const points = cleanPoints(el.points, MAX_POINTS_PER_STROKE);
    const opacity =
      typeof el.opacity === "number" ? Math.min(Math.max(el.opacity, 0.05), 1) : 1;
    return points ? { ...base, kind, points, opacity } : null;
  }

  if (typeof kind === "string" && SHAPE_KINDS.has(kind)) {
    const from = cleanPoint(el.from);
    const to = cleanPoint(el.to);
    return from && to
      ? { ...base, kind: kind as "line" | "arrow" | "rect" | "ellipse", from, to }
      : null;
  }

  if (kind === "text") {
    const at = cleanPoint(el.at);
    const text = typeof el.text === "string" ? el.text.trim().slice(0, 500) : "";
    return at && text ? { ...base, kind, at, text } : null;
  }

  return null;
}
