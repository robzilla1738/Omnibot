import {
  BarChart3,
  Bot,
  Code2,
  Cpu,
  FileCode2,
  FolderGit2,
  GitBranch,
  Globe,
  Palette,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import type React from "react";
import { useEffect, useId, useMemo, useState } from "react";
import type { BotColor, BotShape, CliDriverKind } from "../../lib/types";
import {
  ClaudeIcon,
  GeminiIcon,
  GrokIcon,
  OpenaiIcon,
} from "./OmarchyIcons";

export const BOT_SHAPES: Array<{ id: BotShape; label: string; isProviderLogo?: boolean }> = [
  // Bespoke Provider-Logo Bot PFPs
  { id: "omni-prism", label: "Omni Prism", isProviderLogo: true },
  { id: "claude-spark", label: "Claude Sunburst", isProviderLogo: true },
  { id: "codex-bloom", label: "Codex Knot", isProviderLogo: true },
  { id: "grok-orbit", label: "Grok Orbit", isProviderLogo: true },
  { id: "cursor-cube", label: "Cursor Cube", isProviderLogo: true },
  { id: "opencode-terminal", label: "OpenCode Terminal", isProviderLogo: true },
  { id: "pi-crest", label: "Pi Crest", isProviderLogo: true },
  { id: "gemini-star", label: "Gemini Star", isProviderLogo: true },
  { id: "ollama-llama", label: "Ollama Llama", isProviderLogo: true },
  { id: "aider-git", label: "Aider Git", isProviderLogo: true },
  // Classic Procedural Grok Bot Shapes
  { id: "blob", label: "Blob" },
  { id: "squircle", label: "Squircle" },
  { id: "hex", label: "Hex" },
  { id: "gem", label: "Gem" },
  { id: "star", label: "Star" },
  { id: "pebble", label: "Pebble" },
  { id: "sparkle", label: "Sparkle" },
  { id: "shield", label: "Shield" },
  { id: "cloud", label: "Cloud" },
  { id: "crystal", label: "Crystal" },
  { id: "clover", label: "Clover" },
  { id: "heart", label: "Heart" },
  { id: "dome", label: "Dome" },
  { id: "arch", label: "Arch" },
  { id: "tablet", label: "Tablet" },
  { id: "capsule", label: "Capsule" },
  { id: "cylinder", label: "Cylinder" },
  { id: "wedge", label: "Wedge" },
  { id: "teardrop", label: "Teardrop" },
  { id: "leaf", label: "Leaf" },
  { id: "square", label: "Square" },
  { id: "flower", label: "Flower" },
  { id: "house", label: "House" },
  { id: "bean", label: "Bean" },
  { id: "egg", label: "Egg" },
];

export const BOT_COLORS: Array<{
  id: BotColor;
  label: string;
  from: string;
  to: string;
  swatch: string;
}> = [
  { id: "cyan", label: "Cyan", from: "#58D3C5", to: "#00A592", swatch: "#1CC3B0" },
  { id: "orange", label: "Terracotta", from: "#F28F6B", to: "#B55335", swatch: "#D97757" },
  { id: "green", label: "Emerald", from: "#1CCF82", to: "#008048", swatch: "#10A37F" },
  { id: "blue", label: "Azure", from: "#459FFE", to: "#0C64C1", swatch: "#1084FE" },
  { id: "violet", label: "Violet", from: "#B792FE", to: "#5C39A1", swatch: "#9159FE" },
  { id: "magenta", label: "Magenta", from: "#FF77BE", to: "#A21E62", swatch: "#FF309B" },
  { id: "yellow", label: "Amber", from: "#FFAF38", to: "#C27400", swatch: "#FF9800" },
  { id: "red", label: "Crimson", from: "#FF5667", to: "#A21826", swatch: "#FF263C" },
  { id: "brown", label: "Bronze", from: "#AE8968", to: "#604227", swatch: "#936439" },
  { id: "gray", label: "Titanium", from: "#F4F4F5", to: "#71717A", swatch: "#A1A1AA" },
  { id: "black", label: "Obsidian", from: "#52525B", to: "#18181B", swatch: "#27272A" },
];

const CENTER = 114.2705;
const TWO_PI = Math.PI * 2;
const round2 = (n: number) => Math.round(n * 100) / 100;

class PathBuilder {
  d = "";
  move(x: number, y: number) {
    this.d += `M${round2(x)} ${round2(y)}`;
    return this;
  }
  line(x: number, y: number) {
    this.d += `L${round2(x)} ${round2(y)}`;
    return this;
  }
  curve(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.d += `C${round2(x1)} ${round2(y1)} ${round2(x2)} ${round2(y2)} ${round2(x)} ${round2(y)}`;
    return this;
  }
  corner(prev: [number, number], curr: [number, number], next: [number, number], r: number) {
    const unit = (a: [number, number], b: [number, number]): [number, number] => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    };
    const u1 = unit(prev, curr);
    const u2 = unit(next, curr);
    const p1: [number, number] = [curr[0] + u1[0] * r, curr[1] + u1[1] * r];
    const p2: [number, number] = [curr[0] + u2[0] * r, curr[1] + u2[1] * r];
    if (this.d) this.line(p1[0], p1[1]);
    else this.move(p1[0], p1[1]);
    this.d += `Q${round2(curr[0])} ${round2(curr[1])} ${round2(p2[0])} ${round2(p2[1])}`;
    return this;
  }
  arc(cx: number, cy: number, rx: number, ry: number, start: number, end: number) {
    const segs = Math.max(1, Math.ceil(Math.abs(end - start) / (Math.PI / 2)));
    const step = (end - start) / segs;
    const k = (4 / 3) * Math.tan(step / 4);
    let ang = start;
    for (let i = 0; i < segs; i++) {
      const next = ang + step;
      const p0: [number, number] = [cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)];
      const p1: [number, number] = [cx + rx * Math.cos(next), cy + ry * Math.sin(next)];
      this.curve(
        p0[0] - k * rx * Math.sin(ang),
        p0[1] + k * ry * Math.cos(ang),
        p1[0] + k * rx * Math.sin(next),
        p1[1] - k * ry * Math.cos(next),
        p1[0],
        p1[1]
      );
      ang = next;
    }
    return this;
  }
  close() {
    return `${this.d}Z`;
  }
}

