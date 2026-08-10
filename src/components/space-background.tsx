/**
 * Fixed, pointer-events-none space backdrop. CSS-only: nebula + two starfields
 * + masked grid. (The Three.js layer that used to live on top was dropped as
 * overkill for a local tracker.)
 */
export function SpaceBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <div className="nebula" />
      <div className="starfield" />
      <div className="starfield-2" />
      <div className="grid-veil" />
    </div>
  );
}
