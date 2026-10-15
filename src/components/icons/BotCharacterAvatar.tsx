import {
  AcpLogoIcon,
  ClaudeIcon,
  CursorLogoIcon,
  GeminiIcon,
  GrokIcon,
  MuseLogoIcon,
  OllamaLogoIcon,
  OpenaiIcon,
  OpencodeLogoIcon,
  PiLogoIcon,
} from "./OmarchyIcons";
import {
  BarChart3,
  Bot,
  Code2,
  FileCode2,
  FolderGit2,
  Palette,
  ShieldCheck,
  Star,
} from "lucide-react";
import { avatarSource } from "../../lib/avatar";
import type React from "react";
import { useId, useMemo } from "react";
import type { BotColor, BotShape, CliDriverKind, OpenString } from "../../lib/types";


export const BOT_SHAPES: Array<{ id: BotShape; label: string }> = [
  { id: "blob", label: "Blob" },
  { id: "claude-spark", label: "Sunburst (Claude)" },
  { id: "codex-bloom", label: "Bloom (Codex)" },
  { id: "cursor-cube", label: "Hex Cube (Cursor)" },
  { id: "grok-orbit", label: "Star12 (Grok)" },
  { id: "opencode-terminal", label: "Squircle (OpenCode)" },
  { id: "pi-crest", label: "Clover (Pi)" },
  { id: "gemini-star", label: "Sparkle (Gemini)" },
  { id: "ollama-llama", label: "Cloud (Ollama)" },
  { id: "aider-git", label: "Shield (Aider)" },
  { id: "pebble", label: "Pebble" },
  { id: "bean", label: "Bean" },
  { id: "egg", label: "Egg" },
  { id: "squircle", label: "Squircle" },
  { id: "tablet", label: "Tablet" },
  { id: "capsule", label: "Capsule" },
  { id: "cylinder", label: "Cylinder" },
  { id: "hex", label: "Hex" },
  { id: "gem", label: "Gem" },
  { id: "crystal", label: "Crystal" },
  { id: "wedge", label: "Wedge" },
  { id: "shield", label: "Shield" },
  { id: "dome", label: "Dome" },
  { id: "arch", label: "Arch" },
  { id: "cloud", label: "Cloud" },
  { id: "teardrop", label: "Teardrop" },
  { id: "leaf", label: "Leaf" },
  { id: "square", label: "Square" },
  { id: "sparkle", label: "Sparkle" },
  { id: "clover", label: "Clover" },
  { id: "flower", label: "Flower" },
  { id: "heart", label: "Heart" },
  { id: "house", label: "House" },
  { id: "star", label: "Star" },
];

