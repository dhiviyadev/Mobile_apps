import { AnimatePresence, motion } from "framer-motion";
import { ShieldQuestion } from "lucide-react";
import { useCore } from "@/stores/core";
import { relTime } from "@/lib/format";
import { Badge, Button } from "./ui";

/** Floating stack of pending approvals. Nothing proposed by an agent executes until approved here. */
export function ApprovalStack({ compact }: { compact?: boolean }) {
  const approvals = useCore((s) => s.approvals);
  const decide = useCore((s) => s.decide);
  if (!approvals.length) return null;
  return (
    <div className={compact ? "space-y-2" : "pointer-events-none fixed right-5 bottom-5 z-40 flex w-[380px] flex-col gap-2"}>
      <AnimatePresence initial={false}>
        {approvals.slice(-3).map((a) => (
          <motion.div
            key={a.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="surface-elevated silver-edge pointer-events-auto p-3.5"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg bg-warn/10 text-warn">
                <ShieldQuestion size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[13px] font-medium text-fg">{a.title}</p>
                  {a.source === "hermes" && <Badge>Hermes</Badge>}
                </div>
                {a.detail && <p className="selectable mt-1 line-clamp-4 whitespace-pre-wrap text-[12px] leading-snug text-fg-2">{a.detail}</p>}
                <p className="mt-1 text-[11px] text-muted">
                  {a.kind} · {relTime(a.created_at)}
                </p>
                <div className="mt-2.5 flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => void decide(a.id, true)}>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void decide(a.id, false)}>
                    Deny
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {approvals.length > 3 && <p className="pointer-events-auto text-right text-[11px] text-muted">+{approvals.length - 3} more pending</p>}
    </div>
  );
}
