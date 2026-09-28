import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  acquireDevice,
  checkDevice,
  checkDevices,
  deviceLockOptions,
  findContenders,
  heldUdids,
  lockKey,
  lockPath,
  parseEtime,
  parsePs,
  tryAcquire,
  type LockDeps,
} from "../src/devicelock.js";
import { formatCliError } from "../src/cli.js";
import { resolveLockedContext, type BuildContext } from "../src/action.js";
import { DeviceBusyError } from "../src/errors.js";

const UDID = "6F1E2D3C-8A9B-4C5D-9E0F-1A2B3C4D5E6F";
const META = {
  device: "iPhone 17 Pro · 26.5",
  command: "test",
  scheme: "MyApp",
  project: "/src/MyApps.xcworkspace",
};

describe("lockKey", () => {
  it("locks a simulator or a device by its udid", () => {
    expect(lockKey(`platform=iOS Simulator,id=${UDID.toLowerCase()}`)).toBe(
      UDID,
    );
    expect(lockKey("platform=iOS,id=00008110-001A2B3C4D5E6F")).toBe(
      "00008110-001A2B3C4D5E6F",
    );
    expect(lockKey(`platform=iOS Simulator, id=${UDID}`)).toBe(UDID);
  });

  // A Mac is one shared machine; a placeholder runs nothing; a bare name
  // is xcodebuild's guess across runtimes; a path would escape the directory.
  it("locks nothing it cannot pin to one device", () => {
    for (const specifier of [
      `platform=macOS,arch=arm64,id=${UDID}`,
      `platform=macOS,variant=Mac Catalyst,id=${UDID}`,
      "generic/platform=iOS Simulator",
      "platform=iOS Simulator,name=iPhone 17 Pro",
      "platform=iOS Simulator,id=../../etc",
      undefined,
    ]) {
      expect(lockKey(specifier)).toBeUndefined();
    }
  });
});

