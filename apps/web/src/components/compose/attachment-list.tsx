import { Paperclip, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item.tsx";
import { formatBytes, type UploadedAttachment } from "./compose-utils.ts";

// The non-inline attachments listed under the body (inline images live in the
// HTML itself).
export function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: UploadedAttachment[];
  onRemove: (r2Key: string) => void;
}) {
  if (!attachments.some((a) => !a.inline)) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 border-t pt-2">
      {attachments.flatMap((a) =>
        a.inline
          ? []
          : [
              <li key={a.r2Key}>
                <Item variant="outline" size="sm">
                  <ItemMedia>
                    <Paperclip />
                  </ItemMedia>
                  <ItemContent className="flex-row items-center gap-2">
                    <ItemTitle title={a.filename} className="min-w-0 flex-1">
                      {a.filename}
                    </ItemTitle>
                    <Badge variant="outline" className="shrink-0 font-normal">
                      {formatBytes(a.sizeBytes)}
                    </Badge>
                  </ItemContent>
                  <ItemActions>
                    <IconButton
                      label={`Remove ${a.filename}`}
                      icon={X}
                      size="icon-sm"
                      onClick={() => onRemove(a.r2Key)}
                    />
                  </ItemActions>
                </Item>
              </li>,
            ],
      )}
    </ul>
  );
}
