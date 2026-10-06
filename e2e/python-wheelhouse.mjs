// Explicit wheel bodies only: no cache discovery, pip configuration or credential reads.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { PYTHON } from "./stage.mjs";

const schema = "teammem-dependency-wheelhouse/v1";
const filenamePattern = /^[a-z0-9_]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl$/;
const pythonEnvironment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", PIP_CONFIG_FILE: "/dev/null" };

// stdlib ZIP parsing avoids assuming that the opaque HTTP-cache filename is a
// wheel filename. Tag fields and package identity come from the wheel itself.
const inspectScript = `import email, json, re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as wheel:
    names = wheel.namelist()
    if len(names) != len(set(names)):
        raise ValueError('duplicate ZIP entries')
    if any(n.startswith('/') or '\\\\' in n or '..' in n.split('/') for n in names):
        raise ValueError('unsafe ZIP path')
    metadata = [n for n in names if n.count('/') == 1 and n.endswith('.dist-info/METADATA')]
    headers = [n for n in names if n.count('/') == 1 and n.endswith('.dist-info/WHEEL')]
    if len(metadata) != 1 or len(headers) != 1 or metadata[0].rsplit('/', 1)[0] != headers[0].rsplit('/', 1)[0]:
        raise ValueError('invalid wheel metadata layout')
    if '/' in metadata[0].rsplit('/', 1)[0]:
        raise ValueError('unsafe metadata path')
    if wheel.testzip() is not None:
        raise ValueError('invalid ZIP content')
    info = email.message_from_bytes(wheel.read(metadata[0]))
    wheel_info = email.message_from_bytes(wheel.read(headers[0]))
    if len(info.get_all('Name', [])) != 1 or len(info.get_all('Version', [])) != 1:
        raise ValueError('invalid package identity')
    name, version = info['Name'], info['Version']
    if not re.fullmatch(r'[A-Za-z0-9]+([._-][A-Za-z0-9]+)*', name) or not re.fullmatch(r'[A-Za-z0-9]+([._][A-Za-z0-9]+)*', version):
        raise ValueError('invalid package name or version')
    name = re.sub(r'[-_.]+', '_', name).lower()
    root_name, root_version = metadata[0].split('/')[0][:-10].rsplit('-', 1)
    if re.sub(r'[-_.]+', '_', root_name).lower() != name or root_version != version:
        raise ValueError('wheel root identity does not match metadata')
    tags = wheel_info.get_all('Tag', [])
    if not tags or any(not re.fullmatch(r'[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_]+', t) for t in tags):
        raise ValueError('invalid wheel tags')
    tags = set(tuple(t.split('-')) for t in tags)
    parts = [sorted(set(t[i] for t in tags)) for i in range(3)]
    if len(tags) != len(parts[0]) * len(parts[1]) * len(parts[2]):
        raise ValueError('invalid compressed wheel tags')
    filename = name + '-' + version + '-' + '-'.join('.'.join(p) for p in parts) + '.whl'
    print(json.dumps({'name': name, 'version': version, 'filename': filename}))
`;

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function regular(filename) {
  if (!lstatSync(filename).isFile()) throw new Error(`${filename} must be a regular non-symlink file`);
}

function privateDirectory(directory) {
  absolute(directory, "private directory");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("wheelhouse directory must be owned by the current UID, non-symlink and exact 0700");
  }
  return realpathSync(directory);
}

function protectedAncestors(directory) {
  for (let ancestor = path.dirname(directory); ; ancestor = path.dirname(ancestor)) {
    const stat = lstatSync(ancestor);
    // Root-owned sticky temp directories permit private mkdtemp children without
    // permitting another UID to replace their directory entries.
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.geteuid())
        || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error(`unprotected private wheelhouse ancestor: ${ancestor}`);
    }
    if (ancestor === path.dirname(ancestor)) break;
  }
}

