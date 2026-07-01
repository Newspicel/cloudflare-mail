import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Underline,
  Undo2,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn.ts";
import { Button } from "./ui/button.tsx";
import { ColorPicker } from "./ui/color-picker.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Separator } from "./ui/separator.tsx";

export interface RichEditorHandle {
  exec(cmd: string, value?: string): void;
  // Insert raw HTML at the caret (restoring the last in-editor selection first).
  insertHtml(html: string): void;
  focus(): void;
}

// A pending command applied right after the editor mounts — used when a
// formatting button is pressed while still in plain-text mode (the body is
// promoted to HTML and the command runs against the freshly mounted editor).
export interface PendingCmd {
  cmd: string;
  value?: string;
}

// Email-safe font choices. Values are concrete stacks so the resulting inline
// `font-family` renders predictably in other mail clients.
const FONTS: { label: string; value: string }[] = [
  { label: "Sans", value: "Arial, Helvetica, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", value: "'Courier New', monospace" },
];

// execCommand fontSize takes 1–7; with styleWithCSS the browser emits a
// keyword `font-size` (small/medium/large/…), which is email-safe.
const SIZES: { label: string; value: string }[] = [
  { label: "Small", value: "2" },
  { label: "Normal", value: "3" },
  { label: "Large", value: "5" },
  { label: "Huge", value: "7" },
];

export function RichEditor({
  initialHtml,
  onChange,
  pendingCmd,
  placeholder,
  className,
  ref,
}: {
  initialHtml: string;
  onChange: (html: string) => void;
  pendingCmd?: PendingCmd | null;
  placeholder?: string;
  className?: string;
  ref?: Ref<RichEditorHandle>;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  // Last in-editor selection, restored before running a command so controls
  // that steal focus (the font/size menus, the color popover) still apply to
  // the text.
  const savedRange = useRef<Range | null>(null);
  // Captured once so the mount effect needs no changing deps (seed-on-mount).
  const initialHtmlRef = useRef(initialHtml);
  // react-doctor-disable-next-line no-event-handler -- pendingCmd is a rich-text command queued during promote-to-HTML, replayed once on mount; not a substitute for an event handler
  const pendingCmdRef = useRef(pendingCmd);

  // Memoized: identity feeds the seed-on-mount effect and useImperativeHandle
  // deps, which the (compiler-unaware) exhaustive-deps lint requires to be stable.
  // eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization
  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel?.rangeCount && elRef.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  // eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization
  const exec = useCallback(
    (cmd: string, value?: string) => {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (savedRange.current && sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange.current);
      }
      // styleWithCSS makes execCommand emit inline `style` attributes instead of
      // legacy <font> tags — far friendlier to downstream mail clients.
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand(cmd, false, value);
      saveSelection();
      onChange(el.innerHTML);
    },
    [onChange, saveSelection],
  );

  // eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization
  const insertHtml = useCallback(
    (html: string) => {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (savedRange.current && sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange.current);
      }
      document.execCommand("insertHTML", false, html);
      saveSelection();
      onChange(el.innerHTML);
    },
    [onChange, saveSelection],
  );

  useImperativeHandle(ref, () => ({ exec, insertHtml, focus: () => elRef.current?.focus() }), [
    exec,
    insertHtml,
  ]);

  // Seed content once on mount; the editor is uncontrolled afterwards so the
  // caret never jumps. Run any command queued during the promote-to-HTML step.
  useEffect(() => {
    const el = elRef.current;
    // react-doctor-disable-next-line dangerous-html-sink -- initialHtml is the user's own compose draft (self-authored); the outbound body is sanitized via DOMPurify in compose-dock's buildBody before send.
    if (el && initialHtmlRef.current) el.innerHTML = initialHtmlRef.current;
    const queued = pendingCmdRef.current;
    if (queued) {
      el?.focus();
      exec(queued.cmd, queued.value);
    }
  }, [exec]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: contentEditable rich-text surface
    <div
      ref={elRef}
      contentEditable
      role="textbox" // react-doctor-disable-line prefer-tag-over-role -- a contentEditable rich-text surface cannot be a real <input>; role="textbox" is intentional
      tabIndex={0}
      aria-multiline="true"
      aria-label="Message body"
      data-placeholder={placeholder}
      onInput={(e) => onChange(e.currentTarget.innerHTML)}
      onKeyUp={saveSelection}
      onMouseUp={saveSelection}
      onBlur={saveSelection}
      className={cn(
        "min-h-40 flex-1 overflow-y-auto py-2 text-[13px] outline-none",
        "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        className,
      )}
    />
  );
}

// A formatting button that applies an execCommand. `onMouseDown` preventDefault
// keeps the editor's selection alive so the command lands on the selected text
// instead of being lost to the button taking focus.
function ToolBtn({
  onExec,
  cmd,
  value,
  label,
  children,
}: {
  onExec: (cmd: string, value?: string) => void;
  cmd: string;
  value?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onExec(cmd, value)}
      aria-label={label}
      title={label}
      className="shrink-0"
    >
      {children}
    </Button>
  );
}

