import { useId, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface FormFieldProps extends Omit<ComponentProps<"input">, "id"> {
  label: string;
  /** Help text shown under the input while there is no error. */
  hint?: string;
  error?: string;
}

/** Label, input and hint or error, wired together for screen readers. */
export function FormField({ label, hint, error, ...inputProps }: FormFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        {...inputProps}
      />
      {note && (
        <p
          id={noteId}
          className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {note}
        </p>
      )}
    </div>
  );
}
