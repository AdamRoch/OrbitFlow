import Link from "next/link";
import { listLabels } from "@/lib/domain";
import { getServerDb } from "@/lib/server-data";
import { LabelChip } from "@/components/issue-display";
import { CreateLabelForm, DeleteLabelButton } from "./label-forms";
import { AlienIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { SYSTEM_LABEL_COLOR, SYSTEM_LABEL_NAME } from "@/lib/config";

/**
 * Labels management (/labels). List + create + delete. Deleting a label
 * cascades (removes it from issues, keeps the issues). The "Ready for Agent"
 * label is system-managed (derived from issue state), so it's shown read-only
 * at the top and cannot be created, assigned, or deleted.
 */
export default async function LabelsPage() {
  const db = getServerDb();
  const labels = listLabels(db);
  // Stored labels won't include the system label, but filter defensively in
  // case an older seed left one behind so it isn't shown twice / as deletable.
  const userLabels = labels.filter(
    (l) => l.name.toLowerCase() !== SYSTEM_LABEL_NAME,
  );

  return (
    <div className="max-w-2xl">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-xs text-[--foreground-muted] hover:text-[--foreground] mb-4 transition-colors"
      >
        <span className="rotate-180">→</span>
        Back to tickets
      </Link>
      <Reveal>
        <span className="eyebrow">
          <AlienIcon className="h-3 w-3" />
          Classification
        </span>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[--foreground] text-glow mb-5">
          Labels
        </h1>
      </Reveal>

      <Reveal delay={60}>
        <div className="glass rounded-2xl p-5">
          <CreateLabelForm />
        </div>
      </Reveal>

      <div className="mt-6 space-y-2">
        <div
          className="flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface]/60 px-4 py-3 backdrop-blur-sm"
        >
          <LabelChip
            label={{ id: 0, name: SYSTEM_LABEL_NAME, color: SYSTEM_LABEL_COLOR }}
          />
          <span className="font-mono text-xs text-[--foreground-subtle]">
            {SYSTEM_LABEL_COLOR}
          </span>
          <div className="flex-1" />
          <span className="text-xs text-[--foreground-subtle]">
            System · auto-applied
          </span>
        </div>
        {userLabels.length === 0 ? (
          <p className="text-sm text-[--foreground-subtle] pt-2">
            No custom labels yet. Create one above.
          </p>
        ) : (
          userLabels.map((l) => (
            <div
              key={l.id}
              className="flex items-center gap-3 rounded-xl border border-[--border] bg-[--surface]/60 px-4 py-3 backdrop-blur-sm transition-colors hover:border-[--border-strong]"
            >
              <LabelChip label={l} />
              <span className="font-mono text-xs text-[--foreground-subtle]">
                {l.color}
              </span>
              <div className="flex-1" />
              <DeleteLabelButton id={l.id} name={l.name} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
