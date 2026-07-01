import { useId } from "react";

/** App brand mark: orange tile with the Proton-style folded-flap envelope. */
export function Logo({ className }: { className?: string }) {
  const id = useId();
  const bg = `${id}-bg`;
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-label="cfmail"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={bg} x1="256" y1="0" x2="256" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fb923c" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${bg})`} />
      <g transform="translate(116,142.5) scale(2.64)">
        <path
          d="M83.46 16.17L67.31 29.74L67.32 29.74L46.16 48.66C42.55 51.88 37.17 51.96 33.48 48.85L0 20.67V74.9C0 81.03 4.91 86 10.96 86L83.46 86V16.17Z"
          fill="#ffffff"
          fillOpacity="0.58"
        />
        <path
          d="M83.46 16.16V86H95.04C101.09 86 106 81.03 106 74.9V2.47C106 0.38 103.6 -0.76 102 0.58L83.46 16.16Z"
          fill="#ffffff"
          fillOpacity="0.85"
        />
        <path
          d="M67.31 29.74L46.16 48.66C42.55 51.88 37.17 51.96 33.48 48.85L0 20.67V2.48C0 0.39 2.4 -0.76 4 0.58L46 35.88C50.06 39.29 55.95 39.29 60.01 35.88L67.31 29.74Z"
          fill="#ffffff"
        />
      </g>
    </svg>
  );
}
