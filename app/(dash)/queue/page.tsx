import { QueueTable } from "@/components/delta/queue-table";
import { getQueue } from "@/lib/dash/queries";

export const metadata = { title: "Queue — Delta" };

export default async function QueuePage() {
  const rows = await getQueue(200);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Queue</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every detected risk item with its score, the action the agent proposes, and what the
          policy engine decided. Blocked items are listed alongside sent ones — a STOP is a
          decision, not an absence.
        </p>
      </header>

      <QueueTable rows={rows} />
    </div>
  );
}