const Sep = () => <Separator orientation="vertical" className="mx-0.5 h-4 shrink-0" />;

// Quick-pick swatches for the text-color popover; the full picker sits above.
const COLOR_PRESETS = [
  "#000000",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

// A "menu" trigger styled like the toolbar buttons — Font / Size open these. No
// preventDefault here: letting the editor blur saves its selection (RichEditor's
// onBlur), which `exec` restores before applying the command.
function MenuTrigger({ label }: { label: string }) {
  return (
    <Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2 font-medium">
      {label}
      <ChevronDown className="size-3 opacity-70" />
    </Button>
  );
}

export function FormatToolbar({
  mode,
  onExec,
  onToggleMarkdown,
  preview,
  onTogglePreview,
  onExitRich,
}: {
  mode: "text" | "markdown" | "html";
  onExec: (cmd: string, value?: string) => void;
  onToggleMarkdown: () => void;
  preview: boolean;
  onTogglePreview: () => void;
  // Drop an HTML body back to plain text.
  onExitRich: () => void;
}) {
  const [color, setColor] = useState("#000000");
  const isMd = mode === "markdown";
  return (
    // One line, never wraps — scrolls horizontally when the dock is narrow.
    <div className="flex items-center gap-0.5 overflow-x-auto border-b py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {!isMd && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger render={<MenuTrigger label="Font" />} />
            <DropdownMenuContent side="bottom" align="start" className="min-w-[8rem]">
              {FONTS.map((f) => (
                <DropdownMenuItem
                  key={f.label}
                  onClick={() => onExec("fontName", f.value)}
                  style={{ fontFamily: f.value }}
                >
                  {f.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<MenuTrigger label="Size" />} />
            <DropdownMenuContent side="bottom" align="start" className="min-w-[8rem]">
              {SIZES.map((s) => (
                <DropdownMenuItem key={s.label} onClick={() => onExec("fontSize", s.value)}>
                  {s.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Sep />
          <ToolBtn onExec={onExec} cmd="bold" label="Bold">
            <Bold className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="italic" label="Italic">
            <Italic className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="underline" label="Underline">
            <Underline className="size-3.5" />
          </ToolBtn>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Text color"
                  title="Text color"
                  className="shrink-0"
                >
                  <Baseline className="size-3.5" />
                </Button>
              }
            />
            <PopoverContent side="bottom" align="start" className="w-56 p-3">
              <ColorPicker value={color} onChange={setColor} />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Apply ${c}`}
                    onClick={() => {
                      setColor(c);
                      onExec("foreColor", c);
                    }}
                    style={{ backgroundColor: c }}
                    className="size-5 rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
                  />
                ))}
              </div>
              <Button
                variant="primary"
                size="sm"
                className="mt-2.5 w-full"
                onClick={() => onExec("foreColor", color)}
              >
                Apply color
              </Button>
            </PopoverContent>
          </Popover>
          <Sep />
          <ToolBtn onExec={onExec} cmd="insertUnorderedList" label="Bulleted list">
            <List className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="insertOrderedList" label="Numbered list">
            <ListOrdered className="size-3.5" />
          </ToolBtn>
          <Sep />
          <ToolBtn onExec={onExec} cmd="justifyLeft" label="Align left">
            <AlignLeft className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="justifyCenter" label="Align center">
            <AlignCenter className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="justifyRight" label="Align right">
            <AlignRight className="size-3.5" />
          </ToolBtn>
          <Sep />
          <ToolBtn onExec={onExec} cmd="undo" label="Undo">
            <Undo2 className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="redo" label="Redo">
            <Redo2 className="size-3.5" />
          </ToolBtn>
          <Sep />
        </>
      )}
      {/* Markdown toggle lives in the editor bar. */}
      <Button
        variant="ghost"
        size="sm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleMarkdown}
        aria-pressed={isMd}
        title="Write in Markdown"
        className={cn(
          "shrink-0 px-2 font-medium",
          isMd && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        MD
      </Button>
      {isMd && (
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onTogglePreview}
          aria-pressed={preview}
          title="Toggle preview"
          className="shrink-0 px-2 font-medium"
        >
          {preview ? "Edit" : "Preview"}
        </Button>
      )}
      {mode === "html" && (
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onExitRich}
          title="Switch back to a plain-text message"
          className="ml-auto shrink-0 px-2 font-medium"
        >
          Plain text
        </Button>
      )}
    </div>
  );
}

export function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}

// Best-effort HTML → plain text for the multipart/alternative text part. Block
// elements become line breaks; everything else collapses to its text content.
export function htmlToText(html: string): string {
  const el = document.createElement("div");
  // react-doctor-disable-next-line dangerous-html-sink -- detached div never inserted into the DOM; used only for textContent extraction
  el.innerHTML = html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  return (el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
