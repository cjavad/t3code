import { RefreshIcon } from "~/components/ui/refresh-icon";
import * as Option from "effect/Option";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  EnvironmentId,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { GitIcon, JujutsuIcon, type Icon } from "../Icons";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { SourceControlAccountSettings } from "./SourceControlAccountSettings";
import { SourceControlAppSignInSettings } from "./SourceControlAppSignInSettings";
import { SourceControlTokenSettings } from "./SourceControlTokenSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting, sourceControlHostSettingsSearchId } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { sourceControlIcon } from "~/sourceControlPresentation";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

/** The status chip at the end of a provider row. */
function itemChip(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary" | "unavailable";
} {
  if (isVcsNotReady(item)) return { label: "Coming soon", variant: "warning" };
  if (item.status !== "available") return { label: "Not installed", variant: "unavailable" };
  if (!isProviderDiscoveryItem(item)) return { label: "Ready", variant: "success" };
  if (item.auth.status === "authenticated") return { label: "Authenticated", variant: "success" };
  if (item.auth.status === "unauthenticated")
    return { label: "Not authenticated", variant: "secondary" };
  return { label: "Available", variant: "secondary" };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function sourceControlItemIcon(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): ReactNode {
  const host = isProviderDiscoveryItem(item) ? sourceControlClients.find(item.kind) : undefined;
  const Icon = isProviderDiscoveryItem(item)
    ? host && sourceControlIcon(host)
    : VCS_ICONS[item.kind];
  return Icon ? <Icon /> : null;
}

function itemSummary({
  item,
  auth,
  authAccount,
  version,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
  readonly version: string | null;
}) {
  const toolVersion = version
    ? auth && item.executable
      ? `${item.executable} ${version}`
      : version
    : null;
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server: {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      const authDetail = optionLabel(auth.detail);
      return (
        <>
          {authAccount ? (
            <>
              <span>Signed in as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : (
            <span>Signed in</span>
          )}
          {authDetail ? <span className="basis-full">{authDetail}</span> : null}
          {toolVersion ? <span className="basis-full">{toolVersion}</span> : null}
        </>
      );
    }

    if (!item.executable && auth.status === "unauthenticated") {
      return <span>Available. {item.installHint}</span>;
    }

    if (auth.status === "unauthenticated" && auth.accounts?.some((entry) => entry.authenticated)) {
      return <span>{optionLabel(auth.detail) ?? `Every ${item.label} host is turned off.`}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          Sign in with{" "}
          <code className="rounded bg-muted px-1 py-px text-micro">{item.executable}</code> on the
          server host to enable change request features.
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    if (authDetail) {
      return (
        <span>
          Could not verify {item.label}. {authDetail}
        </span>
      );
    }
    return <span>{item.executable} found on this environment</span>;
  }

  return <span>{toolVersion ?? "Available"}</span>;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const chip = itemChip(item);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;
  const searchTargetId = useSettingsSearchTargetId();
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  const targetsThisRow = searchTargetId === sourceControlHostSettingsSearchId(item.kind);
  if (targetsThisRow && !isExpanded && seenSearchTargetId !== searchTargetId) {
    setIsExpanded(true);
  }
  if (seenSearchTargetId !== searchTargetId) setSeenSearchTargetId(searchTargetId);

  return (
    <div className={cn(isVcsNotReady(item) && "opacity-80")}>
      <SettingsRow
        leading={sourceControlItemIcon(item)}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate">{item.label}</span>
            {version ? <code className="text-meta text-dim-foreground">{version}</code> : null}
            {chip.variant === "warning" ? (
              <Badge variant="warning">{chip.label}</Badge>
            ) : chip.variant === "secondary" &&
              isProviderDiscoveryItem(item) &&
              item.auth.status === "unauthenticated" ? (
              <Badge variant="secondary">{chip.label}</Badge>
            ) : null}
          </span>
        }
        description={
          <span className="flex min-w-0 flex-wrap items-center gap-x-1">
            {itemSummary({ item, auth, authAccount, version: null })}
          </span>
        }
        trailing={
          hasDetails ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              onClick={() => setIsExpanded((open) => !open)}
              aria-expanded={isExpanded}
              aria-label={`Toggle ${item.label} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
          ) : null
        }
      />
      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-3 sm:px-4">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton shape="pill" className="h-4 w-28" />
            <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
          </div>
          <Skeleton shape="pill" className="h-5 w-20" />
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const hasError = error !== null;

  return (
    <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <PullRequestGlyph.pullRequest />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? "Could not scan the server environment" : "Nothing detected yet"}
          </EmptyTitle>
          <EmptyDescription>
            {hasError
              ? error
              : "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="secondary" onClick={onScan} disabled={isPending}>
            <RefreshIcon size="sm" refreshing={isPending} />
            Scan
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

function GitIdentitySettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const identity = useEnvironmentQuery(
    sourceControlEnvironment.gitIdentity({ environmentId, input: {} }),
  );
  const update = useAtomCommand(sourceControlEnvironment.updateGitIdentity, {
    reportFailure: false,
  });
  const [nameEdit, setDisplayName] = useState<string>();
  const [emailEdit, setEmail] = useState<string>();
  const [usernameEdit, setGithubUsername] = useState<string>();
  const [githubToken, setGithubToken] = useState("");
  const [saving, setSaving] = useState(false);
  const displayName = nameEdit ?? identity.data?.displayName ?? "";
  const email = emailEdit ?? identity.data?.email ?? "";
  const githubUsername = usernameEdit ?? identity.data?.githubUsername ?? "";

  const save = async () => {
    setSaving(true);
    try {
      const result = await update({
        environmentId,
        input: {
          displayName,
          email,
          githubUsername,
          ...(githubToken.trim() ? { githubToken: githubToken.trim() } : {}),
        },
      });
      if (result._tag === "Success") {
        setGithubToken("");
        identity.refresh();
        toastManager.add({
          type: "success",
          title: "Git identity saved",
          description: "New commits will use this identity and SSH signing key.",
        });
      } else {
        toastManager.add({ type: "error", title: "Git identity could not be saved" });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Git identity could not be saved",
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setSaving(false);
  };

  return (
    <SettingsSection title="Git identity and signing">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <p className="text-body text-muted-foreground">
          Commits are signed with a per-user Ed25519 SSH key. Add the public key to GitHub under
          Settings → SSH and GPG keys → New SSH key → Signing key.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Name"
          />
          <Input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Git email"
            type="email"
          />
        </div>
        <Input
          value={githubUsername}
          onChange={(event) => setGithubUsername(event.target.value)}
          placeholder="GitHub username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <Input
          value={githubToken}
          onChange={(event) => setGithubToken(event.target.value)}
          placeholder={
            identity.data?.githubTokenConfigured
              ? "GitHub token saved"
              : "GitHub token for PRs (optional)"
          }
          type="password"
        />
        {identity.data?.signingKey ? (
          <pre className="max-h-24 overflow-auto rounded-md bg-muted/40 p-2 text-micro text-muted-foreground">
            {identity.data.signingKey}
          </pre>
        ) : null}
        <Button
          size="sm"
          onClick={save}
          disabled={saving || !displayName.trim() || !email.trim() || !githubUsername.trim()}
        >
          {saving ? "Saving…" : "Save identity"}
        </Button>
      </div>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();

  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentContext =
    aggregate && environment ? (
      <span className="text-meta text-muted-foreground">{environment.label}</span>
    ) : null;
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  const hostSettingsPanel = (item: SourceControlProviderDiscoveryItem) => {
    const definition = sourceControlClients.find(item.kind);
    if (!definition?.settings || environmentId === null) return undefined;
    const { credentials } = definition;
    if (credentials) {
      return (
        <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
          <div className="grid gap-6">
            {credentials.appSignIn && item.appSignIn === true ? (
              <SourceControlAppSignInSettings
                key={`sign-in-${environmentId}`}
                environmentId={environmentId}
                definition={definition}
                appSignIn={credentials.appSignIn}
                account={Option.getOrNull(item.auth.account)}
                onChanged={handleScan}
              />
            ) : null}
            {credentials.appSignIn && item.appSignIn === true ? (
              <div className="flex items-center gap-3 text-caption text-muted-foreground">
                <span aria-hidden className="h-px flex-1 bg-border" />
                Or use your own credentials
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <SourceControlTokenSettings
              key={`token-${environmentId}`}
              environmentId={environmentId}
              definition={definition}
              credentials={credentials}
              onSaved={handleScan}
            />
            {item.status === "available" ? (
              <SourceControlAccountSettings
                key={environmentId}
                environmentId={environmentId}
                definition={definition}
                credentials={credentials}
                auth={item.auth}
                onSaved={handleScan}
              />
            ) : null}
          </div>
        </SettingsSearchTarget>
      );
    }
    return (
      <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
        <SourceControlHostSettings
          key={environmentId}
          environmentId={environmentId}
          definition={{ ...definition, settings: definition.settings }}
          onSaved={handleScan}
        />
      </SettingsSearchTarget>
    );
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // Hangs 6px past the header row so the glyph's ink ends on the card edge.
            className="-me-1.5"
            size="icon-xs"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan Git and hosting integrations"
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  const providersTitle = "Source Control Providers";
  return (
    <SettingsPageContainer className="max-w-[688px]">
      <ProjectDefaultsSettings category="source-control" />
      {environmentId === null ? (
        <SettingsSection
          id={searchableSetting("source-control").id}
          title="Source Control Providers"
        >
          <p className="px-4 py-3 text-body text-muted-foreground">
            Connect an environment to inspect its version control tools and hosting integrations.
          </p>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <SourceControlSectionSkeleton title={providersTitle} headerAction={scanButton} />
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title="Version Control"
              titleAction={environmentContext}
              headerAction={scanButton}
            >
              {result.versionControlSystems.map((item) => (
                <DiscoveryItemRow key={`vcs:${item.kind}`} item={item} />
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title="Source Control Providers"
              titleAction={hasVersionControlSystems ? null : environmentContext}
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
                  {hostSettingsPanel(item)}
                </DiscoveryItemRow>
              ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}

      {environmentId !== null ? (
        <GitIdentitySettings key={environmentId} environmentId={environmentId} />
      ) : null}

      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
