import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TakeStore } from "../src/main/take-store";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ root: string; store: TakeStore }> {
  const root = await mkdtemp(join(tmpdir(), "emcorder-take-store-"));
  temporaryDirectories.push(root);
  return { root, store: new TakeStore(join(root, "takes")) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("writes chunks in append order", async () => {
  const { store } = await createStore();
  await store.begin();
  const first = new TextEncoder().encode("first-");
  const second = new TextEncoder().encode("second-");
  const third = new TextEncoder().encode("third");

  await Promise.all([store.append(first), store.append(second), store.append(third)]);
  const size = await store.finish();

  assert.equal(size, first.length + second.length + third.length);
  assert.equal(await readFile(store.path!, "utf8"), "first-second-third");
});

test("rejects begin while a previous take still exists", async () => {
  const { store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("take"));
  await store.finish();
  const previousPath = store.path;

  await assert.rejects(store.begin(), /Save or discard the previous take/);
  assert.equal(store.path, previousPath);
  assert.equal(await readFile(previousPath!, "utf8"), "take");
});

test("concurrent begin requests open only one temporary take", async () => {
  const { root, store } = await createStore();
  const beginning = store.begin();
  await assert.rejects(store.begin(), /current take operation/);
  await assert.rejects(store.finish(), /current take operation/);
  await assert.rejects(store.discard(), /current take operation/);
  await beginning;

  assert.equal((await readdir(join(root, "takes"))).length, 1);
  await store.append(new TextEncoder().encode("one take"));
  await store.finish();
  await store.discard();
});

test("save waits for finalization and preserves a take when disk sync fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "emcorder-take-store-"));
  temporaryDirectories.push(root);
  let releaseSync!: () => void;
  let startedSync!: () => void;
  const syncing = new Promise<void>((resolve) => { startedSync = resolve; });
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  const store = new TakeStore(join(root, "takes"), (async (path, flags, mode) => {
    const file = await open(path, flags, mode);
    if (flags === "wx") file.sync = async () => {
      startedSync();
      await syncGate;
      throw new Error("disk sync failed");
    };
    return file;
  }) as typeof open);
  await store.begin();
  await store.append(new TextEncoder().encode("retain source"));
  const source = store.path!;
  const finishing = assert.rejects(store.finish(), /disk sync failed/);
  await syncing;
  const saving = assert.rejects(store.save({ filename: "incomplete", directory: root }), /disk sync failed/);
  releaseSync();
  await Promise.all([finishing, saving]);

  assert.equal(store.path, source);
  assert.equal(store.isSaved, false);
  assert.equal(await readFile(source, "utf8"), "retain source");
  await assert.rejects(stat(join(root, "incomplete.mp4")), { code: "ENOENT" });
  await assert.rejects(store.save({ filename: "retry", directory: root }), /disk sync failed/);
  await store.discard();
});

test("successful save removes temporary data and serves review from the saved file", async () => {
  const { root, store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("complete take"));
  await store.finish();
  const source = store.path!;
  const destination = join(root, "saved.mp4");

  const savedPath = await store.save({ filename: "saved.mp4", directory: root });

  assert.equal(savedPath, destination);
  assert.equal(await readFile(destination, "utf8"), "complete take");
  assert.equal(store.path, destination);
  assert.equal(store.isSaved, true);
  assert.equal(store.temporaryFilePath, null);
  await assert.rejects(stat(source), { code: "ENOENT" });
  await store.discard();
  assert.equal(store.path, null);
  assert.equal(await readFile(destination, "utf8"), "complete take");
});

test("save skips existing suffixes without overwriting any recording", async () => {
  const { root, store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("keep me"));
  await store.finish();
  const source = store.path!;
  const destination = join(root, "already-exists.mp4");
  const existingContents = "existing destination";
  await writeFile(destination, existingContents);
  const secondDestination = join(root, "already-exists_2.mp4");
  await writeFile(secondDestination, "second existing take");

  const saved = await store.save({ filename: "already-exists.mp4", directory: root });

  assert.equal(saved, join(root, "already-exists_3.mp4"));
  assert.equal(await readFile(saved, "utf8"), "keep me");
  assert.equal(await readFile(destination, "utf8"), existingContents);
  assert.equal(await readFile(secondDestination, "utf8"), "second existing take");
  await assert.rejects(stat(source), { code: "ENOENT" });
  assert.equal(store.path, saved);
});

test("save rejects path traversal and preserves the temporary source", async () => {
  const { root, store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("safe source"));
  await store.finish();
  const source = store.path!;

  await assert.rejects(store.save({ filename: "..\\outside.mp4", directory: root }), /valid filename/);
  for (const filename of ["CON", "nul.mp4", "COM1.mp4", "LPT9", "trailing.", "trailing "]) {
    await assert.rejects(store.save({ filename, directory: root }), /valid filename/);
  }
  await assert.rejects(store.save({ filename: "valid.mp4", directory: "relative-folder" }), /absolute folder/);
  assert.equal(await readFile(source, "utf8"), "safe source");
  assert.equal(store.isSaved, false);
});

test("Retake clears saved review state without deleting the saved file", async () => {
  const { root, store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("user-owned"));
  await store.finish();
  const destination = await store.save({ filename: "owned.mp4", directory: root });

  await store.discard();

  assert.equal(store.path, null);
  assert.equal(await readFile(destination, "utf8"), "user-owned");
});

test("explicit discard deletes the take and clears its path", async () => {
  const { store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("discard me"));
  await store.finish();
  const source = store.path!;

  await store.discard();

  assert.equal(store.path, null);
  await assert.rejects(stat(source), { code: "ENOENT" });
});

test("finish closes an empty failed recording so it can be discarded", async () => {
  const { store } = await createStore();
  await store.begin();
  const source = store.path!;

  await assert.rejects(store.finish(), /encoder produced an empty file/);
  assert.equal(store.recording, false);
  assert.equal((await stat(source)).size, 0);

  await store.discard();
  assert.equal(store.path, null);
  await assert.rejects(stat(source), { code: "ENOENT" });
});

test("save surfaces Controlled Folder Access ENOENT on an existing destination folder and preserves the take", async () => {
  const root = await mkdtemp(join(tmpdir(), "emcorder-take-store-"));
  temporaryDirectories.push(root);
  const takesDir = join(root, "takes");
  const blockedDir = join(root, "Videos");
  await rm(blockedDir, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(blockedDir, { recursive: true });

  const store = new TakeStore(takesDir, (async (path, flags, mode) => {
    if (String(path).startsWith(blockedDir) && flags === "wx") {
      const error = Object.assign(
        new Error(`ENOENT: no such file or directory, open '${String(path)}'`),
        { code: "ENOENT", syscall: "open", path: String(path) },
      );
      throw error;
    }
    return open(path, flags, mode);
  }) as typeof open);

  await store.begin();
  await store.append(new TextEncoder().encode("protected take"));
  await store.finish();
  const source = store.path!;

  await assert.rejects(
    store.save({ filename: "intro.mp4", directory: blockedDir }),
    /Windows could not write to that folder.*Controlled Folder Access/,
  );
  assert.equal(store.path, source);
  assert.equal(store.isSaved, false);
  assert.equal(await readFile(source, "utf8"), "protected take");

  const savedPath = await store.save({ filename: "intro.mp4", directory: root });
  assert.equal(savedPath, join(root, "intro.mp4"));
  assert.equal(await readFile(savedPath, "utf8"), "protected take");
});

test("save reports missing temporary source without creating an empty destination file", async () => {
  const { root, store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("ephemeral"));
  await store.finish();
  await unlink(store.path!);

  const destination = join(root, "should-not-exist.mp4");
  await assert.rejects(
    store.save({ filename: "should-not-exist.mp4", directory: root }),
    /temporary recording file could not be found/,
  );
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("Retake recovers when the temporary source is already missing", async () => {
  const { root, store } = await createStore();
  await store.begin();
  await store.append(new TextEncoder().encode("removed outside the app"));
  await store.finish();
  await unlink(store.path!);

  await assert.rejects(store.save({ filename: "missing", directory: root }), /temporary recording file could not be found/);
  await store.discard();
  assert.equal(store.path, null);

  await store.begin();
  await store.append(new TextEncoder().encode("replacement take"));
  await store.finish();
  assert.equal(await readFile(store.path!, "utf8"), "replacement take");
  await store.discard();
});
