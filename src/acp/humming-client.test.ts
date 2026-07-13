import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HummingClient } from "./humming-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe("HummingClient infrastructure", () => {
  it("stores the current permission mode", () => {
    const client = new HummingClient({ permissionMode: "alwaysAsk" });
    expect(client.getPermissionMode()).toBe("alwaysAsk");
    client.setPermissionMode("alwaysAllow");
    expect(client.getPermissionMode()).toBe("alwaysAllow");
  });

  it("provides ACP text-file IO without owning Card presentation", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "humming-client-"));
    roots.push(root);
    const file = path.join(root, "note.txt");
    const client = new HummingClient({ permissionMode: "alwaysDeny" });

    await client.writeTextFile({ path: file, content: "hello" });
    await expect(client.readTextFile({ path: file })).resolves.toEqual({ content: "hello" });
  });
});