export const BOT_COLORS: Array<{
  id: BotColor;
  label: string;
  from: string;
  to: string;
  swatch: string;
}> = [
  { id: "cyan", label: "Cyan", from: "#58D3C5", to: "#00A592", swatch: "#1CC3B0" },
  { id: "orange", label: "Terracotta", from: "#FF8838", to: "#D9653B", swatch: "#D97757" },
  { id: "green", label: "Emerald", from: "#1CCF82", to: "#009957", swatch: "#10A37F" },
  { id: "blue", label: "Azure", from: "#459FFE", to: "#0E74E0", swatch: "#1084FE" },
  { id: "violet", label: "Violet", from: "#B792FE", to: "#804EE0", swatch: "#9159FE" },
  { id: "magenta", label: "Magenta", from: "#FF77BE", to: "#E02A88", swatch: "#FF309B" },
  { id: "yellow", label: "Amber", from: "#FFAF38", to: "#E08600", swatch: "#FF9800" },
  { id: "red", label: "Crimson", from: "#FF5667", to: "#E02135", swatch: "#FF263C" },
  { id: "brown", label: "Bronze", from: "#AE8968", to: "#855C36", swatch: "#936439" },
  { id: "gray", label: "Silver", from: "#FFFFFF", to: "#A1A1AA", swatch: "#D4D4D8" },
  { id: "black", label: "Obsidian", from: "#52525B", to: "#27272A", swatch: "#3F3F46" },
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
    // Provider-inspired minimalist Grok Bot silhouettes
    case "claude-spark": {
      // 12-spoke organic Claude starburst silhouette
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < 24; i++) {
        const ang = -Math.PI / 2 + (i / 24) * TWO_PI;
        const r = i % 2 === 0 ? 108 : 78;
        pts.push([x + Math.cos(ang) * r, x + Math.sin(ang) * r]);
      }
      path = roundedPolygon(pts, 11);
      break;
    }
    case "codex-bloom": {
      // 6-lobed OpenAI hexagonal bloom silhouette
      const lobes: Array<[number, number, number]> = [[x, x, 68]];
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * TWO_PI;
        lobes.push([x + Math.cos(ang) * 42, x + Math.sin(ang) * 42, 56]);
      }
      path = metaballUnion(lobes);
      break;
    }
    case "cursor-cube":
    case "hex":
      path = roundedPolygon(
        Array.from({ length: 6 }, (_, i) => {
          const ang = Math.PI / 6 + (i / 6) * TWO_PI;
          return [x + Math.cos(ang) * 108, x + Math.sin(ang) * 108] as [number, number];
        }),
        20
      );
      break;
    case "grok-orbit":
    case "star":
      path = roundedPolygon(
        Array.from({ length: 12 }, (_, i) => {
          const ang = -Math.PI / 2 + (i / 12) * TWO_PI;
          const r = i % 2 === 0 ? 108 : 74;
          return [x + Math.cos(ang) * r, x + Math.sin(ang) * r] as [number, number];
        }),
        14
      );
      break;
    case "opencode-terminal":
    case "squircle":
      path = superellipsePath(104, 104, 3.2);
      break;
    case "pi-crest":
    case "clover":
      path = metaballUnion([
        [x - 36, x - 36, 54],
        [x + 36, x - 36, 54],
        [x + 36, x + 36, 54],
        [x - 36, x + 36, 54],
      ]);
      break;
    case "gemini-star":
    case "sparkle":
      path = samplePolar((t) => {
        const r = 74 + 34 * Math.pow(Math.cos(t * 2), 2);
        return [x + Math.cos(t) * r, x + Math.sin(t) * r];
      });
      break;
    case "ollama-llama":
    case "cloud":
      path = metaballUnion([
        [x - 56, x + 22, 52],
        [x + 56, x + 22, 50],
        [x, x + 30, 58],
        [x - 22, x - 26, 58],
        [x + 34, x - 22, 50],
      ]);
      break;
    case "aider-git":
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
    case "omni-prism":
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
    avatarImage?: string | null;
    shape?: OpenString<BotShape>;
    color?: OpenString<BotColor>;
    isPrimary?: boolean;
    cliDriver?: CliDriverKind;
  };
  shape?: OpenString<BotShape>;
  color?: OpenString<BotColor>;
  isPrimary?: boolean;
  cliDriver?: CliDriverKind;
  size?: number;
  isStreaming?: boolean;
  showStarBadge?: boolean;
  showCliBadge?: boolean;
  useHeroMascot?: boolean;
  className?: string;
}

const BLINK_CYCLE_MS = 6000;

// A per-instance phase offset keeps avatars on screen from blinking in unison.
function blinkDelayFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % BLINK_CYCLE_MS;
}

/**
 * Procedural character avatar:
 * Single clean silhouette + smooth 135° gradient + two solid dark capsule eyes.
 */
