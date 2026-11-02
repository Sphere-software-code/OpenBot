import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/**
 * `watchdog.sh` against a stack that is up, down, briefly down, or stopped on purpose.
 *
 * Run in a copy of the scripts folder, with `curl`, `pgrep` and `sleep` stood in for and a
 * `start.sh` that only records that it was started: what is under test is the decision, not the
 * stack. `down` lists the ports that do not answer. `recoversAfter` has them answer again once that
 * many requests have been made, which is a stack somebody was restarting by hand. `leavesRunning`
 * has `start.sh` leave a process behind, as the real one leaves the server, worker and app, and
 * `runs` runs the watchdog that many times in a row against the same stack. `startPid` writes
 * `.logs/start.pid` as the real `start.sh` does while it runs: naming a `start.sh` that is still
 * going, or a number that has since been reused by some other process.
 */
type Stack = {
  down?: readonly number[];
  workerRunning?: boolean;
  recoversAfter?: number;
  hold?: boolean;
  args?: readonly string[];
  leavesRunning?: boolean;
  runs?: number;
  startPid?: "running" | "reused";
};

async function watchdog({
  down = [],
  workerRunning = true,
  recoversAfter,
  hold = false,
  args = [],
  leavesRunning = false,
  runs = 1,
  startPid,
}: Stack = {}) {
  const directory = (
    await Bun.$`mktemp -d ${tmpdir()}/openbot-watchdog-XXXXXX`.text()
  ).trim();
  const bin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const logs = join(directory, ".logs");
  const curlLog = join(directory, "curl.log");
  const startLog = join(directory, "start.log");
  await mkdir(bin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(logs, { recursive: true });
  for (const name of ["watchdog.sh", "require-bash.sh", "processes.sh"])
    await copyFile(join(import.meta.dir, name), join(scripts, name));
  await writeFile(join(directory, ".env"), "SERVER_PORT=3001\nAPP_PORT=3011\n");
  // The real `sleep`, by path, since the one on the watchdog's PATH returns at once.
  const left = leavesRunning
    ? `"${Bun.which("sleep")}" 5 >/dev/null 2>&1 &\n`
    : "";
  await writeExecutable(
    join(scripts, "start.sh"),
    `#!/usr/bin/env bash\necho started >> "${startLog}"\n${left}`,
  );
  const recovered =
    recoversAfter === undefined
      ? ""
      : `[ "$calls" -gt ${recoversAfter} ] && { printf 200; exit 0; }`;
  await writeExecutable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
url="\${@: -1}"
echo "$url" >> "${curlLog}"
calls="$(wc -l < "${curlLog}")"
for port in ${down.join(" ")}; do
  if [[ "$url" == *":$port/"* ]]; then
    ${recovered}
    printf 000
    exit 7
  fi
done
printf 200
`,
  );
  await writeExecutable(
    join(bin, "pgrep"),
    `#!/usr/bin/env bash\nexit ${workerRunning ? 0 : 1}\n`,
  );
  await writeExecutable(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  if (hold) await writeFile(join(logs, "watchdog.hold"), "");
  // Somebody else's start.sh, still busy: a script of that name that only waits.
  let starting: ReturnType<typeof Bun.spawn> | undefined;
  if (startPid === "running") {
    const slow = join(directory, "elsewhere", "start.sh");
    await mkdir(join(directory, "elsewhere"));
    await writeExecutable(
      slow,
      `#!/usr/bin/env bash\n"${Bun.which("sleep")}" 5\n`,
    );
    starting = Bun.spawn(["bash", slow], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await writeFile(join(logs, "start.pid"), `${starting.pid}\n`);
  }
  // The test runner: alive, and nothing like a start.sh.
  if (startPid === "reused")
    await writeFile(join(logs, "start.pid"), `${process.pid}\n`);

  let run = await Bun.$`bash ${join(scripts, "watchdog.sh")} ${args}`
    .env({ PATH: `${bin}:${process.env.PATH}`, HOME: directory })
    .nothrow()
    .quiet();
  for (let again = 1; again < runs; again++)
    run = await Bun.$`bash ${join(scripts, "watchdog.sh")} ${args}`
      .env({ PATH: `${bin}:${process.env.PATH}`, HOME: directory })
      .nothrow()
      .quiet();
  starting?.kill();
  const started = existsSync(startLog)
    ? (await readFile(startLog, "utf8")).trim().split("\n").length
    : 0;
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), started };
}

describe("watchdog.sh", () => {
  test("a stack that answers is left alone", async () => {
    expect(await watchdog()).toMatchObject({
      exitCode: 0,
      started: 0,
      stdout: "",
    });
  });

  test("a server still down a minute later is started again, and the log says what was down", async () => {
    const run = await watchdog({ down: [3001] });
    expect(run.started).toBe(1);
    expect(run.stdout).toContain("down: server");
  });

  test("a stopped routine worker is started again", async () => {
    const run = await watchdog({ workerRunning: false });
    expect(run.started).toBe(1);
    expect(run.stdout).toContain("down: worker");
  });

  test("a server back by the second look was being restarted by hand, and is left to it", async () => {
    // The first look asks the server and the app, two requests; the server answers from the third.
    expect(await watchdog({ down: [3001], recoversAfter: 2 })).toMatchObject({
      exitCode: 0,
      started: 0,
    });
  });

  test("what start.sh left running does not keep the next run from starting it again", async () => {
    // A server that outlived the first restart, while the worker keeps falling over.
    expect(
      await watchdog({ workerRunning: false, leavesRunning: true, runs: 2 }),
    ).toMatchObject({ started: 2 });
  });

  test("a stack a start.sh is still bringing up is left to it", async () => {
    expect(
      await watchdog({ down: [3001, 3011], startPid: "running" }),
    ).toMatchObject({ exitCode: 0, started: 0 });
  });

  test("a start.pid whose number now belongs to something else holds nothing up", async () => {
    expect(
      await watchdog({ down: [3001, 3011], startPid: "reused" }),
    ).toMatchObject({ started: 1 });
  });

  test("a stack stopped with stop.sh stays stopped", async () => {
    expect(
      await watchdog({ down: [3001, 3011], workerRunning: false, hold: true }),
    ).toMatchObject({ exitCode: 0, started: 0 });
  });

  test("--check names what is down and starts nothing", async () => {
    expect(
      await watchdog({
        down: [3011],
        workerRunning: false,
        args: ["--check"],
      }),
    ).toMatchObject({ exitCode: 1, started: 0, stdout: "worker\napp\n" });
    expect(await watchdog({ args: ["--check"] })).toMatchObject({
      exitCode: 0,
      started: 0,
      stdout: "",
    });
  });
});
