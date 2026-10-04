import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type InputHTMLAttributes, type Ref } from "react";
import { cn } from "@/lib/utils";

// A field for passwords and keys (M3.10, ADR-0012). The value stays in this
// field: it is never put in the URL, a chat message, a log or the browser's
// autofill store, and it is cleared when the field goes away. Show/hide lets
// the person check what they typed.

export function SecretInput({
  ref,
  className,
  value,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  ref?: Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  // Leaving the screen forgets the value.
  useEffect(() => () => latest.current(""), []);

  return (
    <div className="relative">
      <input
        {...props}
        ref={ref}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        // Password managers: don't offer to save this here.
        data-1p-ignore
        data-lpignore="true"
        className={cn(
          "flex h-13 w-full rounded-md border border-input bg-field pr-12 pl-4 text-base text-foreground transition-colors outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      />
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-label={shown ? "Hide" : "Show"}
        aria-pressed={shown}
        className="absolute top-1/2 right-2.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}
