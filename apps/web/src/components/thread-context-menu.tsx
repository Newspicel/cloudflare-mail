import type { LucideIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useFinePointer } from "@/lib/use-pointer.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";

export interface RowAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

interface Props {
  /** Heading shown above the actions, e.g. the thread subject. */
  title?: string;
  actions: RowAction[];
  children: ReactNode;
}

// Right-click action menu for a single thread row — mirrors the desktop hover
// cluster. Gated to fine pointers so it never competes with the touch
// long-press action sheet.
export function RowContextMenu({ title, actions, children }: Props) {
  const fine = useFinePointer();
  if (!fine || actions.length === 0) return <>{children}</>;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {title && (
          <>
            <ContextMenuLabel className="max-w-60 truncate">{title}</ContextMenuLabel>
            <ContextMenuSeparator />
          </>
        )}
        {actions.map((a) => (
          <Fragment key={a.label}>
            {a.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem variant={a.variant} onClick={a.onClick}>
              <a.icon />
              {a.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
