import {
  FAMILIAR_COLORS,
  type FamiliarEyes,
  type FamiliarForm,
  type FamiliarLook,
  type FamiliarMark,
  type FamiliarMood,
  type FamiliarSkin,
} from "@ofa/contracts";

// Geometry for an agent's familiar, shared by web (SVG) and mobile
// (react-native-svg). Pure functions: a look and a mood in, SVG path data and
// colours out, all in a 120×120 view box. Renderers only draw what this returns.

export type FamiliarGaze = "auto" | "left" | "right" | "up" | "down";

export interface FamiliarPattern {
  readonly width: number;
  readonly height: number;
  readonly path: string;
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
}

export interface FamiliarParts {
  readonly color: string;
  /** Darker body tone for lids, horns and details. */
  readonly deep: string;
  /** Ink for strokes on the body: light on dark colours, dark on light ones. */
  readonly faceInk: string;
  readonly body: string;
  readonly detail: string;
  readonly shadowRx: number;
  /** Skin print, drawn over the body; null for a solid skin. */
  readonly pattern: FamiliarPattern | null;
  readonly whites: string;
  readonly rings: string;
  readonly pupils: string;
  readonly pupilFill: string;
  readonly glints: string;
  readonly glintFill: string;
  readonly lids: string;
  readonly strokes: string;
  readonly mouth: string;
  readonly markBack: string;
  readonly markBackColor: string;
  readonly markFill: string;
  readonly markFillColor: string;
  readonly markStrokeColor: string;
  readonly markLine: string;
  readonly markLineColor: string;
  /** "z z" position while asleep; null otherwise. */
  readonly sleep: { readonly x: number; readonly y: number } | null;
  /** Status dot for moods that want attention; null otherwise. */
  readonly badge: { readonly x: number; readonly y: number; readonly color: string } | null;
}

const INK = "#0f0f10";
const ACID = FAMILIAR_COLORS.acid;

/** Badge colours per mood. The badge itself is the shape cue, so state never relies on colour alone. */
export const FAMILIAR_MOOD_COLORS: Partial<Record<FamiliarMood, string>> = {
  thinking: "#b7a6ff",
  working: ACID,
  waiting: "#ffc93a",
  error: "#ff5b3a",
};

const round = (value: number) => Math.round(value * 100) / 100;

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  const mix = (v: number) => Math.round((target - v) * k + v);
  const r = mix(n >> 16);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const circle = (cx: number, cy: number, r: number) =>
  `M${round(cx - r)} ${round(cy)}A${r} ${r} 0 1 0 ${round(cx + r)} ${round(cy)}A${r} ${r} 0 1 0 ${round(cx - r)} ${round(cy)}Z`;

