import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("gRPC snapshot generation replacement", () => {
  it("removes deleted sources and generated modules, preserves non-owned files, and leaves valid inventories untouched on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "grpc-codegen-test-"));
    roots.push(root);
    const repo = join(root, "repo");
    const snapshot = join(root, "upstream");
    await mkdir(join(repo, "scripts"), { recursive: true });
    const proto = "packages/imessage/proto";
    const generated = "packages/imessage/src/generated";
    await mkdir(join(repo, proto), { recursive: true });
    await mkdir(snapshot);
    await cp("scripts/generate-grpc.mjs", join(repo, "scripts/generate-grpc.mjs"));
    for (const name of ["README.md", "LICENSE.photon", "buf.yaml"]) {
      await cp(join(proto, name), join(repo, proto, name));
    }
    const environment = { ...process.env, PATH: `${resolve("node_modules/.bin")}:${process.env.PATH}`, TMPDIR: root };
    const generate = (...args: string[]) => execFileSync(process.execPath, [join(repo, "scripts/generate-grpc.mjs"), ...args], {
      cwd: repo, env: environment, stdio: "pipe",
    });
    await writeFile(join(snapshot, "keep.proto"), 'syntax = "proto3"; package fixture; message Keep { string value = 1; }\n');
    await writeFile(join(snapshot, "deleted.proto"), 'syntax = "proto3"; package fixture; message Deleted {}\n');
    generate("--snapshot-source", snapshot);
    expect(await readdir(join(repo, generated))).toEqual(["deleted_pb.ts", "keep_pb.ts"]);
    // These are explicitly outside the script-owned inventories.
    await writeFile(join(repo, generated, "README.md"), "keep generated documentation\n");
    await writeFile(join(repo, generated, "helper.ts"), "// not a protobuf-generated module\n");
    await rm(join(snapshot, "deleted.proto"));
    await writeFile(join(snapshot, "keep.proto"), 'syntax = "proto3"; package fixture; message Keep { bytes value = 1; }\n');
    generate("--snapshot-source", snapshot);
    expect(await readdir(join(repo, generated))).toEqual(["README.md", "helper.ts", "keep_pb.ts"]);
    expect((await readdir(join(repo, proto))).filter((name) => name.endsWith(".proto"))).toEqual(["keep.proto"]);
    const manifest = JSON.parse(await readFile(join(repo, proto, "snapshot.json"), "utf8"));
    expect(Object.keys(manifest.sha256)).toEqual(["keep.proto"]);
    for (const name of ["README.md", "LICENSE.photon", "buf.yaml"]) {
      expect(await readFile(join(repo, proto, name), "utf8")).toBe(await readFile(join(proto, name), "utf8"));
    }
    expect(await readFile(join(repo, generated, "helper.ts"), "utf8")).toBe("// not a protobuf-generated module\n");
    generate("--check");
    const owned = [join(proto, "keep.proto"), join(proto, "snapshot.json"), join(generated, "keep_pb.ts")];
    const before = await Promise.all(owned.map((path) => readFile(join(repo, path), "utf8")));
    // Equal counts must not hide a renamed/replaced generated module.
    await writeFile(join(repo, generated, "renamed_pb.ts"), before[2]!);
    await rm(join(repo, generated, "keep_pb.ts"));
    expect(() => generate("--check")).toThrow(/Generated file inventory changed/);
    await rm(join(repo, generated, "renamed_pb.ts"));
    await writeFile(join(repo, generated, "keep_pb.ts"), before[2]!);
    // Likewise, a snapshot manifest with the right count but wrong key fails.
    await writeFile(join(repo, proto, "snapshot.json"), JSON.stringify({ ...manifest, sha256: { 'renamed.proto': manifest.sha256['keep.proto'] } }));
    expect(() => generate("--check")).toThrow(/Snapshot file inventory changed/);
    await writeFile(join(repo, proto, "snapshot.json"), before[1]!);
    // Failed staging/codegen must not partially publish a snapshot or clear the
    // old generated inventory. This invalid source also removes the old file.
    await rm(join(snapshot, "keep.proto"));
    await writeFile(join(snapshot, "invalid.proto"), "this is not a protobuf file\n");
    expect(() => generate("--snapshot-source", snapshot)).toThrow();
    expect(await Promise.all(owned.map((path) => readFile(join(repo, path), "utf8")))).toEqual(before);
    generate("--check");
  }, 30_000);
});
