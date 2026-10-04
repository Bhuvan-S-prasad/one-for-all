import { familiarParts, FAMILIAR_MOOD_COLORS, type FamiliarGaze } from "@ofa/client";
import type { FamiliarLook, FamiliarMood } from "@ofa/contracts";
import { useId } from "react";
import { cn } from "@/lib/utils";

interface FamiliarProps {
  look: FamiliarLook;
  mood?: FamiliarMood;
  gaze?: FamiliarGaze;
  size?: number;
  /** Colour of the gap around the status badge; match the surface behind. */
  ring?: string;
  /** Body colour override (#rrggbb) for decorative silhouettes. */
  bodyColor?: string;
  /** Accessible name. Omit for purely decorative familiars. */
  label?: string;
  /**
   * Move with the mood (UX.06): breathe and blink, sway, bob, shiver or doze.
   * Keep it for familiars that are busy, need someone, or are the one on
   * screen, so a list of agents stays calm. Off under reduced motion.
   */
  animate?: boolean;
  /** One hop, for the moment a run finishes. Change `key` to replay it. */
  celebrate?: boolean;
  className?: string;
}

/** An agent's familiar, drawn from the shared geometry in @ofa/client. */
export function Familiar({
  look,
  mood = "idle",
  gaze = "auto",
  size = 120,
  ring = "var(--background)",
  bodyColor,
  label,
  animate = false,
  celebrate = false,
  className,
}: FamiliarProps) {
  const p = familiarParts(look, { mood, gaze, bodyColor });
  const patternId = `familiar-skin-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  // Extras only at sizes where they read; below that the body motion is enough.
  const extras = animate && size >= 48;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={cn(
        "familiar overflow-visible",
        animate && `familiar--${mood}`,
        celebrate && "familiar--hop",
        className,
      )}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {p.pattern && (
        <defs>
          <pattern
            id={patternId}
            patternUnits="userSpaceOnUse"
            width={p.pattern.width}
            height={p.pattern.height}
          >
            <path
              d={p.pattern.path}
              fill={p.pattern.fill}
              stroke={p.pattern.stroke}
              strokeWidth={p.pattern.strokeWidth}
              strokeLinecap="round"
            />
          </pattern>
        </defs>
      )}
      <ellipse cx="60" cy="110" rx={p.shadowRx} ry="4" fill="#000" fillOpacity="0.22" />
      <g className="familiar-body">
        {p.markBack && (
          <path
            d={p.markBack}
            fill="none"
            stroke={p.markBackColor}
            strokeWidth="3.5"
            strokeLinecap="round"
          />
        )}
        <path d={p.body} fill={p.color} />
        {p.pattern && <path d={p.body} fill={`url(#${patternId})`} />}
        {p.detail && <path d={p.detail} fill={p.deep} />}
        {p.markFill && (
          <path
            d={p.markFill}
            fill={p.markFillColor}
            stroke={p.markStrokeColor}
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        )}
        {p.markLine && (
          <path
            d={p.markLine}
            fill="none"
            stroke={p.markLineColor}
            strokeWidth="3"
            strokeLinecap="round"
          />
        )}
        <g className="familiar-eyes">
          {p.whites && <path d={p.whites} fill="#fff" />}
          {p.rings && <path d={p.rings} fill="none" stroke="#0f0f10" strokeWidth="2.4" />}
          {p.pupils && <path d={p.pupils} fill={p.pupilFill} />}
          {p.glints && <path d={p.glints} fill={p.glintFill} />}
          {p.lids && <path d={p.lids} fill={p.deep} />}
          {p.strokes && (
            <path
              d={p.strokes}
              fill="none"
              stroke={p.faceInk}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </g>
        <path
          d={p.mouth}
          fill="none"
          stroke={p.faceInk}
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      {p.sleep && (
        <text
          x={p.sleep.x}
          y={p.sleep.y}
          fontFamily="var(--font-mono)"
          fontSize="12"
          fontWeight="500"
          fill="#8a8a90"
          className={cn(animate && "familiar-zz")}
        >
          z z
        </text>
      )}
      {extras && mood === "thinking" && (
        <g fill={FAMILIAR_MOOD_COLORS.thinking} aria-hidden>
          <circle className="familiar-thought" cx="88" cy="18" r="2.5" />
          <circle className="familiar-thought familiar-thought--2" cx="95" cy="11" r="3.5" />
          <circle className="familiar-thought familiar-thought--3" cx="104" cy="4" r="4.5" />
        </g>
      )}
      {extras && mood === "working" && (
        <g fill={FAMILIAR_MOOD_COLORS.working} aria-hidden>
          <path
            className="familiar-spark"
            d="M18 34Q18 40 24 40Q18 40 18 46Q18 40 12 40Q18 40 18 34Z"
          />
          <path
            className="familiar-spark familiar-spark--2"
            d="M100 56Q100 60 104 60Q100 60 100 64Q100 60 96 60Q100 60 100 56Z"
          />
        </g>
      )}
      {p.badge && (
        <circle
          cx={p.badge.x}
          cy={p.badge.y}
          r="7"
          fill={p.badge.color}
          style={{ stroke: ring }}
          strokeWidth="3"
        />
      )}
    </svg>
  );
}
