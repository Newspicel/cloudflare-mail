import { ImageIcon, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Label } from "@/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { ToggleGroup, ToggleItem } from "@/components/ui/toggle-group.tsx";
import { canDownscale } from "@/lib/resize-image.ts";
import type { useAttachments } from "./use-attachments.ts";

// The attach-vs-inline choice for dropped/picked images, with metadata
// stripping and downscale options. Driven entirely by the attachments hook.
export function ImageChoiceDialog({ attach }: { attach: ReturnType<typeof useAttachments> }) {
  const {
    pendingImages,
    setPendingImages,
    placement,
    setPlacement,
    stripMeta,
    setStripMeta,
    resizeMax,
    setResizeMax,
    commitPendingImages,
  } = attach;
  return (
    <Dialog
      open={pendingImages.length > 0}
      onOpenChange={(next) => {
        if (!next) setPendingImages([]);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {pendingImages.length > 1 ? `Add ${pendingImages.length} images` : "Add image"}
          </DialogTitle>
          <DialogDescription>
            Embed {pendingImages.length > 1 ? "them" : "it"} in the message or attach as
            {pendingImages.length > 1 ? " files" : " a file"}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <ToggleGroup
            value={placement}
            onValueChange={(v) => setPlacement(v)}
            className="w-full [&>*]:flex-1"
          >
            <ToggleItem value="inline">
              <ImageIcon />
              In message
            </ToggleItem>
            <ToggleItem value="attachment">
              <Paperclip />
              As attachment
            </ToggleItem>
          </ToggleGroup>
          <Label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <Checkbox checked={stripMeta} onCheckedChange={(v) => setStripMeta(v === true)} />
            Remove image metadata (EXIF, GPS)
          </Label>
          {pendingImages.some((f) => canDownscale(f.type)) && (
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span>Scale down</span>
              <Select
                items={[
                  { value: "0", label: "Original size" },
                  { value: "2048", label: "Large (2048px)" },
                  { value: "1280", label: "Medium (1280px)" },
                  { value: "640", label: "Small (640px)" },
                ]}
                value={String(resizeMax)}
                onValueChange={(v) => setResizeMax(Number(v))}
              >
                <SelectTrigger className="h-8 w-36 text-[13px]" aria-label="Scale down image">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Original size</SelectItem>
                  <SelectItem value="2048">Large (2048px)</SelectItem>
                  <SelectItem value="1280">Medium (1280px)</SelectItem>
                  <SelectItem value="640">Small (640px)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPendingImages([])}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void commitPendingImages()}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
