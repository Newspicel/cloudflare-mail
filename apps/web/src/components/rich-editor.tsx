import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Underline,
  Undo2,
} from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { cn } from "@/lib/cn.ts";

export interface RichEditorHandle {
  exec(cmd: string, value?: string): void;
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

export const RichEditor = forwardRef<
  RichEditorHandle,
  {
    initialHtml: string;
    onChange: (html: string) => void;
    pendingCmd?: PendingCmd | null;
    placeholder?: string;
    className?: string;
  }
>(function RichEditor({ initialHtml, onChange, pendingCmd, placeholder, className }, ref) {
  const elRef = useRef<HTMLDivElement>(null);
  // Last in-editor selection, restored before running a command so controls
  // that steal focus (the native font/size selects) still apply to the text.
  const savedRange = useRef<Range | null>(null);
  // Captured once so the mount effect needs no changing deps (seed-on-mount).
  const initialHtmlRef = useRef(initialHtml);
  const pendingCmdRef = useRef(pendingCmd);

  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel?.rangeCount && elRef.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

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

  useImperativeHandle(ref, () => ({ exec }), [exec]);

  // Seed content once on mount; the editor is uncontrolled afterwards so the
  // caret never jumps. Run any command queued during the promote-to-HTML step.
  useEffect(() => {
    const el = elRef.current;
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
      role="textbox"
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
});

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
    <button
      type="button"
      // Keep the editor selection — don't let the click blur it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onExec(cmd, value)}
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
    >
      {children}
    </button>
  );
}

const SEP = <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />;

const PILL =
  "h-7 shrink-0 rounded px-1.5 font-medium text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/45";

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
  const selectCls =
    "h-7 shrink-0 rounded border-0 bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45";
  const isMd = mode === "markdown";
  return (
    // One line, never wraps — scrolls horizontally when the dock is narrow.
    <div className="flex items-center gap-0.5 overflow-x-auto border-b py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {!isMd && (
        <>
          <select
            aria-label="Font"
            className={selectCls}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) onExec("fontName", e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Font
            </option>
            {FONTS.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Text size"
            className={selectCls}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) onExec("fontSize", e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Size
            </option>
            {SIZES.map((s) => (
              <option key={s.label} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {SEP}
          <ToolBtn onExec={onExec} cmd="bold" label="Bold">
            <Bold className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="italic" label="Italic">
            <Italic className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="underline" label="Underline">
            <Underline className="size-3.5" />
          </ToolBtn>
          {/* Text color — native picker; the label keeps the editor selection. */}
          <label
            title="Text color"
            className="relative grid size-7 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
          >
            <Baseline className="size-3.5" />
            <input
              type="color"
              aria-label="Text color"
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={(e) => onExec("foreColor", e.target.value)}
            />
          </label>
          {SEP}
          <ToolBtn onExec={onExec} cmd="insertUnorderedList" label="Bulleted list">
            <List className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="insertOrderedList" label="Numbered list">
            <ListOrdered className="size-3.5" />
          </ToolBtn>
          {SEP}
          <ToolBtn onExec={onExec} cmd="justifyLeft" label="Align left">
            <AlignLeft className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="justifyCenter" label="Align center">
            <AlignCenter className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="justifyRight" label="Align right">
            <AlignRight className="size-3.5" />
          </ToolBtn>
          {SEP}
          <ToolBtn onExec={onExec} cmd="undo" label="Undo">
            <Undo2 className="size-3.5" />
          </ToolBtn>
          <ToolBtn onExec={onExec} cmd="redo" label="Redo">
            <Redo2 className="size-3.5" />
          </ToolBtn>
          {SEP}
        </>
      )}
      {/* Markdown toggle lives in the editor bar. */}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleMarkdown}
        aria-pressed={isMd}
        title="Write in Markdown"
        className={cn(
          PILL,
          isMd
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-card hover:text-foreground",
        )}
      >
        MD
      </button>
      {isMd && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onTogglePreview}
          aria-pressed={preview}
          title="Toggle preview"
          className={cn(PILL, "text-muted-foreground hover:bg-card hover:text-foreground")}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      )}
      {mode === "html" && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onExitRich}
          className={cn(PILL, "ml-auto text-muted-foreground hover:bg-muted hover:text-foreground")}
          title="Switch back to a plain-text message"
        >
          Plain text
        </button>
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