function catmullRomClosed(pts: Array<[number, number]>): string {
  const n = pts.length;
  let d = `M${round2(pts[0][0])} ${round2(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += `C${round2(p1[0] + (p2[0] - p0[0]) / 6)} ${round2(p1[1] + (p2[1] - p0[1]) / 6)} ${round2(p2[0] - (p3[0] - p1[0]) / 6)} ${round2(p2[1] - (p3[1] - p1[1]) / 6)} ${round2(p2[0])} ${round2(p2[1])}`;
  }
  return `${d}Z`;
}

function samplePolar(fn: (theta: number) => [number, number], count = 96): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    pts.push(fn((i / count) * TWO_PI));
  }
  return catmullRomClosed(pts);
}

function roundedPolygon(pts: Array<[number, number]>, r: number | number[]): string {
  const pb = new PathBuilder();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const rad = typeof r === "number" ? r : r[i % r.length];
    pb.corner(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n], rad);
  }
  return pb.close();
}

function superellipsePath(rx: number, ry: number, exp: number): string {
  return samplePolar((t) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [
      CENTER + Math.sign(c) * Math.pow(Math.abs(c), 2 / exp) * rx,
      CENTER + Math.sign(s) * Math.pow(Math.abs(s), 2 / exp) * ry,
    ];
  });
}

function metaballUnion(circles: Array<[number, number, number]>): string {
  return samplePolar((theta) => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let maxDist = 0;
    for (const [cx, cy, r] of circles) {
      const dx = cx - CENTER;
      const dy = cy - CENTER;
      const proj = c * dx + s * dy;
      const disc = proj * proj - (dx * dx + dy * dy) + r * r;
      if (disc <= 0) continue;
      const d = proj + Math.sqrt(disc);
      if (d > maxDist) maxDist = d;
    }
    return [CENTER + c * maxDist, CENTER + s * maxDist];
  }, 120);
}

const SHAPE_CACHE = new Map<string, string>();

function getShapeSvgPath(shape: string): string {
  const cached = SHAPE_CACHE.get(shape);
  if (cached) return cached;

  const x = CENTER;
  let path: string;

  switch (shape) {
    case "pebble":
      path = samplePolar((t) => {
        const r = 104 * (1 + 0.075 * (Math.sin(t * 2 + 1.1) * 0.6 + Math.sin(t * 3 - 1.1) * 0.4));
        return [x + Math.cos(t) * r, x + Math.sin(t) * r * 0.98];
      });
      break;
    case "bean":
      path = samplePolar((t) => {
        const gauss = (a: number) => {
          const d = Math.abs(((t - a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI);
          return Math.exp(-(d * d) / 0.4232);
        };
        const k = 1 - 0.34 * gauss(Math.PI) + 0.34 * 0.34 * gauss(TWO_PI);
        return [x + Math.cos(t) * 94 * k, x + Math.sin(t) * 108 * k];
      });
      break;
    case "egg":
      path = samplePolar((t) => {
        const c = Math.cos(t);
        const s = Math.sin(t);
        const u = (1 - s) / 2;
        return [x + c * 96 * (1 - 0.22 * u * u), x + s * 108];
      });
      break;
    case "squircle":
      path = superellipsePath(104, 104, 3.2);
      break;
    case "square":
      path = roundedPolygon(
        [
          [x - 102, x - 102],
          [x + 102, x - 102],
          [x + 102, x + 102],
          [x - 102, x + 102],
        ],
        28
      );
      break;
    case "tablet":
      path = new PathBuilder()
        .move(x - 108 + 72, x - 72)
        .line(x + 108 - 72, x - 72)
        .arc(x + 108 - 72, x, 72, 72, -Math.PI / 2, Math.PI / 2)
        .line(x - 108 + 72, x + 72)
        .arc(x - 108 + 72, x, 72, 72, Math.PI / 2, (Math.PI * 3) / 2)
        .close();
      break;
    case "capsule":
      path = new PathBuilder()
        .move(x - 70, x + 106 - 70)
        .line(x - 70, x - 106 + 70)
        .arc(x, x - 106 + 70, 70, 70, Math.PI, TWO_PI)
        .line(x + 70, x + 106 - 70)
        .arc(x, x + 106 - 70, 70, 70, 0, Math.PI)
        .close();
      break;
    case "cylinder":
      path = new PathBuilder()
        .move(x - 90, x - 104 + 44)
        .arc(x, x - 104 + 44, 90, 44, Math.PI, TWO_PI)
        .line(x + 90, x + 104 - 44)
        .arc(x, x + 104 - 44, 90, 44, 0, Math.PI)
        .close();
      break;
    case "hex":
      path = roundedPolygon(
        Array.from({ length: 6 }, (_, i) => {
          const ang = Math.PI / 6 + (i / 6) * TWO_PI;
          return [x + Math.cos(ang) * 108, x + Math.sin(ang) * 108] as [number, number];
        }),
        20
      );
      break;
    case "gem":
      path = superellipsePath(106, 106, 1.5);
      break;
    case "crystal":
      path = roundedPolygon(
        Array.from({ length: 8 }, (_, i) => {
          const ang = -Math.PI / 2 + (i / 8) * TWO_PI;
          const r = i % 2 === 0 ? 108 : 88;
          return [x + Math.cos(ang) * r * 0.85, x + Math.sin(ang) * r] as [number, number];
        }),
        12
      );
      break;
    case "wedge":
      path = roundedPolygon(
        Array.from({ length: 3 }, (_, i) => {
          const ang = -Math.PI / 2 + (i / 3) * TWO_PI;
          return [x + Math.cos(ang) * 116, x + 16 + Math.sin(ang) * 116] as [number, number];
        }),
        [52, 42, 42]
      );
      break;
    case "shield": {
      const top = x - 102;
      const bot = x + 104;
      path = new PathBuilder()
        .move(x - 94, top + 28)
        .curve(x - 94, top - 2, x - 47, top - 10, x, top - 10)
        .curve(x + 47, top - 10, x + 94, top - 2, x + 94, top + 28)
        .curve(x + 94, x + 44, x + 58, bot, x, bot)
        .curve(x - 58, bot, x - 94, x + 44, x - 94, top + 28)
        .close();
      break;
    }
    case "dome": {
      const b = x + 80;
      path = new PathBuilder()
        .move(x - 106, b - 26)
        .arc(x, b - 26, 106, 134, Math.PI, TWO_PI)
        .line(x + 106, b - 26)
        .curve(x + 106, b, x + 106, b, x + 106 - 26, b)
        .line(x - 106 + 26, b)
        .curve(x - 106, b, x - 106, b, x - 106, b - 26)
        .close();
      break;
    }
    case "arch": {
      const b = x + 104;
      const o = x - 104 + 74;
      path = new PathBuilder()
        .move(x - 74, o)
        .arc(x, o, 74, 74, Math.PI, TWO_PI)
        .line(x + 74, b - 38)
        .curve(x + 74, b, x + 74, b, x + 74 - 38, b)
        .line(x - 74 + 38, b)
        .curve(x - 74, b, x - 74, b, x - 74, b - 38)
        .close();
      break;
    }
    case "cloud":
      path = metaballUnion([
        [x - 56, x + 22, 52],
        [x + 56, x + 22, 50],
        [x, x + 30, 58],
        [x - 22, x - 26, 58],
        [x + 34, x - 22, 50],
      ]);
      break;
    case "teardrop":
      path = samplePolar((t) => {
        const c = Math.cos(t);
        const s = Math.sin(t);
        const squeeze = 1 - 0.35 * Math.pow((1 - s) / 2, 1.8);
        return [x + c * 96 * squeeze, x + s * 106];
      });
      break;
    case "leaf":
      path = samplePolar((t) => {
        const c = Math.cos(t);
        const s = Math.sin(t);
        return [x + c * 86 * Math.pow(Math.max(1 - s * s, 0), 0.25), x + s * 106];
      });
      break;
    case "clover":
      path = metaballUnion([
        [x - 36, x - 36, 54],
        [x + 36, x - 36, 54],
        [x + 36, x + 36, 54],
        [x - 36, x + 36, 54],
      ]);
      break;
    case "flower":
      path = samplePolar((t) => {
        const r = 92 + 18 * Math.cos(t * 5);
        return [x + Math.cos(t) * r, x + Math.sin(t) * r];
      });
      break;
    case "heart":
      path = samplePolar((t) => {
        const sx = 16 * Math.pow(Math.sin(t), 3);
        const sy = -(
          13 * Math.cos(t) -
          5 * Math.cos(2 * t) -
          2 * Math.cos(3 * t) -
          Math.cos(4 * t)
        );
        return [x + sx * 6.2, x + 10 + sy * 6.2];
      });
      break;
    case "house":
      path = roundedPolygon(
        [
          [x - 94, x + 102],
          [x + 94, x + 102],
          [x + 94, x - 26],
          [x, x - 104],
          [x - 94, x - 26],
        ],
        28
      );
      break;
    case "sparkle":
      path = samplePolar((t) => {
        const r = 68 + 38 * Math.pow(Math.cos(t * 2), 2);
        return [x + Math.cos(t) * r, x + Math.sin(t) * r];
      });
      break;
    case "star":
      path = roundedPolygon(
        Array.from({ length: 12 }, (_, i) => {
          const ang = -Math.PI / 2 + (i / 12) * TWO_PI;
          const r = i % 2 === 0 ? 110 : 66;
          return [x + Math.cos(ang) * r, x + Math.sin(ang) * r] as [number, number];
        }),
        14
      );
      break;
    case "blob":
    default:
      path = samplePolar((t) => {
        const r = 104 * (1 + 0.04 * Math.sin(t * 3 + 0.7));
        return [x + Math.cos(t) * r, x + Math.sin(t) * r];
      });
      break;
  }

  SHAPE_CACHE.set(shape, path);
  return path;
}

export interface BotCharacterAvatarProps {
  bot?: {
    name?: string;
    shape?: BotShape | string;
    color?: BotColor | string;
    isPrimary?: boolean;
    cliDriver?: CliDriverKind;
  };
  shape?: BotShape | string;
  color?: BotColor | string;
  isPrimary?: boolean;
  cliDriver?: CliDriverKind;
  size?: number;
  isStreaming?: boolean;
  showStarBadge?: boolean;
  showCliBadge?: boolean;
  useHeroMascot?: boolean;
  className?: string;
}

function resolveEffectiveMascotShape(
  rawShape: string,
  isPrimary: boolean,
  useHeroMascot: boolean,
  cliDriver?: CliDriverKind
): string {
  if (isPrimary || useHeroMascot || rawShape === "omni-prism") {
    return "omni-prism";
  }
  if (rawShape.includes("-")) {
    return rawShape;
  }
  // If using legacy default shape for a known CLI driver, upgrade to its provider-logo Bot PFP
  if (cliDriver) {
    switch (cliDriver) {
      case "claude":
        if (rawShape === "squircle") return "claude-spark";
        break;
      case "codex":
        if (rawShape === "hex") return "codex-bloom";
        break;
      case "opencode":
        if (rawShape === "blob") return "opencode-terminal";
        break;
      case "cursor":
        if (rawShape === "gem") return "cursor-cube";
        break;
      case "grok":
        if (rawShape === "star") return "grok-orbit";
        break;
      case "pi":
        if (rawShape === "pebble") return "pi-crest";
        break;
      case "gemini":
        if (rawShape === "sparkle") return "gemini-star";
        break;
      case "ollama":
        if (rawShape === "cloud") return "ollama-llama";
        break;
      case "aider":
        if (rawShape === "shield") return "aider-git";
        break;
    }
  }
  return rawShape;
}

/**
 * Custom Provider-Logo Bot PFP & Grok Bot Procedural Character Avatar Engine.
 * Each provider (Omni, Claude, Codex, Grok, Cursor, OpenCode, Pi, Gemini, Ollama, Aider)
 * has a bespoke, logo-inspired Bot mascot with animated blinking & gaze eyes.
 */
export function BotCharacterAvatar({
  bot,
  shape: propShape,
  color: propColor,
  isPrimary: propIsPrimary,
  cliDriver: propCliDriver,
  size = 44,
  isStreaming = false,
  showStarBadge = false,
  showCliBadge = false,
  useHeroMascot = false,
  className = "",
}: BotCharacterAvatarProps): React.ReactElement {
  const uid = useId().replace(/:/g, "");
  const isPrimary = propIsPrimary ?? bot?.isPrimary ?? false;
  const cliDriver = propCliDriver ?? bot?.cliDriver;
  const rawShape = propShape ?? bot?.shape ?? (isPrimary ? "omni-prism" : "blob");
  const color = propColor ?? bot?.color ?? "cyan";

  const effectiveShape = resolveEffectiveMascotShape(
    rawShape,
    isPrimary,
    useHeroMascot,
    cliDriver
  );

  const [isBlinking, setIsBlinking] = useState(false);

  useEffect(() => {
    const delay = 2600 + Math.random() * 4200;
    const timer = setTimeout(() => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 145);
    }, delay);
    return () => clearTimeout(timer);
  }, [isBlinking]);

  const palette = useMemo(
    () => BOT_COLORS.find((c) => c.id === color) ?? BOT_COLORS[0],
    [color]
  );

  const eyeScaleY = isBlinking ? 0.14 : isStreaming ? 0.84 : 1;
  const eyeShiftX = isStreaming ? 4 : 0;

  return (
    <div
      className={`relative inline-flex items-center justify-center select-none shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 240 240"
        className={`overflow-visible transition-transform duration-300 ${
          isStreaming ? "scale-[1.05]" : ""
        }`}
      >
        {renderProviderOrCustomMascot(
          effectiveShape,
          uid,
          palette,
          eyeScaleY,
          eyeShiftX
        )}
      </svg>

      {showStarBadge && (
        <span
          className="absolute flex items-center justify-center rounded-full bg-gradient-to-br from-[#38BDF8] to-[#6366F1] text-white shadow-md ring-2 ring-[#0e0e0e]"
          style={{
            width: Math.max(14, Math.round(size * 0.28)),
            height: Math.max(14, Math.round(size * 0.28)),
            right: -1,
            bottom: -1,
          }}
        >
          <Sparkles
            style={{
              width: Math.max(8, Math.round(size * 0.16)),
              height: Math.max(8, Math.round(size * 0.16)),
            }}
          />
        </span>
      )}

      {showCliBadge && cliDriver && !showStarBadge && (
        <span
          className="absolute flex items-center justify-center rounded-full bg-[#141418] text-white shadow-md ring-2 ring-[#0e0e0e]"
          style={{
            width: Math.max(15, Math.round(size * 0.34)),
            height: Math.max(15, Math.round(size * 0.34)),
            right: -2,
            bottom: -2,
          }}
        >
          <CliProviderGlyph
            driver={cliDriver}
            size={Math.max(9, Math.round(size * 0.2))}
          />
        </span>
      )}
    </div>
  );
}

