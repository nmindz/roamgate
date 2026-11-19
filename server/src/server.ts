import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import packageJson from "../../package.json";
import type { ExtensionsPush } from "../../shared/extensions";
import { isHtmlPath } from "../../shared/filePreview";
import {
  createAgentSeenStore,
  createHerdrBootCache,
  markAgentSeen,
} from "./agent/agent-seen";
import { createAssistantContext } from "./assistant/context";
import { HerdrClient } from "./bridge/herdr-client";
import { createUiSettingsRpcHandler } from "./bridge/settings-rpc";
import {
  createSshForwards,
  forwardToWire,
  roamgateOwnPorts,
} from "./bridge/ssh-forward";
import { sweepOrphanedSshMasters } from "./bridge/ssh-master";
import { runInSshLane, type SshLane } from "./bridge/ssh-sessions";
import type { SshTunnelConfig } from "./bridge/ssh-tunnel";
import {
  flushCoalescedMessages,
  sendWebSocketMessage,
  WebSocketCleanupTracker,
  WS_PER_MESSAGE_DEFLATE,
} from "./bridge/websocket-send";
import { cliCommands, runCli, topLevelHelp } from "./cli";
import { CONTINUE_TO_SERVER, defaultCliContext } from "./cli/command";
import {
  authTokenPrintCommand,
  isShortAuthPassword,
  RECOMMENDED_PASSWORD_LENGTH,
} from "./config/auth-token";
import {
  readGuiSettings,
  worktreeRemoveCommandFor,
} from "./config/gui-settings";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  loadServerConfig,
  openBrowser,
  withLoginToken,
} from "./config/server-config";
import { loadOrCreateSessionSecret } from "./config/session-secret";
import { readConnectionAgentSessions } from "./connections/agent-sessions";
import {
  connectionRoutingErrorResponse,
  type ParsedConnectionHttpRoute,
  parseConnectionHttpRoute,
  publishConnectionHttpResponse,
  rawRequestPathname,
  resolveConnectionHttpRoute,
} from "./connections/http-routing";
import {
  ConnectionManager,
  type ConnectionRuntimeContext,
  sanitizeConnectionError,
} from "./connections/manager";
import {
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type SyntheticLocalProfile,
  testConnectionSockets,
} from "./connections/profile-service";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
  connectionRecoveryFingerprint,
} from "./connections/profiles";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  createLegacyRoutingLogger,
  isBridgeGlobalMethod,
  serializeConnectionEnvelope,
  serializeHerdrEventEnvelope,
  validateConnectionGeneration,
  validateConnectionId,
} from "./connections/protocol";
import {
  type ConnectionRpcRequest,
  isConnectionRpcEnvelope,
  resolveRpcRoute,
} from "./connections/rpc-routing";
import {
  createLegacyConnectionRuntime,
  type LegacyConnectionRuntime,
} from "./connections/runtime";
import { createShutdownController } from "./connections/shutdown";
import { createSshProfileRuntimeConfig } from "./connections/ssh-profile-runtime";
import { bindListenerBeforeConnectionStart } from "./connections/startup";
import { LEGACY_DEFAULT_CONNECTION_ID } from "./connections/types";
import { unixOnlyMessage } from "./connections/unix-only";
import {
  ActionDeniedError,
  gateAction,
  gateRpcAction,
  HTTP_ENDPOINT_FILE_OPS,
  installActionGate,
  interceptRpcCall,
  RPC_METHOD_ACTIONS,
  runWithOrigin,
} from "./extensions/action-events";
import {
  ApprovalService,
  installApprovals,
  listenForApprovals,
} from "./extensions/approvals";
import { extensionConfigReader } from "./extensions/config";
import { ExtensionBus } from "./extensions/events";
import { isUngateableMethod } from "./extensions/guard";
import { ExtensionHost } from "./extensions/host";
import { ExtensionInstaller, InstallPreviews } from "./extensions/install";
import { MarketplaceStore } from "./extensions/marketplace";
import { extensionPaths } from "./extensions/paths";
import {
  type ExtensionProxySocket,
  ProxyCaps,
  proxySocketHandlers,
} from "./extensions/proxy";
import {
  createRangerToolProvider,
  installRangerTools,
} from "./extensions/ranger";
import { openReceiptStore, type ReceiptStore } from "./extensions/receipts";
import { ExtensionRegistry } from "./extensions/registry";
import { createExtensionRoutes } from "./extensions/routes";
import {
  createExtensionRpc,
  createInvalidateCoalescer,
} from "./extensions/rpc";
import { WebhookTokens } from "./extensions/webhooks";
import { enrichIntegrationVersions } from "./herdr/integration-versions";
import { createAuthHandlers, unauthenticatedLoginRedirect } from "./http/auth";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "./http/herdr-setup";
import { handleInstanceSettings } from "./http/instance-settings";
import { serveStatic } from "./http/static-files";
import {
  TERMINAL_UPLOAD_TIMEOUT_MS,
  terminalUploadRequestBodyLimit,
} from "./http/terminal-upload";
import {
  createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./http/update";
import { createWebPushService } from "./notifications/web-push";
import {
  createInFlightRpcs,
  startEventLoopStallMonitor,
} from "./utils/event-loop-stall";
import {
  configureServerLogger,
  createRecoveryReporter,
  type RecoveryReporter,
  serverLogger,
} from "./utils/logger";
import { runProcessWithCodeTimeout, shQuote } from "./utils/process-utils";
import { rpcLogLevel } from "./utils/rpc-logging";
import { DOWNLOAD_TIMEOUT_MS } from "./workspace/file-constants";
import { canRevealFiles } from "./workspace/file-manager";
import { inspectWorkspacePath } from "./workspace/path";
import { createWorkspaceWorktree } from "./worktree/create";
import {
  removeWorktreeWithRecovery,
  runWorktreeRemoveCommand,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "./worktree/remove";

const APP_VERSION = packageJson.version;
const cliCommandList = cliCommands();
const cliResult = await runCli(
  process.argv.slice(2),
  defaultCliContext(APP_VERSION),
  cliCommandList,
);
if (cliResult === CONTINUE_TO_SERVER) {
  // `service run <env>` loaded the service environment; start the listener.
  process.argv.splice(2);
} else if (cliResult !== null) {
  process.exit(cliResult);
}
const config = loadServerConfig(APP_VERSION, {
  helpText: () => topLevelHelp(cliCommandList),
});
// Only a listener startup may rotate sessions. Management commands also read
// ServerConfig, sometimes with a different environment from the running service.
let sessionSecret = "";
if (config.authRequired) {
  try {
    sessionSecret = loadOrCreateSessionSecret([
      config.password,
      ...(config.pin ? [config.pin] : []),
    ]);
  } catch (cause) {
    console.error(
      `[bridge] FATAL: could not load the session signing secret: ${(cause as Error).message}`,
    );
    process.exit(1);
  }
}
configureServerLogger(config.logLevel);
const logger = serverLogger;
// Command masters of a Roamgate that crashed outlive it; end them.
void sweepOrphanedSshMasters({ logger: logger.child("ssh") }).catch(
  () => undefined,
);
if (
  config.authRequired &&
  !config.generatedAuthToken &&
  isShortAuthPassword(config.password)
) {
  logger.warn(
    `The login password is shorter than ${RECOMMENDED_PASSWORD_LENGTH} characters. Use a longer one if this server is reachable beyond a trusted private network.`,
  );
}
if (config.authRequired && config.pin) {
  logger.warn(
    "PIN login is enabled. Use only behind a trusted private network or VPN; keep your password/token available for recovery.",
  );
}
const cpuProfile = config.profile
  ? (await import("./utils/cpu-profile")).startCpuProfile(
      config.profile,
      APP_VERSION,
      logger,
    )
  : undefined;
// Which agents' finished turns the user saw in Roamgate (agent-seen.ts).
const agentSeen = createAgentSeenStore();
// Seen marks hold for one Herdr server process: its boot id, per connection.
const herdrBoots = createHerdrBootCache();
const inFlightRpcs = createInFlightRpcs();
const stopStallMonitor = startEventLoopStallMonitor({
  logger,
  context: () => inFlightRpcs.snapshot(),
});
const webPush = createWebPushService({
  warn: (message) => logger.warn(message),
});
// Extensions: the bus producers raise events on, and the host that runs mods.
// Nothing starts until an extension's activation trigger happens.
const extensionBus = new ExtensionBus(logger.child("extensions"));
installActionGate(extensionBus);
// Asks wait here for a person; every decision leaves a receipt.
let extensionReceipts: ReceiptStore | null = null;
try {
  extensionReceipts = openReceiptStore(extensionPaths().receipts);
} catch (error) {
  logger.error("extension receipts unavailable; asks are denied", { error });
}
const extensionApprovals = new ApprovalService({
  receipts: extensionReceipts,
  publish: (approvals) => broadcastExtensions({ approvals }),
  // Nobody is looking: reach a phone, which opens the approval.
  announce: (approval) => {
    if (clients.size > 0) return;
    webPush.notify(
      {
        extension: approval.ext,
        title: `Approval needed: ${approval.title}`,
        body: approval.body ?? approval.ext,
        approval_id: approval.id,
      },
      () => extensionApprovals.list().some((entry) => entry.id === approval.id),
    );
  },
  connectionCurrent: (connection) =>
    connectionManager.readyRuntimeLease(connection.id)?.generation ===
    connection.generation,
});
if (extensionReceipts) installApprovals(extensionApprovals);
const extensionRegistry = new ExtensionRegistry({
  paths: extensionPaths(),
  appVersion: APP_VERSION,
  safeModeFlag: config.safeMode,
});
if (extensionRegistry.loadError)
  logger.error("extensions are off: registry unreadable", {
    error: extensionRegistry.loadError,
  });
function broadcastExtensions(push: ExtensionsPush) {
  const line = JSON.stringify({ extensions: push });
  for (const ws of clients) safeSend(ws, line, "extensions");
}
// Each push makes every open browser re-request ext.ui.render for that slot.
const invalidateExtensionSlot = createInvalidateCoalescer((ext, slot) =>
  broadcastExtensions({ invalidate: { ext, slot } }),
);
const extensionHost = new ExtensionHost({
  registry: extensionRegistry,
  paths: extensionPaths(),
  bus: extensionBus,
  logger: logger.child("extensions"),
  watchLinks: true,
  readConfig: extensionConfigReader(extensionRegistry, extensionPaths()),
  // Versions a drained update or an uninstall left behind.
  onRetired: (id) => {
    try {
      extensionInstaller.prune(id);
    } catch (error) {
      logger.warn("extension version cleanup failed", { extension: id, error });
    }
  },
  dollar: {
    lease: (connectionId) => {
      const id = connectionId ?? connectionManager.defaultId();
      if (!connectionManager.has(id)) return null;
      const lease = connectionManager.readyRuntimeLease(id);
      if (!lease) return null;
      const { runtime } = lease;
      return {
        connectionId: id,
        generation: lease.generation,
        isCurrent: lease.isCurrent,
        call: (method, params, timeoutMs) =>
          runtime.herdr.call(method, params, timeoutMs),
        sshHost: runtime.sshHost(),
        remotePlatform: runtime.remotePlatform,
        readAgentSession: runtime.agentSessions.readSummary,
        readAgentHistory: runtime.agentSessions.readHistory,
        files: {
          read: runtime.files.readWorkspaceFileBytes,
          write: runtime.files.uploadWorkspaceFile,
        },
      };
    },
    connections: () => connectionProfiles.list(),
    notify: (extension, message) =>
      webPush.notify(
        { extension, title: message.title, body: message.body },
        () => true,
      ),
    toast: (ext, toast) => broadcastExtensions({ toast: { ...toast, ext } }),
    invalidate: (ext, slot) => invalidateExtensionSlot(ext, slot),
    frameEvent: (ext, event) =>
      broadcastExtensions({ frame_event: { ext, ...event } }),
  },
});
const extensionWebhookTokens = new WebhookTokens(extensionPaths());
const extensionInstaller = new ExtensionInstaller({
  paths: extensionPaths(),
  registry: extensionRegistry,
  appVersion: APP_VERSION,
  strictValidation: async () =>
    (await readGuiSettings()).extensions_strict_validation === true,
});
const extensionPreviews = new InstallPreviews(extensionInstaller);
const extensionRpc = createExtensionRpc({
  registry: extensionRegistry,
  host: extensionHost,
  installer: extensionInstaller,
  previews: extensionPreviews,
  broadcast: broadcastExtensions,
  approvals: extensionApprovals,
  receipts: extensionReceipts,
  webhookTokens: extensionWebhookTokens,
  marketplaces: new MarketplaceStore({ paths: extensionPaths() }),
});
// Webhooks, frame assets and proxied pages (CONTRACT §7).
const extensionRoutes = createExtensionRoutes({
  registry: extensionRegistry,
  host: extensionHost,
  tokens: extensionWebhookTokens,
  // Without login there is no session secret; capabilities still need a key.
  caps: new ProxyCaps(sessionSecret || randomBytes(32).toString("hex")),
});
extensionBus.add(extensionHost);
// Ranger turns list tools of `ranger` extensions; confirmed actions run them.
installRangerTools(createRangerToolProvider(extensionHost));
extensionHost.onChange(() => {
  extensionRpc.publishState();
  extensionApprovals.reconcile({
    safeMode: extensionRegistry.safeMode(),
    enabled: (id) => extensionRegistry.get(id)?.enabled === true,
  });
});
// `roamgate ext` writes registry.json; changes reach browsers without a restart.
const stopRegistryWatch = extensionRegistry.watch(() => extensionHost.sync());
// One `connection.ready` per runtime generation, one `connection.lost` when it goes.
const extensionReadyGenerations = new Map<string, number>();
function reportExtensionConnection(
  id: string,
  state: string,
  generation: number,
) {
  const known = extensionReadyGenerations.get(id);
  if (state === "ready") {
    if (known === generation) return;
    if (known !== undefined)
      extensionBus.emit({
        name: "connection.lost",
        connection: { id, generation: known },
        state: "replaced",
      });
    extensionReadyGenerations.set(id, generation);
    extensionBus.emit({
      name: "connection.ready",
      connection: { id, generation },
    });
  } else if (known !== undefined && state !== "connecting") {
    extensionReadyGenerations.delete(id);
    extensionBus.emit({
      name: "connection.lost",
      connection: { id, generation: known },
      state,
    });
  }
}
const downstreamConnectionConfig = {
  socketPath: config.socketPath,
  clientSocketPath: config.clientSocketPath,
  sshHost: config.sshHost,
  session: config.session,
  hasExplicitSocketPath: config.hasExplicitSocketPath,
  hasExplicitClientSocketPath: config.hasExplicitClientSocketPath,
};
const {
  isAuthed,
  sessionToken,
  handleTokenLogin,
  handleLogin,
  handlePinLogin,
  handleLogout,
  loginPage,
} = createAuthHandlers({
  authRequired: config.authRequired,
  password: config.password,
  pin: config.pin,
  sessionSecret,
  urlLoginToken: config.generatedAuthToken,
  tokenCommand:
    config.generatedAuthTokenPath &&
    authTokenPrintCommand(config.generatedAuthTokenPath),
  secureCookies: Boolean(config.tls),
});

type RpcRequest = ConnectionRpcRequest;

const { handleUpdateCheck, handleUpdateInstall } = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
  scheduleProcessExit: scheduleManagedShutdown,
});
const clients = new Set<ServerWebSocket<unknown>>();
const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
const clientSessions = new WeakMap<ServerWebSocket<unknown>, string | null>();
interface WebSocketCleanupSnapshot {
  client: string;
  viewedTerminals: string[];
}
let nextClientId = 1;

