import type { Skill } from "@ofa/contracts";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

// `/` in the composer (M5.08): the skills this agent may use, to name one in
// a message. The server applies `/slug` when the run starts; this only helps
// write it.

/** The `/partial` being typed at the end of the text, or null. */
export function skillQuery(text: string): string | null {
  const match = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** Replace the `/partial` at the end with the chosen skill. */
export function insertSkill(text: string, slug: string): string {
  return text.replace(/\/([a-z0-9-]*)$/i, `/${slug} `);
}

/** Active skills whose handle starts with, or name contains, what was typed. */
export function matchSkills(skills: readonly Skill[], query: string): Skill[] {
  return skills
    .filter((s) => s.status === "active")
    .filter((s) => s.slug.startsWith(query) || s.name.toLowerCase().includes(query))
    .slice(0, 6);
}

export function SkillSuggestions(props: {
  id: string;
  items: readonly Skill[];
  active: number;
  onPick: (skill: Skill) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul
      id={props.id}
      role="listbox"
      aria-label="Skills"
      className="absolute right-2 bottom-full left-2 mb-2 overflow-hidden rounded-[18px] border bg-popover p-1.5 text-popover-foreground shadow-xl"
    >
      {props.items.map((skill, i) => (
        <li
          key={skill.id}
          id={`${props.id}-${i}`}
          role="option"
          aria-selected={i === props.active}
          onPointerMove={() => props.onHover(i)}
          // Keep focus in the composer.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(skill)}
          className={cn(
            "flex min-h-11 cursor-pointer items-center gap-3 rounded-[12px] px-3 py-1.5",
            i === props.active && "bg-accent",
          )}
        >
          <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px]">{skill.name}</span>
            <span className="block truncate text-[12.5px] text-muted-foreground">
              {skill.description}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            /{skill.slug}
          </span>
        </li>
      ))}
    </ul>
  );
}
