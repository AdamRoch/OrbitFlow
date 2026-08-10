"use client";

import { useActionState, useState } from "react";
import { createLabelAction, deleteLabelAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Plus, Trash2, Check, X } from "lucide-react";

const PRESET_COLORS = [
  "#22c55e",
  "#ef4444",
  "#3b82f6",
  "#f2c94c",
  "#a855f7",
  "#6b7280",
];

export function CreateLabelForm() {
  const [state, action] = useActionState(createLabelAction, { ok: true });
  const [color, setColor] = useState(PRESET_COLORS[0]);

  return (
    <form action={action} className="glass rounded-2xl p-4 space-y-3">
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Field label="Name">
          <Input name="name" placeholder="e.g. backend" autoFocus />
        </Field>
        <Field label="Color">
          <div className="flex items-center gap-2">
            <input type="hidden" name="color" value={color} />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-10 rounded-lg border border-[--border] bg-transparent cursor-pointer"
            />
            <span className="font-mono text-xs text-[--foreground-muted]">
              {color}
            </span>
          </div>
        </Field>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
            style={{
              backgroundColor: c,
              borderColor: color.toLowerCase() === c.toLowerCase() ? "#fff" : "transparent",
            }}
            aria-label={`Pick ${c}`}
          />
        ))}
      </div>

      {state && !state.ok && state.error && (
        <p className="text-xs text-[--danger]">{state.error}</p>
      )}

      <Button type="submit" variant="primary" size="sm" icon={<Plus size={13} />}>
        Create label
      </Button>
    </form>
  );
}

export function DeleteLabelButton({
  id,
  name,
}: {
  id: number;
  name: string;
}) {
  const bound = deleteLabelAction.bind(null, id);
  const [_state, dispatch] = useActionState(bound, { ok: true });
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={13} />
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs text-[--foreground-muted]">
        Delete “{name}”?
      </span>
      <form action={dispatch}>
        <Button variant="danger" size="sm" type="submit">
          <Check size={13} />
        </Button>
      </form>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setConfirming(false)}
      >
        <X size={13} />
      </Button>
    </span>
  );
}
