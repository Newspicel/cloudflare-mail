import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { cn } from "@/lib/cn";
import { buttonVariants } from "./button.tsx";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      weekStartsOn={1}
      className={cn("p-2", className)}
      classNames={{
        months: "flex flex-col gap-3",
        month: "relative flex flex-col gap-3",
        month_caption: "flex h-7 items-center justify-center px-8",
        caption_label: "font-medium text-[13px]",
        nav: "absolute inset-x-0 top-0 flex h-7 items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-foreground",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-foreground",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 font-normal text-[11px] text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "size-8 p-0 text-center text-[13px]",
        day_button: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "size-8 rounded-md p-0 font-normal aria-selected:opacity-100",
        ),
        selected:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground",
        today: "[&:not(.rdp-selected)>button]:bg-accent [&:not(.rdp-selected)>button]:text-foreground",
        outside: "text-muted-foreground/40",
        disabled: "text-muted-foreground/40 opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? <ChevronLeft /> : <ChevronRight />,
      }}
      {...props}
    />
  );
}
