import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { inputClass } from "./input.tsx";

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  return `#${hsvToRgb(h, s, v)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToHsv(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

interface Props {
  value: string;
  onChange: (hex: string) => void;
}

export function ColorPicker({ value, onChange }: Props) {
  // Keep hue/sat/val internally so dragging through black/white doesn't lose hue.
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(value) ?? [217, 0.27, 0.55]);
  const [hex, setHex] = useState(value);

  // Re-sync internal state when the value changes from outside (e.g. preset click).
  if (value !== hex && /^#[0-9a-f]{6}$/i.test(value)) {
    const next = hexToHsv(value);
    if (next) {
      setHsv(next);
      setHex(value);
    }
  }

  const [h, s, v] = hsv;

  const commit = (nh: number, ns: number, nv: number) => {
    const next: [number, number, number] = [nh, ns, nv];
    setHsv(next);
    const out = hsvToHex(nh, ns, nv);
    setHex(out);
    onChange(out);
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const dragSv = (e: React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const ns = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const nv = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
    commit(h, ns, nv);
  };

  const dragHue = (e: React.PointerEvent) => {
    const el = hueRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const nh = Math.min(360, Math.max(0, ((e.clientX - rect.left) / rect.width) * 360));
    commit(nh, s, v);
  };

  return (
    <div className="space-y-2">
      <div
        ref={svRef}
        onPointerDown={dragSv}
        onPointerMove={(e) => e.buttons === 1 && dragSv(e)}
        className="relative h-28 w-full cursor-crosshair rounded-md border"
        style={{
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), hsl(${h} 100% 50%)`,
        }}
      >
        <span
          className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute h-3 w-3 rounded-full border-2 border-white shadow"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, backgroundColor: hex }}
        />
      </div>

      <div
        ref={hueRef}
        onPointerDown={dragHue}
        onPointerMove={(e) => e.buttons === 1 && dragHue(e)}
        className="relative h-3 w-full cursor-pointer rounded-full border"
        style={{
          background:
            "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
        }}
      >
        <span
          className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute top-1/2 h-4 w-4 rounded-full border-2 border-white shadow"
          style={{ left: `${(h / 360) * 100}%`, backgroundColor: hsvToHex(h, 1, 1) }}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="h-6 w-6 shrink-0 rounded-md border" style={{ backgroundColor: hex }} />
        <input
          value={hex}
          onChange={(e) => {
            setHex(e.target.value);
            const next = hexToHsv(e.target.value);
            if (next) {
              setHsv(next);
              onChange(hsvToHex(...next));
            }
          }}
          spellCheck={false}
          maxLength={7}
          className={cn(inputClass, "font-mono uppercase")}
          aria-label="Hex color"
        />
      </div>
    </div>
  );
}
