import { familiarParts, type FamiliarGaze } from "@ofa/client";
import type { FamiliarLook, FamiliarMood } from "@ofa/contracts";
import { useId } from "react";

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
  className,
}: FamiliarProps) {
  const p = familiarParts(look, { mood, gaze, bodyColor });
  const patternId = `familiar-skin-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
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
      <path
        d={p.mouth}
        fill="none"
        stroke={p.faceInk}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {p.sleep && (
        <text
          x={p.sleep.x}
          y={p.sleep.y}
          fontFamily="var(--font-mono)"
          fontSize="12"
          fontWeight="500"
          fill="#8a8a90"
        >
          z z
        </text>
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
