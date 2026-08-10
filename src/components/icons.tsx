import type { SVGProps } from "react";

/**
 * Ultra-light, precise line icons for the space / UFO theme. Stroke is kept
 * thin (1.25) so they read as premium rather than the thick default icon sets.
 * All inherit `currentColor`.
 */
const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

export function UfoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8.5 11.4a3.5 3.5 0 0 1 7 0" />
      <ellipse cx="12" cy="12" rx="9" ry="3" />
      <path d="M5 12.4c1.2 1.6 4 2.4 7 2.4s5.8-.8 7-2.4" opacity="0.55" />
      <circle cx="8.6" cy="12" r="0.7" />
      <circle cx="12" cy="12.5" r="0.7" />
      <circle cx="15.4" cy="12" r="0.7" />
      <path d="M10.4 15c-1 2-1.5 3.6-1.6 5.2M13.6 15c1 2 1.5 3.6 1.6 5.2" opacity="0.5" />
    </svg>
  );
}

export function AlienIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <ellipse cx="12" cy="12.5" rx="6.4" ry="8" />
      <path d="M8.6 10.6c.9-1.5 2.4-1.5 3 0" />
      <path d="M12.4 10.6c.9-1.5 2.4-1.5 3 0" />
      <path d="M10 16.5c.7.7 3.3.7 4 0" opacity="0.7" />
    </svg>
  );
}

export function StarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5l1.7 5.1L19 10l-5.3 1.4L12 16.5l-1.7-5L5 10l5.3-1.4z" />
    </svg>
  );
}

export function CometIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M5 19l8.5-8.5" />
      <path d="M13.5 6.5c1.6-1.1 3.4-1 4.5.1s1.2 2.9 0 4.5l-3-3" opacity="0.8" />
      <circle cx="6.4" cy="17.6" r="1.1" />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function SignalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="1.8" />
      <path d="M8.6 8.6a5 5 0 0 0 0 6.8M15.4 8.6a5 5 0 0 1 0 6.8" />
      <path d="M6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12" opacity="0.55" />
    </svg>
  );
}

export function RadarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" opacity="0.6" />
      <path d="M12 12l6-3" />
    </svg>
  );
}