describe("device lock", () => {
  const created: string[] = [];
  afterEach(() => {
    delete process.env["XCODEBUILD_AXI_HELD_DEVICES"];
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  /** A world of processes: pid -> start time, and a `ps` listing. */
  function deps(
    live: Record<number, string>,
    options: { pid?: number; ps?: string; clock?: { now: number } } = {},
  ): LockDeps & { said: () => string } {
    const dir = mkdtempSync(join(tmpdir(), "axi-locks-"));
    created.push(dir);
    const clock = options.clock ?? { now: Date.parse("2026-09-28T12:00:00Z") };
    const said: string[] = [];
    return {
      dir,
      pid: options.pid ?? 100,
      now: () => clock.now,
      processStart: (pid) => live[pid],
      psList: () => options.ps ?? "",
      sleep: async (ms) => {
        clock.now += ms;
      },
      progress: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          said.push(chunk.toString());
          callback();
        },
      }),
      said: () => said.join(""),
    };
  }

  function record(dir: string, fields: Record<string, unknown>): void {
    writeFileSync(
      lockPath(dir, UDID),
      JSON.stringify({
        version: 1,
        udid: UDID,
        device: META.device,
        command: "test",
        scheme: "MyApp",
        started: "2026-09-28T11:57:00.000Z",
        ...fields,
      }),
    );
  }

  it("writes a complete record and leaves nothing else behind", () => {
    const world = deps({ 100: "Mon Sep 28 11:00:00 2026" });
    const attempt = tryAcquire(world, UDID, META);
    expect("release" in attempt).toBe(true);
    expect(readdirSync(world.dir)).toEqual([`${UDID}.json`]);
    const written = JSON.parse(
      readFileSync(lockPath(world.dir, UDID), "utf-8"),
    );
    expect(written).toMatchObject({
      pid: 100,
      pid_started: "Mon Sep 28 11:00:00 2026",
      command: "test",
      scheme: "MyApp",
    });
    if ("release" in attempt) attempt.release();
    expect(existsSync(lockPath(world.dir, UDID))).toBe(false);
  });

  it("names a live holder rather than taking its device", () => {
    const world = deps({ 100: "a", 4242: "b" });
    record(world.dir, { pid: 4242, pid_started: "b" });
    const attempt = tryAcquire(world, UDID, META);
    expect(attempt).toMatchObject({
      holder: { pid: 4242, command: "test", scheme: "MyApp", heldSeconds: 180 },
    });
    expect(readdirSync(world.dir)).toEqual([`${UDID}.json`]);
  });

  // kill -9, a crash, or a reboot: no release ran, and none has to.
  it("takes over from a holder that is gone", () => {
    const world = deps({ 100: "a" });
    record(world.dir, { pid: 4242, pid_started: "b" });
    const attempt = tryAcquire(world, UDID, META);
    expect("release" in attempt).toBe(true);
    expect(
      JSON.parse(readFileSync(lockPath(world.dir, UDID), "utf-8")).pid,
    ).toBe(100);
  });

  it("takes over from a pid the OS has handed to another process", () => {
    const world = deps({ 100: "a", 4242: "started later" });
    record(world.dir, { pid: 4242, pid_started: "b" });
    expect("release" in tryAcquire(world, UDID, META)).toBe(true);
  });

  // The contract for other tools: a file with a live pid is enough.
  it("honours a lock another tool wrote with only a pid", () => {
    const world = deps({ 100: "a", 4242: "b" });
    writeFileSync(lockPath(world.dir, UDID), JSON.stringify({ pid: 4242 }));
    expect(tryAcquire(world, UDID, META)).toMatchObject({
      holder: { pid: 4242 },
    });
  });

  it("treats a fresh unreadable lock as held, and an old one as stale", () => {
    const world = deps({ 100: "a" }, { clock: { now: Date.now() } });
    writeFileSync(lockPath(world.dir, UDID), "{");
    expect("holder" in tryAcquire(world, UDID, META)).toBe(true);

    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath(world.dir, UDID), old, old);
    expect("release" in tryAcquire(world, UDID, META)).toBe(true);
  });

  // A directory, or another user's unreadable file, must not stop every run.
  it("judges a lock it cannot read at all by its age", () => {
    const world = deps({ 100: "a" }, { clock: { now: Date.now() } });
    mkdirSync(lockPath(world.dir, UDID));
    expect([...heldUdids(world)]).toEqual([UDID]);

    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath(world.dir, UDID), old, old);
    expect([...heldUdids(world)]).toEqual([]);
    expect("release" in tryAcquire(world, UDID, META)).toBe(true);
    expect(readdirSync(world.dir)).toEqual([`${UDID}.json`]);
  });

  it("leaves a lock alone on release once another run has taken it over", () => {
    const world = deps({ 100: "a" });
    const attempt = tryAcquire(world, UDID, META);
    record(world.dir, { pid: 4242 });
    if ("release" in attempt) attempt.release();
    expect(existsSync(lockPath(world.dir, UDID))).toBe(true);
  });

  it("lists only the devices a live process holds", () => {
    const world = deps({ 4242: "b" });
    record(world.dir, { pid: 4242, pid_started: "b" });
    writeFileSync(
      join(world.dir, "AAAA-BBBB.json"),
      JSON.stringify({ pid: 999 }),
    );
    expect([...heldUdids(world)]).toEqual([UDID]);
  });

  // A scheme pre-action's xcodebuild-axi belongs on its parent run's device:
  // not steered away from it, and not refused by the parent's xcodebuild.
  it("treats the parent run's device as this run's own", async () => {
    const world = deps(
      { 100: "a", 4242: "b" },
      {
        ps: `  4300  4242   00:30 /usr/bin/xcodebuild -scheme MyApp -destination platform=iOS Simulator,id=${UDID} test\n`,
      },
    );
    record(world.dir, { pid: 4242, pid_started: "b" });
    process.env["XCODEBUILD_AXI_HELD_DEVICES"] = UDID.toLowerCase();

    expect([...heldUdids(world)]).toEqual([]);
    const release = await acquireDevice({
      udid: UDID,
      meta: META,
      options: { skip: false },
      deps: world,
    });
    release();
    await checkDevice({
      udid: UDID,
      meta: META,
      options: { skip: false },
      deps: world,
    });
    expect(
      JSON.parse(readFileSync(lockPath(world.dir, UDID), "utf-8")).pid,
    ).toBe(4242);
  });

  it("refuses naming the holder, and renders it as data", async () => {
    const world = deps({ 100: "a", 4242: "b" });
    record(world.dir, {
      pid: 4242,
      pid_started: "b",
      project: "/src/MyApps.xcworkspace",
    });
    const refusal = await acquireDevice({
      udid: UDID,
      meta: META,
      options: { skip: false },
      deps: world,
    }).catch((error: unknown) => error);

    const { output, exitCode } = formatCliError(refusal);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "error: iPhone 17 Pro · 26.5 is in use by another run",
    );
    expect(output).toContain("code: DEVICE_BUSY");
    expect(output).toContain(
      "holder:\n  pid: 4242\n  command: test\n  scheme: MyApp",
    );
    expect(output).toContain("held: 3m00s");
    expect(output).toMatch(/help\[3\]:\n {2}Add `--wait 900`/);
  });

  it("waits for a holder to finish, saying so once", async () => {
    const live: Record<number, string> = { 100: "a", 4242: "b" };
    const world = deps(live);
    record(world.dir, { pid: 4242, pid_started: "b" });
    const originalSleep = world.sleep;
    let polls = 0;
    world.sleep = async (ms) => {
      polls += 1;
      if (polls === 3) delete live[4242];
      await originalSleep(ms);
    };

    const release = await acquireDevice({
      udid: UDID,
      meta: META,
      options: { skip: false, waitSeconds: 60 },
      deps: world,
    });
    expect(world.said().match(/waiting:/g)).toHaveLength(1);
    expect(world.said()).toContain("held by pid 4242 (test MyApp for 3m00s)");
    // While held, a scheme pre-action run by this xcodebuild sees it as ours.
    expect(process.env["XCODEBUILD_AXI_HELD_DEVICES"]).toBe(UDID);
    release();
    expect(process.env["XCODEBUILD_AXI_HELD_DEVICES"]).toBeUndefined();
  });

  it("gives up after --wait, saying how long it waited", async () => {
    const world = deps({ 100: "a", 4242: "b" });
    record(world.dir, { pid: 4242, pid_started: "b" });
    const refusal = await acquireDevice({
      udid: UDID,
      meta: META,
      options: { skip: false, waitSeconds: 5 },
      deps: world,
    }).catch((error: unknown) => error);
    expect(formatCliError(refusal).output).toContain("waited: 5.0s");
  });

  // A raw xcodebuild -- CI, another checkout -- never took the lock.
  it("refuses a device a raw xcodebuild is testing on, and releases the lock", async () => {
    const world = deps(
      { 100: "a" },
      {
        ps: `  555     1   12:03 /usr/bin/xcodebuild -scheme MyApp -destination platform=iOS Simulator,id=${UDID} test\n`,
      },
    );
    const refusal = await acquireDevice({
      udid: UDID,
      meta: META,
      options: { skip: false },
      deps: world,
    }).catch((error: unknown) => error);
    const { output } = formatCliError(refusal);
    expect(output).toContain("pid: 555");
    expect(output).toContain(
      "command: xcodebuild test (not through xcodebuild-axi)",
    );
    expect(output).toContain("held: 12m03s");
    expect(existsSync(lockPath(world.dir, UDID))).toBe(false);
  });

  it("checks without taking the lock", async () => {
    const world = deps({ 100: "a" });
    await checkDevice({
      udid: UDID,
      meta: META,
      options: { skip: false },
      deps: world,
    });
    expect(readdirSync(world.dir)).toEqual([]);
  });

  // `sim shutdown --all` takes down every device, including one a raw
  // xcodebuild is testing on without a lock file.
  it("checks every device a blanket change would touch", async () => {
    const other = "0A1B2C3D-0000-4000-8000-000000000000";
    const world = deps(
      { 100: "a" },
      {
        ps: `  555     1   00:40 xcodebuild -destination id=${other} test\n`,
      },
    );
    const refusal = await checkDevices(
      [
        { udid: UDID, device: "iPhone 17 Pro · 26.5" },
        { udid: other, device: "iPad Air · 26.5" },
      ],
      "sim shutdown",
      { skip: false },
      world,
    ).catch((error: unknown) => error);
    const { output } = formatCliError(refusal);
    expect(output).toContain("error: iPad Air · 26.5 is in use by another run");
    expect(output).toContain(`udid: ${other}`);
    expect(output).toContain("Run `xcodebuild-axi sim list`");
  });

  it("does neither under --no-device-lock", async () => {
    const world = deps({ 100: "a", 4242: "b" });
    record(world.dir, { pid: 4242, pid_started: "b" });
    const release = await acquireDevice({
      udid: UDID,
      meta: META,
      options: { skip: true },
      deps: world,
    });
    release();
    expect(
      JSON.parse(readFileSync(lockPath(world.dir, UDID), "utf-8")).pid,
    ).toBe(4242);
  });
});

