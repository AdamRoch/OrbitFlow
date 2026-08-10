"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  addBlockerAction,
  claimIssueAction,
  deleteIssueAction,
  removeBlockerAction,
  setIssueLabelsAction,
  updateIssueAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
} from "@/components/issue-display";
import { StatusBadge } from "@/components/issue-display";
import type { IssueDTO, LabelDTO } from "@/lib/types";
import { SYSTEM_LABEL_NAME } from "@/lib/config";
import { Pencil, Trash2, Play, Check, X, Plus } from "lucide-react";

/**
 * Client island holding the interactive controls on the issue detail page:
 * inline edit form, claim/delete buttons, label editor, and dependency
 * add/remove. Each control dispatches a server action and reads back the
 * result via useActionState for inline feedback.
 *
 */
export function IssueDetailForms({
  issue,
  allLabels,
  blockers,
  blockedBy,
}: {
  issue: IssueDTO;
  allLabels: LabelDTO[];
  blockers: IssueDTO[];
  blockedBy: IssueDTO[];
}) {
  const [editing, setEditing] = useState(false);
  const [showAddBlocker, setShowAddBlocker] = useState(false);

  const boundUpdate = updateIssueAction.bind(null, issue.identifier);
  const [updateState, updateAction] = useActionState(boundUpdate, { ok: true });

  const boundSetLabels = setIssueLabelsAction.bind(null, issue.identifier);
  const [labelsState, labelsAction] = useActionState(boundSetLabels, {
    ok: true,
  });

  const boundClaim = claimIssueAction.bind(null, issue.identifier);
  const [claimState, claimAction] = useActionState(boundClaim, { ok: true });

  const boundAddBlocker = addBlockerAction.bind(null, issue.identifier);
  const [addBlockerState, dispatchAddBlocker] = useActionState(boundAddBlocker, {
    ok: true,
  });

  // Auto-collapse the edit form on a successful save.
  const prevUpdateOk = useRef(updateState.ok);
  useEffect(() => {
    if (!prevUpdateOk.current && updateState.ok) setEditing(false);
    prevUpdateOk.current = updateState.ok;
  }, [updateState.ok]);

  return (
    <div className="space-y-6">
      {/* Top action bar */}
      <div className="flex flex-wrap items-center gap-2 pb-4 border-b border-[--border]">
        {issue.status === "todo" || issue.status === "in_progress" ? (
          <form action={claimAction}>
            <Button type="submit" variant="primary" size="sm" icon={<Play size={13} />}>
              {issue.status === "in_progress" ? "Re-claim" : "Claim"}
            </Button>
          </form>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing((v) => !v)}
          icon={<Pencil size={13} />}
        >
          {editing ? "Cancel edit" : "Edit"}
        </Button>
        <DeleteButton identifier={issue.identifier} />
      </div>

      {claimState && !claimState.ok && claimState.error && (
        <ErrorNote>{claimState.error}</ErrorNote>
      )}
      {updateState && !updateState.ok && updateState.error && (
        <ErrorNote>{updateState.error}</ErrorNote>
      )}

      {editing && (
        <form action={updateAction} className="glass space-y-4 rounded-2xl border border-[--border] p-4">
          <Field label="Title">
            <Input name="title" defaultValue={issue.title} />
          </Field>
          <Field label="Description (markdown)">
            <Textarea
              name="description"
              defaultValue={issue.description ?? ""}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Status">
              <Select name="status" defaultValue={issue.status}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select name="priority" defaultValue={String(issue.priority)}>
                {PRIORITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="primary" size="sm" icon={<Check size={13} />}>
            Save changes
          </Button>
        </form>
      )}

      {/* Labels editor */}
      <section>
        <h2 className="eyebrow mb-3">Labels</h2>
        {allLabels.length === 0 ? (
          <p className="text-xs text-[--foreground-subtle]">
            No labels exist yet. Create some on the{" "}
            <a href="/labels" className="text-[--accent] underline underline-offset-2">
              labels page
            </a>
            .
          </p>
        ) : (
          <form action={labelsAction} className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {allLabels
                .filter(
                  (l) => l.name.toLowerCase() !== SYSTEM_LABEL_NAME,
                )
                .map((l) => {
                const checked = issue.labels.some((il) => il.id === l.id);
                return (
                  <label
                    key={l.id}
                    className="inline-flex items-center gap-1.5 text-sm text-[--foreground] cursor-pointer rounded-full border border-[--border] bg-[--surface-2]/60 px-3 py-1.5 backdrop-blur-sm hover:bg-[--surface-hover] transition-colors"
                  >
                    <input
                      type="checkbox"
                      name="labelNames"
                      value={l.name}
                      defaultChecked={checked}
                    />
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: l.color }}
                    />
                    {l.name}
                  </label>
                );
              })}
            </div>
            <Button type="submit" variant="secondary" size="sm" icon={<Check size={13} />}>
              Update labels
            </Button>
            {labelsState && !labelsState.ok && labelsState.error && (
              <p className="text-xs text-[--danger]">{labelsState.error}</p>
            )}
          </form>
        )}
      </section>

      {/* Dependency add controls */}
      <section>
        <h2 className="eyebrow mb-3">Blockers</h2>
        {blockers.length > 0 ? (
          <ul className="space-y-1.5 mb-2">
            {blockers.map((b) => (
              <li
                key={b.id}
                className="flex items-center gap-2 rounded-xl border border-[--border] bg-[--surface]/60 px-3 py-2 text-sm backdrop-blur-sm"
              >
                <span className="font-mono text-xs text-[--foreground-subtle]">
                  {b.identifier}
                </span>
                <span className="flex-1 truncate text-[--foreground]">
                  {b.title}
                </span>
                <StatusBadge status={b.status} />
                <RemoveBlockerButton
                  identifier={issue.identifier}
                  blockerId={String(b.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[--foreground-subtle] mb-2">
            No blockers.
          </p>
        )}

        {showAddBlocker ? (
          <form
            action={dispatchAddBlocker}
            className="flex items-center gap-2"
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowAddBlocker(false);
            }}
          >
            <Input
              name="blockerId"
              placeholder="FACT-42 or ticket id"
              autoFocus
              className="h-9 text-sm"
            />
            <Button type="submit" variant="secondary" size="sm" icon={<Check size={13} />}>
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowAddBlocker(false)}
              icon={<X size={13} />}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowAddBlocker(true)}
            icon={<Plus size={13} />}
          >
            Add blocker
          </Button>
        )}
        {addBlockerState && !addBlockerState.ok && addBlockerState.error && (
          <p className="text-xs text-[--danger] mt-1">
            {addBlockerState.error}
          </p>
        )}
      </section>

      {blockedBy.length > 0 && (
        <section>
          <h2 className="eyebrow mb-3">This ticket blocks</h2>
          <ul className="space-y-1.5">
            {blockedBy.map((b) => (
              <li key={b.id}>
                <a
                  href={`/issues/${b.identifier}`}
                  className="group flex items-center gap-2 rounded-xl border border-[--border] bg-[--surface]/60 px-3 py-2 text-sm backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-[--border-strong] hover:bg-[--surface-hover]/80"
                >
                  <span className="font-mono text-xs text-[--foreground-subtle]">
                    {b.identifier}
                  </span>
                  <span className="flex-1 truncate text-[--foreground] group-hover:text-white">
                    {b.title}
                  </span>
                  <StatusBadge status={b.status} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[--danger]/50 bg-[--danger]/10 px-3 py-2 text-xs text-[--danger]">
      {children}
    </div>
  );
}

function DeleteButton({
  identifier,
}: {
  identifier: string;
}) {
  const boundDelete = deleteIssueAction.bind(null, identifier);
  const [state, dispatch] = useActionState(boundDelete, { ok: true });
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        variant="danger"
        size="sm"
        type="button"
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={13} />
        Delete
      </Button>
    );
  }
  return (
    <form action={dispatch} className="inline-flex items-center gap-2">
      <span className="text-xs text-[--foreground-muted]">Delete this ticket?</span>
      <Button variant="danger" size="sm" type="submit">
        <Check size={13} />
        Confirm
      </Button>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setConfirming(false)}
      >
        <X size={13} />
      </Button>
      {state && !state.ok && state.error && (
        <span className="text-xs text-[--danger]">{state.error}</span>
      )}
    </form>
  );
}

function RemoveBlockerButton({
  identifier,
  blockerId,
}: {
  identifier: string;
  blockerId: string;
}) {
  const bound = removeBlockerAction.bind(null, identifier, blockerId);
  const [_state, dispatch] = useActionState(bound, { ok: true });
  return (
    <form action={dispatch}>
      <button
        type="submit"
        className="text-[--foreground-subtle] hover:text-[--danger] p-1"
        title="Remove this blocker"
      >
        <X size={13} />
      </button>
    </form>
  );
}
