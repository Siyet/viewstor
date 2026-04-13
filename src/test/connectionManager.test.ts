/**
 * Unit tests for ConnectionManager — connection CRUD, lifecycle,
 * folder management, color/readonly inheritance, driver caching, dispose.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// vi.hoisted runs before vi.mock hoisting, so shared state is available in mock factories
const {
  globalStateStore,
  mockGlobalState,
  watcherListeners,
  mockFileSystemWatcher,
  readFileHolder,
} = vi.hoisted(() => {
  const globalStateStore = new Map<string, unknown>();
  const mockGlobalState = {
    get: (key: string, defaultValue?: unknown) => globalStateStore.get(key) ?? defaultValue,
    update: async (key: string, value: unknown) => { globalStateStore.set(key, value); },
  };

  const watcherListeners = {
    onChange: [] as Array<() => void>,
    onCreate: [] as Array<() => void>,
    onDelete: [] as Array<() => void>,
  };

  const mockFileSystemWatcher = {
    onDidChange: (listener: () => void) => {
      watcherListeners.onChange.push(listener);
      return { dispose: () => {} };
    },
    onDidCreate: (listener: () => void) => {
      watcherListeners.onCreate.push(listener);
      return { dispose: () => {} };
    },
    onDidDelete: (listener: () => void) => {
      watcherListeners.onDelete.push(listener);
      return { dispose: () => {} };
    },
    dispose: () => {},
  };

  const readFileHolder = { result: null as Uint8Array | null };

  return { globalStateStore, mockGlobalState, watcherListeners, mockFileSystemWatcher, readFileHolder };
});

function createFreshMockDriver() {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    execute: vi.fn(async () => ({ columns: [], rows: [] })),
    getSchema: vi.fn(async () => []),
    getTableInfo: vi.fn(async () => ({ columns: [] })),
    getTableData: vi.fn(async () => ({ columns: [], rows: [] })),
  };
}

vi.mock("vscode", () => {
  const mockWorkspaceFolderUri = { fsPath: "/workspace", toString: () => "file:///workspace" };
  const mockFileUri = {
    fsPath: "/workspace/.vscode/viewstor.json",
    toString: () => "file:///workspace/.vscode/viewstor.json",
  };

  return {
    EventEmitter: class {
      private listeners: Array<(...args: unknown[]) => void> = [];
      event = (listener: (...args: unknown[]) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } };
      };
      fire(...args: unknown[]) {
        for (const listener of this.listeners) listener(...args);
      }
      dispose() { this.listeners = []; }
    },
    Uri: {
      joinPath: () => mockFileUri,
      file: (filePath: string) => ({ fsPath: filePath }),
    },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    workspace: {
      workspaceFolders: [{ uri: mockWorkspaceFolderUri }],
      fs: {
        readFile: async () => {
          if (readFileHolder.result) return readFileHolder.result;
          throw new Error("File not found");
        },
        writeFile: async () => {},
      },
      createFileSystemWatcher: () => mockFileSystemWatcher,
    },
  };
});

// createDriver mock — factory returns vi.fn() spies so individual tests can override with mockReturnValueOnce
vi.mock("../drivers", () => ({
  createDriver: vi.fn(() => ({
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    execute: vi.fn(async () => ({ columns: [], rows: [] })),
    getSchema: vi.fn(async () => []),
    getTableInfo: vi.fn(async () => ({ columns: [] })),
    getTableData: vi.fn(async () => ({ columns: [], rows: [] })),
  })),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { ConnectionManager } from "../connections/connectionManager";
import { ConnectionConfig } from "../types/connection";
import { createDriver } from "../drivers";
import * as fs from "fs";

// --- Helpers ---

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "test-conn-1",
    name: "Test PG",
    type: "postgresql",
    host: "localhost",
    port: 5432,
    database: "testdb",
    ...overrides,
  };
}

function makeContext() {
  return {
    globalState: mockGlobalState,
    subscriptions: [],
  } as never;
}

function createManager(): ConnectionManager {
  return new ConnectionManager(makeContext());
}

// --- Test suites ---

beforeEach(() => {
  globalStateStore.clear();
  readFileHolder.result = null;
  watcherListeners.onChange = [];
  watcherListeners.onCreate = [];
  watcherListeners.onDelete = [];
  vi.clearAllMocks();
  (fs.existsSync as Mock).mockReturnValue(false);
});

describe("ConnectionManager", () => {
  // -----------------------------------------------------------------------
  // Loading from globalState
  // -----------------------------------------------------------------------
  describe("loadConnections / loadFolders", () => {
    it("loads connections from globalState and sets scope to 'user'", () => {
      const stored = [makeConfig({ id: "stored-1", scope: undefined as unknown as "user" })];
      globalStateStore.set("viewstor.connections", stored);

      const manager = createManager();
      const all = manager.getAll();

      expect(all).toHaveLength(1);
      expect(all[0].config.id).toBe("stored-1");
      expect(all[0].config.scope).toBe("user");
      expect(all[0].connected).toBe(false);
    });

    it("loads folders from globalState and sets scope to 'user'", () => {
      const stored = [{ id: "f1", name: "Dev", sortOrder: 0 }];
      globalStateStore.set("viewstor.connectionFolders", stored);

      const manager = createManager();
      const folders = manager.getAllFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe("Dev");
      expect(folders[0].scope).toBe("user");
    });

    it("returns empty arrays when globalState has no data", () => {
      const manager = createManager();
      expect(manager.getAll()).toHaveLength(0);
      expect(manager.getAllFolders()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // User config file (~/.viewstor/connections.json)
  // -----------------------------------------------------------------------
  describe("loadUserConfigFile", () => {
    it("loads connections from user config file when it exists", () => {
      const fileConnections = [makeConfig({ id: "file-conn" })];
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        JSON.stringify({ connections: fileConnections, folders: [] })
      );

      const manager = createManager();
      const conn = manager.get("file-conn");

      expect(conn).toBeDefined();
      expect(conn!.config.scope).toBe("user");
    });

    it("does not overwrite existing connections with same id", () => {
      const existing = makeConfig({ id: "dup-id", name: "GlobalState Version" });
      globalStateStore.set("viewstor.connections", [existing]);

      const fileConnections = [makeConfig({ id: "dup-id", name: "File Version" })];
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(
        JSON.stringify({ connections: fileConnections, folders: [] })
      );

      const manager = createManager();
      expect(manager.get("dup-id")!.config.name).toBe("GlobalState Version");
    });

    it("handles missing config file gracefully", () => {
      (fs.existsSync as Mock).mockReturnValue(false);
      const manager = createManager();
      expect(manager.getAll()).toHaveLength(0);
    });

    it("handles invalid JSON gracefully", () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue("not valid json {{");
      // Should not throw
      const manager = createManager();
      expect(manager.getAll()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Project data (.vscode/viewstor.json)
  // -----------------------------------------------------------------------
  describe("loadProjectData", () => {
    it("loads project connections and folders from workspace file", async () => {
      const projectData = {
        connections: [makeConfig({ id: "proj-conn", name: "Project DB" })],
        folders: [{ id: "proj-f1", name: "Project Folder", sortOrder: 0 }],
      };
      readFileHolder.result = Buffer.from(JSON.stringify(projectData), "utf8");

      const manager = createManager();
      await vi.waitFor(() => {
        expect(manager.get("proj-conn")).toBeDefined();
      });

      expect(manager.get("proj-conn")!.config.scope).toBe("project");
      expect(manager.getFolder("proj-f1")!.scope).toBe("project");
    });

    it("does not overwrite existing connections from globalState", async () => {
      const existing = makeConfig({ id: "shared-id", name: "User Version" });
      globalStateStore.set("viewstor.connections", [existing]);

      const projectData = {
        connections: [makeConfig({ id: "shared-id", name: "Project Version" })],
        folders: [],
      };
      readFileHolder.result = Buffer.from(JSON.stringify(projectData), "utf8");

      const manager = createManager();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(manager.get("shared-id")!.config.name).toBe("User Version");
    });
  });

  // -----------------------------------------------------------------------
  // Connection CRUD
  // -----------------------------------------------------------------------
  describe("connection CRUD", () => {
    it("add() stores connection and fires onDidChange", async () => {
      const manager = createManager();
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      const config = makeConfig({ id: "new-1" });
      await manager.add(config);

      expect(manager.get("new-1")).toBeDefined();
      expect(manager.get("new-1")!.connected).toBe(false);
      expect(changeHandler).toHaveBeenCalled();
      // Verify persisted to globalState
      const saved = globalStateStore.get("viewstor.connections") as ConnectionConfig[];
      expect(saved.some(conn => conn.id === "new-1")).toBe(true);
    });

    it("getAll() returns all connections", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "a" }));
      await manager.add(makeConfig({ id: "b" }));

      expect(manager.getAll()).toHaveLength(2);
    });

    it("get() returns undefined for nonexistent id", () => {
      const manager = createManager();
      expect(manager.get("nonexistent")).toBeUndefined();
    });

    it("update() replaces config, disconnects if connected, and fires change", async () => {
      const manager = createManager();
      const config = makeConfig({ id: "upd-1", name: "Original" });
      await manager.add(config);
      await manager.connect("upd-1");

      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      await manager.update(makeConfig({ id: "upd-1", name: "Updated" }));

      expect(manager.get("upd-1")!.config.name).toBe("Updated");
      expect(manager.get("upd-1")!.connected).toBe(false);
      expect(changeHandler).toHaveBeenCalled();
    });

    it("update() works on disconnected connection without errors", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "upd-2" }));
      await manager.update(makeConfig({ id: "upd-2", name: "New Name" }));

      expect(manager.get("upd-2")!.config.name).toBe("New Name");
    });

    it("remove() deletes connection, disconnects if connected, fires change", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "rm-1" }));
      await manager.connect("rm-1");

      const driver = manager.getDriver("rm-1")!;
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      await manager.remove("rm-1");

      expect(manager.get("rm-1")).toBeUndefined();
      expect(driver.disconnect).toHaveBeenCalled();
      expect(changeHandler).toHaveBeenCalled();
    });

    it("remove() persists deletion to globalState", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "rm-2" }));
      await manager.remove("rm-2");

      const savedConnections = globalStateStore.get("viewstor.connections") as ConnectionConfig[];
      expect(savedConnections.find(conn => conn.id === "rm-2")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Connection lifecycle (connect, disconnect)
  // -----------------------------------------------------------------------
  describe("connection lifecycle", () => {
    it("connect() creates driver, connects, sets connected=true", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "lc-1" }));

      await manager.connect("lc-1");

      expect(manager.get("lc-1")!.connected).toBe(true);
      expect(createDriver).toHaveBeenCalledWith("postgresql");
      expect(manager.getDriver("lc-1")).toBeDefined();
    });

    it("connect() fires onDidChange", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "lc-2" }));
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      await manager.connect("lc-2");

      expect(changeHandler).toHaveBeenCalled();
    });

    it("connect() throws for nonexistent connection", async () => {
      const manager = createManager();
      await expect(manager.connect("ghost")).rejects.toThrow("not found");
    });

    it("disconnect() cleans up driver and sets connected=false", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "lc-3" }));
      await manager.connect("lc-3");

      const driver = manager.getDriver("lc-3")!;
      await manager.disconnect("lc-3");

      expect(manager.get("lc-3")!.connected).toBe(false);
      expect(driver.disconnect).toHaveBeenCalled();
      expect(manager.getDriver("lc-3")).toBeUndefined();
    });

    it("disconnect() cleans up cached multi-DB drivers", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "lc-4", database: "maindb" }));
      await manager.connect("lc-4");

      // Create a multi-DB cached driver
      const dbDriver = await manager.getDriverForDatabase("lc-4", "otherdb");
      await manager.disconnect("lc-4");

      // Multi-DB driver should have been disconnected
      expect(dbDriver.disconnect).toHaveBeenCalled();
    });

    it("disconnect() fires onDidChange", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "lc-5" }));
      await manager.connect("lc-5");
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      await manager.disconnect("lc-5");

      expect(changeHandler).toHaveBeenCalled();
    });

    it("disconnect() is safe to call on already-disconnected connection", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "lc-6" }));

      // Should not throw
      await manager.disconnect("lc-6");
      expect(manager.get("lc-6")!.connected).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-DB driver caching (getDriverForDatabase)
  // -----------------------------------------------------------------------
  describe("getDriverForDatabase", () => {
    it("returns primary driver when requesting the main database", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "mdb-1", database: "maindb" }));
      await manager.connect("mdb-1");

      const primaryDriver = manager.getDriver("mdb-1");
      const result = await manager.getDriverForDatabase("mdb-1", "maindb");

      expect(result).toBe(primaryDriver);
    });

    it("creates and caches a new driver for a different database", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "mdb-2", database: "maindb" }));
      await manager.connect("mdb-2");

      const initialCreateCount = (createDriver as Mock).mock.calls.length;
      const driver = await manager.getDriverForDatabase("mdb-2", "analytics");

      expect((createDriver as Mock).mock.calls.length).toBe(initialCreateCount + 1);
      expect(driver.connect).toHaveBeenCalled();
    });

    it("reuses cached driver when ping succeeds", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "mdb-3", database: "maindb" }));
      await manager.connect("mdb-3");

      const firstDriver = await manager.getDriverForDatabase("mdb-3", "analytics");
      const createCountAfterFirst = (createDriver as Mock).mock.calls.length;

      const secondDriver = await manager.getDriverForDatabase("mdb-3", "analytics");

      expect(secondDriver).toBe(firstDriver);
      expect((createDriver as Mock).mock.calls.length).toBe(createCountAfterFirst);
    });

    it("creates new driver when cached driver ping fails", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "mdb-4", database: "maindb" }));
      await manager.connect("mdb-4");

      const firstDriver = await manager.getDriverForDatabase("mdb-4", "analytics");
      // Make ping fail on the cached driver
      (firstDriver.ping as Mock).mockRejectedValueOnce(new Error("connection lost"));

      const secondDriver = await manager.getDriverForDatabase("mdb-4", "analytics");

      expect(secondDriver).not.toBe(firstDriver);
      expect(secondDriver.connect).toHaveBeenCalled();
    });

    it("throws for nonexistent connection", async () => {
      const manager = createManager();
      await expect(manager.getDriverForDatabase("ghost", "db")).rejects.toThrow("Connection not found");
    });
  });

  // -----------------------------------------------------------------------
  // testConnection
  // -----------------------------------------------------------------------
  describe("testConnection", () => {
    it("returns true when ping succeeds", async () => {
      const manager = createManager();
      const result = await manager.testConnection(makeConfig());

      expect(result).toBe(true);
      expect(createDriver).toHaveBeenCalledWith("postgresql");
    });

    it("returns false when connect throws", async () => {
      const failDriver = createFreshMockDriver();
      (failDriver.connect as Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
      (createDriver as Mock).mockReturnValueOnce(failDriver);

      const manager = createManager();
      const result = await manager.testConnection(makeConfig());

      expect(result).toBe(false);
    });

    it("disconnects driver after successful test", async () => {
      const testDriver = createFreshMockDriver();
      (createDriver as Mock).mockReturnValueOnce(testDriver);

      const manager = createManager();
      await manager.testConnection(makeConfig());

      expect(testDriver.disconnect).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Folder management
  // -----------------------------------------------------------------------
  describe("folder CRUD", () => {
    it("addFolder() creates folder with generated id and fires change", async () => {
      const manager = createManager();
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      const folder = await manager.addFolder("Production", "#ff0000", true);

      expect(folder.name).toBe("Production");
      expect(folder.color).toBe("#ff0000");
      expect(folder.readonly).toBe(true);
      expect(folder.id).toBeTruthy();
      expect(manager.getFolder(folder.id)).toBe(folder);
      expect(changeHandler).toHaveBeenCalled();
    });

    it("addFolder() with parentFolderId creates nested folder", async () => {
      const manager = createManager();
      const parent = await manager.addFolder("Parent");
      const child = await manager.addFolder("Child", undefined, undefined, parent.id);

      expect(child.parentFolderId).toBe(parent.id);
    });

    it("getAllFolders() returns folders sorted by sortOrder", async () => {
      const manager = createManager();
      const folderB = await manager.addFolder("B");
      const folderA = await manager.addFolder("A");
      await manager.updateFolder(folderA.id, { sortOrder: 0 });
      await manager.updateFolder(folderB.id, { sortOrder: 1 });

      const folders = manager.getAllFolders();
      expect(folders[0].name).toBe("A");
      expect(folders[1].name).toBe("B");
    });

    it("updateFolder() modifies folder properties", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("Old Name");
      await manager.updateFolder(folder.id, { name: "New Name", color: "#00ff00" });

      expect(manager.getFolder(folder.id)!.name).toBe("New Name");
      expect(manager.getFolder(folder.id)!.color).toBe("#00ff00");
    });

    it("updateFolder() is no-op for nonexistent folder", async () => {
      const manager = createManager();
      // Should not throw
      await manager.updateFolder("nonexistent", { name: "Whatever" });
    });

    it("removeFolder() reparents child folders to deleted folder's parent", async () => {
      const manager = createManager();
      const grandparent = await manager.addFolder("Grandparent");
      const parent = await manager.addFolder("Parent", undefined, undefined, grandparent.id);
      const child = await manager.addFolder("Child", undefined, undefined, parent.id);

      await manager.removeFolder(parent.id);

      expect(manager.getFolder(parent.id)).toBeUndefined();
      expect(manager.getFolder(child.id)!.parentFolderId).toBe(grandparent.id);
    });

    it("removeFolder() reparents connections to deleted folder's parent", async () => {
      const manager = createManager();
      const parent = await manager.addFolder("Root");
      const child = await manager.addFolder("Child", undefined, undefined, parent.id);

      await manager.add(makeConfig({ id: "conn-in-child", folderId: child.id }));
      await manager.removeFolder(child.id);

      expect(manager.get("conn-in-child")!.config.folderId).toBe(parent.id);
    });

    it("removeFolder() reparents to undefined when deleted folder has no parent", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("TopLevel");
      const child = await manager.addFolder("ChildFolder", undefined, undefined, folder.id);
      await manager.add(makeConfig({ id: "conn-orphan", folderId: folder.id }));

      await manager.removeFolder(folder.id);

      expect(manager.getFolder(child.id)!.parentFolderId).toBeUndefined();
      expect(manager.get("conn-orphan")!.config.folderId).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Circular nesting prevention (moveFolderToFolder)
  // -----------------------------------------------------------------------
  describe("moveFolderToFolder — circular nesting prevention", () => {
    it("allows valid move to unrelated folder", async () => {
      const manager = createManager();
      const folderA = await manager.addFolder("A");
      const folderB = await manager.addFolder("B");

      await manager.moveFolderToFolder(folderA.id, folderB.id);

      expect(manager.getFolder(folderA.id)!.parentFolderId).toBe(folderB.id);
    });

    it("prevents moving folder into its own child (direct cycle)", async () => {
      const manager = createManager();
      const parent = await manager.addFolder("Parent");
      const child = await manager.addFolder("Child", undefined, undefined, parent.id);

      await manager.moveFolderToFolder(parent.id, child.id);

      // Should not have changed — cycle prevented
      expect(manager.getFolder(parent.id)!.parentFolderId).toBeUndefined();
    });

    it("prevents moving folder into a deeply nested descendant", async () => {
      const manager = createManager();
      const level0 = await manager.addFolder("L0");
      const level1 = await manager.addFolder("L1", undefined, undefined, level0.id);
      const level2 = await manager.addFolder("L2", undefined, undefined, level1.id);

      // Try to move L0 into L2 — would create L0 -> L1 -> L2 -> L0
      await manager.moveFolderToFolder(level0.id, level2.id);

      expect(manager.getFolder(level0.id)!.parentFolderId).toBeUndefined();
    });

    it("allows moving folder to root (undefined parent)", async () => {
      const manager = createManager();
      const parent = await manager.addFolder("Parent");
      const child = await manager.addFolder("Child", undefined, undefined, parent.id);

      await manager.moveFolderToFolder(child.id, undefined);

      expect(manager.getFolder(child.id)!.parentFolderId).toBeUndefined();
    });

    it("fires onDidChange on valid move", async () => {
      const manager = createManager();
      const folderA = await manager.addFolder("A");
      const folderB = await manager.addFolder("B");
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      await manager.moveFolderToFolder(folderA.id, folderB.id);

      expect(changeHandler).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Color and readonly inheritance
  // -----------------------------------------------------------------------
  describe("getConnectionColor", () => {
    it("returns connection's own color when set", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "cc-1", color: "#ff0000" }));

      expect(manager.getConnectionColor("cc-1")).toBe("#ff0000");
    });

    it("falls back to folder color when connection has no color", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("Colored", "#00ff00");
      await manager.add(makeConfig({ id: "cc-2", folderId: folder.id }));

      expect(manager.getConnectionColor("cc-2")).toBe("#00ff00");
    });

    it("returns undefined when neither connection nor folder has color", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("NoColor");
      await manager.add(makeConfig({ id: "cc-3", folderId: folder.id }));

      expect(manager.getConnectionColor("cc-3")).toBeUndefined();
    });

    it("returns undefined for nonexistent connection", () => {
      const manager = createManager();
      expect(manager.getConnectionColor("ghost")).toBeUndefined();
    });

    it("prefers connection color over folder color", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("Blue", "#0000ff");
      await manager.add(makeConfig({ id: "cc-4", color: "#ff0000", folderId: folder.id }));

      expect(manager.getConnectionColor("cc-4")).toBe("#ff0000");
    });
  });

  describe("isConnectionReadonly", () => {
    it("returns true when connection is readonly", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "ro-1", readonly: true }));

      expect(manager.isConnectionReadonly("ro-1")).toBe(true);
    });

    it("returns false when connection is explicitly not readonly", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("RO Folder", undefined, true);
      await manager.add(makeConfig({ id: "ro-2", readonly: false, folderId: folder.id }));

      // Connection explicitly says readonly=false
      expect(manager.isConnectionReadonly("ro-2")).toBe(false);
    });

    it("falls back to folder readonly when connection has no setting", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("RO Folder", undefined, true);
      await manager.add(makeConfig({ id: "ro-3", folderId: folder.id }));

      expect(manager.isConnectionReadonly("ro-3")).toBe(true);
    });

    it("returns false when neither connection nor folder is readonly", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "ro-4" }));

      expect(manager.isConnectionReadonly("ro-4")).toBe(false);
    });

    it("returns false for nonexistent connection", () => {
      const manager = createManager();
      expect(manager.isConnectionReadonly("ghost")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Additional operations
  // -----------------------------------------------------------------------
  describe("setConnectionColor", () => {
    it("updates connection color and fires change", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "sc-1" }));
      const changeHandler = vi.fn();
      manager.onDidChange(changeHandler);

      await manager.setConnectionColor("sc-1", "#abcdef");

      expect(manager.get("sc-1")!.config.color).toBe("#abcdef");
      expect(changeHandler).toHaveBeenCalled();
    });

    it("clears color when undefined is passed", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "sc-2", color: "#ff0000" }));

      await manager.setConnectionColor("sc-2", undefined);

      expect(manager.get("sc-2")!.config.color).toBeUndefined();
    });
  });

  describe("moveConnectionToFolder", () => {
    it("assigns connection to a folder and fires change", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("Target");
      await manager.add(makeConfig({ id: "mcf-1" }));

      await manager.moveConnectionToFolder("mcf-1", folder.id);

      expect(manager.get("mcf-1")!.config.folderId).toBe(folder.id);
    });

    it("removes folder assignment when undefined is passed", async () => {
      const manager = createManager();
      const folder = await manager.addFolder("Source");
      await manager.add(makeConfig({ id: "mcf-2", folderId: folder.id }));

      await manager.moveConnectionToFolder("mcf-2", undefined);

      expect(manager.get("mcf-2")!.config.folderId).toBeUndefined();
    });
  });

  describe("toggleHiddenSchema", () => {
    it("adds schema to hidden list", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "hs-1" }));

      await manager.toggleHiddenSchema("hs-1", "mydb", "pg_catalog");

      expect(manager.get("hs-1")!.config.hiddenSchemas).toEqual({ mydb: ["pg_catalog"] });
    });

    it("removes schema from hidden list on second toggle", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "hs-2" }));

      await manager.toggleHiddenSchema("hs-2", "mydb", "pg_catalog");
      await manager.toggleHiddenSchema("hs-2", "mydb", "pg_catalog");

      expect(manager.get("hs-2")!.config.hiddenSchemas!["mydb"]).toEqual([]);
    });
  });

  describe("toggleHiddenDatabase", () => {
    it("adds database to hidden list", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "hd-1" }));

      await manager.toggleHiddenDatabase("hd-1", "template0");

      expect(manager.get("hd-1")!.config.hiddenDatabases).toContain("template0");
    });

    it("removes database from hidden list on second toggle", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "hd-2" }));

      await manager.toggleHiddenDatabase("hd-2", "template0");
      await manager.toggleHiddenDatabase("hd-2", "template0");

      expect(manager.get("hd-2")!.config.hiddenDatabases).not.toContain("template0");
    });
  });

  // -----------------------------------------------------------------------
  // Saving behavior
  // -----------------------------------------------------------------------
  describe("persistence", () => {
    it("saves only user-scoped connections to globalState", async () => {
      const projectData = {
        connections: [makeConfig({ id: "proj-only", scope: "project" as const })],
        folders: [],
      };
      readFileHolder.result = Buffer.from(JSON.stringify(projectData), "utf8");

      const manager = createManager();
      await vi.waitFor(() => {
        expect(manager.get("proj-only")).toBeDefined();
      });

      await manager.add(makeConfig({ id: "user-only", scope: "user" }));

      const savedToGlobalState = globalStateStore.get("viewstor.connections") as ConnectionConfig[];
      const ids = savedToGlobalState.map(conn => conn.id);
      expect(ids).toContain("user-only");
      expect(ids).not.toContain("proj-only");
    });

    it("writes user config file on connection save", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "ucf-1" }));

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("creates config directory if it does not exist", async () => {
      (fs.existsSync as Mock).mockReturnValue(false);
      const manager = createManager();
      await manager.add(makeConfig({ id: "ucf-2" }));

      expect(fs.mkdirSync).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getSchemaForDatabase
  // -----------------------------------------------------------------------
  describe("getSchemaForDatabase", () => {
    it("creates temp driver, fetches schema, disconnects", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "sdb-1" }));

      const schemaDriver = createFreshMockDriver();
      (schemaDriver.getSchema as Mock).mockResolvedValueOnce([
        { name: "public", type: "schema", children: [] },
      ]);
      (createDriver as Mock).mockReturnValueOnce(schemaDriver);

      const schema = await manager.getSchemaForDatabase("sdb-1", "otherdb");

      expect(schema).toHaveLength(1);
      expect(schemaDriver.connect).toHaveBeenCalled();
      expect(schemaDriver.disconnect).toHaveBeenCalled();
    });

    it("disconnects driver even when getSchema throws", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "sdb-2" }));

      const failDriver = createFreshMockDriver();
      (failDriver.getSchema as Mock).mockRejectedValueOnce(new Error("permission denied"));
      (createDriver as Mock).mockReturnValueOnce(failDriver);

      await expect(manager.getSchemaForDatabase("sdb-2", "forbidden")).rejects.toThrow("permission denied");
      expect(failDriver.disconnect).toHaveBeenCalled();
    });

    it("throws for nonexistent connection", async () => {
      const manager = createManager();
      await expect(manager.getSchemaForDatabase("ghost", "db")).rejects.toThrow("Connection not found");
    });
  });

  // -----------------------------------------------------------------------
  // File system watcher
  // -----------------------------------------------------------------------
  describe("project file watcher", () => {
    it("reloads project data when file changes", async () => {
      const projectData = {
        connections: [makeConfig({ id: "watch-conn", scope: "project" as const })],
        folders: [],
      };
      readFileHolder.result = Buffer.from(JSON.stringify(projectData), "utf8");

      const manager = createManager();
      await vi.waitFor(() => {
        expect(manager.get("watch-conn")).toBeDefined();
      });

      // Simulate file change — remove old project data, load new
      const updatedData = {
        connections: [makeConfig({ id: "watch-conn-2", scope: "project" as const })],
        folders: [],
      };
      readFileHolder.result = Buffer.from(JSON.stringify(updatedData), "utf8");

      // Fire the onChange listener
      for (const listener of watcherListeners.onChange) {
        listener();
      }

      await vi.waitFor(() => {
        expect(manager.get("watch-conn-2")).toBeDefined();
      });

      // Old project connection should be removed
      expect(manager.get("watch-conn")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------
  describe("dispose", () => {
    it("disconnects all active drivers", async () => {
      const manager = createManager();
      await manager.add(makeConfig({ id: "disp-1" }));
      await manager.add(makeConfig({ id: "disp-2" }));
      await manager.connect("disp-1");
      await manager.connect("disp-2");

      const driver1 = manager.getDriver("disp-1")!;
      const driver2 = manager.getDriver("disp-2")!;

      manager.dispose();
      // Give disconnect promises time to settle
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(driver1.disconnect).toHaveBeenCalled();
      expect(driver2.disconnect).toHaveBeenCalled();
    });
  });
});
