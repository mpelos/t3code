import { useAtomValue } from "@effect/atom-react";
import {
  type EditaiiActivity,
  type EditaiiConfiguration,
  type EditaiiPanel,
  type EnvironmentId,
  editaiiJournalProblemMessage,
  editaiiProblemMessage,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { editaiiEnvironment } from "../../state/editaii";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveContextWindowModelDisplayName } from "../chat/ContextWindowMeter.logic";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  BLOCKED_REASON,
  configurationProblem,
  describeJob,
  type EditaiiTarget,
  sameTarget,
  shownTarget,
} from "./EditaiiSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function EditaiiSettings() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("editaii")}>
        {environment ? (
          <EnvironmentConnection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Choose an environment to connect it to Editaii.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentConnection({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useAtomValue(editaiiEnvironment.state({ environmentId, input: {} }));
  const panel = AsyncResult.getOrElse(result, () => null);
  if (!panel)
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {AsyncResult.isFailure(result)
          ? "Could not read this environment's Editaii connection. Reconnect the environment or update T3."
          : "Loading Editaii connection…"}
      </p>
    );
  return (
    <ConnectionForm
      key={panel.connection.origin}
      environmentId={environmentId}
      label={label}
      panel={panel}
    />
  );
}

function ConnectionForm({
  environmentId,
  label,
  panel,
}: {
  environmentId: EnvironmentId;
  label: string;
  panel: EditaiiPanel;
}) {
  const state = panel.connection;
  const [origin, setOrigin] = useState(state.origin ?? "");
  const [machineName, setMachineName] = useState(label);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The link the person is asked about; the question goes away if the link shown changes.
  const [confirming, setConfirming] = useState<EditaiiTarget | null>(null);
  const allowed = useAtomValue(editaiiEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(editaiiEnvironment.configure, { reportFailure: false });
  const start = useAtomCommand(editaiiEnvironment.startPairing, { reportFailure: false });
  const reopen = useAtomCommand(editaiiEnvironment.reopenBrowser, { reportFailure: false });
  const disconnect = useAtomCommand(editaiiEnvironment.disconnect, { reportFailure: false });
  const disabled = pending || !allowed;
  const disconnected = state.status === "disconnected";
  const target = shownTarget(state);
  const asking = confirming !== null && target !== null && sameTarget(confirming, target);

  async function run(operation: "configure" | "start" | "reopen") {
    setPending(true);
    setError(null);
    const result =
      operation === "configure"
        ? await configure({ environmentId, input: { origin } })
        : operation === "start"
          ? await start({ environmentId, input: { machineName } })
          : await reopen({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Could not update the Editaii connection.",
      );
    }
  }

  async function end(shown: EditaiiTarget) {
    setConfirming(null);
    setPending(true);
    setError(null);
    const result = await disconnect({ environmentId, input: { target: shown } });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not disconnect from Editaii.");
    } else if (result.value === "not_current") {
      setError("The connection changed since it was shown. Review it and try again.");
    }
  }

  return (
    <div className="grid gap-5 px-4 py-3">
      <p className="text-sm text-muted-foreground">
        Pairing opens the browser on <strong>{label}</strong>, the computer running this T3
        environment. Complete the Editaii sign-in and confirmation on that computer, even when you
        are using T3 remotely.
      </p>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run("configure");
        }}
      >
        <label className="text-sm font-medium" htmlFor="editaii-origin">
          Editaii origin
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1">
            <Input
              id="editaii-origin"
              type="url"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://editaii.example.com"
              autoCapitalize="none"
              spellCheck={false}
              disabled={disabled || !disconnected}
              required
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || !disconnected || !origin.trim() || origin.trim() === state.origin}
          >
            Save origin
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The origin can only be changed while disconnected.{" "}
          {state.origin ? `Saved origin: ${state.origin}` : "Save the origin before pairing."}
        </p>
      </form>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run("start");
        }}
      >
        <label className="text-sm font-medium" htmlFor="editaii-machine-name">
          Machine name in Editaii
        </label>
        <Input
          id="editaii-machine-name"
          value={machineName}
          onChange={(event) => setMachineName(event.target.value)}
          maxLength={80}
          disabled={disabled || !disconnected}
          required
        />
        <div>
          <Button
            type="submit"
            disabled={
              disabled ||
              !disconnected ||
              !state.origin ||
              !machineName.trim() ||
              origin.trim() !== state.origin
            }
          >
            Connect to Editaii
          </Button>
        </div>
      </form>
      <div className="grid gap-2" role="status" aria-live="polite">
        <p className="text-sm font-medium">
          {state.status === "connected"
            ? "Connected to Editaii"
            : state.status === "pairing"
              ? "Waiting for the browser confirmation"
              : state.status === "redeeming"
                ? "Completing pairing…"
                : state.status === "error"
                  ? "Connection needs attention"
                  : "Disconnected"}
        </p>
        {state.machine && (
          <p className="text-sm text-muted-foreground">
            {state.machine.nome} · {state.machine.dono}
          </p>
        )}
        {state.problem && (
          <p className="text-sm text-destructive">{editaiiProblemMessage(state.problem)}</p>
        )}
        {panel.connector.journal && (
          <p className="text-sm text-destructive">
            {editaiiJournalProblemMessage(panel.connector.journal)} Editaii requests wait on this
            computer until it is fixed.
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {state.canReopen && (
          <Button variant="outline" disabled={disabled} onClick={() => void run("reopen")}>
            Open browser again
          </Button>
        )}
        {target?.type === "link" && (
          <Button variant="outline" disabled={disabled} onClick={() => setConfirming(target)}>
            Disconnect
          </Button>
        )}
        {target?.type === "attempt" && (
          <Button variant="outline" disabled={disabled} onClick={() => void end(target)}>
            Cancel pairing
          </Button>
        )}
      </div>
      <ProjectChoice
        environmentId={environmentId}
        projectId={state.projectId}
        configuration={panel.configuration}
      />
      {panel.activity && (
        <section className="grid gap-2" aria-labelledby="editaii-activity">
          <h3 id="editaii-activity" className="text-sm font-medium">
            Editaii work on this computer
          </h3>
          <ActivityList environmentId={environmentId} activity={panel.activity} />
        </section>
      )}
      <AlertDialog
        open={asking}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {state.machine?.nome ?? "this computer"} from Editaii?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the Editaii credentials of this T3 environment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid max-h-[50vh] gap-3 overflow-y-auto px-6 pb-4">
            {panel.activity && (
              <ActivityList environmentId={environmentId} activity={panel.activity} />
            )}
            <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
              <li>Threads already running in T3 keep running. Disconnecting does not stop them.</li>
              <li>Nothing more returns to Editaii from this computer: no results, no updates.</li>
              <li>
                The machine stays registered in Editaii. Revoke it there to remove its access.
              </li>
            </ul>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => confirming && void end(confirming)}
            >
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ProjectChoice({
  environmentId,
  projectId,
  configuration,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  configuration: EditaiiConfiguration;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const allowed = useAtomValue(editaiiEnvironment.chooseProject.permissionAtom(environmentId));
  const choose = useAtomCommand(editaiiEnvironment.chooseProject, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = configurationProblem(configuration);
  const chosen =
    projectId === null
      ? "No project"
      : (projects.find((project) => project.id === projectId)?.title ?? "Missing project");

  async function pick(value: string) {
    setPending(true);
    setError(null);
    const result = await choose({
      environmentId,
      input: { projectId: value === "" ? null : ProjectId.make(value) },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not choose the project.");
    }
  }

  return (
    <div className="grid gap-2">
      <p id="editaii-project" className="text-sm font-medium">
        Project for new conversations
      </p>
      <Select
        value={projectId ?? ""}
        onValueChange={(value) => void pick(value ?? "")}
        disabled={pending || !allowed}
      >
        <SelectTrigger aria-labelledby="editaii-project" className="w-full sm:w-80">
          <SelectValue>{chosen}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="" label="No project">
            No project
          </SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id} label={project.title}>
              {project.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {configuration.type === "ready" ? (
        <ReadyConfiguration environmentId={environmentId} configuration={configuration} />
      ) : (
        <p className="text-xs text-destructive">{problem}</p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What a new conversation runs with, as T3 resolves it for the chosen project. */
function ReadyConfiguration({
  environmentId,
  configuration,
}: {
  environmentId: EnvironmentId;
  configuration: Extract<EditaiiConfiguration, { readonly type: "ready" }>;
}) {
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const { instanceId, model } = configuration.modelSelection;
  const instance =
    providerInstanceEntriesFor(providers, settings, configuration.projectId).find(
      (entry) => entry.instanceId === instanceId,
    )?.displayName ?? instanceId;
  const modelName =
    resolveContextWindowModelDisplayName(
      configuration.modelSelection,
      getCustomModelOptionsByInstance(settings, providers, instanceId, model),
    ) ?? model;
  return (
    <p className="text-xs text-muted-foreground">
      New conversations run in {configuration.projectTitle} with{" "}
      <strong className="font-medium text-foreground">{modelName}</strong> on {instance},{" "}
      {runtimeModeConfig[configuration.runtimeMode].label.toLowerCase()}. Change these in the
      project's settings.
    </p>
  );
}

function ActivityList({
  environmentId,
  activity,
}: {
  environmentId: EnvironmentId;
  activity: EditaiiActivity;
}) {
  if (activity.type === "unavailable")
    return (
      <p className="text-sm text-destructive">
        Could not verify the Editaii work on this computer.{" "}
        {editaiiJournalProblemMessage(activity.reason)}
      </p>
    );
  if (activity.jobs.length === 0 && activity.blockedConversations.length === 0)
    return <p className="text-sm text-muted-foreground">No Editaii work on this computer.</p>;
  return (
    <ul className="grid gap-2 text-sm">
      {activity.jobs.map((job) => {
        const { state, owed } = describeJob(job);
        return (
          <li key={job.jobId} className="grid gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{state}</span>
              <ThreadLink environmentId={environmentId} threadId={job.threadId} />
            </span>
            {owed.length > 0 && (
              <span className="text-xs text-muted-foreground">{owed.join(" · ")}</span>
            )}
          </li>
        );
      })}
      {activity.blockedConversations.map((conversation) => (
        <li key={conversation.conversationId} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{BLOCKED_REASON[conversation.reason]}</span>
          <ThreadLink environmentId={environmentId} threadId={conversation.threadId} />
        </li>
      ))}
    </ul>
  );
}

function ThreadLink({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string | null;
}) {
  if (threadId === null) return <span className="text-xs text-muted-foreground">No thread</span>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: ThreadId.make(threadId) }}
      className="text-xs underline underline-offset-2"
    >
      Open thread
    </Link>
  );
}
