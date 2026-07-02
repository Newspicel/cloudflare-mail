import type { EmailTemplate } from "@cfmail/shared/responses";
import { BellPlus, Clock, FileText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";

// Saved-templates picker in the compose footer; closes itself after inserting.
export function TemplatesPopover({
  templates,
  onInsert,
}: {
  templates: EmailTemplate[];
  onInsert: (t: EmailTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Insert template">
            <FileText />
          </Button>
        }
      />
      <PopoverContent side="top" align="start" className="w-64 p-1.5">
        <div className="px-1.5 py-1 font-medium text-[11px] text-muted-foreground">
          Insert template
        </div>
        {templates.length === 0 ? (
          <Empty>
            <EmptyMedia>
              <FileText />
            </EmptyMedia>
            <EmptyTitle>No templates yet</EmptyTitle>
            <EmptyDescription>Add them in Settings → Templates.</EmptyDescription>
          </Empty>
        ) : (
          templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onInsert(t);
                setOpen(false);
              }}
              className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
              title={t.name}
            >
              {t.name}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

// "Remind me if no reply" toggle + window, in the compose footer.
export function FollowUpPopover({
  followUp,
  onFollowUpChange,
  days,
  onDaysChange,
}: {
  followUp: boolean;
  onFollowUpChange: (on: boolean) => void;
  days: number;
  onDaysChange: (days: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remind me if no reply"
            aria-pressed={followUp}
            title={followUp ? `Remind if no reply in ${days}d` : "Remind if no reply"}
            className={followUp ? "text-primary" : undefined}
          >
            <BellPlus />
          </Button>
        }
      />
      <PopoverContent side="top" align="start" className="w-60 p-2.5">
        <Label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <Checkbox checked={followUp} onCheckedChange={(v) => onFollowUpChange(v === true)} />
          Remind me if no reply
        </Label>
        <InputGroup className={cn("mt-2", !followUp && "opacity-50")}>
          <InputGroupAddon>
            <Clock />
            <InputGroupText>after</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            type="number"
            min={1}
            max={30}
            aria-label="Days until reminder"
            value={days}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (!Number.isNaN(n)) onDaysChange(Math.min(30, Math.max(1, n)));
            }}
            disabled={!followUp}
            className="text-center"
          />
          <InputGroupAddon align="end">
            <InputGroupText>days</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      </PopoverContent>
    </Popover>
  );
}
