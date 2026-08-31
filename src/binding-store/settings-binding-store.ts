import {
  BindingValidationError,
  type BindingStore,
  type ChatBinding,
  type RepositoryScope,
} from "./binding-store.js";
import { repositoryCwdSchema, storedBindingSchema } from "./binding-schema.js";
import type { StoredBinding } from "./binding-schema.js";
import { readSettingsFileObject, writeSettingsFileObject } from "../settings-file/settings-file.js";

type DeleteScopeResult =
  { readonly changed: false } | { readonly changed: true; readonly binding: StoredBinding | null };
type BindingMutationOperation = "set" | "delete";

type StrictMutationState = {
  readonly root: Record<string, unknown>;
  readonly bindings: Record<string, StoredBinding>;
};

/** A mutation cannot safely preserve a malformed settings file. */
export class SettingsBindingMutationError extends Error {
  override readonly name = "SettingsBindingMutationError";

  constructor(
    readonly operation: BindingMutationOperation,
    readonly settingsPath: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`cannot ${operation} repository binding: ${reason} (${settingsPath})`, options);
  }
}

/**
 * {@link BindingStore} backed by the `bindings` block of a single
 * `settings.json`. This keeps every piece of humming state in one file
 * (Miller's decision) and is the file the agent edits for natural-language
 * binding — the gateway watches it and hot-reloads.
 *
 * Reads/writes are whole-file: the store loads settings.json, mutates only the
 * `bindings` key, and writes the whole object back atomically (temp + rename)
 * so a concurrent reader never sees a half-written file. Other top-level keys
 * (credentials, runtime, agents) are preserved untouched.
 */
export class SettingsBindingStore implements BindingStore {
  private readonly settingsPath: string;
  /** Last valid bindings remain routable while an external editor is mid-write. */
  private lastKnownBindings: Record<string, StoredBinding> = {};

  constructor(settingsPath: string) {
    this.settingsPath = settingsPath;
  }

  async init(): Promise<void> {
    // Prime last-known-good before the watcher can observe a transient external write.
    this.readBindings();
  }

  async close(): Promise<void> {
    // Writes are synchronous + atomic; nothing to flush.
  }

  async get(chatId: string): Promise<ChatBinding | null> {
    const stored = this.readBindings()[chatId];
    if (!stored) return null;
    return this.hydrate(chatId, stored);
  }

  /**
   * @throws {BindingValidationError} When `cwd` is empty.
   * @throws {SettingsBindingMutationError} When existing settings are malformed or invalid.
   * @throws {Error} When the settings file cannot be written.
   */
  async set(chatId: string, scope: RepositoryScope, cwd: string): Promise<void> {
    const parsedCwd = repositoryCwdSchema.safeParse(cwd);
    if (!parsedCwd.success) throw new BindingValidationError(scope, cwd);

    const { root, bindings } = this.readStrictMutationState("set");
    const existing = bindings[chatId] ?? {};
    const nextBindings = { ...bindings, [chatId]: this.setScope(existing, scope, parsedCwd.data) };
    writeSettingsFileObject(this.settingsPath, { ...root, bindings: nextBindings });
    this.lastKnownBindings = cloneBindings(nextBindings);
  }

  /**
   * @throws {SettingsBindingMutationError} When existing settings are malformed or invalid.
   * @throws {Error} When the settings file cannot be written after a deletion.
   */
  async delete(chatId: string, scope: RepositoryScope): Promise<void> {
    const { root, bindings } = this.readStrictMutationState("delete");
    const existing = bindings[chatId];
    if (!existing) return;

    const result = this.deleteScope(existing, scope);
    if (!result.changed) return;

    const nextBindings = { ...bindings };
    if (result.binding) nextBindings[chatId] = result.binding;
    else delete nextBindings[chatId];
    writeSettingsFileObject(this.settingsPath, { ...root, bindings: nextBindings });
    this.lastKnownBindings = cloneBindings(nextBindings);
  }

  async list(): Promise<readonly ChatBinding[]> {
    const stored = this.readBindings();
    return Object.entries(stored).map(([chatId, binding]) => this.hydrate(chatId, binding));
  }