function inspectWheel(filename) {
  regular(filename);
  const result = spawnSync(PYTHON, ["-c", inspectScript, filename], { encoding: "utf8", env: pythonEnvironment, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`invalid wheel ZIP: ${result.stderr || result.error?.message || "inspection failed"}`);
  const identity = JSON.parse(result.stdout);
  if (!filenamePattern.test(identity.filename)) throw new Error("invalid sanitized wheel filename");
  const bytes = readFileSync(filename);
  return { ...identity, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function createDependencyWheelhouse({ wheelBodies, destination }) {
  absolute(destination, "wheelhouse destination");
  if (!Array.isArray(wheelBodies) || wheelBodies.length === 0) throw new Error("explicit wheel bodies are required");
  const wheels = [];
  const names = new Set();
  for (const body of wheelBodies) {
    absolute(body, "wheel body");
    const wheel = inspectWheel(body);
    if (names.has(wheel.name)) throw new Error(`duplicate wheel distribution: ${wheel.name}`);
    names.add(wheel.name);
    wheels.push(wheel);
  }
  mkdirSync(destination, { mode: 0o700 }); // Never overwrite or trust an existing directory.
  try {
    for (const [index, wheel] of wheels.entries()) {
      copyFileSync(wheelBodies[index], path.join(destination, wheel.filename), constants.COPYFILE_EXCL);
    }
    writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify({ schema, wheels }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return await validateDependencyWheelhouse(destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function validateDependencyWheelhouse(directory) {
  absolute(directory, "dependency wheelhouse");
  const resolved = privateDirectory(directory);
  const manifestPath = path.join(resolved, "manifest.json");
  regular(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== schema || !Array.isArray(manifest.wheels) || manifest.wheels.length === 0) throw new Error("invalid wheelhouse manifest");
  const names = new Set();
  const filenames = new Set();
  for (const wheel of manifest.wheels) {
    if (wheel === null || typeof wheel !== "object" || !filenamePattern.test(wheel.filename)
        || typeof wheel.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(wheel.sha256)
        || !Number.isSafeInteger(wheel.bytes) || wheel.bytes <= 0) throw new Error("invalid wheelhouse manifest filename/hash/bytes");
    if (filenames.has(wheel.filename) || names.has(wheel.name)) throw new Error("duplicate wheelhouse manifest entry");
    filenames.add(wheel.filename);
    names.add(wheel.name);
    const wheelPath = path.join(resolved, wheel.filename);
    regular(wheelPath);
    const bytes = readFileSync(wheelPath);
    if (bytes.length !== wheel.bytes || createHash("sha256").update(bytes).digest("hex") !== wheel.sha256) throw new Error(`wheel hash/bytes mismatch: ${wheel.filename}`);
    const actual = inspectWheel(wheelPath);
    if (actual.filename !== wheel.filename || actual.name !== wheel.name || actual.version !== wheel.version) throw new Error(`wheel metadata mismatch: ${wheel.filename}`);
  }
  const entries = readdirSync(resolved);
  if (entries.length !== filenames.size + 1 || entries.some((name) => name !== "manifest.json" && !filenames.has(name))) throw new Error("unlisted wheelhouse contents");
  return { path: resolved, wheels: manifest.wheels };
}

/** Bind the validated caller manifest to copied bytes beneath the staged root.
 * Pip receives only this private snapshot, never the mutable caller directory. */
export async function snapshotDependencyWheelhouse({ dependencyWheelhouse, privateRoot }) {
  const root = privateDirectory(privateRoot);
  protectedAncestors(root);
  const source = await validateDependencyWheelhouse(dependencyWheelhouse);
  const snapshot = mkdtempSync(path.join(root, "dependency-wheelhouse-"));
  try {
    for (const wheel of source.wheels) {
      const filename = path.join(source.path, wheel.filename);
      regular(filename);
      const bytes = readFileSync(filename);
      if (bytes.length !== wheel.bytes || createHash("sha256").update(bytes).digest("hex") !== wheel.sha256) {
        throw new Error(`wheel changed before private copy: ${wheel.filename}`);
      }
      writeFileSync(path.join(snapshot, wheel.filename), bytes, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(path.join(snapshot, "manifest.json"), `${JSON.stringify({ schema, wheels: source.wheels }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return await validateDependencyWheelhouse(snapshot);
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export async function teamMemDependencyOptions(dependencyWheelhouse) {
  if (dependencyWheelhouse === undefined) return { argv: [], options: {} };
  const validated = await validateDependencyWheelhouse(dependencyWheelhouse);
  return {
    argv: ["--no-index", "--find-links", validated.path, "--no-cache-dir", "--disable-pip-version-check"],
    options: { env: { ...pythonEnvironment } },
  };
}
