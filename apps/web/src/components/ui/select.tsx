import { Check, ChevronDown } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface Opt {
  value: string;
  label: string;
  disabled: boolean;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Read `<option>` children (also inside fragments), as the native select would. */
function collect(children: ReactNode, out: Opt[]): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as {
      value?: string | number;
      disabled?: boolean;
      children?: ReactNode;
    };
    if (child.type === "option") {
      const label = textOf(props.children);
      out.push({
        value: props.value === undefined ? label : String(props.value),
        label,
        disabled: !!props.disabled,
      });
    } else {
      collect(props.children, out);
    }
  });
  return out;
}

const VARIANTS = {
  /** Like `Input`: a field in a form. */
  field:
    "h-13 w-full rounded-md border border-input bg-field px-4 text-base text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
  /** A compact filter or switcher in a toolbar. */
  pill: "h-10 rounded-full border border-input bg-card px-4 text-[13.5px] font-medium text-foreground focus-visible:ring-2 focus-visible:ring-ring",
} as const;

export interface SelectProps {
  value: string | number;
  onChange?: (event: { target: { value: string }; currentTarget: { value: string } }) => void;
  /** `<option>` elements, as for a native select. */
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  id?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
}

/**
 * A themed select. Same call shape as `<select>` (`value`, `onChange(e)` with
 * `e.target.value`, `<option>` children) so the browser's own popup, which
 * ignores the theme, is never shown.
 */
export function Select({
  value,
  onChange,
  children,
  variant = "field",
  id,
  name,
  disabled,
  className,
  title,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
}: SelectProps) {
  const options = useMemo(() => collect(children, []), [children]);
  const current = String(value);
  const selectedIndex = options.findIndex((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const choose = (opt: Opt | undefined) => {
    setOpen(false);
    if (!opt || opt.disabled || opt.value === current) return;
    onChange?.({ target: { value: opt.value }, currentTarget: { value: opt.value } });
  };

  const show = () => {
    if (disabled) return;
    const first = options.findIndex((o) => !o.disabled);
    setActive(selectedIndex >= 0 ? selectedIndex : Math.max(first, 0));
    setOpen(true);
  };

  // Place the list under the button, or above it when the room below is short.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setPlace(
      below < 240 && r.top > below
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6 }
        : { left: r.left, width: r.width, top: r.bottom + 6 },
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (list.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active, place]);

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      if (!options[i]!.disabled) return i;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => step(a, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => step(a, -1));
        break;
      case "Home":
        e.preventDefault();
        setActive(step(-1, 1));
        break;
      case "End":
        e.preventDefault();
        setActive(step(options.length, -1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(options[active]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cn(
          "flex min-w-0 items-center justify-between gap-2 text-left outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
          VARIANTS[variant],
          className,
        )}
      >
        <span className="truncate">{selectedIndex >= 0 ? options[selectedIndex]!.label : ""}</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {open &&
        place &&
        createPortal(
          <ul
            ref={list}
            id={listId}
            role="listbox"
            style={{
              left: place.left,
              top: place.top,
              bottom: place.bottom,
              minWidth: place.width,
              maxWidth: "min(24rem, calc(100vw - 1.5rem))",
            }}
            className="fixed z-[70] max-h-72 w-max overflow-y-auto rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-2xl"
          >
            {options.map((o, i) => (
              <li
                key={`${o.value}:${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === selectedIndex}
                aria-disabled={o.disabled || undefined}
                onPointerEnter={() => !o.disabled && setActive(i)}
                // Keep focus on the button so the keyboard keeps working.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm",
                  i === active && "bg-accent text-accent-foreground",
                  i === selectedIndex && "font-semibold",
                  o.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span>{o.label}</span>
                {i === selectedIndex && <Check className="size-4 shrink-0" aria-hidden />}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