  /**
   * Whether settings.json currently contains one complete, valid bindings
   * snapshot. Returns `true` when the file or its `bindings` key is absent
   * (both are legitimate empty states); returns `false` for malformed JSON or
   * any invalid binding entry, such as a half-written external update.
   * Callers that diff bindings use this to retain last-known-good state.
   */
  isReadable(): boolean {
    try {
      return this.bindingsOfStrict(readSettingsFileObject(this.settingsPath)) !== null;
    } catch {
      return false;
    }
  }

  private setScope(existing: StoredBinding, scope: RepositoryScope, cwd: string): StoredBinding {
    if (scope.kind === "chat") return { ...existing, cwd };

    return {
      ...existing,
      topics: {
        ...existing.topics,
        [scope.threadId]: { cwd },
      },
    };
  }

  private deleteScope(existing: StoredBinding, scope: RepositoryScope): DeleteScopeResult {
    if (scope.kind === "chat") {
      if (existing.cwd === undefined) return { changed: false };
      if (!existing.topics) return { changed: true, binding: null };
      return { changed: true, binding: { topics: existing.topics } };
    }

    if (!existing.topics || !Object.hasOwn(existing.topics, scope.threadId)) {
      return { changed: false };
    }

    const topics = { ...existing.topics };
    delete topics[scope.threadId];
    if (Object.keys(topics).length === 0) {
      if (existing.cwd === undefined) return { changed: true, binding: null };
      return { changed: true, binding: { cwd: existing.cwd } };
    }

    return {
      changed: true,
      binding: {
        ...(existing.cwd === undefined ? {} : { cwd: existing.cwd }),
        topics,
      },
    };
  }

  // ----- internals --------------------------------------------------------

  private hydrate(chatId: string, stored: StoredBinding): ChatBinding {
    const now = Date.now();
    return {
      chatId,
      ...(stored.cwd === undefined ? {} : { cwd: stored.cwd }),
      ...(stored.topics === undefined ? {} : { topics: stored.topics }),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Read the bindings map, retaining the last fully validated state while an
   * external writer has left settings.json malformed or incomplete.
   */
  private readBindings(): Record<string, StoredBinding> {
    try {
      const bindings = this.bindingsOfStrict(readSettingsFileObject(this.settingsPath));
      if (bindings === null) return this.lastKnownBindings;
      this.lastKnownBindings = cloneBindings(bindings);
      return bindings;
    } catch {
      return this.lastKnownBindings;
    }
  }

  /**
   * @throws {SettingsBindingMutationError} When settings cannot safely be used as a RMW base.
   */
  private readStrictMutationState(operation: BindingMutationOperation): StrictMutationState {
    try {
      const root = readSettingsFileObject(this.settingsPath);
      const bindings = this.bindingsOfStrict(root);
      if (bindings === null) {
        throw new SettingsBindingMutationError(
          operation,
          this.settingsPath,
          "bindings must be a complete valid snapshot",
        );
      }
      this.lastKnownBindings = cloneBindings(bindings);
      return { root, bindings };
    } catch (err) {
      if (err instanceof SettingsBindingMutationError) throw err;
      throw new SettingsBindingMutationError(
        operation,
        this.settingsPath,
        "settings JSON is invalid",
        {
          cause: err,
        },
      );
    }
  }

  /** Return null unless every declared binding is valid as one consistent snapshot. */
  private bindingsOfStrict(root: Record<string, unknown>): Record<string, StoredBinding> | null {
    if (root["bindings"] === undefined) return {};
    const raw = root["bindings"];
    if (!isRecord(raw)) return null;

    return Object.entries(raw).reduce<Record<string, StoredBinding> | null>(
      (bindings, [chatId, value]) => {
        if (bindings === null) return null;
        const parsed = storedBindingSchema.safeParse(value);
        return parsed.success ? { ...bindings, [chatId]: parsed.data } : null;
      },
      {},
    );
  }
}

function cloneBindings(
  bindings: Readonly<Record<string, StoredBinding>>,
): Record<string, StoredBinding> {
  return structuredClone(bindings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
