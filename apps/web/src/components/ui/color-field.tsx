import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { ColorPicker } from "./color-picker.tsx";

export const DEFAULT_COLOR = "#64748b";

const PRESET_COLORS = [
  "#64748b",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#6366f1",
  "#ec4899",
];

// Preset swatches + a custom-color toggle that reveals the full ColorPicker.
// Shared by labels and folders so both pick colors the same way.
export function ColorField({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  const [custom, setCustom] = useState(() => !PRESET_COLORS.includes(color));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              onChange(c);
              setCustom(false);
            }}
            className={cn(
              "h-5 w-5 rounded-full border",
              !custom && color === c ? "ring-2 ring-ring ring-offset-1 ring-offset-card" : "",
            )}
            style={{ backgroundColor: c }}
            aria-label={c}
          />
        ))}
        <button
          type="button"
          onClick={() => setCustom((v) => !v)}
          className={cn(
            "h-5 w-5 rounded-full border",
            custom ? "ring-2 ring-ring ring-offset-1 ring-offset-card" : "",
          )}
          style={{
            background: custom
              ? color
              : "conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #06b6d4, #6366f1, #ec4899, #ef4444)",
          }}
          aria-label="Custom color"
          title="Custom color"
        />
      </div>
      {custom && <ColorPicker value={color} onChange={onChange} />}
    </div>
  );
}