function renderBotEyes(
  cx: number,
  cy: number,
  eyeScaleY: number,
  eyeShiftX: number,
  eyeColor = "#09090B",
  glintColor = "#FFFFFF",
  gap = 24,
  w = 16,
  h = 34
) {
  const actualH = Math.max(4, h * eyeScaleY);
  const topY = cy - actualH / 2;
  const leftX = cx - gap - w / 2 + eyeShiftX;
  const rightX = cx + gap - w / 2 + eyeShiftX;

  return (
    <g style={{ transition: "all 140ms ease" }}>
      <rect x={leftX} y={topY} width={w} height={actualH} rx={w / 2} fill={eyeColor} />
      <rect x={rightX} y={topY} width={w} height={actualH} rx={w / 2} fill={eyeColor} />
      {eyeScaleY > 0.4 && (
        <>
          <circle cx={leftX + w * 0.36} cy={topY + actualH * 0.26} r={w * 0.18} fill={glintColor} opacity={0.9} />
          <circle cx={rightX + w * 0.36} cy={topY + actualH * 0.26} r={w * 0.18} fill={glintColor} opacity={0.9} />
        </>
      )}
    </g>
  );
}

function renderProviderOrCustomMascot(
  shape: string,
  uid: string,
  palette: { from: string; to: string },
  eyeScaleY: number,
  eyeShiftX: number
): React.ReactNode {
  switch (shape) {
    // 1. OMNI PRISM BOT (Bespoke Lead Coordinator Mascot)
    case "omni-prism":
      return (
        <g>
          <defs>
            <linearGradient id={`omni-b-${uid}`} x1="30" y1="20" x2="210" y2="220" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#A855F7" />
              <stop offset="48%" stopColor="#6366F1" />
              <stop offset="100%" stopColor="#06B6D4" />
            </linearGradient>
            <linearGradient id={`omni-r-${uid}`} x1="16" y1="120" x2="224" y2="120" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F97316" />
              <stop offset="45%" stopColor="#EC4899" />
              <stop offset="100%" stopColor="#22D3EE" />
            </linearGradient>
          </defs>
          {/* Back orbital arc */}
          <g transform="rotate(-18 120 124)">
            <path d="M 18 124 A 102 36 0 0 1 222 124" stroke={`url(#omni-r-${uid})`} strokeWidth="8" strokeOpacity="0.4" fill="none" />
          </g>
          {/* Antenna */}
          <path d="M 120 22 L 120 42" stroke="#67E8F9" strokeWidth="6" strokeLinecap="round" />
          <circle cx="120" cy="18" r="9" fill="#67E8F9" />
          {/* Sculpted Prism Head */}
          <path
            d="M 120 38 C 168 38, 202 68, 206 114 C 210 156, 192 198, 162 214 C 144 224, 132 226, 120 226 C 108 226, 96 224, 78 214 C 48 198, 30 156, 34 114 C 38 68, 72 38, 120 38 Z"
            fill={`url(#omni-b-${uid})`}
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="3"
          />
          {/* Inner Visor */}
          <rect x="58" y="88" width="124" height="68" rx="32" fill="#0B0B14" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
          {renderBotEyes(120, 122, eyeScaleY, eyeShiftX, "#67E8F9", "#FFFFFF", 22, 16, 32)}
          {/* Front orbital arc + satellite nodes */}
          <g transform="rotate(-18 120 124)">
            <path d="M 222 124 A 102 36 0 0 1 18 124" stroke={`url(#omni-r-${uid})`} strokeWidth="9" strokeLinecap="round" fill="none" />
            <circle cx="22" cy="124" r="9" fill="#F97316" stroke="#0E0E14" strokeWidth="3" />
            <circle cx="218" cy="124" r="9" fill="#10B981" stroke="#0E0E14" strokeWidth="3" />
            <circle cx="120" cy="160" r="8" fill="#22D3EE" stroke="#0E0E14" strokeWidth="3" />
          </g>
        </g>
      );

    // 2. CLAUDE SPARK BOT (Anthropic 12-Ray Sunburst Mascot)
    case "claude-spark": {
      const rays = 12;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < rays * 2; i++) {
        const ang = -Math.PI / 2 + (i / (rays * 2)) * TWO_PI;
        const r = i % 2 === 0 ? 108 : 74;
        pts.push([120 + Math.cos(ang) * r, 120 + Math.sin(ang) * r]);
      }
      const burstPath = roundedPolygon(pts, 11);
      return (
        <g>
          <defs>
            <linearGradient id={`claude-${uid}`} x1="24" y1="20" x2="216" y2="220" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F59E7A" />
              <stop offset="50%" stopColor="#D97757" />
              <stop offset="100%" stopColor="#A64629" />
            </linearGradient>
          </defs>
          <path
            d={burstPath}
            fill={`url(#claude-${uid})`}
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="3"
          />
          <circle cx="120" cy="122" r="56" fill="#23120B" fillOpacity="0.22" />
          {renderBotEyes(120, 120, eyeScaleY, eyeShiftX, "#180C07", "#FFD8C7", 22, 16, 34)}
        </g>
      );
    }

    // 3. CODEX BLOOM BOT (OpenAI 6-Fold Interlocking Hexagonal Blossom Mascot)
    case "codex-bloom": {
      const lobes: Array<[number, number, number]> = [[120, 120, 68]];
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * TWO_PI;
        lobes.push([120 + Math.cos(ang) * 44, 120 + Math.sin(ang) * 44, 54]);
      }
      const bloomPath = metaballUnion(
        lobes.map(([cx, cy, r]) => [cx - 120 + CENTER, cy - 120 + CENTER, r])
      );
      return (
        <g>
          <defs>
            <linearGradient id={`codex-${uid}`} x1="24" y1="24" x2="216" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#34D399" />
              <stop offset="55%" stopColor="#10A37F" />
              <stop offset="100%" stopColor="#065F46" />
            </linearGradient>
          </defs>
          <g transform={`translate(${120 - CENTER}, ${120 - CENTER})`}>
            <path
              d={bloomPath}
              fill={`url(#codex-${uid})`}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth="3.5"
            />
          </g>
          {/* OpenAI Geometric Knot Inner Hexagon Ring */}
          <polygon
            points="120,56 175,88 175,152 120,184 65,152 65,88"
            fill="#052E22"
            fillOpacity="0.45"
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          {renderBotEyes(120, 120, eyeScaleY, eyeShiftX, "#ECFDF5", "#FFFFFF", 22, 15, 32)}
        </g>
      );
    }

    // 4. GROK ORBIT BOT (xAI Monochrome Black-Hole + Diagonal Orbital Slash Mascot)
    case "grok-orbit":
      return (
        <g>
          <defs>
            <linearGradient id={`grok-b-${uid}`} x1="36" y1="30" x2="204" y2="210" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#3F3F46" />
              <stop offset="45%" stopColor="#18181B" />
              <stop offset="100%" stopColor="#09090B" />
            </linearGradient>
            <linearGradient id={`grok-s-${uid}`} x1="20" y1="200" x2="220" y2="30" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#A1A1AA" />
              <stop offset="50%" stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#FFFFFF" />
            </linearGradient>
          </defs>
          {/* Monochrome Event-Horizon Sphere */}
          <circle
            cx="120"
            cy="122"
            r="88"
            fill={`url(#grok-b-${uid})`}
            stroke="rgba(255,255,255,0.32)"
            strokeWidth="4"
          />
          {/* Iconic Grok Diagonal Orbital Accretion Slash */}
          <path
            d="M 28 188 C 68 174, 154 114, 214 34"
            stroke={`url(#grok-s-${uid})`}
            strokeWidth="12"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 48 86 A 76 76 0 0 1 182 76"
            stroke="#FFFFFF"
            strokeOpacity="0.28"
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
          />
          {renderBotEyes(120, 124, eyeScaleY, eyeShiftX, "#FFFFFF", "#E4E4E7", 23, 15, 33)}
        </g>
      );

    // 5. CURSOR CUBE BOT (Cursor 3D Isometric Cube + Pointer Chevron Mascot)
    case "cursor-cube":
      return (
        <g>
          <defs>
            <linearGradient id={`cur-top-${uid}`} x1="120" y1="20" x2="120" y2="120" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#93C5FD" />
              <stop offset="100%" stopColor="#3B82F6" />
            </linearGradient>
            <linearGradient id={`cur-left-${uid}`} x1="30" y1="70" x2="120" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#3B82F6" />
              <stop offset="100%" stopColor="#1D4ED8" />
            </linearGradient>
            <linearGradient id={`cur-right-${uid}`} x1="120" y1="70" x2="210" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#2563EB" />
              <stop offset="100%" stopColor="#1E3A8A" />
            </linearGradient>
          </defs>
          {/* 3D Isometric Cube Silhouette */}
          <polygon points="120,22 208,72 120,122 32,72" fill={`url(#cur-top-${uid})`} />
          <polygon points="32,72 120,122 120,220 32,170" fill={`url(#cur-left-${uid})`} />
          <polygon points="208,72 120,122 120,220 208,170" fill={`url(#cur-right-${uid})`} />
          <polygon
            points="120,22 208,72 208,170 120,220 32,170 32,72"
            fill="none"
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="3.5"
            strokeLinejoin="round"
          />
          {/* Iconic Cursor Pointer Arrow Emblem on Top Facet */}
          <path d="M 102 54 L 146 68 L 122 76 L 114 96 Z" fill="#FFFFFF" fillOpacity="0.92" />
          {/* Front Visor Across Cube Center */}
          <rect x="58" y="106" width="124" height="64" rx="28" fill="#09152E" stroke="rgba(255,255,255,0.28)" strokeWidth="2.5" />
          {renderBotEyes(120, 138, eyeScaleY, eyeShiftX, "#60A5FA", "#FFFFFF", 22, 15, 30)}
        </g>
      );

    // 6. OPENCODE TERMINAL BOT (OpenCode `>_` Terminal Keycap Mascot)
    case "opencode-terminal":
      return (
        <g>
          <defs>
            <linearGradient id={`oc-${uid}`} x1="24" y1="24" x2="216" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#67E8F9" />
              <stop offset="50%" stopColor="#06B6D4" />
              <stop offset="100%" stopColor="#0E7490" />
            </linearGradient>
          </defs>
          {/* Outer Keycap / Terminal Block */}
          <rect
            x="24"
            y="28"
            width="192"
            height="184"
            rx="46"
            fill={`url(#oc-${uid})`}
            stroke="rgba(255,255,255,0.26)"
            strokeWidth="3.5"
          />
          {/* Inner Recessed Terminal Screen */}
          <rect
            x="44"
            y="52"
            width="152"
            height="136"
            rx="32"
            fill="#081C24"
            stroke="rgba(103,232,249,0.35)"
            strokeWidth="2.5"
          />
          {/* Terminal `>_` Prompt Crest in Top-Left of Screen */}
          <path
            d="M 64 72 L 76 80 L 64 88 M 82 88 L 96 88"
            stroke="#22D3EE"
            strokeWidth="4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          {renderBotEyes(120, 126, eyeScaleY, eyeShiftX, "#67E8F9", "#FFFFFF", 24, 16, 34)}
        </g>
      );

    // 7. PI CREST BOT (Pi Mathematical Symbol Mascot)
    case "pi-crest":
      return (
        <g>
          <defs>
            <linearGradient id={`pi-${uid}`} x1="30" y1="24" x2="210" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#D8B4FE" />
              <stop offset="50%" stopColor="#9333EA" />
              <stop offset="100%" stopColor="#4C1D95" />
            </linearGradient>
          </defs>
          {/* Sculpted Body */}
          <circle
            cx="120"
            cy="128"
            r="84"
            fill={`url(#pi-${uid})`}
            stroke="rgba(255,255,255,0.24)"
            strokeWidth="3.5"
          />
          {/* Iconic Sweeping Pi (π) Crown */}
          <path
            d="M 52 54 C 74 36, 166 36, 188 50"
            stroke="#F3E8FF"
            strokeWidth="14"
            strokeLinecap="round"
            fill="none"
          />
          <path d="M 88 46 L 82 78 M 152 46 L 158 78" stroke="#F3E8FF" strokeWidth="10" strokeLinecap="round" />
          {renderBotEyes(120, 130, eyeScaleY, eyeShiftX, "#1E0936", "#F3E8FF", 23, 16, 34)}
        </g>
      );

    // 8. GEMINI STAR BOT (Google Gemini 4-Point Concave Sparkle Mascot)
    case "gemini-star": {
      const starPath = samplePolar((t) => {
        const r = 74 + 38 * Math.pow(Math.cos(t * 2), 2);
        return [120 + Math.cos(t) * r, 124 + Math.sin(t) * r];
      });
      return (
        <g>
          <defs>
            <linearGradient id={`gem-${uid}`} x1="24" y1="24" x2="216" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#60A5FA" />
              <stop offset="52%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#F43F5E" />
            </linearGradient>
          </defs>
          <path
            d={starPath}
            fill={`url(#gem-${uid})`}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth="3.5"
          />
          {/* Twin Mini Gemini Sparkle at Top Right */}
          <path
            d="M 192 22 Q 192 42 212 42 Q 192 42 192 62 Q 192 42 172 42 Q 192 42 192 22 Z"
            fill="#93C5FD"
          />
          {renderBotEyes(120, 124, eyeScaleY, eyeShiftX, "#0F172A", "#FFFFFF", 20, 15, 32)}
        </g>
      );
    }

    // 9. OLLAMA LLAMA BOT (Perked Llama Ears Mascot)
    case "ollama-llama":
      return (
        <g>
          <defs>
            <linearGradient id={`llama-${uid}`} x1="36" y1="20" x2="204" y2="220" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F9A8D4" />
              <stop offset="50%" stopColor="#EC4899" />
              <stop offset="100%" stopColor="#9D174D" />
            </linearGradient>
          </defs>
          {/* Left & Right Perked Llama Ears */}
          <rect x="54" y="18" width="34" height="68" rx="17" transform="rotate(-10 71 52)" fill={`url(#llama-${uid})`} stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
          <rect x="152" y="18" width="34" height="68" rx="17" transform="rotate(10 169 52)" fill={`url(#llama-${uid})`} stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
          {/* Fluffy Llama Head */}
          <rect x="34" y="56" width="172" height="158" rx="68" fill={`url(#llama-${uid})`} stroke="rgba(255,255,255,0.24)" strokeWidth="3.5" />
          {/* Cute Rounded Snout */}
          <rect x="94" y="148" width="52" height="36" rx="18" fill="#500724" fillOpacity="0.35" />
          {renderBotEyes(120, 118, eyeScaleY, eyeShiftX, "#2E0516", "#FCE7F3", 26, 16, 34)}
        </g>
      );

    // 10. AIDER GIT BOT (Git Branch Nodes + Shield Mascot)
    case "aider-git": {
      const shieldPath = getShapeSvgPath("shield");
      return (
        <g>
          <defs>
            <linearGradient id={`aider-${uid}`} x1="30" y1="24" x2="210" y2="216" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#FCD34D" />
              <stop offset="55%" stopColor="#F59E0B" />
              <stop offset="100%" stopColor="#B45309" />
            </linearGradient>
          </defs>
          <g transform={`translate(${120 - CENTER}, ${124 - CENTER})`}>
            <path d={shieldPath} fill={`url(#aider-${uid})`} stroke="rgba(255,255,255,0.24)" strokeWidth="3.5" />
          </g>
          {/* Git Branch Antennae */}
          <path d="M 96 58 L 120 76 L 144 58" stroke="#451A03" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx="96" cy="56" r="7" fill="#FEF3C7" stroke="#451A03" strokeWidth="3" />
          <circle cx="144" cy="56" r="7" fill="#FEF3C7" stroke="#451A03" strokeWidth="3" />
          {renderBotEyes(120, 126, eyeScaleY, eyeShiftX, "#271002", "#FEF3C7", 22, 16, 34)}
        </g>
      );
    }

    // Fallback: Classic Grok Bot Procedural Mathematical Shapes
    default: {
      const svgPath = getShapeSvgPath(shape);
      return (
        <g transform={`translate(${120 - CENTER}, ${120 - CENTER})`}>
          <defs>
            <linearGradient id={`custom-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={palette.from} />
              <stop offset="100%" stopColor={palette.to} />
            </linearGradient>
          </defs>
          <path
            d={svgPath}
            fill={`url(#custom-${uid})`}
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="4"
          />
          {renderBotEyes(CENTER, CENTER - 4, eyeScaleY, eyeShiftX, "#09090B", "#FFFFFF", 24, 17, 36)}
        </g>
      );
    }
  }
}