const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${round(cx - rx)} ${round(cy)}A${rx} ${ry} 0 1 0 ${round(cx + rx)} ${round(cy)}A${rx} ${ry} 0 1 0 ${round(cx - rx)} ${round(cy)}Z`;

const roundedRect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

interface FormGeometry {
  readonly body: string;
  readonly detail?: string;
  /** Eye line. */
  readonly eyeY: number;
  /** Half the distance between the eyes. */
  readonly eyeDx: number;
  /** Top of the head, where marks sit. */
  readonly top: number;
  readonly shadowRx: number;
  readonly badge: readonly [number, number];
}

function bloomBody(): string {
  let d = circle(60, 66, 31);
  for (let i = 0; i < 8; i++) {
    const a = ((i * 45 - 90) * Math.PI) / 180;
    d += circle(60 + 30 * Math.cos(a), 66 + 30 * Math.sin(a), 13);
  }
  return d;
}

function cookieBody(): string {
  const point = (deg: number, radius: number) => {
    const a = (deg * Math.PI) / 180;
    return `${round(60 + radius * Math.cos(a))} ${round(68 + radius * Math.sin(a))}`;
  };
  let d = `M${point(-126, 30)}`;
  for (let k = 0; k < 5; k++) {
    const angle = -90 + k * 72;
    d += `Q${point(angle, 50)} ${point(angle + 36, 30)}`;
  }
  return `${d}Z`;
}

const FORMS: Record<FamiliarForm, FormGeometry> = {
  bloom: { body: bloomBody(), eyeY: 64, eyeDx: 11, top: 23, shadowRx: 30, badge: [96, 32] },
  blob: {
    body: "M58 28C82 26 100 42 99 64C98 88 84 104 60 104C36 104 21 90 21 66C21 44 36 29 58 28Z",
    eyeY: 62,
    eyeDx: 12,
    top: 28,
    shadowRx: 32,
    badge: [93, 36],
  },
  drop: {
    body: "M60 18C67 32 96 52 96 76A36 28 0 0 1 24 76C24 52 53 32 60 18Z",
    eyeY: 72,
    eyeDx: 11,
    top: 20,
    shadowRx: 30,
    badge: [88, 40],
  },
  totem: {
    body: roundedRect(30, 20, 60, 50, 22) + roundedRect(22, 62, 76, 42, 18),
    detail: roundedRect(48, 82, 24, 6, 3),
    eyeY: 44,
    eyeDx: 11,
    top: 20,
    shadowRx: 32,
    badge: [87, 25],
  },
  ghost: {
    body: "M26 104V62A34 34 0 0 1 94 62V104L82.67 96L71.33 104L60 96L48.67 104L37.33 96Z",
    eyeY: 60,
    eyeDx: 12,
    top: 28,
    shadowRx: 30,
    badge: [91, 34],
  },
  cookie: { body: cookieBody(), eyeY: 66, eyeDx: 10, top: 28, shadowRx: 30, badge: [94, 34] },
};

/** Pupil offset (x, y) and size factor per mood: up while thinking, down while working, wide while waiting. */
const MOOD_GAZE: Record<FamiliarMood, readonly [number, number, number]> = {
  idle: [0, 0, 1],
  thinking: [2.6, -3, 1],
  working: [-2.8, 2.6, 0.95],
  waiting: [0, 0.4, 1.25],
  asleep: [0, 0, 1],
  error: [0, 0, 1],
};

const LOOK_AT: Record<Exclude<FamiliarGaze, "auto">, readonly [number, number]> = {
  left: [-3.2, 0],
  right: [3.2, 0],
  up: [0, -3.2],
  down: [0, 3],
};

function skinPattern(skin: FamiliarSkin, tone: string): FamiliarPattern | null {
  switch (skin) {
    case "stripes":
      return {
        width: 8,
        height: 8,
        path: "M-2 2L2 -2M0 8L8 0M6 10L10 6",
        fill: "none",
        stroke: tone,
        strokeWidth: 2.6,
      };
    case "dots":
      return {
        width: 7,
        height: 7,
        path: circle(3.5, 3.5, 1.5),
        fill: tone,
        stroke: "none",
        strokeWidth: 0,
      };
    case "checker":
      return {
        width: 10,
        height: 10,
        path: "M0 0h5v5h-5ZM5 5h5v5h-5Z",
        fill: tone,
        stroke: "none",
        strokeWidth: 0,
      };
    case "waves":
      return {
        width: 12,
        height: 7,
        path: "M0 3.5Q3 0.5 6 3.5T12 3.5",
        fill: "none",
        stroke: tone,
        strokeWidth: 1.8,
      };
    case "solid":
      return null;
  }
}

interface MarkParts {
  back: string;
  backColor: string;
  fill: string;
  fillColor: string;
  strokeColor: string;
  line: string;
  lineColor: string;
}

function markParts(mark: FamiliarMark, top: number, color: string, deep: string): MarkParts {
  const T = top;
  const none: MarkParts = {
    back: "",
    backColor: "none",
    fill: "",
    fillColor: "none",
    strokeColor: "none",
    line: "",
    lineColor: "none",
  };
  switch (mark) {
    case "sprout":
      return {
        ...none,
        line: `M60 ${T + 2}V${T - 9}`,
        lineColor: "#3fcf6a",
        fill:
          `M60 ${T - 8}C60 ${T - 18} 69 ${T - 23} 77 ${T - 21}C76 ${T - 12} 68 ${T - 8} 60 ${T - 8}Z` +
          `M60 ${T - 6}C59 ${T - 13} 52 ${T - 17} 45 ${T - 15}C47 ${T - 9} 53 ${T - 6} 60 ${T - 6}Z`,
        fillColor: "#3fcf6a",
      };
    case "spark": {
      const x = 88;
      const y = T - 4;
      const s = 10;
      return {
        ...none,
        fill: `M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z`,
        fillColor: color === ACID ? "#ffffff" : ACID,
        strokeColor: INK,
      };
    }
    case "halo":
      return { ...none, back: ellipse(60, T - 9, 17, 4.5), backColor: "#ffc93a" };
    case "cap": {
      const capColor =
        color === FAMILIAR_COLORS.tomato ? FAMILIAR_COLORS.cobalt : FAMILIAR_COLORS.tomato;
      return {
        ...none,
        fill: `M43 ${T + 8}A17 15 0 0 1 77 ${T + 8}Z${circle(60, T - 9, 4.5)}`,
        fillColor: capColor,
        strokeColor: capColor,
      };
    }
    case "horns":
      return {
        ...none,
        fill:
          `M43 ${T + 10}Q36 ${T - 4} 44 ${T - 10}Q45 ${T + 1} 52 ${T + 6}Z` +
          `M77 ${T + 10}Q84 ${T - 4} 76 ${T - 10}Q75 ${T + 1} 68 ${T + 6}Z`,
        fillColor: deep,
        strokeColor: deep,
      };
    case "none":
      return none;
  }
}

interface EyeParts {
  whites: string;
  rings: string;
  pupils: string;
  pupilFill: string;
  glints: string;
  glintFill: string;
  lids: string;
  strokes: string;
}

function eyeParts(
  style: FamiliarEyes,
  mood: FamiliarMood,
  geometry: FormGeometry,
  gaze: FamiliarGaze,
  color: string,
  faceInk: string,
  darkBase: boolean,
): EyeParts {
  const ex = 60;
  const ey = geometry.eyeY;
  const dx = geometry.eyeDx;
  const eyes: [number, number][] =
    style === "cyclops"
      ? [[ex, ey]]
      : [
          [ex - dx, ey],
          [ex + dx, ey],
        ];
  const parts: EyeParts = {
    whites: "",
    rings: "",
    pupils: "",
    pupilFill: INK,
    glints: "",
    glintFill: "#ffffff",
    lids: "",
    strokes: "",
  };

  const [moodX, moodY, k] = MOOD_GAZE[mood];
  const [ox, oy] = gaze === "auto" ? [moodX, moodY] : LOOK_AT[gaze];
  const asleep = mood === "asleep";
  const stuck = mood === "error";

  if (style === "visor") {
    parts.pupils = roundedRect(ex - dx - 11, ey - 6.5, 2 * dx + 22, 13, 6.5);
    if (asleep) {
      parts.glints = eyes.map(([x, y]) => roundedRect(x - 3.5, y - 0.8, 7, 1.6, 0.8)).join("");
      parts.glintFill = "#5a5a60";
    } else {
      parts.glintFill = stuck ? FAMILIAR_COLORS.tomato : color === ACID ? "#ffffff" : ACID;
      parts.glints = eyes
        .map(([x, y]) => circle(x + ox * 0.8, y + oy * 0.5, stuck ? 2 : 2.6))
        .join("");
    }
    return parts;
  }
  if (asleep) {
    parts.strokes = eyes.map(([x, y]) => `M${x - 5} ${y}Q${x} ${y + 4.5} ${x + 5} ${y}`).join("");
    return parts;
  }
  if (stuck) {
    parts.strokes = eyes.map(([x, y]) => `M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8`).join("");
    return parts;
  }
  if (style === "beans") {
    parts.pupilFill = faceInk;
    parts.glintFill = darkBase ? INK : "#ffffff";
    parts.pupils = eyes
      .map(([x, y]) => ellipse(x + ox * 0.6, y + oy * 0.6, 3.6 * k, 5.4 * k))
      .join("");
    parts.glints = eyes.map(([x, y]) => circle(x + ox * 0.6 + 1.1, y + oy * 0.6 - 2, 1.1)).join("");
    return parts;
  }

  const cyclops = style === "cyclops";
  const radius = cyclops ? 12.5 : style === "rings" ? 8 : 8.5;
  const pupil = (cyclops ? 6 : style === "rings" ? 2.8 : 4.2) * k;
  const reach = cyclops ? 1.3 : 1;
  parts.whites = eyes.map(([x, y]) => circle(x, y, radius)).join("");
  parts.pupils = eyes.map(([x, y]) => circle(x + ox * reach, y + oy * reach, pupil)).join("");
  if (style !== "rings") {
    parts.glints = eyes
      .map(([x, y]) =>
        circle(x + ox * reach + pupil * 0.38, y + oy * reach - pupil * 0.38, cyclops ? 1.6 : 1.1),
      )
      .join("");
  } else {
    parts.rings = parts.whites;
  }
  if (style === "lids" && mood !== "waiting") {
    const l = radius + 0.6;
    parts.lids = eyes
      .map(([x, y]) => `M${round(x - l)} ${y + 0.5}A${l} ${l} 0 0 1 ${round(x + l)} ${y + 0.5}Z`)
      .join("");
  }
  return parts;
}

function mouthPath(mood: FamiliarMood, x: number, y: number): string {
  switch (mood) {
    case "idle":
      return `M${x - 4} ${y}Q${x} ${y + 4} ${x + 4} ${y}`;
    case "thinking":
      return `M${x - 2} ${y + 1.5}L${x + 4} ${y - 0.5}`;
    case "working":
      return `M${x - 4} ${y + 1}H${x + 4}`;
    case "waiting":
      return circle(x, y + 1, 2.4);
    case "asleep":
      return `M${x - 2} ${y + 1}H${x + 2}`;
    case "error":
      return `M${x - 6} ${y + 2}l3 -3l3 3l3 -3l3 3`;
  }
}

/** Everything a renderer needs to draw a familiar. */
export function familiarParts(
  look: FamiliarLook,
  options: {
    mood?: FamiliarMood;
    gaze?: FamiliarGaze;
    /** Body colour override as #rrggbb, for decorative silhouettes outside the palette. */
    bodyColor?: string;
  } = {},
): FamiliarParts {
  const mood = options.mood ?? "idle";
  const gaze = options.gaze ?? "auto";
  const color =
    options.bodyColor && /^#[0-9a-f]{6}$/i.test(options.bodyColor)
      ? options.bodyColor.toLowerCase()
      : FAMILIAR_COLORS[look.color];
  const darkBase = luminance(color) < 0.42;
  const faceInk = darkBase ? "#f4f4f0" : INK;
  const deep = shade(color, -0.3);
  const tone = darkBase ? shade(color, 0.18) : shade(color, -0.14);
  const geometry = FORMS[look.form];

  const eyes = eyeParts(look.eyes, mood, geometry, gaze, color, faceInk, darkBase);
  const mark = markParts(look.mark, geometry.top, color, deep);
  const mouthY = geometry.eyeY + (look.eyes === "cyclops" ? 19 : 14);
  const [bx, by] = geometry.badge;
  const badgeColor = FAMILIAR_MOOD_COLORS[mood];

  return {
    color,
    deep,
    faceInk,
    body: geometry.body,
    detail: geometry.detail ?? "",
    shadowRx: geometry.shadowRx,
    pattern: skinPattern(look.skin, tone),
    ...eyes,
    mouth: mouthPath(mood, 60, mouthY),
    markBack: mark.back,
    markBackColor: mark.backColor,
    markFill: mark.fill,
    markFillColor: mark.fillColor,
    markStrokeColor: mark.strokeColor,
    markLine: mark.line,
    markLineColor: mark.lineColor,
    sleep: mood === "asleep" ? { x: bx - 10, y: by + 2 } : null,
    badge: badgeColor ? { x: bx, y: by, color: badgeColor } : null,
  };
}
