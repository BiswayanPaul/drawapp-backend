"use strict";
// Everything a client sends is validated here before it is stored or relayed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_POINTS_PER_STROKE = void 0;
exports.cleanPoint = cleanPoint;
exports.cleanPoints = cleanPoints;
exports.cleanElement = cleanElement;
exports.MAX_POINTS_PER_STROKE = 4000;
const SHAPE_KINDS = new Set(["line", "arrow", "rect", "ellipse"]);
const round = (n) => Math.round(n * 10) / 10;
function cleanPoint(value) {
    const p = value;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
        return null;
    return { x: round(p.x), y: round(p.y) };
}
function cleanPoints(value, max) {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) {
        return null;
    }
    const points = value.map(cleanPoint);
    return points.every(Boolean) ? points : null;
}
function cleanElement(value) {
    const el = value;
    if (!el || typeof el !== "object")
        return null;
    const { id, kind, color, size } = el;
    if (typeof id !== "string" || id.length === 0 || id.length > 40)
        return null;
    if (typeof color !== "string" || color.length > 32)
        return null;
    if (typeof size !== "number" || !(size > 0 && size <= 200))
        return null;
    const base = { id, color, size };
    if (kind === "stroke") {
        const points = cleanPoints(el.points, exports.MAX_POINTS_PER_STROKE);
        const opacity = typeof el.opacity === "number" ? Math.min(Math.max(el.opacity, 0.05), 1) : 1;
        return points ? Object.assign(Object.assign({}, base), { kind, points, opacity }) : null;
    }
    if (typeof kind === "string" && SHAPE_KINDS.has(kind)) {
        const from = cleanPoint(el.from);
        const to = cleanPoint(el.to);
        return from && to
            ? Object.assign(Object.assign({}, base), { kind: kind, from, to }) : null;
    }
    if (kind === "text") {
        const at = cleanPoint(el.at);
        const text = typeof el.text === "string" ? el.text.trim().slice(0, 500) : "";
        return at && text ? Object.assign(Object.assign({}, base), { kind, at, text }) : null;
    }
    if (kind === "fill") {
        const at = cleanPoint(el.at);
        return at ? Object.assign(Object.assign({}, base), { kind, at }) : null;
    }
    return null;
}
