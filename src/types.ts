/**
 * TypeScript shapes for the Pterodactyl Client API (`/api/client`).
 *
 * Field names are taken from `docs/pterodactyl-api.md`, which was compiled from the
 * panel's own transformers (`app/Transformers/Api/Client/*`). Everything here describes
 * the *inner* `attributes` object of a Pterodactyl fractal envelope unless the name says
 * otherwise (`*Envelope` / `*List`).
 *
 * Later phases (console, files, power, backups, misc) consume these — keep them exported.
 */

/* -------------------------------------------------------------------------- */
/* Fractal envelopes                                                          */
/* -------------------------------------------------------------------------- */

/** A single resource: `{ object: "server", attributes: {...} }`. */
export interface PteroItem<TObject extends string, TAttributes> {
  object: TObject;
  attributes: TAttributes;
  meta?: Record<string, unknown>;
}

/** A list: `{ object: "list", data: [...], meta: { pagination } }`. */
export interface PteroList<TItem> {
  object: 'list';
  data: TItem[];
  meta?: {
    pagination?: PteroPagination;
    [key: string]: unknown;
  };
}

export interface PteroPagination {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
  links?: Record<string, unknown>;
}

/** The panel's error envelope: `{ errors: [ { code, status, detail, meta } ] }`. */
export interface PteroErrorEnvelope {
  errors: Array<{
    code?: string;
    status?: string;
    detail?: string;
    meta?: Record<string, unknown>;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Servers (§4)                                                               */
/* -------------------------------------------------------------------------- */

export interface ServerLimits {
  memory: number;
  swap: number;
  disk: number;
  io: number;
  cpu: number;
  threads?: string | null;
  oom_disabled?: boolean;
}

export interface ServerFeatureLimits {
  databases: number;
  allocations: number;
  backups: number;
}

export interface ServerSftpDetails {
  ip: string;
  port: number;
}

/**
 * `ServerTransformer` attributes. `status` is the modern field; `is_suspended` /
 * `is_installing` are deprecated in the panel but still emitted, and the spec (docs/SPEC.md)
 * asks for them explicitly.
 */
export interface ServerAttributes {
  server_owner: boolean;
  identifier: string;
  __deprecated_uuid_short?: string;
  server_identifier?: string;
  internal_id?: number | string;
  uuid: string;
  name: string;
  node: string;
  is_node_under_maintenance?: boolean;
  sftp_details: ServerSftpDetails;
  description: string | null;
  limits: ServerLimits;
  invocation: string;
  docker_image: string;
  egg_features?: string[] | null;
  feature_limits: ServerFeatureLimits;
  /** null = running/installed normally. Otherwise one of `ServerStatus`. */
  status: ServerStatus | null;
  is_suspended: boolean;
  is_installing: boolean;
  is_transferring: boolean;
  skip_scripts?: boolean;
  relationships?: ServerRelationships;
}

/** `Server::STATUS_*` constants. */
export type ServerStatus =
  | 'installing'
  | 'install_failed'
  | 'reinstall_failed'
  | 'suspended'
  | 'restoring_backup';

export interface ServerRelationships {
  allocations?: PteroList<AllocationItem>;
  variables?: PteroList<EggVariableItem> | null;
  egg?: PteroItem<'egg', Record<string, unknown>>;
  subusers?: PteroList<PteroItem<'server_subuser', Record<string, unknown>>>;
}

export type ServerItem = PteroItem<'server', ServerAttributes>;

/** `GET /servers/{id}` — includes `meta.is_server_owner` / `meta.user_permissions`. */
export interface ServerResponse extends ServerItem {
  meta?: {
    is_server_owner?: boolean;
    user_permissions?: string[];
    [key: string]: unknown;
  };
}

export type ServerListResponse = PteroList<ServerItem>;

/* -------------------------------------------------------------------------- */
/* Resources (§5)                                                             */
/* -------------------------------------------------------------------------- */

export interface ResourceUsage {
  memory_bytes: number;
  cpu_absolute: number;
  disk_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  /** Milliseconds the process has been up, per Wings. */
  uptime: number;
}

/** Daemon-reported process state. Panel passes it straight through, so treat as open. */
export type ServerPowerState = 'offline' | 'starting' | 'running' | 'stopping' | (string & {});

export interface ResourcesAttributes {
  current_state: ServerPowerState;
  is_suspended: boolean;
  resources: ResourceUsage;
}

export type ResourcesResponse = PteroItem<'stats', ResourcesAttributes>;

/* -------------------------------------------------------------------------- */
/* Websocket credentials (§6)                                                 */
/* -------------------------------------------------------------------------- */

export interface WebsocketCredentials {
  /** Short-lived (10 minute) JWT. Never log this. */
  token: string;
  /** `wss://<node-fqdn>/api/servers/<uuid>/ws` */
  socket: string;
}

export interface WebsocketCredentialsResponse {
  data: WebsocketCredentials;
}

/* -------------------------------------------------------------------------- */
/* Power (§7)                                                                 */
/* -------------------------------------------------------------------------- */

export type PowerSignal = 'start' | 'stop' | 'restart' | 'kill';

/* -------------------------------------------------------------------------- */
/* Files (§9)                                                                 */
/* -------------------------------------------------------------------------- */

export interface FileObjectAttributes {
  name: string;
  mode: string;
  mode_bits: string;
  size: number;
  is_file: boolean;
  is_symlink: boolean;
  mimetype: string;
  created_at: string;
  modified_at: string;
}

export type FileObjectItem = PteroItem<'file_object', FileObjectAttributes>;
export type FileListResponse = PteroList<FileObjectItem>;

export interface SignedUrlAttributes {
  /** Signed, short-lived URL. Never log or audit this. */
  url: string;
}

export type SignedUrlResponse = PteroItem<'signed_url', SignedUrlAttributes>;

/** One entry of the `PUT /files/rename` body. */
export interface FileRenameEntry {
  from: string;
  to: string;
}

/* -------------------------------------------------------------------------- */
/* Backups (§10)                                                              */
/* -------------------------------------------------------------------------- */

export interface BackupAttributes {
  uuid: string;
  is_successful: boolean;
  is_locked: boolean;
  name: string;
  ignored_files: string[];
  checksum: string | null;
  bytes: number;
  created_at: string;
  completed_at: string | null;
}

export type BackupItem = PteroItem<'backup', BackupAttributes>;

export interface BackupListResponse extends PteroList<BackupItem> {
  meta?: {
    pagination?: PteroPagination;
    backup_count?: number;
    [key: string]: unknown;
  };
}

export interface CreateBackupOptions {
  name?: string;
  /** Newline-delimited glob list of paths to exclude. */
  ignored?: string;
  /** Silently ignored by the panel unless the key holds `backup.delete`. */
  is_locked?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Schedules (§11)                                                            */
/* -------------------------------------------------------------------------- */

export interface ScheduleCron {
  minute: string;
  hour: string;
  day_of_month: string;
  month: string;
  day_of_week: string;
}

export interface ScheduleTaskAttributes {
  id: number;
  sequence_id: number;
  action: 'command' | 'power' | 'backup';
  payload: string;
  time_offset: number;
  is_queued: boolean;
  continue_on_failure: boolean;
  created_at: string;
  updated_at: string;
}

export type ScheduleTaskItem = PteroItem<'schedule_task', ScheduleTaskAttributes>;

export interface ScheduleAttributes {
  id: number;
  name: string;
  cron: ScheduleCron;
  is_active: boolean;
  is_processing: boolean;
  only_when_online: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  relationships?: {
    tasks?: PteroList<ScheduleTaskItem>;
  };
}

export type ScheduleItem = PteroItem<'server_schedule', ScheduleAttributes>;
export type ScheduleListResponse = PteroList<ScheduleItem>;

/* -------------------------------------------------------------------------- */
/* Allocations (§12)                                                          */
/* -------------------------------------------------------------------------- */

export interface AllocationAttributes {
  id: number;
  ip: string;
  ip_alias: string | null;
  port: number;
  notes: string | null;
  /** True iff this is the server's current primary allocation. */
  is_default: boolean;
}

export type AllocationItem = PteroItem<'allocation', AllocationAttributes>;
export type AllocationListResponse = PteroList<AllocationItem>;

/* -------------------------------------------------------------------------- */
/* Startup / egg variables (§13)                                              */
/* -------------------------------------------------------------------------- */

export interface EggVariableAttributes {
  name: string;
  description: string;
  env_variable: string;
  default_value: string;
  server_value: string | null;
  is_editable: boolean;
  /** Laravel validation rule string, e.g. `required|string|max:20`. */
  rules: string;
}

export type EggVariableItem = PteroItem<'egg_variable', EggVariableAttributes>;

export interface StartupResponse extends PteroList<EggVariableItem> {
  meta?: {
    startup_command?: string;
    raw_startup_command?: string;
    docker_images?: Record<string, string>;
    [key: string]: unknown;
  };
}

/* -------------------------------------------------------------------------- */
/* Account (§14)                                                              */
/* -------------------------------------------------------------------------- */

export interface AccountAttributes {
  id: number;
  admin: boolean;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  language: string;
}

export type AccountResponse = PteroItem<'user', AccountAttributes>;

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

export interface RateLimitInfo {
  /** `X-RateLimit-Limit` — requests permitted per window. */
  limit: number;
  /** `X-RateLimit-Remaining` — requests left in the current window. */
  remaining: number;
  /**
   * Absolute time the window resets. Derived from `X-RateLimit-Reset`, which Laravel
   * emits as a unix timestamp (seconds); a small value is treated as "seconds from now".
   */
  resetAt: Date;
}
