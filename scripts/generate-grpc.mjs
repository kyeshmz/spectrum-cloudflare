#!/usr/bin/env node
// Build-time tooling only. The generated runtime uses Web APIs exclusively.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proto = join(root, "proto");
const generated = join(root, "src/generated");
const pin = "buf.build/photon-hq/imessage:d271d841bb604a8ea53556dfb1a77ac4";
const args = process.argv.slice(2);
const check = args.includes("--check");
const sourceIndex = args.indexOf("--snapshot-source");

async function files(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path, suffix) : path.endsWith(suffix) ? [path] : [];
  }));
  return nested.flat().sort();
}

for (const [command, version] of [["buf", "1.69.0"], ["protoc-gen-es", "2.16.0"]]) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim().endsWith(version)) {
    throw new Error(`Code generation requires ${command}@${version}; got ${result.stdout.trim()}`);
  }
}

const temporary = await mkdtemp(join(tmpdir(), "photon-grpc-"));
try {
  if (sourceIndex !== -1 && (check || !args[sourceIndex + 1])) {
    throw new Error("Snapshot source requires a path and cannot be used with --check");
  }
  const source = sourceIndex === -1 ? proto : resolve(args[sourceIndex + 1]);
  const snapshot = join(temporary, "proto");
  await mkdir(snapshot);
  // Stage an exact inventory, never an overlay on the previous snapshot.
  const inputs = await files(source, ".proto");
  if (inputs.length === 0) throw new Error("Snapshot contains no .proto files");
  const hashes = {};
  for (const file of inputs) {
    const path = relative(source, file);
    const destination = join(snapshot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(file, destination);
    hashes[path] = createHash("sha256").update(await readFile(destination)).digest("hex");
  }
  let manifest;
  if (sourceIndex === -1) {
    manifest = JSON.parse(await readFile(join(proto, "snapshot.json"), "utf8"));
    if (manifest.module !== pin) throw new Error("Unexpected Photon protobuf pin");
    if (inputs.length !== Object.keys(manifest.sha256).length) throw new Error("Snapshot file inventory changed");
    for (const [path, hash] of Object.entries(hashes)) {
      if (manifest.sha256[path] !== hash) throw new Error(`Snapshot changed: ${path}`);
    }
  } else {
    manifest = {
      module: pin,
      source: "Snapshot supplied by --snapshot-source; verify its module commit before accepting this update",
      sha256: hashes,
    };
  }
  await writeFile(join(snapshot, "buf.yaml"), "version: v2\nmodules:\n  - path: .\n");
  const output = join(temporary, "generated");
  const config = {
    version: "v2",
    plugins: [{ local: "protoc-gen-es", out: output, include_imports: true,
      opt: ["target=ts", "import_extension=js"] }],
    inputs: [{ directory: snapshot }],
  };
  const result = spawnSync("buf", ["generate", "--template", JSON.stringify(config)], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`buf generate failed (${result.status})`);
  const next = await files(output, "_pb.ts");
  if (next.length === 0) throw new Error("Code generation produced no protobuf modules");
  if (check) {
    const previous = await files(generated, "_pb.ts");
    if (previous.length !== next.length) throw new Error("Generated file inventory changed");
    for (const file of next) {
      const path = relative(output, file);
      if (!(await readFile(file)).equals(await readFile(join(generated, path)))) {
        throw new Error(`Generated file is stale: src/generated/${path}`);
      }
    }
  } else {
    // Compilation and inventory validation must finish before modifying any
    // checked-in sources. Only .proto and *_pb.ts files belong to this script;
    // leave documentation, licenses, configuration, and other files intact.
    if (sourceIndex !== -1) {
      for (const file of await files(proto, ".proto")) await rm(file);
      for (const path of Object.keys(hashes)) {
        const destination = join(proto, path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(snapshot, path), destination);
      }
      await writeFile(join(proto, "snapshot.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    for (const file of await files(generated, "_pb.ts")) await rm(file);
    await mkdir(generated, { recursive: true });
    await cp(output, generated, { recursive: true });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