export function CliProviderGlyph({
  driver,
  size = 15,
  className = "",
}: {
  driver: CliDriverKind | string;
  size?: number;
  className?: string;
}): React.ReactElement {
  const d = driver.toLowerCase();
  const style = { width: size, height: size };

  if (d === "claude") {
    return <ClaudeIcon style={style} className={`text-[#d97757] ${className}`} />;
  }
  if (d === "codex") {
    return <OpenaiIcon style={style} className={`text-emerald-400 ${className}`} />;
  }
  if (d === "grok") {
    return <GrokIcon style={style} className={`text-zinc-100 ${className}`} />;
  }
  if (d === "gemini") {
    return <GeminiIcon style={style} className={`text-blue-400 ${className}`} />;
  }
  if (d === "opencode") {
    return <Terminal style={style} className={`text-[#8cf1fb] ${className}`} />;
  }
  if (d === "cursor") {
    return <Code2 style={style} className={`text-sky-400 ${className}`} />;
  }
  if (d === "pi") {
    return <Cpu style={style} className={`text-violet-400 ${className}`} />;
  }
  if (d === "aider") {
    return <GitBranch style={style} className={`text-amber-400 ${className}`} />;
  }
  return <Sparkles style={style} className={`text-cyan-300 ${className}`} />;
}