export function BotCharacterAvatar({
  bot,
  shape: propShape,
  color: propColor,
  isPrimary: propIsPrimary,
  cliDriver: propCliDriver,
  size = 44,
  isStreaming = false,
  showStarBadge: propShowStarBadge,
  showCliBadge: propShowCliBadge,
  className = "",
}: BotCharacterAvatarProps): React.ReactElement {
  const imageSource = avatarSource(bot?.avatarImage);
  const gradId = useId().replace(/:/g, "");
  const isPrimary = propIsPrimary ?? bot?.isPrimary ?? false;
  const cliDriver = propCliDriver ?? bot?.cliDriver;
  const showStarBadge = propShowStarBadge ?? (isPrimary && size >= 28);
  const showCliBadge =
    propShowCliBadge ?? (!isPrimary && Boolean(cliDriver) && size >= 28);
  const rawShape = propShape ?? bot?.shape ?? "blob";
  const effectiveShape =
    isPrimary && rawShape === "omni-prism" ? "blob" : rawShape;
  const color = propColor ?? bot?.color ?? "cyan";

  const blinkDelay = useMemo(() => blinkDelayFor(gradId), [gradId]);

  const palette = useMemo(
    () => BOT_COLORS.find((c) => c.id === color) ?? BOT_COLORS[0],
    [color]
  );

  const svgPath = useMemo(
    () => getShapeSvgPath(effectiveShape),
    [effectiveShape]
  );

  const eyeHeight = isStreaming ? 32 : 38;
  const eyeY = CENTER - eyeHeight / 2 - 4;
  const eyeOffsetX = isStreaming ? 4 : 0;

  return (
    <div
      className={`relative inline-flex items-center justify-center select-none shrink-0 ${isStreaming ? "bot-avatar-working" : ""} ${className}`}
      style={{ width: size, height: size }}
    >
      {imageSource ? <img src={imageSource} alt={`${bot?.name || "Bot"} profile picture`} width={size} height={size} className="h-full w-full object-contain rounded-[18%]" /> : <svg aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 228.54 228.54"
        className="overflow-visible transition-transform duration-300"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={palette.from} />
            <stop offset="100%" stopColor={palette.to} />
          </linearGradient>
        </defs>

        {/* Clean Minimalist Silhouette */}
        <path d={svgPath} fill={`url(#${gradId})`} />

        {/* Two Solid Dark Vertical Capsule Eyes */}
        <g
          style={{
            transition: "transform 160ms ease",
            transform: `translate(${eyeOffsetX}px, 0px)`,
          }}
        >
          <g className="bot-avatar-eyes" style={{ animationDelay: `-${blinkDelay}ms` }}>
          <rect
            x={CENTER - 35}
            y={eyeY}
            width={18}
            height={eyeHeight}
            rx={9}
            fill="#09090B"
          />
          <rect
            x={CENTER + 17}
            y={eyeY}
            width={18}
            height={eyeHeight}
            rx={9}
            fill="#09090B"
          />
          </g>
        </g>
      </svg>}

      {showStarBadge && (
        <span
          className="absolute flex items-center justify-center rounded-full bg-[#e88827] text-white shadow-md ring-2 ring-[#0e0e0e]"
          style={{
            width: Math.max(14, Math.round(size * 0.27)),
            height: Math.max(14, Math.round(size * 0.27)),
            right: Math.round(size * 0.02),
            bottom: Math.round(size * 0.02),
          }}
        >
          <Star size={Math.max(8, Math.round(size * 0.155))} fill="currentColor" strokeWidth={0} />
        </span>
      )}

      {showCliBadge && cliDriver && !showStarBadge && (
        <span
          className="absolute flex items-center justify-center rounded-full bg-[#16161a] text-white shadow-md ring-2 ring-[#0e0e0e]"
          style={{
            width: Math.max(16, Math.round(size * 0.37)),
            height: Math.max(16, Math.round(size * 0.37)),
            right: -2,
            bottom: -2,
          }}
        >
          <CliProviderGlyph
            driver={cliDriver}
            size={Math.max(10, Math.round(size * 0.21))}
          />
        </span>
      )}
    </div>
  );
}

export function CliProviderGlyph({
  driver,
  size = 15,
  className = "",
}: {
  driver: OpenString<CliDriverKind>;
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
  if (d === "opencode") {
    return <OpencodeLogoIcon style={style} className={`text-[#F1ECEC] ${className}`} />;
  }
  if (d === "cursor") {
    return <CursorLogoIcon style={style} className={`text-[#EDECEC] ${className}`} />;
  }
  if (d === "grok") {
    return <GrokIcon style={style} className={`text-zinc-100 ${className}`} />;
  }
  if (d === "pi") {
    return <PiLogoIcon style={style} className={`text-violet-300 ${className}`} />;
  }
  if (d === "muse") {
    return <MuseLogoIcon style={style} className={`text-cyan-300 ${className}`} />;
  }
  if (d === "acp") {
    return <AcpLogoIcon style={style} className={`text-zinc-200 ${className}`} />;
  }
  if (d === "antigravity") {
    return (
      <img
        src="/antigravity-logo.png"
        alt="Antigravity"
        style={style}
        className={`object-contain ${className}`}
      />
    );
  }
  if (d === "gemini") {
    return <GeminiIcon style={style} className={`text-blue-400 ${className}`} />;
  }
  if (d === "ollama") {
    return <OllamaLogoIcon style={style} className={`text-pink-400 ${className}`} />;
  }
  if (d === "aider") {
    return <span style={style} className={`inline-flex items-center justify-center text-[10px] font-medium ${className}`} aria-hidden="true">ai</span>;
  }
  return <span style={style} className={`inline-flex items-center justify-center text-[10px] font-medium ${className}`} aria-hidden="true">{driver.slice(0, 1).toUpperCase()}</span>;
}

export function CliBrandBadge({ driver, size = 42, rounded = "rounded-xl" }: {
  driver: OpenString<CliDriverKind>;
  size?: number;
  rounded?: string;
}): React.ReactElement {
  return <div style={{ width: size, height: size }} className={`${rounded} bg-white/[0.05] border border-white/10 flex items-center justify-center shrink-0`}>
    <CliProviderGlyph driver={driver} size={Math.round(size * 0.52)} />
  </div>;
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
