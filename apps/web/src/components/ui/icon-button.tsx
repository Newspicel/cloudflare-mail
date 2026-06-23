import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { Button, type ButtonProps } from "./button.tsx";
import { Tooltip } from "./tooltip.tsx";

// One ghost icon button with a text tooltip. Pass an `icon` or `children` (the
// label doubles as the tooltip and the aria-label). Replaces the per-file
// ToolbarButton / BulkButton / RowAction copies.
export function IconButton({
  label,
  icon: Icon,
  children,
  onClick,
  disabled,
  size = "icon",
  className,
  side,
}: {
  label: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  size?: ButtonProps["size"];
  className?: string;
  side?: React.ComponentProps<typeof Tooltip>["side"];
}) {
  return (
    <Tooltip label={label} side={side}>
      <Button
        variant="ghost"
        size={size}
        className={className}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        {Icon ? <Icon /> : children}
      </Button>
    </Tooltip>
  );
}