describe("deviceLockOptions", () => {
  it("refuses waiting for a lock it was told to skip", () => {
    expect(() =>
      deviceLockOptions(["--wait", "60", "--no-device-lock"]),
    ).toThrow(/--wait waits for the device lock/);
  });
});

describe("findContenders", () => {
  const id = UDID;
  const rows = parsePs(
    [
      `  200   100    0:05 /usr/bin/xcodebuild -scheme Ours test`,
      `  201   200    0:05 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme Ours test`,
      `  300     1   03:10 /usr/bin/xcodebuild -scheme MyApp -destination platform=iOS Simulator,id=${id} test`,
      `  301   300   03:10 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme MyApp -destination platform=iOS Simulator,id=${id} test`,
      `  400     1   01:00 xcodebuild -destination id=${id.toLowerCase()} test-without-building`,
      `  500     1   01:00 xcodebuild -scheme MyApp -destination id=${id} build`,
      `  600     1   01:00 xcodebuild -destination id=${id}0 test`,
      `  700     1   01:00 grep xcodebuild id=${id} test`,
      `  800     1   00:10 xcodebuild -scheme MyApp -destination id=${id} -enumerate-tests -test-enumeration-output-path /tmp/t.json test`,
    ].join("\n"),
  );

  it("finds test runs on the udid, once per shim, and skips our own", () => {
    const found = findContenders(rows, id, 100);
    expect(found.map((holder) => holder.pid)).toEqual([300, 400]);
    expect(found[0]).toMatchObject({ scheme: "MyApp", heldSeconds: 190 });
  });

  it("reads ps elapsed times", () => {
    expect(parseEtime("05:03")).toBe(303);
    expect(parseEtime("02:00:00")).toBe(7200);
    expect(parseEtime("1-00:00:01")).toBe(86401);
  });
});

