import { AlertDialog, Dialog, DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button.js";
import { cn } from "./cn.js";

// Piezas de shadcn/ui sobre Radix, con los colores de la marca.

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-56 rounded-xl border border-line bg-raised p-1.5 text-ink shadow-lg"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({ children, onSelect, active }: { children: ReactNode; onSelect: () => void; active?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface",
        active && "font-semibold",
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1.5 h-px bg-line" />;
}

/** Confirmación para acciones que no se deshacen (quitar a alguien, cancelar una invitación). */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-line bg-raised p-6 text-ink shadow-xl">
          <AlertDialog.Title className="text-lg font-semibold">{props.title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted">{props.description}</AlertDialog.Description>
          <div className="mt-2 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{props.cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="brand" onClick={props.onConfirm}>
                {props.confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Panel lateral (el menú de la consola en el teléfono). */
export function Drawer(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-surface pt-[env(safe-area-inset-top)] shadow-xl">
          <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
          <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Panel lateral derecho para editar un elemento (servicio, profesional) sin salir de la lista. */
export function Sheet(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(34rem,100vw)] flex-col bg-raised pt-[env(safe-area-inset-top)] text-ink shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <Dialog.Title className="text-lg font-semibold">{props.title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="×">
                ✕
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
          <div className="flex-1 overflow-y-auto px-6 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{props.children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
