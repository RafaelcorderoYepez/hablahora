import { Switch } from "radix-ui";
import { cn } from "./cn.js";

export function SwitchField(props: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch.Root
        id={props.id}
        checked={props.checked}
        onCheckedChange={props.onCheckedChange}
        disabled={props.disabled}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
        className={cn(
          "relative mt-0.5 h-6 w-11 flex-none rounded-full bg-line transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 data-[state=checked]:bg-success",
        )}
      >
        <Switch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={props.id} className="font-semibold">
          {props.label}
        </label>
        {props.hint ? (
          <p id={`${props.id}-hint`} className="text-sm text-muted">
            {props.hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
