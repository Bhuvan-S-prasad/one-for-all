import { useImportAgent } from "@ofa/client";
import { AGENT_FILE_FORMAT, type Agent, type AgentFileInput } from "@ofa/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Download, Upload } from "lucide-react";
import { useRef, type ChangeEvent } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { toast } from "@/lib/toast";

// An agent as a file (M5.12): download one from its Settings, or hatch one
// from a file on the Agents page. Files carry no sign-ins, secrets, memory
// or chats; an imported agent's skills wait for approval and its routines
// stay paused until you resume them.

const LINK =
  "inline-flex h-11 items-center gap-2 self-start rounded-full border border-input px-5 text-[15px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

export function ExportAgentCard({ agent }: { agent: Agent }) {
  return (
    <Card className="flex flex-col gap-3 p-6">
      <CardTitle className="text-[18px]">Export as a file</CardTitle>
      <p className="text-sm text-muted-foreground">
        {agent.name}'s job, standing rules, look, permissions, its own skills and routines, as a
        file you can keep or bring into another workspace. Sign-ins, secrets, memory and chats stay
        here.
      </p>
      <a
        href={`/api/agents/${encodeURIComponent(agent.id)}/export`}
        download={`${agent.slug}.agent.json`}
        className={LINK}
      >
        <Download className="size-[18px]" aria-hidden /> Download {agent.slug}.agent.json
      </a>
    </Card>
  );
}

export function ImportAgentButton() {
  const input = useRef<HTMLInputElement>(null);
  const importAgent = useImportAgent();
  const navigate = useNavigate();

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    let parsed: AgentFileInput;
    try {
      parsed = JSON.parse(await file.text()) as AgentFileInput;
      if (parsed.format !== AGENT_FILE_FORMAT) throw new Error("not an agent file");
    } catch {
      toast({ message: "That isn't an agent file from One-for-All.", tone: "error" });
      return;
    }
    const grants = parsed.agent?.grants?.length ?? 0;
    const skills = parsed.skills?.length ?? 0;
    const routines = parsed.routines?.length ?? 0;
    const ok = window.confirm(
      [
        `Hatch “${parsed.agent?.name ?? "this agent"}” from the file?`,
        `It asks for ${grants} permission${grants === 1 ? "" : "s"}; check them in its Settings.`,
        skills
          ? `${skills} skill${skills === 1 ? "" : "s"} will wait for your approval in Skills.`
          : "",
        routines
          ? `${routines} routine${routines === 1 ? "" : "s"} will stay paused until you resume them.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (!ok) return;
    importAgent.mutate(parsed, {
      onSuccess: (result) => {
        toast({
          message: [`Hatched ${result.agent.name}`, ...result.notes].join(". "),
          duration: result.notes.length ? 9_000 : undefined,
        });
        void navigate({ to: "/agents/$agentId/edit", params: { agentId: result.agent.id } });
      },
      onError: (error) => toast({ message: error.message, tone: "error" }),
    });
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void onFile(e)}
      />
      <button
        type="button"
        disabled={importAgent.isPending}
        onClick={() => input.current?.click()}
        className="flex h-11 items-center gap-2 rounded-full border border-input px-5 text-[15px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Upload className="size-[18px]" aria-hidden /> Import from a file
      </button>
    </>
  );
}