export function CliBrandBadge({
  driver,
  size = 40,
  rounded = "rounded-xl",
}: {
  driver: CliDriverKind | string;
  size?: number;
  rounded?: string;
}): React.ReactElement {
  const d = driver.toLowerCase();
  const boxStyle = { width: size, height: size };
  const svgSize = Math.round(size * 0.52);

  if (d === "claude") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-[#d97757]/15 border border-[#d97757]/30 text-[#d97757] flex items-center justify-center shrink-0 shadow-sm`}
      >
        <ClaudeIcon style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (d === "codex") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-emerald-500/15 border border-emerald-400/30 text-emerald-400 flex items-center justify-center shrink-0 shadow-sm`}
      >
        <OpenaiIcon style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (d === "opencode") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-[#8cf1fb]/15 border border-[#8cf1fb]/30 text-[#8cf1fb] flex items-center justify-center shrink-0 shadow-sm`}
      >
        <Terminal style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (d === "cursor") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-blue-500/15 border border-blue-400/30 text-blue-400 flex items-center justify-center shrink-0 shadow-sm`}
      >
        <Code2 style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (d === "grok") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-white/10 border border-white/20 text-white flex items-center justify-center shrink-0 shadow-sm`}
      >
        <GrokIcon style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (d === "pi") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-violet-500/15 border border-violet-400/30 text-violet-300 flex items-center justify-center shrink-0 shadow-sm`}
      >
        <Cpu style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (d === "gemini") {
    return (
      <div
        style={boxStyle}
        className={`${rounded} bg-sky-500/15 border border-sky-400/30 text-sky-300 flex items-center justify-center shrink-0 shadow-sm`}
      >
        <GeminiIcon style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  return (
    <div
      style={boxStyle}
      className={`${rounded} bg-cyan-500/12 border border-cyan-400/25 text-cyan-300 flex items-center justify-center shrink-0 shadow-sm`}
    >
      <Globe style={{ width: svgSize, height: svgSize }} />
    </div>
  );
}

export function SkillBrandIcon({
  name,
  size = 38,
}: {
  name: string;
  size?: number;
}): React.ReactElement {
  const boxStyle = { width: size, height: size };
  const svgSize = Math.round(size * 0.52);
  const lower = name.toLowerCase();

  if (lower.includes("security") || lower.includes("auth") || lower.includes("op-")) {
    return (
      <div
        style={boxStyle}
        className="rounded-xl bg-emerald-500/14 border border-emerald-400/25 text-emerald-300 flex items-center justify-center shrink-0"
      >
        <ShieldCheck style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (lower.includes("design") || lower.includes("canvas") || lower.includes("visualize")) {
    return (
      <div
        style={boxStyle}
        className="rounded-xl bg-purple-500/14 border border-purple-400/25 text-purple-300 flex items-center justify-center shrink-0"
      >
        <Palette style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (lower.includes("code") || lower.includes("trpc") || lower.includes("sdk") || lower.includes("pr")) {
    return (
      <div
        style={boxStyle}
        className="rounded-xl bg-blue-500/14 border border-blue-400/25 text-blue-300 flex items-center justify-center shrink-0"
      >
        <Code2 style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (lower.includes("databricks") || lower.includes("data") || lower.includes("sql")) {
    return (
      <div
        style={boxStyle}
        className="rounded-xl bg-cyan-500/14 border border-cyan-400/25 text-cyan-300 flex items-center justify-center shrink-0"
      >
        <BarChart3 style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (lower.includes("doc") || lower.includes("pdf") || lower.includes("pptx") || lower.includes("xlsx")) {
    return (
      <div
        style={boxStyle}
        className="rounded-xl bg-sky-500/14 border border-sky-400/25 text-sky-300 flex items-center justify-center shrink-0"
      >
        <FileCode2 style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }
  if (lower.includes("git") || lower.includes("repo") || lower.includes("origin")) {
    return (
      <div
        style={boxStyle}
        className="rounded-xl bg-[#8cf1fb]/14 border border-[#8cf1fb]/25 text-[#8cf1fb] flex items-center justify-center shrink-0"
      >
        <FolderGit2 style={{ width: svgSize, height: svgSize }} />
      </div>
    );
  }

  return (
    <div
      style={boxStyle}
      className="rounded-xl bg-[#1afafd]/12 border border-[#1afafd]/25 text-[#1afafd] flex items-center justify-center shrink-0"
    >
      <Bot style={{ width: svgSize, height: svgSize }} />
    </div>
  );
}
