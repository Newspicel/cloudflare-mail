import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        secondary: "border bg-card text-foreground shadow-sm hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        outline: "border bg-transparent text-foreground hover:bg-accent",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
        default: "h-8 px-3 text-[13px] [&_svg]:size-4",
        lg: "h-9 px-4 text-sm [&_svg]:size-4",
        icon: "size-8 [&_svg]:size-4",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { ref?: React.Ref<HTMLButtonElement> };

export function Button({ className, variant, size, type, ref, ...props }: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
