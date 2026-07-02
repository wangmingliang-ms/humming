/**
 * Persistent mapping from `chatId` → the repo + agent that chat is bound to.
 *
 * This is what lets a single Lark bot serve many project groups: each chat
 * points at its own working directory and its own resolved ACP agent
 * invocation. Distinct from {@link SessionStore}, which records agent-side
 * conversation ids for resume — a binding answers "which repo/agent is this
 * chat pointed at", of which there is exactly one per chat.
 *
 * The library does **not** ship a default — callers construct a
 * {@link FileBindingStore} (or their own implementation) and pass it to
 * `LarkBridge`.
 */

/**
 * A chat's current repo + agent binding. The agent invocation is stored
 * already-resolved (command / args / env) so spawning never needs the CLI
 * preset registry — mirrors how {@link SessionRecord} persists resolved
 * `agentCommand` / `agentArgs`.
 */
export interface ChatBinding {
  readonly chatId: string;
  /** Absolute working directory the agent subprocess runs in. */
  readonly cwd: string;
  /**
   * Display label for the bound agent (preset id like `claude`, or the raw
   * command line). Shown by the `/where` command; never used for spawning.
   */
  readonly agentLabel: string;
  readonly agentCommand: string;
  readonly agentArgs: readonly string[];
  readonly agentEnv?: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
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

  /** The binding for a chat, or `null` if the chat is unbound. */
  get(chatId: string): Promise<ChatBinding | null>;

  /** Upsert a chat's binding (key: `chatId`). */
  set(binding: ChatBinding): Promise<void>;

  /** Remove a chat's binding. No-op if the chat was unbound. */
  delete(chatId: string): Promise<void>;

  /** Every known binding, insertion order not guaranteed. */
  list(): Promise<readonly ChatBinding[]>;
}
