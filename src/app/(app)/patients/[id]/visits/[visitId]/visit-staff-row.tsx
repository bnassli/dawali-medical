"use client";

import { useId, useState } from "react";
import type { StaffMember, VisitStaffSlot } from "@/modules/visits/staff";
import { setVisitStaffAction } from "./staff-actions";

interface SlotProps {
  visitId: string;
  slot: VisitStaffSlot;
  label: string;
  initial: StaffMember | null;
  choices: StaffMember[];
  editable: boolean;
}

function StaffSlot({ visitId, slot, label, initial, choices, editable }: SlotProps) {
  const id = useId();
  const [current, setCurrent] = useState<StaffMember | null>(initial);
  const [status, setStatus] = useState<"" | "saving" | "saved" | "error">("");
  const [message, setMessage] = useState<string | null>(null);

  // The assigned person stays selectable even if no longer an active member of the role.
  const options = current && !choices.some((c) => c.id === current.id) ? [current, ...choices] : choices;

  async function change(nextId: string) {
    const userId = nextId === "" ? null : nextId;
    setStatus("saving");
    setMessage(null);
    try {
      const result = await setVisitStaffAction({ visitId, slot, userId, expectedUserId: current?.id ?? null });
      if (result.ok) {
        setCurrent(result.member);
        setStatus("saved");
        return;
      }
      if (result.conflict) setCurrent(result.current ?? null);
      setStatus("error");
      setMessage(result.error);
    } catch {
      setStatus("error");
      setMessage("Not saved. Check the connection and try again.");
    }
  }

  return (
    <div className={`vs-slot vs-${slot}`} data-staff={slot}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={current?.id ?? ""}
        disabled={!editable || status === "saving"}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">—</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <span className={`vs-status ${status}`} role="status" aria-live="polite">
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : (message ?? "")}
      </span>
    </div>
  );
}

/** Doctor and nurse of the visit (ADR-039), where SonoSoft shows Interp Phys/Surgeon and Technologist. */
export function VisitStaffRow(props: {
  visitId: string;
  doctor: StaffMember | null;
  nurse: StaffMember | null;
  choices: Record<VisitStaffSlot, StaffMember[]>;
  editable: boolean;
}) {
  return (
    <section className="visit-staff" aria-label="Visit staff">
      <StaffSlot
        key={`doctor:${props.visitId}`}
        visitId={props.visitId}
        slot="doctor"
        label="Doctor"
        initial={props.doctor}
        choices={props.choices.doctor}
        editable={props.editable}
      />
      <StaffSlot
        key={`nurse:${props.visitId}`}
        visitId={props.visitId}
        slot="nurse"
        label="Nurse"
        initial={props.nurse}
        choices={props.choices.nurse}
        editable={props.editable}
      />
    </section>
  );
}
