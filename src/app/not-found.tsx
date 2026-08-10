import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Custom 404 — reached via notFound() in the detail route, or unknown URLs. */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-sm text-[--foreground-muted]">404 — not found</p>
      <h1 className="text-xl font-semibold mt-2 mb-4">
        That page or ticket doesn&rsquo;t exist.
      </h1>
      <Button asChild variant="secondary" size="sm">
        <Link href="/">Back to tickets</Link>
      </Button>
    </div>
  );
}
