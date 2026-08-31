/**
 * Persistent mapping from `chatId` → repository bindings for the chat and its
 * individual topics.
 *
 * This is what lets a single Lark bot serve many project groups: each chat can
 * point at a repository, while a topic can override that repository. Distinct
 * from {@link SessionStore}, which records agent-side conversation ids and
 * per-topic session profiles (agent + controls) for resume.
 *
 * The library does **not** ship a default — callers construct a
 * {@link SettingsBindingStore} (or their own implementation) and pass it to
 * `LarkGateway`.
 */

/** A topic's repository override. */
export type TopicRepositoryBinding = {
  /** Absolute working directory the agent subprocess runs in. */
  readonly cwd: string;
};

/**
 * A chat's repository bindings. A topic without an override inherits `cwd`.
 * Agent/model/mode/permission/config live on {@link SessionRecord}.
 */
export type ChatBinding = {
  readonly chatId: string;
  /** Absolute working directory for the chat, if it has one. */
  readonly cwd?: string;
  /** Per-topic repository overrides, keyed by thread id. */
  readonly topics?: Readonly<Record<string, TopicRepositoryBinding>>;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** One repository-binding location within a chat. */
export type RepositoryScope =
  { readonly kind: "chat" } | { readonly kind: "topic"; readonly threadId: string };

/**
 * Resolve the repository cwd visible at one chat/topic scope. Topic bindings
 * shadow the chat binding; unbound scopes fall through to runtime then
 * reception defaults.
 */
export function effectiveRepositoryCwd(
  binding: Pick<ChatBinding, "cwd" | "topics"> | null | undefined,
  threadId: string | null,
  runtimeCwd: string | null | undefined,
  receptionCwd: string | null | undefined,
): string | null | undefined {
  const topicCwd = threadId === null ? undefined : binding?.topics?.[threadId]?.cwd;
  return topicCwd ?? binding?.cwd ?? runtimeCwd ?? receptionCwd;
}

/** A requested repository binding has an invalid working directory. */
export class BindingValidationError extends Error {
  override readonly name = "BindingValidationError";

  constructor(
    readonly scope: RepositoryScope,
    readonly cwd: string,
  ) {
    super(`repository binding cwd must be an absolute path for ${scope.kind} scope`);
  }
}

export interface BindingStore {
  /**
   * Open / verify the underlying resource. Must be called before any other
   * method.
   *
   * @throws when the underlying resource (file system) cannot be initialised.
   */
  init(): Promise<void>;

  /** Release any open handles. */
  close(): Promise<void>;

  /** The repository bindings for a chat, or `null` if the chat is unbound. */
  get(chatId: string): Promise<ChatBinding | null>;

  /**
   * Upsert one repository-binding scope without changing the others.
   *
   * @throws {BindingValidationError} When `cwd` is not an absolute path.
   * @throws {Error} When the underlying settings storage cannot be written.
   */
  set(chatId: string, scope: RepositoryScope, cwd: string): Promise<void>;

  /**
   * Remove one repository-binding scope. No-op if the scope was unbound.
   *
   * @throws {Error} When the underlying settings storage cannot be written after a deletion.
   */
  delete(chatId: string, scope: RepositoryScope): Promise<void>;

  /** Every known binding, insertion order not guaranteed. */
  list(): Promise<readonly ChatBinding[]>;
}