describe("resolveLockedContext", () => {
  const A = "AAAAAAAA-0000-4000-8000-000000000000";
  const B = "BBBBBBBB-0000-4000-8000-000000000000";

  /** Picks the first simulator not avoided, as the default destination does. */
  function resolver(picks: string[][]) {
    return async (options: { avoid?: Set<string> }) => {
      picks.push([...(options.avoid ?? [])]);
      const udid = [A, B].find((id) => !options.avoid?.has(id)) ?? A;
      return {
        destinationSpecifier: `platform=iOS Simulator,id=${udid}`,
      } as BuildContext;
    };
  }

  /** A claim that loses the race for A. */
  async function claim(context: BuildContext): Promise<string> {
    if (context.destinationSpecifier?.includes(A)) {
      throw new DeviceBusyError(
        "iPhone 17 Pro is in use by another run",
        {},
        [],
      );
    }
    return context.destinationSpecifier ?? "";
  }

  // Two runs started together both saw A free; the loser takes B.
  it("picks again when a default choice loses its device", async () => {
    const picks: string[][] = [];
    const { claimed } = await resolveLockedContext(
      { args: [], command: "test", lock: { skip: false } },
      claim,
      resolver(picks),
      () => new Set(),
    );
    expect(claimed).toContain(B);
    expect(picks).toEqual([[], [A]]);
  });

  it("does not swap a device the caller named, or one it asked to wait for", async () => {
    for (const [args, lock] of [
      [["--device", "iPhone 17 Pro"], { skip: false }],
      [[], { skip: false, waitSeconds: 60 }],
    ] as const) {
      await expect(
        resolveLockedContext(
          { args: [...args], command: "test", lock },
          claim,
          resolver([]),
          () => new Set(),
        ),
      ).rejects.toBeInstanceOf(DeviceBusyError);
    }
  });

  it("stops once every candidate is held", async () => {
    const picks: string[][] = [];
    await expect(
      resolveLockedContext(
        { args: [], command: "test", lock: { skip: false } },
        async () => {
          throw new DeviceBusyError("busy", {}, []);
        },
        resolver(picks),
        () => new Set(),
      ),
    ).rejects.toBeInstanceOf(DeviceBusyError);
    expect(picks).toHaveLength(3);
  });
});