const rpcOutcomes = new Map<string, { status: "error"; detail?: string }>();

const IMPORTANT_RPC_METHODS = new Set([
  "bridge.pause_others",
  "agent_history.get",
  "agent_history.entry",
  "agent_session.get",
  "file.read",
  "git.diff_file",
  "git.commit_file",
  "git.commit_preview",
  "git.file_action",
  "git.pull",
  "git.repo_action",
  "settings.update_repo",
  "settings.workspace_auto_sync.get",
  "settings.workspace_auto_sync.list",
  "settings.workspace_auto_sync.update",
  "settings.workspace_auto_sync.update_key",
  "settings.worktree_hooks.get",
  "settings.worktree_directory.get",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
]);
const SLOW_RPC_LOG_MS = 750;
const legacyRoutingLogger = createLegacyRoutingLogger({
  log: (message) =>
    logger.warn("deprecated request routing", { detail: message }),
});

function clientLabel(ws: ServerWebSocket<unknown>): string {
  const id = clientIds.get(ws);
  return id ? `c${id}` : "unknown";
}

function assignClientId(ws: ServerWebSocket<unknown>): string {
  clientIds.set(ws, nextClientId++);
  return clientLabel(ws);
}

function logDetail(value: string): string {
  return sanitizeConnectionError(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .trim()
    .slice(0, 300);
}

function parseRpcMeta(raw: string): {
  id: string | null;
  method: string | null;
  connectionId: unknown;
  connectionGeneration: unknown;
  lane: SshLane;
} {
  try {
    const msg = JSON.parse(raw);
    return {
      id: typeof msg?.id === "string" ? msg.id : null,
      method: typeof msg?.method === "string" ? msg.method : null,
      // What the browser marks background (badges, polls) yields on the host.
      lane: msg?.lane === "background" ? "background" : "interactive",
      connectionId: Object.hasOwn(msg ?? {}, "connection_id")
        ? msg.connection_id
        : undefined,
      connectionGeneration: Object.hasOwn(msg ?? {}, "connection_generation")
        ? msg.connection_generation
        : undefined,
    };
  } catch {
    return {
      id: null,
      method: null,
      connectionId: undefined,
      connectionGeneration: undefined,
      lane: "interactive",
    };
  }
}

function rpcOutcomeKey(ws: ServerWebSocket<unknown>, id: string) {
  return `${clientLabel(ws)}\0${id}`;
}

function markRpcError(
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) {
  if (!id) return;
  rpcOutcomes.set(rpcOutcomeKey(ws, id), { status: "error", detail });
}

function takeRpcOutcome(ws: ServerWebSocket<unknown>, id: string | null) {
  if (!id) return null;
  const key = rpcOutcomeKey(ws, id);
  const outcome = rpcOutcomes.get(key) ?? null;
  rpcOutcomes.delete(key);
  return outcome;
}

function shouldLogRpc(
  method: string | null,
  elapsedMs: number,
  failed: boolean,
) {
  if (!method) return failed;
  if (failed) return true;
  if (method === "bridge.ping" || method === "bridge.status") return false;
  if (method === "terminal.input" || method === "terminal.scroll") return false;
  if (method === "terminal.resize" && elapsedMs < SLOW_RPC_LOG_MS) return false;
  return IMPORTANT_RPC_METHODS.has(method) || elapsedMs >= SLOW_RPC_LOG_MS;
}

function logRpc(
  ws: ServerWebSocket<unknown>,
  method: string | null,
  startedAt: number,
  status: "ok" | "error",
  connectionId: string | null,
  detail?: string,
) {
  const elapsedMs = Date.now() - startedAt;
  const failed = status === "error";
  if (!shouldLogRpc(method, elapsedMs, failed)) return;
  const level = rpcLogLevel({ method, status, detail });
  logger[level]("rpc completed", {
    status,
    client: clientLabel(ws),
    method: method ? logDetail(method) : "unknown",
    connection: connectionId ? logDetail(connectionId) : undefined,
    duration_ms: elapsedMs,
    detail: detail ? logDetail(detail) : undefined,
  });
}

function summarizeHerdrEvent(event: any): string {
  const type = logDetail(String(event?.event ?? event?.type ?? "unknown"));
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const ids = ["workspace_id", "tab_id", "pane_id", "agent_id", "terminal_id"]
    .map((key) => {
      const value = data[key] ?? event?.[key];
      return typeof value === "string" && value
        ? `${key}=${logDetail(value)}`
        : "";
    })
    .filter(Boolean);
  return [`type=${type}`, ...ids].join(" ");
}

/**
 * One registry for the whole server: local ports are a single machine-wide
 * space, so two connections cannot each decide they own 5173.
 */
// Updated once the listener is bound (a configured port 0 resolves then).
let forwardReservedListeningPort = config.port;
// Read at runtime, as server-config does, so Bun does not inline it.
const { NODE_ENV: forwardNodeEnvironment } = process.env;
const sshForwards = createSshForwards({
  logger: logger.child("forward"),
  reservedPorts: () =>
    roamgateOwnPorts(
      forwardReservedListeningPort,
      forwardNodeEnvironment === "development",
    ),
});
// Forwards belong to the machine, not to a browser tab: every open tab shows
// the same list, so a port one of them opened can be found and closed from
// another. Carries no connection envelope for the same reason.
sshForwards.onChange((forwards) => {
  const line = JSON.stringify({ forwards: forwards.map(forwardToWire) });
  for (const ws of clients) safeSend(ws, line, "forwards");
});
const connectionProfileStore = new ConnectionProfileStore();
const syntheticLegacyProfile: SyntheticLocalProfile = {
  id: LEGACY_DEFAULT_CONNECTION_ID,
  label: "Default",
  type: "local",
  control_socket_path: config.socketPath,
  client_socket_path: config.clientSocketPath,
  auto_connect: true,
};
const explicitLegacyOverride = Boolean(
  config.hasExplicitSocketPath ||
    config.hasExplicitClientSocketPath ||
    config.sshHost ||
    config.session,
);
let connectionBootstrap;
try {
  connectionBootstrap = loadConnectionProfileBootstrap({
    store: connectionProfileStore,
    legacyProfile: syntheticLegacyProfile,
    explicitLegacyOverride,
  });
} catch (error) {
  const registryLoadError = sanitizeConnectionError(error);
  logger.error("invalid connection registry preserved", {
    error: registryLoadError,
    profile_mutations: "disabled",
  });
  connectionBootstrap = {
    defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
    explicitLegacyOverride,
    persistedRegistry: null,
    registryLoadError,
    registrations: [
      { profile: syntheticLegacyProfile, readOnly: true as const },
    ],
  };
}

const connectionFailureReporters = new Map<string, RecoveryReporter>();
const readyConnectionGenerations = new Map<string, number>();

function connectionFailureReporter(connectionId: string): RecoveryReporter {
  let reporter = connectionFailureReporters.get(connectionId);
  if (!reporter) {
    reporter = createRecoveryReporter({
      logger: logger.child("connections"),
      failureMessage: "connection degraded",
      recoveryMessage: "connection recovered",
    });
    connectionFailureReporters.set(connectionId, reporter);
  }
  return reporter;
}

const connectionManager = new ConnectionManager<LegacyConnectionRuntime>(
  connectionBootstrap.defaultConnectionId,
  (status) => {
    const fields = {
      connection: status.id,
      state: status.state,
      generation: status.generation,
    };
    logger.debug("connection status", {
      ...fields,
      error: status.error?.message,
    });
    reportExtensionConnection(status.id, status.state, status.generation);
    const reporter = connectionFailureReporter(status.id);
    if (
      (status.state === "error" || status.state === "reconnecting") &&
      status.error
    ) {
      reporter.failure(status.error.message, fields);
      return;
    }
    if (status.state !== "ready") return;
    resumeAssistantIfLoaded();
    if (reporter.recovered(fields)) {
      readyConnectionGenerations.set(status.id, status.generation);
    } else if (
      readyConnectionGenerations.get(status.id) !== status.generation
    ) {
      readyConnectionGenerations.set(status.id, status.generation);
      logger.info("connection ready", fields);
    }
  },
  logger.child("connections"),
);

const assistantContext = createAssistantContext({
  catalog: () => connectionProfiles.list(),
  lease: (id) => connectionManager.readyRuntimeLease(id),
  recoveryFingerprint: (id) => {
    const profile = connectionProfiles
      .list()
      .find((profile) => profile.id === id);
    if (!profile) throw new Error("Ranger connection is no longer configured");
    return connectionRecoveryFingerprint(profile);
  },
  createWorktree: (runtime, params, isCurrent, beforeDispatch) =>
    createWorkspaceWorktree(
      runtime,
      params,
      isCurrent,
      undefined,
      undefined,
      beforeDispatch,
    ),
});
let assistantServiceTask: Promise<
  Awaited<
    ReturnType<typeof import("./assistant/service").createAssistantService>
  >
> | null = null;
function getAssistantService() {
  assistantServiceTask ??= import("./assistant/service")
    .then(({ createAssistantService }) =>
      createAssistantService({
        context: assistantContext,
        publish: (snapshot) => {
          const payload = JSON.stringify({ assistant: snapshot });
          for (const ws of clients)
            safeSend(ws, payload, "assistant", "assistant");
        },
        notify: (notification) => {
          const payload = JSON.stringify({
            assistant_notification: notification,
          });
          for (const ws of clients)
            safeSend(ws, payload, "assistant_notification");
          webPush.notify(notification, () => true);
        },
      }),
    )
    .catch((error) => {
      assistantServiceTask = null;
      throw error;
    });
  return assistantServiceTask;
}

function resumeAssistantIfLoaded() {
  void assistantServiceTask
    ?.then((service) => service.resume())
    .catch(() => {
      logger.warn("Ranger recovery could not be started");
    });
}

const { handleHerdrStatus, handleHerdrSetup } = createHerdrSetupHandlers({
  ping: () => {
    const runtime = connectionManager.defaultReadyRuntime();
    return runtime
      ? runtime.herdr.ping()
      : new HerdrClient(config.socketPath).ping();
  },
  guard: () =>
    herdrSetupGuardForProfile(
      config,
      connectionProfiles
        .list()
        .find((profile) => profile.id === connectionManager.defaultId()),
    ),
});

function runtimeFactoryForProfile(
  profile: ConnectionProfile | SyntheticLocalProfile,
) {
  const identity = connectionIdentityForProfile(profile);
  return (context: ConnectionRuntimeContext) => {
    const profileConfig: SshTunnelConfig =
      profile.id === LEGACY_DEFAULT_CONNECTION_ID
        ? downstreamConnectionConfig
        : profile.type === "ssh"
          ? createSshProfileRuntimeConfig(profile)
          : {
              socketPath: profile.control_socket_path,
              clientSocketPath: profile.client_socket_path,
              sshHost: undefined,
              session: undefined,
              hasExplicitSocketPath: true,
              hasExplicitClientSocketPath: true,
              ownedRuntimeDirectory: undefined,
            };
    let runtime: LegacyConnectionRuntime;
    try {
      runtime = createLegacyConnectionRuntime({
        identity,
        connectionGeneration: context.generation,
        config: profileConfig,
        logger: logger.child("connection"),
        safeSend,
        broadcast: (payload, context) => {
          for (const ws of clients) safeSend(ws, payload, context);
        },
        clientLabel,
        markRpcError,
        taskNotificationSource: config.taskNotificationSource,
        extensions: extensionBus,
        onTaskEvent: (event) => {
          const connections = connectionProfiles.list();
          webPush.notify(
            {
              ...event,
              connectionId: identity.id,
              connectionLabel:
                connections.length > 1
                  ? (connections.find(
                      (connection) => connection.id === identity.id,
                    )?.label ?? identity.label)
                  : undefined,
              runtimeGeneration: context.generation,
            },
            context.isCurrent,
          );
        },
        onEvent: (event, eventIdentity) => {
          if (!context.isCurrent()) return;
          logger.debug("Herdr event", {
            connection: eventIdentity.id,
            detail: summarizeHerdrEvent(event),
          });
          try {
            const line = serializeHerdrEventEnvelope(
              eventIdentity.id,
              event,
              context.generation,
            );
            for (const ws of clients) safeSend(ws, line, "event");
          } catch (error) {
            logger.warn("dropped invalid Herdr event", {
              connection: eventIdentity.id,
              error: sanitizeConnectionError(error),
            });
          }
        },
        forwards: sshForwards,
        onTransportExit: profileConfig.sshHost
          ? (error) => {
              if (!context.isCurrent()) return;
              const reconnecting = connectionProfiles.willRetry(
                profile.id,
                error,
              );
              context.reportError(error, { reconnecting });
              connectionProfiles.runtimeFailed(profile.id, error);
            }
          : undefined,
      });
    } catch (error) {
      if (profileConfig.ownedRuntimeDirectory) {
        rmSync(profileConfig.ownedRuntimeDirectory, {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
    return {
      ...runtime,
      async startTransport() {
        await runtime.startTransport();
        await testConnectionSockets(
          profileConfig.socketPath,
          profileConfig.clientSocketPath,
        );
      },
    };
  };
}

const connectionProfiles = new ConnectionProfileService({
  manager: connectionManager,
  store: connectionProfileStore,
  bootstrap: connectionBootstrap,
  createRuntime: runtimeFactoryForProfile,
});

function notifyBrowserClientCount() {
  connectionManager.forEachCurrentRuntime((runtime) => {
    runtime.terminalBridge.browserClientCountChanged(clients.size);
  });
}

const webSocketCleanup = new WebSocketCleanupTracker<
  ServerWebSocket<unknown>,
  WebSocketCleanupSnapshot
>((ws) => {
  const viewedTerminals: string[] = [];
  connectionManager.forEachCurrentRuntime((runtime) => {
    viewedTerminals.push(...runtime.terminalBridge.viewedTerminals(ws));
    runtime.terminalBridge.cleanupWs(ws);
  });
  const snapshot = {
    client: clientLabel(ws),
    viewedTerminals,
  };
  clients.delete(ws);
  notifyBrowserClientCount();
  return snapshot;
});

function safeSend(
  ws: ServerWebSocket<unknown>,
  payload: string,
  context = "message",
  coalesceKey?: string,
): boolean {
  return sendWebSocketMessage(ws, payload, {
    cleanup: () => {
      webSocketCleanup.cleanup(ws);
    },
    coalesceKey,
    context,
    warn: (message) =>
      logger.warn("websocket send failed", {
        detail: message.replace(/^\[bridge\] /, ""),
      }),
  });
}

const PANE_INPUT_METHODS = new Set([
  "pane.send_input",
  "pane.send_text",
  "pane.send_keys",
]);

const handleUiSettingsRpc = createUiSettingsRpcHandler();

async function handleRpc(ws: ServerWebSocket<unknown>, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "bad json" } }),
      "bad-json",
    );
    return;
  }
  if (!isConnectionRpcEnvelope(parsed)) {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "invalid request envelope" } }),
      "invalid-request-envelope",
    );
    return;
  }
  const req = parsed as RpcRequest;
  const { id, method } = req;
  let { params } = req;
  let validationConnectionId: string | undefined;
  let connectionIdValidationFailed = false;
  if (Object.hasOwn(req, "connection_id")) {
    try {
      validationConnectionId = validateConnectionId(req.connection_id);
    } catch {
      connectionIdValidationFailed = true;
    }
  }
  let validationConnectionGeneration: number | undefined;
  let connectionGenerationValidationFailed = false;
  if (Object.hasOwn(req, "connection_generation")) {
    try {
      validationConnectionGeneration = validateConnectionGeneration(
        req.connection_generation,
      );
    } catch {
      connectionGenerationValidationFailed = true;
    }
  }
  if (typeof id !== "string" || !id || typeof method !== "string" || !method) {
    const message = connectionIdValidationFailed
      ? "invalid connection_id"
      : connectionGenerationValidationFailed
        ? "invalid connection_generation"
        : "missing id/method";
    markRpcError(ws, typeof id === "string" ? id : undefined, message);
    const responseId = typeof id === "string" ? id : undefined;
    const payload = validationConnectionId
      ? serializeConnectionEnvelope(
          validationConnectionId,
          {
            ...(responseId ? { id: responseId } : {}),
            error: { message },
          },
          validationConnectionGeneration,
        )
      : JSON.stringify({
          ...(responseId ? { id: responseId } : {}),
          error: { message },
        });
    safeSend(ws, payload, "invalid-request");
    return;
  }
  let route: ReturnType<typeof resolveRpcRoute<LegacyConnectionRuntime>>;
  try {
    route = resolveRpcRoute({
      request: req,
      registry: connectionManager,
      legacyClient: ws,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    const connectionId =
      error instanceof ConnectionRoutingError ? error.connectionId : undefined;
    const connectionGeneration =
      error instanceof ConnectionRoutingError
        ? error.connectionGeneration
        : undefined;
    const payload = connectionId
      ? serializeConnectionEnvelope(
          connectionId,
          {
            id,
            error: { message },
          },
          connectionGeneration,
        )
      : JSON.stringify({ id, error: { message } });
    safeSend(ws, payload, "connection-routing-error");
    return connectionId ?? null;
  }
  const connectionId = route.scope === "connection" ? route.connectionId : null;
  const requestIsCurrent = () => route.scope === "bridge" || route.isCurrent();
  const encode = (message: Record<string, unknown>) =>
    route.scope === "connection"
      ? serializeConnectionEnvelope(
          route.connectionId,
          message,
          route.generation,
        )
      : JSON.stringify(message);
  const replyPublisher =
    route.scope === "connection"
      ? createConnectionReplyPublisher({
          connectionId: route.connectionId,
          generation: route.generation,
          requestId: id,
          isCurrent: route.isCurrent,
          send: (payload, context) => safeSend(ws, payload, context),
          markError: (message) => markRpcError(ws, id, message),
        })
      : null;
  const sendReply = (
    message: Record<string, unknown>,
    context: string,
  ): boolean =>
    replyPublisher
      ? replyPublisher.send(message, context)
      : safeSend(ws, encode(message), context);
  // A gated call that waits on a person tells the browser to stop its timer.
  listenForApprovals((approvalId) => {
    if (requestIsCurrent())
      safeSend(
        ws,
        encode({ id, pending: { approval_id: approvalId } }),
        "approval-pending",
      );
  });
  const sendError = (context: string, error: unknown) => {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    sendReply({ id, error: { message } }, context);
  };
  // Experimental `rpc.call` handlers see every RPC but keystrokes and heartbeats.
  if (!isUngateableMethod(method)) {
    try {
      const intercepted = await interceptRpcCall(
        route.scope === "connection"
          ? { id: route.connectionId, generation: route.generation }
          : undefined,
        method,
        params ?? {},
      );
      if (intercepted.kind === "answer") {
        sendReply({ id, result: intercepted.result }, "extensions-rpc-call");
        return;
      }
      params = intercepted.params;
    } catch (error) {
      sendError("extensions-rpc-call-error", error);
      return;
    }
  }
  // Bridge-global mutations gate here; connection ones once the runtime is known.
  if (route.scope === "bridge" && Object.hasOwn(RPC_METHOD_ACTIONS, method)) {
    try {
      params = await gateRpcAction(undefined, method, params ?? {});
    } catch (error) {
      sendError(`${method}-gate`, error);
      return;
    }
  }
  if (
    method === "bridge.ui_settings.get" ||
    method === "bridge.ui_settings.update"
  ) {
    try {
      const result = await handleUiSettingsRpc(method, params ?? {});
      if (method === "bridge.ui_settings.update") {
        const line = JSON.stringify({ ui_settings: result });
        for (const client of clients)
          if (client !== ws) safeSend(client, line, "ui-settings");
      }
      sendReply({ id, result }, "ui-settings");
    } catch (error) {
      sendError("ui-settings-error", error);
    }
    return;
  }
  if (method.startsWith("ext.")) {
    try {
      if (!extensionRpc.handles(method))
        throw new Error(`unknown bridge-global method: ${method}`);
      const result = await extensionRpc.handle(method, params ?? {});
      sendReply({ id, result }, "extensions-rpc");
    } catch (error) {
      sendError("extensions-rpc-error", error);
    }
    return;
  }
  if (method === "bridge.ping") {
    sendReply({ id, result: { ok: true } }, "bridge-ping");
    return;
  }
  if (method === "bridge.status") {
    sendReply(
      {
        id,
        result: {
          clients: clients.size,
          terminals:
            connectionManager
              .defaultReadyRuntime()
              ?.terminalBridge.statusTerminals() ?? [],
          default_connection_id: connectionManager.defaultId(),
          connections: connectionProfiles.list(),
        },
      },
      "bridge-status",
    );
    return;
  }
  if (method.startsWith("bridge.assistant.")) {
    try {
      const result =
        method === "bridge.assistant.context"
          ? await (await getAssistantService()).workspaceCatalog()
          : method === "bridge.assistant.mentions"
            ? await (await getAssistantService()).mentionCatalog(params ?? {})
            : method === "bridge.assistant.task.get"
              ? await (await getAssistantService()).taskDetail(params ?? {})
              : await (await getAssistantService()).handle(
                  method,
                  params ?? {},
                );
      sendReply({ id, result }, "assistant-rpc");
    } catch (error) {
      sendError("assistant-rpc-error", error);
    }
    return;
  }
  if (method === "connections.list") {
    sendReply(
      {
        id,
        result: {
          default_connection_id: connectionManager.defaultId(),
          connections: connectionProfiles.list(),
        },
      },
      "connections-list",
    );
    return;
  }
  if (method === "connections.agent_sessions") {
    try {
      const result = await readConnectionAgentSessions(connectionManager);
      sendReply({ id, result }, "connections-agent-sessions");
    } catch (error) {
      sendError("connections-agent-sessions-error", error);
    }
    return;
  }
  if (method.startsWith("connections.")) {
    try {
      let result: unknown;
      if (method === "connections.create") {
        result = await connectionProfiles.create(params?.profile ?? params);
      } else if (method === "connections.update") {
        result = await connectionProfiles.update(
          params?.id,
          params?.profile ?? params,
        );
      } else if (method === "connections.remove") {
        result = await connectionProfiles.remove(params?.id);
      } else if (method === "connections.set_default") {
        result = await connectionProfiles.setDefault(params?.id);
      } else if (method === "connections.connect") {
        result = await connectionProfiles.connect(params?.id);
      } else if (method === "connections.disconnect") {
        result = await connectionProfiles.disconnect(params?.id);
      } else if (method === "connections.test") {
        result = await connectionProfiles.test(params?.profile ?? params);
      } else {
        throw new Error(`unknown bridge-global method: ${method}`);
      }
      sendReply({ id, result }, "connections-mutation");
    } catch (error) {
      const message = sanitizeConnectionError(error);
      markRpcError(ws, id, message);
      sendReply({ id, error: { message } }, "connections-mutation-error");
    }
    return;
  }
  if (method === "bridge.pause_others") {
    const targets = Array.from(clients).filter((client) => client !== ws);
    let pausedClients = 0;
    for (const client of targets) {
      const ok = safeSend(
        client,
        JSON.stringify({
          control: {
            type: "pause_connection",
            reason:
              "Another Roamgate client paused this connection. Resume when you want this browser to sync again.",
          },
        }),
        "pause-other-client",
      );
      if (ok) pausedClients += 1;
    }
    sendReply(
      {
        id,
        result: {
          ok: true,
          paused_clients: pausedClients,
          clients: clients.size,
        },
      },
      "bridge-pause-others",
    );
    return;
  }

  if (route.scope === "bridge") {
    sendError(
      "unknown-bridge-method",
      new Error(`unknown bridge-global method: ${method}`),
    );
    return null;
  }
  const connection = route.runtime;
  if (
    connection.remotePlatform === "windows" &&
    /^(?:file\.|git\.|worktree\.|agent_history\.|agent_session\.|agent_commands\.|agent_artifacts\.|settings\.(?:workspace_auto_sync|worktree_hooks)\.)/.test(
      method,
    )
  ) {
    sendError(
      "unsupported-windows-operation",
      new Error(unixOnlyMessage("This operation")),
    );
    return;
  }
  const {
    sshHost,
    herdr,
    worktreeParents,
    handleSettingsRpc,
    handleForwardRpc,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
  } = connection;
  const {
    listWorkspaceFiles,
    resolveWorkspaceFiles,
    readWorkspaceFile,
    searchWorkspaceFiles,
    revealWorkspaceFile,
    createWorkspaceDirectory,
    moveWorkspaceFile,
    readGitDiffSummary,
    readWorkspacePullRequest,
    readGitDiffFile,
    readGitCommits,
    readGitCommit,
    readGitCommitFile,
    readGitCommitPreview,
    runGitPull,
    runWorkspaceGitFileAction,
    runWorkspaceGitRepoAction,
  } = connection.files;
  const { enrichWorkspacesWithGitStatus, invalidateGitStatus } =
    connection.status;
  const {
    runWorktreeHook,
    worktreeRemoveHookContext,
    runWorktreeRemovedHook,
    runWorktreeOpenedHook,
    sourceWorkspaceForWorktreeCreate,
  } = connection.worktreeHooks;
  const {
    readHistory: readAgentMessageHistory,
    readSummary: readAgentSessionSummary,
    readEntry: readAgentHistoryEntry,
    readCommands: readAgentCommands,
    readArtifacts: readAgentArtifacts,
  } = connection.agentSessions;

  // One choke point for every connection mutation the browser sends.
  if (Object.hasOwn(RPC_METHOD_ACTIONS, method)) {
    try {
      params = await gateRpcAction(
        { id: connection.identity.id, generation: route.generation },
        method,
        params ?? {},
      );
      if (!requestIsCurrent())
        throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
    } catch (error) {
      sendError(`${method}-gate`, error);
      return;
    }
  }

  if (
    method === "workspace.path" ||
    (method === "workspace.create" && params?.cwd != null && params.cwd !== "")
  ) {
    try {
      const info = await inspectWorkspacePath(
        method === "workspace.path" ? params?.path : params?.cwd,
        { host: sshHost(), remotePlatform: connection.remotePlatform },
        method === "workspace.path",
      );
      if (method === "workspace.path") {
        sendReply({ id, result: info }, method);
        return;
      }
      if (info.error) throw new Error(`${info.error} ${info.path}`);
      if (!requestIsCurrent())
        throw new Error("Creation connection changed. Reconnect and retry.");
      params = { ...params, cwd: info.path };
    } catch (error) {
      sendError(`${method}-error`, error);
      return;
    }
  }

  if (
    (method === "tab.create" || method === "workspace.create") &&
    params &&
    Object.hasOwn(params, "browser_source")
  ) {
    try {
      const result = await terminalBridge.createFromTerminal(
        ws,
        method,
        params,
        requestIsCurrent,
        async () => {
          if (
            method === "workspace.create" &&
            params?.cwd != null &&
            params.cwd !== ""
          ) {
            const info = await inspectWorkspacePath(
              params.cwd,
              { host: sshHost(), remotePlatform: connection.remotePlatform },
              false,
            );
            if (info.error) throw new Error(`${info.error} ${info.path}`);
          }
        },
      );
      sendReply({ id, result }, method);
    } catch (error) {
      sendError(`${method}-error`, error);
    }
    return;
  }

  const herdrBoot = () =>
    herdrBoots.get(connection.identity.id, () =>
      connection.recoveryIdentity(AbortSignal.timeout(3_000)),
    );
  if (method === "agent.list") {
    try {
      const [list, boot] = await Promise.all([
        connection.remotePlatform === "windows"
          ? herdr.call("agent.list", params ?? {})
          : connection.agentSessions.listWithActivity(params ?? {}),
        herdrBoot(),
      ]);
      const result = agentSeen.annotate(connection.identity.id, list, boot);
      sendReply({ id, result }, "agent-list");
    } catch (e) {
      sendError("agent-list-error", e);
    }
    return;
  }
  if (method === "agent_seen.mark") {
    try {
      const result = await markAgentSeen(
        agentSeen,
        herdrBoots,
        connection.identity.id,
        params,
        () => connection.recoveryIdentity(AbortSignal.timeout(3_000)),
      );
      sendReply({ id, result }, method);
    } catch (e) {
      sendError("agent-seen-error", e);
    }
    return;
  }

  if (method === "agent_history.get") {
    try {
      const result = await readAgentMessageHistory(params ?? {});
      sendReply({ id, result }, "agent-history-get");
    } catch (e) {
      sendError("agent-history-get-error", e);
    }
    return;
  }
  if (method === "agent_artifacts.get") {
    try {
      sendReply({ id, result: await readAgentArtifacts(params ?? {}) }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "agent_commands.get") {
    try {
      sendReply({ id, result: await readAgentCommands(params ?? {}) }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "agent_history.entry") {
    try {
      const result = await readAgentHistoryEntry(params ?? {});
      sendReply({ id, result }, "agent-history-entry");
    } catch (e) {
      sendError("agent-history-entry-error", e);
    }
    return;
  }
  if (method === "agent_session.get") {
    try {
      const result = await readAgentSessionSummary(params ?? {});
      sendReply({ id, result }, "agent-session-get");
    } catch (e) {
      sendError("agent-session-get-error", e);
    }
    return;
  }
  if (method === "file.list") {
    try {
      const result = await listWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-list");
    } catch (e) {
      sendError("file-list-error", e);
    }
    return;
  }
  if (method === "file.resolve") {
    try {
      const result = await resolveWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-resolve");
    } catch (e) {
      sendError("file-resolve-error", e);
    }
    return;
  }
  if (method === "file.mkdir" || method === "file.move") {
    try {
      const result = await (method === "file.mkdir"
        ? createWorkspaceDirectory
        : moveWorkspaceFile)(params ?? {});
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "file.read") {
    try {
      const result = await readWorkspaceFile(params ?? {});
      sendReply({ id, result }, "file-read");
    } catch (e) {
      sendError("file-read-error", e);
    }
    return;
  }
  if (method === "file.search") {
    try {
      const result = await searchWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-search");
    } catch (e) {
      sendError("file-search-error", e);
    }
    return;
  }
  if (method === "file.reveal") {
    try {
      const result = await revealWorkspaceFile(params ?? {}, ws.remoteAddress);
      sendReply({ id, result }, "file-reveal");
    } catch (e) {
      sendError("file-reveal-error", e);
    }
    return;
  }
  if (method === "git.diff_summary") {
    try {
      const result = await readGitDiffSummary(params ?? {});
      sendReply({ id, result }, "git-diff-summary");
    } catch (e) {
      sendError("git-diff-summary-error", e);
    }
    return;
  }
  if (method === "git.pull_request") {
    try {
      const result = await readWorkspacePullRequest(params ?? {});
      sendReply({ id, result }, "git-pull-request");
    } catch {
      // Root resolution errors may include remote URLs or CLI diagnostics.
      sendError(
        "git-pull-request-error",
        new Error("Cannot resolve this workspace's Git checkout."),
      );
    }
    return;
  }
  if (method === "git.diff_file") {
    try {
      const result = await readGitDiffFile(params ?? {});
      sendReply({ id, result }, "git-diff-file");
    } catch (e) {
      sendError("git-diff-file-error", e);
    }
    return;
  }
  if (
    method === "git.commits" ||
    method === "git.commit" ||
    method === "git.commit_file" ||
    method === "git.commit_preview"
  ) {
    try {
      const result =
        method === "git.commits"
          ? await readGitCommits(params ?? {})
          : method === "git.commit"
            ? await readGitCommit(params ?? {})
            : method === "git.commit_file"
              ? await readGitCommitFile(params ?? {})
              : await readGitCommitPreview(params ?? {});
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "git.pull") {
    try {
      const result = await runGitPull(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-pull");
    } catch (e) {
      sendError("git-pull-error", e);
    }
    return;
  }
  if (method === "git.file_action") {
    try {
      const result = await runWorkspaceGitFileAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-file-action");
    } catch (e) {
      sendError("git-file-action-error", e);
    }
    return;
  }
  if (method === "git.repo_action") {
    try {
      const result = await runWorkspaceGitRepoAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-repo-action");
    } catch (e) {
      sendError("git-repo-action-error", e);
    }
    return;
  }
  if (method.startsWith("terminal.")) {
    return terminalBridge.handleTerminalRpc(
      ws,
      id,
      method,
      params ?? {},
      requestIsCurrent,
    );
  }
  if (method.startsWith("settings.")) {
    return handleSettingsRpc(ws, id, method, params ?? {}, requestIsCurrent);
  }
  if (method.startsWith("forward.")) {
    if (!handleForwardRpc) {
      markRpcError(ws, id, "port forwarding is unavailable");
      return;
    }
    return handleForwardRpc(ws, id, method, params ?? {}, requestIsCurrent);
  }
  if (method === "worktree.create") {
    try {
      const result = await createWorkspaceWorktree(
        connection,
        params ?? {},
        requestIsCurrent,
        (error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        },
      );
      sendReply(
        {
          id,
          result,
        },
        "worktree-create",
      );
    } catch (e) {
      sendError("worktree-create-error", e);
    }
    return;
  }
  if (method === "worktree.open") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const result = await herdr.call(method, params ?? {});
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
        .catch((error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist opened worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        });
      const openedHook = await runWorktreeOpenedHook(result, sourceWorkspace);
      sendReply(
        {
          id,
          result: { ...result, opened_hook: openedHook },
        },
        "worktree-open",
      );
    } catch (e) {
      sendError("worktree-open-error", e);
    }
    return;
  }
  if (method === "worktree.remove") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const result = await worktreeRemovalCoordinator.run(
        workspaceId,
        async () => {
          const removeHookContext = await worktreeRemoveHookContext(
            params ?? {},
          );
          const checkoutState = removeHookContext
            ? await worktreeRemovalRuntime
                .inspectCheckout(removeHookContext.checkoutPath)
                .catch(() => "unknown" as const)
            : "unknown";
          const beforeRemoveHook =
            removeHookContext && checkoutState !== "missing"
              ? await runWorktreeHook({
                  hook: "teardown",
                  checkoutPath: removeHookContext.checkoutPath,
                  sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                  repoSettingsKey: removeHookContext.repoSettingsKey,
                })
              : ({
                  event: "worktree.before_remove",
                  status: "skipped",
                } as const);
          if (beforeRemoveHook.status === "failed") {
            markRpcError(
              ws,
              id,
              beforeRemoveHook.error || "before-remove hook failed",
            );
            return {
              ok: false,
              skipped_remove: true,
              before_remove_hook: beforeRemoveHook,
            };
          }

          const removeCommand = removeHookContext
            ? worktreeRemoveCommandFor(
                await readGuiSettings(),
                removeHookContext.repoSettingsKey,
              )
            : undefined;
          const removal = await removeWorktreeWithRecovery({
            call: (name, callParams) =>
              herdr.call(name, callParams, WORKTREE_REMOVE_TIMEOUT_MS),
            params: params ?? {},
            checkoutPath: removeHookContext?.checkoutPath,
            runtime: worktreeRemovalRuntime,
            // The command removes the checkout (git recworktree also its
            // nested ones); Herdr then only closes the workspace, as its own
            // removal would. Not installed on this host: Herdr removes it.
            removeWithCommand:
              removeCommand && removeHookContext
                ? async () => {
                    const force = params?.force === true;
                    const fallback = await runWorktreeRemoveCommand({
                      template: removeCommand,
                      checkoutPath: removeHookContext.checkoutPath,
                      sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                      force,
                      host: sshHost(),
                      runProcess: runProcessWithCodeTimeout,
                    });
                    if (fallback)
                      return {
                        fallback: `${fallback} Herdr removed the worktree.`,
                      };
                    await herdr.call("workspace.close", {
                      workspace_id: workspaceId,
                    });
                    return {
                      result: {
                        forced: force,
                        path: removeHookContext.checkoutPath,
                        type: "worktree_removed",
                        workspace_id: workspaceId,
                      },
                    };
                  }
                : undefined,
          });
          if (removal.cleanup?.preserved_path) {
            logger.warn("preserved stale worktree files", {
              connection: connectionId,
              path: removal.cleanup.preserved_path,
            });
          }
          if (removeHookContext?.checkoutPath) {
            await worktreeParents
              .forgetWorktree(removeHookContext.checkoutPath, requestIsCurrent)
              .catch((error) => {
                if (!requestIsCurrent()) return;
                logger.warn("unable to remove worktree parent", {
                  connection: connectionId,
                  error: sanitizeConnectionError(error),
                });
              });
          }
          const removedHook = await runWorktreeRemovedHook(removeHookContext);
          return {
            ...removal.result,
            ...(removal.cleanup ? { cleanup: removal.cleanup } : {}),
            ...(removal.commandFallback
              ? { command_fallback: removal.commandFallback }
              : {}),
            before_remove_hook: beforeRemoveHook,
            removed_hook: removedHook,
          };
        },
      );
      sendReply({ id, result }, "worktree-remove");
    } catch (e) {
      sendError("worktree-remove-error", e);
    }
    return;
  }
  const isPaneInput = PANE_INPUT_METHODS.has(method);
  let inputTerminalId: string | undefined;
  if (isPaneInput && typeof params?.pane_id === "string") {
    // Resolve the recipient before input can produce a clipboard write.
    try {
      const pane = await herdr.call(
        "pane.get",
        { pane_id: params.pane_id },
        2000,
      );
      if (typeof pane?.pane?.terminal_id === "string")
        inputTerminalId = pane.pane.terminal_id;
    } catch {
      // A failed lookup must not prevent input.
    }
  }
  try {
    if (method === "tab.rename" && typeof params?.tab_id === "string") {
      connection.tabAutoRenamer?.markManualRename(
        params.tab_id,
        typeof params.label === "string" ? params.label : undefined,
      );
    }
    const rawResult = await herdr.call(method, params ?? {}, undefined, () => {
      if (isPaneInput && !requestIsCurrent())
        throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
      if (inputTerminalId)
        terminalBridge.noteTerminalInput(ws, inputTerminalId);
    });
    let result = rawResult;
    if (
      method === "integration.list" &&
      connection.remotePlatform !== "windows"
    ) {
      result = await enrichIntegrationVersions(result, {
        sshHost: sshHost(),
        ping: () => herdr.ping(),
      });
    }
    if (method === "workspace.list") {
      if (connection.remotePlatform !== "windows") {
        result = await worktreeParents.enrichWorkspaceList(result);
        result = await enrichWorkspacesWithGitStatus(result);
      }
      result = {
        ...result,
        navigation_mode: await terminalBridge.navigationMode(),
        tab_move_supported: await terminalBridge.tabMoveSupported(),
        endpoint_availability: terminalBridge.endpointAvailability(),
      };
    }
    sendReply({ id, result }, method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

async function handleConnectionHttpRequest(
  route: ParsedConnectionHttpRoute,
  url: URL,
  req: Request,
): Promise<Response> {
  if (route.kind === "error") {
    return connectionRoutingErrorResponse(route.error);
  }

  let resolved: ReturnType<
    typeof resolveConnectionHttpRoute<LegacyConnectionRuntime>
  >;
  const generationText = url.searchParams.get("connection_generation");
  const requestedGeneration =
    generationText === null
      ? undefined
      : /^(0|[1-9]\d*)$/.test(generationText)
        ? Number(generationText)
        : generationText;
  try {
    resolved = resolveConnectionHttpRoute({
      route,
      requestedGeneration,
      registry: connectionManager,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    if (error instanceof ConnectionRoutingError) {
      return connectionRoutingErrorResponse(error);
    }
    return Response.json(
      { error: "connection routing failed" },
      { status: 500 },
    );
  }

  const { runtime: connection, endpoint } = resolved;
  const fileOp = HTTP_ENDPOINT_FILE_OPS[endpoint];
  if (fileOp) {
    try {
      await gateAction({
        name: "file.write",
        connection: {
          id: connection.identity.id,
          generation: resolved.generation,
        },
        op: fileOp,
        paths: [
          url.searchParams.get("path") ??
            url.searchParams.get("filename") ??
            url.searchParams.get("directory") ??
            "",
        ].filter(Boolean),
        ...(url.searchParams.get("workspace_id")
          ? { workspace_id: url.searchParams.get("workspace_id") }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof ActionDeniedError)) throw error;
      return publishConnectionHttpResponse(
        resolved,
        Response.json({ error: error.message }, { status: 403 }),
      );
    }
  }
  if (connection.remotePlatform === "windows" && endpoint !== "herdr-info") {
    return publishConnectionHttpResponse(
      resolved,
      Response.json(
        {
          error:
            "Remote file transfers and agent history require a Unix SSH host.",
        },
        { status: 501 },
      ),
    );
  }
  try {
    let response: Response;
    if (endpoint === "herdr-info") {
      response = await connection.handleHerdrInfo();
    } else if (endpoint === "upload-image") {
      response = await connection.handleImageUpload(req);
    } else if (endpoint === "terminal-upload") {
      response = await connection.handleTerminalUpload(
        req,
        url.searchParams.get("filename"),
      );
    } else if (endpoint === "agent-session-download") {
      response = await connection.agentSessions.downloadFile({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "agent-session-atif") {
      response = await connection.agentSessions.downloadAtif({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "file-download") {
      try {
        response = await connection.files.downloadWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
          scope: url.searchParams.get("scope"),
          inline: url.searchParams.get("inline") === "1",
          range: req.headers.get("range") ?? undefined,
          if_range: req.headers.get("if-range") ?? undefined,
        });
      } catch (error) {
        response = new Response((error as Error).message, { status: 400 });
      }
    } else if (endpoint === "file-upload") {
      try {
        const result = await connection.files.uploadWorkspaceFile(
          {
            workspace_id: url.searchParams.get("workspace_id"),
            directory: url.searchParams.get("directory"),
            filename: url.searchParams.get("filename"),
          },
          req,
        );
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    } else {
      try {
        const result = await connection.files.deleteWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
        });
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    }
    return publishConnectionHttpResponse(resolved, response);
  } catch (error) {
    return publishConnectionHttpResponse(
      resolved,
      Response.json({ error: (error as Error).message }, { status: 500 }),
    );
  }
}

function main() {
  const server = bindListenerBeforeConnectionStart({
    bindListener: () =>
      Bun.serve<{
        sessionToken: string | null;
        extProxy?: ExtensionProxySocket;
      }>({
        port: config.port,
        hostname: config.host,
        tls: config.tls,
        maxRequestBodySize: terminalUploadRequestBodyLimit(),
        async fetch(req, server) {
          const requestPathname = rawRequestPathname(req.url);
          let url: URL;
          try {
            url = new URL(req.url);
          } catch {
            return new Response("invalid request URL", { status: 400 });
          }

          // Forwarded headers are untrusted; use the actual TCP peer address.
          const clientIp = server.requestIP(req)?.address ?? "unknown";
          const tokenLoginResponse = handleTokenLogin(req, clientIp);
          if (tokenLoginResponse) return tokenLoginResponse;

          if (url.pathname === "/health" || url.pathname === "/healthz") {
            return new Response("Ok", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }

          // Auth endpoints are always reachable.
          if (url.pathname === "/api/login/pin" && req.method === "POST") {
            return handlePinLogin(req, clientIp);
          }
          if (url.pathname === "/api/login" && req.method === "POST") {
            return handleLogin(req, clientIp);
          }
          if (url.pathname === "/login") {
            return loginPage(req);
          }
          // The login page's logo and favicon must also work before login.
          if (url.pathname === "/roamgate-icon-192.png") {
            return serveStatic(req, config.publicDir);
          }
          if (url.pathname === "/api/logout") {
            const response = handleLogout(req);
            const token = sessionToken(req);
            if (response.ok && config.authRequired && token) {
              for (const client of clients) {
                if (clientSessions.get(client) !== token) continue;
                webSocketCleanup.cleanup(client);
                client.close(4001, "Logged out");
              }
            }
            // Proxied extension pages lose their capabilities with the session.
            if (response.ok) extensionRoutes.revokeCaps();
            return response;
          }

          // Webhooks (bearer token) and proxied pages (capability) carry their
          // own authority: opaque-origin frames send no session cookie.
          const extensionPublic = await extensionRoutes.handlePublic(req, url, {
            upgrade: (request, extProxy, headers) =>
              server.upgrade(request, {
                headers,
                data: { sessionToken: null, extProxy },
              }),
            timeout: (request, seconds) => server.timeout(request, seconds),
          });
          if (extensionPublic === "upgraded") return undefined;
          if (extensionPublic) return extensionPublic;

          // Authentication is bypassed only for development loopback listeners.
          if (!isAuthed(req)) {
            const accept = req.headers.get("accept") ?? "";
            if (req.method === "GET" && accept.includes("text/html")) {
              return unauthenticatedLoginRedirect();
            }
            return new Response("unauthorized", { status: 401 });
          }

          if (url.pathname === "/ws") {
            if (
              server.upgrade(req, { data: { sessionToken: sessionToken(req) } })
            )
              return undefined;
            return new Response("websocket upgrade failed", { status: 400 });
          }
          const extensionAuthed = await extensionRoutes.handleAuthed(req, url);
          if (extensionAuthed) return extensionAuthed;
          if (url.pathname === "/api/notifications/push") {
            return webPush.handle(req);
          }
          if (url.pathname === "/api/instance-settings") {
            return handleInstanceSettings(req);
          }
          if (url.pathname === "/api/health") {
            return Response.json({
              ok: true,
              version: APP_VERSION,
              socket: config.socketPath,
              auth_required: config.authRequired,
            });
          }
          if (url.pathname === "/api/update/check" && req.method === "GET") {
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleUpdateCheck(req);
          }
          if (url.pathname === "/api/update/install" && req.method === "POST") {
            try {
              await gateAction({
                name: "update.install",
                from_version: APP_VERSION,
                version: url.searchParams.get("version") ?? "latest",
              });
            } catch (error) {
              if (!(error instanceof ActionDeniedError)) throw error;
              return Response.json({ error: error.message }, { status: 403 });
            }
            // Binary download and verification can exceed Bun's default ten-second
            // request timeout. Keep the larger budget scoped to update requests.
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleUpdateInstall(req);
          }
          if (url.pathname === "/api/herdr/status" && req.method === "GET") {
            return handleHerdrStatus();
          }
          if (url.pathname === "/api/herdr/setup" && req.method === "POST") {
            // Herdr download plus service start shares the update budget.
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleHerdrSetup(req);
          }
          const connectionRoute = parseConnectionHttpRoute(
            requestPathname,
            req.method,
          );
          if (connectionRoute) {
            if (
              connectionRoute.kind === "connection" &&
              connectionRoute.endpoint === "terminal-upload"
            ) {
              server.timeout(req, TERMINAL_UPLOAD_TIMEOUT_MS / 1000);
            }
            if (
              connectionRoute.kind === "connection" &&
              connectionRoute.endpoint === "file-download" &&
              url.searchParams.get("inline") === "1" &&
              isHtmlPath(url.searchParams.get("path") ?? "")
            ) {
              // HTML preparation can require several bounded SSH resource reads.
              server.timeout(req, DOWNLOAD_TIMEOUT_MS / 1000);
            }
            return handleConnectionHttpRequest(connectionRoute, url, req);
          }
          // Everything else: serve the built frontend (embedded or on-disk).
          return serveStatic(
            req,
            config.publicDir,
            (await readGuiSettings()).title_suffix,
          );
        },
        websocket: {
          perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
          open(ws) {
            if (ws.data.extProxy) {
              proxySocketHandlers.open(ws, ws.data.extProxy);
              return;
            }
            clients.add(ws);
            clientSessions.set(ws, ws.data.sessionToken);
            const label = assignClientId(ws);
            logger.debug("client connected", {
              client: label,
              clients: clients.size,
            });
            notifyBrowserClientCount();
            extensionBus.emit({
              name: "viewer.attach",
              viewer: { id: label, mobile: false },
            });
            safeSend(
              ws,
              JSON.stringify({
                hello: true,
                socket: config.socketPath,
                bridge_protocol_version: 3,
                default_connection_id: connectionManager.defaultId(),
                capabilities: {
                  connection_id: true,
                  connection_scoped_http: true,
                  file_reveal: canRevealFiles(ws.remoteAddress),
                  connection_runtime_generation: true,
                  embedded_assistant: true,
                  extensions: true,
                  herdr_task_notifications:
                    config.taskNotificationSource === "herdr",
                },
              }),
              "hello",
            );
            // The registry is global and must arrive before any Herdr catalog
            // or runtime lease is available, including with an offline default.
            safeSend(
              ws,
              JSON.stringify({
                forwards: sshForwards.list().map(forwardToWire),
              }),
              "forwards",
            );
          },
          drain(ws) {
            if (ws.data.extProxy) return;
            // The viewer caught up: send the newest repaint we held back.
            flushCoalescedMessages(ws, {
              cleanup: () => {
                webSocketCleanup.cleanup(ws);
              },
              warn: (detail) =>
                logger.warn("websocket send failed", {
                  detail: detail.replace(/^\[bridge\] /, ""),
                }),
            });
          },
          message(ws, message) {
            if (ws.data.extProxy) {
              proxySocketHandlers.message(ws.data.extProxy, message);
              return;
            }
            if (!clients.has(ws)) return;
            const text =
              typeof message === "string" ? message : message.toString();
            const { id, method, connectionId, connectionGeneration, lane } =
              parseRpcMeta(text);
            const startedAt = Date.now();
            let responseConnectionId: string | null = null;
            let logConnectionId: string | null = null;
            if (method && !isBridgeGlobalMethod(method)) {
              if (connectionId === undefined) {
                responseConnectionId = connectionManager.defaultId();
                logConnectionId = responseConnectionId;
              } else {
                try {
                  responseConnectionId = validateConnectionId(connectionId);
                  logConnectionId = responseConnectionId;
                } catch {
                  logConnectionId = "invalid";
                }
              }
            }
            const settled = inFlightRpcs.begin(method);
            runInSshLane(lane, () =>
              runWithOrigin("browser", () => handleRpc(ws, text)),
            )
              .finally(settled)
              .then(() => {
                const outcome = takeRpcOutcome(ws, id);
                logRpc(
                  ws,
                  method,
                  startedAt,
                  outcome?.status ?? "ok",
                  logConnectionId,
                  outcome?.detail,
                );
              })
              .catch((e) => {
                logRpc(
                  ws,
                  method,
                  startedAt,
                  "error",
                  logConnectionId,
                  (e as Error).message,
                );
                const errorMessage: Record<string, unknown> = {
                  error: { message: (e as Error).message },
                };
                if (id) errorMessage.id = id;
                safeSend(
                  ws,
                  responseConnectionId
                    ? serializeConnectionEnvelope(
                        responseConnectionId,
                        errorMessage,
                        typeof connectionGeneration === "number"
                          ? connectionGeneration
                          : undefined,
                      )
                    : JSON.stringify(errorMessage),
                  "message-error",
                );
              });
          },
          close(ws, code, reason) {
            if (ws.data.extProxy) {
              proxySocketHandlers.close(ws.data.extProxy, code, reason);
              return;
            }
            const { client, viewedTerminals } = webSocketCleanup.complete(ws);
            extensionBus.emit({
              name: "viewer.detach",
              viewer: { id: client, mobile: false },
            });
            logger.debug("client disconnected", {
              client,
              clients: clients.size,
              terminals: viewedTerminals.length
                ? viewedTerminals.join(",")
                : "none",
            });
          },
        },
      }),
    startConnection: async () => {
      await connectionProfiles.startConfigured();
      extensionHost.start();
      // Resume saved work even when no browser has opened Ranger yet.
      await getAssistantService();
      resumeAssistantIfLoaded();
      notifyBrowserClientCount();
      const runtime = connectionManager.defaultReadyRuntime();
      void runtime?.herdr
        .ping()
        .then((ping) =>
          logger.info("Herdr reachable", {
            connection: runtime.identity.id,
            version: ping.version,
            protocol: ping.protocol,
          }),
        )
        .catch((error) =>
          logger.warn("Herdr not reachable yet", {
            connection: runtime.identity.id,
            error: sanitizeConnectionError(error),
            action: "run `roamgate herdr setup`; RPCs retry per request",
          }),
        );
    },
    onConnectionError: (error) => {
      logger.warn("default connection startup failed", {
        error: sanitizeConnectionError(error),
      });
    },
  });
  const listeningPort = server.port ?? config.port;
  forwardReservedListeningPort = listeningPort;
  const publicBrowserUrl = browserUrlFor(
    config.host,
    listeningPort,
    Boolean(config.tls),
  );
  logger.info("listening", {
    url: publicBrowserUrl,
    websocket: "/ws",
    log_level: config.logLevel,
  });
  if (config.authRequired) {
    if (config.generatedAuthTokenPath) {
      logger.info("authentication required", {
        mode: "generated token",
        path: config.generatedAuthTokenPath,
      });
    } else {
      logger.info("authentication required", { mode: "password" });
    }
  }
  logger.debug("Herdr sockets configured", {
    control_socket: config.socketPath,
    client_socket: config.clientSocketPath,
    public_dir: config.publicDir,
  });
  logger.info("browser URL", { url: publicBrowserUrl });

  const browserUrl = withLoginToken(
    publicBrowserUrl,
    config.generatedAuthToken,
  );
  if (isAnyHost(config.host)) {
    const lanUrls = getLanIPs().map((ip) =>
      browserUrlFor(ip, listeningPort, Boolean(config.tls)),
    );
    if (lanUrls.length > 0) {
      for (const url of lanUrls) logger.info("LAN URL", { url });
    } else {
      logger.warn("no LAN IPv4 address detected");
    }
  }
  openBrowser(config, browserUrl);
}

let managerStopTask: Promise<void> | null = null;
function stopManagerOnce(): Promise<void> {
  // Seen marks are written in batches: keep the last ones.
  agentSeen.flush();
  webPush.stop();
  connectionProfiles.stopSupervision();
  managerStopTask ??= (async () => {
    // Pause the harness before taking away the runtimes its reads depend on.
    await assistantServiceTask
      ?.then((assistant) => assistant.dispose())
      .catch(() => undefined);
    stopStallMonitor();
    await Promise.all([
      connectionManager.stopAll(),
      cpuProfile?.stop(),
      extensionHost.dispose(),
      Promise.resolve(stopRegistryWatch()),
      Promise.resolve(extensionPreviews.clear()),
    ]);
  })();
  return managerStopTask;
}

const shutdownController = createShutdownController({
  stop: stopManagerOnce,
  exit: (code) => process.exit(code),
  onStopError: (error) => {
    logger.error("connection shutdown failed", {
      error: sanitizeConnectionError(error),
    });
  },
});

function scheduleManagedShutdown(): void {
  const timer = setTimeout(() => {
    void shutdownController.request(0);
  }, 1_000);
  timer.unref();
}

process.on("exit", () => {
  void stopManagerOnce();
});
process.on("SIGINT", () => {
  void shutdownController.request(130);
});
process.on("SIGTERM", () => {
  void shutdownController.request(143);
});

try {
  main();
} catch (e) {
  logger.error("fatal startup error", { error: e });
  void shutdownController.request(1);
}
